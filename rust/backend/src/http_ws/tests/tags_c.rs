//! WebSocket protocol tests (tags_c); child of `http_ws::tests`.
//!
//! Covers the `respawn`, `respawnAll`, `chat` and `chat:stop` cases of the
//! Node message handler (`pty-ws.mjs:160-170`) over a real loopback socket.
//! Node sends no reply for `respawn`/`respawnAll`/`chat:stop`; their only
//! client-visible effect is the list/chat broadcast the registry or the chat
//! task produces afterwards.

use super::*;
use std::net::Ipv4Addr;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;

/// `chat.mjs` no-credential frame text (`NO_TOKEN_MESSAGE` in `chat.rs`).
const NO_TOKEN: &str = "Claude not signed in — run `claude` to log in";

/// `usage.mjs:554-558` credentials the chat path reads before any network use.
fn signed_in(fixture: &Fixture) {
    let path = fixture.root.join("home/.claude/.credentials.json");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(
        path,
        json!({ "claudeAiOauth": { "accessToken": "fake-token" } }).to_string(),
    )
    .unwrap();
}

fn txmeta_frame(id: &str) -> Value {
    json!({ "t": "txmeta", "id": id, "written": 0, "ringMax": RING_MAX })
}

/// Barrier on the socket: the session handles one message at a time, so the
/// reply proves every earlier message on this socket — including a tag that
/// replies nothing — has been fully handled, and that no frame was emitted in
/// between.
async fn marker(client: &mut RawClient, id: &str) {
    client
        .send_text(&json!({ "t": "txmeta", "id": id }).to_string())
        .await;
    assert_eq!(client.json().await, txmeta_frame(id));
}

fn agent_ids(frame: &Value) -> Vec<String> {
    frame["agents"]
        .as_array()
        .unwrap_or_else(|| panic!("a list frame: {frame}"))
        .iter()
        .map(|agent| agent["id"].as_str().unwrap().to_owned())
        .collect()
}

/// A loopback endpoint for `ChatDeps::messages_url`. Every connection is
/// handed to the test, which decides when (and whether) to answer — no real
/// model, no external network.
async fn chat_endpoint() -> (String, mpsc::UnboundedReceiver<TcpStream>) {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    let address = listener.local_addr().unwrap();
    assert!(address.ip().is_loopback());
    let (tx, rx) = mpsc::unbounded_channel();
    tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                break;
            };
            if tx.send(stream).is_err() {
                break;
            }
        }
    });
    (format!("http://{address}/v1/messages"), rx)
}

async fn next_upstream(accepted: &mut mpsc::UnboundedReceiver<TcpStream>) -> TcpStream {
    tokio::time::timeout(Duration::from_secs(5), accepted.recv())
        .await
        .expect("the chat request reaches the fake endpoint")
        .expect("the listener task is alive")
}

/// Read the request head and its `content-length` body, so a test can assert
/// the outbound JSON as well as the frames.
async fn read_request(stream: &mut TcpStream) -> (String, Vec<u8>) {
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        stream.read_exact(&mut byte).await.unwrap();
        head.push(byte[0]);
        assert!(head.len() < 8192, "request head too large");
    }
    let head = String::from_utf8(head).unwrap();
    let length = head
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse::<usize>().unwrap())
        })
        .unwrap_or(0);
    let mut body = vec![0u8; length];
    if length > 0 {
        stream.read_exact(&mut body).await.unwrap();
    }
    (head, body)
}

/// Read the request head so the client is never blocked writing its body.
async fn read_request_head(stream: &mut TcpStream) {
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        stream.read_exact(&mut byte).await.unwrap();
        head.push(byte[0]);
        assert!(head.len() < 8192, "request head too large");
    }
}

