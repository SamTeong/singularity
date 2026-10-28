//! Transcript and session read routes: `GET`/`PUT /api/transcripts/root`,
//! `GET /api/transcripts`, `GET /api/transcripts/codex-thread`,
//! `GET /api/transcript`, `GET /api/transcripts/search` and
//! `POST /api/transcripts/stats`, mirroring `server/transcript-routes.mjs:2-31`
//! and `server/index.mjs:863-869` with their `sessions.mjs` / `stats.mjs`
//! adapters.
//!
//! Transcript parsing, discovery and file access stay in `transcript_service`;
//! per-session cost/token parsing stays in `stats`. This module owns only the
//! HTTP surface plus the pieces Node keeps in its own process: `reg.isLive` for
//! the recomputed `running` flag (`server/sessions.mjs:86-91` and `:100`),
//! `reg.codexThreadFor` (`server/transcript-routes.mjs:11`) and the resume-scope
//! merge (`server/transcript-routes.mjs:19-27`). They arrive as
//! [`TranscriptRegistry`] so the host can wire the live registry later; the
//! default methods model the Node shape for an unknown agent (not live, no
//! scopes, no codex thread).
//!
//! Parity notes:
//!   * Repeated query keys are arrays in Fastify. Node forwards the array to the
//!     typed Rust bridge, which rejects it, so the route answers 500 with serde's
//!     type-error text; only the position is dropped here, because the generated
//!     bridge request layout differs.
//!   * `Number(req.query.cap) || 5000` keeps the JavaScript number coercion, then
//!     the bridge's `usize` boundary decides between a usable cap and a 500.
//!   * Transcript bodies keep the parser's exact JSON bytes. The resume-scope
//!     merge splices `"scopes"` into `meta` instead of re-serializing, so escaped
//!     lone surrogates in the transcript survive verbatim as in Node.
use crate::http_body::{RawBody, parse_raw};
use crate::http_policy::query_values;
use crate::stats::{StatsRequest, StatsService};
use crate::transcript_bridge::ResponseBody;
use crate::transcript_service::{
    Inputs, ListOptions, ReadOptions, SearchOptions, SessionRow, TranscriptService,
};
use axum::body::Body;
use axum::extract::{RawQuery, State};
use axum::http::{Request, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::ser::SerializeMap;
use serde::{Serialize, Serializer};
use serde_json::value::RawValue;
use serde_json::{Value, json};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

/// `RUNNING_MS` in `server/sessions.mjs:12`.
const RUNNING_MS: f64 = 30_000.0;
/// `Number(req.query.cap) || 5000` (`server/transcript-routes.mjs:4`).
const DEFAULT_CAP: f64 = 5000.0;
/// `req.body.items.slice(0, 200)` (`server/index.mjs:864`).
const STATS_ITEM_CAP: usize = 200;
/// serde's `expected a string` prefix for the bridge request Node's array-valued
/// query key cannot satisfy; see the module note on repeated query keys.
const SEQUENCE_MESSAGE: &str = "invalid type: sequence, expected a string";
/// serde's `expected usize` prefix for a cap the bridge's typed request rejects.
const CAP_MESSAGE: &str = "invalid type: expected usize";
/// `stats.mjs` `statsRequest` rejects a payload carrying `error`.
const BAD_INPUTS_MESSAGE: &str = "missing stats request inputs";
/// Fastify's message when `req.query.q` is an array (`q.charCodeAt` is absent).
const SEARCH_ARRAY_MESSAGE: &str = "q.charCodeAt is not a function";

/// Live agent registry inputs the Node routes read out of `server/agents.mjs`.
///
/// `is_live` is `reg.isLive` (`agents.mjs:135`), `codex_thread_for` is
/// `reg.codexThreadFor` (`agents.mjs:173`), and the two scope lookups are
/// `reg.getLaunchConfig` / `reg.getLaunchConfigForCodexThread`
/// (`agents.mjs:141,156`) reduced to the only field the route consumes.
pub trait TranscriptRegistry: Send + Sync {
    /// `!!agents.get(id)?.proc`.
    fn is_live(&self, _agent_id: &str) -> bool {
        false
    }
    /// Registry id to codex-minted rollout thread uuid.
    fn codex_thread_for(&self, _agent_id: &str) -> Option<String> {
        None
    }
    /// `getLaunchConfig(id)?.scopes`.
    fn launch_scopes(&self, _agent_id: &str) -> Option<Vec<String>> {
        None
    }
    /// `getLaunchConfigForCodexThread(threadId, cwd)?.scopes`.
    fn codex_thread_scopes(&self, _thread_id: &str, _cwd: Option<&str>) -> Option<Vec<String>> {
        None
    }
}

/// Host-supplied inputs every route needs. `model_catalog` is a live provider
/// because Node re-reads `(await getModels()).models` on every call
/// (`server/sessions.mjs:20-27`); the parsed catalog changes the transcript
/// parser's model labels and cost estimates.
pub struct TranscriptHost {
    pub state_dir: PathBuf,
    pub claude_home: PathBuf,
    pub codex_home: PathBuf,
    /// `USAGE_SKILL_STATE` (`server/app-dir.mjs:28`); its `cost-state/` directory
    /// and `stats.csv` back the session cost figures.
    pub usage_state: PathBuf,
    pub model_catalog: Arc<dyn Fn() -> Vec<Value> + Send + Sync>,
    pub registry: Arc<dyn TranscriptRegistry>,
}

struct Inner {
    host: TranscriptHost,
    /// The service caches transcript metadata and search text, so it must outlive
    /// a request; Node keeps one alive for the whole daemon. Rebuilt only when the
    /// model catalogue changes, exactly like `transcript_bridge.rs:73-85`.
    service: Mutex<Option<(String, Arc<TranscriptService>)>>,
    stats: Mutex<StatsService>,
}

// VERIFY: transcripts-router-injection
/// Mounts the six transcript routes. The outer server layer owns auth, origin and
/// token checks.
pub fn router(host: TranscriptHost) -> Router {
    Router::new()
        .route("/api/transcripts/root", get(root_get).put(root_put))
        .route("/api/transcripts", get(list))
        .route("/api/transcripts/codex-thread", get(codex_thread))
        .route("/api/transcript", get(read))
        .route("/api/transcripts/search", get(search))
        .route("/api/transcripts/stats", post(stats))
        .with_state(Arc::new(Inner {
            host,
            service: Mutex::new(None),
            stats: Mutex::new(StatsService::default()),
        }))
}

impl Inner {
    fn transcript(&self) -> Arc<TranscriptService> {
        let catalog = (self.host.model_catalog)();
        let key = serde_json::to_string(&catalog).unwrap_or_default();
        let mut slot = self
            .service
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if let Some((cached, service)) = slot.as_ref() {
            if *cached == key {
                return service.clone();
            }
        }
        let service = Arc::new(TranscriptService::new(Inputs {
            state_dir: self.host.state_dir.clone(),
            claude_home: self.host.claude_home.clone(),
            codex_home: self.host.codex_home.clone(),
            model_catalog: catalog,
        }));
        *slot = Some((key, service.clone()));
        service
    }
}

/// `GET /api/transcripts/root` (`server/transcript-routes.mjs:2`).
async fn root_get(State(inner): State<Arc<Inner>>) -> Response {
    match tokio::task::spawn_blocking(move || {
        let root = inner.transcript().get_root();
        Json(RootReply { root: &root }).into_response()
    })
    .await
    {
        Ok(response) => response,
        Err(_) => internal_error("Internal Server Error"),
    }
}

/// `PUT /api/transcripts/root` (`server/transcript-routes.mjs:3`). The route always
/// answers 200: `setSessionsRoot` turns both an invalid token and a bridge failure
/// into `{ok:false, error}` (`server/sessions.mjs:54-58`).
async fn root_put(State(inner): State<Arc<Inner>>, request: Request<Body>) -> Response {
    let body = match parse_raw(request).await {
        Ok(body) => body,
        Err(response) => return response,
    };
    let root = match root_member(&body) {
        Some(root) if !root.is_empty() => root,
        _ => return Json(bad_root()).into_response(),
    };
    match tokio::task::spawn_blocking(move || {
        let service = inner.transcript();
        Json(service.set_root(&root)).into_response()
    })
    .await
    {
        Ok(response) => response,
        Err(_) => internal_error("Internal Server Error"),
    }
}

/// `GET /api/transcripts` (`server/transcript-routes.mjs:4`).
async fn list(State(inner): State<Arc<Inner>>, RawQuery(query): RawQuery) -> Response {
    match tokio::task::spawn_blocking(move || list_response(&inner, query.as_deref())).await {
        Ok(response) => response,
        Err(_) => internal_error("Internal Server Error"),
    }
}

/// `GET /api/transcripts/codex-thread` (`server/transcript-routes.mjs:8-14`).
async fn codex_thread(State(inner): State<Arc<Inner>>, RawQuery(query): RawQuery) -> Response {
    match tokio::task::spawn_blocking(move || codex_thread_response(&inner, query.as_deref())).await
    {
        Ok(response) => response,
        Err(_) => internal_error("Internal Server Error"),
    }
}

/// `GET /api/transcript` (`server/transcript-routes.mjs:15-30`).
async fn read(State(inner): State<Arc<Inner>>, RawQuery(query): RawQuery) -> Response {
    match tokio::task::spawn_blocking(move || read_response(&inner, query.as_deref())).await {
        Ok(response) => response,
        Err(_) => internal_error("Internal Server Error"),
    }
}

/// `GET /api/transcripts/search` (`server/transcript-routes.mjs:31`).
async fn search(State(inner): State<Arc<Inner>>, RawQuery(query): RawQuery) -> Response {
    match tokio::task::spawn_blocking(move || search_response(&inner, query.as_deref())).await {
        Ok(response) => response,
        Err(_) => internal_error("Internal Server Error"),
    }
}

/// `POST /api/transcripts/stats` (`server/index.mjs:863-869`).
async fn stats(State(inner): State<Arc<Inner>>, request: Request<Body>) -> Response {
    let body = match parse_raw(request).await {
        Ok(body) => body,
        Err(response) => return response,
    };
    match tokio::task::spawn_blocking(move || stats_response(&inner, &body)).await {
        Ok(response) => response,
        Err(_) => internal_error("Internal Server Error"),
    }
}

fn list_response(inner: &Inner, query: Option<&str>) -> Response {
    let cap = match cap_param(param_values(query, "cap")) {
        Ok(cap) => cap,
        Err(response) => return response,
    };
    let root = match single_param(param_values(query, "root")) {
        Ok(root) => root,
        Err(response) => return response,
    };
    let hide_reviews = hide_reviews(query);
    let now = now_ms();
    let service = inner.transcript();
    match service.list(&ListOptions {
        root,
        cap,
        now_ms: now,
        hide_reviews,
        // Liveness is recomputed below from the registry, so the service needs no
        // id list; Node does the same in `updateRunning` after the bridge call.
        live_ids: Vec::new(),
    }) {
        Ok(mut rows) => {
            apply_liveness(&mut rows, now, inner.host.registry.as_ref());
            Json(SessionsReply { sessions: rows }).into_response()
        }
        Err(error) => internal_error(&error.to_string()),
    }
}

fn codex_thread_response(inner: &Inner, query: Option<&str>) -> Response {
    let ids = param_values(query, "id");
    let thread_id = match ids.len() {
        // An absent or empty id is falsy in Node; a repeated id is an array, which
        // the registry cannot key, so `codexThreadFor` resolves to null.
        0 => None,
        1 => ids.into_iter().next().filter(|id| !id.is_empty()),
        _ => return codex_reply(StatusCode::NOT_FOUND, None, Some("not found")),
    };
    let Some(id) = thread_id else {
        return codex_reply(StatusCode::BAD_REQUEST, None, Some("id required"));
    };
    match inner.host.registry.codex_thread_for(&id) {
        Some(thread_id) => codex_reply(StatusCode::OK, Some(&thread_id), None),
        None => codex_reply(StatusCode::NOT_FOUND, None, Some("not found")),
    }
}

fn read_response(inner: &Inner, query: Option<&str>) -> Response {
    let project = match single_param(param_values(query, "project")) {
        Ok(project) => project,
        Err(response) => return response,
    };
    let id = match single_param(param_values(query, "id")) {
        Ok(id) => id,
        Err(response) => return response,
    };
    let root = match single_param(param_values(query, "root")) {
        Ok(root) => root,
        Err(response) => return response,
    };
    let source = match single_param(param_values(query, "source")) {
        Ok(source) => source,
        Err(response) => return response,
    };
    let file = match single_param(param_values(query, "file")) {
        Ok(file) => file,
        Err(response) => return response,
    };
    let (Some(project), Some(id)) = (
        project.filter(|v| !v.is_empty()),
        id.filter(|v| !v.is_empty()),
    ) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "ok": false, "error": "project + id required" })),
        )
            .into_response();
    };
    let codex = source.as_deref() == Some("codex");
    let service = inner.transcript();
    let parsed = service.read(&project, &id, &ReadOptions { root, source, file });
    match parsed {
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(json!({ "ok": false, "error": "not found" })),
        )
            .into_response(),
        Ok(Some(raw)) => {
            // Skill scopes live only in the registry: claude sessions key on the
            // agent id, codex threads on (thread uuid, transcript cwd).
            let scopes = if codex {
                inner
                    .host
                    .registry
                    .codex_thread_scopes(&id, meta_cwd(&raw).as_deref())
            } else {
                inner.host.registry.launch_scopes(&id)
            };
            raw_json(&with_scopes(&raw, scopes.as_deref()))
        }
        Err(error) => internal_error(&error.to_string()),
    }
}

