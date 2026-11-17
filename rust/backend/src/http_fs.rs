//! Explorer HTTP surface: every `/api/fs/*` route, mirroring
//! `server/index.mjs:405-490` (`/fs/browse` inline, the rest delegating to
//! `server/explorer.mjs`) and the persisted UI state through
//! `rust/backend/src/explorer_state.rs`.
//!
//! There is deliberately no containment guard: `explorer.mjs` only rejects a
//! path that is not a non-empty absolute string (`bad(p)`), and full-FS access
//! is the feature. The outer `http_server` layer owns auth, origin and token
//! checks.
//!
//! Parity contract:
//!   * `GET /fs/list`, `/fs/search`, `/fs/read`, `/fs/raw`, `DELETE /fs/entry`
//!     take a single query value; a missing or repeated parameter is not a
//!     JavaScript string, so `explorer.mjs`'s `bad(p)` rejects it (400
//!     `bad path`). `GET /fs/browse` instead lets a repeated `path` reach
//!     `existsSync`, which throws — reproduced as the Fastify 500.
//!   * `/fs/list` types junctions/symlinks through `stat`, keeps dotfiles,
//!     sorts dirs then files with `localeCompare`, and caps at 2000.
//!   * `/fs/search` is a breadth-first name walk in 64-directory batches, with
//!     `SEARCH_CAP` 300, `DIR_BUDGET` 20000 and the exact `SKIP_DIRS` set;
//!     results are in traversal order, as in Node.
//!   * `/fs/read` classifies image by extension, else `toolarge` above 2 MiB,
//!     else `binary` when the first 8192 bytes contain a NUL, else `text`
//!     (lossy UTF-8). `mtime` is `st.mtimeMs`.
//!   * `/fs/raw` streams the bytes with `image/*` MIME by extension plus the
//!     exact `X-Content-Type-Options: nosniff` and CSP sandbox headers.
//!   * `PUT /fs/write` uses a 4 MiB body limit (`index.mjs:451`), requires both
//!     `path` and `content`, runs the pre-backup mtime guard, creates the
//!     parent directory, makes a best-effort backup into the injected backups
//!     dir, re-runs the guard, then calls `explorer_fs::write`; only the exact
//!     `changed on disk` error maps to 409.
//!   * `POST/DELETE /fs/entry` and `PATCH /fs/rename` keep Node's status map:
//!     404 only for `not found`, 400 otherwise.
//!   * `/fs/state` always answers 200; a failed read falls back to the default
//!     document, and a failed write reports `{ok:false,error}`.
//!
//! Parity limits, reported rather than approximated:
//!   * Filesystem failure text is Rust's `io::Error` text, not Node's `e.message`
//!     (`ENOENT: ...`), on `/fs/list`, `/fs/browse`, `/fs/read`, `/fs/raw`,
//!     `/fs/write` and the mutation routes.
//!   * ICU4X collation can differ from Node's bundled ICU version, so
//!     `localeCompare` order is equivalent but not guaranteed byte-identical.
//!   * `path.join` for search result/queue paths normalises separators but does
//!     not resolve `.`/`..` lexically or rewrite a UNC share root.
//!   * A JSON `mtime` that is an array (other than `[]` or a single primitive)
//!     or an object is treated as `NaN` (no guard); Node applies `ToNumber`.
//!   * A non-string `kind` on `POST /fs/entry` is treated as `file`; the Node
//!     bridge would have rejected the request with a type error instead. The
//!     same applies to a non-boolean `force` on `/fs/write`: JavaScript
//!     truthiness decides, where the bridge would have rejected the type.
//!   * The shared `http_body` parser is hard-coded at 1 MiB and is not owned by
//!     this slice, so `PUT /fs/write` carries a local copy of that exact
//!     contract at 4 MiB (`parse_write_body`). It should be replaced by a
//!     parameterised `http_body` once that module is free to change.
//!   * Escaped lone surrogates in a write `path`/`content` are rejected by
//!     serde_json as invalid JSON (Fastify envelope); Node would accept them.
use crate::http_policy::query_values;
use axum::body::{Body, to_bytes};
use axum::extract::{RawQuery, State};
use axum::http::{HeaderMap, HeaderName, HeaderValue, Request, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post, put};
use axum::{Json, Router};
use http_body_util::LengthLimitError;
use icu_collator::{Collator, CollatorBorrowed, options::CollatorOptions};
use icu_locale_core::Locale;
use serde_json::{Value, json};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::UNIX_EPOCH;

const ENTRY_CAP: usize = 2000;
const SEARCH_CAP: usize = 300;
const DIR_BUDGET: usize = 20000;
const BATCH: usize = 64;
const SKIP_DIRS: [&str; 6] = ["node_modules", ".git", ".cache", "dist", "build", ".next"];
const TOOLARGE: u64 = 2 * 1024 * 1024;
const NUL_SCAN: usize = 8192;
const WRITE_LIMIT: usize = 4 * 1024 * 1024;
const EXPLORER_STATE_FILE: &str = "explorer-state.json";
const NOSNIFF: &str = "nosniff";
const CSP: &str = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
// Fastify's message for `existsSync` receiving the array a repeated `path`
// query parameter produces.
const ARRAY_PATH_MESSAGE: &str = "The \"path\" argument must be of type string or an instance of Buffer or URL. Received an instance of Array";
const TRIM_MESSAGE: &str = "q.trim is not a function";

#[derive(Clone)]
struct Explorer {
    state_dir: PathBuf,
    backups_dir: PathBuf,
    locale: String,
    // Serialises `/fs/state` read-modify-write, as the Node bridge did.
    lock: Arc<Mutex<()>>,
}

// VERIFY: fs-router-injection
/// Dependencies the host must supply: `state_dir` (`SINGULARITY_HOME/state`),
/// `backups_dir` (`SINGULARITY_HOME/cache/backups`) and the system locale used
/// for `localeCompare` (`memory_collation::system_locale()`).
pub fn router(state_dir: PathBuf, backups_dir: PathBuf, locale: String) -> Router {
    Router::new()
        .route("/api/fs/browse", get(browse))
        .route("/api/fs/list", get(list))
        .route("/api/fs/search", get(search))
        .route("/api/fs/read", get(read))
        .route("/api/fs/raw", get(raw_file))
        .route("/api/fs/write", put(write))
        .route("/api/fs/entry", post(create_entry).delete(delete_entry))
        .route("/api/fs/rename", patch(rename_entry))
        .route("/api/fs/state", get(get_state).put(put_state))
        .with_state(Explorer {
            state_dir,
            backups_dir,
            locale,
            lock: Arc::new(Mutex::new(())),
        })
}

// VERIFY: fs-browse-route
async fn browse(State(state): State<Explorer>, RawQuery(query): RawQuery) -> Response {
    let values = query_values(query.as_deref().unwrap_or_default(), "path");
    if values.len() > 1 {
        return fastify_failure(StatusCode::INTERNAL_SERVER_ERROR, ARRAY_PATH_MESSAGE);
    }
    let Some(path) = values.first().filter(|path| !path.is_empty()) else {
        return browse_bad_path();
    };
    let path = path.clone();
    let locale = state.locale.clone();
    blocking(move || browse_response(&locale, &path)).await
}

fn browse_response(locale: &str, path: &str) -> Response {
    let target = Path::new(path);
    if !target.exists() {
        return browse_bad_path();
    }
    let read = match crate::fs_sorted::read_dir(target) {
        Ok(read) => read,
        Err(error) => return browse_failure(&error.to_string()),
    };
    let mut dirs = Vec::new();
    for entry in read {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => return browse_failure(&error.to_string()),
        };
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        if entry.file_type().is_ok_and(|file_type| file_type.is_dir()) {
            dirs.push(name);
        }
    }
    let collator = match make_collator(locale) {
        Ok(collator) => collator,
        Err(message) => return fastify_failure(StatusCode::INTERNAL_SERVER_ERROR, &message),
    };
    dirs.sort_by(|a, b| collator.compare(a, b));
    Json(json!({
        "path": path,
        "parent": parent_of(path),
        "dirs": dirs,
    }))
    .into_response()
}