async fn write_sse(stream: &mut TcpStream, body: &str) -> std::io::Result<()> {
    let head = format!(
        "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(head.as_bytes()).await?;
    stream.write_all(body.as_bytes()).await?;
    stream.flush().await
}

async fn respond_sse(stream: &mut TcpStream, body: &str) {
    write_sse(stream, body)
        .await
        .expect("the upstream socket is still open");
}

/// Answering a cancelled chat races the task's own teardown: it may already
/// have closed the connection, which leaves the same observable — no frame.
async fn respond_sse_if_open(stream: &mut TcpStream, body: &str) {
    let _ = write_sse(stream, body).await;
}

/// The chat task drops the upstream response when it returns (cancelled or
/// finished), which closes the connection. Waiting for that EOF is the
/// barrier that proves the task can no longer emit a frame — no sleep needed.
async fn wait_for_close(stream: &mut TcpStream) {
    // Drain whatever request body is still buffered, then wait for EOF.
    let closed = tokio::time::timeout(Duration::from_secs(5), async {
        let mut buf = [0u8; 1024];
        loop {
            match stream.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
        }
    })
    .await;
    assert!(
        closed.is_ok(),
        "the chat task dropped the upstream connection"
    );
}

fn sse_delta(text: &str) -> String {
    format!(
        "data: {}\n\n",
        json!({
            "type": "content_block_delta",
            "delta": { "type": "text_delta", "text": text },
        })
    )
}

const SSE_STOP: &str = "data: {\"type\":\"message_stop\"}\n\n";

fn sse_error(message: &str) -> String {
    format!(
        "data: {}\n\n",
        json!({ "type": "error", "error": { "message": message } })
    )
}

/// Drive one chat to its terminal frames: the request must reach the stub, the
/// stub answers delta + `message_stop`, and the client sees the matching
/// `chat:delta`/`chat:done` (raw `chatId` echoed). Returns the outbound body.
async fn expect_chat_proceeds(
    client: &mut RawClient,
    accepted: &mut mpsc::UnboundedReceiver<TcpStream>,
    payload: Value,
) -> Value {
    let chat_id = payload["chatId"].clone();
    client.send_text(&payload.to_string()).await;
    let mut upstream = next_upstream(accepted).await;
    let (_head, body) = read_request(&mut upstream).await;
    respond_sse(&mut upstream, &(sse_delta("hi") + SSE_STOP)).await;
    assert_eq!(
        client.json().await,
        json!({ "t": "chat:delta", "chatId": chat_id, "text": "hi" }),
        "{payload}"
    );
    assert_eq!(
        client.json().await,
        json!({ "t": "chat:done", "chatId": chat_id }),
        "{payload}"
    );
    serde_json::from_slice(&body).unwrap()
}

// VERIFY: wave9-tags_c-1
/// `case 'respawn': reg.respawn(m.id); break;` (`pty-ws.mjs:160`) replies
/// nothing; the effect is that the agent's exit resumes it with the same id
/// (`agents.mjs:609-617`), which the registry reports as two `list` frames:
/// the entry removed, then re-created with a new pty.
#[test]
fn respawn_arms_the_live_agent_and_its_exit_rebroadcasts_the_list() {
    run(async {
        let fixture = Fixture::new();
        let port = FakePort::new();
        let registry = fixture.registry(port.clone());
        let agent = registry
            .create(create_input(&fixture, "respawn-me"))
            .unwrap();
        let generation = port.generation(&agent.id);
        let server = serve(deps(
            &fixture,
            registry.clone(),
            Arc::new(AtomicUsize::new(0)),
            None,
        ))
        .await;
        let mut client = RawClient::connect(server.address, "/ws").await;
        let _ = snapshot(&mut client).await;

        client
            .send_text(&json!({ "t": "respawn", "id": agent.id }).to_string())
            .await;
        marker(&mut client, "armed").await;

        registry.on_pty_event(PtyEvent::Exit {
            id: agent.id.clone(),
            generation,
            exit_code: Some(0),
        });

        let removed = client.json().await;
        assert_eq!(removed["t"], "list", "{removed}");
        assert_eq!(agent_ids(&removed), Vec::<String>::new());

        let resumed = client.json().await;
        assert_eq!(resumed["t"], "list", "{resumed}");
        assert_eq!(agent_ids(&resumed), vec![agent.id.clone()]);
        // The resumed agent keeps its id and config but runs on a new pty.
        assert_eq!(resumed["agents"][0]["title"], json!("demo"));
        assert_ne!(resumed["agents"][0]["pid"], json!(1000));
    });
}

// VERIFY: wave9-tags_c-2
/// `case 'respawnAll': reg.respawnAll(); break;` (`pty-ws.mjs:161`) replies
/// nothing either; every live agent resumes on exit, so each exit broadcasts
/// the removed list and each resume the re-created one, in registry order.
#[test]
fn respawn_all_resumes_every_live_agent_on_exit() {
    run(async {
        let fixture = Fixture::new();
        let port = FakePort::new();
        let registry = fixture.registry(port.clone());
        let a = registry.create(create_input(&fixture, "a")).unwrap();
        let b = registry.create(create_input(&fixture, "b")).unwrap();
        let generation = (port.generation(&a.id), port.generation(&b.id));
        let server = serve(deps(
            &fixture,
            registry.clone(),
            Arc::new(AtomicUsize::new(0)),
            None,
        ))
        .await;
        let mut client = RawClient::connect(server.address, "/ws").await;
        let _ = snapshot(&mut client).await;

        client
            .send_text(&json!({ "t": "respawnAll" }).to_string())
            .await;
        marker(&mut client, "armed").await;

        registry.on_pty_event(PtyEvent::Exit {
            id: a.id.clone(),
            generation: generation.0,
            exit_code: Some(0),
        });
        let first = client.json().await;
        assert_eq!(first["t"], "list", "{first}");
        assert_eq!(agent_ids(&first), vec![b.id.clone()]);
        let second = client.json().await;
        assert_eq!(second["t"], "list", "{second}");
        assert_eq!(agent_ids(&second), vec![b.id.clone(), a.id.clone()]);

        registry.on_pty_event(PtyEvent::Exit {
            id: b.id.clone(),
            generation: generation.1,
            exit_code: Some(0),
        });
        let third = client.json().await;
        assert_eq!(third["t"], "list", "{third}");
        assert_eq!(agent_ids(&third), vec![a.id.clone()]);
        let fourth = client.json().await;
        assert_eq!(fourth["t"], "list", "{fourth}");
        assert_eq!(agent_ids(&fourth), vec![a.id.clone(), b.id.clone()]);
    });
}

// VERIFY: wave9-tags_c-3
/// `reg.respawn(m.id)` answers `false` for an unknown id and for a missing one
/// (`agents.mjs:609-611`); `pty-ws.mjs:160` ignores the result, so neither emits
/// a frame nor arms anything.
#[test]
fn respawn_of_an_unknown_or_missing_id_emits_nothing() {
    run(async {
        let fixture = Fixture::new();
        let port = FakePort::new();
        let registry = fixture.registry(port);
        let agent = registry.create(create_input(&fixture, "known")).unwrap();
        let server = serve(deps(
            &fixture,
            registry.clone(),
            Arc::new(AtomicUsize::new(0)),
            None,
        ))
        .await;
        let mut client = RawClient::connect(server.address, "/ws").await;
        let _ = snapshot(&mut client).await;

        client
            .send_text(&json!({ "t": "respawn", "id": "missing" }).to_string())
            .await;
        client
            .send_text(&json!({ "t": "respawn" }).to_string())
            .await;
        marker(&mut client, "after").await;

        // Nothing was armed: the known agent is untouched and still live.
        assert_eq!(registry.snapshot().len(), 1);
        assert_eq!(registry.snapshot()[0].id, agent.id);
    });
}

// VERIFY: wave9-tags_c-4
/// `chat.mjs` without a credential sends one `chat:error` with `needsAuth`
/// before any fetch (`chat.mjs:99-102`); `pty-ws.mjs:166-167` forwards it
/// unchanged. `chat:stop` with nothing in flight (`:170`) is a no-op.
#[test]
fn chat_without_credentials_reports_needs_auth_and_stop_is_a_noop() {
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

        client
            .send_text(&json!({ "t": "chat:stop" }).to_string())
            .await;
        client
            .send_text(&json!({ "t": "chat", "chatId": "c1", "question": "hello" }).to_string())
            .await;
        assert_eq!(
            client.json().await,
            json!({ "t": "chat:error", "chatId": "c1", "needsAuth": true, "msg": NO_TOKEN })
        );
        // VERIFY: wave10-chat_id-1 — an absent `chatId` is omitted, as
        // JSON.stringify drops `chatId: undefined`.
        client
            .send_text(&json!({ "t": "chat", "question": "hello" }).to_string())
            .await;
        assert_eq!(
            client.json().await,
            json!({ "t": "chat:error", "needsAuth": true, "msg": NO_TOKEN })
        );
        marker(&mut client, "after").await;
    });
}

