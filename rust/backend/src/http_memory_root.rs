// Memory root HTTP surface: `GET`/`PUT /api/memory/root`, mirroring
// `server/index.mjs:749-750` -> `memory.mjs` `getMemoryRoot`/`setMemoryRoot`.
//
// The state dir is host-injected (SINGULARITY_HOME/state); the body is read only for
// its last `root` member, so a request can never redirect the write. Root tokens stay
// raw (`wiki_root::RootValue`), so escaped lone surrogates survive both the response
// and the persisted file without a lossy `serde_json::Value` hop.
//
// Common filesystem failures use Node-style error text; other failures retain Rust's
// `io::Error` text. Body errors use the shared Fastify-shaped `http_body` responses.
use crate::http_body::parse_raw;
use crate::wiki_root::{RootResponse, request_root};
use axum::body::Body;
use axum::extract::State;
use axum::http::Request;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

#[derive(Clone)]
pub struct MemoryServices {
    pub state_dir: PathBuf,
    pub home: PathBuf,
    pub cwd: PathBuf,
    pub drive_cwds: Vec<(u16, PathBuf)>,
    pub backups_dir: PathBuf,
    pub locale: String,
}

impl MemoryServices {
    pub fn from_env(state_dir: PathBuf, backups_dir: PathBuf) -> std::io::Result<Self> {
        Ok(Self {
            state_dir,
            home: crate::memory_root::current_node_home()?,
            cwd: std::env::current_dir()?,
            drive_cwds: crate::wiki_root::current_drive_cwds(),
            backups_dir,
            locale: crate::memory_collation::system_locale(),
        })
    }

    pub fn router(self) -> Router {
        let lock = Arc::new(Mutex::new(()));
        let file_lock = Arc::new(Mutex::new(()));
        router(self.state_dir.clone(), lock.clone())
            .merge(crate::http_memory_file_read::router(
                self.state_dir.clone(),
                self.home.clone(),
                self.cwd.clone(),
                self.drive_cwds.clone(),
                lock.clone(),
                file_lock.clone(),
            ))
            .merge(crate::http_memory_file_write::router(
                self.state_dir.clone(),
                self.home.clone(),
                self.cwd.clone(),
                self.drive_cwds.clone(),
                self.backups_dir,
                lock.clone(),
                file_lock,
            ))
            .merge(crate::http_memory_list::router(
                self.state_dir,
                self.home,
                self.cwd,
                self.drive_cwds,
                self.locale,
                lock,
            ))
    }
}

#[derive(Clone)]
struct MemoryRoot {
    state_dir: PathBuf,
    // Shared with file operations so authorization cannot race root changes.
    lock: Arc<Mutex<()>>,
}

pub fn router(state_dir: PathBuf, lock: Arc<Mutex<()>>) -> Router {
    Router::new()
        .route("/api/memory/root", get(get_root).put(put_root))
        .with_state(MemoryRoot { state_dir, lock })
}

