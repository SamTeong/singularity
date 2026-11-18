//! Rules editor HTTP surface: `GET`/`PUT /api/rules/roots`, `POST /api/rules/files`,
//! `POST /api/rules/search`, `GET`/`PUT /api/rules/file`, `GET /api/rules/reference`,
//! mirroring `server/index.mjs:765-776` -> `server/rules.mjs` and the Node bridge
//! wrappers in `server/rust-backend.mjs` (`ruleFiles` 507, `ruleSearch` 511,
//! `ruleWrite` 520, `ruleReference` 503).
//!
//! The host injects the state dir (`SINGULARITY_HOME/state`), home, cwd, Node's
//! per-drive cwd values, the configured companion-reference dir
//! (`SING_RULES_REF` or `<home>/.agents/rules-reference`) and two locks; this module
//! reads no process env. `lock` serializes the persisted root file and `file_lock`
//! stands in for the single Node->Rust bridge queue that serializes every rules
//! list/search/read/write/reference call.
//!
//! Parity contract:
//!   * Roots live in `rules-roots.json`; `picker_roots` gives the default `["~"]`,
//!     the 50-entry cap and the dedupe-by-UTF-16 order.
//!   * Scan pairs keep the verbatim client base as `root` and pass
//!     `resolve(join(resolveRoot(base), '.claude/rules'))` as `dir`. Bases that are
//!     not non-empty strings, or that cannot be spelled as UTF-16, drop silently.
//!   * `rules::list_files` returns readdir order (no sort, exactly like the bridge).
//!     Search snippets are sliced to 200 UTF-16 units, as `ruleSearch` does.
//!   * `isRulePath` = resolve, `.md` (case-insensitive) and containment under one
//!     configured `<base>/.claude/rules`; the read itself uses the client's raw path.
//!   * A rules write never takes a backup (`writeRuleFile` does not call it) and maps
//!     `changed on disk` to 409, everything else to 400.
//!   * Reference lookups answer 404 only for the exact `no reference` error.
//!
//! Parity limits, reported rather than approximated:
//!   * A field whose JSON token holds an escaped lone surrogate cannot cross the
//!     Node->Rust bridge; such a write or read is reported with the bridge's own
//!     message instead of reproducing the bridge teardown.
//!   * Filesystem failure text is Rust's `io::Error` text, not Node's `e.message`.
//!   * Replies keep each stored root token's original spelling, while Node
//!     re-serializes the parsed array (escapes, inner whitespace and hand-edited
//!     numbers such as `1e999` can differ in bytes).
use crate::http_body::{RawBody, parse_raw};
use crate::http_hooks::{PathEnv, js_number_text, js_truthy, js_value_number, roots_router};
use crate::http_policy::query_values;
use crate::transcripts::TranscriptRawText;
use axum::body::Body;
use axum::extract::{RawQuery, State};
use axum::http::{Request, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::value::RawValue;
use serde_json::{Value, json};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

const RULES_ROOTS_FILE: &str = "rules-roots.json";
const RULES_SUBDIR: &str = ".claude/rules";
const SEARCH_SLICE: usize = 200;
const OUTSIDE: &str = "path outside rule roots";
const NOT_FOUND: &str = "not found";
const REQUIRED: &str = "path + content required";
const CHANGED: &str = "changed on disk";
const CONTENT_TYPE_ERROR: &str = "content must be a string";
const FILES_FAILED: &str = "rules files backend unavailable";
const SEARCH_FAILED: &str = "rules search backend unavailable";
const WRITE_FAILED: &str = "rules write backend unavailable";
const REFERENCE_FAILED: &str = "rules reference backend unavailable";

#[derive(Clone)]
struct Rules {
    state_dir: PathBuf,
    paths: PathEnv,
    reference_dir: PathBuf,
    lock: Arc<Mutex<()>>,
    file_lock: Arc<Mutex<()>>,
}

// VERIFY: rules-router-injection
/// Returns the whole `/api/rules` subtree. Pass the same `file_lock` the host gives
/// `http_hooks::router` to mirror Node's single bridge queue.
pub fn router(
    state_dir: PathBuf,
    home: PathBuf,
    cwd: PathBuf,
    drive_cwds: Vec<(u16, PathBuf)>,
    reference_dir: PathBuf,
    lock: Arc<Mutex<()>>,
    file_lock: Arc<Mutex<()>>,
) -> Router {
    Router::new()
        // VERIFY: rules-roots-route
        .merge(roots_router(
            "/api/rules/roots",
            RULES_ROOTS_FILE,
            state_dir.clone(),
            lock.clone(),
        ))
        .merge(
            Router::new()
                .route("/api/rules/files", post(files))
                .route("/api/rules/search", post(search))
                .route("/api/rules/file", get(get_file).put(put_file))
                .route("/api/rules/reference", get(get_reference))
                .with_state(Rules {
                    state_dir,
                    paths: PathEnv::new(home, cwd, drive_cwds),
                    reference_dir,
                    lock,
                    file_lock,
                }),
        )
}

// VERIFY: rules-files-route
/// `POST /api/rules/files` -> `ruleFiles(scanRoots(body.roots))`; a scanning throw is
/// the handler's own 500 `rules files backend unavailable`.
async fn files(State(state): State<Rules>, request: Request<Body>) -> Response {
    let body = match parse_raw(request).await {
        Ok(body) => body,
        Err(response) => return response,
    };
    let roots = match roots_list(&body.value, FILES_FAILED) {
        Ok(roots) => roots,
        Err(response) => return response,
    };
    tokio::task::spawn_blocking(move || {
        let _guard = lock(&state.file_lock);
        let scans = scan_roots(&state, &roots);
        Json(crate::rules::list_files(&Value::Array(scans))).into_response()
    })
    .await
    .unwrap_or_else(|_| unavailable(FILES_FAILED))
}

// VERIFY: rules-search-route
/// `POST /api/rules/search` -> `ruleSearch(scanRoots(body.roots), q)`; `q` reaches
/// `rules::search` as-is, so a non-string query searches for nothing.
async fn search(State(state): State<Rules>, request: Request<Body>) -> Response {
    let body = match parse_raw(request).await {
        Ok(body) => body,
        Err(response) => return response,
    };
    let roots = match roots_list(&body.value, SEARCH_FAILED) {
        Ok(roots) => roots,
        Err(response) => return response,
    };
    let query = body
        .value
        .as_object()
        .and_then(|object| object.get("q"))
        .cloned()
        .unwrap_or(Value::Null);
    tokio::task::spawn_blocking(move || {
        let _guard = lock(&state.file_lock);
        let scans = scan_roots(&state, &roots);
        let payload = crate::rules::search(&Value::Array(scans), &query);
        search_response(payload)
    })
    .await
    .unwrap_or_else(|_| unavailable(SEARCH_FAILED))
}

/// `scanRoots`: a pair per picked base, with the client's own spelling kept as
/// `root`. Non-strings, empties and bases Rust cannot spell as UTF-16 drop silently.
fn scan_roots(state: &Rules, roots: &[Value]) -> Vec<Value> {
    roots
        .iter()
        .filter_map(|raw| {
            let raw = raw.as_str().filter(|raw| !raw.is_empty())?;
            let dir = state
                .paths
                .base_dir(&raw.encode_utf16().collect::<Vec<_>>(), RULES_SUBDIR)?;
            let dir = String::from_utf16(&dir).ok()?;
            Some(json!({ "root": raw, "dir": dir }))
        })
        .collect()
}

/// `for (const raw of roots || [])`: absent and falsy roots list nothing, a truthy
/// non-array throws inside the handler's try block and maps to its 500 body.
fn roots_list(value: &Value, error: &str) -> Result<Vec<Value>, Response> {
    match value.as_object().and_then(|object| object.get("roots")) {
        Some(Value::Array(items)) => Ok(items.clone()),
        Some(other) if js_truthy(other) => Err(unavailable(error)),
        _ => Ok(Vec::new()),
    }
}

/// Relay `rules::search` after the bridge's `text.slice(0, 200)` trim, keeping a
/// split surrogate pair as the lone unit JavaScript produces.
fn search_response(payload: Value) -> Response {
    let Ok(payload) = serde_json::from_value::<SearchPayload>(payload) else {
        return unavailable(SEARCH_FAILED);
    };
    let mut results = Vec::with_capacity(payload.results.len());
    for hit in payload.results {
        let Some(text) = slice_units(&hit.text) else {
            return unavailable(SEARCH_FAILED);
        };
        results.push(SearchHit {
            root: hit.root,
            path: hit.path,
            rel: hit.rel,
            file: hit.file,
            line: hit.line,
            text,
        });
    }
    Json(SearchReply {
        results,
        capped: payload.capped,
    })
    .into_response()
}

#[derive(serde::Deserialize)]
struct SearchPayload {
    #[serde(default)]
    results: Vec<SearchPayloadHit>,
    #[serde(default)]
    capped: bool,
}

#[derive(serde::Deserialize)]
struct SearchPayloadHit {
    root: String,
    path: String,
    rel: String,
    file: String,
    line: u64,
    text: String,
}

#[derive(serde::Serialize)]
struct SearchReply {
    results: Vec<SearchHit>,
    capped: bool,
}

#[derive(serde::Serialize)]
struct SearchHit {
    root: String,
    path: String,
    rel: String,
    file: String,
    line: u64,
    text: TranscriptRawText,
}

fn slice_units(text: &str) -> Option<TranscriptRawText> {
    let token = serde_json::to_string(text).ok()?;
    TranscriptRawText::from_json_token(token)
        .ok()?
        .slice_units(0, SEARCH_SLICE)
        .ok()
}

// VERIFY: rules-file-read
/// `GET /api/rules/file` -> `readRuleFile(query.path)`: outside roots is a 400, a
/// missing file a 404, any other read failure a 400 with its own message.
async fn get_file(State(state): State<Rules>, RawQuery(query): RawQuery) -> Response {
    tokio::task::spawn_blocking(move || get_file_blocking(&state, query.as_deref()))
        .await
        .unwrap_or_else(|_| unavailable(FILES_FAILED))
}

fn get_file_blocking(state: &Rules, query: Option<&str>) -> Response {
    let raw = match path_param(query) {
        PathParam::Absent => return failure(StatusCode::BAD_REQUEST, OUTSIDE),
        PathParam::Array => return invalid_path_argument(&Value::Array(Vec::new())),
        PathParam::One(value) if value.is_empty() => {
            return failure(StatusCode::BAD_REQUEST, OUTSIDE);
        }
        PathParam::One(value) => value,
    };
    if !is_rule_path(state, &raw.encode_utf16().collect::<Vec<_>>()) {
        return failure(StatusCode::BAD_REQUEST, OUTSIDE);
    }
    let _guard = lock(&state.file_lock);
    let path = Path::new(&raw);
    if !path.exists() {
        return failure(StatusCode::NOT_FOUND, NOT_FOUND);
    }
    let read = fs::read(path);
    let modified = fs::metadata(path).and_then(|metadata| metadata.modified());
    match (read, modified) {
        (Ok(bytes), Ok(modified)) => {
            let content = String::from_utf8_lossy(&bytes);
            let Ok(mtime) = RawValue::from_string(js_number_text(system_time_ms(modified))) else {
                return internal_error();
            };
            Json(ReadOk {
                ok: true,
                content: &content,
                mtime: &mtime,
            })
            .into_response()
        }
        (Err(error), _) | (_, Err(error)) => failure(StatusCode::BAD_REQUEST, &error.to_string()),
    }
}

#[derive(serde::Serialize)]
struct ReadOk<'a> {
    ok: bool,
    content: &'a str,
    // `mtime` stays a JSON number; its text follows ECMAScript number rules.
    mtime: &'a RawValue,
}