// VERIFY: wave12-chat_raw_id-5 — `chatId` reaches the frame exactly as the
// client sent it (`chatId: m.chatId`): `""` stays an empty string, numbers and
// `null` keep their JSON type, and an absent field is dropped by
// JSON.stringify. Non-string request fields never block the verdict, because
// the credential check runs before the payload is destructured (`chat.mjs:99`).
#[test]
fn needs_auth_frames_echo_the_raw_chat_id_and_ignore_field_types() {
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

        for (payload, chat_id) in [
            (
                json!({ "t": "chat", "chatId": "", "question": "hello" }),
                Some(json!("")),
            ),
            (
                json!({ "t": "chat", "chatId": 42, "question": "hello" }),
                Some(json!(42)),
            ),
            (
                json!({ "t": "chat", "chatId": null, "question": "hello" }),
                Some(json!(null)),
            ),
            (json!({ "t": "chat", "question": "hello" }), None),
        ] {
            client.send_text(&payload.to_string()).await;
            let mut expected = json!({ "t": "chat:error", "needsAuth": true, "msg": NO_TOKEN });
            if let Some(chat_id) = chat_id {
                expected["chatId"] = chat_id;
            }
            assert_eq!(client.json().await, expected, "{payload}");
        }

        // Every non-string field at once, including the ones the typed request
        // still requires: Node's verdict is the credential's, not the parser's.
        client
            .send_text(
                &json!({
                    "t": "chat",
                    "chatId": [1, 2],
                    "question": 7,
                    "scope": 5,
                    "project": {},
                    "id": 9,
                    "history": 3,
                    "root": true,
                })
                .to_string(),
            )
            .await;
        assert_eq!(
            client.json().await,
            json!({ "t": "chat:error", "chatId": [1, 2], "needsAuth": true, "msg": NO_TOKEN })
        );
        marker(&mut client, "after").await;
    });
}

