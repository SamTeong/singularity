//! Session-history chat: stream an answer from the Claude Messages API,
//! grounded in one session's transcript (scope `one`) or a directory of recent
//! sessions (scope `all`). Ported from `server/chat.mjs`.
//!
//! The OAuth Messages endpoint requires `system` to begin with the exact Claude
//! Code identity string for non-Haiku models (GH #35724/#40515). Node prepends
//! it always and runs Haiku 4.5 (exempt); the prefix is kept for parity so a
//! future model swap cannot silently 400.
//!
//! The host wires [`stream_chat`] into the WS layer: frames go through the
//! `send` callback, a new request cancels the prior one through [`Cancel`], and
//! an `Err` is the Node `streamChat(...).catch(...)` path — the caller emits
//! `chat:error` with that message (`server/pty-ws.mjs:166-167`).
use crate::claude_credentials::{self, ClaudeCredentialsRead};
use crate::fetch_retry::{FetchError, RetryPolicy, fetch_external};
use crate::transcript_service::{ListOptions, ReadOptions, SessionRow, TranscriptService};
use crate::usage_auth;
use reqwest::Response;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json, value::RawValue};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tokio::sync::Notify;

/// `chat.mjs:16`.
pub const MESSAGES_URL: &str = "https://api.anthropic.com/v1/messages";
/// `chat.mjs:17`.
const IDENTITY: &str = "You are Claude Code, Anthropic's official CLI for Claude.";
/// `chat.mjs:18`.
const MODEL: &str = "claude-haiku-4-5-20251001";
/// `chat.mjs:19`.
const MAX_TOKENS: u32 = 2048;
/// `chat.mjs:20` — scope `all` context cap (chars).
const ALL_CAP: usize = 60_000;
/// `chat.mjs:25` — ceiling on the outbound call, headers and streamed body.
const FETCH_TIMEOUT: Duration = Duration::from_secs(120);
/// `sessions.mjs:38` — `sessionText` head+tail cap.
const TEXT_CAP: usize = 80_000;
/// `AbortSignal.timeout()` rejection message, so the frame reads as Node's does.
const ABORT_TIMEOUT_MESSAGE: &str = "The operation was aborted due to timeout";
const NO_TOKEN_MESSAGE: &str = "Claude not signed in — run `claude` to log in";
const AUTH_EXPIRED_MESSAGE: &str = "auth expired — re-run `claude` to log in";
const RATE_LIMITED_MESSAGE: &str = "rate-limited — try again shortly";

/// One outbound WS frame. Serialises to the exact Node objects: the tag is `t`
/// (`chat.mjs:86-93`, `:101`, `:119-127`), and `needsAuth` is only present on
/// the auth frames, where Node inserts it before `msg`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "t")]
pub enum ChatFrame {
    #[serde(rename = "chat:delta")]
    Delta {
        // VERIFY: wave12-chat_raw_id-4 — `chatId: m.chatId` is forwarded as the
        // caller sent it: JSON.stringify drops `undefined` (absent) and keeps
        // `""`, `null` and numbers verbatim.
        #[serde(rename = "chatId", skip_serializing_if = "Option::is_none")]
        chat_id: Option<Value>,
        text: String,
    },
    #[serde(rename = "chat:done")]
    Done {
        #[serde(rename = "chatId", skip_serializing_if = "Option::is_none")]
        chat_id: Option<Value>,
    },
    #[serde(rename = "chat:error")]
    Error {
        #[serde(rename = "chatId", skip_serializing_if = "Option::is_none")]
        chat_id: Option<Value>,
        #[serde(rename = "needsAuth", skip_serializing_if = "Option::is_none")]
        needs_auth: Option<bool>,
        msg: String,
    },
}

/// The `/ws` `chat` message (`pty-ws.mjs:162-168`, destructured at
/// `chat.mjs:98`). `scope` defaults to `one`, `history` to `[]`; every other
/// field is optional. Nothing here is typed further than `Value`, because Node
/// destructures without validating: a field's type only matters at its use
/// site, where it either coerces, passes through, or throws a `TypeError`.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ChatRequest {
    /// VERIFY: wave15-chat-1 — raw `chatId` (`m.chatId`): Node never validates
    /// it and forwards it unchanged to every frame. `present_raw` keeps a
    /// present `null`, which serde's `Option` would otherwise read as absent.
    #[serde(default, deserialize_with = "present_raw")]
    pub chat_id: Option<Value>,
    /// Raw `content` for the user turn — `{ role: 'user', content: question }`
    /// (`chat.mjs:105`) with `content` omitted only when `question` is
    /// `undefined`; a present `null` is forwarded.
    #[serde(default, deserialize_with = "present_raw")]
    pub question: Option<Value>,
    /// `scope = 'one'` is a default, not a type: Node compares `=== 'one'`, so
    /// any other JSON value takes the `all` branch.
    pub scope: Value,
    /// `project`/`id`/`source`/`file`/`root` are raw: each is coerced or
    /// rejected only where `chat.mjs`/`sessions.mjs` use it.
    pub project: Option<Value>,
    pub id: Option<Value>,
    pub source: Option<Value>,
    pub file: Option<Value>,
    /// Turn objects (`{role, content}`) passed straight through to the API.
    /// Absent means `[]`; any other non-array (including `null`) throws.
    #[serde(default, deserialize_with = "present_raw")]
    pub history: Option<Value>,
    pub root: Option<Value>,
}

impl Default for ChatRequest {
    fn default() -> Self {
        Self {
            chat_id: None,
            question: None,
            scope: json!("one"),
            project: None,
            id: None,
            source: None,
            file: None,
            history: None,
            root: None,
        }
    }
}

/// Keep a present JSON `null` as `Some(Value::Null)`, so it stays
/// distinguishable from an absent field (Node's `undefined`).
fn present_raw<'de, D>(deserializer: D) -> Result<Option<Value>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Value::deserialize(deserializer).map(Some)
}

/// Everything `chat.mjs` reaches outside itself: the endpoint (so tests can
/// point at a local server), the transcript service backing `contextFor`, the
/// Claude credential location, and the injected clock.
pub struct ChatDeps {
    pub messages_url: String,
    pub transcripts: Arc<TranscriptService>,
    /// `<claude_home>/.credentials.json` (`usage.mjs:554-558`).
    pub credentials_path: PathBuf,
    /// `Some("darwin")` enables the Keychain fallback (`usage.mjs:562-571`),
    /// delegated to `usage_auth::keychain`; `keychain_bin` is the absolute
    /// `security` path. Never resolved through `PATH`.
    pub keychain_platform: Option<String>,
    pub keychain_bin: Option<String>,
    /// Fixed clock for tests; `None` reads `Date.now()` at call time.
    pub now_ms: Option<i64>,
    pub client: reqwest::Client,
}

impl ChatDeps {
    pub fn new(transcripts: Arc<TranscriptService>, credentials_path: PathBuf) -> Self {
        Self {
            messages_url: MESSAGES_URL.to_owned(),
            transcripts,
            credentials_path,
            keychain_platform: Some(std::env::consts::OS.to_owned()),
            keychain_bin: None,
            now_ms: None,
            client: reqwest::Client::new(),
        }
    }

    fn now_ms(&self) -> i64 {
        self.now_ms.unwrap_or_else(epoch_ms)
    }
}

/// Replacement for the caller's `AbortSignal`: a new chat aborts the prior one
/// (`pty-ws.mjs:164-165`, `chat:stop` at `:170`, socket close at `:174`). The
/// flag makes the state readable at any point; the notify wakes the in-flight
/// fetch or chunk read so cancellation is immediate rather than next-chunk.
#[derive(Clone)]
pub struct Cancel {
    inner: Arc<CancelInner>,
}

struct CancelInner {
    flag: AtomicBool,
    notify: Notify,
}

impl Default for Cancel {
    fn default() -> Self {
        Self::new()
    }
}