// VERIFY: rules-file-write
/// `PUT /api/rules/file` -> `createRuleWriteHandler`: required fields, the Node-side
/// `isRulePath` authorization, then `rules::write_file` with the bridge's coercions.
async fn put_file(State(state): State<Rules>, request: Request<Body>) -> Response {
    let body = match parse_raw(request).await {
        Ok(body) => body,
        Err(response) => return response,
    };
    tokio::task::spawn_blocking(move || put_file_blocking(&state, body))
        .await
        .unwrap_or_else(|_| unavailable(WRITE_FAILED))
}

fn put_file_blocking(state: &Rules, body: RawBody) -> Response {
    let object = body.value.as_object();
    let path = object.and_then(|object| object.get("path"));
    let content = object.and_then(|object| object.get("content"));
    if path.is_none_or(Value::is_null) || content.is_none_or(Value::is_null) {
        return failure(StatusCode::BAD_REQUEST, REQUIRED);
    }
    let path = path.expect("checked above");
    let Some(raw) = path.as_str() else {
        // `isRulePath` rejects falsy values before `resolve` can throw.
        if js_truthy(path) {
            return invalid_path_argument(path);
        }
        return failure(StatusCode::BAD_REQUEST, OUTSIDE);
    };
    if !is_rule_path(state, &raw.encode_utf16().collect::<Vec<_>>()) {
        return failure(StatusCode::BAD_REQUEST, OUTSIDE);
    }
    let _guard = lock(&state.file_lock);
    let Some(content) = content.and_then(Value::as_str) else {
        return failure(StatusCode::BAD_REQUEST, CONTENT_TYPE_ERROR);
    };
    // The bridge cannot carry an escaped lone surrogate.
    if lone_surrogate(&body, "path") || lone_surrogate(&body, "content") {
        return unavailable(WRITE_FAILED);
    }
    // `mtime == null ? null : Number(mtime)`, then JSON's non-finite -> null.
    let mtime = object
        .and_then(|object| object.get("mtime"))
        .filter(|value| !value.is_null())
        .map(js_value_number)
        .filter(|value| value.is_finite());
    let force = object
        .and_then(|object| object.get("force"))
        .is_some_and(js_truthy);
    let payload = crate::rules::write_file(Some(raw), Some(content), mtime, force);
    write_response(payload)
}

