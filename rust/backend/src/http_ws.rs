//! `/ws` WebSocket bridge: fans registry bus events to sockets and routes
//! client messages to the registry.
//!
//! Port of `server/pty-ws.mjs` (`attachPtyWs`, `:59-236`). Behaviour parity
//! points:
//!
//! - **Origin** (`:96-98`): a disallowed `Origin` upgrades the connection and
//!   then closes it `1008 forbidden origin` — never an HTTP 403 before the
//!   handshake, which a browser reports differently. The transport layer must
//!   therefore not pre-reject `/ws` on Origin (`http_server.rs`).
//! - **Token** (`:115-118`): a missing/wrong `?token=` upgrades the connection
//!   and then closes it `1008 unauthorized`.
//! - **Initial snapshot** (`:107-132`, `:207-233`): the list/tasks/crons/
//!   background frames are computed synchronously on connect; the
//!   window-anchor frame is awaited, then all five are sent in that order and
//!   the frames queued while awaiting are flushed FIFO. A backlog over 256
//!   frames or 1 048 576 bytes closes `1013 initial snapshot backlog exceeded`
//!   (`:12-21`); a failed anchor closes `1011 initial snapshot failed`
//!   (`:224-231`).
//! - **Fan-out** (`:63-98`): `output` only to sockets whose attached set holds
//!   the id (the set is never pruned, `:105`); every other event to all
//!   sockets. Each event is serialized once (`Arc<str>`) and handed to a
//!   per-socket unbounded channel, so the bus is never blocked.
//! - **Heartbeat** (`:87-93`, `:103-109`): a 30 s ping; a socket that has not
//!   ponged by the next tick is terminated.
//! - **Close** (`:199-205`): a client-initiated `Close` is echoed with the
//!   peer's own code and reason (tungstenite queues the reply; the task flushes
//!   it so the peer never observes 1006/EOF), then the in-flight chat is
//!   aborted, the socket unsubscribes from the bus and the live-client counter
//!   `/api/health` reports is decremented.
//!
//! Deviances from Node:
//! - The empty `tasks`/`crons`/`background` snapshots are the native placeholders
//!   the host wires in later (`{tasks:[],history:[]}`, `[]`, and
//!   background's module-initial state).
//! - Client messages are handled one at a time in the socket task, so replies
//!   stay in receive order; Node's `async` handler may interleave two
//!   concurrent registry calls.

use std::collections::{HashSet, VecDeque};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use axum::Router;
use axum::body::Bytes;
use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::{RawQuery, State};
use axum::http::HeaderMap;
use axum::response::Response;
use axum::routing::get;
use futures_util::SinkExt;
use serde_json::{Map, Value, json};
use tokio::sync::mpsc;

use crate::agent_registry::{CreateAgent, RING_MAX, Registry};
use crate::bus::{BusEvent, BusListener};
use crate::chat::{self, Cancel, ChatDeps, ChatRequest};
use crate::http_policy::HttpPolicy;
use crate::window_anchor;
use crate::ws_filters;

/// `ws.initialFrames.length >= 256` (`pty-ws.mjs:14`).
const INITIAL_MAX_FRAMES: usize = 256;
/// `ws.initialBytes + bytes > 1_048_576` (`pty-ws.mjs:14`).
const INITIAL_MAX_BYTES: usize = 1_048_576;
/// `setInterval(..., 30_000)` (`pty-ws.mjs:93`).
const HEARTBEAT: Duration = Duration::from_secs(30);
/// `TICK_MINUTES * 60_000` in `snapshotBackground()` (`background.mjs:26`, `:163`).
const BACKGROUND_TICK_MS: i64 = 3_600_000;

// VERIFY: http-ws-deps
/// Everything the `/ws` route needs from the host.
///
/// `anchor` is the shared window-anchor service; `chat` is moved into an `Arc`
/// inside [`router`] because `ChatDeps` is not `Clone`. `clients` is the live
/// socket counter `/api/health` reports. `policy` supplies the `SING_TOKEN`
/// check (`HttpPolicy::websocket_authenticated`, `http_policy.rs:112`) — a
/// deviation from the design's field list, required because the token check
/// lives in this route rather than the outer middleware. `shutdown` is the
/// host's drain broadcast: flipping it closes every socket `1001` so graceful
/// HTTP shutdown never waits on an upgraded connection.
#[derive(Clone)]
pub struct DomainSnapshots {
    pub tasks: Arc<dyn Fn() -> Value + Send + Sync>,
    pub crons: Arc<dyn Fn() -> Value + Send + Sync>,
    pub background: Arc<dyn Fn() -> Value + Send + Sync>,
}

pub struct WsDeps {
    pub registry: Arc<Registry>,
    pub anchor: Arc<Mutex<window_anchor::Service>>,
    pub chat: ChatDeps,
    pub clients: Arc<AtomicUsize>,
    pub policy: HttpPolicy,
    pub snapshots: Option<DomainSnapshots>,
    /// Host shutdown broadcast: every session closes `1001` and returns when
    /// it flips to `true`. `None` in tests that do not exercise shutdown.
    pub shutdown: Option<tokio::sync::watch::Receiver<bool>>,
}

#[derive(Clone)]
struct WsState {
    registry: Arc<Registry>,
    anchor: Arc<Mutex<window_anchor::Service>>,
    chat: Arc<ChatDeps>,
    clients: Arc<AtomicUsize>,
    policy: HttpPolicy,
    snapshots: Option<DomainSnapshots>,
    shutdown: Option<tokio::sync::watch::Receiver<bool>>,
    heartbeat: Duration,
}

// VERIFY: http-ws-router
/// Mounts `GET /ws` (`pty-ws.mjs:176`).
pub fn router(deps: WsDeps) -> Router {
    router_with_heartbeat(deps, HEARTBEAT)
}

/// [`router`] with an explicit ping period, so tests need not wait 30 s.
fn router_with_heartbeat(deps: WsDeps, heartbeat: Duration) -> Router {
    let state = WsState {
        registry: deps.registry,
        anchor: deps.anchor,
        chat: Arc::new(deps.chat),
        clients: deps.clients,
        policy: deps.policy,
        snapshots: deps.snapshots,
        shutdown: deps.shutdown,
        heartbeat,
    };
    Router::new().route("/ws", get(upgrade)).with_state(state)
}