fn search_response(inner: &Inner, query: Option<&str>) -> Response {
    let q = match single_param(param_values(query, "q")) {
        Ok(q) => q,
        // Node's array-valued `q` throws inside the adapter.
        Err(_) => return internal_error(SEARCH_ARRAY_MESSAGE),
    };
    let project = match single_param(param_values(query, "project")) {
        Ok(project) => project,
        Err(response) => return response,
    };
    let id = match single_param(param_values(query, "id")) {
        Ok(id) => id,
        Err(response) => return response,
    };
    let root = match single_param(param_values(query, "root")) {
        Ok(root) => root,
        Err(response) => return response,
    };
    let hide_reviews = hide_reviews(query);
    // `if (!q) return { results: [], capped: false }` — the same response the
    // service produces for an empty query.
    let units = q
        .map(|q| q.encode_utf16().collect::<Vec<_>>())
        .unwrap_or_default();
    match service_search(inner, &units, root, project, id, hide_reviews) {
        Ok(response) => Json(response).into_response(),
        Err(error) => internal_error(&error.to_string()),
    }
}

fn service_search(
    inner: &Inner,
    units: &[u16],
    root: Option<String>,
    project: Option<String>,
    id: Option<String>,
    hide_reviews: bool,
) -> Result<crate::transcript_service::SearchResponse, crate::transcript_service::Error> {
    inner.transcript().search_units(
        units,
        &SearchOptions {
            root,
            project,
            id,
            hide_reviews,
        },
    )
}