fn write_response(payload: Value) -> Response {
    if payload.get("ok").and_then(Value::as_bool) == Some(true) {
        let Some(mtime) = payload
            .get("mtime")
            .and_then(Value::as_f64)
            .filter(|value| value.is_finite())
        else {
            return unavailable(WRITE_FAILED);
        };
        let Ok(mtime) = RawValue::from_string(js_number_text(mtime)) else {
            return unavailable(WRITE_FAILED);
        };
        return Json(WriteOk {
            ok: true,
            mtime: &mtime,
        })
        .into_response();
    }
    let error = payload
        .get("error")
        .and_then(Value::as_str)
        .unwrap_or(WRITE_FAILED);
    let status = if error == CHANGED {
        StatusCode::CONFLICT
    } else {
        StatusCode::BAD_REQUEST
    };
    failure(status, error)
}

#[derive(serde::Serialize)]
struct WriteOk<'a> {
    ok: bool,
    mtime: &'a RawValue,
}

// VERIFY: rules-reference-route
/// `GET /api/rules/reference` -> `ruleReference(query.path, RULES_REF_DIR)`; a
/// repeated `path` is an array, which the bridge's `path.as_str()` turns into
/// `no path`. Only the exact `no reference` error is a 404.
async fn get_reference(State(state): State<Rules>, RawQuery(query): RawQuery) -> Response {
    tokio::task::spawn_blocking(move || get_reference_blocking(&state, query.as_deref()))
        .await
        .unwrap_or_else(|_| unavailable(REFERENCE_FAILED))
}