async fn upgrade(
    State(state): State<WsState>,
    upgrade: WebSocketUpgrade,
    RawQuery(query): RawQuery,
    headers: HeaderMap,
) -> Response {
    // A browser always sends Origin on a WS upgrade (`pty-ws.mjs:96-98`), so the
    // verdict has to be taken here: Node finishes the upgrade first and only
    // then closes, and a pre-upgrade 403 is a different answer to the page.
    //
    // VERIFY: wave12-ws_dup_origin-2 — the whole header map goes to the
    // bridge, because Node judges the `, `-joined field: two `Origin` lines
    // (even identical ones) must close 1008, not pass on the first value.
    upgrade.on_upgrade(move |socket| connection(socket, state, query, headers))
}

async fn connection(
    mut socket: WebSocket,
    state: WsState,
    query: Option<String>,
    headers: HeaderMap,
) {
    // VERIFY: wave8-ws_origin-1 — `if (!originAllowed(req.headers.origin)) {
    // ws.close(1008, 'forbidden origin'); return; }` (`pty-ws.mjs:98`). Node's
    // `originAllowed` has no `Sec-Fetch-Site` argument, so only Origin decides.
    if !state.policy.websocket_origin_allowed(&headers) {
        let _ = close(&mut socket, 1008, "forbidden origin").await;
        return;
    }
    // `if (t !== token) { ws.close(1008, 'unauthorized'); return; }` (`:115-118`).
    if !state.policy.websocket_authenticated(query.as_deref()) {
        let _ = close(&mut socket, 1008, "unauthorized").await;
        return;
    }
    state.clients.fetch_add(1, Ordering::SeqCst);
    session(&mut socket, &state).await;
    state.clients.fetch_sub(1, Ordering::SeqCst);
}

/// Per-socket send state for the initialization window (`:12-27`).
#[derive(Default)]
struct SendState {
    initializing: bool,
    queue: VecDeque<Arc<str>>,
    queued_bytes: usize,
}

enum Delivery {
    Sent,
    Queued,
    /// Backlog over the cap: the caller closes `1013` (`:16-20`).
    Overflow,
    /// The underlying socket is gone.
    Closed,
}

/// `send(ws, msg)` (`pty-ws.mjs:9-27`).
async fn deliver(session: &mut SendState, socket: &mut WebSocket, frame: Arc<str>) -> Delivery {
    if session.initializing {
        let bytes = frame.len();
        if session.queue.len() >= INITIAL_MAX_FRAMES
            || session.queued_bytes + bytes > INITIAL_MAX_BYTES
        {
            session.initializing = false;
            session.queue.clear();
            return Delivery::Overflow;
        }
        session.queued_bytes += bytes;
        session.queue.push_back(frame);
        return Delivery::Queued;
    }
    match send_text(socket, &frame).await {
        Ok(()) => Delivery::Sent,
        Err(_) => Delivery::Closed,
    }
}

async fn session(socket: &mut WebSocket, state: &WsState) {
    let attached: Arc<Mutex<HashSet<String>>> = Arc::new(Mutex::new(HashSet::new()));
    let (tx, mut frames) = mpsc::unbounded_channel::<Arc<str>>();
    // `sockets.add(ws)` (`:126`): the bus fans every event into this channel.
    let subscription = state.registry.bus().subscribe(socket_listener(
        tx.clone(),
        attached.clone(),
        Arc::downgrade(&state.registry),
    ));

    // `const initial = [...]` (`:127-132`): computed before the anchor await.
    let mut initial: VecDeque<String> =
        initial_frames(&state.registry, state.snapshots.as_ref()).into();
    let anchor = state.anchor.clone();
    let mut anchor_task = tokio::task::spawn_blocking(move || anchor_frame(&anchor));
    let mut anchored = false;

    let mut client = Client {
        registry: state.registry.clone(),
        chat: state.chat.clone(),
        attached,
        tx,
        cancel: None,
    };
    let mut session = SendState {
        initializing: true,
        ..SendState::default()
    };
    // Node's first ping is one period out. Starting there also skips awaiting an
    // immediate first tick, which still waits for a time-driver turn (~15 ms
    // on Windows) and so delayed every connection's first frame.
    let mut heartbeat = tokio::time::interval_at(
        tokio::time::Instant::now() + state.heartbeat,
        state.heartbeat,
    );
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut shutdown = state.shutdown.clone();
    let mut alive = true;
    let mut open = true;

    while open {
        tokio::select! {
            _ = shutdown_signal(&mut shutdown) => {
                // The host is draining: close 1001 and let the upgrade finish so
                // graceful HTTP shutdown never waits on this socket.
                let _ = close(socket, 1001, "").await;
                open = false;
            }
            result = &mut anchor_task, if !anchored => {
                anchored = true;
                let Ok(Some(anchor_text)) = result else {
                    let _ = close(socket, 1011, "initial snapshot failed").await;
                    open = false;
                    continue;
                };
                // `for (const frame of firstFrames) ws.send(...)` (`:211-215`).
                while let Some(frame) = initial.pop_front() {
                    if send_text(socket, &frame).await.is_err() {
                        open = false;
                        break;
                    }
                }
                if !open {
                    continue;
                }
                if send_text(socket, &anchor_text).await.is_err() {
                    open = false;
                    continue;
                }
                // `ws.initializing = false; ... for (const frame of queued) ws.send(frame)`
                // (`:216-223`).
                session.initializing = false;
                while let Some(frame) = session.queue.pop_front() {
                    if send_text(socket, &frame).await.is_err() {
                        open = false;
                        break;
                    }
                }
                session.queue.clear();
                session.queued_bytes = 0;
            }
            frame = frames.recv() => {
                let Some(frame) = frame else {
                    open = false;
                    continue;
                };
                match deliver(&mut session, socket, frame).await {
                    Delivery::Overflow => {
                        let _ = close(socket, 1013, "initial snapshot backlog exceeded").await;
                        open = false;
                    }
                    Delivery::Closed => open = false,
                    Delivery::Sent | Delivery::Queued => {}
                }
            }
            message = socket.recv() => {
                match message {
                    Some(Ok(Message::Text(text))) => {
                        let replies = client.handle(text.as_str()).await;
                        let replies = queued_then(&mut frames, replies);
                        if !deliver_all(&mut session, socket, replies).await {
                            open = false;
                        }
                    }
                    // `JSON.parse(raw.toString())` (`:115`): binary frames are
                    // decoded as text too.
                    Some(Ok(Message::Binary(bytes))) => {
                        let raw = String::from_utf8_lossy(&bytes).into_owned();
                        let replies = client.handle(&raw).await;
                        let replies = queued_then(&mut frames, replies);
                        if !deliver_all(&mut session, socket, replies).await {
                            open = false;
                        }
                    }
                    Some(Ok(Message::Pong(_))) => alive = true,
                    Some(Ok(Message::Ping(payload))) => {
                        if socket.send(Message::Pong(payload)).await.is_err() {
                            open = false;
                        }
                    }
                    // `ws` answers a protocol violation with close 1002 before
                    // destroying the socket; tungstenite only returns the error.
                    Some(Err(_)) => {
                        let _ = close(socket, 1002, "protocol error").await;
                        open = false;
                    }
                    // VERIFY: wave21-wsclose-1 — `ws` completes the
                    // client-initiated Close handshake: the peer's own code and
                    // reason are echoed (tungstenite has already queued that
                    // reply, normalizing a non-wire code to 1002), so flush it
                    // before the transport is dropped — otherwise the peer
                    // observes 1006/EOF.
                    Some(Ok(Message::Close(_))) => {
                        let _ = socket.flush().await;
                        open = false;
                    }
                    None => open = false,
                }
            }
            _ = heartbeat.tick() => {
                // `if (ws.isAlive === false) { ws.terminate(); ... }` (`:88-92`).
                if !alive {
                    open = false;
                    continue;
                }
                alive = false;
                if socket.send(Message::Ping(Bytes::new())).await.is_err() {
                    open = false;
                }
            }
        }
    }

    // `ws.on('close', ...)` (`:199-205`).
    if let Some(cancel) = client.cancel.take() {
        cancel.cancel();
    }
    state.registry.bus().unsubscribe(subscription);
}

