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
use serde_json::{Value, json, value::RawValue};
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
        #[serde(rename = "chatId")]
        chat_id: String,
        text: String,
    },
    #[serde(rename = "chat:done")]
    Done {
        #[serde(rename = "chatId")]
        chat_id: String,
    },
    #[serde(rename = "chat:error")]
    Error {
        #[serde(rename = "chatId")]
        chat_id: String,
        #[serde(rename = "needsAuth", skip_serializing_if = "Option::is_none")]
        needs_auth: Option<bool>,
        msg: String,
    },
}

/// The `/ws` `chat` message (`pty-ws.mjs:162-168`, destructured at
/// `chat.mjs:98`). `scope` defaults to `one`, `history` to `[]`; every other
/// field is optional.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ChatRequest {
    pub chat_id: String,
    pub question: String,
    pub scope: String,
    pub project: Option<String>,
    pub id: Option<String>,
    pub source: Option<String>,
    pub file: Option<String>,
    /// Turn objects (`{role, content}`) passed straight through to the API.
    pub history: Vec<Value>,
    pub root: Option<String>,
}

impl Default for ChatRequest {
    fn default() -> Self {
        Self {
            chat_id: String::new(),
            question: String::new(),
            scope: "one".to_owned(),
            project: None,
            id: None,
            source: None,
            file: None,
            history: Vec::new(),
            root: None,
        }
    }
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
    let Some(token) = oauth_access_token(deps) else {
        send(ChatFrame::Error {
            chat_id: req.chat_id.clone(),
            needs_auth: Some(true),
            msg: NO_TOKEN_MESSAGE.to_owned(),
        });
        return Ok(());
    };
    let system = format!("{IDENTITY}{}", context_for(&req, deps).await?);
    let mut messages = req.history.clone();
    messages.push(json!({ "role": "user", "content": req.question }));

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
    let deadline = tokio::time::Instant::now() + FETCH_TIMEOUT;
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
        if let Ok(payload) = response.json::<Value>().await {
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
    if req.scope == "one" {
        if let (Some(project), Some(id)) = (truthy(&req.project), truthy(&req.id)) {
            let text = session_text(deps, project, id, req).await?;
            if text.is_empty() {
                return Ok("\n\nThe selected session transcript is empty.".to_owned());
            }
            return Ok(format!(
                "\n\nYou are answering questions about ONE Claude Code session. Below is its transcript. Cite turns by role when useful.\n\n<session>\n{text}\n</session>"
            ));
        }
    }
    // Scope `all`: a directory of the most recent sessions (metadata only — the
    // full text of every session will not fit).
    let rows = list_sessions(deps, req).await?;
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
    project: &str,
    id: &str,
    req: &ChatRequest,
) -> Result<String, String> {
    let service = Arc::clone(&deps.transcripts);
    let options = ReadOptions {
        root: req.root.clone(),
        source: req.source.clone(),
        file: req.file.clone(),
    };
    let project = project.to_owned();
    let id = id.to_owned();
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
async fn list_sessions(deps: &ChatDeps, req: &ChatRequest) -> Result<Vec<SessionRow>, String> {
    let service = Arc::clone(&deps.transcripts);
    let options = ListOptions {
        root: req.root.clone(),
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
    chat_id: &str,
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

/// JS falsiness for the optional request fields (`project`, `id`).
fn truthy(value: &Option<String>) -> Option<&str> {
    value.as_deref().filter(|value| !value.is_empty())
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
    use super::{Cancel, ChatDeps, ChatFrame, ChatRequest, MESSAGES_URL, stream_chat};
    use crate::transcript_service::{Inputs, TranscriptService};
    use axum::Router;
    use axum::extract::State;
    use axum::http::StatusCode;
    use axum::routing::post;
    use serde_json::json;
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
        let frames = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&frames);
        let result = stream_chat(
            req,
            deps,
            move |frame| sink.lock().unwrap().push(frame),
            cancel,
        )
        .await;
        let collected = frames.lock().unwrap().clone();
        (collected, result)
    }

    fn question(chat_id: &str) -> ChatRequest {
        ChatRequest {
            chat_id: chat_id.to_owned(),
            question: "hello".to_owned(),
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
        assert_eq!(
            serde_json::to_string(&ChatFrame::Delta {
                chat_id: "c1".into(),
                text: "hi".into()
            })
            .unwrap(),
            r#"{"t":"chat:delta","chatId":"c1","text":"hi"}"#
        );
        assert_eq!(
            serde_json::to_string(&ChatFrame::Done {
                chat_id: "c1".into()
            })
            .unwrap(),
            r#"{"t":"chat:done","chatId":"c1"}"#
        );
        assert_eq!(
            serde_json::to_string(&ChatFrame::Error {
                chat_id: "c1".into(),
                needs_auth: None,
                msg: "HTTP 503".into()
            })
            .unwrap(),
            r#"{"t":"chat:error","chatId":"c1","msg":"HTTP 503"}"#
        );
        assert_eq!(
            serde_json::to_string(&ChatFrame::Error {
                chat_id: "c1".into(),
                needs_auth: Some(true),
                msg: "auth expired — re-run `claude` to log in".into()
            })
            .unwrap(),
            r#"{"t":"chat:error","chatId":"c1","needsAuth":true,"msg":"auth expired — re-run `claude` to log in"}"#
        );
    }

    #[test]
    fn request_defaults_match_node_destructuring() {
        let request: ChatRequest =
            serde_json::from_value(json!({ "chatId": "c", "question": "q" })).unwrap();
        assert_eq!(request.scope, "one");
        assert!(request.history.is_empty());
        assert_eq!(request.project, None);
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
                    chat_id: "retry-test".into(),
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
                        chat_id: "c1".into(),
                        text: "hello world".into()
                    },
                    ChatFrame::Done {
                        chat_id: "c1".into()
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
                        chat_id: "c5".into(),
                        text: "héllo ✓".into()
                    },
                    ChatFrame::Done {
                        chat_id: "c5".into()
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
                    chat_id: "c2".into()
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
                    chat_id: "c3".into(),
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
                    chat_id: "c4".into()
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
                    chat_id: "c6".into(),
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
                    chat_id: "c7".into(),
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
                        chat_id: "c9".into(),
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
                    chat_id: "c10".into(),
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
            request.scope = "all".into();
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
            request.project = Some("demo".into());
            request.id = Some("sess-2".into());
            request.history = vec![json!({ "role": "user", "content": "earlier" })];
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
}