fn stats_response(inner: &Inner, body: &RawBody) -> Response {
    let object = body.value.as_object();
    let items = object
        .and_then(|object| object.get("items"))
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    // `root` is optional; `null` behaves like absent, any other non-string value
    // fails the bridge's typed request.
    let root = match object.and_then(|object| object.get("root")) {
        None | Some(Value::Null) => None,
        Some(Value::String(root)) => Some(root.clone()),
        Some(_) => return internal_error(SEQUENCE_MESSAGE),
    };
    let host = &inner.host;
    let base = StatsRequest {
        stats_claude_home: Some(path_string(&host.claude_home)),
        stats_codex_home: Some(path_string(&host.codex_home)),
        stats_usage_state: Some(path_string(&host.usage_state)),
        stats_state_dir: Some(path_string(&host.state_dir)),
        stats_root: root,
        ..StatsRequest::default()
    };
    let mut service = inner
        .stats
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let mut map = StatsMap::default();
    for item in items.iter().take(STATS_ITEM_CAP) {
        let Some(item) = item.as_object() else {
            continue;
        };
        let (Some(project), Some(id)) = (item.get("project"), item.get("id")) else {
            continue;
        };
        if !js_truthy(project) || !js_truthy(id) {
            continue;
        }
        let (Value::String(project), Value::String(id)) = (project, id) else {
            return internal_error(SEQUENCE_MESSAGE);
        };
        let request = StatsRequest {
            stats_project: Some(project.clone()),
            stats_id: Some(id.clone()),
            ..base.clone()
        };
        match service.dispatch("transcript_stats", &request) {
            ResponseBody::Raw(raw) => map.insert(id.clone(), raw),
            ResponseBody::Value(error) => {
                return internal_error(error["error"].as_str().unwrap_or(BAD_INPUTS_MESSAGE));
            }
        }
    }
    Json(StatsReply { stats: map }).into_response()
}

#[derive(Serialize)]
struct RootReply<'a> {
    root: &'a str,
}

#[derive(Serialize)]
struct RootSetReply<'a> {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    root: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<&'a str>,
}

#[derive(Serialize)]
struct SessionsReply {
    sessions: Vec<SessionRow>,
}

#[derive(Serialize)]
struct CodexThreadReply<'a> {
    ok: bool,
    #[serde(rename = "threadId", skip_serializing_if = "Option::is_none")]
    thread_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<&'a str>,
}

#[derive(Serialize)]
struct StatsReply {
    stats: StatsMap,
}

/// `stats[it.id] = entry` in JavaScript object key order: array-index keys first
/// in ascending numeric order, then the remaining keys in insertion order. A
/// repeated id keeps its first position and last value.
#[derive(Default)]
struct StatsMap {
    entries: Vec<(String, Box<RawValue>)>,
}

impl StatsMap {
    fn insert(&mut self, id: String, value: Box<RawValue>) {
        match self.entries.iter_mut().find(|(key, _)| key == &id) {
            Some(slot) => slot.1 = value,
            None => self.entries.push((id, value)),
        }
    }
}

impl Serialize for StatsMap {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut indexed = self
            .entries
            .iter()
            .enumerate()
            .filter_map(|(position, (key, _))| array_index(key).map(|index| (index, position)))
            .collect::<Vec<_>>();
        indexed.sort_by_key(|(index, _)| *index);
        let mut map = serializer.serialize_map(Some(self.entries.len()))?;
        for (_, position) in indexed {
            let (key, value) = &self.entries[position];
            map.serialize_entry(key, value)?;
        }
        for (key, value) in &self.entries {
            if array_index(key).is_none() {
                map.serialize_entry(key, value)?;
            }
        }
        map.end()
    }
}

/// A canonical JavaScript array-index property key (`0`..=`4294967294`).
fn array_index(key: &str) -> Option<u32> {
    if key.is_empty() || key.len() > 10 || !key.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    if key.len() > 1 && key.starts_with('0') {
        return None;
    }
    let index = key.parse::<u32>().ok()?;
    (index != u32::MAX).then_some(index)
}