// VERIFY: wave10-ws_order-1
/// Node runs a handler synchronously, so bus frames it emitted (e.g. the
/// `list` from `reg.create`) reach the wire before its direct replies
/// (`pty-ws.mjs:139-158`). Drain what the handler queued first.
fn queued_then(
    frames: &mut mpsc::UnboundedReceiver<Arc<str>>,
    replies: Vec<Arc<str>>,
) -> Vec<Arc<str>> {
    let mut out: Vec<Arc<str>> = std::iter::from_fn(|| frames.try_recv().ok()).collect();
    out.extend(replies);
    out
}

async fn deliver_all(
    session: &mut SendState,
    socket: &mut WebSocket,
    frames: Vec<Arc<str>>,
) -> bool {
    for frame in frames {
        match deliver(session, socket, frame).await {
            Delivery::Sent | Delivery::Queued => {}
            Delivery::Overflow => {
                let _ = close(socket, 1013, "initial snapshot backlog exceeded").await;
                return false;
            }
            Delivery::Closed => return false,
        }
    }
    true
}

/// Resolves when the host broadcasts shutdown. Without a channel (tests) or
/// after the sender is dropped it pends forever instead of closing the socket.
async fn shutdown_signal(shutdown: &mut Option<tokio::sync::watch::Receiver<bool>>) {
    let Some(receiver) = shutdown.as_mut() else {
        return std::future::pending().await;
    };
    loop {
        if *receiver.borrow() {
            return;
        }
        if receiver.changed().await.is_err() {
            return std::future::pending().await;
        }
    }
}

async fn send_text(socket: &mut WebSocket, payload: &str) -> Result<(), axum::Error> {
    socket.send(Message::Text(payload.to_owned().into())).await
}

async fn close(socket: &mut WebSocket, code: u16, reason: &str) -> Result<(), axum::Error> {
    socket
        .send(Message::Close(Some(CloseFrame {
            code,
            reason: reason.to_owned().into(),
        })))
        .await
}

fn text(value: &Value) -> Arc<str> {
    Arc::from(
        serde_json::to_string(value).expect("a JSON object built from JSON values serializes"),
    )
}

/// `{ t: 'tasks', ...data }` / `{ t: 'history', ...data }` /
/// `{ t: 'background', ...data }` (`:63-82`): the tag first, then the payload's
/// own keys in order (`serde_json`'s `preserve_order` keeps that).
fn tagged(tag: &str, data: &Value) -> Value {
    let mut map = Map::new();
    map.insert("t".to_owned(), Value::String(tag.to_owned()));
    if let Value::Object(fields) = data {
        for (key, value) in fields {
            map.insert(key.clone(), value.clone());
        }
    }
    Value::Object(map)
}

/// The bus listener for one socket: filters `output` by the attached set and
/// serializes each event once (`:63-98`).
fn socket_listener(
    tx: mpsc::UnboundedSender<Arc<str>>,
    attached: Arc<Mutex<HashSet<String>>>,
    registry: Weak<Registry>,
) -> BusListener {
    Arc::new(move |event: &BusEvent| {
        let Some(frame) = frame_for(event, &attached, &registry) else {
            return;
        };
        // The receiver is dropped only after this listener is unsubscribed.
        let _ = tx.send(frame);
    })
}

fn frame_for(
    event: &BusEvent,
    attached: &Mutex<HashSet<String>>,
    registry: &Weak<Registry>,
) -> Option<Arc<str>> {
    match event {
        BusEvent::Output { id, data } => {
            if !attached.lock().unwrap().contains(id) {
                return None;
            }
            Some(text(&json!({ "t": "output", "id": id, "data": data })))
        }
        BusEvent::Status { id, status } => {
            Some(text(&json!({ "t": "status", "id": id, "status": status })))
        }
        // Listeners run after the registry lock is released, so reading it is safe.
        BusEvent::List(agents) => Some(text(&json!({
            "t": "list",
            "agents": agents,
            "recentRepos": registry.upgrade().map(|r| r.recent_repos()).unwrap_or_default(),
        }))),
        BusEvent::Usage(data) => Some(text(&json!({ "t": "usage", "data": data }))),
        BusEvent::Tasks(data) => Some(text(&tagged("tasks", data))),
        BusEvent::Crons(crons) => Some(text(&json!({ "t": "crons", "crons": crons }))),
        BusEvent::WindowAnchor(anchor) => {
            Some(text(&json!({ "t": "window-anchor", "anchor": anchor })))
        }
        BusEvent::History(data) => Some(text(&tagged("history", data))),
        BusEvent::Background(data) => Some(text(&tagged("background", data))),
    }
}

/// Read each domain at connection time, in Node's initial frame order.
fn initial_frames(registry: &Registry, snapshots: Option<&DomainSnapshots>) -> Vec<String> {
    let tasks = snapshots
        .map(|s| (s.tasks)())
        .unwrap_or_else(|| json!({"tasks": [], "history": []}));
    let crons = snapshots.map(|s| (s.crons)()).unwrap_or_else(|| json!([]));
    let background = snapshots.map(|s| (s.background)()).unwrap_or_else(|| {
        json!({
            "config": {"jobs": []}, "lastTick": null, "liveTaskId": null,
            "nextDueAt": BACKGROUND_TICK_MS,
        })
    });
    vec![
        serde_json::to_string(&json!({
            "t": "list",
            "agents": registry.snapshot(),
            "recentRepos": registry.recent_repos(),
        }))
        .expect("a list frame serializes"),
        serde_json::to_string(&tagged("tasks", &tasks)).expect("a tasks frame serializes"),
        serde_json::to_string(&json!({ "t": "crons", "crons": crons }))
            .expect("a crons frame serializes"),
        serde_json::to_string(&tagged("background", &background))
            .expect("a background frame serializes"),
    ]
}

