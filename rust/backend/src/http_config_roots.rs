// Config editor root lists: `GET`/`PUT /api/config/roots` and
// `GET`/`PUT /api/codex-config/roots`, mirroring `server/index.mjs:596-597,627-628`
// -> `config.mjs` / `codex-config.mjs` (`getConfigRoots`/`setConfigRoots`) and the
// bridge in `server/rust-backend.mjs` (`pickerRootsGet`/`pickerRootsSet`).
//
// Each family owns its file under the host-injected state dir, and all filesystem
// work runs on the blocking pool under the injected shared lock. Root tokens stay
// raw end to end: `picker_roots` reads and writes raw array text, and the request's
// last `roots` member is scanned out of the document `parse_raw` already validated,
// so escaped lone surrogates and duplicate keys match `JSON.parse` without a lossy
// `serde_json::Value` hop. Replies keep each element token's original spelling, while
// Node re-serializes: escapes, inner whitespace and (hand-edited files only) numbers
// such as `1e999`/`-0` differ in bytes. Falsy or missing `roots` store `[]`; a truthy non-array
// reproduces the Node handler's TypeError as a Fastify 500.
use crate::http_body::{RawBody, parse_raw};
use crate::picker_roots::SetRootsResult;
use axum::body::Body;
use axum::extract::State;
use axum::http::{Request, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde_json::value::RawValue;
use serde_json::{Value, json};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

const CONFIG_ROOTS_FILE: &str = "config-roots.json";
const CODEX_ROOTS_FILE: &str = "codex-config-roots.json";
// `picker_roots::get_roots` returns this same array when the file is absent,
// empty, unreadable or not a JSON array; here it only backs an unreachable fallback.
const DEFAULT_ROOTS_ARRAY: &str = "[\"~\"]";
// Fastify's message for the TypeError thrown by `(roots || []).filter` on a
// truthy non-array `roots` (`server/config.test.mjs` pins the same text).
const FILTER_ERROR: &str = "(roots || []).filter is not a function";

#[derive(Clone)]
struct Roots {
    path: PathBuf,
    // Shared with the other routes so root reads and writes cannot interleave.
    lock: Arc<Mutex<()>>,
}

// VERIFY: config-roots-router-injection
/// Both families share one handler pair; only the state (and so the file) differs.
pub fn router(state_dir: PathBuf, lock: Arc<Mutex<()>>) -> Router {
    let config = Roots {
        path: state_dir.join(CONFIG_ROOTS_FILE),
        lock: lock.clone(),
    };
    let codex = Roots {
        path: state_dir.join(CODEX_ROOTS_FILE),
        lock,
    };
    Router::new()
        .route("/api/config/roots", get(get_roots).put(put_roots))
        .with_state(config)
        .merge(
            Router::new()
                .route("/api/codex-config/roots", get(get_roots).put(put_roots))
                .with_state(codex),
        )
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
            Json(RootsReply { roots: &*roots }).into_response()
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
        Err(()) => return filter_error(),
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
                roots: Some(&*roots),
                error: None,
            })
            .into_response()
        }
        // The bridge surfaces the native error text verbatim, so keep `io::Error`
        // wording rather than inventing a Node-style message.
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

// VERIFY: config-roots-normalization
/// `req.body?.roots` for the Node handler: only a JSON object's last `roots`
/// member counts, so scalar, array, plain-text and absent bodies have none.
/// Missing, `null`, `false`, `0` and `""` are falsy and store `[]`; any other
/// non-array is truthy and throws in the handler; arrays are forwarded as their
/// original raw token so escaped lone surrogates reach `picker_roots` unchanged.
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
            .and_then(|raw| crate::wiki_root::raw_fields(raw.get()).ok().flatten())
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

/// JavaScript truthiness of a parsed JSON value. JSON cannot express `NaN`, so a
/// number is falsy exactly when it decodes to zero (including `-0`); a number that
/// `as_f64` cannot decode is still a truthy non-array.
fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(value) => value.as_f64() != Some(0.0),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
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