/// `req.body?.root` for the Node handler: only an object's `root` string counts.
fn root_member(body: &RawBody) -> Option<String> {
    body.value
        .as_object()
        .and_then(|object| object.get("root"))
        .and_then(Value::as_str)
        .map(str::to_owned)
}

fn bad_root() -> RootSetReply<'static> {
    RootSetReply {
        ok: false,
        root: None,
        error: Some("bad root"),
    }
}

fn codex_reply(status: StatusCode, thread_id: Option<&str>, error: Option<&str>) -> Response {
    (
        status,
        Json(CodexThreadReply {
            ok: error.is_none(),
            thread_id,
            error,
        }),
    )
        .into_response()
}

fn param_values(query: Option<&str>, name: &str) -> Vec<String> {
    query
        .map(|query| query_values(query, name))
        .unwrap_or_default()
}

/// `req.query.hideReviews === '1'`: a repeated key is an array, so it is false.
fn hide_reviews(query: Option<&str>) -> bool {
    let values = param_values(query, "hideReviews");
    values.len() == 1 && values[0] == "1"
}

/// Fastify hands a repeated query key to the handler as an array; Node forwards it
/// to the typed bridge, which rejects the request.
fn single_param(values: Vec<String>) -> Result<Option<String>, Response> {
    match values.len() {
        0 => Ok(None),
        1 => Ok(values.into_iter().next()),
        _ => Err(internal_error(SEQUENCE_MESSAGE)),
    }
}

/// `Number(req.query.cap) || 5000` followed by the bridge's `usize` boundary:
/// zero and `NaN` fall back to the default, and anything else that is not a
/// non-negative integer the bridge can hold answers 500.
fn cap_param(values: Vec<String>) -> Result<usize, Response> {
    let value = match values.len() {
        0 => 0.0,
        1 => js_number(&values[0]),
        // `Number(['a','b'])` stringifies to `a,b`, which is not a number.
        _ => 0.0,
    };
    let cap = if value == 0.0 || value.is_nan() {
        DEFAULT_CAP
    } else {
        value
    };
    if cap.is_finite() && cap >= 0.0 && cap.fract() == 0.0 && cap <= usize::MAX as f64 {
        Ok(cap as usize)
    } else {
        Err(internal_error(CAP_MESSAGE))
    }
}

/// JavaScript `Number(string)` for the shapes a query string can carry: trimmed,
/// empty is `0`, `0x`/`0o`/`0b` prefixes and the `Infinity` spellings. Rust also
/// accepts `inf`/`NaN`/digit separators, which JS rejects; those stay a documented
/// gap because a real client never sends them.
fn js_number(text: &str) -> f64 {
    let trimmed = text.trim_matches(is_js_space);
    if trimmed.is_empty() {
        return 0.0;
    }
    let (sign, digits) = match trimmed.strip_prefix('-') {
        Some(rest) => (-1.0, rest),
        None => (1.0, trimmed.strip_prefix('+').unwrap_or(trimmed)),
    };
    if digits.eq_ignore_ascii_case("infinity") {
        return sign * f64::INFINITY;
    }
    for (prefix, radix) in [("0x", 16), ("0o", 8), ("0b", 2)] {
        if let Some(rest) = digits
            .strip_prefix(prefix)
            .or_else(|| digits.strip_prefix(&prefix.to_uppercase()))
        {
            return u64::from_str_radix(rest, radix)
                .map(|value| sign * value as f64)
                .unwrap_or(f64::NAN);
        }
    }
    digits
        .parse::<f64>()
        .map(|value| sign * value)
        .unwrap_or(f64::NAN)
}

fn is_js_space(character: char) -> bool {
    character.is_whitespace() || character == '\u{FEFF}'
}

/// `updateRunning` (`server/sessions.mjs:86-91`): `isLive(agentId ?? id)` or an
/// mtime inside `RUNNING_MS`, applied to the row and every nested subagent.
fn apply_liveness(rows: &mut [SessionRow], now: u64, registry: &dyn TranscriptRegistry) {
    for row in rows {
        let agent_id = row.agent_id.clone();
        row.running =
            registry.is_live(agent_id.as_deref().unwrap_or(&row.id)) || running_now(now, row.mtime);
        for child in &mut row.subagents {
            let agent_id = child.agent_id.clone();
            child.running = registry.is_live(&agent_id) || running_now(now, child.mtime);
        }
    }
}

fn running_now(now: u64, mtime: f64) -> bool {
    now as f64 - mtime < RUNNING_MS
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis().min(u64::MAX as u128) as u64)
        .unwrap_or(0)
}

/// The parser's document, kept as raw tokens so a transcript holding escaped lone
/// surrogates can be rebuilt without a lossy `Value` hop.
#[derive(serde::Deserialize)]
struct Document {
    meta: Box<RawValue>,
    messages: Box<RawValue>,
}

/// `r.meta.scopes = lc.scopes` (`server/transcript-routes.mjs:26`). Appending
/// inside the existing `meta` object keeps the parser's bytes and puts `scopes`
/// last, which is where JavaScript's insertion order leaves it.
fn with_scopes(raw: &str, scopes: Option<&[String]>) -> String {
    let Some(scopes) = scopes.filter(|scopes| !scopes.is_empty()) else {
        return raw.to_owned();
    };
    let Ok(document) = serde_json::from_str::<Document>(raw) else {
        return raw.to_owned();
    };
    let meta = document.meta.get();
    let Some(fields) = meta.strip_suffix('}') else {
        return raw.to_owned();
    };
    let Ok(scopes_json) = serde_json::to_string(scopes) else {
        return raw.to_owned();
    };
    let mut out = String::with_capacity(raw.len() + scopes_json.len() + 16);
    out.push_str("{\"meta\":");
    out.push_str(fields);
    if !fields.trim_end().ends_with('{') {
        out.push(',');
    }
    out.push_str("\"scopes\":");
    out.push_str(&scopes_json);
    out.push_str("},\"messages\":");
    out.push_str(document.messages.get());
    out.push('}');
    out
}

/// `r.meta?.cwd`, as the codex scope lookup needs it. Only a JSON string counts;
/// Node would throw for any other truthy value and the route has no scopes then.
fn meta_cwd(raw: &str) -> Option<String> {
    let document = serde_json::from_str::<Document>(raw).ok()?;
    let fields = crate::wiki_root::raw_fields(document.meta.get())
        .ok()
        .flatten()?;
    let key = "cwd".encode_utf16().collect::<Vec<_>>();
    let token = fields.into_iter().rev().find(|(field, _)| field == &key)?.1;
    serde_json::from_str::<String>(token.get()).ok()
}