/// `snapshotWindowAnchor()` (`window-anchor.mjs:221-224`, `:230`): the anchor
/// service's current snapshot. `None` means the anchor could not be read, which
/// closes the socket `1011` (`pty-ws.mjs:224-231`).
fn anchor_frame(anchor: &Mutex<window_anchor::Service>) -> Option<String> {
    let mut service = anchor.lock().ok()?;
    let response = service.dispatch("window_anchor_snapshot", &json!({ "now_ms": 0 }));
    Some(
        serde_json::to_string(&json!({
            "t": "window-anchor",
            "anchor": response["snapshot"],
        }))
        .ok()?,
    )
}

/// `SHADOW && !SHADOW_WS_OK.has(m.t)` (`pty-ws.mjs`): a missing or non-string
/// `t` is not in the allow set either.
fn shadow_ws_denies(shadow: bool, tag: Option<&str>) -> bool {
    shadow && !tag.is_some_and(crate::shadow::ws_allows)
}

/// One socket's message handler (`:134-196`).
struct Client {
    registry: Arc<Registry>,
    chat: Arc<ChatDeps>,
    attached: Arc<Mutex<HashSet<String>>>,
    tx: mpsc::UnboundedSender<Arc<str>>,
    cancel: Option<Cancel>,
}

impl Client {
    async fn handle(&mut self, raw: &str) -> Vec<Arc<str>> {
        // `try { m = JSON.parse(raw) } catch { return; }` (`:135-136`).
        let Ok(message) = serde_json::from_str::<Value>(raw) else {
            return Vec::new();
        };
        let tag = message.get("t").and_then(Value::as_str);
        if shadow_ws_denies(crate::shadow::enabled(), tag) {
            return vec![text(&json!({ "t": "error", "msg": crate::shadow::ERROR }))];
        }
        let Some(tag) = tag else {
            return Vec::new();
        };
        match tag {
            "create" => self.create(&message).await,
            "fork" => self.fork(&message).await,
            "reattach" => self.reattach(&message).await,
            "attach" => self.attach(&message),
            "input" => {
                let id = string_field(&message, "id").unwrap_or_default();
                let data = string_field(&message, "data").unwrap_or_default();
                self.registry
                    .input(&id, &ws_filters::strip_color_responses(&data));
                Vec::new()
            }
            "txmeta" => {
                let id = string_field(&message, "id").unwrap_or_default();
                let mut reply = serde_json::Map::new();
                reply.insert("t".into(), json!("txmeta"));
                // `id: m.id`: JSON.stringify drops an absent id, keeps null.
                if let Some(raw) = message.get("id") {
                    reply.insert("id".into(), raw.clone());
                }
                reply.insert("written".into(), json!(self.registry.get_written(&id)));
                reply.insert("ringMax".into(), json!(RING_MAX));
                vec![text(&Value::Object(reply))]
            }
            "resize" => {
                let id = string_field(&message, "id").unwrap_or_default();
                let cols = number_field(&message, "cols");
                let rows = number_field(&message, "rows");
                self.registry.resize(&id, cols, rows);
                Vec::new()
            }
            "kill" => {
                let id = string_field(&message, "id").unwrap_or_default();
                let _ = self.registry.kill(&id);
                Vec::new()
            }
            "reorder" => {
                // `if (!Array.isArray(ids) || ...) return;` (`agents.mjs:629`):
                // a missing/non-array field must not become an empty-registry
                // "permutation". Non-string elements never match a key.
                if let Some(items) = message.get("ids").and_then(Value::as_array) {
                    if items.iter().all(Value::is_string) {
                        let _ = self.registry.reorder(&strings(items));
                    }
                }
                Vec::new()
            }
            "respawn" => {
                let id = string_field(&message, "id").unwrap_or_default();
                let registry = self.registry.clone();
                let _ = tokio::task::spawn_blocking(move || registry.respawn(&id)).await;
                Vec::new()
            }
            "respawnAll" => {
                let registry = self.registry.clone();
                let _ = tokio::task::spawn_blocking(move || registry.respawn_all()).await;
                Vec::new()
            }
            "chat" => self.start_chat(&message),
            "chat:stop" => {
                if let Some(cancel) = self.cancel.take() {
                    cancel.cancel();
                }
                Vec::new()
            }
            _ => Vec::new(),
        }
    }

    async fn create(&mut self, message: &Value) -> Vec<Arc<str>> {
        let input = CreateAgent {
            cwd: string_field(message, "cwd"),
            title: string_field(message, "title"),
            model: string_field(message, "model"),
            scopes: message
                .get("scopes")
                .and_then(Value::as_array)
                .map(|items| strings(items)),
            session_id: string_field(message, "sessionId"),
            tool: string_field(message, "tool"),
            ..CreateAgent::default()
        };
        let registry = self.registry.clone();
        match tokio::task::spawn_blocking(move || registry.create(input)).await {
            Ok(Ok(agent)) => {
                self.attached.lock().unwrap().insert(agent.id.clone());
                vec![text(&json!({ "t": "attached", "id": agent.id }))]
            }
            Ok(Err(error)) => vec![text(&json!({
                "t": "error",
                "msg": format!("spawn failed: {error}"),
            }))],
            Err(_) => vec![text(&json!({
                "t": "error",
                "msg": "spawn failed: registry task failed",
            }))],
        }
    }

    async fn fork(&mut self, message: &Value) -> Vec<Arc<str>> {
        let id = string_field(message, "id").unwrap_or_default();
        let title = string_field(message, "title").unwrap_or_default();
        let registry = self.registry.clone();
        match tokio::task::spawn_blocking(move || registry.fork(&id, &title)).await {
            Ok(Ok(agent)) => {
                self.attached.lock().unwrap().insert(agent.id.clone());
                vec![text(&json!({ "t": "attached", "id": agent.id }))]
            }
            Ok(Err(error)) => vec![text(&json!({
                "t": "error",
                "msg": format!("fork failed: {error}"),
            }))],
            Err(_) => vec![text(&json!({
                "t": "error",
                "msg": "fork failed: registry task failed",
            }))],
        }
    }