fn get_reference_blocking(state: &Rules, query: Option<&str>) -> Response {
    let path = match path_param(query) {
        PathParam::One(value) => Some(value),
        PathParam::Absent | PathParam::Array => None,
    };
    let _guard = lock(&state.file_lock);
    let root = state.reference_dir.to_string_lossy().into_owned();
    let payload = crate::rules::find_reference(path.as_deref(), Some(root.as_str()));
    if payload.get("ok").and_then(Value::as_bool) != Some(true) {
        let error = payload
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or(REFERENCE_FAILED);
        let status = if error == "no reference" {
            StatusCode::NOT_FOUND
        } else {
            StatusCode::BAD_REQUEST
        };
        return failure(status, error);
    }
    Json(payload).into_response()
}

/// `isRulePath`: lexical resolve, a case-insensitive `.md` tail, then containment
/// under one configured `<base>/.claude/rules`.
fn is_rule_path(state: &Rules, path: &[u16]) -> bool {
    let abs = state.paths.resolve(path, false);
    if !ends_with_md(&abs) {
        return false;
    }
    let roots = {
        let _guard = lock(&state.lock);
        crate::picker_roots::get_roots(&state.state_dir.join(RULES_ROOTS_FILE))
    };
    state.paths.inside(&roots, path, RULES_SUBDIR).is_some()
}