impl Cancel {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(CancelInner {
                flag: AtomicBool::new(false),
                notify: Notify::new(),
            }),
        }
    }

    pub fn cancel(&self) {
        self.inner.flag.store(true, Ordering::SeqCst);
        self.inner.notify.notify_waiters();
    }

    pub fn is_cancelled(&self) -> bool {
        self.inner.flag.load(Ordering::SeqCst)
    }

    async fn cancelled(&self) {
        loop {
            if self.is_cancelled() {
                return;
            }
            let notified = self.inner.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.is_cancelled() {
                return;
            }
            notified.await;
            return;
        }
    }
}

/// `streamChat`: stream `chat:delta` frames, then `chat:done` or `chat:error`.
/// An `Err` is the Node rejection that `pty-ws.mjs:166-167` turns into a
/// `chat:error` frame.
pub async fn stream_chat(
    req: ChatRequest,
    deps: &ChatDeps,
    send: impl Fn(ChatFrame),
    cancel: &Cancel,
) -> Result<(), String> {
    stream_chat_with_timeout(req, deps, send, cancel, FETCH_TIMEOUT).await
}

async fn stream_chat_with_timeout(
    req: ChatRequest,
    deps: &ChatDeps,
    send: impl Fn(ChatFrame),
    cancel: &Cancel,
    timeout: Duration,
) -> Result<(), String> {
    let Some(token) = oauth_access_token(deps) else {
        send(ChatFrame::Error {
            chat_id: req.chat_id.clone(),
            needs_auth: Some(true),
            msg: NO_TOKEN_MESSAGE.to_owned(),
        });
        return Ok(());
    };
    let system = format!("{IDENTITY}{}", context_for(&req, deps).await?);
    // VERIFY: wave15-chat-2 — `const messages = [...history, {...}]`
    // (`chat.mjs:105`): a string spreads to characters, any other non-array is
    // a `TypeError` that `pty-ws.mjs:166-167` turns into `chat:error`.
    let mut messages = history_messages(req.history.as_ref())?;
    // `{ role: 'user', content: question }` (`chat.mjs:105`): a missing
    // `question` is `undefined`, which JSON.stringify drops from the body.
    let mut user_turn = Map::new();
    user_turn.insert("role".into(), json!("user"));
    if let Some(content) = req.question.clone() {
        user_turn.insert("content".into(), content);
    }
    messages.push(Value::Object(user_turn));

    let body = json!({
        "model": MODEL,
        "max_tokens": MAX_TOKENS,
        "system": system,
        "messages": messages,
        "stream": true,
    })
    .to_string();
    let request = match deps
        .client
        .post(&deps.messages_url)
        .header("authorization", format!("Bearer {token}"))
        .header("content-type", "application/json")
        .header("anthropic-version", "2023-06-01")
        .header("anthropic-beta", "oauth-2025-04-20,claude-code-20250219")
        .header("user-agent", "claude-cli/1.0")
        .header("x-app", "cli")
        .body(body)
        .build()
    {
        Ok(request) => request,
        Err(error) => {
            send(ChatFrame::Error {
                chat_id: req.chat_id.clone(),
                needs_auth: None,
                msg: format!("request failed: {error}"),
            });
            return Ok(());
        }
    };

    // `chat.mjs:109-116`: retries off, no per-attempt timeout, one 120 s
    // ceiling shared by the response headers and the streamed body. An already
    // aborted signal rejects before a socket is opened.
    if cancel.is_cancelled() {
        return Ok(());
    }
    let deadline = tokio::time::Instant::now() + timeout;
    let policy = RetryPolicy {
        retry: false,
        max_attempts: 1,
        timeout: None,
    };
    let response = tokio::select! {
        _ = cancel.cancelled() => return Ok(()),
        _ = tokio::time::sleep_until(deadline) => {
            send(ChatFrame::Error {
                chat_id: req.chat_id.clone(),
                needs_auth: None,
                msg: format!("request failed: {ABORT_TIMEOUT_MESSAGE}"),
            });
            return Ok(());
        }
        result = fetch_external(&deps.client, request, &policy) => result,
    };
    let mut response = match response {
        Ok(response) => response,
        Err(error) => {
            if cancel.is_cancelled() {
                return Ok(());
            }
            send(ChatFrame::Error {
                chat_id: req.chat_id.clone(),
                needs_auth: None,
                msg: format!("request failed: {}", transport_message(&error)),
            });
            return Ok(());
        }
    };

    if cancel.is_cancelled() {
        return Ok(());
    }
    let status = response.status();
    if status.as_u16() == 401 {
        send(ChatFrame::Error {
            chat_id: req.chat_id.clone(),
            needs_auth: Some(true),
            msg: AUTH_EXPIRED_MESSAGE.to_owned(),
        });
        return Ok(());
    }
    if status.as_u16() == 429 {
        send(ChatFrame::Error {
            chat_id: req.chat_id.clone(),
            needs_auth: None,
            msg: RATE_LIMITED_MESSAGE.to_owned(),
        });
        return Ok(());
    }
    if !status.is_success() {
        let mut msg = format!("HTTP {}", status.as_u16());
        let payload = tokio::select! {
            _ = cancel.cancelled() => return Ok(()),
            _ = tokio::time::sleep_until(deadline) => None,
            result = response.json::<Value>() => result.ok(),
        };
        if let Some(payload) = payload {
            if let Some(message) = payload
                .get("error")
                .and_then(|error| error.get("message"))
                .and_then(Value::as_str)
                .filter(|message| !message.is_empty())
            {
                msg = message.to_owned();
            }
        }
        send(ChatFrame::Error {
            chat_id: req.chat_id.clone(),
            needs_auth: None,
            msg,
        });
        return Ok(());
    }

    let outcome = consume_stream(&mut response, &send, &req.chat_id, cancel, deadline).await;
    match outcome {
        // `chat.mjs:139`: a quiet end without a terminal event still finishes.
        Ok(false) if !cancel.is_cancelled() => send(ChatFrame::Done {
            chat_id: req.chat_id.clone(),
        }),
        Ok(_) => {}
        Err(error) => {
            if !cancel.is_cancelled() {
                send(ChatFrame::Error {
                    chat_id: req.chat_id.clone(),
                    needs_auth: None,
                    msg: format!("stream failed: {error}"),
                });
            }
        }
    }
    Ok(())
}

/// `chat.mjs:41-56` — the block prepended to the identity string.
async fn context_for(req: &ChatRequest, deps: &ChatDeps) -> Result<String, String> {
    // VERIFY: wave15-chat-3 — `scope === 'one' && project && id`: JS truthiness
    // on the raw values, so `0`, `false`, `null` and `""` take the `all` branch.
    if req.scope.as_str() == Some("one")
        && js_truthy_opt(req.project.as_ref())
        && js_truthy_opt(req.id.as_ref())
    {
        let project = req.project.clone().unwrap_or(Value::Null);
        let id = req.id.clone().unwrap_or(Value::Null);
        let text = session_text(deps, &project, &id, req).await?;
        if text.is_empty() {
            return Ok("\n\nThe selected session transcript is empty.".to_owned());
        }
        return Ok(format!(
            "\n\nYou are answering questions about ONE Claude Code session. Below is its transcript. Cite turns by role when useful.\n\n<session>\n{text}\n</session>"
        ));
    }
    // Scope `all`: a directory of the most recent sessions (metadata only — the
    // full text of every session will not fit). `listSessions` resolves the
    // root first, so a truthy non-string `root` throws before any read.
    let root = root_arg(req.root.as_ref())?;
    let rows = list_sessions(deps, root).await?;
    if rows.is_empty() {
        return Ok("\n\nNo sessions found.".to_owned());
    }
    let lines: Vec<String> = rows.iter().map(session_line).collect();
    let mut text = lines.join("\n");
    if utf16_len(&text) > ALL_CAP {
        text = format!(
            "{}\n…(+{} sessions, truncated)",
            utf16_prefix(&text, ALL_CAP),
            rows.len()
        );
    }
    Ok(format!(
        "\n\nYou are answering questions about the user's Claude Code sessions. Below is a directory of recent sessions (title, cwd, date). Answer about what was worked on; suggest specific sessions to open for detail.\n\n<sessions>\n{text}\n</sessions>"
    ))
}

