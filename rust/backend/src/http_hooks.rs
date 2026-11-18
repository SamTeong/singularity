//! Hooks editor HTTP surface: `GET`/`PUT /api/hooks/roots`, `POST /api/hooks/list`,
//! `POST /api/hooks/search`, `GET`/`PUT /api/hooks/file`, mirroring
//! `server/index.mjs:642-662` -> `server/hooks.mjs` plus the Node bridge wrappers in
//! `server/rust-backend.mjs` (`hooksList` 692, `hooksSearch` 698, `hooksRead` 705,
//! `hooksWrite` 711).
//!
//! The host injects the state dir (`SINGULARITY_HOME/state`), home, cwd, Node's
//! per-drive cwd values, the backups dir, one locale id and two locks; this module
//! reads no process env. `lock` serializes the persisted root file, and `file_lock`
//! stands in for the single Node->Rust bridge queue that serializes hook list,
//! search, read and write. Pass the same `file_lock` to `http_rules::router` to
//! mirror that one queue for both families.
//!
//! Parity contract:
//!   * Roots live in `hook-roots.json` under the state dir; `picker_roots` gives the
//!     default `["~"]`, the 50-entry cap and the dedupe-by-UTF-16 order.
//!   * A scan pair is `{root: <verbatim client cwd>, dir: <cwd>/.claude/hooks}`, and
//!     the walk/search are `hooks_read`'s. Node's `localeCompare` sorts are
//!     reproduced with ICU4X (list by `rel`, search by `path`), and each search
//!     snippet is `trim()`ed then sliced to 200 UTF-16 units.
//!   * The path guard resolves first (`~` is never expanded for a target) and then
//!     requires containment under one configured root's `<root>/.claude/hooks`.
//!   * PUT order matches `writeHook`: guard -> pre-backup mtime guard -> best-effort
//!     backup -> post-backup guard -> `typeof content` -> `hooks_write::write_file`.
//!     Only the exact error `changed on disk` is a 409.
//!
//! Parity limits, reported rather than approximated:
//!   * A relative or empty client `cwd` reaches the filesystem as the resolved
//!     absolute `<cwd>/.claude/hooks` (Node's `join` keeps it relative), so the
//!     `path` members would be absolute where Node's are relative.
//!   * A field whose JSON token holds an escaped lone surrogate cannot cross the
//!     Node->Rust bridge; such a write is rejected with the bridge's own message
//!     (`hook write failed`) instead of reproducing the bridge teardown.
//!   * Filesystem failure text is Rust's `io::Error` text, not Node's `e.message`.
//!   * Replies keep each stored root token's original spelling, while Node
//!     re-serializes the parsed array (escapes, inner whitespace and hand-edited
//!     numbers such as `1e999` can differ in bytes).
use crate::http_body::{RawBody, parse_raw};
use crate::http_policy::query_values;
use crate::picker_roots::SetRootsResult;
use crate::transcripts::TranscriptRawText;
use crate::wiki_root::{raw_fields, resolve_units};
use axum::body::Body;
use axum::extract::{RawQuery, State};
use axum::http::{Request, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use icu_collator::{Collator, options::CollatorOptions};
use icu_locale_core::Locale;
use serde_json::value::RawValue;
use serde_json::{Value, json};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

const HOOK_ROOTS_FILE: &str = "hook-roots.json";
const HOOKS_SUBDIR: &str = ".claude/hooks";
const SEARCH_SLICE: usize = 200;
// `picker_roots::get_roots` answers this array when the file is absent, empty,
// unreadable or not a JSON array; here it only backs an unreachable fallback.
const DEFAULT_ROOTS_ARRAY: &str = "[\"~\"]";
const FILTER_ERROR: &str = "(roots || []).filter is not a function";
const MAP_ERROR: &str = "(roots || []).map is not a function";
const REQUIRED: &str = "path + content required";
const BAD_PATH: &str = "bad path";
const CHANGED: &str = "changed on disk";
const CONTENT_TYPE_ERROR: &str = "content must be a string";
const WRITE_FAILED: &str = "hook write failed";

// VERIFY: hooks-roots-persist
/// `resolve`/`contains` helpers shared with `http_rules`, plus the roots routes both
/// families use; the hooks half of `server/hooks.mjs` keeps this file's defaults.
#[derive(Clone)]
pub(crate) struct PathEnv {
    home: PathBuf,
    cwd: PathBuf,
    drive_cwds: Vec<(u16, PathBuf)>,
}

impl PathEnv {
    pub(crate) fn new(home: PathBuf, cwd: PathBuf, drive_cwds: Vec<(u16, PathBuf)>) -> Self {
        Self {
            home,
            cwd,
            drive_cwds,
        }
    }

    /// `path.resolve` over UTF-16 units: `~` is expanded only when `expand_tilde`
    /// asks for it, because `resolveRoot` expands roots while targets never do.
    pub(crate) fn resolve(&self, units: &[u16], expand_tilde: bool) -> Vec<u16> {
        resolve_units(
            units,
            &self.home,
            &self.cwd,
            &self.drive_cwds,
            cfg!(windows),
            expand_tilde,
        )
    }

    /// `resolve(join(base, sub))`: the scan dir handed to `hooks_read`/`rules`.
    pub(crate) fn joined(&self, base: &[u16], sub: &str) -> Vec<u16> {
        self.child(&self.resolve(base, false), sub)
    }

    /// `resolve(join(resolveRoot(raw), sub))`: the editor dir for a picked root.
    /// `resolveRoot` answers null for a falsy root, which drops the pair.
    pub(crate) fn base_dir(&self, raw: &[u16], sub: &str) -> Option<Vec<u16>> {
        (!raw.is_empty()).then(|| self.child(&self.resolve(raw, true), sub))
    }

    fn child(&self, base: &[u16], sub: &str) -> Vec<u16> {
        let separator = std::path::MAIN_SEPARATOR as u16;
        let mut joined = Vec::with_capacity(base.len() + sub.len() + 1);
        joined.extend_from_slice(base);
        if joined.last() != Some(&separator) {
            joined.push(separator);
        }
        joined.extend(sub.encode_utf16());
        self.resolve(&joined, false)
    }

    /// `guard(path)` from `server/hooks.mjs:32-40` and `isRulePath`'s containment
    /// half: resolve the target, then require `abs === dir || abs.startsWith(dir + sep)`
    /// for one configured root's `sub` dir. Returns the resolved units on success.
    pub(crate) fn inside(&self, roots_json: &str, target: &[u16], sub: &str) -> Option<Vec<u16>> {
        let abs = self.resolve(target, false);
        let separator = std::path::MAIN_SEPARATOR as u16;
        root_units(roots_json)
            .iter()
            .filter_map(|raw| self.base_dir(raw, sub))
            .any(|dir| {
                let mut prefixed = dir.clone();
                prefixed.push(separator);
                abs == dir || abs.starts_with(&prefixed)
            })
            .then_some(abs)
    }
}

/// The persisted root array as UTF-16 tokens; non-string members are skipped, which
/// differs from Node only for a hand-edited file (there every `resolveRoot` throws).
pub(crate) fn root_units(roots_json: &str) -> Vec<Vec<u16>> {
    serde_json::from_str::<Vec<Box<RawValue>>>(roots_json)
        .map(|tokens| {
            tokens
                .iter()
                .filter_map(|token| {
                    TranscriptRawText::from_json_token(token.get().to_owned())
                        .ok()?
                        .units()
                        .ok()
                })
                .filter(|units| !units.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

#[derive(Clone)]
struct Roots {
    path: PathBuf,
    // Shared with the file routes so root reads and writes cannot interleave.
    lock: Arc<Mutex<()>>,
}

// VERIFY: hooks-roots-route
/// `/api/hooks/roots` and `/api/rules/roots` share one handler pair; only the state
/// file (and so the route) differs.
pub(crate) fn roots_router(
    route: &'static str,
    file: &'static str,
    state_dir: PathBuf,
    lock: Arc<Mutex<()>>,
) -> Router {
    Router::new()
        .route(route, get(get_roots).put(put_roots))
        .with_state(Roots {
            path: state_dir.join(file),
            lock,
        })
}

async fn get_roots(State(state): State<Roots>) -> Response {
    let result = tokio::task::spawn_blocking(move || {
        let _guard = state.lock.lock().unwrap_or_else(|error| error.into_inner());
        crate::picker_roots::get_roots(&state.path)
    })
    .await;
    match result {
        Ok(roots_json) => {
            let roots = stored_array(&roots_json);
            Json(RootsReply { roots: &roots }).into_response()
        }
        Err(_) => internal_error(),
    }
}

async fn put_roots(State(state): State<Roots>, request: Request<Body>) -> Response {
    let body = match parse_raw(request).await {
        Ok(body) => body,
        Err(response) => return response,
    };
    let roots_json = match roots_member(&body) {
        Ok(roots_json) => roots_json,
        Err(()) => return type_error(FILTER_ERROR),
    };
    let result = tokio::task::spawn_blocking(move || {
        let _guard = state.lock.lock().unwrap_or_else(|error| error.into_inner());
        crate::picker_roots::set_roots(&state.path, &roots_json)
    })
    .await;
    match result {
        Ok(SetRootsResult::Success { roots_json }) => {
            let roots = stored_array(&roots_json);
            Json(SetReply {
                ok: true,
                roots: Some(&roots),
                error: None,
            })
            .into_response()
        }
        // `picker_roots` answers an `io::Error`; the route relays its own text.
        Ok(SetRootsResult::StorageFailure(error)) => Json(SetReply {
            ok: false,
            roots: None,
            error: Some(error.to_string()),
        })
        .into_response(),
        Err(_) => internal_error(),
    }
}

#[derive(serde::Serialize)]
struct RootsReply<'a> {
    roots: &'a RawValue,
}

#[derive(serde::Serialize)]
struct SetReply<'a> {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    roots: Option<&'a RawValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

/// `req.body?.roots` for the Node handler: only a JSON object's last `roots` member
/// counts, so scalar, array, plain-text and absent bodies have none. Missing,
/// `null`, `false`, `0` and `""` are falsy and store `[]`; any other non-array is
/// truthy and throws in the handler; arrays keep their original raw tokens.
fn roots_member(body: &RawBody) -> Result<String, ()> {
    let Some(value) = body
        .value
        .as_object()
        .and_then(|object| object.get("roots"))
    else {
        return Ok("[]".to_owned());
    };
    if matches!(value, Value::Array(_)) {
        // `parse_raw` validated the whole document, so the scanner cannot miss the
        // member that produced `value`; refusing here keeps the raw token
        // authoritative instead of falling back to a lossy re-serialization.
        return body
            .raw
            .as_deref()
            .and_then(|raw| raw_fields(raw.get()).ok().flatten())
            .and_then(|fields| {
                fields
                    .into_iter()
                    .rev()
                    .find(|(key, _)| key == &"roots".encode_utf16().collect::<Vec<_>>())
                    .map(|(_, value)| value)
            })
            .map(|token| token.get().to_owned())
            .ok_or(());
    }
    if js_truthy(value) {
        return Err(());
    }
    Ok("[]".to_owned())
}

fn stored_array(roots_json: &str) -> Box<RawValue> {
    let compact = serde_json::from_str::<Vec<Box<RawValue>>>(roots_json)
        .map(|items| {
            format!(
                "[{}]",
                items
                    .iter()
                    .map(|item| item.get())
                    .collect::<Vec<_>>()
                    .join(",")
            )
        })
        .unwrap_or_else(|_| DEFAULT_ROOTS_ARRAY.to_owned());
    RawValue::from_string(compact).expect("validated array")
}

#[derive(Clone)]
struct Hooks {
    state_dir: PathBuf,
    paths: PathEnv,
    backups_dir: PathBuf,
    locale: String,
    lock: Arc<Mutex<()>>,
    file_lock: Arc<Mutex<()>>,
}

// VERIFY: hooks-router-injection
/// Returns the whole `/api/hooks` subtree. The host passes the same `file_lock` it
/// hands `http_rules::router` when it wants Node's single bridge queue.
pub fn router(
    state_dir: PathBuf,
    home: PathBuf,
    cwd: PathBuf,
    drive_cwds: Vec<(u16, PathBuf)>,
    backups_dir: PathBuf,
    locale: String,
    lock: Arc<Mutex<()>>,
    file_lock: Arc<Mutex<()>>,
) -> Router {
    Router::new()
        .merge(roots_router(
            "/api/hooks/roots",
            HOOK_ROOTS_FILE,
            state_dir.clone(),
            lock.clone(),
        ))
        .merge(
            Router::new()
                .route("/api/hooks/list", post(list))
                .route("/api/hooks/search", post(search))
                .route("/api/hooks/file", get(get_file).put(put_file))
                .with_state(Hooks {
                    state_dir,
                    paths: PathEnv::new(home, cwd, drive_cwds),
                    backups_dir,
                    locale,
                    lock,
                    file_lock,
                }),
        )
}

// VERIFY: hooks-list-route
/// `POST /api/hooks/list` -> `{groups}`; groups keep the verbatim client cwd and a
/// per-cwd `files` array sorted by `rel` the way Node's `localeCompare` orders it.
async fn list(State(state): State<Hooks>, request: Request<Body>) -> Response {
    let body = match parse_raw(request).await {
        Ok(body) => body,
        Err(response) => return response,
    };
    let roots = match array_field(&body.value, MAP_ERROR) {
        Ok(roots) => roots,
        Err(response) => return response,
    };
    let scans = match scans(&state.paths, &roots) {
        Ok(scans) => scans,
        Err(response) => return response,
    };
    tokio::task::spawn_blocking(move || list_blocking(&state, scans))
        .await
        .unwrap_or_else(|_| internal_error())
}

fn list_blocking(state: &Hooks, scans: Vec<Value>) -> Response {
    let locale: Locale = match state.locale.parse() {
        Ok(locale) => locale,
        Err(error) => return internal_message(&format!("invalid locale: {error}")),
    };
    let collator = match Collator::try_new(locale.into(), CollatorOptions::default()) {
        Ok(collator) => collator,
        Err(error) => return internal_message(&error.to_string()),
    };
    let _guard = state
        .file_lock
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let raw = crate::hooks_read::list(&Value::Array(scans));
    let Ok(mut payload) = serde_json::from_str::<Value>(raw.get()) else {
        return internal_error();
    };
    let Some(groups) = payload.as_array_mut() else {
        return internal_error();
    };
    for files in groups
        .iter_mut()
        .filter_map(|group| group.get_mut("files").and_then(Value::as_array_mut))
    {
        files.sort_by(|a, b| collator.compare(field(a, "rel"), field(b, "rel")));
    }
    Json(json!({ "groups": groups })).into_response()
}

// VERIFY: hooks-search-route
/// `POST /api/hooks/search` -> `{results}`; an empty `String(q || '')` answers no
/// hits before any root is resolved, and hits are sorted by `path`.
async fn search(State(state): State<Hooks>, request: Request<Body>) -> Response {
    let body = match parse_raw(request).await {
        Ok(body) => body,
        Err(response) => return response,
    };
    let needle = body
        .value
        .as_object()
        .and_then(|object| object.get("q"))
        .map(|q| {
            if js_truthy(q) {
                js_string(q)
            } else {
                String::new()
            }
        })
        .unwrap_or_default();
    if needle.is_empty() {
        return Json(json!({ "results": [] })).into_response();
    }
    let roots = match iterable_field(&body.value) {
        Ok(roots) => roots,
        Err(response) => return response,
    };
    let scans = match scans(&state.paths, &roots) {
        Ok(scans) => scans,
        Err(response) => return response,
    };
    tokio::task::spawn_blocking(move || search_blocking(&state, scans, &needle))
        .await
        .unwrap_or_else(|_| internal_error())
}

fn search_blocking(state: &Hooks, scans: Vec<Value>, needle: &str) -> Response {
    let locale: Locale = match state.locale.parse() {
        Ok(locale) => locale,
        Err(error) => return internal_message(&format!("invalid locale: {error}")),
    };
    let collator = match Collator::try_new(locale.into(), CollatorOptions::default()) {
        Ok(collator) => collator,
        Err(error) => return internal_message(&error.to_string()),
    };
    let _guard = state
        .file_lock
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let raw = crate::hooks_read::search(&Value::Array(scans), needle);
    let Ok(mut hits) = serde_json::from_str::<Vec<Value>>(raw.get()) else {
        return internal_error();
    };
    hits.sort_by(|a, b| collator.compare(field(a, "path"), field(b, "path")));
    let mut results = Vec::with_capacity(hits.len());
    for hit in &hits {
        let Some(text) = hit["text"].as_str().and_then(|text| slice_units(text)) else {
            return internal_error();
        };
        results.push(Hit {
            cwd: field(hit, "cwd").to_owned(),
            path: field(hit, "path").to_owned(),
            rel: field(hit, "rel").to_owned(),
            line: hit["line"].as_u64().unwrap_or(0),
            text,
        });
    }
    Json(SearchReply { results }).into_response()
}

#[derive(serde::Serialize)]
struct SearchReply {
    results: Vec<Hit>,
}

#[derive(serde::Serialize)]
struct Hit {
    cwd: String,
    path: String,
    rel: String,
    line: u64,
    text: TranscriptRawText,
}

/// `String.prototype.slice(0, 200)` over UTF-16 units, keeping a split surrogate
/// pair as the lone unit JavaScript produces.
fn slice_units(text: &str) -> Option<TranscriptRawText> {
    let token = serde_json::to_string(text).ok()?;
    TranscriptRawText::from_json_token(token)
        .ok()?
        .slice_units(0, SEARCH_SLICE)
        .ok()
}

fn scans(paths: &PathEnv, roots: &[Value]) -> Result<Vec<Value>, Response> {
    roots
        .iter()
        .map(|root| {
            let Some(cwd) = root.as_str() else {
                return Err(invalid_path_argument(root));
            };
            let dir = paths.joined(&cwd.encode_utf16().collect::<Vec<_>>(), HOOKS_SUBDIR);
            let Ok(dir) = String::from_utf16(&dir) else {
                return Err(internal_error());
            };
            Ok(json!({ "root": cwd, "dir": dir }))
        })
        .collect()
}

// VERIFY: hooks-file-read
/// `GET /api/hooks/file` -> the guarded read. A rejected or absent `path` answers
/// 400 `bad path` with the client's own value echoed; a read failure is Node's
/// uncaught `hooksRead` throw, so its Fastify 500 envelope relays the error text.
async fn get_file(State(state): State<Hooks>, RawQuery(query): RawQuery) -> Response {
    tokio::task::spawn_blocking(move || get_file_blocking(&state, query.as_deref()))
        .await
        .unwrap_or_else(|_| internal_error())
}

fn get_file_blocking(state: &Hooks, query: Option<&str>) -> Response {
    let target = match param(query, "path") {
        QueryParam::Absent => return bad_path(None),
        QueryParam::Array(values) => {
            let values = values.into_iter().map(Value::String).collect();
            return bad_path(Some(Value::Array(values)));
        }
        QueryParam::One(value) if value.is_empty() => return bad_path(Some(Value::String(value))),
        QueryParam::One(value) => value,
    };
    let roots_json = roots_json(state);
    let Some(abs) = state.paths.inside(
        &roots_json,
        &target.encode_utf16().collect::<Vec<_>>(),
        HOOKS_SUBDIR,
    ) else {
        return bad_path(Some(Value::String(target)));
    };
    let Ok(abs) = String::from_utf16(&abs) else {
        return internal_message(WRITE_FAILED);
    };
    let _guard = state
        .file_lock
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let payload = crate::hooks_read::read(&abs);
    let Ok(payload) = serde_json::from_str::<ReadPayload>(payload.get()) else {
        return internal_error();
    };
    if let Some(error) = payload.error {
        return internal_message(&error);
    }
    let Ok(mtime) = RawValue::from_string(js_number_text(payload.mtime)) else {
        return internal_error();
    };
    Json(FileReply {
        path: &abs,
        exists: payload.exists,
        content: &payload.content,
        mtime: &mtime,
    })
    .into_response()
}

#[derive(serde::Deserialize)]
struct ReadPayload {
    #[serde(default)]
    exists: bool,
    #[serde(default)]
    content: String,
    #[serde(default)]
    mtime: f64,
    #[serde(default)]
    error: Option<String>,
}

#[derive(serde::Serialize)]
struct FileReply<'a> {
    path: &'a str,
    exists: bool,
    content: &'a str,
    // `mtime` stays a JSON number; its text follows ECMAScript number rules.
    mtime: &'a RawValue,
}

#[derive(serde::Serialize)]
struct BadPath<'a> {
    #[serde(skip_serializing_if = "Option::is_none")]
    path: Option<Value>,
    exists: bool,
    error: &'a str,
}

// VERIFY: hooks-file-write
/// `PUT /api/hooks/file` -> `writeHook` with its exact ordering: authorize, guard
/// the mtime, back up, re-guard, reject non-string content, then write.
async fn put_file(State(state): State<Hooks>, request: Request<Body>) -> Response {
    let body = match parse_raw(request).await {
        Ok(body) => body,
        Err(response) => return response,
    };
    tokio::task::spawn_blocking(move || put_file_blocking(&state, body))
        .await
        .unwrap_or_else(|_| write_failed())
}

fn put_file_blocking(state: &Hooks, body: RawBody) -> Response {
    let object = body.value.as_object();
    let path = object.and_then(|object| object.get("path"));
    // `if (!path || content == null)`
    let Some(path_value) = path.filter(|value| js_truthy(*value)) else {
        return required();
    };
    if object
        .and_then(|object| object.get("content"))
        .is_none_or(Value::is_null)
    {
        return required();
    }
    let Some(path) = path_value.as_str() else {
        return write_failed_with(StatusCode::BAD_REQUEST, BAD_PATH);
    };

    let roots_json = roots_json(state);
    let units: Vec<u16> = path.encode_utf16().collect();
    let Some(abs) = state.paths.inside(&roots_json, &units, HOOKS_SUBDIR) else {
        return write_failed_with(StatusCode::BAD_REQUEST, BAD_PATH);
    };
    let Ok(abs) = String::from_utf16(&abs) else {
        return write_failed();
    };
    let abs_path = PathBuf::from(&abs);

    let _guard = state
        .file_lock
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let mtime = object.and_then(|object| object.get("mtime"));
    let mtime_present = mtime.is_some_and(|value| !value.is_null());
    let mtime_number = mtime.map(js_value_number).unwrap_or(f64::NAN);
    let force = object
        .and_then(|object| object.get("force"))
        .is_some_and(js_truthy);

    // Guard 1, before the backup: a stale save creates no backup.
    if let Err(response) = guard_mtime(&abs_path, mtime_present, mtime_number, force) {
        return response;
    }
    // Best effort: `backupFile` swallows every failure and the save continues.
    let backup = crate::memory_backup::backup_file(&abs, &abs_path, &state.backups_dir);
    // Guard 2, after the backup: covers a save landing while the copy ran.
    if let Err(response) = guard_mtime(&abs_path, mtime_present, mtime_number, force) {
        return response;
    }
    let Some(content) = object
        .and_then(|object| object.get("content"))
        .and_then(Value::as_str)
    else {
        return write_failed_with(StatusCode::BAD_REQUEST, CONTENT_TYPE_ERROR);
    };
    // The bridge cannot carry an escaped lone surrogate.
    if lone_surrogate(&body, "path") || lone_surrogate(&body, "content") {
        return write_failed();
    }
    // `mtime == null ? null : Number(mtime)`, then JSON's non-finite -> null.
    let backend_mtime = (mtime_present && mtime_number.is_finite()).then_some(mtime_number);
    let payload = crate::hooks_write::write_file(Some(&abs), Some(content), backend_mtime, force);
    payload_response(payload, backup, &abs)
}

/// `existsSync` + `statSync().mtimeMs` against the resolved path, exactly like Node:
/// a missing path never blocks, and the tolerance is strictly `> 1` ms.
fn guard_mtime(path: &Path, present: bool, expected: f64, force: bool) -> Result<(), Response> {
    if !present || force || !path.exists() {
        return Ok(());
    }
    let modified = fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .map_err(|error| write_failed_with(StatusCode::BAD_REQUEST, &error.to_string()))?;
    if (system_time_ms(modified) - expected).abs() > 1.0 {
        return Err(write_failed_with(StatusCode::CONFLICT, CHANGED));
    }
    Ok(())
}

fn payload_response(payload: Value, backup: Option<PathBuf>, abs: &str) -> Response {
    if payload.get("ok").and_then(Value::as_bool) == Some(true) {
        let Some(mtime) = payload
            .get("mtime")
            .and_then(Value::as_f64)
            .filter(|value| value.is_finite())
        else {
            return write_failed();
        };
        let Ok(mtime) = RawValue::from_string(js_number_text(mtime)) else {
            return write_failed();
        };
        return Json(WriteOk {
            ok: true,
            mtime: &mtime,
            backup: backup.map(|path| path.to_string_lossy().into_owned()),
            path: abs,
        })
        .into_response();
    }
    let error = payload
        .get("error")
        .and_then(Value::as_str)
        .unwrap_or(WRITE_FAILED);
    if error == CHANGED {
        write_failed_with(StatusCode::CONFLICT, CHANGED)
    } else {
        write_failed()
    }
}

#[derive(serde::Serialize)]
struct WriteOk<'a> {
    ok: bool,
    mtime: &'a RawValue,
    backup: Option<String>,
    path: &'a str,
}

fn roots_json(state: &Hooks) -> String {
    let _guard = state.lock.lock().unwrap_or_else(|error| error.into_inner());
    crate::picker_roots::get_roots(&state.state_dir.join(HOOK_ROOTS_FILE))
}

fn field<'a>(value: &'a Value, name: &str) -> &'a str {
    value.get(name).and_then(Value::as_str).unwrap_or("")
}

