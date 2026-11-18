//! Codex config search: `POST /api/codex-config/search`, mirroring
//! `server/index.mjs:629-632` -> `codex-config.mjs:searchConfig` (lines 55-68)
//! and the `codexConfigSearch` bridge in `server/rust-backend.mjs:671-676`.
//!
//! Contract, in Node's order of operations:
//! 1. `needle = String(q || '').toLowerCase()`; an empty needle answers
//!    `{"results":[]}` before the roots list is touched (so a malformed `roots`
//!    with no query is not an error).
//! 2. `for (const cwd of roots || [])`: a falsy `roots` iterates nothing, an
//!    array iterates its elements, a string iterates its code points, and any
//!    other truthy value throws `(roots || []) is not iterable` -> 500.
//! 3. `isKnownConfigRoot(cwd)` (falsy skips; a truthy non-string throws
//!    `p.startsWith is not a function` -> 500) against the picker roots in
//!    `<state_dir>/codex-config-roots.json`.
//! 4. Authorized `{cwd, project, user}` entries feed `config_read::search_codex`
//!    (the same native backend the bridge calls), each hit's `text` is sliced to
//!    the bridge's 200 UTF-16 units, and the hits are sorted by `path` with the
//!    same locale collation the scan route uses.
//!
//! Parity limits:
//! - `q` and `cwd` values arrive through `serde_json::Value`, so an escaped
//!   lone surrogate decodes as U+FFFD; Node would compare the exact UTF-16
//!   units. Config files themselves are read byte-exact by the shared backend.
//! - `String.prototype.toLowerCase` uses context-sensitive Final_Sigma; Rust's
//!   `str::to_lowercase` does not. The needle is lowercased once here, then the
//!   shared backend lowercases it again exactly as it does for the Node bridge.
//! - The collation is the host's ICU locale (as in `http_config_scan.rs`), not
//!   V8's default-locale `localeCompare`; they agree for the path shapes here
//!   but are separate implementations.
//! - The roots file is re-read per candidate cwd under the shared lock, matching
//!   `isKnownConfigRoot`'s per-cwd `getConfigRoots()` call, so a concurrent
//!   update mid-request is observed the same way.
use crate::config_editor_auth::is_known;
use crate::config_editor_paths::join_config;
use crate::http_body::{RawBody, parse_raw};
use crate::transcripts::TranscriptRawText;
use axum::body::Body;
use axum::extract::State;
use axum::http::{Request, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use icu_collator::{Collator, options::CollatorOptions};
use icu_locale_core::Locale;
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use serde_json::{Value, json};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

const CODEX_ROOTS_FILE: &str = "codex-config-roots.json";
/// `result.text.slice(0, 200)` in the bridge, in JavaScript UTF-16 units.
const SNIPPET_UNITS: usize = 200;
// Fastify's default-handler messages for the two TypeErrors this route can hit.
const NOT_ITERABLE: &str = "(roots || []) is not iterable";
const NOT_A_STRING: &str = "p.startsWith is not a function";
// `results?.error || 'Rust Codex config search failed'` in the bridge.
const SEARCH_FAILED: &str = "Rust Codex config search failed";

#[derive(Clone)]
struct Search {
    inner: Arc<SearchState>,
}

struct SearchState {
    home: PathBuf,
    codex_home: PathBuf,
    roots_file: PathBuf,
    // Shared with the other config-editor routes so root reads and writes
    // cannot interleave.
    lock: Arc<Mutex<()>>,
    process_cwd: PathBuf,
    drive_cwds: Vec<(u16, PathBuf)>,
}

#[derive(Serialize)]
struct ResultsReply {
    results: Vec<Hit>,
}

/// Search hit in the shared backend's key order: `cwd, scope, path, line, text`.
#[derive(Serialize)]
struct Hit {
    cwd: String,
    scope: String,
    path: String,
    line: usize,
    // Serializes the original JSON token, so a slice ending inside a surrogate
    // pair stays a lone `\ud8xx` escape exactly as `String.prototype.slice` would.
    text: TranscriptRawText,
}

#[derive(Deserialize)]
struct HitSource {
    cwd: String,
    scope: String,
    path: String,
    line: usize,
    text: Box<RawValue>,
}

// VERIFY: codex-config-search-router-injection
pub fn router(
    home: PathBuf,
    codex_home: PathBuf,
    state_dir: PathBuf,
    lock: Arc<Mutex<()>>,
    process_cwd: PathBuf,
    drive_cwds: Vec<(u16, PathBuf)>,
) -> Router {
    Router::new()
        .route("/api/codex-config/search", post(search))
        .with_state(Search {
            inner: Arc::new(SearchState {
                home,
                codex_home,
                roots_file: state_dir.join(CODEX_ROOTS_FILE),
                lock,
                process_cwd,
                drive_cwds,
            }),
        })
}

async fn search(State(state): State<Search>, request: Request<Body>) -> Response {
    let body = match parse_raw(request).await {
        Ok(body) => body,
        Err(response) => return response,
    };
    let needle = needle(&body);
    // `if (!needle) return []` runs before any roots access in `searchConfig`.
    if needle.is_empty() {
        return Json(ResultsReply {
            results: Vec::new(),
        })
        .into_response();
    }
    let roots = body
        .value
        .as_object()
        .and_then(|object| object.get("roots"))
        .cloned()
        .unwrap_or(Value::Null);
    let inner = Arc::clone(&state.inner);
    match tokio::task::spawn_blocking(move || run(&inner, &roots, &needle)).await {
        Ok(Ok(results)) => Json(ResultsReply { results }).into_response(),
        Ok(Err(message)) => internal_error(&message),
        Err(_) => internal_error("Internal Server Error"),
    }
}

// VERIFY: codex-config-search-needle
/// `String(q || '').toLowerCase()` for the last `q` member of a JSON object body.
fn needle(body: &RawBody) -> String {
    match body.value.as_object().and_then(|object| object.get("q")) {
        Some(value) if js_truthy(value) => js_string(value).to_lowercase(),
        // every falsy value — and a non-object body — becomes the empty needle
        _ => String::new(),
    }
}

fn run(state: &SearchState, roots: &Value, needle: &str) -> Result<Vec<Hit>, String> {
    let mut authorized = Vec::new();
    for cwd in cwd_values(roots)? {
        if !is_known_cwd(state, &cwd)? {
            continue;
        }
        let cwd = cwd.as_str().expect("an authorized cwd is a string");
        let windows = cfg!(windows);
        authorized.push(json!({
            "cwd": cwd,
            // scopePaths() applies no tilde expansion.
            "project": join_config(cwd, ".codex", "config.toml", windows),
            "user": join_config(&state.codex_home.to_string_lossy(), "", "config.toml", windows),
        }));
    }
    let raw = crate::config_read::search_codex(&Value::Array(authorized), needle);
    let text = raw.get();
    let Ok(sources) = serde_json::from_str::<Vec<HitSource>>(text) else {
        return Err(search_error(text));
    };
    let mut hits: Vec<Hit> = sources
        .into_iter()
        .map(|source| Hit {
            cwd: source.cwd,
            scope: source.scope,
            path: source.path,
            line: source.line,
            text: snippet(source.text.get()),
        })
        .collect();
    let locale: Locale = crate::memory_collation::system_locale()
        .parse()
        .expect("valid system locale");
    let collator =
        Collator::try_new(locale.into(), CollatorOptions::default()).expect("available collation");
    hits.sort_by(|a, b| collator.compare(&a.path, &b.path));
    Ok(hits)
}

/// `for (const cwd of roots || [])`: arrays yield their elements, strings yield
/// code points (never an empty string), falsy values yield nothing, and any
/// other truthy value is not iterable.
fn cwd_values(roots: &Value) -> Result<Vec<Value>, String> {
    match roots {
        Value::Array(items) => Ok(items.clone()),
        Value::String(text) => Ok(text
            .chars()
            .map(|character| Value::String(character.to_string()))
            .collect()),
        value if !js_truthy(value) => Ok(Vec::new()),
        _ => Err(NOT_ITERABLE.to_owned()),
    }
}

/// `isKnownConfigRoot(cwd)`, including its two throws: a truthy non-string cwd
/// rejects in `resolveRoot`, and so does a truthy non-string persisted root that
/// is reached before a match (`.some` short-circuits on the first hit).
fn is_known_cwd(state: &SearchState, cwd: &Value) -> Result<bool, String> {
    if !js_truthy(cwd) {
        return Ok(false);
    }
    let Some(cwd) = cwd.as_str() else {
        return Err(NOT_A_STRING.to_owned());
    };
    let cwd = cwd.encode_utf16().collect::<Vec<_>>();
    for token in stored_roots(state) {
        if token.get().starts_with('"') {
            let matching = TranscriptRawText::from_json_token(token.get().to_owned())
                .and_then(|root| root.units())
                .is_ok_and(|root| {
                    is_known(
                        &cwd,
                        std::slice::from_ref(&root),
                        &state.home,
                        &state.process_cwd,
                        &state.drive_cwds,
                    )
                });
            if matching {
                return Ok(true);
            }
        } else if !raw_truthy(&token) {
            continue;
        } else {
            // `resolveRoot` calls `startsWith` on a number, boolean, array or object.
            return Err(NOT_A_STRING.to_owned());
        }
    }
    Ok(false)
}

/// The picker's roots array, read for every candidate cwd under the shared lock.
fn stored_roots(state: &SearchState) -> Vec<Box<RawValue>> {
    let _guard = state.lock.lock().unwrap_or_else(|error| error.into_inner());
    let roots_json = crate::picker_roots::get_roots(&state.roots_file);
    serde_json::from_str(&roots_json).unwrap_or_default()
}

/// `result.text.slice(0, 200)`: applied to the raw token so a cut inside a
/// surrogate pair serializes as the lone escape Node produces.
fn snippet(token: &str) -> TranscriptRawText {
    TranscriptRawText::from_json_token(token.to_owned())
        .and_then(|text| text.slice_units(0, SNIPPET_UNITS))
        .unwrap_or_else(|_| {
            TranscriptRawText::from_json_token("\"\"".to_owned()).expect("empty string token")
        })
}

/// `results?.error || 'Rust Codex config search failed'` when the backend replies
/// with anything but an array (its read-failure shape).
fn search_error(text: &str) -> String {
    match serde_json::from_str::<Value>(text) {
        Ok(value) => match value.get("error") {
            Some(error) if js_truthy(error) => js_string(error),
            _ => SEARCH_FAILED.to_owned(),
        },
        Err(_) => SEARCH_FAILED.to_owned(),
    }
}

/// JavaScript truthiness: only `false`, `0`, `""`, `null` and `NaN` are falsy;
/// every array and object (even empty) is truthy.
fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => {
            let value = json_number(number);
            value != 0.0 && !value.is_nan()
        }
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// Truthiness of a persisted root token that is not a JSON string. A number too
/// large for `f64` still parses (arbitrary precision) and is truthy.
fn raw_truthy(token: &RawValue) -> bool {
    serde_json::from_str::<Value>(token.get()).map_or(true, |value| js_truthy(&value))
}

/// `String(value)` for the JSON values a body can hold.
fn js_string(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => js_number_text(json_number(number)),
        Value::String(text) => text.clone(),
        Value::Array(items) => items.iter().map(js_string).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".to_owned(),
    }
}