/// `sessions.mjs:691-704`: flatten a session into a compact transcript.
async fn session_text(
    deps: &ChatDeps,
    project: &Value,
    id: &Value,
    req: &ChatRequest,
) -> Result<String, String> {
    // VERIFY: wave15-chat-4 — reproduce `readSession` (`sessions.mjs:627-635`)
    // field by field: `source === 'codex'` is strict, the codex branch reads
    // neither `project` nor `root`, and only the claude branch coerces `id` and
    // validates `project` (through `path.join`) and `root`.
    let (project, id, options) = if is_codex_source(req) {
        let file = codex_file(req)?;
        if file.is_none() && !id.is_string() {
            // `findCodexById` compares the raw value strictly against a string
            // id, so a non-string can never match: not found, empty transcript.
            return Ok(String::new());
        }
        (
            js_to_string(project),
            js_to_string(id),
            ReadOptions {
                root: None,
                source: Some("codex".to_owned()),
                file,
            },
        )
    } else {
        // `pathFor` resolves the root before `path.join` rejects a non-string
        // project (`sessions.mjs:590-600`), so the root error wins; a
        // separator project reaches the same `resolveRoot` through the
        // `findById` fallback (`:633-634`), so the root still wins there.
        let root = root_arg(req.root.as_ref())?;
        (
            claude_project(project)?,
            js_to_string(id),
            ReadOptions {
                root,
                source: None,
                file: None,
            },
        )
    };
    let service = Arc::clone(&deps.transcripts);
    let raw = tokio::task::spawn_blocking(move || service.read(&project, &id, &options))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())?;
    // `readSession` reports `{ok:false}` for a missing file; `sessionText`
    // then yields '' and `contextFor` reports an empty transcript.
    let Some(raw) = raw else {
        return Ok(String::new());
    };
    let parsed: Value = serde_json::from_str(&raw).map_err(|error| error.to_string())?;
    let mut lines = Vec::new();
    if let Some(messages) = parsed.get("messages").and_then(Value::as_array) {
        for message in messages {
            let text = message_text(message.get("text"));
            match message.get("kind").and_then(Value::as_str) {
                Some("toolResult") => lines.push(format!("[tool_result] {text}")),
                Some("toolUse") => lines.push(format!(
                    "[tool: {}] {text}",
                    message.get("name").and_then(Value::as_str).unwrap_or("?")
                )),
                _ => lines.push(format!(
                    "[{}] {text}",
                    message.get("role").and_then(Value::as_str).unwrap_or("")
                )),
            }
        }
    }
    let text = lines.join("\n");
    if utf16_len(&text) <= TEXT_CAP {
        return Ok(text);
    }
    let half = TEXT_CAP / 2;
    Ok(format!(
        "{}\n\n[…truncated…]\n\n{}",
        utf16_prefix(&text, half),
        utf16_suffix(&text, half)
    ))
}

/// `sessions.mjs:50,473-522` with Node's defaults: `cap: 100`, no live ids.
async fn list_sessions(deps: &ChatDeps, root: Option<String>) -> Result<Vec<SessionRow>, String> {
    let service = Arc::clone(&deps.transcripts);
    let options = ListOptions {
        root,
        cap: 100,
        now_ms: u64::try_from(deps.now_ms()).unwrap_or(0),
        hide_reviews: false,
        live_ids: Vec::new(),
    };
    tokio::task::spawn_blocking(move || service.list(&options))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())
}

/// `sessions.mjs:52`: `- ${title || id}  (${cwd || project}, YYYY-MM-DD)`.
fn session_line(row: &SessionRow) -> String {
    format!(
        "- {}  ({}, {})",
        raw_string(row.title.as_deref()).unwrap_or_else(|| row.id.clone()),
        raw_string(row.cwd.as_deref()).unwrap_or_else(|| row.project.clone()),
        utc_date(row.mtime)
    )
}

/// `new Date(mtime).toISOString().slice(0, 10)`.
fn utc_date(mtime_ms: f64) -> String {
    let nanos = (mtime_ms * 1_000_000.0) as i128;
    time::OffsetDateTime::from_unix_timestamp_nanos(nanos)
        .ok()
        .and_then(|at| {
            at.format(&time::format_description::well_known::Rfc3339)
                .ok()
        })
        .map(|text| text.chars().take(10).collect())
        .unwrap_or_default()
}

/// `chat.mjs:62-96`: incremental SSE parse. Returns true when a terminal frame
/// was sent (or the stream was aborted), false when the body just ended.
async fn consume_stream(
    response: &mut Response,
    send: &impl Fn(ChatFrame),
    chat_id: &Option<Value>,
    cancel: &Cancel,
    deadline: tokio::time::Instant,
) -> Result<bool, String> {
    let mut decoder = StreamDecoder::default();
    let mut buffer = String::new();
    loop {
        if cancel.is_cancelled() {
            return Ok(true);
        }
        let chunk = tokio::select! {
            _ = cancel.cancelled() => return Ok(true),
            _ = tokio::time::sleep_until(deadline) => return Err(ABORT_TIMEOUT_MESSAGE.to_owned()),
            chunk = response.chunk() => chunk.map_err(|error| error.to_string())?,
        };
        let Some(chunk) = chunk else {
            return Ok(false);
        };
        buffer.push_str(&decoder.push(&chunk));
        while let Some(separator) = buffer.find("\n\n") {
            let block: String = buffer[..separator].to_owned();
            buffer.drain(..separator + 2);
            let Some(data) = block.lines().find(|line| line.starts_with("data:")) else {
                continue;
            };
            let Ok(payload) = serde_json::from_str::<Value>(data[5..].trim()) else {
                continue;
            };
            let kind = payload.get("type").and_then(Value::as_str).unwrap_or("");
            if kind == "content_block_delta"
                && payload
                    .get("delta")
                    .and_then(|delta| delta.get("type"))
                    .and_then(Value::as_str)
                    == Some("text_delta")
            {
                let text = payload
                    .get("delta")
                    .and_then(|delta| delta.get("text"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                send(ChatFrame::Delta {
                    chat_id: chat_id.to_owned(),
                    text: text.to_owned(),
                });
            } else if kind == "error" {
                let msg = payload
                    .get("error")
                    .and_then(|error| error.get("message"))
                    .and_then(Value::as_str)
                    .filter(|message| !message.is_empty())
                    .unwrap_or("upstream error");
                send(ChatFrame::Error {
                    chat_id: chat_id.to_owned(),
                    needs_auth: None,
                    msg: msg.to_owned(),
                });
                return Ok(true);
            } else if kind == "message_stop" {
                send(ChatFrame::Done {
                    chat_id: chat_id.to_owned(),
                });
                return Ok(true);
            }
        }
    }
}

/// Streaming UTF-8 decode with a carry across chunk boundaries — the
/// `TextDecoder({stream: true})` of `chat.mjs:64,76`.
#[derive(Default)]
struct StreamDecoder {
    carry: Vec<u8>,
}

impl StreamDecoder {
    fn push(&mut self, bytes: &[u8]) -> String {
        self.carry.extend_from_slice(bytes);
        let mut out = String::new();
        loop {
            match std::str::from_utf8(&self.carry) {
                Ok(text) => {
                    out.push_str(text);
                    self.carry.clear();
                    return out;
                }
                Err(error) => {
                    let valid = error.valid_up_to();
                    if valid > 0 {
                        out.push_str(std::str::from_utf8(&self.carry[..valid]).unwrap_or(""));
                    }
                    match error.error_len() {
                        Some(len) => {
                            out.push('\u{fffd}');
                            self.carry.drain(..valid + len);
                        }
                        None => {
                            self.carry.drain(..valid);
                            return out;
                        }
                    }
                }
            }
        }
    }
}

/// VERIFY: wave12-chat_auth_first-3 — `streamChat` awaits `claudeOauthToken()`
/// before destructuring the payload (`chat.mjs:98-103`), so a signed-out daemon
/// answers `needsAuth` for *any* payload shape, even one [`ChatRequest`] cannot
/// deserialize. The frame carries the raw `chatId`.
pub(crate) fn auth_preflight(deps: &ChatDeps, chat_id: Option<Value>) -> Option<ChatFrame> {
    oauth_access_token(deps)
        .is_none()
        .then(|| ChatFrame::Error {
            chat_id,
            needs_auth: Some(true),
            msg: NO_TOKEN_MESSAGE.to_owned(),
        })
}

/// `usage.mjs:536-542` `claudeOauthToken()`: the file wins, the darwin Keychain
/// is the fallback, and an expired token reads as signed out.
fn oauth_access_token(deps: &ChatDeps) -> Option<String> {
    if let Some(oauth) = credentials_file(deps) {
        return access_token(&oauth, deps.now_ms());
    }
    let response = usage_auth::keychain(
        deps.keychain_platform.as_deref(),
        deps.keychain_bin.as_deref(),
        &json!({}),
    );
    if response.get("ok").and_then(Value::as_bool) != Some(true) {
        return None;
    }
    access_token(response.get("oauth")?, deps.now_ms())
}

/// `usage.mjs:554-558`: `<credentials_path>` → its `claudeAiOauth` object.
/// `None` means absent, unreadable, unparseable, or `claudeAiOauth` null —
/// exactly the cases where Node's `??` falls through to the Keychain.
fn credentials_file(deps: &ChatDeps) -> Option<Value> {
    let ClaudeCredentialsRead::File(text) = claude_credentials::read(&deps.credentials_path) else {
        return None;
    };
    let envelope: Value = serde_json::from_str(&text).ok()?;
    envelope
        .get("claudeAiOauth")
        .filter(|v| !v.is_null())
        .cloned()
}

fn access_token(oauth: &Value, now_ms: i64) -> Option<String> {
    let token = match oauth.get("accessToken") {
        Some(Value::String(token)) if !token.is_empty() => token.clone(),
        _ => return None,
    };
    if let Some(expires) = oauth.get("expiresAt").filter(|value| js_truthy(value)) {
        // `Number(expiresAt) < Date.now()`; an unparseable value is NaN, which
        // compares false and therefore never expires.
        if js_number(expires).is_some_and(|at| at < now_ms as f64) {
            return None;
        }
    }
    Some(token)
}

/// `reqwest`'s transport error text in place of Node's `TypeError: fetch
/// failed`, with the same frame shape.
fn transport_message(error: &FetchError) -> String {
    error.to_string()
}

fn epoch_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0)
}