async fn get_root(State(state): State<MemoryRoot>) -> Response {
    tokio::task::spawn_blocking(move || {
        let _guard = state.lock.lock().unwrap_or_else(|error| error.into_inner());
        Json(RootResponse {
            root: crate::memory_root::get_root(&state.state_dir),
        })
        .into_response()
    })
    .await
    .unwrap_or_else(|_| axum::http::StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

async fn put_root(State(state): State<MemoryRoot>, request: Request<Body>) -> Response {
    let body = match parse_raw(request).await {
        Ok(body) => body,
        Err(response) => return response,
    };
    // `req.body?.root`: only a JSON object's last `root` counts; scalar, array, plain
    // text and absent bodies have none. Re-parsing the raw token keeps lone surrogates
    // out of `Value`, which cannot represent them.
    let root = body
        .raw
        .as_deref()
        .and_then(|raw| request_root(raw.get()).ok().flatten());
    tokio::task::spawn_blocking(move || {
        let _guard = state.lock.lock().unwrap_or_else(|error| error.into_inner());
        Json(crate::memory_root::set_root(&state.state_dir, root)).into_response()
    })
    .await
    .unwrap_or_else(|_| axum::http::StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

#[cfg(test)]
mod tests {
    use super::{MemoryRoot, get_root, put_root};
    use axum::body::{Body, to_bytes};
    use axum::extract::State;
    use axum::http::{Method, Request, header};
    use axum::response::Response;
    use serde_json::Value;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::{SystemTime, UNIX_EPOCH};

    // Pins the literal from memory.mjs:20-21 rather than reusing DEFAULT_ROOT.
    const DEFAULT_BODY: &str = r#"{"root":"~/.claude/projects"}"#;
    const BAD_ROOT: &str = r#"{"ok":false,"error":"bad root"}"#;

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
                "http-memory-root-{}-{unique}-{id}",
                std::process::id()
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }

        fn state_dir(&self) -> PathBuf {
            self.0.join("state")
        }

        fn root_file(&self) -> PathBuf {
            self.state_dir().join("memory-root.json")
        }

        fn write_root_file(&self, text: &str) {
            fs::create_dir_all(self.state_dir()).unwrap();
            fs::write(self.root_file(), text).unwrap();
        }

        fn state(&self) -> MemoryRoot {
            MemoryRoot {
                state_dir: self.state_dir(),
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
        let mut builder = Request::builder().method(method).uri("/api/memory/root");
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

    async fn send_get(state: &MemoryRoot) -> (u16, String) {
        collect(get_root(State(state.clone())).await).await
    }

    async fn send_put(state: &MemoryRoot, content_type: Option<&str>, body: &str) -> (u16, String) {
        collect(
            put_root(
                State(state.clone()),
                request(Method::PUT, content_type, body),
            )
            .await,
        )
        .await
    }

    #[test]
    fn get_root_defaults_to_the_node_literal() {
        let fixture = Fixture::new();
        let state = fixture.state();
        run(async {
            assert_eq!(send_get(&state).await, (200, DEFAULT_BODY.to_owned()));
            for raw in [
                "{",
                "null",
                "42",
                r#""text""#,
                "[]",
                "{}",
                r#"{"root":42}"#,
                r#"{"root":null}"#,
                r#"{"root":[]}"#,
                r#"{"root":""}"#,
                r#"{"other":"/x"}"#,
                r#"{"\ud800":1}"#,
            ] {
                fixture.write_root_file(raw);
                assert_eq!(
                    send_get(&state).await,
                    (200, DEFAULT_BODY.to_owned()),
                    "{raw}"
                );
            }
        });
    }

    #[test]
    fn put_root_persists_and_get_root_returns_the_token_verbatim() {
        let fixture = Fixture::new();
        let state = fixture.state();
        run(async {
            assert_eq!(
                send_put(
                    &state,
                    Some("application/json"),
                    r#"{"root":"/srv/memory"}"#
                )
                .await,
                (200, r#"{"ok":true,"root":"/srv/memory"}"#.to_owned())
            );
            assert_eq!(
                fs::read(fixture.root_file()).unwrap(),
                br#"{"root":"/srv/memory"}"#.as_slice()
            );
            assert_eq!(
                send_get(&state).await,
                (200, r#"{"root":"/srv/memory"}"#.to_owned())
            );

            assert_eq!(
                send_put(&state, Some("application/json"), r#"{"root":"記憶 🧪"}"#).await,
                (200, r#"{"ok":true,"root":"記憶 🧪"}"#.to_owned())
            );
            assert_eq!(
                fs::read_to_string(fixture.root_file()).unwrap(),
                r#"{"root":"記憶 🧪"}"#
            );
            assert_eq!(
                send_get(&state).await,
                (200, r#"{"root":"記憶 🧪"}"#.to_owned())
            );

            // Whitespace is preserved, not trimmed or expanded.
            assert_eq!(
                send_put(&state, Some("application/json"), r#"{"root":"  ~/x  "}"#).await,
                (200, r#"{"ok":true,"root":"  ~/x  "}"#.to_owned())
            );
            assert_eq!(
                fs::read_to_string(fixture.root_file()).unwrap(),
                r#"{"root":"  ~/x  "}"#
            );
        });
    }

    #[test]
    fn put_root_rejects_missing_non_string_and_empty_roots_without_writing() {
        let fixture = Fixture::new();
        let state = fixture.state();
        run(async {
            for body in [
                "{}",
                r#"{"root":42}"#,
                r#"{"root":null}"#,
                r#"{"root":[]}"#,
                r#"{"root":{}}"#,
                r#"{"root":""}"#,
            ] {
                assert_eq!(
                    send_put(&state, Some("application/json"), body).await,
                    (200, BAD_ROOT.to_owned()),
                    "{body}"
                );
                assert!(!fixture.state_dir().exists(), "{body}");
            }
            // Plain text and an absent body carry no `root` member at all.
            assert_eq!(
                send_put(&state, Some("text/plain"), r#"{"root":"/x"}"#).await,
                (200, BAD_ROOT.to_owned())
            );
            assert_eq!(send_put(&state, None, "").await, (200, BAD_ROOT.to_owned()));
            assert!(!fixture.state_dir().exists());
        });
    }

    #[test]
    fn put_root_uses_the_last_duplicate_root_and_ignores_other_fields() {
        let fixture = Fixture::new();
        let state = fixture.state();
        run(async {
            assert_eq!(
                send_put(
                    &state,
                    Some("application/json"),
                    r#"{"root":"a","root":"b"}"#
                )
                .await,
                (200, r#"{"ok":true,"root":"b"}"#.to_owned())
            );
            assert_eq!(send_get(&state).await, (200, r#"{"root":"b"}"#.to_owned()));

            // A lone-surrogate key is decoded as units and ignored, as `JSON.parse` does.
            assert_eq!(
                send_put(
                    &state,
                    Some("application/json"),
                    r#"{"\ud800":1,"root":"x"}"#
                )
                .await,
                (200, r#"{"ok":true,"root":"x"}"#.to_owned())
            );
            assert_eq!(send_get(&state).await, (200, r#"{"root":"x"}"#.to_owned()));

            // A non-string last duplicate is `bad root` and leaves the file untouched.
            assert_eq!(
                send_put(&state, Some("application/json"), r#"{"root":"kept"}"#).await,
                (200, r#"{"ok":true,"root":"kept"}"#.to_owned())
            );
            assert_eq!(
                send_put(
                    &state,
                    Some("application/json"),
                    r#"{"root":"/x","root":42}"#
                )
                .await,
                (200, BAD_ROOT.to_owned())
            );
            assert_eq!(
                fs::read_to_string(fixture.root_file()).unwrap(),
                r#"{"root":"kept"}"#
            );

            // `state_dir` in the body is unknown and never consulted.
            assert_eq!(
                send_put(
                    &state,
                    Some("application/json"),
                    r#"{"root":"/x","state_dir":"elsewhere"}"#
                )
                .await,
                (200, r#"{"ok":true,"root":"/x"}"#.to_owned())
            );
            assert_eq!(
                fs::read_to_string(fixture.root_file()).unwrap(),
                r#"{"root":"/x"}"#
            );
            assert!(!fixture.0.join("elsewhere").exists());
        });
    }

    #[test]
    fn lone_surrogates_round_trip_through_response_and_file() {
        let fixture = Fixture::new();
        let state = fixture.state();
        run(async {
            assert_eq!(
                send_put(&state, Some("application/json"), r#"{"root":"\ud800"}"#).await,
                (200, r#"{"ok":true,"root":"\ud800"}"#.to_owned())
            );
            assert_eq!(
                fs::read(fixture.root_file()).unwrap(),
                br#"{"root":"\ud800"}"#.as_slice()
            );
            assert_eq!(
                send_get(&state).await,
                (200, r#"{"root":"\ud800"}"#.to_owned())
            );

            assert_eq!(
                send_put(&state, Some("application/json"), r#"{"root":"a\ud800b"}"#).await,
                (200, r#"{"ok":true,"root":"a\ud800b"}"#.to_owned())
            );
            assert_eq!(
                send_get(&state).await,
                (200, r#"{"root":"a\ud800b"}"#.to_owned())
            );

            assert_eq!(
                send_put(&state, Some("application/json"), r#"{"root":"𐀀\ud801"}"#).await,
                (200, r#"{"ok":true,"root":"𐀀\ud801"}"#.to_owned())
            );
            assert_eq!(
                send_get(&state).await,
                (200, r#"{"root":"𐀀\ud801"}"#.to_owned())
            );

            // A file written by Node carries the same raw token.
            fixture.write_root_file(r#"{"root":"\ud800"}"#);
            assert_eq!(
                send_get(&state).await,
                (200, r#"{"root":"\ud800"}"#.to_owned())
            );
        });
    }

    #[test]
    fn roots_use_javascript_json_stringification() {
        let fixture = Fixture::new();
        let state = fixture.state();
        run(async {
            let input = r#"{"root":"\/\u0061\uD800"}"#;
            let expected = r#"{"root":"/a\ud800"}"#;
            assert_eq!(
                send_put(&state, Some("application/json"), input).await,
                (200, r#"{"ok":true,"root":"/a\ud800"}"#.to_owned())
            );
            assert_eq!(fs::read_to_string(fixture.root_file()).unwrap(), expected);
            fixture.write_root_file(input);
            assert_eq!(send_get(&state).await, (200, expected.to_owned()));
        });
    }

    #[test]
    fn body_errors_match_the_shared_fastify_parser() {
        let fixture = Fixture::new();
        let state = fixture.state();
        run(async {
            for (content_type, body, status, code) in [
                (
                    Some("application/json"),
                    "{",
                    400,
                    "FST_ERR_CTP_INVALID_JSON_BODY",
                ),
                (
                    Some("application/json"),
                    "",
                    400,
                    "FST_ERR_CTP_EMPTY_JSON_BODY",
                ),
                (
                    Some("application/json; charset=utf-8"),
                    "[1,",
                    400,
                    "FST_ERR_CTP_INVALID_JSON_BODY",
                ),
                (
                    Some("application/xml"),
                    "<x/>",
                    415,
                    "FST_ERR_CTP_INVALID_MEDIA_TYPE",
                ),
                (None, "payload", 415, "FST_ERR_CTP_INVALID_MEDIA_TYPE"),
            ] {
                let (actual_status, response_body) = send_put(&state, content_type, body).await;
                assert_eq!(actual_status, status, "{body}");
                let value: Value = serde_json::from_str(&response_body).unwrap();
                assert_eq!(value["code"], code, "{body}");
            }
            assert!(!fixture.state_dir().exists());

            // Valid non-object JSON reaches the handler; `body?.root` yields nothing.
            for body in ["42", r#""text""#, "null", "true", "[]"] {
                assert_eq!(
                    send_put(&state, Some("application/json"), body).await,
                    (200, BAD_ROOT.to_owned()),
                    "{body}"
                );
            }
            assert!(!fixture.state_dir().exists());
        });
    }

    #[test]
    fn write_failure_returns_a_success_status_with_an_error_body() {
        let fixture = Fixture::new();
        fs::write(fixture.state_dir(), "not a directory").unwrap();
        let state = fixture.state();
        run(async {
            let (status, body) =
                send_put(&state, Some("application/json"), r#"{"root":"/x"}"#).await;
            let value: Value = serde_json::from_str(&body).unwrap();
            assert_eq!(status, 200);
            assert_eq!(value["ok"], false);
            assert!(
                value["error"]
                    .as_str()
                    .is_some_and(|error| !error.is_empty())
            );
        });
    }

    #[test]
    fn concurrent_reads_and_writes_never_observe_a_partial_file() {
        let fixture = Fixture::new();
        let state = fixture.state();
        run(async {
            let roots: Vec<String> = (0..8).map(|index| format!("/srv/memory-{index}")).collect();
            fixture.write_root_file(&format!(r#"{{"root":"{}"}}"#, roots[0]));
            let mut tasks = Vec::new();
            for (index, root) in roots.iter().enumerate() {
                let put_state = state.clone();
                let body = format!(r#"{{"root":"{root}"}}"#);
                tasks.push(tokio::spawn(async move {
                    send_put(&put_state, Some("application/json"), &body).await
                }));
                if index % 2 == 0 {
                    let get_state = state.clone();
                    tasks.push(tokio::spawn(async move { send_get(&get_state).await }));
                }
            }
            for task in tasks {
                let (status, body) = task.await.unwrap();
                assert_eq!(status, 200, "{body}");
                let value: Value = serde_json::from_str(&body).unwrap();
                if let Some(root) = value.get("root").and_then(Value::as_str) {
                    assert!(roots.iter().any(|candidate| candidate == root), "{body}");
                } else {
                    panic!("missing root: {body}");
                }
            }

            let (status, body) = send_get(&state).await;
            assert_eq!(status, 200);
            let value: Value = serde_json::from_str(&body).unwrap();
            let root = value["root"].as_str().unwrap();
            assert!(roots.iter().any(|candidate| candidate == root), "{root}");

            let stored: Value =
                serde_json::from_str(&fs::read_to_string(fixture.root_file()).unwrap()).unwrap();
            let stored = stored["root"].as_str().unwrap();
            assert!(
                roots.iter().any(|candidate| candidate == stored),
                "{stored}"
            );
        });
    }
}