fn ends_with_md(units: &[u16]) -> bool {
    units.len() >= 3
        && units[units.len() - 3..]
            .iter()
            .map(|unit| {
                let unit = *unit;
                if (u16::from(b'A')..=u16::from(b'Z')).contains(&unit) {
                    unit + 32
                } else {
                    unit
                }
            })
            .eq([u16::from(b'.'), u16::from(b'm'), u16::from(b'd')])
}

// VERIFY: rules-query-shape
/// Fastify's query parser yields a string for one occurrence and an array for
/// repeats; bracket syntax stays a literal key, so `path[x]` is not `path`.
enum PathParam {
    Absent,
    One(String),
    Array,
}

fn path_param(query: Option<&str>) -> PathParam {
    let Some(query) = query else {
        return PathParam::Absent;
    };
    let mut values = query_values(query, "path");
    if values.is_empty() {
        PathParam::Absent
    } else if values.len() == 1 {
        PathParam::One(values.remove(0))
    } else {
        PathParam::Array
    }
}

/// The bridge cannot carry an escaped lone surrogate, so the raw token decides.
fn lone_surrogate(body: &RawBody, name: &str) -> bool {
    let Some(raw) = body.raw.as_deref() else {
        return false;
    };
    let Ok(Some(fields)) = crate::wiki_root::raw_fields(raw.get()) else {
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

fn lock(lock: &Arc<Mutex<()>>) -> std::sync::MutexGuard<'_, ()> {
    lock.lock().unwrap_or_else(|error| error.into_inner())
}

/// `{ok:false, error}` for every mapped failure body.
fn failure(status: StatusCode, error: &str) -> Response {
    (status, Json(json!({ "ok": false, "error": error }))).into_response()
}

/// The handlers' own 500 bodies for a failed backend call.
fn unavailable(error: &str) -> Response {
    failure(StatusCode::INTERNAL_SERVER_ERROR, error)
}

fn internal_error() -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({
            "statusCode": 500,
            "error": "Internal Server Error",
            "message": "Internal Server Error",
        })),
    )
        .into_response()
}