// VERIFY: wave12-chat_malformed_auth-6 — signed in, a payload with non-string
// `chatId`/`question`/`scope` still reaches the local stub through the real
// chat path, and the frames echo the raw `chatId`. `question` is forwarded as
// the JSON value it was (`{ role: 'user', content: question }`, `chat.mjs:105`)
// — no coercion.
#[test]
fn chat_with_nonstring_fields_routes_and_echoes_the_raw_chat_id() {
    run(async {
        let fixture = Fixture::new();
        signed_in(&fixture);
        let port = FakePort::new();
        let registry = fixture.registry(port);
        let (url, mut accepted) = chat_endpoint().await;
        let mut ws = deps(&fixture, registry, Arc::new(AtomicUsize::new(0)), None);
        ws.chat.messages_url = url;
        let server = serve(ws).await;
        let mut client = RawClient::connect(server.address, "/ws").await;
        let _ = snapshot(&mut client).await;

        client
            .send_text(&json!({ "t": "chat", "chatId": 42, "question": 7, "scope": 5 }).to_string())
            .await;
        let mut upstream = next_upstream(&mut accepted).await;
        let (_head, body) = read_request(&mut upstream).await;
        let body: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["messages"][0], json!({ "role": "user", "content": 7 }));

        respond_sse(&mut upstream, &(sse_delta("hi") + SSE_STOP)).await;
        assert_eq!(
            client.json().await,
            json!({ "t": "chat:delta", "chatId": 42, "text": "hi" })
        );
        assert_eq!(
            client.json().await,
            json!({ "t": "chat:done", "chatId": 42 })
        );
        marker(&mut client, "after").await;
    });
}

// VERIFY: wave9-tags_c-5
/// `case 'chat:stop': ws.chatAbort?.abort(); break;` (`pty-ws.mjs:170`): the
/// in-flight stream stops silently — `chat.mjs` sends nothing once
/// `signal.aborted` — so a response that lands afterwards never reaches the
/// socket.
#[test]
fn chat_stop_cancels_the_in_flight_stream_without_a_frame() {
    run(async {
        let fixture = Fixture::new();
        signed_in(&fixture);
        let port = FakePort::new();
        let registry = fixture.registry(port);
        let (url, mut accepted) = chat_endpoint().await;
        let mut ws = deps(&fixture, registry, Arc::new(AtomicUsize::new(0)), None);
        ws.chat.messages_url = url;
        let server = serve(ws).await;
        let mut client = RawClient::connect(server.address, "/ws").await;
        let _ = snapshot(&mut client).await;

        client
            .send_text(&json!({ "t": "chat", "chatId": "c1", "question": "hello" }).to_string())
            .await;
        let mut upstream = next_upstream(&mut accepted).await;
        read_request_head(&mut upstream).await;

        client
            .send_text(&json!({ "t": "chat:stop" }).to_string())
            .await;
        marker(&mut client, "stopped").await;

        // Answer the aborted request: the task already returned, so nothing is sent.
        respond_sse_if_open(&mut upstream, &(sse_delta("late") + SSE_STOP)).await;
        wait_for_close(&mut upstream).await;
        marker(&mut client, "after").await;
    });
}

