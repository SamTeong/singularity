//! Wiki routes: `GET`/`PUT /api/wiki/root`, `GET /api/wiki/file`,
//! `GET /api/wiki/files|sweeps|search|graph` — `server/wiki-routes.mjs:26-62`
//! plus `server/index.mjs:790-798`, over `wiki_root.rs`, `wiki_read.rs` and
//! `wiki_graph` (`lib.rs`).
//!
//! Duplicate query parameters stay per-parameter faithful to Fastify: a repeated
//! `path`/`root` on `/wiki/file` and a repeated `q`/`root` on `/wiki/search`
//! reproduce the Node `TypeError` as a Fastify-shaped 500, while `/wiki/sweeps`
//! and `/wiki/graph` fall back to their `typeof`/nullish defaults.
//!
//! Node sorted `/wiki/files` and `/wiki/search` results with `localeCompare` after
//! the native call (Rust ships readdir order), so the same ICU collator ordering
//! (`memory_collation` approach) is applied here; ICU data can differ from Node's.

use crate::http_body::parse_raw;
use crate::http_policy::query_values;
use crate::transcripts::TranscriptRawText;
use crate::wiki_root::{RootResponse, RootValue};
use axum::body::Body;
use axum::extract::{RawQuery, State};
use axum::http::{Request, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use icu_collator::{Collator, options::CollatorOptions};
use icu_locale_core::Locale;
use serde::Serialize;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

const ROOT_FILE: &str = "wiki-root.json";
const OUTSIDE: &str = "path outside wiki root";
const FILE_UNAVAILABLE: &str = "wiki file backend unavailable";
const GRAPH_UNAVAILABLE: &str = "wiki graph backend unavailable";
// `path.resolve` rejects a duplicate `path` query parameter; Node 22's wording.
const PATH_ARG_ERROR: &str =
    "The \"paths[0]\" argument must be of type string. Received an instance of Array";

#[derive(Clone)]
struct WikiState {
    state_file: PathBuf,
    home: PathBuf,
    cwd: PathBuf,
    drive_cwds: Vec<(u16, PathBuf)>,
    locale: String,
    // One lock for the persisted root, as the single bridge child serialized it.
    lock: Arc<Mutex<()>>,
}

// VERIFY: wiki-router-injection
/// `state_dir` holds `wiki-root.json`; `home`/`cwd`/`drive_cwds` are the Node
/// resolution context and `home` also backs the persisted root's default.
pub fn router(
    state_dir: PathBuf,
    home: PathBuf,
    cwd: PathBuf,
    drive_cwds: Vec<(u16, PathBuf)>,
    lock: Arc<Mutex<()>>,
) -> Router {
    let state = WikiState {
        state_file: state_dir.join(ROOT_FILE),
        home,
        cwd,
        drive_cwds,
        locale: crate::memory_collation::system_locale(),
        lock,
    };
    Router::new()
        .route("/api/wiki/root", get(get_root).put(put_root))
        .route("/api/wiki/file", get(get_file))
        .route("/api/wiki/files", get(files))
        .route("/api/wiki/sweeps", get(sweeps))
        .route("/api/wiki/search", get(search))
        .route("/api/wiki/graph", get(graph))
        .with_state(state)
}

async fn get_root(State(state): State<WikiState>) -> Response {
    let result = tokio::task::spawn_blocking(move || {
        let _guard = state.lock.lock().unwrap_or_else(|error| error.into_inner());
        crate::wiki_root::get(&state.state_file, &state.home)
    })
    .await;
    match result {
        Ok(root) => Json(RootResponse { root }).into_response(),
        Err(_) => internal_error(),
    }
}

async fn put_root(State(state): State<WikiState>, request: Request<Body>) -> Response {
    let body = match parse_raw(request).await {
        Ok(body) => body,
        Err(response) => return response,
    };
    let root = root_member(&body);
    let result = tokio::task::spawn_blocking(move || {
        let _guard = state.lock.lock().unwrap_or_else(|error| error.into_inner());
        crate::wiki_root::set(&state.state_file, &state.home, root)
    })
    .await;
    match result {
        Ok(response) => Json(response).into_response(),
        Err(_) => internal_error(),
    }
}

// VERIFY: wiki-root-body
/// `req.body?.root`: only a JSON string token is a root; anything else (missing,
/// `null`, nested, plain-text body) is `bad root`.
fn root_member(body: &crate::http_body::RawBody) -> Option<RootValue> {
    let token = body
        .raw
        .as_deref()
        .and_then(|raw| crate::wiki_root::raw_fields(raw.get()).ok().flatten())
        .and_then(|fields| {
            fields
                .into_iter()
                .rev()
                .find(|(key, _)| key == &"root".encode_utf16().collect::<Vec<_>>())
                .map(|(_, value)| value)
        })?;
    let token = token.get();
    token
        .starts_with('"')
        .then(|| RootValue::from_token(token.to_owned()).ok())
        .flatten()
}

async fn get_file(State(state): State<WikiState>, RawQuery(query): RawQuery) -> Response {
    let query = query.unwrap_or_default();
    let path = query_value(&query, "path");
    let root = query_value(&query, "root");
    if !js_truthy(&path) || !js_truthy(&root) {
        return bad_request(OUTSIDE);
    }
    // `root.startsWith('~')` then `resolve(path)` — the legacy type errors the
    // Node handler deliberately re-triggers for duplicate query parameters.
    let Some(root_text) = root.as_str() else {
        return fastify_error("root.startsWith is not a function");
    };
    let Some(path_text) = path.as_str() else {
        return fastify_error(PATH_ARG_ERROR);
    };
    let root_text = root_text.to_owned();
    let path_text = path_text.to_owned();
    let result =
        tokio::task::spawn_blocking(move || read_file(&state, &root_text, &path_text)).await;
    match result {
        Ok(response) => response,
        Err(_) => error_payload(FILE_UNAVAILABLE),
    }
}

/// `wikiRootAuthorize` then `readFile`: the read keeps the raw query path, so a
/// `~`-prefixed path authorizes but fails to open, exactly as the bridge did.
fn read_file(state: &WikiState, root_text: &str, path_text: &str) -> Response {
    let _guard = state.lock.lock().unwrap_or_else(|error| error.into_inner());
    let (Some(root), Some(path)) = (root_value(root_text), root_value(path_text)) else {
        return error_payload(FILE_UNAVAILABLE);
    };
    let persisted = crate::wiki_root::get(&state.state_file, &state.home);
    let authorized = path
        .units()
        .map(|units| !units.contains(&0))
        .unwrap_or(false)
        && crate::wiki_root::authorize_raw_with_drive_cwds(
            &root,
            &path,
            &persisted,
            &state.home,
            &state.cwd,
            &state.drive_cwds,
        );
    if !authorized {
        return bad_request(OUTSIDE);
    }
    let target = read_target(path_text, &state.cwd);
    let payload = crate::wiki_read::dispatch(
        "read",
        &Value::Null,
        &Value::Null,
        &Value::String(target.to_string_lossy().into_owned()),
        &Value::Null,
    );
    match payload["ok"].as_bool() {
        Some(true) => Json(payload).into_response(),
        _ if payload["error"].as_str() == Some("not found") => {
            (StatusCode::NOT_FOUND, Json(payload)).into_response()
        }
        _ => (StatusCode::BAD_REQUEST, Json(payload)).into_response(),
    }
}

async fn files(State(state): State<WikiState>, RawQuery(query): RawQuery) -> Response {
    let query = query.unwrap_or_default();
    let root = match resolve_query_root(&state, &query_values(&query, "root")) {
        Ok(root) => root,
        Err(response) => return response,
    };
    let result = tokio::task::spawn_blocking(move || {
        let _guard = state.lock.lock().unwrap_or_else(|error| error.into_inner());
        files_payload(&state, root)
    })
    .await;
    match result {
        Ok(response) => response,
        Err(_) => internal_error(),
    }
}

/// `rustBackend.files(...)`: the tree from `wiki_read`, then Node's
/// `localeCompare` order for wikis and pages.
fn files_payload(state: &WikiState, root: Option<String>) -> Response {
    let Ok(collator) = collator(&state.locale) else {
        return internal_error();
    };
    let order = wiki_order(root.as_deref(), &collator);
    let payload = crate::wiki_read::dispatch(
        "files",
        &root.map(Value::String).unwrap_or(Value::Null),
        &Value::Null,
        &Value::Null,
        &order,
    );
    Json(sort_files(payload, &collator)).into_response()
}

fn sort_files(mut payload: Value, collator: &icu_collator::CollatorBorrowed<'static>) -> Value {
    let Some(wikis) = payload.get_mut("wikis").and_then(Value::as_array_mut) else {
        return payload;
    };
    wikis.sort_by(|a, b| collator.compare(field(a, "name"), field(b, "name")));
    for wiki in wikis {
        let Some(pages) = wiki.get_mut("pages").and_then(Value::as_array_mut) else {
            continue;
        };
        pages.sort_by(|a, b| collator.compare(field(a, "rel"), field(b, "rel")));
    }
    payload
}

/// `wikiOrder(root)` in `server/rust-backend.mjs`: directory names under the
/// resolved root in `localeCompare` order, `[]` when unreadable.
fn wiki_order(root: Option<&str>, collator: &icu_collator::CollatorBorrowed<'static>) -> Value {
    let Some(root) = root else {
        return json!([]);
    };
    let Ok(entries) = std::fs::read_dir(root) else {
        return json!([]);
    };
    let mut names = entries
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false))
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    names.sort_by(|a, b| collator.compare(a, b));
    Value::Array(names.into_iter().map(Value::String).collect())
}