/// `req.body?.roots` when the Node handler would call `.map` on it: absent and
/// falsy roots are an empty list, a truthy non-array throws `MAP_ERROR`.
fn array_field(value: &Value, message: &str) -> Result<Vec<Value>, Response> {
    match value.as_object().and_then(|object| object.get("roots")) {
        Some(Value::Array(items)) => Ok(items.clone()),
        Some(other) if js_truthy(other) => Err(type_error(message)),
        _ => Ok(Vec::new()),
    }
}

/// The same for `[...(roots || [])]`, whose TypeError names the spread value.
fn iterable_field(value: &Value) -> Result<Vec<Value>, Response> {
    match value.as_object().and_then(|object| object.get("roots")) {
        Some(Value::Array(items)) => Ok(items.clone()),
        Some(other) if js_truthy(other) => {
            Err(type_error(&format!("{} is not iterable", js_string(other))))
        }
        _ => Ok(Vec::new()),
    }
}

// VERIFY: hooks-file-query-shape
/// Fastify's query parser yields a string for one occurrence and an array for
/// repeats; bracket syntax stays a literal key, so `path[x]` is not `path`.
enum QueryParam {
    Absent,
    One(String),
    Array(Vec<String>),
}

fn param(query: Option<&str>, name: &str) -> QueryParam {
    let Some(query) = query else {
        return QueryParam::Absent;
    };
    let mut values = query_values(query, name);
    if values.is_empty() {
        QueryParam::Absent
    } else if values.len() == 1 {
        QueryParam::One(values.remove(0))
    } else {
        QueryParam::Array(values)
    }
}