// VERIFY: fs-list-route
async fn list(State(state): State<Explorer>, RawQuery(query): RawQuery) -> Response {
    let Some(path) = single_path(query.as_deref()) else {
        return failure(StatusCode::BAD_REQUEST, "bad path");
    };
    let locale = state.locale.clone();
    blocking(move || list_response(&locale, &path)).await
}

fn list_response(locale: &str, dir: &str) -> Response {
    let read = match crate::fs_sorted::read_dir(dir) {
        Ok(read) => read,
        Err(error) => return failure(StatusCode::BAD_REQUEST, &error.to_string()),
    };
    let mut dirs: Vec<Entry> = Vec::new();
    let mut files: Vec<Entry> = Vec::new();
    for entry in read {
        let entry = match entry {
            Ok(entry) => entry,
            // `readdirSync` returns every entry or throws.
            Err(error) => return failure(StatusCode::BAD_REQUEST, &error.to_string()),
        };
        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(_) => continue,
        };
        // Dirent is lstat-based, so a junction/symlink is neither dir nor file;
        // stat through the link so a junction opens as its target.
        let mut kind = if file_type.is_dir() {
            Some("dir")
        } else {
            None
        };
        let mut size = 0;
        if kind.is_none() {
            match fs::metadata(entry.path()) {
                Ok(metadata) if metadata.is_dir() => kind = Some("dir"),
                Ok(metadata) => {
                    kind = Some("file");
                    size = metadata.len();
                }
                Err(_) if file_type.is_file() => kind = Some("file"),
                Err(_) => continue,
            }
        }
        let item = Entry {
            name: entry.file_name().to_string_lossy().into_owned(),
            kind: kind.expect("classified above"),
            size,
        };
        if item.kind == "dir" {
            dirs.push(item);
        } else {
            files.push(item);
        }
    }
    let collator = match make_collator(locale) {
        Ok(collator) => collator,
        Err(message) => return fastify_failure(StatusCode::INTERNAL_SERVER_ERROR, &message),
    };
    dirs.sort_by(|a, b| collator.compare(&a.name, &b.name));
    files.sort_by(|a, b| collator.compare(&a.name, &b.name));
    dirs.append(&mut files);
    let mut entries = dirs;
    let capped = entries.len() > ENTRY_CAP;
    if capped {
        entries.truncate(ENTRY_CAP);
    }
    Json(json!({
        "ok": true,
        "path": dir,
        "parent": parent_of(dir),
        "entries": entries,
        "capped": capped,
    }))
    .into_response()
}

#[derive(serde::Serialize)]
struct Entry {
    name: String,
    #[serde(rename = "type")]
    kind: &'static str,
    size: u64,
}

// VERIFY: fs-search-route
async fn search(RawQuery(query): RawQuery) -> Response {
    let query = query.unwrap_or_default();
    let roots = query_values(&query, "root");
    let Some(root) = roots
        .as_slice()
        .first()
        .filter(|root| roots.len() == 1 && !bad_path(root.as_str()))
    else {
        return failure(StatusCode::BAD_REQUEST, "bad path");
    };
    let root = root.clone();
    let values = query_values(&query, "q");
    let term = match values.as_slice() {
        [] => String::new(),
        [value] => value.clone(),
        _ => return fastify_failure(StatusCode::INTERNAL_SERVER_ERROR, TRIM_MESSAGE),
    };
    blocking(move || search_response(&root, &term)).await
}

fn search_response(root: &str, source: &str) -> Response {
    let term = source.trim_matches(is_js_whitespace).to_lowercase();
    if term.is_empty() {
        return Json(json!({ "ok": true, "results": [], "capped": false })).into_response();
    }
    let mut results: Vec<SearchHit> = Vec::new();
    let mut queue: Vec<String> = vec![root.to_owned()];
    let mut visited = 0usize;
    while !queue.is_empty() && results.len() < SEARCH_CAP && visited < DIR_BUDGET {
        let take = queue.len().min(BATCH);
        let batch: Vec<String> = queue.drain(..take).collect();
        visited += batch.len();
        for dir in batch {
            // `readdir` failures behave like the Node `catch(() => null)`.
            let Ok(read) = crate::fs_sorted::read_dir(&dir) else {
                continue;
            };
            for entry in read {
                let Ok(entry) = entry else {
                    continue;
                };
                let name = entry.file_name().to_string_lossy().into_owned();
                let is_dir = entry.file_type().is_ok_and(|file_type| file_type.is_dir());
                if name.to_lowercase().contains(&term) {
                    results.push(SearchHit {
                        path: join_path(&dir, &name),
                        name: name.clone(),
                        kind: if is_dir { "dir" } else { "file" },
                    });
                }
                // Junctions/symlinks never report isDirectory here, which also
                // rules out link cycles.
                if is_dir && !SKIP_DIRS.contains(&name.as_str()) {
                    queue.push(join_path(&dir, &name));
                }
            }
        }
    }
    let capped = results.len() >= SEARCH_CAP || visited >= DIR_BUDGET;
    if results.len() > SEARCH_CAP {
        results.truncate(SEARCH_CAP);
    }
    Json(SearchReply {
        ok: true,
        results,
        capped,
    })
    .into_response()
}

#[derive(serde::Serialize)]
struct SearchReply {
    ok: bool,
    results: Vec<SearchHit>,
    capped: bool,
}

#[derive(serde::Serialize)]
struct SearchHit {
    path: String,
    name: String,
    #[serde(rename = "type")]
    kind: &'static str,
}

// VERIFY: fs-read-route
async fn read(RawQuery(query): RawQuery) -> Response {
    let Some(path) = single_path(query.as_deref()) else {
        return failure(StatusCode::BAD_REQUEST, "bad path");
    };
    blocking(move || read_response(&path)).await
}

fn read_response(path: &str) -> Response {
    let target = Path::new(path);
    if !target.exists() {
        return failure(StatusCode::NOT_FOUND, "not found");
    }
    let metadata = match fs::metadata(target) {
        Ok(metadata) => metadata,
        // `statSync` throws out of the handler; Fastify reports a 500.
        Err(error) => {
            return fastify_failure(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string());
        }
    };
    let Some(mtime) = mtime_ms(&metadata) else {
        return fastify_failure(StatusCode::INTERNAL_SERVER_ERROR, "unreadable mtime");
    };
    let size = metadata.len();
    let extension = extname(path);
    if is_image(&extension) {
        return Json(json!({ "ok": true, "kind": "image", "size": size, "mtime": mtime }))
            .into_response();
    }
    if size > TOOLARGE {
        return Json(json!({ "ok": true, "kind": "toolarge", "size": size, "mtime": mtime }))
            .into_response();
    }
    let bytes = match fs::read(target) {
        Ok(bytes) => bytes,
        Err(error) => {
            return fastify_failure(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string());
        }
    };
    if bytes.iter().take(NUL_SCAN).any(|byte| *byte == 0) {
        return Json(json!({ "ok": true, "kind": "binary", "size": size, "mtime": mtime }))
            .into_response();
    }
    let content = String::from_utf8_lossy(&bytes).into_owned();
    Json(json!({
        "ok": true,
        "kind": "text",
        "size": size,
        "mtime": mtime,
        "content": content,
    }))
    .into_response()
}

// VERIFY: fs-raw-route
async fn raw_file(RawQuery(query): RawQuery) -> Response {
    let Some(path) = single_path(query.as_deref()) else {
        return failure(StatusCode::BAD_REQUEST, "bad path");
    };
    blocking(move || raw_response(&path)).await
}

fn raw_response(path: &str) -> Response {
    let target = Path::new(path);
    if !target.exists() {
        return failure(StatusCode::NOT_FOUND, "not found");
    }
    let mime = mime_for(&extname(path));
    match fs::read(target) {
        Ok(bytes) => raw_bytes(bytes, mime),
        Err(error) => failure(StatusCode::BAD_REQUEST, &error.to_string()),
    }
}