async fn sweeps(State(state): State<WikiState>, RawQuery(query): RawQuery) -> Response {
    let query = query.unwrap_or_default();
    // `typeof req.query.root === 'string' ? req.query.root : null` — a repeated
    // parameter is an array and falls back to the default root set.
    let root = match &query_values(&query, "root")[..] {
        [root] => Value::String(root.clone()),
        _ => Value::Null,
    };
    let result = tokio::task::spawn_blocking(move || {
        let _guard = state.lock.lock().unwrap_or_else(|error| error.into_inner());
        crate::wiki_read::dispatch("sweeps", &root, &Value::Null, &Value::Null, &Value::Null)
    })
    .await;
    match result {
        Ok(payload) => Json(payload).into_response(),
        Err(_) => internal_error(),
    }
}

async fn search(State(state): State<WikiState>, RawQuery(query): RawQuery) -> Response {
    let query = query.unwrap_or_default();
    let q = query_value(&query, "q");
    let mut root = None;
    if js_truthy(&q) {
        if q.as_str().is_none() {
            return fastify_error("q.toLowerCase is not a function");
        }
        root = match resolve_query_root(&state, &query_values(&query, "root")) {
            Ok(root) => root,
            Err(response) => return response,
        };
    }
    let q = q.as_str().unwrap_or("").to_owned();
    let result = tokio::task::spawn_blocking(move || {
        let _guard = state.lock.lock().unwrap_or_else(|error| error.into_inner());
        search_payload(&state, &q, root)
    })
    .await;
    match result {
        Ok(response) => response,
        Err(_) => internal_error(),
    }
}