/// `JSON.stringify` of a lone-surrogate field would need UTF-16 units Rust strings
/// cannot hold, so the escaped token is detected from the raw body instead.
fn lone_surrogate(body: &RawBody, name: &str) -> bool {
    let Some(raw) = body.raw.as_deref() else {
        return false;
    };
    let Ok(Some(fields)) = raw_fields(raw.get()) else {
        return false;
    };
    let key: Vec<u16> = name.encode_utf16().collect();
    let Some((_, token)) = fields.into_iter().rev().find(|(field, _)| *field == key) else {
        return false;
    };
    TranscriptRawText::from_json_token(token.get().to_owned())
        .ok()
        .and_then(|text| text.units().ok())
        .is_some_and(|units| String::from_utf16(&units).is_err())
}

fn system_time_ms(time: SystemTime) -> f64 {
    match time.duration_since(UNIX_EPOCH) {
        Ok(duration) => duration.as_secs_f64() * 1000.0,
        Err(error) => -(error.duration().as_secs_f64() * 1000.0),
    }
}

/// JavaScript truthiness: only `false`, `0`, `""`, `null`/`undefined` and `NaN` are
/// falsy; every array and object (even empty) is truthy.
pub(crate) fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => {
            let value = number.as_f64().unwrap_or(f64::NAN);
            value != 0.0 && !value.is_nan()
        }
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// `String(value)` for the JSON values a query or body field can hold.
pub(crate) fn js_string(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(_) => js_number_text(js_value_number(value)),
        Value::String(text) => text.clone(),
        Value::Array(items) => items.iter().map(js_string).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".to_owned(),
    }
}