// VERIFY: wave9-tags_c-6
/// A new `chat` aborts the previous one (`pty-ws.mjs:164-165`) and the
/// surviving stream is forwarded verbatim: `chat:delta` per text delta
/// (`chat.mjs:85`), then `chat:done` on `message_stop` (`:90-91`).
#[test]
fn a_new_chat_supersedes_the_previous_one_and_frames_match_node() {
    run(async {
        let fixture = Fixture::new();
        signed_in(&fixture);
        let port = FakePort::new();
        let registry = fixture.registry(port);
        let (url, mut accepted) = chat_endpoint().await;
        let mut ws = deps(&fixture, registry, Arc::new(AtomicUsize::new(0)), None);
        ws.chat.messages_url = url;
        let server = serve(ws).await;
        let mut client = RawClient::connect(server.address, "/ws").await;
        let _ = snapshot(&mut client).await;

        client
            .send_text(&json!({ "t": "chat", "chatId": "c1", "question": "first" }).to_string())
            .await;
        let mut first = next_upstream(&mut accepted).await;
        read_request_head(&mut first).await;

        client
            .send_text(&json!({ "t": "chat", "chatId": "c2", "question": "second" }).to_string())
            .await;
        let mut second = next_upstream(&mut accepted).await;
        read_request_head(&mut second).await;

        // The superseded stream answers first and is dropped silently.
        respond_sse_if_open(&mut first, &(sse_delta("stale") + SSE_STOP)).await;
        wait_for_close(&mut first).await;
        respond_sse(&mut second, &(sse_delta("hi") + SSE_STOP)).await;

        assert_eq!(
            client.json().await,
            json!({ "t": "chat:delta", "chatId": "c2", "text": "hi" })
        );
        assert_eq!(
            client.json().await,
            json!({ "t": "chat:done", "chatId": "c2" })
        );
        // The marker stays in order, so the superseded chat emitted no frame of
        // its own before it: its upstream answer was the stale one consumed above.
        marker(&mut client, "after").await;
    });
}

// VERIFY: wave15-chat-6 — a present `chatId: null` / `question: null` survives
// the signed-in path: Node forwards `chatId` verbatim to every frame
// (`chat.mjs:86,91,101`) and sends `content: null` in the user turn (`:105`).
#[test]
fn signed_in_null_chat_id_and_question_survive_verbatim() {
    run(async {
        let fixture = Fixture::new();
        signed_in(&fixture);
        let port = FakePort::new();
        let registry = fixture.registry(port);
        let (url, mut accepted) = chat_endpoint().await;
        let mut ws = deps(&fixture, registry, Arc::new(AtomicUsize::new(0)), None);
        ws.chat.messages_url = url;
        let server = serve(ws).await;
        let mut client = RawClient::connect(server.address, "/ws").await;
        let _ = snapshot(&mut client).await;

        let payload = json!({ "t": "chat", "chatId": null, "question": null });
        let body = expect_chat_proceeds(&mut client, &mut accepted, payload.clone()).await;
        assert_eq!(
            body["messages"],
            json!([{ "role": "user", "content": null }]),
            "a present null question is `content: null`, not an omitted key"
        );

        // The error frame carries the same raw `null`, not a dropped `chatId`.
        client.send_text(&payload.to_string()).await;
        let mut upstream = next_upstream(&mut accepted).await;
        read_request_head(&mut upstream).await;
        respond_sse(&mut upstream, &sse_error("boom")).await;
        assert_eq!(
            client.json().await,
            json!({ "t": "chat:error", "chatId": null, "msg": "boom" })
        );
        marker(&mut client, "after").await;
    });
}