// VERIFY: fs-raw-security-headers
fn raw_bytes(bytes: Vec<u8>, mime: &'static str) -> Response {
    let length = bytes.len();
    let mut response = Response::new(Body::from(bytes));
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static(mime));
    headers.insert(
        HeaderName::from_static("x-content-type-options"),
        HeaderValue::from_static(NOSNIFF),
    );
    headers.insert(
        HeaderName::from_static("content-security-policy"),
        HeaderValue::from_static(CSP),
    );
    headers.insert(
        header::CONTENT_LENGTH,
        HeaderValue::from_str(&length.to_string()).expect("decimal length"),
    );
    response
}

// VERIFY: fs-write-route
async fn write(State(state): State<Explorer>, request: Request<Body>) -> Response {
    let body = match parse_write_body(request).await {
        Ok(body) => body,
        Err(response) => return response,
    };
    let object = body.as_object();
    let field = |name: &str| object.and_then(|object| object.get(name));
    let missing = |value: Option<&Value>| value.is_none_or(Value::is_null);
    let (path, content) = (field("path"), field("content"));
    if missing(path) || missing(content) {
        return failure(StatusCode::BAD_REQUEST, "path + content required");
    }
    let Some(path) = path.and_then(Value::as_str).filter(|path| !bad_path(path)) else {
        return failure(StatusCode::BAD_REQUEST, "bad path");
    };
    let path = path.to_owned();
    let content = Value::clone(content.expect("checked above"));
    let mtime = field("mtime");
    let mtime_present = mtime.is_some_and(|value| !value.is_null());
    let mtime_number = mtime.map(js_number).unwrap_or(f64::NAN);
    let force = field("force").is_some_and(js_truthy);
    let backups = state.backups_dir.clone();
    blocking(move || {
        write_response(
            &path,
            &content,
            mtime_present,
            mtime_number,
            force,
            &backups,
        )
    })
    .await
}

fn write_response(
    path: &str,
    content: &Value,
    mtime_present: bool,
    mtime_number: f64,
    force: bool,
    backups: &Path,
) -> Response {
    let target = Path::new(path);
    let expected = mtime_present.then_some(mtime_number);
    // Guard 1, before the backup: a stale save creates no backup.
    match stale(target, expected, force) {
        Ok(true) => return write_payload(json!({ "ok": false, "error": "changed on disk" })),
        Ok(false) => {}
        Err(error) => return failure(StatusCode::BAD_REQUEST, &error.to_string()),
    }
    if let Some(parent) = target.parent() {
        if let Err(error) = fs::create_dir_all(parent) {
            return failure(StatusCode::BAD_REQUEST, &error.to_string());
        }
    }
    // Best effort: any backup failure is swallowed and the save continues.
    let _ = crate::memory_backup::backup_file(path, target, backups);
    // Guard 2, after the backup: covers a concurrent save landing in between.
    match stale(target, expected, force) {
        Ok(true) => return write_payload(json!({ "ok": false, "error": "changed on disk" })),
        Ok(false) => {}
        Err(error) => return failure(StatusCode::BAD_REQUEST, &error.to_string()),
    }
    write_payload(crate::explorer_fs::write(
        Some(path),
        content,
        expected,
        force,
    ))
}

fn write_payload(value: Value) -> Response {
    let status = if value.get("ok").and_then(Value::as_bool) == Some(true) {
        StatusCode::OK
    } else if value.get("error").and_then(Value::as_str) == Some("changed on disk") {
        StatusCode::CONFLICT
    } else {
        StatusCode::BAD_REQUEST
    };
    payload(status, value)
}

// VERIFY: fs-entry-routes
async fn create_entry(request: Request<Body>) -> Response {
    let body = match crate::http_body::parse(request).await {
        Ok(body) => body,
        Err(response) => return response,
    };
    let field = |name: &str| body.as_object().and_then(|object| object.get(name));
    let Some(path) = field("path")
        .and_then(Value::as_str)
        .filter(|path| !bad_path(path))
        .map(str::to_owned)
    else {
        return failure(StatusCode::BAD_REQUEST, "bad path");
    };
    let kind = field("kind").and_then(Value::as_str).map(str::to_owned);
    let result =
        blocking_value(move || crate::explorer_fs::create(Some(path.as_str()), kind.as_deref()))
            .await;
    entry_payload(result)
}

async fn delete_entry(RawQuery(query): RawQuery) -> Response {
    let Some(path) = single_path(query.as_deref()) else {
        return failure(StatusCode::BAD_REQUEST, "bad path");
    };
    let result = blocking_value(move || crate::explorer_fs::delete(Some(path.as_str()))).await;
    not_found_payload(result)
}

// VERIFY: fs-rename-route
async fn rename_entry(request: Request<Body>) -> Response {
    let body = match crate::http_body::parse(request).await {
        Ok(body) => body,
        Err(response) => return response,
    };
    let field = |name: &str| body.as_object().and_then(|object| object.get(name));
    let valid = |value: Option<&Value>| {
        value
            .and_then(Value::as_str)
            .is_some_and(|path| !bad_path(path))
    };
    let (from, to) = (field("from"), field("to"));
    if !valid(from) || !valid(to) {
        return failure(StatusCode::BAD_REQUEST, "bad path");
    }
    let from = from.and_then(Value::as_str).expect("validated").to_owned();
    let to = to.and_then(Value::as_str).expect("validated").to_owned();
    let result =
        blocking_value(move || crate::explorer_fs::rename(Some(from.as_str()), Some(to.as_str())))
            .await;
    not_found_payload(result)
}

fn entry_payload(value: Value) -> Response {
    let status = if value.get("ok").and_then(Value::as_bool) == Some(true) {
        StatusCode::OK
    } else {
        StatusCode::BAD_REQUEST
    };
    payload(status, value)
}

fn not_found_payload(value: Value) -> Response {
    if value.get("ok").and_then(Value::as_bool) == Some(true) {
        return payload(StatusCode::OK, value);
    }
    let status = if value.get("error").and_then(Value::as_str) == Some("not found") {
        StatusCode::NOT_FOUND
    } else {
        StatusCode::BAD_REQUEST
    };
    payload(status, value)
}

// VERIFY: fs-state-routes
async fn get_state(State(state): State<Explorer>) -> Response {
    let file = state.state_dir.join(EXPLORER_STATE_FILE);
    let lock = state.lock.clone();
    let result = tokio::task::spawn_blocking(move || {
        let _guard = lock.lock().unwrap_or_else(|error| error.into_inner());
        let file = file.to_string_lossy();
        crate::explorer_state::get(&file)
    })
    .await;
    // Node swallows a bridge failure and serves the default document.
    let stored = result.unwrap_or_else(|_| default_state());
    Json(json!({ "state": stored })).into_response()
}

async fn put_state(State(state): State<Explorer>, request: Request<Body>) -> Response {
    let patch = match crate::http_body::parse(request).await {
        Ok(patch) => patch,
        Err(response) => return response,
    };
    let file = state.state_dir.join(EXPLORER_STATE_FILE);
    let lock = state.lock.clone();
    let result = tokio::task::spawn_blocking(move || {
        let _guard = lock.lock().unwrap_or_else(|error| error.into_inner());
        let file = file.to_string_lossy();
        crate::explorer_state::set(&file, &patch)
    })
    .await;
    match result {
        Ok(value) => Json(value).into_response(),
        Err(_) => {
            Json(json!({ "ok": false, "error": "explorer state write failed" })).into_response()
        }
    }
}

fn default_state() -> Value {
    json!({ "root": "~", "expanded": [], "tabs": [], "active": null, "autosave": false })
}