/// `rustBackend.search(...)`: results sorted by wiki name, each snippet cut to
/// 200 UTF-16 units (a JS slice can split a surrogate pair, so the token is
/// spliced rather than passed through a Rust string).
fn search_payload(state: &WikiState, q: &str, root: Option<String>) -> Response {
    let Ok(collator) = collator(&state.locale) else {
        return internal_error();
    };
    let order = wiki_order(root.as_deref(), &collator);
    let payload = crate::wiki_read::dispatch(
        "search",
        &root.map(Value::String).unwrap_or(Value::Null),
        &Value::String(q.to_owned()),
        &Value::Null,
        &order,
    );
    let mut hits = payload["results"].as_array().cloned().unwrap_or_default();
    hits.sort_by(|a, b| collator.compare(wiki_of(field(a, "rel")), wiki_of(field(b, "rel"))));
    let Some(results) = hits.iter().map(search_hit).collect::<Option<Vec<_>>>() else {
        return internal_error();
    };
    Json(SearchReply {
        results,
        capped: payload["capped"].as_bool() == Some(true),
    })
    .into_response()
}

#[derive(Serialize)]
struct SearchReply {
    results: Vec<SearchHit>,
    capped: bool,
}

#[derive(Serialize)]
struct SearchHit {
    file: Value,
    path: Value,
    rel: Value,
    line: Value,
    text: TranscriptRawText,
}