// VERIFY: wave15-chat-7 — signed in, the wrong-typed context fields produce
// Node's outcomes: a truthy non-string `project`/`root` and a codex `file`
// throw (one `chat:error`, raw `chatId`), a non-array `history` throws, and
// `source`/`id`/falsy `root`/falsy `project` proceed because Node coerces or
// ignores them (`sessions.mjs:590-600,628-635`, `chat.mjs:105`).
#[test]
fn signed_in_wrong_typed_context_fields_match_the_node_outcomes() {
    run(async {
        let fixture = Fixture::new();
        signed_in(&fixture);
        let port = FakePort::new();
        let registry = fixture.registry(port);
        let (url, mut accepted) = chat_endpoint().await;
        let mut ws = deps(&fixture, registry, Arc::new(AtomicUsize::new(0)), None);
        ws.chat.messages_url = url;
        let server = serve(ws).await;
        let mut client = RawClient::connect(server.address, "/ws").await;
        let _ = snapshot(&mut client).await;

        // Throwing cases: one terminal frame, and no upstream request at all.
        // VERIFY: wave17-chat-6 — `pty-ws.mjs:167` forwards `String(e)`, so each
        // text is V8's full `Error.prototype.toString`: name, Node's error code
        // where the message carries one, then the message.
        for (payload, msg) in [
            (
                json!({ "t": "chat", "chatId": "p1", "scope": "one", "project": 5, "id": "s" }),
                "TypeError [ERR_INVALID_ARG_TYPE]: The \"path\" argument must be of type string. Received type number (5)",
            ),
            (
                json!({ "t": "chat", "chatId": "r1", "scope": "all", "root": true }),
                "TypeError: p.startsWith is not a function",
            ),
            (
                json!({
                    "t": "chat", "chatId": "f1", "scope": "one", "project": "p",
                    "id": "s", "source": "codex", "file": 5,
                }),
                "TypeError [ERR_INVALID_ARG_TYPE]: The \"paths[1]\" argument must be of type string. Received type number (5)",
            ),
            (
                json!({ "t": "chat", "chatId": "h1", "history": 3 }),
                "TypeError: history is not iterable",
            ),
            (
                json!({ "t": "chat", "chatId": "h2", "history": null }),
                "TypeError: history is not iterable",
            ),
        ] {
            let chat_id = payload["chatId"].clone();
            client.send_text(&payload.to_string()).await;
            assert_eq!(
                client.json().await,
                json!({ "t": "chat:error", "chatId": chat_id, "msg": msg }),
                "{payload}"
            );
            assert!(
                accepted.try_recv().is_err(),
                "a throwing case must not open an upstream request: {payload}"
            );
        }

        // Proceed cases. `source` is compared strictly, so a non-string takes
        // the Claude branch and only the (absent) transcript is empty.
        for payload in [
            json!({ "t": "chat", "chatId": "s1", "scope": "one", "project": "demo", "id": "nope", "source": 5 }),
            // `id` is coerced by `${id}.jsonl` / `RegExp.test`.
            json!({ "t": "chat", "chatId": "i1", "scope": "one", "project": "demo", "id": 9 }),
            // `file` is ignored unless `source === 'codex'`.
            json!({ "t": "chat", "chatId": "l1", "scope": "one", "project": "demo", "id": "nope", "source": "claude", "file": 5 }),
        ] {
            let body = expect_chat_proceeds(&mut client, &mut accepted, payload.clone()).await;
            assert!(
                body["system"]
                    .as_str()
                    .unwrap()
                    .contains("The selected session transcript is empty."),
                "{payload}"
            );
        }

        // A falsy non-string `project` falls through to scope `all`.
        let body = expect_chat_proceeds(
            &mut client,
            &mut accepted,
            json!({ "t": "chat", "chatId": "z1", "scope": "one", "project": 0, "id": "s" }),
        )
        .await;
        assert!(
            body["system"]
                .as_str()
                .unwrap()
                .ends_with("No sessions found."),
            "{body}"
        );

        // A falsy `root` takes the default root rather than throwing.
        let body = expect_chat_proceeds(
            &mut client,
            &mut accepted,
            json!({ "t": "chat", "chatId": "z2", "scope": "all", "root": false }),
        )
        .await;
        assert!(
            body["system"]
                .as_str()
                .unwrap()
                .ends_with("No sessions found."),
            "{body}"
        );

        // A string `history` spreads to its characters (`[...'ab']`).
        let body = expect_chat_proceeds(
            &mut client,
            &mut accepted,
            json!({ "t": "chat", "chatId": "h3", "history": "ab", "question": "q" }),
        )
        .await;
        assert_eq!(
            body["messages"],
            json!(["a", "b", { "role": "user", "content": "q" }])
        );

        marker(&mut client, "after").await;
    });
}