fn filter_error() -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({
            "statusCode": 500,
            "error": "Internal Server Error",
            "message": FILTER_ERROR,
        })),
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
    use super::{CODEX_ROOTS_FILE, CONFIG_ROOTS_FILE, FILTER_ERROR, Roots, get_roots, put_roots};
    use axum::body::{Body, to_bytes};
    use axum::extract::State;
    use axum::http::{Method, Request, header};
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
        fn new() -> Self {
            let unique = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let id = FIXTURE_ID.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "http-config-roots-{}-{unique}-{id}",
                std::process::id()
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }

        fn state_dir(&self) -> PathBuf {
            self.0.join("state")
        }

        fn state(&self, name: &str) -> Roots {
            Roots {
                path: self.state_dir().join(name),
                lock: Arc::new(Mutex::new(())),
            }
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

    fn request(method: Method, content_type: Option<&str>, body: &str) -> Request<Body> {
        let mut builder = Request::builder().method(method).uri("/api/config/roots");
        if let Some(content_type) = content_type {
            builder = builder.header(header::CONTENT_TYPE, content_type);
        }
        builder.body(Body::from(body.to_owned())).unwrap()
    }

    async fn collect(response: Response) -> (u16, String) {
        let status = response.status().as_u16();
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        (status, String::from_utf8(bytes.to_vec()).unwrap())
    }

    async fn send_get(state: &Roots) -> (u16, String) {
        collect(get_roots(State(state.clone())).await).await
    }

    async fn send_put(state: &Roots, content_type: Option<&str>, body: &str) -> (u16, String) {
        let message = request(Method::PUT, content_type, body);
        collect(put_roots(State(state.clone()), message).await).await
    }

    // VERIFY: config-roots-storage-separation
    #[test]
    fn families_store_separately_and_normalize_roots() {
        let fixture = Fixture::new();
        let config = fixture.state(CONFIG_ROOTS_FILE);
        let codex = fixture.state(CODEX_ROOTS_FILE);
        let config_file = fixture.state_dir().join(CONFIG_ROOTS_FILE);
        let codex_file = fixture.state_dir().join(CODEX_ROOTS_FILE);
        run(async {
            assert_eq!(
                send_get(&config).await,
                (200, r#"{"roots":["~"]}"#.to_owned())
            );
            assert_eq!(
                send_get(&codex).await,
                (200, r#"{"roots":["~"]}"#.to_owned())
            );

            // dedupe by UTF-16 units, drop non-strings and empties, keep order
            let normalized = send_put(
                &config,
                Some("application/json"),
                r#"{"roots":["/a","/a","","/b",3,false]}"#,
            )
            .await;
            assert_eq!(
                normalized,
                (200, r#"{"ok":true,"roots":["/a","/b"]}"#.to_owned())
            );
            assert_eq!(
                send_get(&codex).await,
                (200, r#"{"roots":["~"]}"#.to_owned())
            );
            assert_eq!(
                fs::read_to_string(&config_file).unwrap(),
                "[\n  \"/a\",\n  \"/b\"\n]"
            );

            let saved = send_put(&codex, Some("application/json"), r#"{"roots":["/c"]}"#).await;
            assert_eq!(saved, (200, r#"{"ok":true,"roots":["/c"]}"#.to_owned()));
            assert_eq!(
                send_get(&config).await,
                (200, r#"{"roots":["/a","/b"]}"#.to_owned())
            );
            assert_eq!(fs::read_to_string(&codex_file).unwrap(), "[\n  \"/c\"\n]");
        });
    }

    // VERIFY: config-roots-falsy-and-type-errors
    #[test]
    fn falsy_or_missing_roots_store_empty_and_truthy_non_arrays_are_500() {
        let fixture = Fixture::new();
        let state = fixture.state(CONFIG_ROOTS_FILE);
        run(async {
            for body in [
                r#"{"roots":false}"#,
                r#"{"roots":null}"#,
                r#"{"roots":0}"#,
                r#"{"roots":-0}"#,
                r#"{"roots":0.0}"#,
                r#"{"roots":""}"#,
                r#"{"roots":[]}"#,
                r#"{"other":["/a"]}"#,
                r#"{"roots":"/a","roots":false}"#,
                "[]",
                r#""roots""#,
                "null",
            ] {
                assert_eq!(
                    send_put(&state, Some("application/json"), body).await,
                    (200, r#"{"ok":true,"roots":[]}"#.to_owned()),
                    "{body}"
                );
            }
            // a plain-text or absent body has no `roots` member
            assert_eq!(
                send_put(&state, Some("text/plain"), r#"{"roots":["/a"]}"#).await,
                (200, r#"{"ok":true,"roots":[]}"#.to_owned())
            );
            assert_eq!(
                send_put(&state, None, "").await,
                (200, r#"{"ok":true,"roots":[]}"#.to_owned())
            );

            for body in [
                r#"{"roots":"bad"}"#,
                r#"{"roots":{}}"#,
                r#"{"roots":true}"#,
                r#"{"roots":1}"#,
                r#"{"roots":["/a"],"roots":"bad"}"#,
            ] {
                let (status, response) = send_put(&state, Some("application/json"), body).await;
                assert_eq!(status, 500, "{body}");
                let payload: Value = serde_json::from_str(&response).unwrap();
                assert_eq!(payload["statusCode"], json!(500));
                assert_eq!(payload["error"], json!("Internal Server Error"));
                assert_eq!(payload["message"], json!(FILTER_ERROR));
            }
        });
    }

    // VERIFY: config-roots-surrogates
    #[test]
    fn escaped_surrogates_and_duplicate_keys_survive_verbatim() {
        let fixture = Fixture::new();
        let state = fixture.state(CONFIG_ROOTS_FILE);
        let file = fixture.state_dir().join(CONFIG_ROOTS_FILE);
        run(async {
            let saved = send_put(
                &state,
                Some("application/json"),
                r#"{"roots":["\ud800","\\ud800","a","a"]}"#,
            )
            .await;
            assert_eq!(
                saved,
                (
                    200,
                    r#"{"ok":true,"roots":["\ud800","\\ud800","a"]}"#.to_owned()
                )
            );
            assert_eq!(
                fs::read_to_string(&file).unwrap(),
                "[\n  \"\\ud800\",\n  \"\\\\ud800\",\n  \"a\"\n]"
            );
            assert_eq!(
                send_get(&state).await,
                (200, r#"{"roots":["\ud800","\\ud800","a"]}"#.to_owned())
            );

            // duplicate keys: the last member wins, as in `JSON.parse`
            let reopened = send_put(
                &state,
                Some("application/json"),
                r#"{"roots":["/old"],"roots":["\udfff"]}"#,
            )
            .await;
            assert_eq!(
                reopened,
                (200, r#"{"ok":true,"roots":["\udfff"]}"#.to_owned())
            );

            // an escaped key spelling is the same member as `roots`
            let escaped_key =
                send_put(&state, Some("application/json"), r#"{"ro\u006fts":["/x"]}"#).await;
            assert_eq!(
                escaped_key,
                (200, r#"{"ok":true,"roots":["/x"]}"#.to_owned())
            );
        });
    }

    #[test]
    fn storage_failure_returns_ok_false_with_status_200() {
        let fixture = Fixture::new();
        fs::create_dir_all(fixture.state_dir().join(CONFIG_ROOTS_FILE)).unwrap();
        let state = fixture.state(CONFIG_ROOTS_FILE);
        run(async {
            let (status, body) =
                send_put(&state, Some("application/json"), r#"{"roots":["/a"]}"#).await;
            assert_eq!(status, 200);
            let payload: Value = serde_json::from_str(&body).unwrap();
            assert_eq!(payload["ok"], json!(false));
            assert!(payload.get("roots").is_none());
            assert!(
                payload["error"]
                    .as_str()
                    .is_some_and(|error| !error.is_empty())
            );
        });
    }
}