/// JavaScript `Number(value)`.
pub(crate) fn js_value_number(value: &Value) -> f64 {
    match value {
        Value::Null => 0.0,
        Value::Bool(flag) => {
            if *flag {
                1.0
            } else {
                0.0
            }
        }
        Value::Number(number) => number
            .as_f64()
            .unwrap_or_else(|| number.to_string().parse().unwrap_or(f64::NAN)),
        Value::String(text) => crate::memory_backup::js_string_to_number(text),
        Value::Array(_) => crate::memory_backup::js_string_to_number(&js_string(value)),
        Value::Object(_) => f64::NAN,
    }
}

/// ECMAScript number text, as `ryu_js` formats it for a finite value.
pub(crate) fn js_number_text(value: f64) -> String {
    if value.is_nan() {
        return "NaN".to_owned();
    }
    if value.is_infinite() {
        return if value.is_sign_positive() {
            "Infinity".to_owned()
        } else {
            "-Infinity".to_owned()
        };
    }
    if value == 0.0 {
        return "0".to_owned();
    }
    let mut buffer = ryu_js::Buffer::new();
    buffer.format_finite(value).to_owned()
}

fn required() -> Response {
    write_failed_with(StatusCode::BAD_REQUEST, REQUIRED)
}

fn bad_path(path: Option<Value>) -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(BadPath {
            path,
            exists: false,
            error: BAD_PATH,
        }),
    )
        .into_response()
}