// VERIFY: wave17-chat-7 — M2: `/[\\/]/.test(project)` (`sessions.mjs:591`)
// coerces the value before `path.join` validates it, so a non-string project
// whose `String()` holds a separator makes `pathFor` return null and
// `readSession` falls through to `findById` (a miss for this id) instead of
// throwing. VERIFY: wave17-chat-9 — the same fallback resolves the root, so a
// truthy non-string `root` still throws even with a separator project.
// VERIFY: wave17-chat-8 — the codex branch reads neither `project` nor `root`
// (`sessions.mjs:628-631`), so a truthy non-string root proceeds there.
#[test]
fn signed_in_separator_project_and_codex_root_match_node() {
    run(async {
        let fixture = Fixture::new();
        signed_in(&fixture);
        let port = FakePort::new();
        let registry = fixture.registry(port);
        let (url, mut accepted) = chat_endpoint().await;
        let mut ws = deps(&fixture, registry, Arc::new(AtomicUsize::new(0)), None);
        ws.chat.messages_url = url;
        let server = serve(ws).await;
        let mut client = RawClient::connect(server.address, "/ws").await;
        let _ = snapshot(&mut client).await;

        for (chat_id, project) in [
            // `["a/b"]` coerces to "a/b" — separator, so `pathFor` bails.
            ("m1", json!(["a/b"])),
            // Nested: `[["x\\y"]]` coerces to "x\\y".
            ("m2", json!([["x\\y"]])),
        ] {
            let body = expect_chat_proceeds(
                &mut client,
                &mut accepted,
                json!({ "t": "chat", "chatId": chat_id, "scope": "one", "project": project, "id": "nope" }),
            )
            .await;
            assert!(
                body["system"]
                    .as_str()
                    .unwrap()
                    .contains("The selected session transcript is empty."),
                "{body}"
            );
        }

        // Separator project with a truthy non-string root: `pathFor` returns
        // early, but `findById` resolves the root, so the root error wins.
        client
            .send_text(
                &json!({
                    "t": "chat", "chatId": "m3", "scope": "one",
                    "project": ["a/b"], "id": "nope", "root": 5,
                })
                .to_string(),
            )
            .await;
        assert_eq!(
            client.json().await,
            json!({
                "t": "chat:error", "chatId": "m3",
                "msg": "TypeError: p.startsWith is not a function",
            })
        );
        assert!(
            accepted.try_recv().is_err(),
            "the separator/root case must not open an upstream request"
        );

        // Codex ignores `root` entirely, so a truthy non-string still proceeds.
        let body = expect_chat_proceeds(
            &mut client,
            &mut accepted,
            json!({
                "t": "chat", "chatId": "m4", "scope": "one", "project": "demo",
                "id": "nope", "source": "codex", "root": 5,
            }),
        )
        .await;
        assert!(
            body["system"]
                .as_str()
                .unwrap()
                .contains("The selected session transcript is empty."),
            "{body}"
        );

        marker(&mut client, "after").await;
    });
}

// VERIFY: wave17-chat-10 — an absent `chatId` is `undefined` in Node, so
// `JSON.stringify` drops the key from every frame (`chat.mjs:86,91,101`).
#[test]
fn signed_in_absent_chat_id_is_dropped_from_every_frame() {
    run(async {
        let fixture = Fixture::new();
        signed_in(&fixture);
        let port = FakePort::new();
        let registry = fixture.registry(port);
        let (url, mut accepted) = chat_endpoint().await;
        let mut ws = deps(&fixture, registry, Arc::new(AtomicUsize::new(0)), None);
        ws.chat.messages_url = url;
        let server = serve(ws).await;
        let mut client = RawClient::connect(server.address, "/ws").await;
        let _ = snapshot(&mut client).await;

        client
            .send_text(&json!({ "t": "chat", "question": "q" }).to_string())
            .await;
        let mut upstream = next_upstream(&mut accepted).await;
        read_request_head(&mut upstream).await;
        respond_sse(&mut upstream, &(sse_delta("hi") + SSE_STOP)).await;
        let delta = client.json().await;
        assert_eq!(delta, json!({ "t": "chat:delta", "text": "hi" }));
        assert!(
            delta.get("chatId").is_none(),
            "an absent chatId must not be serialised: {delta}"
        );
        let done = client.json().await;
        assert_eq!(done, json!({ "t": "chat:done" }));
        assert!(
            done.get("chatId").is_none(),
            "an absent chatId must not be serialised: {done}"
        );
        marker(&mut client, "after").await;
    });
}