    async fn reattach(&mut self, message: &Value) -> Vec<Arc<str>> {
        let id = string_field(message, "id").unwrap_or_default();
        let registry = self.registry.clone();
        match tokio::task::spawn_blocking(move || registry.reattach(&id)).await {
            Ok(Ok(Some(agent))) => {
                self.attached.lock().unwrap().insert(agent.id.clone());
                vec![text(&json!({ "t": "attached", "id": agent.id }))]
            }
            Ok(Ok(None)) => Vec::new(),
            Ok(Err(error)) => vec![text(&json!({
                "t": "error",
                "msg": format!("reattach failed: {error}"),
            }))],
            Err(_) => vec![text(&json!({
                "t": "error",
                "msg": "reattach failed: registry task failed",
            }))],
        }
    }

    fn attach(&mut self, message: &Value) -> Vec<Arc<str>> {
        let id = string_field(message, "id").unwrap_or_default();
        // `if (!reg.getStatus(m.id)) return;` (`:170`).
        let Some(status) = self.registry.get_status(&id) else {
            return Vec::new();
        };
        self.attached.lock().unwrap().insert(id.clone());
        // Replay the scrollback minus stale terminal queries (`:172`).
        let data = ws_filters::strip_queries(&self.registry.get_buf(&id));
        let status = self.registry.get_status(&id).unwrap_or(status);
        vec![
            text(&json!({ "t": "output", "id": id, "data": data })),
            text(&json!({ "t": "status", "id": id, "status": status })),
        ]
    }

    fn start_chat(&mut self, message: &Value) -> Vec<Arc<str>> {
        // One in-flight chat per socket: a new request cancels the prior
        // (`:164-165`).
        if let Some(previous) = self.cancel.take() {
            previous.cancel();
        }
        let cancel = Cancel::new();
        self.cancel = Some(cancel.clone());
        // VERIFY: wave12-chat_auth_first-3 — `streamChat` awaits
        // `claudeOauthToken()` before destructuring the payload
        // (`chat.mjs:98-103`), so a signed-out daemon answers `needsAuth` for
        // any payload shape, malformed fields included, and echoes the raw
        // `chatId` (`m.chatId`) exactly as received.
        if let Some(frame) = chat::auth_preflight(&self.chat, message.get("chatId").cloned()) {
            return serde_json::to_string(&frame)
                .map_or_else(|_| Vec::new(), |payload| vec![Arc::from(payload)]);
        }
        // VERIFY: wave15-chat-5 — every wrong-typed field is now raw, so an
        // object payload cannot fail here; this frame is the last-resort
        // terminal answer (with the raw `chatId`) so the UI never waits forever.
        let request = match serde_json::from_value::<ChatRequest>(message.clone()) {
            Ok(request) => request,
            Err(error) => {
                let frame = chat::ChatFrame::Error {
                    chat_id: message.get("chatId").cloned(),
                    needs_auth: None,
                    msg: format!("invalid chat request: {error}"),
                };
                return serde_json::to_string(&frame)
                    .map_or_else(|_| Vec::new(), |payload| vec![Arc::from(payload)]);
            }
        };
        let chat_id = request.chat_id.clone();
        let deps = self.chat.clone();
        let tx = self.tx.clone();
        tokio::spawn(async move {
            let frames = tx.clone();
            let result = chat::stream_chat(
                request,
                &deps,
                move |frame| {
                    if let Ok(payload) = serde_json::to_string(&frame) {
                        let _ = frames.send(Arc::from(payload));
                    }
                },
                &cancel,
            )
            .await;
            // `streamChat(...).catch((e) => send(ws, { t: 'chat:error', chatId, msg }))`
            // (`:166-167`).
            if let Err(error) = result {
                let frame = chat::ChatFrame::Error {
                    chat_id,
                    needs_auth: None,
                    msg: error,
                };
                if let Ok(payload) = serde_json::to_string(&frame) {
                    let _ = tx.send(Arc::from(payload));
                }
            }
        });
        Vec::new()
    }
}