fn write_failed() -> Response {
    write_failed_with(StatusCode::BAD_REQUEST, WRITE_FAILED)
}

fn write_failed_with(status: StatusCode, error: &str) -> Response {
    (status, Json(json!({ "ok": false, "error": error }))).into_response()
}

fn type_error(message: &str) -> Response {
    internal_message(message)
}

fn internal_message(message: &str) -> Response {
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

fn internal_error() -> Response {
    internal_message("Internal Server Error")
}

/// Fastify's default error envelope for a thrown `path` TypeError.
fn invalid_path_argument(value: &Value) -> Response {
    let received = match value {
        Value::Null => "null".to_owned(),
        Value::Bool(flag) => format!("type boolean ({flag})"),
        Value::Number(_) => format!("type number ({})", js_number_text(js_value_number(value))),
        Value::Array(_) => "an instance of Array".to_owned(),
        _ => "an instance of Object".to_owned(),
    };
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({
            "statusCode": 500,
            "code": "ERR_INVALID_ARG_TYPE",
            "error": "Internal Server Error",
            "message": format!("The \"path\" argument must be of type string. Received {received}"),
        })),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::{
        HOOK_ROOTS_FILE, Hooks, MAP_ERROR, PathEnv, Roots, get_file, get_roots, list, put_file,
        put_roots, search,
    };
    use axum::body::{Body, to_bytes};
    use axum::extract::{RawQuery, State};
    use axum::http::{Method, Request, header};
    use axum::response::Response;
    use serde_json::{Value, json};
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::{SystemTime, UNIX_EPOCH};

    static FIXTURE_ID: AtomicU64 = AtomicU64::new(0);

    struct Fixture(PathBuf);

    impl Fixture {
        fn new() -> Self {
            let unique = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let id = FIXTURE_ID.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir()
                .join(format!("http-hooks-{}-{unique}-{id}", std::process::id()));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        fn base(&self, name: &str) -> PathBuf {
            self.0.join(name)
        }

        fn state_dir(&self) -> PathBuf {
            self.0.join("state")
        }

        fn hooks(&self, name: &str) -> PathBuf {
            self.base(name).join(".claude").join("hooks")
        }

        fn root_with(&self, name: &str, files: &[(&str, &str)]) -> PathBuf {
            let dir = self.hooks(name);
            fs::create_dir_all(&dir).unwrap();
            for (file, content) in files {
                let path = dir.join(file);
                fs::create_dir_all(path.parent().unwrap()).unwrap();
                fs::write(path, content).unwrap();
            }
            self.base(name)
        }

        fn state(&self) -> Hooks {
            Hooks {
                state_dir: self.state_dir(),
                paths: PathEnv::new(self.0.join("home"), self.0.clone(), Vec::new()),
                backups_dir: self.0.join("backups"),
                locale: "en-SG".to_owned(),
                lock: Arc::new(Mutex::new(())),
                file_lock: Arc::new(Mutex::new(())),
            }
        }

        fn roots(&self) -> Roots {
            Roots {
                path: self.state_dir().join(HOOK_ROOTS_FILE),
                lock: Arc::new(Mutex::new(())),
            }
        }

        fn persist_roots(&self, roots: &[&str]) {
            fs::create_dir_all(self.state_dir()).unwrap();
            fs::write(
                self.state_dir().join(HOOK_ROOTS_FILE),
                serde_json::to_string(roots).unwrap(),
            )
            .unwrap();
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn run<F: std::future::Future>(future: F) -> F::Output {
        tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(future)
    }

    fn text(path: &Path) -> String {
        path.to_str().unwrap().to_owned()
    }

    async fn collect(response: Response) -> (u16, String) {
        let status = response.status().as_u16();
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        (status, String::from_utf8(bytes.to_vec()).unwrap())
    }

    fn post(uri: &str, body: &str) -> Request<Body> {
        Request::builder()
            .method(Method::POST)
            .uri(uri)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body.to_owned()))
            .unwrap()
    }

    fn put(body: &str) -> Request<Body> {
        Request::builder()
            .method(Method::PUT)
            .uri("/api/hooks/file")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body.to_owned()))
            .unwrap()
    }

    async fn send_list(state: &Hooks, body: &str) -> (u16, String) {
        collect(list(State(state.clone()), post("/api/hooks/list", body)).await).await
    }

    async fn send_search(state: &Hooks, body: &str) -> (u16, String) {
        collect(search(State(state.clone()), post("/api/hooks/search", body)).await).await
    }

    async fn send_get(state: &Hooks, query: Option<String>) -> (u16, String) {
        let query = RawQuery(query);
        collect(get_file(State(state.clone()), query).await).await
    }

    async fn send_put(state: &Hooks, body: &str) -> (u16, String) {
        collect(put_file(State(state.clone()), put(body)).await).await
    }

    fn payload(body: &str) -> Value {
        serde_json::from_str(body).unwrap()
    }

    #[test]
    fn roots_default_dedupe_and_falsy_inputs_match_the_node_handler() {
        let fixture = Fixture::new();
        let roots = fixture.roots();
        run(async {
            let get = || get_roots(State(roots.clone()));
            assert_eq!(
                collect(get().await).await,
                (200, r#"{"roots":["~"]}"#.to_owned())
            );
            let saved = collect(
                put_roots(
                    State(roots.clone()),
                    Request::builder()
                        .method(Method::PUT)
                        .uri("/api/hooks/roots")
                        .header(header::CONTENT_TYPE, "application/json")
                        .body(Body::from(r#"{"roots":["~","/a","/a","/b",123,""]}"#))
                        .unwrap(),
                )
                .await,
            )
            .await;
            assert_eq!(
                saved,
                (200, r#"{"ok":true,"roots":["~","/a","/b"]}"#.to_owned())
            );
            assert_eq!(
                collect(get().await).await,
                (200, r#"{"roots":["~","/a","/b"]}"#.to_owned())
            );
            assert_eq!(
                fs::read_to_string(fixture.state_dir().join(HOOK_ROOTS_FILE)).unwrap(),
                "[\n  \"~\",\n  \"/a\",\n  \"/b\"\n]"
            );

            for body in [r#"{"roots":false}"#, r#"{"roots":null}"#, "{}", "[]"] {
                assert_eq!(
                    collect(
                        put_roots(
                            State(roots.clone()),
                            Request::builder()
                                .method(Method::PUT)
                                .uri("/api/hooks/roots")
                                .header(header::CONTENT_TYPE, "application/json")
                                .body(Body::from(body))
                                .unwrap(),
                        )
                        .await,
                    )
                    .await,
                    (200, r#"{"ok":true,"roots":[]}"#.to_owned()),
                    "{body}"
                );
            }
            let rejected = collect(
                put_roots(
                    State(roots.clone()),
                    Request::builder()
                        .method(Method::PUT)
                        .uri("/api/hooks/roots")
                        .header(header::CONTENT_TYPE, "application/json")
                        .body(Body::from(r#"{"roots":"/a"}"#))
                        .unwrap(),
                )
                .await,
            )
            .await;
            assert_eq!(rejected.0, 500);
            assert_eq!(payload(&rejected.1)["message"], json!(super::FILTER_ERROR));
        });
    }

    #[test]
    fn list_groups_keep_the_verbatim_cwd_and_sort_files_by_rel() {
        let fixture = Fixture::new();
        let base = fixture.root_with(
            "project",
            &[("b.mjs", "x"), ("a.mjs", "x"), ("sub/c.mjs", "x")],
        );
        let empty = fixture.base("empty");
        let state = fixture.state();
        run(async {
            let body = json!({ "roots": [text(&base), text(&empty)] }).to_string();
            let (status, response) = send_list(&state, &body).await;
            assert_eq!(status, 200, "{response}");
            let groups = payload(&response);
            assert_eq!(groups["groups"][0]["cwd"], json!(text(&base)));
            let rels: Vec<&str> = groups["groups"][0]["files"]
                .as_array()
                .unwrap()
                .iter()
                .map(|file| file["rel"].as_str().unwrap())
                .collect();
            let nested = Path::new("sub")
                .join("c.mjs")
                .to_string_lossy()
                .into_owned();
            assert_eq!(rels, vec!["a.mjs", "b.mjs", nested.as_str()]);
            assert_eq!(
                groups["groups"][1],
                json!({ "cwd": text(&empty), "files": [] })
            );

            assert_eq!(
                send_list(&state, "{}").await,
                (200, r#"{"groups":[]}"#.to_owned())
            );
            let rejected = send_list(&state, r#"{"roots":"x"}"#).await;
            assert_eq!(rejected.0, 500);
            assert_eq!(payload(&rejected.1)["message"], json!(MAP_ERROR));
        });
    }

    #[test]
    fn search_sorts_by_path_and_slices_the_snippet_to_200_utf16_units() {
        let fixture = Fixture::new();
        let long = format!("{}\u{1F600} needle", "x".repeat(199));
        let base = fixture.root_with("project", &[("b.mjs", &long), ("a.mjs", "needle")]);
        let state = fixture.state();
        run(async {
            let body = json!({ "roots": [text(&base)], "q": "NEEDLE" }).to_string();
            let (status, response) = send_search(&state, &body).await;
            assert_eq!(status, 200, "{response}");
            // The sliced snippet ends in a lone high surrogate, so the body cannot
            // round-trip through `serde_json::Value`; assert on the raw text.
            assert_eq!(response.matches("\"rel\"").count(), 2, "{response}");
            let first = response.find("a.mjs").unwrap();
            let second = response.find("b.mjs").unwrap();
            assert!(first < second, "{response}");
            assert!(response.contains("\"text\":\"needle\""), "{response}");
            // A pair split at unit 200 leaves the lone high surrogate escaped.
            assert!(response.contains("\\ud83d"), "{response}");
            assert!(!response.contains("\\ude00"), "{response}");

            // An empty query answers before any root is touched.
            assert_eq!(
                send_search(&state, r#"{"roots":5,"q":""}"#).await,
                (200, r#"{"results":[]}"#.to_owned())
            );
            let rejected = send_search(&state, r#"{"roots":5,"q":"x"}"#).await;
            assert_eq!(rejected.0, 500);
            assert_eq!(payload(&rejected.1)["message"], json!("5 is not iterable"));
        });
    }

    #[test]
    fn file_read_maps_guard_missing_and_read_failures() {
        let fixture = Fixture::new();
        let base = fixture.root_with("project", &[("r.mjs", "hello")]);
        fixture.persist_roots(&[&text(&base)]);
        let _outside = fixture.root_with("outside", &[("r.mjs", "secret")]);
        let state = fixture.state();
        let read = fixture.hooks("project").join("r.mjs");
        let missing = fixture.hooks("project").join("absent.mjs");
        let escape = format!(
            "{}{}..{}..{}escape.mjs",
            text(&fixture.hooks("project")),
            std::path::MAIN_SEPARATOR,
            std::path::MAIN_SEPARATOR,
            std::path::MAIN_SEPARATOR
        );
        run(async {
            let q = format!(
                "path={}",
                text(&read).replace('\\', "%5C").replace('/', "%2F")
            );
            let (status, response) = send_get(&state, Some(q)).await;
            assert_eq!(status, 200, "{response}");
            let value = payload(&response);
            assert_eq!(value["path"], json!(text(&read)));
            assert_eq!(value["exists"], true);
            assert_eq!(value["content"], json!("hello"));
            assert!(value["mtime"].as_f64().unwrap() > 0.0);

            let q = format!(
                "path={}",
                text(&missing).replace('\\', "%5C").replace('/', "%2F")
            );
            assert_eq!(
                send_get(&state, Some(q)).await,
                (
                    200,
                    json!({
                        "path": text(&missing),
                        "exists": false,
                        "content": "",
                        "mtime": 0,
                    })
                    .to_string()
                )
            );

            // A hooks-shaped path under a root that was never registered.
            let unregistered = fixture.hooks("outside").join("r.mjs");
            let q = format!(
                "path={}",
                text(&unregistered).replace('\\', "%5C").replace('/', "%2F")
            );
            assert_eq!(
                send_get(&state, Some(q)).await,
                (
                    400,
                    json!({ "path": text(&unregistered), "exists": false, "error": "bad path" })
                        .to_string()
                )
            );
            let q = format!("path={}", escape.replace('\\', "%5C").replace('/', "%2F"));
            assert_eq!(send_get(&state, Some(q)).await.0, 400);
            assert_eq!(
                send_get(&state, None).await,
                (400, r#"{"exists":false,"error":"bad path"}"#.to_owned())
            );
            let repeated = send_get(&state, Some("path=a.mjs&path=b.mjs".to_owned())).await;
            assert_eq!(repeated.0, 400);
            assert_eq!(payload(&repeated.1)["path"], json!(["a.mjs", "b.mjs"]));

            // A read failure is an uncaught bridge throw: Fastify's 500 envelope.
            let dir = fixture.hooks("project");
            let q = format!(
                "path={}",
                text(&dir).replace('\\', "%5C").replace('/', "%2F")
            );
            let failed = send_get(&state, Some(q)).await;
            assert_eq!(failed.0, 500);
            assert_eq!(payload(&failed.1)["error"], json!("Internal Server Error"));
        });
    }

    #[test]
    fn file_write_backs_up_guards_the_mtime_and_maps_statuses() {
        let fixture = Fixture::new();
        let base = fixture.root_with("project", &[("w.mjs", "v1")]);
        fixture.persist_roots(&[&text(&base)]);
        let outside = fixture.root_with("outside", &[("w.mjs", "v1")]);
        let file = fixture.hooks("project").join("w.mjs");
        let state = fixture.state();
        run(async {
            let saved = send_put(
                &state,
                &json!({ "path": text(&file), "content": "v2" }).to_string(),
            )
            .await;
            assert_eq!(saved.0, 200, "{}", saved.1);
            let value = payload(&saved.1);
            assert_eq!(value["ok"], true);
            assert_eq!(value["path"], json!(text(&file)));
            assert!(value.get("mtime").and_then(Value::as_f64).is_some());
            let backup = value["backup"].as_str().unwrap().to_owned();
            assert_eq!(fs::read_to_string(&backup).unwrap(), "v1");
            assert_eq!(fs::read_to_string(&file).unwrap(), "v2");

            // Stale mtime -> 409 and no second backup.
            let stale = send_put(
                &state,
                &json!({ "path": text(&file), "content": "v3", "mtime": 1.0 }).to_string(),
            )
            .await;
            assert_eq!(
                stale,
                (409, r#"{"ok":false,"error":"changed on disk"}"#.to_owned())
            );
            assert_eq!(fs::read_to_string(&file).unwrap(), "v2");
            assert_eq!(bak_count(&fixture.0.join("backups")), 1);

            // force overrides the guard.
            let forced = send_put(
                &state,
                &json!({ "path": text(&file), "content": "v3", "mtime": 1.0, "force": true })
                    .to_string(),
            )
            .await;
            assert_eq!(forced.0, 200, "{}", forced.1);
            assert_eq!(fs::read_to_string(&file).unwrap(), "v3");

            // Non-string content is refused after the backup, as in writeHook.
            let invalid = send_put(
                &state,
                &json!({ "path": text(&file), "content": 5 }).to_string(),
            )
            .await;
            assert_eq!(
                invalid,
                (
                    400,
                    r#"{"ok":false,"error":"content must be a string"}"#.to_owned()
                )
            );
            assert_eq!(bak_count(&fixture.0.join("backups")), 3);

            let rejected = send_put(
                &state,
                &json!({ "path": text(&outside.join(".claude/hooks/w.mjs")), "content": "x" })
                    .to_string(),
            )
            .await;
            assert_eq!(
                rejected,
                (400, r#"{"ok":false,"error":"bad path"}"#.to_owned())
            );
            assert_eq!(
                send_put(&state, r#"{"content":"x"}"#).await,
                (
                    400,
                    r#"{"ok":false,"error":"path + content required"}"#.to_owned()
                )
            );
            assert_eq!(send_put(&state, r#"{"path":5,"content":"x"}"#).await.0, 400);
        });
    }

    fn bak_count(backups: &Path) -> usize {
        crate::fs_sorted::read_dir(backups)
            .map(|entries| {
                entries
                    .filter_map(|entry| entry.ok())
                    .flat_map(|entry| crate::fs_sorted::read_dir(entry.path()).into_iter().flatten())
                    .filter_map(|entry| entry.ok())
                    .filter(|entry| entry.file_name().to_string_lossy().ends_with(".bak"))
                    .count()
            })
            .unwrap_or(0)
    }
}