// VERIFY: fs-write-body-limit
/// Fastify body parsing at the route's 4 MiB `bodyLimit`. This is a local copy
/// of `http_body`'s contract (that module's cap is hard-coded at 1 MiB and is
/// outside this slice's ownership); only the parsed value is needed here.
async fn parse_write_body(request: Request<Body>) -> Result<Value, Response> {
    let kind = media_kind(request.headers());
    let length = request
        .headers()
        .get(header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<usize>().ok());
    if kind == Media::Unsupported
        || (kind == Media::Absent
            && (length.is_some_and(|value| value > 0)
                || request.headers().contains_key(header::TRANSFER_ENCODING)))
    {
        return Err(invalid_media_type());
    }
    if length.is_some_and(|value| value > WRITE_LIMIT) {
        return Err(body_too_large());
    }
    let bytes = match to_bytes(request.into_body(), WRITE_LIMIT).await {
        Ok(bytes) => bytes,
        Err(error) => {
            let limited = error
                .into_inner()
                .downcast_ref::<LengthLimitError>()
                .is_some();
            return Err(if kind == Media::Absent {
                invalid_media_type()
            } else if limited {
                body_too_large()
            } else {
                invalid_json_body()
            });
        }
    };
    let text = String::from_utf8_lossy(&bytes).into_owned();
    if kind != Media::Absent && text.len() > WRITE_LIMIT {
        return Err(body_too_large());
    }
    if kind != Media::Absent && length.is_some_and(|value| value != text.len()) {
        return Err(invalid_content_length());
    }
    match kind {
        Media::Json => {
            if text.is_empty() {
                return Err(empty_json_body());
            }
            let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
            let Ok(value) = serde_json::from_str::<Value>(text) else {
                return Err(invalid_json_body());
            };
            if !prototype_safe(&value) {
                return Err(invalid_json_body());
            }
            Ok(value)
        }
        Media::Plain => Ok(Value::String(text)),
        Media::Absent => Ok(Value::Null),
        Media::Unsupported => Err(invalid_media_type()),
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Media {
    Json,
    Plain,
    Absent,
    Unsupported,
}

fn media_kind(headers: &HeaderMap) -> Media {
    let Some(value) = headers.get(header::CONTENT_TYPE) else {
        return Media::Absent;
    };
    let Ok(value) = value.to_str() else {
        return Media::Unsupported;
    };
    let media = value.split(';').next().unwrap_or("").trim();
    if media.eq_ignore_ascii_case("application/json") {
        Media::Json
    } else if media.eq_ignore_ascii_case("text/plain") {
        Media::Plain
    } else {
        Media::Unsupported
    }
}

fn prototype_safe(value: &Value) -> bool {
    match value {
        Value::Object(map) => map.iter().all(|(key, property)| {
            key != "__proto__"
                && !(key == "constructor"
                    && matches!(property, Value::Object(object) if object.contains_key("prototype")))
                && prototype_safe(property)
        }),
        Value::Array(items) => items.iter().all(prototype_safe),
        _ => true,
    }
}

fn invalid_media_type() -> Response {
    fastify_ctp(
        StatusCode::UNSUPPORTED_MEDIA_TYPE,
        "FST_ERR_CTP_INVALID_MEDIA_TYPE",
        "Unsupported Media Type",
        "Unsupported Media Type",
    )
}

fn invalid_content_length() -> Response {
    fastify_ctp(
        StatusCode::BAD_REQUEST,
        "FST_ERR_CTP_INVALID_CONTENT_LENGTH",
        "Bad Request",
        "Request body size did not match Content-Length",
    )
}

fn empty_json_body() -> Response {
    fastify_ctp(
        StatusCode::BAD_REQUEST,
        "FST_ERR_CTP_EMPTY_JSON_BODY",
        "Bad Request",
        "Body cannot be empty when content-type is set to 'application/json'",
    )
}

fn invalid_json_body() -> Response {
    fastify_ctp(
        StatusCode::BAD_REQUEST,
        "FST_ERR_CTP_INVALID_JSON_BODY",
        "Bad Request",
        "Body is not valid JSON but content-type is set to 'application/json'",
    )
}

fn body_too_large() -> Response {
    fastify_ctp(
        StatusCode::PAYLOAD_TOO_LARGE,
        "FST_ERR_CTP_BODY_TOO_LARGE",
        "Payload Too Large",
        "Request body is too large",
    )
}

// ---------------------------------------------------------------- helpers

async fn blocking<F: FnOnce() -> Response + Send + 'static>(work: F) -> Response {
    tokio::task::spawn_blocking(work)
        .await
        .unwrap_or_else(|_| internal_failure())
}

async fn blocking_value<F: FnOnce() -> Value + Send + 'static>(work: F) -> Value {
    tokio::task::spawn_blocking(work)
        .await
        .unwrap_or_else(|_| json!({ "ok": false, "error": "Internal Server Error" }))
}

fn payload(status: StatusCode, value: Value) -> Response {
    (status, Json(value)).into_response()
}

fn failure(status: StatusCode, message: &str) -> Response {
    payload(status, json!({ "ok": false, "error": message }))
}

fn browse_bad_path() -> Response {
    payload(StatusCode::BAD_REQUEST, json!({ "error": "bad path" }))
}

fn browse_failure(message: &str) -> Response {
    payload(StatusCode::BAD_REQUEST, json!({ "error": message }))
}

fn fastify_failure(status: StatusCode, message: &str) -> Response {
    payload(
        status,
        json!({
            "statusCode": status.as_u16(),
            "error": "Internal Server Error",
            "message": message,
        }),
    )
}

fn fastify_ctp(status: StatusCode, code: &str, error: &str, message: &str) -> Response {
    payload(
        status,
        json!({
            "statusCode": status.as_u16(),
            "code": code,
            "error": error,
            "message": message,
        }),
    )
}

fn internal_failure() -> Response {
    fastify_failure(StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error")
}

/// A missing, empty or repeated `path` is not the single string `explorer.mjs`
/// accepts.
fn single_path(query: Option<&str>) -> Option<String> {
    match query_values(query.unwrap_or_default(), "path").as_slice() {
        [path] if !bad_path(path) => Some(path.clone()),
        _ => None,
    }
}

/// `bad(p)`: not a string (handled by the caller), empty, or not absolute.
fn bad_path(path: &str) -> bool {
    path.is_empty() || !node_is_absolute(path)
}

/// `path.isAbsolute` (win32: also a rooted path or `X:\`).
fn node_is_absolute(path: &str) -> bool {
    let units: Vec<char> = path.chars().collect();
    let Some(&first) = units.first() else {
        return false;
    };
    let windows = cfg!(windows);
    if first == '/' || (windows && first == '\\') {
        return true;
    }
    windows
        && units.len() > 2
        && first.is_ascii_alphabetic()
        && units[1] == ':'
        && (units[2] == '/' || units[2] == '\\')
}

/// `path.parse(dir).dir` when `dir !== root`, i.e. Rust's parent; `None` at a
/// filesystem root.
fn parent_of(path: &str) -> Option<String> {
    Path::new(path)
        .parent()
        .map(|parent| parent.to_string_lossy().into_owned())
}

/// `path.join(dir, name)` normalised to platform separators.
fn join_path(dir: &str, name: &str) -> String {
    if cfg!(windows) {
        let base = dir.replace('/', "\\");
        let trimmed = base.trim_end_matches('\\');
        if trimmed.is_empty() {
            format!("{base}{name}")
        } else {
            format!("{trimmed}\\{name}")
        }
    } else {
        let trimmed = dir.trim_end_matches('/');
        if trimmed.is_empty() {
            format!("{dir}{name}")
        } else {
            format!("{trimmed}/{name}")
        }
    }
}

/// `path.extname(path).toLowerCase()`; dotfiles have no extension.
fn extname(path: &str) -> String {
    let windows = cfg!(windows);
    let chars: Vec<char> = path.chars().collect();
    let mut start_dot: Option<usize> = None;
    let mut start_part = 0usize;
    let mut end: Option<usize> = None;
    let mut matched_slash = true;
    let mut pre_dot = 0i32;
    let mut index = chars.len();
    while index > 0 {
        index -= 1;
        let character = chars[index];
        if character == '/' || (windows && character == '\\') {
            if !matched_slash {
                start_part = index + 1;
                break;
            }
            continue;
        }
        if end.is_none() {
            matched_slash = false;
            end = Some(index + 1);
        }
        if character == '.' {
            if start_dot.is_none() {
                start_dot = Some(index);
            } else if pre_dot != 1 {
                pre_dot = 1;
            }
        } else if start_dot.is_some() {
            pre_dot = -1;
        }
    }
    let (Some(start_dot), Some(end)) = (start_dot, end) else {
        return String::new();
    };
    if pre_dot == 0 || (pre_dot == 1 && start_dot == end - 1 && start_dot == start_part + 1) {
        return String::new();
    }
    chars[start_dot..end]
        .iter()
        .collect::<String>()
        .to_lowercase()
}

fn is_image(extension: &str) -> bool {
    matches!(
        extension,
        ".png" | ".jpg" | ".jpeg" | ".gif" | ".webp" | ".svg"
    )
}

fn mime_for(extension: &str) -> &'static str {
    match extension {
        ".png" => "image/png",
        ".jpg" | ".jpeg" => "image/jpeg",
        ".gif" => "image/gif",
        ".webp" => "image/webp",
        ".svg" => "image/svg+xml",
        _ => "application/octet-stream",
    }
}