/// JS truthiness of an optional raw request field (absent = `undefined`).
fn js_truthy_opt(value: Option<&Value>) -> bool {
    value.is_some_and(js_truthy)
}

/// `String(value)` for the template-literal and `RegExp.test` coercions
/// (`${id}.jsonl`, `SUBAGENT_ID.test(id)` — `sessions.mjs:590-595`).
fn js_to_string(value: &Value) -> String {
    match value {
        Value::Null => "null".to_owned(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => number.to_string(),
        Value::String(text) => text.clone(),
        Value::Array(items) => items
            .iter()
            .map(|item| match item {
                Value::Null => String::new(),
                other => js_to_string(other),
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_owned(),
    }
}

/// V8's `Received ...` tail for a non-string `path` argument.
fn js_received(value: &Value) -> String {
    match value {
        Value::Null => "null".to_owned(),
        Value::Bool(flag) => format!("type boolean ({flag})"),
        Value::Number(number) => format!("type number ({number})"),
        Value::Array(_) => "an instance of Array".to_owned(),
        Value::Object(_) => "an instance of Object".to_owned(),
        Value::String(_) => "type string".to_owned(),
    }
}

/// `resolveRoot(raw)` (`sessions.mjs:381-385`): a truthy non-string throws
/// (`p.startsWith is not a function`); every falsy value uses the default root.
/// The text is `String(e)` as `pty-ws.mjs:167` forwards it.
fn root_arg(raw: Option<&Value>) -> Result<Option<String>, String> {
    match raw {
        Some(Value::String(text)) if !text.is_empty() => Ok(Some(text.clone())),
        // VERIFY: wave17-chat-2 — `msg: String(e)` (`pty-ws.mjs:167`): V8's
        // `Error.prototype.toString` prefixes the error name, not just `.message`.
        Some(value) if js_truthy(value) => {
            Err("TypeError: p.startsWith is not a function".to_owned())
        }
        _ => Ok(None),
    }
}

/// `source === 'codex'` (`sessions.mjs:628`): strict, no coercion.
fn is_codex_source(req: &ChatRequest) -> bool {
    req.source.as_ref().and_then(Value::as_str) == Some("codex")
}

/// `pathForCodex(file)` (`sessions.mjs:224-230`): a truthy non-string fails
/// `path.resolve`'s string validation, which surfaces as `chat:error` with
/// `String(e)` — Node's error name and `code` included.
fn codex_file(req: &ChatRequest) -> Result<Option<String>, String> {
    match req.file.as_ref() {
        Some(Value::String(file)) if !file.is_empty() => Ok(Some(file.clone())),
        // VERIFY: wave17-chat-3 — measured `String(e)` from
        // `resolve(CODEX_HOME, file)`: `TypeError [ERR_INVALID_ARG_TYPE]: ...`.
        Some(value) if js_truthy(value) => Err(format!(
            "TypeError [ERR_INVALID_ARG_TYPE]: The \"paths[1]\" argument must be of type string. Received {}",
            js_received(value)
        )),
        _ => Ok(None),
    }
}

/// `pathFor` (`sessions.mjs:590-595`): `/[\\/]/.test(project)` coerces the value
/// *before* `path.join` validates it, so a non-string whose `String()` holds a
/// separator makes `pathFor` return null; `readSession` then falls through to
/// `findById` — the same miss path as a stale project slug, not a throw. Any
/// other non-string reaches `path.join` and fails its string check.
fn claude_project(project: &Value) -> Result<String, String> {
    match project {
        Value::String(text) => Ok(text.clone()),
        other => {
            // VERIFY: wave17-chat-5 — M2: separator in the coerced value →
            // `pathFor` returns null. Handing the coerced string to the
            // transcript service reproduces that exactly: its `path_for`
            // rejects separators and then runs its own `findById` scan.
            let coerced = js_to_string(other);
            if coerced.contains(['/', '\\']) {
                return Ok(coerced);
            }
            // VERIFY: wave17-chat-4 — measured `String(e)` from
            // `join(root, project, ...)`: the name and code are both present.
            Err(format!(
                "TypeError [ERR_INVALID_ARG_TYPE]: The \"path\" argument must be of type string. Received {}",
                js_received(other)
            ))
        }
    }
}

/// `[...history]` (`chat.mjs:105`): absent → `[]`, a string spreads to its
/// characters, every other non-array throws. `String(e)` names the spread
/// operand, so the text is constant for every non-iterable value.
fn history_messages(raw: Option<&Value>) -> Result<Vec<Value>, String> {
    match raw {
        None => Ok(Vec::new()),
        Some(Value::Array(items)) => Ok(items.clone()),
        Some(Value::String(text)) => Ok(text.chars().map(|ch| json!(ch.to_string())).collect()),
        // VERIFY: wave17-chat-1 — `String(e)` for `[...history, {...}]` is
        // `TypeError: history is not iterable` for every non-iterable value
        // (V8 uses the source text of the spread operand, not the value).
        Some(_) => Err("TypeError: history is not iterable".to_owned()),
    }
}

fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|number| number != 0.0),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// `Number(value)` where `None` is `NaN`.
fn js_number(value: &Value) -> Option<f64> {
    match value {
        Value::Number(number) => number.as_f64(),
        Value::String(text) => text.trim().parse::<f64>().ok(),
        Value::Bool(flag) => Some(if *flag { 1.0 } else { 0.0 }),
        Value::Null => Some(0.0),
        Value::Array(_) | Value::Object(_) => None,
    }
}

/// `x || fallback` for a raw JSON token: a non-empty string wins.
fn raw_string(raw: Option<&RawValue>) -> Option<String> {
    match serde_json::from_str::<Value>(raw?.get()).ok()? {
        Value::String(text) if !text.is_empty() => Some(text),
        Value::String(_) | Value::Null => None,
        Value::Bool(false) => None,
        other => Some(other.to_string()),
    }
}

/// `m.text` as a string; raw non-string text keeps its JSON spelling.
fn message_text(raw: Option<&Value>) -> String {
    match raw {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Null) | None => String::new(),
        Some(other) => other.to_string(),
    }
}

/// JavaScript `String.prototype.length`: UTF-16 code units, not bytes.
fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

fn utf16_prefix(text: &str, units: usize) -> String {
    let mut used = 0;
    let mut out = String::new();
    for ch in text.chars() {
        let width = ch.len_utf16();
        if used + width > units {
            break;
        }
        used += width;
        out.push(ch);
    }
    out
}

fn utf16_suffix(text: &str, units: usize) -> String {
    let mut used = 0;
    let mut out = Vec::new();
    for ch in text.chars().rev() {
        let width = ch.len_utf16();
        if used + width > units {
            break;
        }
        used += width;
        out.push(ch);
    }
    out.iter().rev().collect()
}

#[cfg(test)]
mod tests {
    use super::{Cancel, ChatDeps, ChatFrame, ChatRequest, MESSAGES_URL};
    use crate::transcript_service::{Inputs, TranscriptService};
    use axum::Router;
    use axum::extract::State;
    use axum::http::StatusCode;
    use axum::routing::post;
    use serde_json::{Value, json};
    use std::net::Ipv4Addr;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, SystemTime, UNIX_EPOCH};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};

    const NOW_MS: i64 = 1_700_000_000_000;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(label: &str) -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir().join(format!("singularity-chat-{label}-{nonce}"));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        fn write(&self, rel: &str, text: &str) {
            let path = self.0.join(rel);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text).unwrap();
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn signed_in(root: &Path) {
        std::fs::create_dir_all(root.join(".claude")).unwrap();
        std::fs::write(
            root.join(".claude/.credentials.json"),
            json!({ "claudeAiOauth": { "accessToken": "fake-token", "expiresAt": NOW_MS + 3_600_000 } })
                .to_string(),
        )
        .unwrap();
    }

    fn deps(root: &Path, url: Option<String>) -> ChatDeps {
        let inputs = Inputs {
            state_dir: root.to_path_buf(),
            claude_home: root.to_path_buf(),
            codex_home: root.to_path_buf(),
            model_catalog: Vec::new(),
        };
        let mut deps = ChatDeps::new(
            Arc::new(TranscriptService::new(inputs)),
            root.join(".claude/.credentials.json"),
        );
        deps.messages_url = url.unwrap_or_else(|| MESSAGES_URL.to_owned());
        deps.keychain_platform = None;
        deps.now_ms = Some(NOW_MS);
        deps
    }

    fn run<F: std::future::Future>(future: F) -> F::Output {
        tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(future)
    }

    async fn chat(
        req: ChatRequest,
        deps: &ChatDeps,
        cancel: &Cancel,
    ) -> (Vec<ChatFrame>, Result<(), String>) {
        chat_with_timeout(req, deps, cancel, super::FETCH_TIMEOUT).await
    }

    async fn chat_with_timeout(
        req: ChatRequest,
        deps: &ChatDeps,
        cancel: &Cancel,
        timeout: Duration,
    ) -> (Vec<ChatFrame>, Result<(), String>) {
        let frames = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&frames);
        let result = super::stream_chat_with_timeout(
            req,
            deps,
            move |frame| sink.lock().unwrap().push(frame),
            cancel,
            timeout,
        )
        .await;
        let collected = frames.lock().unwrap().clone();
        (collected, result)
    }

    fn question(chat_id: &str) -> ChatRequest {
        ChatRequest {
            chat_id: Some(json!(chat_id)),
            question: Some(json!("hello")),
            ..ChatRequest::default()
        }
    }

    /// One TCP response with the body written in `chunks`, so the parser sees
    /// real chunk boundaries. `content-length` terminates the body.
    async fn serve_chunks(chunks: Vec<Vec<u8>>, gap: Duration) -> String {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        assert!(address.ip().is_loopback());
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            drain_request(&mut stream).await;
            let length: usize = chunks.iter().map(Vec::len).sum();
            let headers = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: {length}\r\nconnection: close\r\n\r\n"
            );
            stream.write_all(headers.as_bytes()).await.unwrap();
            for chunk in chunks {
                stream.write_all(&chunk).await.unwrap();
                stream.flush().await.unwrap();
                tokio::time::sleep(gap).await;
            }
        });
        format!("http://{address}/v1/messages")
    }

    async fn serve_stalled_error_body() -> (
        String,
        tokio::sync::oneshot::Receiver<()>,
        tokio::task::JoinHandle<()>,
    ) {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        assert!(address.ip().is_loopback());
        let (headers_sent, headers_received) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            drain_request(&mut stream).await;
            stream.write_all(
                b"HTTP/1.1 500 Internal Server Error\r\ncontent-type: application/json\r\ncontent-length: 100\r\nconnection: keep-alive\r\n\r\n",
            ).await.unwrap();
            stream.flush().await.unwrap();
            let _ = headers_sent.send(());
            std::future::pending::<()>().await;
        });
        (
            format!("http://{address}/v1/messages"),
            headers_received,
            server,
        )
    }

    async fn drain_request(stream: &mut TcpStream) {
        let mut buffer = [0_u8; 4096];
        let _ = stream.read(&mut buffer).await;
    }

    fn sse(payload: serde_json::Value) -> String {
        format!("data: {payload}\n\n")
    }

    #[test]
    fn stream_decoder_carries_partial_utf8_across_pushes() {
        let mut decoder = super::StreamDecoder::default();
        let text = "héllo ✓";
        let bytes = text.as_bytes();
        let split = text.find('é').unwrap() + 1; // inside the two-byte `é`
        assert_eq!(decoder.push(&bytes[..split]), "h");
        assert_eq!(decoder.push(&bytes[split..]), "éllo ✓");
        // An invalid byte becomes U+FFFD rather than poisoning the carry.
        assert_eq!(decoder.push(&[0xff, b'a']), "\u{fffd}a");
    }

    #[test]
    fn utf16_caps_match_javascript_slicing() {
        assert_eq!(super::utf16_len("héllo ✓"), 7);
        assert_eq!(super::utf16_prefix("héllo ✓", 2), "h\u{e9}");
        assert_eq!(super::utf16_suffix("héllo ✓", 2), " ✓");
        assert_eq!(super::utf16_len("😀"), 2);
        // A split surrogate pair is not representable, so the whole char stays.
        assert_eq!(super::utf16_prefix("😀", 1), "");
    }

    #[test]
    fn frame_json_matches_the_node_objects() {
        let c1 = || Some(json!("c1"));
        assert_eq!(
            serde_json::to_string(&ChatFrame::Delta {
                chat_id: c1(),
                text: "hi".into()
            })
            .unwrap(),
            r#"{"t":"chat:delta","chatId":"c1","text":"hi"}"#
        );
        assert_eq!(
            serde_json::to_string(&ChatFrame::Done { chat_id: c1() }).unwrap(),
            r#"{"t":"chat:done","chatId":"c1"}"#
        );
        assert_eq!(
            serde_json::to_string(&ChatFrame::Error {
                chat_id: c1(),
                needs_auth: None,
                msg: "HTTP 503".into()
            })
            .unwrap(),
            r#"{"t":"chat:error","chatId":"c1","msg":"HTTP 503"}"#
        );
        assert_eq!(
            serde_json::to_string(&ChatFrame::Error {
                chat_id: c1(),
                needs_auth: Some(true),
                msg: "auth expired — re-run `claude` to log in".into()
            })
            .unwrap(),
            r#"{"t":"chat:error","chatId":"c1","needsAuth":true,"msg":"auth expired — re-run `claude` to log in"}"#
        );
        // VERIFY: wave12-chat_raw_id-4 — JSON.stringify keeps `""`, `null` and
        // numbers, and drops only `undefined` (which has no JSON spelling).
        let raw = |chat_id: Option<serde_json::Value>| {
            serde_json::to_string(&ChatFrame::Error {
                chat_id,
                needs_auth: Some(true),
                msg: "needs auth".into(),
            })
            .unwrap()
        };
        assert_eq!(
            raw(Some(json!(""))),
            r#"{"t":"chat:error","chatId":"","needsAuth":true,"msg":"needs auth"}"#
        );
        assert_eq!(
            raw(Some(json!(null))),
            r#"{"t":"chat:error","chatId":null,"needsAuth":true,"msg":"needs auth"}"#
        );
        assert_eq!(
            raw(Some(json!(42))),
            r#"{"t":"chat:error","chatId":42,"needsAuth":true,"msg":"needs auth"}"#
        );
        assert_eq!(
            raw(None),
            r#"{"t":"chat:error","needsAuth":true,"msg":"needs auth"}"#
        );
    }

    #[test]
    fn request_defaults_match_node_destructuring() {
        let request: ChatRequest =
            serde_json::from_value(json!({ "chatId": "c", "question": "q" })).unwrap();
        assert_eq!(request.scope, json!("one"));
        assert_eq!(request.history, None);
        assert_eq!(request.project, None);
        assert_eq!(request.chat_id, Some(json!("c")));
        assert_eq!(request.question, Some(json!("q")));
        // An absent `chatId`/`question` stays absent (Node's `undefined`).
        let empty: ChatRequest = serde_json::from_value(json!({})).unwrap();
        assert_eq!(empty.chat_id, None);
        assert_eq!(empty.question, None);
        assert_eq!(empty.scope, json!("one"));
        // VERIFY: wave15-chat-1 — a present `null` is not `undefined`: serde's
        // `Option` would collapse it to `None`, `present_raw` keeps it.
        let nulls: ChatRequest = serde_json::from_value(json!({
            "chatId": null, "question": null, "history": null, "scope": null,
        }))
        .unwrap();
        assert_eq!(nulls.chat_id, Some(Value::Null));
        assert_eq!(nulls.question, Some(Value::Null));
        assert_eq!(nulls.history, Some(Value::Null));
        assert_eq!(nulls.scope, Value::Null);
    }

    #[test]
    fn raw_fields_follow_the_node_coercions() {
        use super::{claude_project, codex_file, history_messages, js_to_string, root_arg};
        let request = |fields: Value| serde_json::from_value::<ChatRequest>(fields).unwrap();

        // `id` coerces through the template literal / `RegExp.test`.
        assert_eq!(js_to_string(&json!(9)), "9");
        assert_eq!(js_to_string(&json!(null)), "null");
        assert_eq!(js_to_string(&json!([1, null, "a"])), "1,,a");
        assert_eq!(js_to_string(&json!({ "k": 1 })), "[object Object]");

        // `project` is rejected by `path.join` only when it is truthy; the text
        // is V8's `String(e)`, which `pty-ws.mjs:167` forwards.
        assert_eq!(
            claude_project(&json!(5)).unwrap_err(),
            "TypeError [ERR_INVALID_ARG_TYPE]: The \"path\" argument must be of type string. Received type number (5)"
        );
        assert!(claude_project(&json!({})).is_err());
        assert_eq!(claude_project(&json!("demo")).unwrap(), "demo");
        // M2: `/[\\/]/.test(project)` coerces first, so a separator in the
        // coerced value returns null from `pathFor` rather than throwing.
        assert_eq!(claude_project(&json!(["a/b"])).unwrap(), "a/b");
        assert_eq!(claude_project(&json!([["x\\y"]])).unwrap(), "x\\y");

        // `root`: truthy non-string throws, falsy takes the default root.
        assert_eq!(
            root_arg(Some(&json!(true))).unwrap_err(),
            "TypeError: p.startsWith is not a function"
        );
        assert_eq!(root_arg(Some(&json!(0))).unwrap(), None);
        assert_eq!(root_arg(Some(&json!(false))).unwrap(), None);
        assert_eq!(root_arg(Some(&json!(null))).unwrap(), None);
        assert_eq!(root_arg(Some(&json!(""))).unwrap(), None);
        assert_eq!(root_arg(Some(&json!("~/x"))).unwrap(), Some("~/x".into()));

        // `file` is validated only on the codex branch.
        assert_eq!(
            codex_file(&request(json!({ "file": 7 }))).unwrap_err(),
            "TypeError [ERR_INVALID_ARG_TYPE]: The \"paths[1]\" argument must be of type string. Received type number (7)"
        );
        assert_eq!(
            codex_file(&request(json!({ "file": "rollout.jsonl" }))).unwrap(),
            Some("rollout.jsonl".into())
        );
        assert_eq!(
            codex_file(&request(json!({ "file": false }))).unwrap(),
            None
        );

        // `history`: absent → [], string spreads to chars, everything else throws.
        assert_eq!(history_messages(None).unwrap(), Vec::<Value>::new());
        assert_eq!(
            history_messages(Some(&json!("ab"))).unwrap(),
            vec![json!("a"), json!("b")]
        );
        assert_eq!(
            history_messages(Some(&json!([{ "role": "user" }]))).unwrap(),
            vec![json!({ "role": "user" })]
        );
        for bad in [json!(3), json!(null), json!(true), json!({})] {
            assert_eq!(
                history_messages(Some(&bad)).unwrap_err(),
                "TypeError: history is not iterable",
                "{bad}"
            );
        }
    }

    async fn unavailable(State(calls): State<Arc<AtomicUsize>>) -> StatusCode {
        calls.fetch_add(1, Ordering::SeqCst);
        StatusCode::SERVICE_UNAVAILABLE
    }

    #[test]
    fn message_post_opts_out_of_retries() {
        run(async {
            let scratch = TempDir::new("retry");
            signed_in(&scratch.0);
            let calls = Arc::new(AtomicUsize::new(0));
            let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
            let address = listener.local_addr().unwrap();
            let counted = Arc::clone(&calls);
            let server = tokio::spawn(async move {
                axum::serve(
                    listener,
                    Router::new()
                        .route("/v1/messages", post(unavailable))
                        .with_state(counted),
                )
                .await
                .unwrap();
            });
            let deps = deps(&scratch.0, Some(format!("http://{address}/v1/messages")));
            let (frames, result) = chat(question("retry-test"), &deps, &Cancel::new()).await;
            assert!(result.is_ok());
            assert_eq!(calls.load(Ordering::SeqCst), 1);
            assert_eq!(
                frames,
                vec![ChatFrame::Error {
                    chat_id: Some(json!("retry-test")),
                    needs_auth: None,
                    msg: "HTTP 503".into(),
                }]
            );
            server.abort();
        });
    }

    #[test]
    fn sse_event_split_across_chunks_yields_one_delta() {
        run(async {
            let scratch = TempDir::new("split");
            signed_in(&scratch.0);
            let block = sse(json!({
                "type": "content_block_delta",
                "delta": { "type": "text_delta", "text": "hello world" }
            }));
            let mid = block.len() / 2;
            assert!(block.is_char_boundary(mid));
            let url = serve_chunks(
                vec![
                    block.as_bytes()[..mid].to_vec(),
                    block.as_bytes()[mid..].to_vec(),
                ],
                Duration::from_millis(40),
            )
            .await;
            let deps = deps(&scratch.0, Some(url));
            let (frames, result) = chat(question("c1"), &deps, &Cancel::new()).await;
            assert!(result.is_ok());
            assert_eq!(
                frames,
                vec![
                    ChatFrame::Delta {
                        chat_id: Some(json!("c1")),
                        text: "hello world".into()
                    },
                    ChatFrame::Done {
                        chat_id: Some(json!("c1"))
                    },
                ]
            );
        });
    }

    #[test]
    fn split_utf8_delta_survives_the_chunk_boundary() {
        run(async {
            let scratch = TempDir::new("utf8");
            signed_in(&scratch.0);
            let block = sse(json!({
                "type": "content_block_delta",
                "delta": { "type": "text_delta", "text": "héllo ✓" }
            }));
            let bytes = block.as_bytes();
            // Split inside the two-byte `é`, one byte early.
            let mid = block.find('é').unwrap() + 1;
            let url = serve_chunks(
                vec![bytes[..mid].to_vec(), bytes[mid..].to_vec()],
                Duration::from_millis(40),
            )
            .await;
            let deps = deps(&scratch.0, Some(url));
            let (frames, result) = chat(question("c5"), &deps, &Cancel::new()).await;
            assert!(result.is_ok());
            assert_eq!(
                frames,
                vec![
                    ChatFrame::Delta {
                        chat_id: Some(json!("c5")),
                        text: "héllo ✓".into()
                    },
                    ChatFrame::Done {
                        chat_id: Some(json!("c5"))
                    },
                ]
            );
        });
    }

    #[test]
    fn message_stop_sends_done() {
        run(async {
            let scratch = TempDir::new("stop");
            signed_in(&scratch.0);
            let url = serve_chunks(
                vec![sse(json!({ "type": "message_stop" })).into_bytes()],
                Duration::ZERO,
            )
            .await;
            let deps = deps(&scratch.0, Some(url));
            let (frames, result) = chat(question("c2"), &deps, &Cancel::new()).await;
            assert!(result.is_ok());
            assert_eq!(
                frames,
                vec![ChatFrame::Done {
                    chat_id: Some(json!("c2"))
                }]
            );
        });
    }

    #[test]
    fn error_payload_sends_chat_error() {
        run(async {
            let scratch = TempDir::new("sse-error");
            signed_in(&scratch.0);
            let url = serve_chunks(
                vec![sse(json!({ "type": "error", "error": { "message": "boom" } })).into_bytes()],
                Duration::ZERO,
            )
            .await;
            let deps = deps(&scratch.0, Some(url));
            let (frames, result) = chat(question("c3"), &deps, &Cancel::new()).await;
            assert!(result.is_ok());
            assert_eq!(
                frames,
                vec![ChatFrame::Error {
                    chat_id: Some(json!("c3")),
                    needs_auth: None,
                    msg: "boom".into(),
                }]
            );
        });
    }

    #[test]
    fn quiet_stream_end_still_emits_done() {
        run(async {
            let scratch = TempDir::new("quiet");
            signed_in(&scratch.0);
            let url = serve_chunks(Vec::new(), Duration::ZERO).await;
            let deps = deps(&scratch.0, Some(url));
            let (frames, result) = chat(question("c4"), &deps, &Cancel::new()).await;
            assert!(result.is_ok());
            assert_eq!(
                frames,
                vec![ChatFrame::Done {
                    chat_id: Some(json!("c4"))
                }]
            );
        });
    }

    #[test]
    fn missing_token_reports_needs_auth_without_a_request() {
        run(async {
            let scratch = TempDir::new("no-token");
            let deps = deps(&scratch.0, None);
            let (frames, result) = chat(question("c6"), &deps, &Cancel::new()).await;
            assert!(result.is_ok());
            assert_eq!(
                frames,
                vec![ChatFrame::Error {
                    chat_id: Some(json!("c6")),
                    needs_auth: Some(true),
                    msg: "Claude not signed in — run `claude` to log in".into(),
                }]
            );
        });
    }

    #[test]
    fn expired_token_reports_needs_auth() {
        run(async {
            let scratch = TempDir::new("expired");
            scratch.write(
                ".claude/.credentials.json",
                &json!({ "claudeAiOauth": { "accessToken": "stale-token", "expiresAt": NOW_MS - 1 } })
                    .to_string(),
            );
            let deps = deps(&scratch.0, None);
            let (frames, _) = chat(question("c7"), &deps, &Cancel::new()).await;
            assert_eq!(
                frames,
                vec![ChatFrame::Error {
                    chat_id: Some(json!("c7")),
                    needs_auth: Some(true),
                    msg: "Claude not signed in — run `claude` to log in".into(),
                }]
            );
        });
    }

    #[test]
    fn cancelled_before_start_emits_nothing_and_sends_no_request() {
        run(async {
            let scratch = TempDir::new("cancel");
            signed_in(&scratch.0);
            let hits = Arc::new(AtomicUsize::new(0));
            let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
            let address = listener.local_addr().unwrap();
            let counted = Arc::clone(&hits);
            let server = tokio::spawn(async move {
                if let Ok((mut stream, _)) = listener.accept().await {
                    counted.fetch_add(1, Ordering::SeqCst);
                    drain_request(&mut stream).await;
                }
            });
            let deps = deps(&scratch.0, Some(format!("http://{address}/v1/messages")));
            let cancel = Cancel::new();
            cancel.cancel();
            let (frames, result) = chat(question("c8"), &deps, &cancel).await;
            assert!(result.is_ok());
            assert!(frames.is_empty());
            assert_eq!(hits.load(Ordering::SeqCst), 0);
            server.abort();
        });
    }

    #[test]
    fn cancelling_stalled_error_body_suppresses_chat_error_frame() {
        run(async {
            let scratch = TempDir::new("cancel-error-body");
            signed_in(&scratch.0);
            let (url, headers_sent, server) = serve_stalled_error_body().await;
            let deps = deps(&scratch.0, Some(url));
            let cancel = Cancel::new();
            let chat_task = tokio::spawn({
                let cancel = cancel.clone();
                async move {
                    let frames = Arc::new(Mutex::new(Vec::new()));
                    let sink = Arc::clone(&frames);
                    let result = super::stream_chat_with_timeout(
                        question("cancel-error-body"),
                        &deps,
                        move |frame| sink.lock().unwrap().push(frame),
                        &cancel,
                        Duration::from_secs(5),
                    )
                    .await;
                    (frames.lock().unwrap().clone(), result)
                }
            });
            tokio::time::timeout(Duration::from_secs(5), headers_sent)
                .await
                .expect("server should send stalled headers")
                .unwrap();
            cancel.cancel();
            let (frames, result) = tokio::time::timeout(Duration::from_secs(2), chat_task)
                .await
                .expect("cancellation should release the stalled body")
                .unwrap();
            assert!(result.is_ok());
            assert!(frames.is_empty());
            server.abort();
        });
    }

    #[test]
    fn stalled_error_body_deadline_keeps_http_fallback_message() {
        run(async {
            let scratch = TempDir::new("deadline-error-body");
            signed_in(&scratch.0);
            let (url, headers_sent, server) = serve_stalled_error_body().await;
            let deps = deps(&scratch.0, Some(url));
            let chat_task = tokio::spawn(async move {
                chat_with_timeout(
                    question("deadline-error-body"),
                    &deps,
                    &Cancel::new(),
                    Duration::from_secs(1),
                )
                .await
            });
            tokio::time::timeout(Duration::from_secs(5), headers_sent)
                .await
                .expect("server should send stalled headers")
                .unwrap();
            let (frames, result) = tokio::time::timeout(Duration::from_secs(3), chat_task)
                .await
                .expect("deadline should release the stalled body")
                .unwrap();
            assert!(result.is_ok());
            assert_eq!(
                frames,
                vec![ChatFrame::Error {
                    chat_id: Some(json!("deadline-error-body")),
                    needs_auth: None,
                    msg: "HTTP 500".into(),
                }]
            );
            server.abort();
        });
    }

    #[test]
    fn status_codes_map_to_the_node_messages() {
        run(async {
            for (status, expected) in [
                (
                    StatusCode::UNAUTHORIZED,
                    "auth expired — re-run `claude` to log in",
                ),
                (
                    StatusCode::TOO_MANY_REQUESTS,
                    "rate-limited — try again shortly",
                ),
            ] {
                let scratch = TempDir::new("status");
                signed_in(&scratch.0);
                let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
                let address = listener.local_addr().unwrap();
                let server = tokio::spawn(async move {
                    axum::serve(
                        listener,
                        Router::new().route("/v1/messages", post(move || async move { status })),
                    )
                    .await
                    .unwrap();
                });
                let deps = deps(&scratch.0, Some(format!("http://{address}/v1/messages")));
                let (frames, result) = chat(question("c9"), &deps, &Cancel::new()).await;
                assert!(result.is_ok());
                assert_eq!(frames.len(), 1);
                assert_eq!(
                    frames[0],
                    ChatFrame::Error {
                        chat_id: Some(json!("c9")),
                        needs_auth: (status == StatusCode::UNAUTHORIZED).then_some(true),
                        msg: expected.into(),
                    }
                );
                server.abort();
            }
        });
    }

    #[test]
    fn error_body_message_replaces_the_http_status() {
        run(async {
            let scratch = TempDir::new("body-error");
            signed_in(&scratch.0);
            let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
            let address = listener.local_addr().unwrap();
            let server = tokio::spawn(async move {
                axum::serve(
                    listener,
                    Router::new().route(
                        "/v1/messages",
                        post(|| async {
                            (
                                StatusCode::BAD_REQUEST,
                                axum::Json(json!({ "error": { "message": "bad request shape" } })),
                            )
                        }),
                    ),
                )
                .await
                .unwrap();
            });
            let deps = deps(&scratch.0, Some(format!("http://{address}/v1/messages")));
            let (frames, _) = chat(question("c10"), &deps, &Cancel::new()).await;
            assert_eq!(
                frames,
                vec![ChatFrame::Error {
                    chat_id: Some(json!("c10")),
                    needs_auth: None,
                    msg: "bad request shape".into(),
                }]
            );
            server.abort();
        });
    }

    #[test]
    fn scope_all_context_lists_sessions_and_truncates() {
        run(async {
            let scratch = TempDir::new("scope-all");
            signed_in(&scratch.0);
            // A transcript under the resolved root, so `list` returns one row.
            scratch.write(
                ".claude/projects/demo/sess-1.jsonl",
                &format!(
                    "{}\n{}\n",
                    json!({ "type": "user", "cwd": "/tmp/demo", "timestamp": "2026-10-01T00:00:00Z", "message": { "content": "hello there" } }),
                    json!({ "type": "assistant", "timestamp": "2026-10-01T00:00:01Z", "message": { "content": [{ "type": "text", "text": "hi" }] } }),
                ),
            );
            let captured = Arc::new(Mutex::new(None::<serde_json::Value>));
            let seen = Arc::clone(&captured);
            let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
            let address = listener.local_addr().unwrap();
            let server = tokio::spawn(async move {
                axum::serve(
                    listener,
                    Router::new().route(
                        "/v1/messages",
                        post(move |body: String| async move {
                            *seen.lock().unwrap() = serde_json::from_str(&body).ok();
                            sse(json!({ "type": "message_stop" }))
                        }),
                    ),
                )
                .await
                .unwrap();
            });
            let deps = deps(&scratch.0, Some(format!("http://{address}/v1/messages")));
            let mut request = question("c11");
            request.scope = json!("all");
            let (_frames, result) = chat(request, &deps, &Cancel::new()).await;
            assert!(result.is_ok());
            let body = captured.lock().unwrap().clone().expect("request body");
            assert_eq!(body["model"], "claude-haiku-4-5-20251001");
            assert_eq!(body["max_tokens"], 2048);
            assert_eq!(body["stream"], true);
            let system = body["system"].as_str().unwrap();
            assert!(
                system.starts_with("You are Claude Code, Anthropic's official CLI for Claude.")
            );
            assert!(system.contains("<sessions>\n- sess-1  (/tmp/demo, 20"));
            assert!(system.contains(")\n</sessions>"));
            assert_eq!(body["messages"].as_array().unwrap().len(), 1);
            server.abort();
        });
    }

    #[test]
    fn scope_one_context_embeds_the_transcript() {
        run(async {
            let scratch = TempDir::new("scope-one");
            signed_in(&scratch.0);
            scratch.write(
                ".claude/projects/demo/sess-2.jsonl",
                &format!(
                    "{}\n{}\n",
                    json!({ "type": "user", "cwd": "/tmp/demo", "timestamp": "2026-10-01T00:00:00Z", "message": { "content": "why is it slow" } }),
                    json!({ "type": "user", "timestamp": "2026-10-01T00:00:01Z", "message": { "content": [{ "type": "tool_result", "content": "tool says hi" }] } }),
                ),
            );
            let captured = Arc::new(Mutex::new(None::<serde_json::Value>));
            let seen = Arc::clone(&captured);
            let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
            let address = listener.local_addr().unwrap();
            let server = tokio::spawn(async move {
                axum::serve(
                    listener,
                    Router::new().route(
                        "/v1/messages",
                        post(move |body: String| async move {
                            *seen.lock().unwrap() = serde_json::from_str(&body).ok();
                            sse(json!({ "type": "message_stop" }))
                        }),
                    ),
                )
                .await
                .unwrap();
            });
            let deps = deps(&scratch.0, Some(format!("http://{address}/v1/messages")));
            let mut request = question("c12");
            request.project = Some(json!("demo"));
            request.id = Some(json!("sess-2"));
            request.history = Some(json!([{ "role": "user", "content": "earlier" }]));
            let (_frames, result) = chat(request, &deps, &Cancel::new()).await;
            assert!(result.is_ok());
            let body = captured.lock().unwrap().clone().expect("request body");
            let system = body["system"].as_str().unwrap();
            assert!(system.contains(
                "<session>\n[user] why is it slow\n[tool_result] tool says hi\n</session>"
            ));
            let messages = body["messages"].as_array().unwrap();
            assert_eq!(messages.len(), 2);
            assert_eq!(messages[0]["content"], "earlier");
            assert_eq!(messages[1]["content"], "hello");
            server.abort();
        });
    }

    // VERIFY: wave12-chat_raw_id-4 — `{ role: 'user', content: question }`
    // (`chat.mjs:105`) forwards the raw value: a non-string question is sent as
    // that JSON value, and an absent one leaves `content` out (JSON.stringify
    // drops `undefined`). Node performs no coercion.
    #[test]
    fn raw_question_value_is_forwarded_without_coercion() {
        run(async {
            let scratch = TempDir::new("raw-question");
            signed_in(&scratch.0);
            let captured = Arc::new(Mutex::new(Vec::<serde_json::Value>::new()));
            let seen = Arc::clone(&captured);
            let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
            let address = listener.local_addr().unwrap();
            let server = tokio::spawn(async move {
                axum::serve(
                    listener,
                    Router::new().route(
                        "/v1/messages",
                        post(move |body: String| async move {
                            seen.lock()
                                .unwrap()
                                .push(serde_json::from_str(&body).unwrap());
                            sse(json!({ "type": "message_stop" }))
                        }),
                    ),
                )
                .await
                .unwrap();
            });
            let deps = deps(&scratch.0, Some(format!("http://{address}/v1/messages")));

            let mut numeric = question("c13");
            numeric.question = Some(json!(7));
            let (frames, result) = chat(numeric, &deps, &Cancel::new()).await;
            assert!(result.is_ok());
            assert_eq!(
                frames,
                vec![ChatFrame::Done {
                    chat_id: Some(json!("c13"))
                }]
            );

            let mut absent = question("c14");
            absent.question = None;
            let (_, result) = chat(absent, &deps, &Cancel::new()).await;
            assert!(result.is_ok());

            let bodies = captured.lock().unwrap().clone();
            assert_eq!(bodies.len(), 2);
            assert_eq!(
                bodies[0]["messages"][0],
                json!({ "role": "user", "content": 7 })
            );
            assert_eq!(bodies[1]["messages"][0], json!({ "role": "user" }));
            server.abort();
        });
    }
}