fn raw_json(text: &str) -> Response {
    match RawValue::from_string(text.to_owned()) {
        Ok(raw) => Json(raw).into_response(),
        Err(_) => internal_error("Internal Server Error"),
    }
}

fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(value) => value.as_f64() != Some(0.0),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

fn path_string(path: &std::path::Path) -> String {
    path.to_string_lossy().into_owned()
}

fn internal_error(message: &str) -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({
            "statusCode": 500,
            "error": "Internal Server Error",
            "message": message,
        })),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::{
        CAP_MESSAGE, SEARCH_ARRAY_MESSAGE, SEQUENCE_MESSAGE, TranscriptHost, TranscriptRegistry,
        codex_thread, list, read, root_get, root_put, search, stats,
    };
    use axum::body::{Body, to_bytes};
    use axum::extract::{RawQuery, State};
    use axum::http::{Method, Request, header};
    use axum::response::Response;
    use serde_json::{Value, json};
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    static FIXTURE_ID: AtomicU64 = AtomicU64::new(0);

    #[derive(Default)]
    struct StubRegistry {
        live: Vec<&'static str>,
        threads: Vec<(&'static str, &'static str)>,
        scopes: Vec<(&'static str, Vec<&'static str>)>,
        codex_scopes: Vec<(&'static str, Vec<&'static str>)>,
    }

    impl TranscriptRegistry for StubRegistry {
        fn is_live(&self, agent_id: &str) -> bool {
            self.live.contains(&agent_id)
        }
        fn codex_thread_for(&self, agent_id: &str) -> Option<String> {
            self.threads
                .iter()
                .find(|(id, _)| *id == agent_id)
                .map(|(_, thread)| (*thread).to_owned())
        }
        fn launch_scopes(&self, agent_id: &str) -> Option<Vec<String>> {
            self.scopes
                .iter()
                .find(|(id, _)| *id == agent_id)
                .map(|(_, scopes)| scopes.iter().map(|scope| (*scope).to_owned()).collect())
        }
        fn codex_thread_scopes(&self, thread_id: &str, _cwd: Option<&str>) -> Option<Vec<String>> {
            self.codex_scopes
                .iter()
                .find(|(id, _)| *id == thread_id)
                .map(|(_, scopes)| scopes.iter().map(|scope| (*scope).to_owned()).collect())
        }
    }

    struct Fixture(PathBuf);

    impl Fixture {
        fn new() -> Self {
            let unique = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let id = FIXTURE_ID.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "http-transcripts-{}-{unique}-{id}",
                std::process::id()
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        fn path(&self, parts: &[&str]) -> PathBuf {
            let mut path = self.0.clone();
            for part in parts {
                path.push(part);
            }
            path
        }

        fn write(&self, parts: &[&str], contents: &str) -> PathBuf {
            let path = self.path(parts);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, contents).unwrap();
            path
        }

        fn transcript(&self, project: &str, id: &str, contents: &str) {
            self.write(&["root", project, &format!("{id}.jsonl")], contents);
        }

        fn host(&self, registry: StubRegistry) -> TranscriptHost {
            TranscriptHost {
                state_dir: self.path(&["state"]),
                claude_home: self.path(&["home"]),
                codex_home: self.path(&["codex"]),
                usage_state: self.path(&["usage"]),
                model_catalog: Arc::new(Vec::new),
                registry: Arc::new(registry),
            }
        }

        fn root(&self) -> String {
            self.path(&["root"]).to_string_lossy().into_owned()
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn inner(host: TranscriptHost) -> Arc<super::Inner> {
        Arc::new(super::Inner {
            host,
            service: Mutex::new(None),
            stats: Mutex::new(super::StatsService::default()),
        })
    }

    fn run<F: std::future::Future>(future: F) -> F::Output {
        tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(future)
    }

    async fn collect(response: Response) -> (u16, String) {
        let status = response.status().as_u16();
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        (status, String::from_utf8(bytes.to_vec()).unwrap())
    }

    /// Percent-encode a fixture path for a raw query string; `+` must not survive
    /// because the decoder reads it as a space.
    fn encode(value: &str) -> String {
        let mut out = String::new();
        for byte in value.bytes() {
            if byte.is_ascii_alphanumeric()
                || matches!(byte, b'-' | b'_' | b'.' | b'~' | b'/' | b':')
            {
                out.push(byte as char);
            } else {
                out.push_str(&format!("%{byte:02X}"));
            }
        }
        out
    }

    fn old_file(path: &std::path::Path, age_secs: u64) {
        let when = SystemTime::now() - Duration::from_secs(age_secs);
        fs::File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(when))
            .unwrap();
    }

    async fn send_root_get(state: &Arc<super::Inner>) -> (u16, String) {
        collect(root_get(State(state.clone())).await).await
    }

    async fn send_root_put(
        state: &Arc<super::Inner>,
        content_type: Option<&str>,
        body: &str,
    ) -> (u16, String) {
        let mut builder = Request::builder()
            .method(Method::PUT)
            .uri("/api/transcripts/root");
        if let Some(content_type) = content_type {
            builder = builder.header(header::CONTENT_TYPE, content_type);
        }
        let request = builder.body(Body::from(body.to_owned())).unwrap();
        collect(root_put(State(state.clone()), request).await).await
    }

    async fn send_list(state: &Arc<super::Inner>, query: Option<&str>) -> (u16, String) {
        let query = RawQuery(query.map(str::to_owned));
        collect(list(State(state.clone()), query).await).await
    }

    async fn send_codex_thread(state: &Arc<super::Inner>, query: Option<&str>) -> (u16, String) {
        let query = RawQuery(query.map(str::to_owned));
        collect(codex_thread(State(state.clone()), query).await).await
    }

    async fn send_read(state: &Arc<super::Inner>, query: Option<&str>) -> (u16, String) {
        let query = RawQuery(query.map(str::to_owned));
        collect(read(State(state.clone()), query).await).await
    }

    async fn send_search(state: &Arc<super::Inner>, query: Option<&str>) -> (u16, String) {
        let query = RawQuery(query.map(str::to_owned));
        collect(search(State(state.clone()), query).await).await
    }

    async fn send_stats(
        state: &Arc<super::Inner>,
        content_type: Option<&str>,
        body: &str,
    ) -> (u16, String) {
        let mut builder = Request::builder()
            .method(Method::POST)
            .uri("/api/transcripts/stats");
        if let Some(content_type) = content_type {
            builder = builder.header(header::CONTENT_TYPE, content_type);
        }
        let request = builder.body(Body::from(body.to_owned())).unwrap();
        collect(stats(State(state.clone()), request).await).await
    }

    // VERIFY: transcripts-root-round-trip
    #[test]
    fn root_round_trip_and_setter_errors() {
        let fixture = Fixture::new();
        let state = inner(fixture.host(StubRegistry::default()));
        run(async {
            assert_eq!(
                send_root_get(&state).await,
                (200, r#"{"root":"~/.claude/projects"}"#.to_owned())
            );
            assert_eq!(
                send_root_put(&state, Some("application/json"), r#"{"root":"/chosen"}"#).await,
                (200, r#"{"ok":true,"root":"/chosen"}"#.to_owned())
            );
            assert_eq!(
                send_root_get(&state).await,
                (200, r#"{"root":"/chosen"}"#.to_owned())
            );
            for body in [
                r#"{"root":""}"#,
                r#"{"root":5}"#,
                r#"{"root":null}"#,
                "{}",
                "[]",
                r#""root""#,
            ] {
                assert_eq!(
                    send_root_put(&state, Some("application/json"), body).await,
                    (200, r#"{"ok":false,"error":"bad root"}"#.to_owned()),
                    "{body}"
                );
            }
            assert_eq!(
                send_root_put(&state, None, "").await,
                (200, r#"{"ok":false,"error":"bad root"}"#.to_owned())
            );
            let (status, response) = send_root_put(&state, Some("application/json"), "{").await;
            assert_eq!(status, 400);
            assert!(response.contains("FST_ERR_CTP_INVALID_JSON_BODY"));
        });

        // A state dir that is a file makes persistence fail; `setSessionsRoot`
        // turns that into 200 `{ok:false, error}` (`server/sessions.mjs:54-58`).
        let blocked = Fixture::new();
        fs::write(blocked.path(&["state"]), "x").unwrap();
        let state = inner(blocked.host(StubRegistry::default()));
        run(async {
            let (status, response) =
                send_root_put(&state, Some("application/json"), r#"{"root":"/chosen"}"#).await;
            assert_eq!(status, 200);
            let payload: Value = serde_json::from_str(&response).unwrap();
            assert_eq!(payload["ok"], json!(false));
            assert!(
                payload["error"]
                    .as_str()
                    .is_some_and(|error| !error.is_empty())
            );
        });
    }

    // VERIFY: transcripts-list-liveness
    #[test]
    fn list_serves_sessions_and_recomputes_registry_liveness() {
        let fixture = Fixture::new();
        fixture.transcript(
            "p",
            "one",
            "{\"type\":\"user\",\"cwd\":\"C:/work\",\"message\":{\"content\":\"first\"}}\n",
        );
        fixture.transcript(
            "p",
            "two",
            "{\"type\":\"user\",\"message\":{\"content\":\"second\"}}\n",
        );
        old_file(&fixture.path(&["root", "p", "one.jsonl"]), 120);
        old_file(&fixture.path(&["root", "p", "two.jsonl"]), 60);
        let state = inner(fixture.host(StubRegistry {
            live: vec!["one"],
            ..StubRegistry::default()
        }));
        let root = encode(&fixture.root());
        run(async {
            let (status, response) = send_list(&state, Some(&format!("root={root}"))).await;
            assert_eq!(status, 200);
            let payload: Value = serde_json::from_str(&response).unwrap();
            let sessions = payload["sessions"].as_array().unwrap();
            assert_eq!(sessions.len(), 2, "{response}");
            assert_eq!(sessions[0]["id"], json!("two"));
            assert_eq!(sessions[0]["running"], json!(false));
            assert_eq!(sessions[1]["id"], json!("one"));
            // Registry liveness wins over the 30s mtime window.
            assert_eq!(sessions[1]["running"], json!(true));
            assert_eq!(sessions[1]["blurb"], json!("first"));
            assert_eq!(sessions[1]["cwd"], json!("C:/work"));

            let (status, response) = send_list(&state, Some(&format!("root={root}&cap=1"))).await;
            assert_eq!(status, 200);
            let payload: Value = serde_json::from_str(&response).unwrap();
            assert_eq!(payload["sessions"].as_array().unwrap().len(), 1);

            // `Number(cap) || 5000`: zero falls back to the default.
            let (status, response) = send_list(&state, Some(&format!("root={root}&cap=0"))).await;
            assert_eq!(status, 200);
            let payload: Value = serde_json::from_str(&response).unwrap();
            assert_eq!(payload["sessions"].as_array().unwrap().len(), 2);

            // A negative or fractional cap cannot satisfy the bridge's `usize`.
            for cap in ["-5", "2.5", "1e30"] {
                let (status, response) =
                    send_list(&state, Some(&format!("root={root}&cap={cap}"))).await;
                assert_eq!(status, 500, "cap {cap}");
                assert_eq!(
                    serde_json::from_str::<Value>(&response).unwrap()["message"],
                    json!(CAP_MESSAGE)
                );
            }

            // A repeated key arrives as an array and fails the typed bridge request.
            let (status, response) =
                send_list(&state, Some(&format!("root={root}&root={root}"))).await;
            assert_eq!(status, 500);
            assert_eq!(
                serde_json::from_str::<Value>(&response).unwrap()["message"],
                json!(SEQUENCE_MESSAGE)
            );
        });

        // A root that is a file surfaces the filesystem error as a Fastify 500.
        let broken = Fixture::new();
        let not_a_directory = broken.path(&["not-a-directory"]);
        fs::write(&not_a_directory, "x").unwrap();
        let state = inner(broken.host(StubRegistry::default()));
        run(async {
            let (status, response) = send_list(
                &state,
                Some(&format!(
                    "root={}",
                    encode(not_a_directory.to_str().unwrap())
                )),
            )
            .await;
            assert_eq!(status, 500);
            let payload: Value = serde_json::from_str(&response).unwrap();
            assert_eq!(payload["statusCode"], json!(500));
            assert_eq!(payload["error"], json!("Internal Server Error"));
            assert!(
                payload["message"]
                    .as_str()
                    .is_some_and(|message| !message.is_empty())
            );
        });
    }

    // VERIFY: transcripts-codex-thread
    #[test]
    fn codex_thread_route_maps_registry_ids() {
        let fixture = Fixture::new();
        let state = inner(fixture.host(StubRegistry {
            threads: vec![("agent", "thread-uuid")],
            ..StubRegistry::default()
        }));
        run(async {
            for query in [None, Some("id="), Some("other=1")] {
                assert_eq!(
                    send_codex_thread(&state, query).await,
                    (400, r#"{"ok":false,"error":"id required"}"#.to_owned()),
                    "{query:?}"
                );
            }
            assert_eq!(
                send_codex_thread(&state, Some("id=unknown")).await,
                (404, r#"{"ok":false,"error":"not found"}"#.to_owned())
            );
            assert_eq!(
                send_codex_thread(&state, Some("id=agent")).await,
                (200, r#"{"ok":true,"threadId":"thread-uuid"}"#.to_owned())
            );
            // A repeated id is an array, which the registry cannot key.
            assert_eq!(
                send_codex_thread(&state, Some("id=agent&id=other")).await,
                (404, r#"{"ok":false,"error":"not found"}"#.to_owned())
            );
        });
    }

    // VERIFY: transcripts-read-scopes
    #[test]
    fn read_returns_parser_json_and_splices_registry_scopes() {
        const CODEX_ID: &str = "11111111-1111-4111-8111-111111111111";
        let fixture = Fixture::new();
        fixture.transcript(
            "p",
            "known",
            "{\"type\":\"user\",\"cwd\":\"C:/work\",\"message\":{\"content\":\"hello\"}}\n",
        );
        fixture.transcript(
            "p",
            "plain",
            "{\"type\":\"user\",\"message\":{\"content\":\"plain\"}}\n",
        );
        fixture.write(
            &[
                "codex",
                "sessions",
                &format!("rollout-2026-{CODEX_ID}.jsonl"),
            ],
            &format!(
                "{{\"type\":\"session_meta\",\"payload\":{{\"session_id\":\"{CODEX_ID}\",\"cwd\":\"C:/work\"}}}}\n{{\"type\":\"event_msg\",\"payload\":{{\"type\":\"user_message\",\"message\":\"codex hello\"}}}}\n"
            ),
        );
        let state = inner(fixture.host(StubRegistry {
            scopes: vec![("known", vec!["/scope"])],
            codex_scopes: vec![(CODEX_ID, vec!["/codex-scope"])],
            ..StubRegistry::default()
        }));
        let root = encode(&fixture.root());
        run(async {
            for query in [
                "id=known".to_owned(),
                "project=p".to_owned(),
                "project=&id=known".to_owned(),
            ] {
                assert_eq!(
                    send_read(&state, Some(&query)).await,
                    (
                        400,
                        r#"{"ok":false,"error":"project + id required"}"#.to_owned()
                    ),
                    "{query}"
                );
            }
            assert_eq!(
                send_read(&state, Some(&format!("project=p&id=missing&root={root}"))).await,
                (404, r#"{"ok":false,"error":"not found"}"#.to_owned())
            );

            let (status, response) =
                send_read(&state, Some(&format!("project=p&id=known&root={root}"))).await;
            assert_eq!(status, 200);
            let payload: Value = serde_json::from_str(&response).unwrap();
            assert_eq!(payload["meta"]["scopes"], json!(["/scope"]));
            assert_eq!(payload["messages"][0]["text"], json!("hello"));
            // The scope token is appended inside `meta`, keeping the parser's bytes.
            assert!(
                response.contains(r#""scopes":["/scope"]},"messages":"#),
                "{response}"
            );

            let (status, response) =
                send_read(&state, Some(&format!("project=p&id=plain&root={root}"))).await;
            assert_eq!(status, 200);
            assert!(!response.contains("scopes"), "{response}");

            let (status, response) = send_read(
                &state,
                Some(&format!("project=%3Ccodex%3E&id={CODEX_ID}&source=codex")),
            )
            .await;
            assert_eq!(status, 200, "{response}");
            let payload: Value = serde_json::from_str(&response).unwrap();
            assert_eq!(payload["meta"]["scopes"], json!(["/codex-scope"]));
            assert_eq!(payload["messages"][0]["text"], json!("codex hello"));
        });

        // A root that is a file surfaces the filesystem error as a Fastify 500.
        let broken = Fixture::new();
        let not_a_directory = broken.path(&["not-a-directory"]);
        fs::write(&not_a_directory, "x").unwrap();
        let state = inner(broken.host(StubRegistry::default()));
        run(async {
            let (status, response) = send_read(
                &state,
                Some(&format!(
                    "project=p&id=known&root={}",
                    encode(not_a_directory.to_str().unwrap())
                )),
            )
            .await;
            assert_eq!(status, 500);
            assert_eq!(
                serde_json::from_str::<Value>(&response).unwrap()["statusCode"],
                json!(500)
            );
        });
    }

    // VERIFY: transcripts-search-units
    #[test]
    fn search_uses_utf16_units_and_reports_array_parameters() {
        let fixture = Fixture::new();
        fixture.transcript(
            "p",
            "hit",
            "{\"type\":\"user\",\"message\":{\"content\":\"needle\"}}\n",
        );
        let state = inner(fixture.host(StubRegistry::default()));
        let root = encode(&fixture.root());
        run(async {
            let (status, response) =
                send_search(&state, Some(&format!("q=needle&root={root}"))).await;
            assert_eq!(status, 200);
            let payload: Value = serde_json::from_str(&response).unwrap();
            assert_eq!(payload["capped"], json!(false));
            let results = payload["results"].as_array().unwrap();
            assert_eq!(results.len(), 1, "{response}");
            assert_eq!(results[0]["id"], json!("hit"));
            assert_eq!(results[0]["role"], json!("user"));
            assert_eq!(results[0]["snippet"], json!("needle"));

            // A missing or empty query short-circuits without scanning.
            for query in [format!("root={root}"), format!("q=&root={root}")] {
                assert_eq!(
                    send_search(&state, Some(&query)).await,
                    (200, r#"{"results":[],"capped":false}"#.to_owned()),
                    "{query}"
                );
            }

            // An array-valued `q` throws in the Node adapter.
            let (status, response) =
                send_search(&state, Some(&format!("q=a&q=b&root={root}"))).await;
            assert_eq!(status, 500);
            assert_eq!(
                serde_json::from_str::<Value>(&response).unwrap()["message"],
                json!(SEARCH_ARRAY_MESSAGE)
            );

            let (status, response) =
                send_search(&state, Some(&format!("q=a&root={root}&root={root}"))).await;
            assert_eq!(status, 500);
            assert_eq!(
                serde_json::from_str::<Value>(&response).unwrap()["message"],
                json!(SEQUENCE_MESSAGE)
            );
        });
    }

    // VERIFY: transcripts-stats-batch
    #[test]
    fn stats_batches_items_in_javascript_key_order() {
        let fixture = Fixture::new();
        fixture.transcript(
            "p",
            "100",
            "{\"type\":\"user\",\"message\":{\"content\":\"a\"}}\n",
        );
        fixture.transcript(
            "p",
            "2",
            "{\"type\":\"user\",\"message\":{\"content\":\"b\"}}\n",
        );
        let state = inner(fixture.host(StubRegistry::default()));
        let root = serde_json::to_string(&fixture.root()).unwrap();
        run(async {
            let body = format!(
                r#"{{"root":{root},"items":[{{"project":"p","id":"100"}},{{"project":"p","id":"2"}},{{"project":"p","id":"missing"}},{{"project":"","id":"skipped"}},{{"id":"noproject"}},7]}}"#
            );
            let (status, response) = send_stats(&state, Some("application/json"), &body).await;
            assert_eq!(status, 200, "{response}");
            let payload: Value = serde_json::from_str(&response).unwrap();
            let stats = payload["stats"].as_object().unwrap();
            assert_eq!(stats.len(), 3, "{response}");
            assert_eq!(stats["100"]["exists"], json!(true));
            assert_eq!(stats["2"]["exists"], json!(true));
            assert_eq!(stats["missing"]["exists"], json!(false));
            // JavaScript emits array-index keys ascending, before the other keys.
            assert!(response.find(r#""2":"#).unwrap() < response.find(r#""100":"#).unwrap());
            assert!(response.find(r#""100":"#).unwrap() < response.find(r#""missing":"#).unwrap());

            // A non-array `items` yields an empty map.
            assert_eq!(
                send_stats(&state, Some("application/json"), r#"{"items":"nope"}"#).await,
                (200, r#"{"stats":{}}"#.to_owned())
            );
            assert_eq!(
                send_stats(&state, None, "").await,
                (200, r#"{"stats":{}}"#.to_owned())
            );

            // The batch is capped at 200 items.
            let items = (0..205)
                .map(|index| format!(r#"{{"project":"p","id":"i{index}"}}"#))
                .collect::<Vec<_>>()
                .join(",");
            let (status, response) = send_stats(
                &state,
                Some("application/json"),
                &format!(r#"{{"items":[{items}]}}"#),
            )
            .await;
            assert_eq!(status, 200);
            assert_eq!(
                serde_json::from_str::<Value>(&response).unwrap()["stats"]
                    .as_object()
                    .unwrap()
                    .len(),
                200
            );

            // A repeated id keeps its first position and last value.
            let (status, response) = send_stats(
                &state,
                Some("application/json"),
                r#"{"items":[{"project":"p","id":"dup"},{"project":"p","id":"dup"}]}"#,
            )
            .await;
            assert_eq!(status, 200);
            assert_eq!(
                serde_json::from_str::<Value>(&response).unwrap()["stats"]
                    .as_object()
                    .unwrap()
                    .len(),
                1
            );

            // Non-string inputs cannot satisfy the bridge's typed request.
            for body in [
                r#"{"root":5}"#,
                r#"{"items":[{"project":5,"id":"x"}]}"#,
                r#"{"items":[{"project":"p","id":5}]}"#,
            ] {
                let (status, response) = send_stats(&state, Some("application/json"), body).await;
                assert_eq!(status, 500, "{body}");
                assert_eq!(
                    serde_json::from_str::<Value>(&response).unwrap()["message"],
                    json!(SEQUENCE_MESSAGE)
                );
            }
        });
    }

    // VERIFY: transcripts-scope-splice
    #[test]
    fn scope_splice_keeps_parser_bytes_and_escaped_surrogates() {
        let raw = r#"{"meta":{"cwd":"\ud800","title":"x"},"messages":[{"text":"\udfff"}]}"#;
        assert_eq!(
            super::with_scopes(raw, Some(&["/s".to_owned()])),
            r#"{"meta":{"cwd":"\ud800","title":"x","scopes":["/s"]},"messages":[{"text":"\udfff"}]}"#
        );
        assert_eq!(
            super::with_scopes(r#"{"meta":{},"messages":[]}"#, Some(&["/s".to_owned()])),
            r#"{"meta":{"scopes":["/s"]},"messages":[]}"#
        );
        // Without scopes the parser's bytes pass through untouched.
        assert_eq!(super::with_scopes(raw, None), raw);
        assert_eq!(super::with_scopes(raw, Some(&[])), raw);
    }

    // VERIFY: transcripts-meta-cwd
    #[test]
    fn meta_cwd_reads_only_a_json_string() {
        assert_eq!(
            super::meta_cwd(r#"{"meta":{"cwd":"C:/work"},"messages":[]}"#).as_deref(),
            Some("C:/work")
        );
        assert_eq!(super::meta_cwd(r#"{"meta":{},"messages":[]}"#), None);
        assert_eq!(
            super::meta_cwd(r#"{"meta":{"cwd":null},"messages":[]}"#),
            None
        );
        assert_eq!(super::meta_cwd(r#"{"meta":{"cwd":7},"messages":[]}"#), None);
    }

    // VERIFY: transcripts-cap-coercion
    #[test]
    fn cap_and_number_coercion_follow_javascript() {
        assert_eq!(super::cap_param(vec![]).ok(), Some(5000));
        assert_eq!(super::cap_param(vec!["12".to_owned()]).ok(), Some(12));
        // `Number(...) || 5000`: empty and non-numeric fall back to the default.
        assert_eq!(super::cap_param(vec![String::new()]).ok(), Some(5000));
        assert_eq!(super::cap_param(vec!["abc".to_owned()]).ok(), Some(5000));
        assert_eq!(super::cap_param(vec![" 7 ".to_owned()]).ok(), Some(7));
        assert_eq!(super::cap_param(vec!["0x10".to_owned()]).ok(), Some(16));
        // A repeated key becomes an array, so `Number` yields NaN.
        assert_eq!(
            super::cap_param(vec!["12".to_owned(), "13".to_owned()]).ok(),
            Some(5000)
        );
        assert_eq!(super::js_number("1e3"), 1000.0);
        assert_eq!(super::js_number("-Infinity"), f64::NEG_INFINITY);
        assert!(super::js_number("nope").is_nan());
    }
}