fn string_field(message: &Value, key: &str) -> Option<String> {
    message.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn strings(items: &[Value]) -> Vec<String> {
    items
        .iter()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect()
}

fn number_field(message: &Value, key: &str) -> u16 {
    message
        .get(key)
        .and_then(Value::as_u64)
        .map(|value| value.min(u64::from(u16::MAX)) as u16)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shadow_ws_gate_allows_only_read_only_messages() {
        assert!(!shadow_ws_denies(true, Some("attach")));
        assert!(!shadow_ws_denies(true, Some("txmeta")));
        assert!(!shadow_ws_denies(true, Some("chat:stop")));
        assert!(shadow_ws_denies(true, Some("create")));
        assert!(shadow_ws_denies(true, Some("chat")));
        assert!(shadow_ws_denies(true, None));
        assert!(!shadow_ws_denies(false, Some("create")));
    }
    use crate::agent_registry::{PtyPort, RegistryConfig};
    use crate::agent_spawn::{Bins, LaunchSpec, SpawnPaths};
    use crate::bus::Bus;
    use crate::pty::PtyEvent;
    use crate::transcript_service::{Inputs, TranscriptService};
    use std::collections::HashMap;
    use std::fs;
    use std::net::SocketAddr;
    use std::path::PathBuf;
    use std::sync::atomic::AtomicU32;
    use std::time::{SystemTime, UNIX_EPOCH};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpStream;

    // Per-tag protocol tests, split so they can grow independently; they reuse
    // this module's private fixture, fake port and raw client.
    mod events;
    mod tags_a;
    mod tags_b;
    mod tags_c;

    fn run<F: std::future::Future>(future: F) -> F::Output {
        tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(future)
    }

    /// Temp dirs for the registry, fake binaries and the transcript service.
    /// Nothing touches the real home, state or a real process.
    struct Fixture {
        root: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            static NEXT: AtomicU32 = AtomicU32::new(0);
            let stamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let root = std::env::temp_dir().join(format!(
                "singularity-http-ws-{}-{stamp}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            for dir in ["home", "repo", "state", "cache", "codex-home"] {
                fs::create_dir_all(root.join(dir)).unwrap();
            }
            Self { root }
        }

        fn touch(&self, rel: &str) -> PathBuf {
            let path = self.root.join(rel);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, b"").unwrap();
            path
        }

        fn bins(&self) -> Bins {
            let claude = self.touch("bin/claude.exe");
            let ollama = self.touch("bin/ollama.exe");
            let codex = self.touch("bin/codex.exe");
            Bins::resolve(
                Some(claude.to_str().unwrap()),
                Some(ollama.to_str().unwrap()),
                Some(codex.to_str().unwrap()),
                SpawnPaths {
                    home: self.root.join("home"),
                    scope_root: None,
                    cache_dir: self.root.join("cache"),
                    codex_home: self.root.join("codex-home"),
                    models_state: self.root.join("state/models.json"),
                },
            )
        }

        fn registry(&self, port: Arc<FakePort>) -> Arc<Registry> {
            Arc::new(Registry::new(
                Bus::new(),
                port,
                RegistryConfig {
                    state_file: self.root.join("state/agents.json"),
                    bins: self.bins(),
                    parent_env: Default::default(),
                    clock: crate::agent_registry::system_clock(),
                },
            ))
        }

        fn chat(&self) -> ChatDeps {
            let inputs = Inputs {
                state_dir: self.root.join("state"),
                claude_home: self.root.join("home"),
                codex_home: self.root.join("codex-home"),
                model_catalog: Vec::new(),
            };
            ChatDeps::new(
                Arc::new(TranscriptService::new(inputs)),
                self.root.join("home/.claude/.credentials.json"),
            )
        }

        fn repo(&self) -> String {
            self.root.join("repo").to_string_lossy().into_owned()
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[derive(Default)]
    struct FakePort {
        writes: Mutex<Vec<(String, Vec<u8>)>>,
        generations: Mutex<HashMap<String, u64>>,
        next_pid: AtomicU32,
    }

    impl FakePort {
        fn new() -> Arc<Self> {
            Arc::new(Self {
                next_pid: AtomicU32::new(1000),
                ..Self::default()
            })
        }

        fn generation(&self, id: &str) -> u64 {
            *self
                .generations
                .lock()
                .unwrap()
                .get(id)
                .expect("the agent was spawned")
        }

        fn writes(&self) -> Vec<(String, Vec<u8>)> {
            self.writes.lock().unwrap().clone()
        }
    }

    impl PtyPort for FakePort {
        fn spawn(&self, id: &str, generation: u64, _spec: LaunchSpec) -> Result<u32, String> {
            self.generations
                .lock()
                .unwrap()
                .insert(id.to_owned(), generation);
            Ok(self.next_pid.fetch_add(1, Ordering::SeqCst))
        }

        fn write(&self, id: &str, data: &[u8]) -> Result<(), String> {
            self.writes
                .lock()
                .unwrap()
                .push((id.to_owned(), data.to_vec()));
            Ok(())
        }

        fn resize(&self, _id: &str, _cols: u16, _rows: u16) -> Result<(), String> {
            Ok(())
        }

        fn kill(&self, _id: &str) -> Result<(), String> {
            Ok(())
        }
    }

    fn create_input(fixture: &Fixture, id: &str) -> CreateAgent {
        CreateAgent {
            cwd: Some(fixture.repo()),
            title: Some("demo".to_owned()),
            model: Some("claude".to_owned()),
            session_id: Some(id.to_owned()),
            ..CreateAgent::default()
        }
    }

    fn deps(
        fixture: &Fixture,
        registry: Arc<Registry>,
        clients: Arc<AtomicUsize>,
        token: Option<&str>,
    ) -> WsDeps {
        WsDeps {
            registry,
            anchor: Arc::new(Mutex::new(window_anchor::Service::default())),
            chat: fixture.chat(),
            clients,
            policy: HttpPolicy {
                daemon_port: 4317,
                vite_port: 5317,
                token: token.map(str::to_owned),
            },
            shutdown: None,
            snapshots: None,
        }
    }

    struct Server {
        address: SocketAddr,
        handle: tokio::task::JoinHandle<std::io::Result<()>>,
    }

    impl Drop for Server {
        fn drop(&mut self) {
            self.handle.abort();
        }
    }

    async fn serve(deps: WsDeps) -> Server {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let handle = tokio::spawn(async move { axum::serve(listener, router(deps)).await });
        Server { address, handle }
    }

    /// A minimal RFC 6455 client over a raw `TcpStream`: manual upgrade and
    /// frame encode/decode, no WebSocket crate (the daemon's dependency set has
    /// none available to tests).
    struct RawClient {
        stream: TcpStream,
    }

    impl RawClient {
        async fn connect(address: SocketAddr, path: &str) -> Self {
            Self::connect_with_origin(address, path, None).await
        }

        async fn connect_with_origin(
            address: SocketAddr,
            path: &str,
            origin: Option<&str>,
        ) -> Self {
            let origins: Vec<&str> = origin.into_iter().collect();
            Self::connect_with_origins(address, path, &origins).await
        }

        /// One `Origin` line per entry, so the server sees a repeated field
        /// exactly as a hostile client can send it.
        async fn connect_with_origins(address: SocketAddr, path: &str, origins: &[&str]) -> Self {
            let mut stream = TcpStream::connect(address).await.unwrap();
            let origin: String = origins
                .iter()
                .map(|origin| format!("Origin: {origin}\r\n"))
                .collect();
            let request = format!(
                "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\n{origin}Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
                address.port()
            );
            stream.write_all(request.as_bytes()).await.unwrap();
            let mut head = Vec::new();
            let mut byte = [0u8; 1];
            loop {
                stream.read_exact(&mut byte).await.unwrap();
                head.push(byte[0]);
                if head.ends_with(b"\r\n\r\n") {
                    break;
                }
            }
            let head = String::from_utf8(head).unwrap();
            assert!(head.starts_with("HTTP/1.1 101"), "{head}");
            Self { stream }
        }

        async fn read_exact(&mut self, buffer: &mut [u8]) {
            tokio::time::timeout(Duration::from_secs(5), self.stream.read_exact(buffer))
                .await
                .expect("a frame within 5s")
                .unwrap();
        }

        async fn send_text(&mut self, text: &str) {
            self.send_frame(0x1, text.as_bytes()).await;
        }

        async fn send_frame(&mut self, opcode: u8, payload: &[u8]) {
            let mask = [0x12u8, 0x34, 0x56, 0x78];
            let mut frame = vec![0x80 | opcode];
            if payload.len() < 126 {
                frame.push(0x80 | payload.len() as u8);
            } else {
                frame.push(0x80 | 126);
                frame.extend_from_slice(&(payload.len() as u16).to_be_bytes());
            }
            frame.extend_from_slice(&mask);
            frame.extend(payload.iter().enumerate().map(|(i, b)| b ^ mask[i % 4]));
            self.stream.write_all(&frame).await.unwrap();
        }

        async fn frame(&mut self) -> (u8, Vec<u8>) {
            let mut head = [0u8; 2];
            self.read_exact(&mut head).await;
            let opcode = head[0] & 0x0f;
            let masked = head[1] & 0x80 != 0;
            let mut length = usize::from(head[1] & 0x7f);
            if length == 126 {
                let mut extended = [0u8; 2];
                self.read_exact(&mut extended).await;
                length = usize::from(u16::from_be_bytes(extended));
            } else if length == 127 {
                let mut extended = [0u8; 8];
                self.read_exact(&mut extended).await;
                length = u64::from_be_bytes(extended) as usize;
            }
            let mut mask = [0u8; 4];
            if masked {
                self.read_exact(&mut mask).await;
            }
            let mut payload = vec![0u8; length];
            self.read_exact(&mut payload).await;
            if masked {
                for (index, byte) in payload.iter_mut().enumerate() {
                    *byte ^= mask[index % 4];
                }
            }
            (opcode, payload)
        }

        async fn json(&mut self) -> Value {
            loop {
                let (opcode, payload) = self.frame().await;
                match opcode {
                    0x1 => return serde_json::from_slice(&payload).unwrap(),
                    0x8 => panic!("socket closed during the test: {payload:?}"),
                    0x9 => self.send_frame(0xa, &payload).await,
                    _ => {}
                }
            }
        }

        async fn close(&mut self) -> (u16, String) {
            let (opcode, payload) = self.frame().await;
            assert_eq!(opcode, 0x8, "expected a close frame");
            assert!(payload.len() >= 2, "close frame without a status code");
            let code = u16::from_be_bytes([payload[0], payload[1]]);
            (code, String::from_utf8_lossy(&payload[2..]).into_owned())
        }
    }

    async fn snapshot(client: &mut RawClient) -> Vec<Value> {
        let mut frames = Vec::new();
        for _ in 0..5 {
            frames.push(client.json().await);
        }
        frames
    }

    #[test]
    fn initial_snapshot_frames_arrive_in_node_order() {
        run(async {
            let fixture = Fixture::new();
            let port = FakePort::new();
            let registry = fixture.registry(port);
            let agent = registry.create(create_input(&fixture, "snapshot")).unwrap();
            let server = serve(deps(
                &fixture,
                registry,
                Arc::new(AtomicUsize::new(0)),
                None,
            ))
            .await;
            let mut client = RawClient::connect(server.address, "/ws").await;

            let frames = snapshot(&mut client).await;
            let tags: Vec<&str> = frames
                .iter()
                .map(|frame| frame["t"].as_str().unwrap())
                .collect();
            assert_eq!(
                tags,
                ["list", "tasks", "crons", "background", "window-anchor"]
            );
            assert_eq!(frames[0]["agents"][0]["id"], json!(agent.id));
            assert_eq!(frames[0]["recentRepos"], json!([agent.cwd]));
            assert_eq!(
                frames[1],
                json!({ "t": "tasks", "tasks": [], "history": [] })
            );
            assert_eq!(frames[2], json!({ "t": "crons", "crons": [] }));
            assert_eq!(frames[3]["config"], json!({ "jobs": [] }));
            assert_eq!(frames[3]["liveTaskId"], Value::Null);
            assert_eq!(frames[3]["nextDueAt"], json!(BACKGROUND_TICK_MS));
            assert!(frames[4]["anchor"]["claude"].is_object(), "{:?}", frames[4]);
        });
    }

    #[test]
    fn initial_frames_read_current_domain_snapshots() {
        let fixture = Fixture::new();
        let registry = fixture.registry(FakePort::new());
        let tasks = Arc::new(Mutex::new(
            json!({"tasks": [{"id": "task-1"}], "history": []}),
        ));
        let task_state = tasks.clone();
        let snapshots = DomainSnapshots {
            tasks: Arc::new(move || task_state.lock().unwrap().clone()),
            crons: Arc::new(|| json!([{"id": "cron-1"}])),
            background: Arc::new(
                || json!({"config": {"jobs": [{"id": "job-1"}]}, "liveTaskId": "task-1"}),
            ),
        };
        let frames: Vec<Value> = initial_frames(&registry, Some(&snapshots))
            .iter()
            .map(|frame| serde_json::from_str(frame).unwrap())
            .collect();
        assert_eq!(frames[1]["tasks"][0]["id"], "task-1");
        assert_eq!(frames[2]["crons"][0]["id"], "cron-1");
        assert_eq!(frames[3]["config"]["jobs"][0]["id"], "job-1");
        assert_eq!(frames[3]["liveTaskId"], "task-1");
        tasks.lock().unwrap()["tasks"] = json!([{"id": "task-2"}]);
        let next: Value =
            serde_json::from_str(&initial_frames(&registry, Some(&snapshots))[1]).unwrap();
        assert_eq!(next["tasks"][0]["id"], "task-2");
    }

    #[test]
    fn host_shutdown_broadcast_closes_sockets_1001() {
        run(async {
            let fixture = Fixture::new();
            let port = FakePort::new();
            let registry = fixture.registry(port);
            let (shutdown, shutdown_rx) = tokio::sync::watch::channel(false);
            let mut deps = deps(&fixture, registry, Arc::new(AtomicUsize::new(0)), None);
            deps.shutdown = Some(shutdown_rx);
            let server = serve(deps).await;
            let mut client = RawClient::connect(server.address, "/ws").await;
            let _ = snapshot(&mut client).await;

            shutdown.send(true).unwrap();
            let (code, reason) = client.close().await;
            assert_eq!(code, 1001);
            assert_eq!(reason, "");
        });
    }

    #[test]
    fn attach_replays_scrollback_with_queries_stripped_then_status() {
        run(async {
            let fixture = Fixture::new();
            let port = FakePort::new();
            let registry = fixture.registry(port.clone());
            let agent = registry.create(create_input(&fixture, "replay")).unwrap();
            let generation = port.generation(&agent.id);
            registry.on_pty_event(PtyEvent::Output {
                id: agent.id.clone(),
                generation,
                bytes: b"a\x1b[cb\x1b]10;?\x07c".to_vec(),
            });
            let server = serve(deps(
                &fixture,
                registry,
                Arc::new(AtomicUsize::new(0)),
                None,
            ))
            .await;
            let mut client = RawClient::connect(server.address, "/ws").await;
            let _ = snapshot(&mut client).await;

            client
                .send_text(&json!({ "t": "attach", "id": agent.id }).to_string())
                .await;
            assert_eq!(
                client.json().await,
                json!({ "t": "output", "id": agent.id, "data": "abc" })
            );
            assert_eq!(
                client.json().await,
                json!({ "t": "status", "id": agent.id, "status": "running" })
            );
        });
    }

    #[test]
    fn input_forwards_through_the_color_response_filter() {
        run(async {
            let fixture = Fixture::new();
            let port = FakePort::new();
            let registry = fixture.registry(port.clone());
            let agent = registry.create(create_input(&fixture, "typing")).unwrap();
            let server = serve(deps(
                &fixture,
                registry,
                Arc::new(AtomicUsize::new(0)),
                None,
            ))
            .await;
            let mut client = RawClient::connect(server.address, "/ws").await;
            let _ = snapshot(&mut client).await;

            client
                .send_text(
                    &json!({
                        "t": "input",
                        "id": agent.id,
                        "data": "hi\x1b]11;rgb:0b0b/0808/1313\x1b\\there",
                    })
                    .to_string(),
                )
                .await;
            let mut writes = Vec::new();
            for _ in 0..200 {
                writes = port.writes();
                if !writes.is_empty() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            assert_eq!(writes, vec![(agent.id.clone(), b"hithere".to_vec())]);
        });
    }

    #[test]
    fn heartbeat_terminates_a_socket_that_never_pongs() {
        run(async {
            let fixture = Fixture::new();
            let port = FakePort::new();
            let registry = fixture.registry(port);
            let clients = Arc::new(AtomicUsize::new(0));
            let deps = deps(&fixture, registry, clients.clone(), None);
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let router = router_with_heartbeat(deps, Duration::from_millis(100));
            let _server = Server {
                address,
                handle: tokio::spawn(async move { axum::serve(listener, router).await }),
            };
            let mut client = RawClient::connect(address, "/ws").await;
            let _ = snapshot(&mut client).await;
            assert_eq!(clients.load(Ordering::SeqCst), 1);

            // The client stays open but never reads, so pings go unanswered.
            for _ in 0..100 {
                if clients.load(Ordering::SeqCst) == 0 {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            assert_eq!(clients.load(Ordering::SeqCst), 0);
            drop(client);
        });
    }

    #[test]
    fn a_wrong_token_upgrades_then_closes_1008_unauthorized() {
        run(async {
            let fixture = Fixture::new();
            let port = FakePort::new();
            let registry = fixture.registry(port);
            let clients = Arc::new(AtomicUsize::new(0));
            let server = serve(deps(&fixture, registry, clients.clone(), Some("secret"))).await;

            let mut denied = RawClient::connect(server.address, "/ws?token=wrong").await;
            let (code, reason) = denied.close().await;
            assert_eq!(code, 1008);
            assert_eq!(reason, "unauthorized");
            assert_eq!(clients.load(Ordering::SeqCst), 0);

            let mut missing = RawClient::connect(server.address, "/ws").await;
            assert_eq!(missing.close().await.0, 1008);
        });
    }

    // VERIFY: wave8-ws_origin-2 — the answer to a disallowed Origin is a
    // completed upgrade followed by `1008 forbidden origin`, not a 403.
    #[test]
    fn a_disallowed_origin_upgrades_then_closes_1008_forbidden_origin() {
        run(async {
            let fixture = Fixture::new();
            let port = FakePort::new();
            let registry = fixture.registry(port);
            let clients = Arc::new(AtomicUsize::new(0));
            let server = serve(deps(&fixture, registry, clients.clone(), None)).await;

            // `connect_with_origin` asserts the 101, so a pre-upgrade rejection fails here.
            let mut denied =
                RawClient::connect_with_origin(server.address, "/ws", Some("https://evil.test"))
                    .await;
            let (code, reason) = denied.close().await;
            assert_eq!(code, 1008);
            assert_eq!(reason, "forbidden origin");
            assert_eq!(clients.load(Ordering::SeqCst), 0);

            // `SELF_HOSTS` holds both the daemon and Vite origins (`index.mjs:191`).
            let mut trusted = RawClient::connect_with_origin(
                server.address,
                "/ws",
                Some("http://127.0.0.1:4317"),
            )
            .await;
            assert_eq!(snapshot(&mut trusted).await.len(), 5);
            assert_eq!(clients.load(Ordering::SeqCst), 1);
        });
    }

    // VERIFY: wave12-ws_dup_origin-2 — Node judges the `, `-joined Origin
    // field, so a repeated Origin upgrades and then closes `1008 forbidden
    // origin` — even when the allowlisted origin is first, and even when both
    // lines are identical. It is never a pre-upgrade 403.
    #[test]
    fn duplicate_origin_headers_upgrade_then_close_1008_forbidden_origin() {
        run(async {
            let fixture = Fixture::new();
            let port = FakePort::new();
            let registry = fixture.registry(port);
            let clients = Arc::new(AtomicUsize::new(0));
            let server = serve(deps(&fixture, registry, clients.clone(), None)).await;

            for origins in [
                ["http://127.0.0.1:4317", "https://evil.test"],
                ["https://evil.test", "http://127.0.0.1:4317"],
                ["http://127.0.0.1:4317", "http://127.0.0.1:4317"],
            ] {
                // `connect_with_origins` asserts the 101, so a pre-upgrade
                // rejection fails here instead of reaching the close.
                let mut denied =
                    RawClient::connect_with_origins(server.address, "/ws", &origins).await;
                let (code, reason) = denied.close().await;
                assert_eq!(code, 1008, "{origins:?}");
                assert_eq!(reason, "forbidden origin", "{origins:?}");
                assert_eq!(clients.load(Ordering::SeqCst), 0, "{origins:?}");
            }

            // A single allowlisted Origin still completes normally.
            let mut trusted =
                RawClient::connect_with_origins(server.address, "/ws", &["http://127.0.0.1:4317"])
                    .await;
            assert_eq!(snapshot(&mut trusted).await.len(), 5);
            assert_eq!(clients.load(Ordering::SeqCst), 1);
        });
    }

    #[test]
    fn malformed_json_is_ignored_and_the_socket_keeps_working() {
        run(async {
            let fixture = Fixture::new();
            let port = FakePort::new();
            let registry = fixture.registry(port);
            let server = serve(deps(
                &fixture,
                registry,
                Arc::new(AtomicUsize::new(0)),
                None,
            ))
            .await;
            let mut client = RawClient::connect(server.address, "/ws").await;
            let _ = snapshot(&mut client).await;

            client.send_text("not json").await;
            client
                .send_text(&json!({ "t": "txmeta", "id": "missing" }).to_string())
                .await;
            assert_eq!(
                client.json().await,
                json!({ "t": "txmeta", "id": "missing", "written": 0, "ringMax": RING_MAX })
            );
        });
    }
}