/// Fastify's default error envelope for the thrown `path.resolve` TypeError
/// (`resolve` validates its argument as `paths[0]`).
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
            "message": format!("The \"paths[0]\" argument must be of type string. Received {received}"),
        })),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::{RULES_ROOTS_FILE, Rules, files, get_file, get_reference, put_file, search};
    use crate::http_hooks::PathEnv;
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
                .join(format!("http-rules-{}-{unique}-{id}", std::process::id()));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        fn state_dir(&self) -> PathBuf {
            self.0.join("state")
        }

        fn root_with(&self, name: &str, files: &[(&str, &str)]) -> PathBuf {
            let base = self.0.join(name);
            let dir = base.join(".claude").join("rules");
            fs::create_dir_all(&dir).unwrap();
            for (file, content) in files {
                let path = dir.join(file);
                fs::create_dir_all(path.parent().unwrap()).unwrap();
                fs::write(path, content).unwrap();
            }
            base
        }

        fn rules_dir(&self, name: &str) -> PathBuf {
            self.0.join(name).join(".claude").join("rules")
        }

        fn reference_dir(&self) -> PathBuf {
            let dir = self.0.join("rules-reference");
            fs::create_dir_all(&dir).unwrap();
            dir
        }

        fn state(&self) -> Rules {
            Rules {
                state_dir: self.state_dir(),
                paths: PathEnv::new(self.0.join("home"), self.0.clone(), Vec::new()),
                reference_dir: self.0.join("rules-reference"),
                lock: Arc::new(Mutex::new(())),
                file_lock: Arc::new(Mutex::new(())),
            }
        }

        fn persist_roots(&self, roots: &[&str]) {
            fs::create_dir_all(self.state_dir()).unwrap();
            fs::write(
                self.state_dir().join(RULES_ROOTS_FILE),
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

    fn query(path: &Path) -> String {
        format!(
            "path={}",
            text(path).replace('/', "%2F").replace('\\', "%5C")
        )
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

    async fn send_files(state: &Rules, body: &str) -> (u16, String) {
        collect(files(State(state.clone()), post("/api/rules/files", body)).await).await
    }

    async fn send_search(state: &Rules, body: &str) -> (u16, String) {
        collect(search(State(state.clone()), post("/api/rules/search", body)).await).await
    }

    async fn send_get(state: &Rules, query: Option<String>) -> (u16, String) {
        let query = RawQuery(query);
        collect(get_file(State(state.clone()), query).await).await
    }

    async fn send_put(state: &Rules, body: &str) -> (u16, String) {
        let request = Request::builder()
            .method(Method::PUT)
            .uri("/api/rules/file")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body.to_owned()))
            .unwrap();
        collect(put_file(State(state.clone()), request).await).await
    }

    async fn send_reference(state: &Rules, query: Option<String>) -> (u16, String) {
        let query = RawQuery(query);
        collect(get_reference(State(state.clone()), query).await).await
    }

    fn payload(body: &str) -> Value {
        serde_json::from_str(body).unwrap()
    }

    #[test]
    fn roots_route_serves_the_persisted_file_over_http() {
        let fixture = Fixture::new();
        run(async {
            let app = super::router(
                fixture.state_dir(),
                fixture.0.join("home"),
                fixture.0.clone(),
                Vec::new(),
                fixture.reference_dir(),
                Arc::new(Mutex::new(())),
                Arc::new(Mutex::new(())),
            );
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            assert!(![4317, 5317].contains(&address.port()));
            let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
            let client = reqwest::Client::builder().no_proxy().build().unwrap();
            let url = format!("http://{address}/api/rules/roots");
            let default: Value = client.get(&url).send().await.unwrap().json().await.unwrap();
            assert_eq!(default, json!({ "roots": ["~"] }));
            let saved: Value = client
                .put(&url)
                .json(&json!({ "roots": ["/a", "/a", "", "/b", 7] }))
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            assert_eq!(saved, json!({ "ok": true, "roots": ["/a", "/b"] }));
            assert_eq!(
                fs::read_to_string(fixture.state_dir().join(RULES_ROOTS_FILE)).unwrap(),
                "[\n  \"/a\",\n  \"/b\"\n]"
            );
            let rejected = client
                .put(&url)
                .json(&json!({ "roots": "/a" }))
                .send()
                .await
                .unwrap();
            assert_eq!(
                rejected.status(),
                reqwest::StatusCode::INTERNAL_SERVER_ERROR
            );
            let body: Value = rejected.json().await.unwrap();
            assert_eq!(
                body["message"],
                json!("(roots || []).filter is not a function")
            );
            server.abort();
            let _ = server.await;
        });
    }

    #[test]
    fn files_resolve_scan_dirs_and_keep_walk_order() {
        let fixture = Fixture::new();
        let base = fixture.root_with("project", &[("a.md", "x"), ("sub/b.md", "y")]);
        let empty = fixture.0.join("absent");
        let state = fixture.state();
        run(async {
            let body = json!({ "roots": [text(&base), text(&empty), 123, ""] }).to_string();
            let (status, response) = send_files(&state, &body).await;
            assert_eq!(status, 200, "{response}");
            let value = payload(&response);
            assert_eq!(value["capped"], false);
            let entries = value["files"].as_array().unwrap();
            let mut rels: Vec<&str> = entries
                .iter()
                .map(|entry| entry["rel"].as_str().unwrap())
                .collect();
            rels.sort();
            assert_eq!(rels, vec!["a.md", "sub/b.md"]);
            assert!(
                entries
                    .iter()
                    .all(|entry| entry["root"] == json!(text(&base)))
            );
            let first = entries.iter().find(|entry| entry["rel"] == "a.md").unwrap();
            assert_eq!(
                first["path"],
                json!(text(&fixture.rules_dir("project").join("a.md")))
            );

            assert_eq!(
                send_files(&state, "{}").await,
                (200, r#"{"files":[],"capped":false}"#.to_owned())
            );
            let rejected = send_files(&state, r#"{"roots":"x"}"#).await;
            assert_eq!(
                rejected,
                (
                    500,
                    r#"{"ok":false,"error":"rules files backend unavailable"}"#.to_owned()
                )
            );
        });
    }

    #[test]
    fn search_passes_the_query_and_maps_backend_errors() {
        let fixture = Fixture::new();
        let base = fixture.root_with("project", &[("a.md", "first\nNEEDLE here\n")]);
        let state = fixture.state();
        run(async {
            let body = json!({ "roots": [text(&base)], "q": "needle" }).to_string();
            let (status, response) = send_search(&state, &body).await;
            assert_eq!(status, 200, "{response}");
            let value = payload(&response);
            assert_eq!(value["capped"], false);
            assert_eq!(value["results"][0]["line"], 2);
            assert_eq!(value["results"][0]["text"], "NEEDLE here");
            assert_eq!(value["results"][0]["root"], json!(text(&base)));

            // A missing or non-string q searches for nothing.
            let body = json!({ "roots": [text(&base)], "q": 5 }).to_string();
            assert_eq!(
                send_search(&state, &body).await,
                (200, r#"{"results":[],"capped":false}"#.to_owned())
            );
            assert_eq!(
                send_search(&state, r#"{"roots":"x"}"#).await,
                (
                    500,
                    r#"{"ok":false,"error":"rules search backend unavailable"}"#.to_owned()
                )
            );
        });
    }

    #[test]
    fn file_read_maps_outside_not_found_and_success() {
        let fixture = Fixture::new();
        let base = fixture.root_with("project", &[("a.md", "body"), ("a.txt", "x")]);
        fixture.persist_roots(&[&text(&base)]);
        let outside = fixture.root_with("outside", &[("a.md", "secret")]);
        let state = fixture.state();
        let file = fixture.rules_dir("project").join("a.md");
        run(async {
            let (status, response) = send_get(&state, Some(query(&file))).await;
            assert_eq!(status, 200, "{response}");
            let value = payload(&response);
            assert_eq!(value["ok"], true);
            assert_eq!(value["content"], "body");
            assert!(value["mtime"].as_f64().unwrap() > 0.0);

            assert_eq!(
                send_get(
                    &state,
                    Some(query(&fixture.rules_dir("project").join("absent.md")))
                )
                .await,
                (404, r#"{"ok":false,"error":"not found"}"#.to_owned())
            );
            assert_eq!(
                send_get(&state, Some(query(&outside.join(".claude/rules/a.md")))).await,
                (
                    400,
                    r#"{"ok":false,"error":"path outside rule roots"}"#.to_owned()
                )
            );
            assert_eq!(
                send_get(
                    &state,
                    Some(query(&fixture.rules_dir("project").join("a.txt")))
                )
                .await,
                (
                    400,
                    r#"{"ok":false,"error":"path outside rule roots"}"#.to_owned()
                )
            );
            assert_eq!(
                send_get(&state, None).await,
                (
                    400,
                    r#"{"ok":false,"error":"path outside rule roots"}"#.to_owned()
                )
            );
            let repeated = send_get(&state, Some("path=a.md&path=b.md".to_owned())).await;
            assert_eq!(repeated.0, 500);
            assert_eq!(payload(&repeated.1)["code"], json!("ERR_INVALID_ARG_TYPE"));
        });
    }

    #[test]
    fn file_write_maps_required_outside_conflict_and_success() {
        let fixture = Fixture::new();
        let base = fixture.root_with("project", &[]);
        fixture.persist_roots(&[&text(&base)]);
        let outside = fixture.root_with("outside", &[]);
        let state = fixture.state();
        let file = fixture.rules_dir("project").join("note.md");
        run(async {
            assert_eq!(
                send_put(&state, r#"{"path":"/x.md"}"#).await,
                (
                    400,
                    r#"{"ok":false,"error":"path + content required"}"#.to_owned()
                )
            );
            assert_eq!(
                send_put(
                    &state,
                    &json!({ "path": text(&file), "content": "v1" }).to_string()
                )
                .await
                .0,
                200
            );
            assert_eq!(fs::read_to_string(&file).unwrap(), "v1");

            let saved = send_put(
                &state,
                &json!({ "path": text(&file), "content": "v2", "mtime": 1.0 }).to_string(),
            )
            .await;
            assert_eq!(
                saved,
                (409, r#"{"ok":false,"error":"changed on disk"}"#.to_owned())
            );
            assert_eq!(fs::read_to_string(&file).unwrap(), "v1");

            assert_eq!(
                send_put(
                    &state,
                    &json!({ "path": text(&outside.join(".claude/rules/note.md")), "content": "x" })
                        .to_string()
                )
                .await,
                (400, r#"{"ok":false,"error":"path outside rule roots"}"#.to_owned())
            );
            assert_eq!(
                send_put(
                    &state,
                    &json!({ "path": text(&file), "content": 5 }).to_string()
                )
                .await,
                (
                    400,
                    r#"{"ok":false,"error":"content must be a string"}"#.to_owned()
                )
            );
            let invalid = send_put(&state, r#"{"path":5,"content":"x"}"#).await;
            assert_eq!(invalid.0, 500);
            assert_eq!(
                payload(&invalid.1)["message"],
                json!("The \"paths[0]\" argument must be of type string. Received type number (5)")
            );
        });
    }

    #[test]
    fn reference_maps_hits_missing_and_absent_paths() {
        let fixture = Fixture::new();
        let reference = fixture.reference_dir();
        fs::write(reference.join("skills-reference.md"), "# body").unwrap();
        let state = fixture.state();
        run(async {
            let (status, response) =
                send_reference(&state, Some("path=skills.md".to_owned())).await;
            assert_eq!(status, 200, "{response}");
            let value = payload(&response);
            assert_eq!(value["ok"], true);
            assert_eq!(
                value["path"],
                json!(text(&reference.join("skills-reference.md")))
            );
            assert_eq!(value["content"], "# body");

            assert_eq!(
                send_reference(&state, Some("path=lonely.md".to_owned())).await,
                (404, r#"{"ok":false,"error":"no reference"}"#.to_owned())
            );
            assert_eq!(
                send_reference(&state, None).await,
                (400, r#"{"ok":false,"error":"no path"}"#.to_owned())
            );
            assert_eq!(
                send_reference(&state, Some("path=a.md&path=b.md".to_owned())).await,
                (400, r#"{"ok":false,"error":"no path"}"#.to_owned())
            );
        });
    }
}