fn make_collator(locale: &str) -> Result<CollatorBorrowed<'static>, String> {
    let locale: Locale = locale
        .parse()
        .map_err(|error| format!("invalid locale: {error}"))?;
    Collator::try_new(locale.into(), CollatorOptions::default()).map_err(|error| error.to_string())
}

/// `existsSync` + `statSync().mtimeMs`, exactly like Node: a missing path never
/// blocks, and the tolerance is strictly `> 1` ms.
fn stale(target: &Path, expected: Option<f64>, force: bool) -> io::Result<bool> {
    if force {
        return Ok(false);
    }
    let Some(expected) = expected else {
        return Ok(false);
    };
    if !target.exists() {
        return Ok(false);
    }
    let metadata = fs::metadata(target)?;
    let Some(actual) = mtime_ms(&metadata) else {
        return Err(io::Error::other("unreadable mtime"));
    };
    Ok((actual - expected).abs() > 1.0)
}

fn mtime_ms(metadata: &fs::Metadata) -> Option<f64> {
    let modified = metadata.modified().ok()?;
    Some(match modified.duration_since(UNIX_EPOCH) {
        Ok(duration) => duration.as_secs_f64() * 1000.0,
        Err(error) => -(error.duration().as_secs_f64() * 1000.0),
    })
}