fn search_hit(hit: &Value) -> Option<SearchHit> {
    let text = hit["text"].as_str()?;
    let token = serde_json::to_string(text)
        .ok()
        .and_then(|token| TranscriptRawText::from_json_token(token).ok())?;
    let text = token.slice_units(0, 200).unwrap_or(token);
    Some(SearchHit {
        file: hit["file"].clone(),
        path: hit["path"].clone(),
        rel: hit["rel"].clone(),
        line: hit["line"].clone(),
        text,
    })
}

/// `rel.split('/')[0]` — the wiki name a search hit belongs to.
fn wiki_of(rel: &str) -> &str {
    rel.split('/').next().unwrap_or(rel)
}

async fn graph(State(_state): State<WikiState>, RawQuery(query): RawQuery) -> Response {
    let query = query.unwrap_or_default();
    // `req.query.root ?? ''` / `req.query.wiki ?? ''`: an array is truthy but not
    // a usable name, and the bridge read it as the empty string.
    let name = |name: &str| match &query_values(&query, name)[..] {
        [value] => value.clone(),
        _ => String::new(),
    };
    let (root, wiki) = (name("root"), name("wiki"));
    let result = tokio::task::spawn_blocking(move || crate::wiki_graph(&root, &wiki)).await;
    match result {
        Ok(Ok(graph)) => Json(serde_json::to_value(graph).unwrap_or(Value::Null)).into_response(),
        Ok(Err(error)) => Json(serde_json::to_value(error).unwrap_or(Value::Null)).into_response(),
        Err(_) => error_payload(GRAPH_UNAVAILABLE),
    }
}

// VERIFY: wiki-root-resolution
/// `resolveRoot(raw)` in `server/wiki.mjs`: absent/empty -> null, a repeated
/// parameter throws `path.startsWith is not a function`, otherwise the
/// `~`-expanded JS-lexical resolve against the injected home and cwd.
fn resolve_query_root(state: &WikiState, values: &[String]) -> Result<Option<String>, Response> {
    match values {
        [] => Ok(None),
        [only] if only.is_empty() => Ok(None),
        [only] => Ok(Some(
            crate::wiki_root::resolve(only, &state.home, &state.cwd)
                .to_string_lossy()
                .into_owned(),
        )),
        _ => Err(fastify_error("path.startsWith is not a function")),
    }
}

fn root_value(text: &str) -> Option<RootValue> {
    RootValue::from_token(serde_json::to_string(text).ok()?).ok()
}

/// The bridge passed the raw path to `fs::read`, so only the process cwd made a
/// relative path absolute; a `~` prefix is *not* expanded at read time.
fn read_target(raw: &str, cwd: &Path) -> PathBuf {
    let path = Path::new(raw);
    if raw.starts_with('~') || path.is_absolute() {
        path.to_path_buf()
    } else {
        cwd.join(path)
    }
}