fn json_number(number: &serde_json::Number) -> f64 {
    number
        .as_f64()
        .unwrap_or_else(|| number.to_string().parse().unwrap_or(f64::NAN))
}

/// `String(number)`: ECMAScript Number::toString, via the same `ryu-js` helper
/// the other native routes use.
fn js_number_text(value: f64) -> String {
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
    use super::{CODEX_ROOTS_FILE, SNIPPET_UNITS, Search, SearchState, search};
    use crate::config_editor_paths::join_config;
    use crate::transcripts::TranscriptRawText;
    use axum::body::{Body, to_bytes};
    use axum::extract::State;
    use axum::http::{Request, header};
    use axum::response::Response;
    use serde_json::{Value, json};
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::{SystemTime, UNIX_EPOCH};

    static FIXTURE_ID: AtomicU64 = AtomicU64::new(0);

    struct Fixture(PathBuf);

    impl Fixture {
        fn new(label: &str) -> Self {
            let unique = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let id = FIXTURE_ID.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "http-codex-search-{label}-{}-{unique}-{id}",
                std::process::id()
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        fn path(&self, rel: &str) -> PathBuf {
            rel.split('/')
                .fold(self.0.clone(), |path, part| path.join(part))
        }

        fn write(&self, rel: &str, content: &str) -> PathBuf {
            let path = self.path(rel);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, content).unwrap();
            path
        }

        /// Pin the picker roots to exactly `roots`.
        fn state(&self, roots: &[&str]) -> Search {
            let roots_json = format!(
                "[{}]",
                roots
                    .iter()
                    .map(|root| serde_json::to_string(root).unwrap())
                    .collect::<Vec<_>>()
                    .join(",")
            );
            self.state_raw(&roots_json)
        }

        /// Pin the picker roots to a hand-written array (non-string members).
        fn state_raw(&self, roots_json: &str) -> Search {
            let state_dir = self.0.join("state");
            fs::create_dir_all(&state_dir).unwrap();
            fs::write(state_dir.join(CODEX_ROOTS_FILE), roots_json).unwrap();
            Search {
                inner: Arc::new(SearchState {
                    home: self.0.join("home"),
                    codex_home: self.0.join("codex-home"),
                    roots_file: state_dir.join(CODEX_ROOTS_FILE),
                    lock: Arc::new(Mutex::new(())),
                    process_cwd: self.0.join("process"),
                    drive_cwds: Vec::new(),
                }),
            }
        }

        fn text(&self, path: &std::path::Path) -> String {
            path.to_string_lossy().into_owned()
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

    async fn send_with(state: &Search, content_type: Option<&str>, body: &str) -> (u16, String) {
        let mut builder = Request::builder()
            .method("POST")
            .uri("/api/codex-config/search");
        if let Some(content_type) = content_type {
            builder = builder.header(header::CONTENT_TYPE, content_type);
        }
        let request = builder.body(Body::from(body.to_owned())).unwrap();
        let response: Response = search(State(state.clone()), request).await;
        let status = response.status().as_u16();
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        (status, String::from_utf8(bytes.to_vec()).unwrap())
    }

    async fn send(state: &Search, body: &str) -> (u16, String) {
        send_with(state, Some("application/json"), body).await
    }

    fn hits(body: &str) -> Vec<Value> {
        serde_json::from_str::<Value>(body).unwrap()["results"]
            .as_array()
            .unwrap()
            .clone()
    }

    // VERIFY: codex-config-search-hit-shape
    #[test]
    fn hits_have_node_key_order_trimmed_text_and_sorted_paths() {
        let fixture = Fixture::new("shape");
        let user = fixture.write("codex-home/config.toml", "model = \"gpt-5\"\nnext = 1\n");
        fixture.write(
            "work/project/.codex/config.toml",
            "  MODEL: \"local\"  \nsecond = true\n",
        );
        let root = fixture.text(&fixture.path("work"));
        let state = fixture.state(&[&root]);
        let cwd = fixture.text(&fixture.path("work/project"));
        let expected_user = fixture.text(&user);
        let expected_project = cwd_project(&cwd);
        run(async {
            let (status, body) =
                send(&state, &json!({ "roots": [cwd], "q": "MODEL" }).to_string()).await;
            assert_eq!(status, 200, "{body}");
            // localeCompare on the full paths: `codex-home` sorts before `work`
            assert_eq!(
                body,
                format!(
                    concat!(
                        "{{\"results\":[",
                        "{{\"cwd\":{cwd},\"scope\":\"user\",\"path\":{user},\"line\":1,",
                        "\"text\":\"model = \\\"gpt-5\\\"\"}},",
                        "{{\"cwd\":{cwd},\"scope\":\"project\",\"path\":{project},\"line\":1,",
                        "\"text\":\"MODEL: \\\"local\\\"\"}}]}}"
                    ),
                    cwd = serde_json::to_string(&cwd).unwrap(),
                    user = serde_json::to_string(&expected_user).unwrap(),
                    project = serde_json::to_string(&expected_project).unwrap(),
                )
            );
        });
    }

    fn cwd_project(cwd: &str) -> String {
        join_config(cwd, ".codex", "config.toml", cfg!(windows))
    }

    // VERIFY: codex-config-search-authorization
    #[test]
    fn unauthorized_and_falsy_roots_are_skipped() {
        let fixture = Fixture::new("auth");
        fixture.write("codex-home/config.toml", "model = \"hit\"\n");
        fixture.write("work/project/.codex/config.toml", "model = \"hit\"\n");
        let root = fixture.text(&fixture.path("work"));
        let state = fixture.state(&[&root]);
        let outside = fixture.text(&fixture.path("elsewhere"));
        run(async {
            for roots in [
                json!([outside]),
                json!([null, false, 0, ""]),
                json!([]),
                json!(null),
                json!("ab"),
            ] {
                let (status, body) =
                    send(&state, &json!({ "roots": roots, "q": "hit" }).to_string()).await;
                assert_eq!(status, 200, "{roots}");
                assert_eq!(body, r#"{"results":[]}"#, "{roots}");
            }
        });
    }

    // VERIFY: codex-config-search-dedupe
    #[test]
    fn duplicate_authorized_roots_yield_one_user_hit() {
        let fixture = Fixture::new("dedupe");
        fixture.write("codex-home/config.toml", "model = \"hit\"\n");
        fixture.write("work/a/.codex/config.toml", "nothing = 1\n");
        fixture.write("work/b/.codex/config.toml", "nothing = 1\n");
        let root = fixture.text(&fixture.path("work"));
        let state = fixture.state(&[&root]);
        let a = fixture.text(&fixture.path("work/a"));
        let b = fixture.text(&fixture.path("work/b"));
        run(async {
            let (status, body) = send(
                &state,
                &json!({ "roots": [a, b, a], "q": "model" }).to_string(),
            )
            .await;
            assert_eq!(status, 200, "{body}");
            let hits = hits(&body);
            assert_eq!(hits.len(), 1, "{body}");
            assert_eq!(hits[0]["scope"], json!("user"));
        });
    }

    // VERIFY: codex-config-search-query-coercion
    #[test]
    fn query_values_follow_javascript_string_coercion() {
        let fixture = Fixture::new("q");
        fixture.write("codex-home/config.toml", "");
        fixture.write("work/n5/.codex/config.toml", "value n5\n");
        fixture.write("work/true/.codex/config.toml", "value true\n");
        fixture.write("work/list/.codex/config.toml", "value 1,2\n");
        fixture.write("work/object/.codex/config.toml", "value [object Object]\n");
        fixture.write("work/expo/.codex/config.toml", "value 1e+21\n");
        let root = fixture.text(&fixture.path("work"));
        let state = fixture.state(&[&root]);
        let cwds: Vec<String> = ["n5", "true", "list", "object", "expo"]
            .iter()
            .map(|name| fixture.text(&fixture.path(&format!("work/{name}"))))
            .collect();
        run(async {
            let cases = [
                (json!(5), "value n5"),
                (json!(true), "value true"),
                (json!([1, 2]), "value 1,2"),
                (json!({}), "value [object Object]"),
                (json!(1e21), "value 1e+21"),
                (json!([["1", "2"]]), "value 1,2"),
            ];
            for (q, expected) in cases {
                let (status, body) =
                    send(&state, &json!({ "roots": cwds, "q": q }).to_string()).await;
                assert_eq!(status, 200, "{q}");
                let hits = hits(&body);
                assert_eq!(hits.len(), 1, "{q}: {body}");
                assert_eq!(hits[0]["text"], json!(expected), "{q}");
            }
            // falsy q returns before the roots list is even iterated
            for q in [json!(null), json!(false), json!(0), json!(""), json!([])] {
                let (status, body) = send(&state, &json!({ "roots": 5, "q": q }).to_string()).await;
                assert_eq!((status, body.as_str()), (200, r#"{"results":[]}"#), "{q}");
            }
        });
    }

    // VERIFY: codex-config-search-roots-shapes
    #[test]
    fn roots_shapes_and_type_errors_match_node() {
        let fixture = Fixture::new("shapes");
        fixture.write("codex-home/config.toml", "model = \"hit\"\n");
        fixture.write("home/.codex/config.toml", "model = \"home project\"\n");
        let root = fixture.text(&fixture.path("work"));
        let state = fixture.state(&[&root, &fixture.text(&fixture.path("home"))]);
        run(async {
            for roots in [json!(5), json!(true), json!({}), json!({"a": 1})] {
                let (status, body) =
                    send(&state, &json!({ "roots": roots, "q": "model" }).to_string()).await;
                assert_eq!(status, 500, "{roots}");
                assert_eq!(
                    body,
                    r#"{"statusCode":500,"error":"Internal Server Error","message":"(roots || []) is not iterable"}"#,
                    "{roots}"
                );
            }
            for cwd in [json!(5), json!(true), json!({}), json!(["a"])] {
                let (status, body) =
                    send(&state, &json!({ "roots": [cwd], "q": "model" }).to_string()).await;
                assert_eq!(status, 500, "{cwd}");
                assert_eq!(
                    body,
                    r#"{"statusCode":500,"error":"Internal Server Error","message":"p.startsWith is not a function"}"#,
                    "{cwd}"
                );
            }
            // a string roots value iterates code points; `~` alone is the home dir,
            // which is pinned here, and scopePaths() never expands the tilde
            let (status, body) =
                send(&state, &json!({ "roots": "~", "q": "model" }).to_string()).await;
            assert_eq!(status, 200, "{body}");
            let hits = hits(&body);
            assert_eq!(hits.len(), 1, "{body}");
            assert_eq!(hits[0]["cwd"], json!("~"));
            assert_eq!(hits[0]["scope"], json!("user"));
        });
    }

    // VERIFY: codex-config-search-persisted-roots
    #[test]
    fn non_string_persisted_roots_skip_throw_or_short_circuit() {
        let fixture = Fixture::new("persisted");
        fixture.write("codex-home/config.toml", "model = \"hit\"\n");
        let root = fixture.text(&fixture.path("work"));
        let cwd = fixture.text(&fixture.path("work/project"));
        let body = json!({ "roots": [cwd], "q": "model" }).to_string();
        run(async {
            for roots_json in [
                format!(
                    "[null,false,0,\"\",{root_json}]",
                    root_json = serde_json::to_string(&root).unwrap()
                ),
                // a falsy non-string after the match is never reached? it is: `.some`
                // scans until the first hit, and this one is falsy anyway
                format!(
                    "[{root_json},null,false]",
                    root_json = serde_json::to_string(&root).unwrap()
                ),
                // the matching root short-circuits before the truthy non-string
                format!(
                    "[{root_json},true]",
                    root_json = serde_json::to_string(&root).unwrap()
                ),
            ] {
                let state = fixture.state_raw(&roots_json);
                let (status, response) = send(&state, &body).await;
                assert_eq!(status, 200, "{roots_json}: {response}");
                assert_eq!(hits(&response).len(), 1, "{roots_json}");
            }
            for roots_json in [
                format!(
                    "[true,{root_json}]",
                    root_json = serde_json::to_string(&root).unwrap()
                ),
                format!(
                    "[5,{root_json}]",
                    root_json = serde_json::to_string(&root).unwrap()
                ),
                format!(
                    "[{{}},{root_json}]",
                    root_json = serde_json::to_string(&root).unwrap()
                ),
            ] {
                let state = fixture.state_raw(&roots_json);
                let (status, response) = send(&state, &body).await;
                assert_eq!(status, 500, "{roots_json}: {response}");
                assert!(
                    response.contains("p.startsWith is not a function"),
                    "{response}"
                );
            }
        });
    }

    // VERIFY: codex-config-search-snippet-boundary
    #[test]
    fn snippet_is_sliced_to_200_utf16_units_and_keeps_a_split_pair() {
        let fixture = Fixture::new("snippet");
        fixture.write("codex-home/config.toml", "");
        // 199 'x' + an astral character = 201 UTF-16 units; slice(0,200) keeps a
        // lone high surrogate.
        let line = format!("{}\u{1F600}", "x".repeat(199));
        fixture.write("work/project/.codex/config.toml", &format!("{line}\n"));
        let root = fixture.text(&fixture.path("work"));
        let cwd = fixture.text(&fixture.path("work/project"));
        let state = fixture.state(&[&root]);
        run(async {
            let (status, body) =
                send(&state, &json!({ "roots": [cwd], "q": "x" }).to_string()).await;
            assert_eq!(status, 200, "{body}");
            assert!(body.contains("\\ud83d"), "{body}");
            let start = body.find("\"text\":").unwrap() + "\"text\":".len();
            let token = &body[start..body.len() - 3];
            let units = TranscriptRawText::from_json_token(token.to_owned())
                .unwrap()
                .units()
                .unwrap();
            assert_eq!(units.len(), SNIPPET_UNITS, "{body}");
            assert_eq!(units[SNIPPET_UNITS - 1], 0xd83d);
        });
    }

    // VERIFY: codex-config-search-sort
    #[test]
    fn hits_sort_with_locale_collation_not_bytes() {
        let fixture = Fixture::new("sort");
        fixture.write("codex-home/config.toml", "");
        fixture.write("work/Zeta/.codex/config.toml", "needle 1\n");
        fixture.write("work/alpha/.codex/config.toml", "needle 2\n");
        let root = fixture.text(&fixture.path("work"));
        let state = fixture.state(&[&root]);
        let zeta = fixture.text(&fixture.path("work/Zeta"));
        let alpha = fixture.text(&fixture.path("work/alpha"));
        run(async {
            let (status, body) = send(
                &state,
                &json!({ "roots": [zeta, alpha], "q": "needle" }).to_string(),
            )
            .await;
            assert_eq!(status, 200, "{body}");
            let paths: Vec<String> = hits(&body)
                .iter()
                .map(|hit| hit["path"].as_str().unwrap().to_owned())
                .collect();
            assert!(
                paths[0].contains("alpha"),
                "locale order puts alpha before Zeta: {paths:?}"
            );
        });
    }

    // VERIFY: codex-config-search-backend-failure
    #[test]
    fn backend_read_failure_becomes_a_fastify_500_message() {
        let fixture = Fixture::new("failure");
        fixture.write("codex-home/config.toml", "");
        // a directory at the project config path makes the shared backend reply
        // with `{"error": ...}` instead of an array
        fs::create_dir_all(fixture.path("work/project/.codex/config.toml")).unwrap();
        let root = fixture.text(&fixture.path("work"));
        let cwd = fixture.text(&fixture.path("work/project"));
        let state = fixture.state(&[&root]);
        run(async {
            let (status, body) = send(
                &state,
                &json!({ "roots": [cwd], "q": "needle" }).to_string(),
            )
            .await;
            assert_eq!(status, 500, "{body}");
            let payload: Value = serde_json::from_str(&body).unwrap();
            assert_eq!(payload["statusCode"], json!(500));
            assert_eq!(payload["error"], json!("Internal Server Error"));
            assert_ne!(payload["message"], json!("Rust Codex config search failed"));
            assert!(
                payload["message"]
                    .as_str()
                    .is_some_and(|text| !text.is_empty()),
                "{body}"
            );
        });
    }

    #[test]
    fn non_json_and_absent_bodies_have_no_members() {
        let fixture = Fixture::new("bodies");
        let state = fixture.state(&["/"]);
        run(async {
            for (content_type, body) in [
                (Some("text/plain"), r#"{"roots":["/"],"q":"x"}"#),
                (None, ""),
            ] {
                let (status, response) = send_with(&state, content_type, body).await;
                assert_eq!(status, 200, "{content_type:?}");
                assert_eq!(response, r#"{"results":[]}"#, "{content_type:?}");
            }
        });
    }

    #[test]
    fn snippet_keeps_text_shorter_than_the_cap() {
        assert_eq!(
            serde_json::to_string(&super::snippet("\"short\"")).unwrap(),
            "\"short\""
        );
    }
}