/// JavaScript `Number(value)` for the `mtime` guard.
fn js_number(value: &Value) -> f64 {
    match value {
        Value::Null => 0.0,
        Value::Bool(value) => {
            if *value {
                1.0
            } else {
                0.0
            }
        }
        Value::Number(number) => number
            .as_f64()
            .unwrap_or_else(|| crate::memory_backup::js_string_to_number(&number.to_string())),
        Value::String(text) => crate::memory_backup::js_string_to_number(text),
        Value::Array(items) if items.is_empty() => 0.0,
        Value::Array(items) if items.len() == 1 => match &items[0] {
            Value::String(text) => crate::memory_backup::js_string_to_number(text),
            Value::Number(_) | Value::Null => js_number(&items[0]),
            _ => f64::NAN,
        },
        Value::Array(_) | Value::Object(_) => f64::NAN,
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

/// JavaScript `trim()` white space (`WhiteSpace` + `LineTerminator`).
fn is_js_whitespace(character: char) -> bool {
    matches!(
        character,
        '\u{0009}' | '\u{000B}' | '\u{000C}' | '\u{0020}' | '\u{00A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
                | '\n'
                | '\r'
    )
}

#[cfg(test)]
mod tests {
    use super::{ARRAY_PATH_MESSAGE, CSP, TRIM_MESSAGE, router};
    use serde_json::{Value, json};
    use std::fs;
    use std::net::{Ipv4Addr, SocketAddr};
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{Duration, SystemTime, UNIX_EPOCH};
    use tokio::sync::oneshot;
    use tokio::task::JoinHandle;

    static SEQ: AtomicU64 = AtomicU64::new(0);

    struct Fixture {
        root: PathBuf,
        state: PathBuf,
        backups: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let unique = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let id = SEQ.fetch_add(1, Ordering::Relaxed);
            let base = std::env::temp_dir().join(format!(
                "singularity-http-fs-{}-{unique}-{id}",
                std::process::id()
            ));
            let root = base.join("files");
            fs::create_dir_all(&root).unwrap();
            Self {
                root,
                state: base.join("state"),
                backups: base.join("backups"),
            }
        }

        fn path(&self, name: &str) -> PathBuf {
            self.root.join(name)
        }

        fn text(path: &Path) -> String {
            path.to_string_lossy().into_owned()
        }

        fn parent_text(&self) -> String {
            Self::text(self.root.parent().unwrap())
        }

        fn bak_contents(&self) -> Vec<Vec<u8>> {
            let mut found = Vec::new();
            let Ok(dirs) = crate::fs_sorted::read_dir(&self.backups) else {
                return found;
            };
            for dir in dirs.flatten() {
                let Ok(files) = crate::fs_sorted::read_dir(dir.path()) else {
                    continue;
                };
                for file in files.flatten() {
                    if file.file_name().to_string_lossy().ends_with(".bak") {
                        found.push(fs::read(file.path()).unwrap());
                    }
                }
            }
            found
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(self.root.parent().unwrap());
        }
    }

    fn run<F: std::future::Future>(future: F) -> F::Output {
        tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(future)
    }

    async fn start(fixture: &Fixture) -> (SocketAddr, oneshot::Sender<()>, JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let address = listener.local_addr().unwrap();
        assert!(address.ip().is_loopback());
        let app = router(
            fixture.state.clone(),
            fixture.backups.clone(),
            "en-US".to_owned(),
        );
        let (stop, stopped) = oneshot::channel::<()>();
        let server = tokio::spawn(async move {
            axum::serve(listener, app)
                .with_graceful_shutdown(async move {
                    let _ = stopped.await;
                })
                .await
                .unwrap();
        });
        (address, stop, server)
    }

    async fn finish(stop: oneshot::Sender<()>, server: JoinHandle<()>) {
        let _ = stop.send(());
        server.await.unwrap();
    }

    fn client() -> reqwest::Client {
        reqwest::Client::builder().no_proxy().build().unwrap()
    }

    fn parse_json(text: &str) -> Value {
        serde_json::from_str(text).unwrap()
    }

    async fn get(address: SocketAddr, path: &str, query: &[(&str, &str)]) -> (u16, String) {
        let response = client()
            .get(format!("http://{address}{path}"))
            .query(query)
            .send()
            .await
            .unwrap();
        (response.status().as_u16(), response.text().await.unwrap())
    }

    async fn send_typed(
        address: SocketAddr,
        method: reqwest::Method,
        path: &str,
        query: &[(&str, &str)],
        content_type: Option<&str>,
        body: String,
    ) -> (u16, String) {
        let mut request = client().request(method, format!("http://{address}{path}"));
        if !query.is_empty() {
            request = request.query(query);
        }
        if let Some(content_type) = content_type {
            request = request.header("content-type", content_type);
        }
        let response = request.body(body).send().await.unwrap();
        (response.status().as_u16(), response.text().await.unwrap())
    }

    async fn send_json(
        address: SocketAddr,
        method: reqwest::Method,
        path: &str,
        body: &str,
    ) -> (u16, String) {
        send_typed(
            address,
            method,
            path,
            &[],
            Some("application/json"),
            body.to_owned(),
        )
        .await
    }

    fn body_for(path: &str, content: &str) -> String {
        json!({ "path": path, "content": content }).to_string()
    }

    /// VERIFY: fs-browse-route
    #[test]
    fn browse_lists_non_dot_directories_with_parent_and_statuses() {
        let fixture = Fixture::new();
        fs::create_dir(fixture.path("adir")).unwrap();
        fs::create_dir(fixture.path("zdir")).unwrap();
        fs::create_dir(fixture.path(".hidden")).unwrap();
        fs::write(fixture.path("file.txt"), "x").unwrap();
        let dir = Fixture::text(&fixture.root);
        let missing = Fixture::text(&fixture.path("absent"));
        run(async {
            let (address, stop, server) = start(&fixture).await;
            let (status, body) = get(address, "/api/fs/browse", &[("path", &dir)]).await;
            assert_eq!(status, 200);
            assert_eq!(
                parse_json(&body),
                json!({ "path": dir, "parent": fixture.parent_text(), "dirs": ["adir", "zdir"] })
            );

            let (status, body) = get(address, "/api/fs/browse", &[]).await;
            assert_eq!(status, 400);
            assert_eq!(parse_json(&body), json!({ "error": "bad path" }));

            let (status, body) = get(address, "/api/fs/browse", &[("path", "relative")]).await;
            assert_eq!(status, 400);
            assert_eq!(parse_json(&body), json!({ "error": "bad path" }));

            let (status, _) = get(address, "/api/fs/browse", &[("path", &missing)]).await;
            assert_eq!(status, 400);

            let (status, body) =
                get(address, "/api/fs/browse", &[("path", &dir), ("path", &dir)]).await;
            assert_eq!(status, 500);
            assert_eq!(parse_json(&body)["message"], ARRAY_PATH_MESSAGE);

            finish(stop, server).await;
        });
    }

    /// VERIFY: fs-list-route
    #[test]
    fn list_sorts_dirs_before_files_keeps_dotfiles_and_rejects_bad_paths() {
        let fixture = Fixture::new();
        let list = fixture.path("list");
        fs::create_dir_all(list.join("zdir")).unwrap();
        fs::create_dir_all(list.join("adir")).unwrap();
        fs::write(list.join("bfile.txt"), "x").unwrap();
        fs::write(list.join(".dotfile"), "x").unwrap();
        let dir = Fixture::text(&list);
        let missing = Fixture::text(&fixture.path("absent"));
        run(async {
            let (address, stop, server) = start(&fixture).await;
            let (status, body) = get(address, "/api/fs/list", &[("path", &dir)]).await;
            assert_eq!(status, 200);
            assert!(
                body.starts_with(r#"{"ok":true,"path":"#),
                "key order: {body}"
            );
            let payload = parse_json(&body);
            assert_eq!(payload["parent"], Fixture::text(&fixture.root));
            assert_eq!(
                payload["entries"],
                json!([
                    { "name": "adir", "type": "dir", "size": 0 },
                    { "name": "zdir", "type": "dir", "size": 0 },
                    { "name": ".dotfile", "type": "file", "size": 1 },
                    { "name": "bfile.txt", "type": "file", "size": 1 },
                ])
            );
            assert_eq!(payload["capped"], false);

            let (status, body) = get(address, "/api/fs/list", &[]).await;
            assert_eq!(status, 400);
            assert_eq!(
                parse_json(&body),
                json!({ "ok": false, "error": "bad path" })
            );

            let (status, _) = get(address, "/api/fs/list", &[("path", "relative")]).await;
            assert_eq!(status, 400);
            let (status, _) = get(address, "/api/fs/list", &[("path", &missing)]).await;
            assert_eq!(status, 400);
            let (status, _) = get(address, "/api/fs/list", &[("path", &dir), ("path", &dir)]).await;
            assert_eq!(status, 400);

            finish(stop, server).await;
        });
    }

    /// VERIFY: fs-search-route
    #[test]
    fn search_matches_names_case_insensitively_and_skips_noise_dirs() {
        let fixture = Fixture::new();
        let root = fixture.path("s");
        fs::create_dir_all(root.join("deep/nest")).unwrap();
        fs::create_dir_all(root.join("node_modules/needle-pkg")).unwrap();
        fs::write(root.join("deep/nest/needle.txt"), "x").unwrap();
        fs::write(root.join("haystack.txt"), "needle").unwrap();
        fs::create_dir(root.join("needle-dir")).unwrap();
        let root_text = Fixture::text(&root);
        run(async {
            let (address, stop, server) = start(&fixture).await;
            let (status, body) = get(
                address,
                "/api/fs/search",
                &[("root", &root_text), ("q", "NEEDLE")],
            )
            .await;
            assert_eq!(status, 200);
            let payload = parse_json(&body);
            assert_eq!(payload["ok"], true);
            assert_eq!(payload["capped"], false);
            let mut hits: Vec<(String, String)> = payload["results"]
                .as_array()
                .unwrap()
                .iter()
                .map(|hit| {
                    (
                        hit["name"].as_str().unwrap().to_owned(),
                        hit["type"].as_str().unwrap().to_owned(),
                    )
                })
                .collect();
            hits.sort();
            assert_eq!(
                hits,
                vec![
                    ("needle-dir".to_owned(), "dir".to_owned()),
                    ("needle.txt".to_owned(), "file".to_owned()),
                ]
            );

            let (status, body) = get(
                address,
                "/api/fs/search",
                &[("root", &root_text), ("q", "  ")],
            )
            .await;
            assert_eq!(status, 200);
            assert_eq!(
                parse_json(&body),
                json!({ "ok": true, "results": [], "capped": false })
            );

            let (status, body) = get(
                address,
                "/api/fs/search",
                &[("root", &root_text), ("q", "a"), ("q", "b")],
            )
            .await;
            assert_eq!(status, 500);
            assert_eq!(parse_json(&body)["message"], TRIM_MESSAGE);

            let (status, body) = get(
                address,
                "/api/fs/search",
                &[("root", "relative"), ("q", "x")],
            )
            .await;
            assert_eq!(status, 400);
            assert_eq!(
                parse_json(&body),
                json!({ "ok": false, "error": "bad path" })
            );

            let (status, _) = get(
                address,
                "/api/fs/search",
                &[("root", &root_text), ("root", &root_text), ("q", "x")],
            )
            .await;
            assert_eq!(status, 400);

            finish(stop, server).await;
        });
    }

    /// VERIFY: fs-search-cap
    #[test]
    fn search_caps_hits_at_three_hundred() {
        let fixture = Fixture::new();
        let root = fixture.path("many");
        fs::create_dir(&root).unwrap();
        for index in 0..301 {
            fs::write(root.join(format!("needle-{index}.txt")), "x").unwrap();
        }
        let root_text = Fixture::text(&root);
        run(async {
            let (address, stop, server) = start(&fixture).await;
            let (status, body) = get(
                address,
                "/api/fs/search",
                &[("root", &root_text), ("q", "needle")],
            )
            .await;
            assert_eq!(status, 200);
            let payload = parse_json(&body);
            assert_eq!(payload["results"].as_array().unwrap().len(), 300);
            assert_eq!(payload["capped"], true);
            finish(stop, server).await;
        });
    }

    /// VERIFY: fs-read-route
    #[test]
    fn read_classifies_text_image_binary_and_toolarge() {
        let fixture = Fixture::new();
        fs::write(fixture.path("t.txt"), "hello world").unwrap();
        fs::write(fixture.path("pic.png"), [1u8, 2, 3]).unwrap();
        fs::write(fixture.path("bin.dat"), [1u8, 0, 2]).unwrap();
        fs::write(fixture.path("big.dat"), vec![b'x'; 2 * 1024 * 1024 + 1]).unwrap();
        let text = Fixture::text(&fixture.path("t.txt"));
        let image = Fixture::text(&fixture.path("pic.png"));
        let binary = Fixture::text(&fixture.path("bin.dat"));
        let large = Fixture::text(&fixture.path("big.dat"));
        let missing = Fixture::text(&fixture.path("absent.txt"));
        run(async {
            let (address, stop, server) = start(&fixture).await;
            let (status, body) = get(address, "/api/fs/read", &[("path", &text)]).await;
            assert_eq!(status, 200);
            assert!(
                body.starts_with(r#"{"ok":true,"kind":"text","size":11,"mtime":"#),
                "key order: {body}"
            );
            let payload = parse_json(&body);
            assert_eq!(payload["content"], "hello world");
            assert!(payload["mtime"].as_f64().is_some());

            let (status, body) = get(address, "/api/fs/read", &[("path", &image)]).await;
            assert_eq!(status, 200);
            assert_eq!(parse_json(&body)["kind"], "image");
            assert!(parse_json(&body).get("content").is_none());

            let (status, body) = get(address, "/api/fs/read", &[("path", &binary)]).await;
            assert_eq!(status, 200);
            assert_eq!(parse_json(&body)["kind"], "binary");

            let (status, body) = get(address, "/api/fs/read", &[("path", &large)]).await;
            assert_eq!(status, 200);
            assert_eq!(parse_json(&body)["kind"], "toolarge");

            let (status, body) = get(address, "/api/fs/read", &[("path", &missing)]).await;
            assert_eq!(status, 404);
            assert_eq!(
                parse_json(&body),
                json!({ "ok": false, "error": "not found" })
            );

            let (status, body) = get(address, "/api/fs/read", &[("path", "relative")]).await;
            assert_eq!(status, 400);
            assert_eq!(
                parse_json(&body),
                json!({ "ok": false, "error": "bad path" })
            );
            let (status, _) =
                get(address, "/api/fs/read", &[("path", &text), ("path", &text)]).await;
            assert_eq!(status, 400);

            finish(stop, server).await;
        });
    }

    /// VERIFY: fs-raw-route
    #[test]
    fn raw_serves_bytes_with_nosniff_and_csp_and_maps_errors() {
        let fixture = Fixture::new();
        fs::write(fixture.path("pic.png"), [1u8, 2, 3]).unwrap();
        fs::write(fixture.path("note.bin"), [9u8]).unwrap();
        let image = Fixture::text(&fixture.path("pic.png"));
        let opaque = Fixture::text(&fixture.path("note.bin"));
        let missing = Fixture::text(&fixture.path("absent.png"));
        let directory = Fixture::text(&fixture.root);
        run(async {
            let (address, stop, server) = start(&fixture).await;
            let response = client()
                .get(format!("http://{address}/api/fs/raw"))
                .query(&[("path", image.as_str())])
                .send()
                .await
                .unwrap();
            assert_eq!(response.status().as_u16(), 200);
            let headers = response.headers().clone();
            assert_eq!(headers["content-type"].to_str().unwrap(), "image/png");
            assert_eq!(
                headers["x-content-type-options"].to_str().unwrap(),
                "nosniff"
            );
            assert_eq!(headers["content-security-policy"].to_str().unwrap(), CSP);
            assert_eq!(response.bytes().await.unwrap().to_vec(), vec![1u8, 2, 3]);

            let response = client()
                .get(format!("http://{address}/api/fs/raw"))
                .query(&[("path", opaque.as_str())])
                .send()
                .await
                .unwrap();
            assert_eq!(response.status().as_u16(), 200);
            assert_eq!(
                response.headers()["content-type"].to_str().unwrap(),
                "application/octet-stream"
            );

            let (status, body) = get(address, "/api/fs/raw", &[("path", &missing)]).await;
            assert_eq!(status, 404);
            assert_eq!(
                parse_json(&body),
                json!({ "ok": false, "error": "not found" })
            );

            let (status, body) = get(address, "/api/fs/raw", &[("path", "relative")]).await;
            assert_eq!(status, 400);
            assert_eq!(
                parse_json(&body),
                json!({ "ok": false, "error": "bad path" })
            );

            let (status, body) = get(address, "/api/fs/raw", &[("path", &directory)]).await;
            assert_eq!(status, 400);
            assert_eq!(parse_json(&body)["ok"], false);
            assert!(
                parse_json(&body)["error"]
                    .as_str()
                    .is_some_and(|text| !text.is_empty())
            );

            finish(stop, server).await;
        });
    }

    fn mtime_of(body: &str) -> f64 {
        parse_json(body)["mtime"].as_f64().unwrap()
    }

    /// VERIFY: fs-write-route
    #[test]
    fn write_creates_parents_backs_up_and_guards_mtime() {
        let fixture = Fixture::new();
        let target = fixture.path("newdir/sub/f.txt");
        let target_text = Fixture::text(&target);
        let existing = fixture.path("existing.txt");
        let existing_text = Fixture::text(&existing);
        fs::write(&existing, "prior-success-bytes").unwrap();
        run(async {
            let (address, stop, server) = start(&fixture).await;
            let (status, body) = send_json(
                address,
                reqwest::Method::PUT,
                "/api/fs/write",
                &body_for(&target_text, "content here"),
            )
            .await;
            assert_eq!(status, 200);
            assert!(
                body.starts_with(r#"{"ok":true,"mtime":"#),
                "key order: {body}"
            );
            assert_eq!(fs::read_to_string(&target).unwrap(), "content here");

            // Overwriting an existing file stores the prior bytes once.
            let (status, _) = send_json(
                address,
                reqwest::Method::PUT,
                "/api/fs/write",
                &body_for(&existing_text, "replacement"),
            )
            .await;
            assert_eq!(status, 200);
            assert!(
                fixture
                    .bak_contents()
                    .contains(&b"prior-success-bytes".to_vec())
            );

            // Conditional save: a matching mtime passes, a stale one is a 409.
            let (_, read_body) = get(address, "/api/fs/read", &[("path", &existing_text)]).await;
            let opened = mtime_of(&read_body);
            let matching = format!(
                r#"{{"path":{},"content":"matched","mtime":{opened}}}"#,
                serde_json::to_string(&existing_text).unwrap()
            );
            assert_eq!(
                send_json(address, reqwest::Method::PUT, "/api/fs/write", &matching)
                    .await
                    .0,
                200
            );

            std::thread::sleep(Duration::from_millis(20));
            fs::write(&existing, "notepad wrote this").unwrap();
            let stale = format!(
                r#"{{"path":{},"content":"v3","mtime":{opened}}}"#,
                serde_json::to_string(&existing_text).unwrap()
            );
            let (status, body) =
                send_json(address, reqwest::Method::PUT, "/api/fs/write", &stale).await;
            assert_eq!(status, 409);
            assert_eq!(
                parse_json(&body),
                json!({ "ok": false, "error": "changed on disk" })
            );
            assert_eq!(fs::read_to_string(&existing).unwrap(), "notepad wrote this");

            let forced = format!(
                r#"{{"path":{},"content":"forced","mtime":{opened},"force":true}}"#,
                serde_json::to_string(&existing_text).unwrap()
            );
            assert_eq!(
                send_json(address, reqwest::Method::PUT, "/api/fs/write", &forced)
                    .await
                    .0,
                200
            );
            assert_eq!(fs::read_to_string(&existing).unwrap(), "forced");

            // Invalid content still creates the parent and backs the old bytes up.
            let invalid_target = fixture.path("invalid-parent/bad.txt");
            let invalid_text = Fixture::text(&invalid_target);
            let invalid = format!(
                r#"{{"path":{},"content":17}}"#,
                serde_json::to_string(&invalid_text).unwrap()
            );
            let (status, body) =
                send_json(address, reqwest::Method::PUT, "/api/fs/write", &invalid).await;
            assert_eq!(status, 400);
            assert_eq!(
                parse_json(&body),
                json!({ "ok": false, "error": "content must be a string" })
            );
            assert!(invalid_target.parent().unwrap().is_dir());

            let (status, body) = send_json(
                address,
                reqwest::Method::PUT,
                "/api/fs/write",
                &json!({ "path": target_text }).to_string(),
            )
            .await;
            assert_eq!(status, 400);
            assert_eq!(
                parse_json(&body),
                json!({ "ok": false, "error": "path + content required" })
            );

            let (status, body) = send_json(
                address,
                reqwest::Method::PUT,
                "/api/fs/write",
                &body_for("relative", "x"),
            )
            .await;
            assert_eq!(status, 400);
            assert_eq!(
                parse_json(&body),
                json!({ "ok": false, "error": "bad path" })
            );

            let (status, _) = send_typed(
                address,
                reqwest::Method::PUT,
                "/api/fs/write",
                &[],
                Some("text/plain"),
                body_for(&target_text, "x"),
            )
            .await;
            assert_eq!(status, 400);
            let (status, _) = send_typed(
                address,
                reqwest::Method::PUT,
                "/api/fs/write",
                &[],
                None,
                String::new(),
            )
            .await;
            assert_eq!(status, 400);

            finish(stop, server).await;
        });
    }

    /// VERIFY: fs-write-body-limit
    #[test]
    fn write_accepts_four_mib_and_rejects_one_byte_more() {
        let fixture = Fixture::new();
        let target = fixture.path("limit.txt");
        let target_text = Fixture::text(&target);
        let prefix = format!(
            r#"{{"path":{},"content":""#,
            serde_json::to_string(&target_text).unwrap()
        );
        let suffix = r#""}"#;
        let overhead = prefix.len() + suffix.len();
        let at_limit = format!("{prefix}{}{suffix}", "x".repeat(4 * 1024 * 1024 - overhead));
        assert_eq!(at_limit.len(), 4 * 1024 * 1024);
        run(async {
            let (address, stop, server) = start(&fixture).await;
            let (status, _) =
                send_json(address, reqwest::Method::PUT, "/api/fs/write", &at_limit).await;
            assert_eq!(status, 200);
            assert_eq!(
                fs::metadata(&target).unwrap().len() as usize,
                4 * 1024 * 1024 - overhead
            );

            // A declared Content-Length above the route limit is rejected before
            // the body is read (a live client would see the socket close on the
            // unread payload, so exercise the parser directly).
            let request = axum::http::Request::builder()
                .method("PUT")
                .uri("/api/fs/write")
                .header("content-type", "application/json")
                .header("content-length", (4 * 1024 * 1024 + 1).to_string())
                .body(axum::body::Body::empty())
                .unwrap();
            let response = super::parse_write_body(request).await.unwrap_err();
            assert_eq!(response.status().as_u16(), 413);
            let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
                .await
                .unwrap();
            let payload: Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(payload["code"], "FST_ERR_CTP_BODY_TOO_LARGE");
            assert_eq!(payload["message"], "Request body is too large");

            finish(stop, server).await;
        });
    }

    /// VERIFY: fs-entry-routes
    #[test]
    fn entry_routes_keep_node_statuses() {
        let fixture = Fixture::new();
        let existing = fixture.path("exists.txt");
        let existing_text = Fixture::text(&existing);
        fs::write(&existing, "x").unwrap();
        let dir = fixture.path("created-dir");
        let dir_text = Fixture::text(&dir);
        let file = fixture.path("created-file.txt");
        let file_text = Fixture::text(&file);
        let renamed = fixture.path("renamed.txt");
        let renamed_text = Fixture::text(&renamed);
        let missing = Fixture::text(&fixture.path("nope.txt"));
        run(async {
            let (address, stop, server) = start(&fixture).await;

            let (status, body) = send_json(
                address,
                reqwest::Method::POST,
                "/api/fs/entry",
                &json!({ "path": existing_text, "kind": "file" }).to_string(),
            )
            .await;
            assert_eq!(status, 400);
            assert_eq!(
                parse_json(&body),
                json!({ "ok": false, "error": "already exists" })
            );

            let (status, body) = send_json(
                address,
                reqwest::Method::POST,
                "/api/fs/entry",
                &json!({ "path": dir_text, "kind": "dir" }).to_string(),
            )
            .await;
            assert_eq!(status, 200);
            assert_eq!(parse_json(&body), json!({ "ok": true }));
            assert!(dir.is_dir());

            let (status, _) = send_json(
                address,
                reqwest::Method::POST,
                "/api/fs/entry",
                &json!({ "path": file_text, "kind": "file" }).to_string(),
            )
            .await;
            assert_eq!(status, 200);
            assert_eq!(fs::read_to_string(&file).unwrap(), "");

            let (status, body) = send_json(
                address,
                reqwest::Method::POST,
                "/api/fs/entry",
                &json!({ "path": "relative" }).to_string(),
            )
            .await;
            assert_eq!(status, 400);
            assert_eq!(
                parse_json(&body),
                json!({ "ok": false, "error": "bad path" })
            );

            let (status, body) = send_typed(
                address,
                reqwest::Method::DELETE,
                "/api/fs/entry",
                &[("path", &dir_text)],
                None,
                String::new(),
            )
            .await;
            assert_eq!(status, 200);
            assert_eq!(parse_json(&body), json!({ "ok": true }));
            assert!(!dir.exists());

            let (status, body) = send_typed(
                address,
                reqwest::Method::DELETE,
                "/api/fs/entry",
                &[("path", &dir_text)],
                None,
                String::new(),
            )
            .await;
            assert_eq!(status, 404);
            assert_eq!(
                parse_json(&body),
                json!({ "ok": false, "error": "not found" })
            );
            let (status, _) = send_typed(
                address,
                reqwest::Method::DELETE,
                "/api/fs/entry",
                &[("path", "relative")],
                None,
                String::new(),
            )
            .await;
            assert_eq!(status, 400);

            let (status, body) = send_json(
                address,
                reqwest::Method::PATCH,
                "/api/fs/rename",
                &json!({ "from": existing_text, "to": existing_text }).to_string(),
            )
            .await;
            assert_eq!(status, 400);
            assert_eq!(
                parse_json(&body),
                json!({ "ok": false, "error": "already exists" })
            );

            let (status, body) = send_json(
                address,
                reqwest::Method::PATCH,
                "/api/fs/rename",
                &json!({ "from": missing, "to": renamed_text }).to_string(),
            )
            .await;
            assert_eq!(status, 404);
            assert_eq!(
                parse_json(&body),
                json!({ "ok": false, "error": "not found" })
            );

            let (status, body) = send_json(
                address,
                reqwest::Method::PATCH,
                "/api/fs/rename",
                &json!({ "from": existing_text, "to": renamed_text }).to_string(),
            )
            .await;
            assert_eq!(status, 200);
            assert_eq!(parse_json(&body), json!({ "ok": true }));
            assert!(renamed.is_file());

            let (status, _) = send_json(
                address,
                reqwest::Method::PATCH,
                "/api/fs/rename",
                &json!({ "from": "relative", "to": renamed_text }).to_string(),
            )
            .await;
            assert_eq!(status, 400);

            finish(stop, server).await;
        });
    }

    /// VERIFY: fs-state-routes
    #[test]
    fn state_serves_defaults_and_persists_patches() {
        let fixture = Fixture::new();
        let file = fixture.state.join("explorer-state.json");
        let defaults = json!({ "state": {
            "root": "~", "expanded": [], "tabs": [], "active": null, "autosave": false
        }});
        run(async {
            let (address, stop, server) = start(&fixture).await;
            assert_eq!(
                get(address, "/api/fs/state", &[]).await,
                (200, defaults.to_string())
            );

            let (status, body) = send_json(
                address,
                reqwest::Method::PUT,
                "/api/fs/state",
                &json!({ "root": "/x", "autosave": true }).to_string(),
            )
            .await;
            assert_eq!(status, 200);
            let saved = parse_json(&body);
            assert_eq!(saved["ok"], true);
            assert_eq!(saved["state"]["root"], "/x");
            assert_eq!(saved["state"]["autosave"], true);
            assert!(file.is_file());

            let (status, body) = get(address, "/api/fs/state", &[]).await;
            assert_eq!(status, 200);
            assert_eq!(parse_json(&body), json!({ "state": saved["state"] }));

            // A null patch is a no-op that still reports the current state.
            let (status, body) = send_typed(
                address,
                reqwest::Method::PUT,
                "/api/fs/state",
                &[],
                Some("application/json"),
                "null".to_owned(),
            )
            .await;
            assert_eq!(status, 200);
            assert_eq!(parse_json(&body)["state"]["root"], "/x");

            finish(stop, server).await;
        });

        fs::create_dir_all(&fixture.state).unwrap();
        fs::write(&file, "{ malformed").unwrap();
        run(async {
            let (address, stop, server) = start(&fixture).await;
            assert_eq!(
                get(address, "/api/fs/state", &[]).await,
                (200, defaults.to_string())
            );
            finish(stop, server).await;
        });
    }
}