/// One query parameter as `req.query.<name>`: absent -> null, one occurrence ->
/// string, several -> array.
fn query_value(query: &str, name: &str) -> Value {
    match query_values(query, name) {
        values if values.is_empty() => Value::Null,
        values if values.len() == 1 => Value::String(values.into_iter().next().unwrap_or_default()),
        values => Value::Array(values.into_iter().map(Value::String).collect()),
    }
}

fn field<'a>(value: &'a Value, name: &str) -> &'a str {
    value.get(name).and_then(Value::as_str).unwrap_or("")
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

fn collator(locale: &str) -> Result<icu_collator::CollatorBorrowed<'static>, ()> {
    let locale: Locale = locale.parse().map_err(|_| ())?;
    Collator::try_new(locale.into(), CollatorOptions::default()).map_err(|_| ())
}

fn bad_request(error: &str) -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({ "ok": false, "error": error })),
    )
        .into_response()
}

/// Fastify's fallback envelope for an error thrown inside a handler.
fn fastify_error(message: &str) -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({
            "statusCode": 500, "error": "Internal Server Error", "message": message,
        })),
    )
        .into_response()
}

fn error_payload(message: &str) -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({ "ok": false, "error": message })),
    )
        .into_response()
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

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::to_bytes;
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};
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
                .join(format!("http-wiki-{}-{unique}-{id}", std::process::id()));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        fn state(&self) -> WikiState {
            WikiState {
                state_file: self.0.join("state/wiki-root.json"),
                home: self.0.join("home"),
                cwd: self.0.clone(),
                drive_cwds: Vec::new(),
                locale: "en-US".to_owned(),
                lock: Arc::new(Mutex::new(())),
            }
        }

        fn put(&self, rel: &str, text: &str) {
            let path = self.0.join(rel);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, text).unwrap();
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

    fn encode(text: &str) -> String {
        let mut out = String::new();
        for byte in text.bytes() {
            if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~' | b'/') {
                out.push(byte as char);
            } else {
                out.push_str(&format!("%{byte:02X}"));
            }
        }
        out
    }

    fn raw_query(pairs: &[(&str, &str)]) -> RawQuery {
        RawQuery(Some(
            pairs
                .iter()
                .map(|(key, value)| format!("{key}={}", encode(value)))
                .collect::<Vec<_>>()
                .join("&"),
        ))
    }

    fn put_request(body: &str) -> Request<Body> {
        Request::builder()
            .method("PUT")
            .uri("/api/wiki/root")
            .header("content-type", "application/json")
            .body(Body::from(body.to_owned()))
            .unwrap()
    }

    async fn collect(response: Response) -> (u16, String) {
        let status = response.status().as_u16();
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        (status, String::from_utf8(bytes.to_vec()).unwrap())
    }

    fn json(body: &str) -> Value {
        serde_json::from_str(body).unwrap()
    }

    async fn call_root_get(state: &WikiState) -> (u16, String) {
        collect(super::get_root(State(state.clone())).await).await
    }

    async fn call_root_put(state: &WikiState, body: &str) -> (u16, String) {
        collect(put_root(State(state.clone()), put_request(body)).await).await
    }

    async fn call_file(state: &WikiState, pairs: &[(&str, &str)]) -> (u16, Value) {
        let (status, body) = collect(get_file(State(state.clone()), raw_query(pairs)).await).await;
        (status, json(&body))
    }

    async fn call_files(state: &WikiState, pairs: &[(&str, &str)]) -> (u16, Value) {
        let (status, body) = collect(files(State(state.clone()), raw_query(pairs)).await).await;
        (status, json(&body))
    }

    async fn call_sweeps(state: &WikiState, pairs: &[(&str, &str)]) -> (u16, Value) {
        let (status, body) = collect(sweeps(State(state.clone()), raw_query(pairs)).await).await;
        (status, json(&body))
    }

    async fn call_search(state: &WikiState, pairs: &[(&str, &str)]) -> (u16, Value) {
        let (status, body) = collect(search(State(state.clone()), raw_query(pairs)).await).await;
        (status, json(&body))
    }

    async fn call_search_raw(state: &WikiState, pairs: &[(&str, &str)]) -> (u16, String) {
        collect(search(State(state.clone()), raw_query(pairs)).await).await
    }

    async fn call_graph(state: &WikiState, pairs: &[(&str, &str)]) -> (u16, Value) {
        let (status, body) = collect(graph(State(state.clone()), raw_query(pairs)).await).await;
        (status, json(&body))
    }

    // VERIFY: wiki-root-round-trip
    #[test]
    fn root_reads_the_default_round_trips_escapes_and_rejects_bad_bodies() {
        let fixture = Fixture::new();
        let state = fixture.state();
        run(async {
            assert_eq!(
                call_root_get(&state).await,
                (200, r#"{"root":"~/wiki"}"#.to_owned())
            );

            // An escaped lone surrogate survives the store and the reply.
            let (status, body) = call_root_put(&state, r#"{"root":"\ud800"}"#).await;
            assert_eq!(status, 200);
            assert_eq!(body, r#"{"ok":true,"root":"\ud800"}"#);
            assert_eq!(
                call_root_get(&state).await,
                (200, r#"{"root":"\ud800"}"#.to_owned())
            );

            for body in [r#"{"root":""}"#, r#"{"root":null}"#, r#"{"root":7}"#] {
                assert_eq!(
                    call_root_put(&state, body).await,
                    (200, r#"{"ok":false,"error":"bad root"}"#.to_owned()),
                    "{body}"
                );
            }

            let (status, body) = call_root_put(&state, "{").await;
            assert_eq!(status, 400);
            assert_eq!(
                json(&body)["code"],
                Value::String("FST_ERR_CTP_INVALID_JSON_BODY".into())
            );
        });
    }

    // VERIFY: wiki-file-statuses
    #[test]
    fn file_authorizes_before_reading_and_maps_every_status() {
        let fixture = Fixture::new();
        let state = fixture.state();
        let wiki = fixture.0.join("wiki");
        fixture.put("wiki/page.md", "page");
        let wiki_text = wiki.to_string_lossy().into_owned();
        let page = wiki.join("page.md").to_string_lossy().into_owned();
        let notes = wiki.join("notes.txt").to_string_lossy().into_owned();
        let outside = fixture.0.join("outside.md").to_string_lossy().into_owned();
        fs::create_dir_all(state.state_file.parent().unwrap()).unwrap();
        fs::write(
            &state.state_file,
            serde_json::to_vec(&serde_json::json!({ "root": &wiki_text })).unwrap(),
        )
        .unwrap();
        run(async {
            assert_eq!(
                call_file(&state, &[("root", &wiki_text), ("path", &page)]).await,
                (200, json!({ "ok": true, "content": "page" }))
            );
            for pairs in [
                vec![("root", wiki_text.as_str())],
                vec![("path", page.as_str())],
                vec![("root", ""), ("path", page.as_str())],
                vec![("root", wiki_text.as_str()), ("path", "")],
            ] {
                let (status, body) = call_file(&state, &pairs).await;
                assert_eq!(status, 400, "{pairs:?}");
                assert_eq!(body, json!({ "ok": false, "error": OUTSIDE }));
            }
            // Outside the persisted root, or not a markdown page.
            for target in [outside.as_str(), notes.as_str()] {
                let (status, body) =
                    call_file(&state, &[("root", &wiki_text), ("path", target)]).await;
                assert_eq!(status, 400, "{target}");
                assert_eq!(body, json!({ "ok": false, "error": OUTSIDE }));
            }
            let missing = wiki.join("missing.md").to_string_lossy().into_owned();
            let (status, body) =
                call_file(&state, &[("root", &wiki_text), ("path", &missing)]).await;
            assert_eq!(status, 404);
            assert_eq!(body, json!({ "ok": false, "error": "not found" }));

            // Duplicate query parameters reproduce the legacy Node type errors.
            let (status, body) = call_file(
                &state,
                &[("root", &wiki_text), ("path", &page), ("path", &page)],
            )
            .await;
            assert_eq!(status, 500);
            assert_eq!(body["message"], Value::String(PATH_ARG_ERROR.into()));
            let (status, body) = call_file(
                &state,
                &[("root", &wiki_text), ("root", &wiki_text), ("path", &page)],
            )
            .await;
            assert_eq!(status, 500);
            assert_eq!(
                body["message"],
                Value::String("root.startsWith is not a function".into())
            );
        });
    }

    // VERIFY: wiki-files-order-and-defaults
    #[test]
    fn files_sorts_wikis_and_pages_and_keeps_the_bad_path_payload() {
        let fixture = Fixture::new();
        let state = fixture.state();
        fixture.put("root/beta/z.md", "");
        fixture.put("root/beta/a.md", "");
        fixture.put("root/alpha/m.md", "");
        let root = fixture.0.join("root").to_string_lossy().into_owned();
        run(async {
            let (status, body) = call_files(&state, &[("root", &root)]).await;
            assert_eq!(status, 200);
            assert_eq!(body["capped"], json!(false));
            let names = body["wikis"]
                .as_array()
                .unwrap()
                .iter()
                .map(|wiki| wiki["name"].as_str().unwrap())
                .collect::<Vec<_>>();
            assert_eq!(names, ["alpha", "beta"]);
            assert_eq!(
                body["wikis"][1]["pages"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|page| page["rel"].as_str().unwrap())
                    .collect::<Vec<_>>(),
                ["a.md", "z.md"]
            );
            assert_eq!(
                call_files(&state, &[]).await,
                (
                    200,
                    json!({ "wikis": [], "capped": false, "error": "bad path" })
                )
            );
            let absent = fixture.0.join("absent").to_string_lossy().into_owned();
            assert_eq!(
                call_files(&state, &[("root", &absent)]).await,
                (
                    200,
                    json!({ "wikis": [], "capped": false, "error": "not found" })
                )
            );
            let (status, body) = call_files(&state, &[("root", &root), ("root", &root)]).await;
            assert_eq!(status, 500);
            assert_eq!(
                body["message"],
                Value::String("path.startsWith is not a function".into())
            );
        });
    }

    // VERIFY: wiki-sweeps-fallback
    #[test]
    fn sweeps_uses_the_fixed_wiki_set_and_ignores_repeated_roots() {
        let fixture = Fixture::new();
        let state = fixture.state();
        fixture.put(
            "root/agentic-coding/meta/websearch-log.md",
            "## [2026-10-12] shallow | lanes: all\n- NEW: —\n",
        );
        fixture.put(
            "root/dotnet/meta/websearch-log.md",
            "## [2026-10-11] deep | lanes: all\n- Sweep completed.\n",
        );
        fixture.put(
            "root/iap/wiki-sync.json",
            "{\"lastIngestedAt\":\"2026-10-10\"}",
        );
        let root = fixture.0.join("root").to_string_lossy().into_owned();
        run(async {
            let (status, body) = call_sweeps(&state, &[("root", &root)]).await;
            assert_eq!(status, 200);
            assert_eq!(
                body["wikis"],
                json!([
                    { "name": "agentic-coding", "shallow": "2026-10-12", "deep": null, "horizon": null },
                    { "name": "dotnet", "shallow": null, "deep": "2026-10-11", "horizon": null },
                    { "name": "iap", "shallow": null, "deep": "2026-10-10", "horizon": null },
                ])
            );

            // A repeated `root` is an array and falls back to the default set.
            let (status, body) = call_sweeps(&state, &[("root", &root), ("root", &root)]).await;
            assert_eq!(status, 200);
            assert_eq!(
                body["wikis"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|wiki| wiki["name"].as_str().unwrap())
                    .collect::<Vec<_>>(),
                ["agentic-coding", "dotnet", "iap"]
            );
            assert_eq!(body["wikis"][0]["shallow"], json!(null));
            assert_eq!(body["wikis"][2]["deep"], json!(null));
        });
    }

    // VERIFY: wiki-search-sort-and-slice
    #[test]
    fn search_sorts_by_wiki_cuts_snippets_and_rejects_duplicate_parameters() {
        let fixture = Fixture::new();
        let state = fixture.state();
        fixture.put("root/beta/b.md", "needle here");
        fixture.put("root/alpha/a.md", "first needle\nother NEEDLE");
        let root = fixture.0.join("root").to_string_lossy().into_owned();
        run(async {
            let (status, body) = call_search(&state, &[("q", "NEEDLE"), ("root", &root)]).await;
            assert_eq!(status, 200);
            assert_eq!(body["capped"], json!(false));
            let rels = body["results"]
                .as_array()
                .unwrap()
                .iter()
                .map(|hit| hit["rel"].as_str().unwrap())
                .collect::<Vec<_>>();
            assert_eq!(rels, ["alpha/a.md", "alpha/a.md", "beta/b.md"]);

            // A 200-unit JS slice can split a surrogate pair, so the snippet keeps
            // the lone high surrogate a Rust string cannot hold.
            fixture.put(
                "root/alpha/clip.md",
                &format!("{}😀 needle", "x".repeat(199)),
            );
            // The 200-unit slice splits the surrogate pair, as JS `slice` does.
            let (status, raw) = call_search_raw(&state, &[("q", "needle"), ("root", &root)]).await;
            assert_eq!(status, 200);
            assert!(
                raw.contains("\\ud83d\""),
                "a lone high surrogate ends the cut snippet: {raw}"
            );

            assert_eq!(
                call_search(&state, &[("q", ""), ("root", &root)]).await,
                (200, json!({ "results": [], "capped": false }))
            );

            let (status, body) =
                call_search(&state, &[("q", "a"), ("q", "b"), ("root", &root)]).await;
            assert_eq!(status, 500);
            assert_eq!(
                body["message"],
                Value::String("q.toLowerCase is not a function".into())
            );
            let (status, body) =
                call_search(&state, &[("q", "needle"), ("root", &root), ("root", &root)]).await;
            assert_eq!(status, 500);
            assert_eq!(
                body["message"],
                Value::String("path.startsWith is not a function".into())
            );
        });
    }

    // VERIFY: wiki-graph-payloads
    #[test]
    fn graph_returns_nodes_edges_and_the_two_missing_errors() {
        let fixture = Fixture::new();
        let state = fixture.state();
        fixture.put("root/wiki/from.md", "[[target|label]] [[missing]]");
        fixture.put("root/wiki/target.md", "");
        let root = fixture.0.join("root").to_string_lossy().into_owned();
        let absent = fixture.0.join("absent").to_string_lossy().into_owned();
        run(async {
            let (status, body) = call_graph(&state, &[("root", &root), ("wiki", "wiki")]).await;
            assert_eq!(status, 200);
            assert_eq!(
                body["edges"],
                json!([{ "source": "from.md", "target": "target.md" }])
            );
            assert_eq!(
                body["nodes"],
                json!([
                    { "id": "from.md", "label": "from", "category": "" },
                    { "id": "target.md", "label": "target", "category": "" },
                ])
            );
            assert_eq!(
                call_graph(&state, &[("root", &absent), ("wiki", "wiki")]).await,
                (200, json!({ "error": "not found" }))
            );
            assert_eq!(
                call_graph(&state, &[("root", &root), ("wiki", "absent")]).await,
                (200, json!({ "error": "wiki not found" }))
            );
            // A repeated parameter is an array, which the bridge read as "".
            assert_eq!(
                call_graph(
                    &state,
                    &[("root", &root), ("root", &root), ("wiki", "wiki")]
                )
                .await,
                (200, json!({ "error": "not found" }))
            );
        });
    }
}
