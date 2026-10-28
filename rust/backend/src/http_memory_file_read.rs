// Memory file read HTTP surface: `GET /api/memory/file`, mirroring
// `server/index.mjs:756-760` -> `memory.mjs` `readMemoryFile` (31-66).
//
// The host injects the state dir (SINGULARITY_HOME/state),
// home, cwd and Node's per-drive cwd values; this module reads no process env
// and no user data of its own.
//
// Parity contract, measured against the Node route on Node v24.19.0:
//   * `?path` absent or empty -> 400 `path outside memory dirs`, no read.
//   * a repeated `?path` is a JS array, so `path.resolve` throws and Fastify
//     answers 500 with `ERR_INVALID_ARG_TYPE`.
//   * a repeated `?root` is an array, so `resolveRoot` throws and Fastify
//     answers 500 with `p.startsWith is not a function`.
//   * the target resolves lexically against cwd (`~` is never expanded) and the
//     supplied root must resolve equal to the persisted `memory-root.json` root;
//     then containment plus the `<root>/<sep><project>/memory/<name>.md` shape.
//   * authorized but missing -> 404 `not found`; any other read failure -> 400.
//
// Parity limits, reported rather than approximated:
//   * the two 500 envelopes keep the measured V8/Fastify text verbatim; another
//     Node version may word a type error differently.
//   * like the other native routes, JSON responses use `application/json`
//     without Fastify's `; charset=utf-8` (shared `http_body` gap).
use crate::http_policy::query_values;
use crate::wiki_root::resolve_units;
use axum::extract::{RawQuery, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde_json::json;
use serde_json::value::RawValue;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

const OUTSIDE: &str = "path outside memory dirs";
const NOT_FOUND: &str = "not found";
// `server/rust-backend.mjs` throws this text when a read result carries neither
// a success nor an error, so the route reports it as a 400.
const BACKEND_FAILED: &str = "Rust Memory read failed";

#[derive(Clone)]
struct MemoryFileRead {
    state_dir: PathBuf,
    home: PathBuf,
    cwd: PathBuf,
    // Windows only: Node's hidden per-drive cwd values (`=C:`), used by
    // `path.resolve` for drive-relative targets and roots.
    drive_cwds: Vec<(u16, PathBuf)>,
    lock: Arc<Mutex<()>>,
}

// VERIFY: memory-file-router-injection
pub fn router(
    state_dir: PathBuf,
    home: PathBuf,
    cwd: PathBuf,
    drive_cwds: Vec<(u16, PathBuf)>,
    lock: Arc<Mutex<()>>,
) -> Router {
    Router::new()
        .route("/api/memory/file", get(get_file))
        .with_state(MemoryFileRead {
            state_dir,
            home,
            cwd,
            drive_cwds,
            lock,
        })
}

// VERIFY: memory-file-query-shape
/// Fastify's query parser yields a string for one occurrence and an array for
/// repeats; bracket syntax stays a literal key, so `path[x]` is not `path`.
enum QueryParam {
    Absent,
    One(String),
    Array,
}

fn param(query: Option<&str>, name: &str) -> QueryParam {
    let Some(query) = query else {
        return QueryParam::Absent;
    };
    match query_values(query, name).as_slice() {
        [] => QueryParam::Absent,
        [value] => QueryParam::One(value.clone()),
        _ => QueryParam::Array,
    }
}

async fn get_file(State(state): State<MemoryFileRead>, RawQuery(query): RawQuery) -> Response {
    tokio::task::spawn_blocking(move || get_file_locked(&state, query.as_deref()))
        .await
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

fn get_file_locked(state: &MemoryFileRead, query: Option<&str>) -> Response {
    let _guard = state.lock.lock().unwrap_or_else(|error| error.into_inner());
    let windows = cfg!(windows);
    // `if (!p) return false` runs before anything else in `isMemoryPath`, and a
    // non-string path throws in `resolve` before the root is ever inspected.
    let raw_target = match param(query, "path") {
        QueryParam::Absent => return outside(),
        QueryParam::One(value) if value.is_empty() => return outside(),
        QueryParam::Array => return array_path_error(),
        QueryParam::One(value) => value,
    };
    let target = resolve_target(&state, &raw_target, windows);
    // `resolveRoot(raw || persisted)` then `resolveRoot(getMemoryRoot())`; an
    // absent or empty raw root falls back inside `is_memory_path`.
    let supplied_root = match param(query, "root") {
        QueryParam::Array => return array_root_error(),
        QueryParam::Absent => Vec::new(),
        QueryParam::One(value) if value.is_empty() => Vec::new(),
        QueryParam::One(value) => resolve_root(&state, &value, windows),
    };
    let persisted = crate::memory_root::get_root(&state.state_dir);
    let Ok(persisted_units) = persisted.units() else {
        return outside();
    };
    let persisted_root = resolve_units(
        &persisted_units,
        &state.home,
        &state.cwd,
        &state.drive_cwds,
        windows,
        true,
    );
    // VERIFY: memory-file-authorization
    if !crate::memory_auth::is_memory_path(&target, &supplied_root, &persisted_root, windows) {
        return outside();
    }
    read(&state, &raw_target)
}

fn resolve_target(state: &MemoryFileRead, value: &str, windows: bool) -> Vec<u16> {
    let units: Vec<u16> = value.encode_utf16().collect();
    // `resolve` never expands `~`; only roots go through `resolveRoot`.
    resolve_units(
        &units,
        &state.home,
        &state.cwd,
        &state.drive_cwds,
        windows,
        false,
    )
}

fn resolve_root(state: &MemoryFileRead, value: &str, windows: bool) -> Vec<u16> {
    let units: Vec<u16> = value.encode_utf16().collect();
    resolve_units(
        &units,
        &state.home,
        &state.cwd,
        &state.drive_cwds,
        windows,
        true,
    )
}

// VERIFY: memory-file-read-status
/// The read result is `memory::read_memory_file`'s payload, the same body Node
/// relays through `JSON.parse`/`JSON.stringify`. Missing stays `not found`
/// (404); every other failure is a 400 with the payload's own error text.
fn read(state: &MemoryFileRead, target: &str) -> Response {
    // Resolve relative paths against the injected process cwd without collapsing
    // `..`: the OS must follow symlinks before interpreting a subsequent `..`.
    let path = std::path::Path::new(target);
    #[cfg(windows)]
    let has_prefix = matches!(
        path.components().next(),
        Some(std::path::Component::Prefix(_))
    );
    #[cfg(not(windows))]
    let has_prefix = false;
    let path = if path.is_absolute() || has_prefix {
        path.to_path_buf()
    } else {
        state.cwd.join(path)
    };
    let payload = crate::memory::read_memory_file(&path.to_string_lossy());
    let Ok(payload) = serde_json::from_str::<ReadPayload>(payload.get()) else {
        return backend_failed();
    };
    if payload.ok != Some(true) {
        let error = payload.error.unwrap_or_else(|| BACKEND_FAILED.to_owned());
        let status = if error == NOT_FOUND {
            StatusCode::NOT_FOUND
        } else {
            StatusCode::BAD_REQUEST
        };
        return (
            status,
            Json(ReadError {
                ok: false,
                error: &error,
            }),
        )
            .into_response();
    }
    // `read_memory_file` always fills both fields on success; a malformed payload
    // is the bridge's `Rust Memory read failed` case, never a partial body.
    let (Some(content), Some(mtime)) = (payload.content, payload.mtime) else {
        return backend_failed();
    };
    let Ok(mtime) = RawValue::from_string(js_number(mtime)) else {
        return backend_failed();
    };
    Json(ReadOk {
        ok: true,
        content: content.as_str(),
        mtime: mtime.as_ref(),
    })
    .into_response()
}

#[derive(serde::Deserialize)]
struct ReadPayload {
    ok: Option<bool>,
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    mtime: Option<f64>,
    #[serde(default)]
    error: Option<String>,
}

#[derive(serde::Serialize)]
struct ReadOk<'a> {
    ok: bool,
    content: &'a str,
    // `mtime` stays a JSON number; only its text follows ECMAScript rules.
    mtime: &'a RawValue,
}

#[derive(serde::Serialize)]
struct ReadError<'a> {
    ok: bool,
    error: &'a str,
}

// VERIFY: memory-file-js-mtime
/// Node turns the payload's `mtime` into a JS number and `JSON.stringify`s it
/// again, so `1729000000000.0` leaves as `1729000000000`.
fn js_number(value: f64) -> String {
    let mut buffer = ryu_js::Buffer::new();
    buffer.format_finite(value).to_owned()
}

fn outside() -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(ReadError {
            ok: false,
            error: OUTSIDE,
        }),
    )
        .into_response()
}

fn backend_failed() -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(ReadError {
            ok: false,
            error: BACKEND_FAILED,
        }),
    )
        .into_response()
}

// Fastify's default error envelope for the thrown `path.resolve` TypeError.
fn array_path_error() -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({
            "statusCode": 500,
            "code": "ERR_INVALID_ARG_TYPE",
            "error": "Internal Server Error",
            "message": "The \"paths[0]\" argument must be of type string. Received an instance of Array",
        })),
    )
        .into_response()
}

// Fastify's default error envelope for the thrown `p.startsWith` TypeError.
fn array_root_error() -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({
            "statusCode": 500,
            "error": "Internal Server Error",
            "message": "p.startsWith is not a function",
        })),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::{MemoryFileRead, get_file, js_number};
    use axum::body::to_bytes;
    use axum::extract::{RawQuery, State};
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
            let base = std::env::temp_dir().join(format!(
                "http-memory-file-{}-{unique}-{id}",
                std::process::id()
            ));
            fs::create_dir_all(&base).unwrap();
            Self(base)
        }

        fn state_dir(&self) -> PathBuf {
            self.0.join("state")
        }

        fn root(&self) -> PathBuf {
            self.0.join("projects")
        }

        fn put(&self, rel: &str, content: &str) -> PathBuf {
            let path = self.root().join(rel);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, content).unwrap();
            path
        }

        // Writes the persisted picker root exactly as a raw JSON string token.
        fn persist_root_token(&self, token: &str) {
            fs::create_dir_all(self.state_dir()).unwrap();
            fs::write(
                self.state_dir().join("memory-root.json"),
                format!("{{\"root\":{token}}}"),
            )
            .unwrap();
        }

        fn persist_root(&self, root: &str) {
            self.persist_root_token(&serde_json::to_string(root).unwrap());
        }

        fn state(&self) -> MemoryFileRead {
            MemoryFileRead {
                state_dir: self.state_dir(),
                home: self.0.join("home"),
                cwd: self.0.clone(),
                drive_cwds: Vec::new(),
                lock: Arc::new(Mutex::new(())),
            }
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn path_text(path: &Path) -> String {
        path.to_string_lossy().into_owned()
    }

    fn encode(value: &str) -> String {
        let mut encoded = String::new();
        for byte in value.bytes() {
            if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
                encoded.push(byte as char);
            } else {
                encoded.push_str(&format!("%{byte:02X}"));
            }
        }
        encoded
    }

    fn query(params: &[(&str, &str)]) -> String {
        params
            .iter()
            .map(|(name, value)| format!("{}={}", encode(name), encode(value)))
            .collect::<Vec<_>>()
            .join("&")
    }

    fn run<F: std::future::Future>(future: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(future)
    }

    async fn send(state: &MemoryFileRead, query: &str) -> (u16, String) {
        let response = get_file(State(state.clone()), RawQuery(Some(query.to_owned()))).await;
        let status = response.status().as_u16();
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        (status, String::from_utf8(bytes.to_vec()).unwrap())
    }

    #[test]
    fn reads_an_authorized_file_and_maps_a_missing_one_to_404() {
        let fixture = Fixture::new();
        fixture.persist_root(&path_text(&fixture.root()));
        let file = path_text(&fixture.put("proj/memory/a-fact.md", "line one\n"));
        let root = path_text(&fixture.root());
        let missing = path_text(&fixture.root().join("proj/memory/missing.md"));
        let state = fixture.state();
        run(async {
            let (status, body) = send(&state, &query(&[("path", &file), ("root", &root)])).await;
            assert_eq!(status, 200, "{body}");
            let value: serde_json::Value = serde_json::from_str(&body).unwrap();
            assert_eq!(value["ok"], true);
            assert_eq!(value["content"], "line one\n");
            assert!(value["mtime"].as_f64().is_some());
            // Node relays the payload in the backend's order: ok, content, mtime.
            assert!(
                body.starts_with("{\"ok\":true,\"content\":\"line one\\n\",\"mtime\":"),
                "{body}"
            );

            assert_eq!(
                send(&state, &query(&[("path", &missing), ("root", &root)])).await,
                (404, r#"{"ok":false,"error":"not found"}"#.to_owned())
            );
        });
    }

    #[test]
    #[cfg(unix)]
    fn reads_raw_path_after_lexical_authorization_through_symlink() {
        let fixture = Fixture::new();
        fixture.persist_root(&path_text(&fixture.root()));
        let memory = fixture.root().join("proj/memory");
        let outside = fixture.0.join("outside");
        fs::create_dir_all(&memory).unwrap();
        fs::create_dir_all(outside.join("child")).unwrap();
        fs::write(memory.join("target.md"), "lexical").unwrap();
        fs::write(outside.join("target.md"), "filesystem").unwrap();
        std::os::unix::fs::symlink(outside.join("child"), memory.join("link")).unwrap();
        let raw = path_text(&memory.join("link/../target.md"));
        let (status, body) = run(send(&fixture.state(), &query(&[("path", &raw)])));
        assert_eq!(status, 200, "{body}");
        let value: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(value["content"], "filesystem");
    }

    #[test]
    fn resolves_relative_and_tilde_targets_against_the_injected_cwd() {
        let fixture = Fixture::new();
        // The persisted root is the injected cwd so cwd-relative targets are
        // authorized; `home` stays a child of it.
        let root = path_text(&fixture.0);
        fixture.persist_root(&root);
        let relative = fixture.0.join("proj/memory/a-fact.md");
        fs::create_dir_all(relative.parent().unwrap()).unwrap();
        fs::write(&relative, "relative").unwrap();
        // A literal `~` project segment proves the target is not expanded: were
        // it expanded, this would resolve under `<root>/home` and miss the file.
        let tilde = fixture.0.join("~/memory/tilde.md");
        fs::create_dir_all(tilde.parent().unwrap()).unwrap();
        fs::write(&tilde, "literal tilde").unwrap();
        let state = fixture.state();
        run(async {
            assert_eq!(
                send(
                    &state,
                    &query(&[("path", "proj/memory/a-fact.md"), ("root", &root)])
                )
                .await
                .0,
                200
            );
            assert_eq!(
                send(
                    &state,
                    &query(&[("path", "~/memory/tilde.md"), ("root", &root)])
                )
                .await
                .0,
                200
            );
            // An omitted or empty root falls back to the persisted one.
            assert_eq!(
                send(&state, &query(&[("path", "proj/memory/a-fact.md")]))
                    .await
                    .0,
                200
            );
            assert_eq!(
                send(
                    &state,
                    &query(&[("path", "proj/memory/a-fact.md"), ("root", "")])
                )
                .await
                .0,
                200
            );
        });
    }

    #[test]
    fn rejects_empty_widened_sibling_and_out_of_shape_targets() {
        let fixture = Fixture::new();
        fixture.persist_root(&path_text(&fixture.root()));
        let file = path_text(&fixture.put("proj/memory/a-fact.md", "x"));
        let root = path_text(&fixture.root());
        let widened = path_text(fixture.root().ancestors().last().unwrap());
        let sibling_root = path_text(&PathBuf::from(format!("{root}-evil")));
        let sibling_file =
            path_text(&PathBuf::from(format!("{root}-evil")).join("proj/memory/a.md"));
        let notes = path_text(&fixture.root().join("proj/notes/a.md"));
        let wrong_ext = path_text(&fixture.root().join("proj/memory/a.txt"));
        let escape = path_text(&fixture.root().join("proj/memory/../../../escape.md"));
        let state = fixture.state();
        run(async {
            for query in [
                query(&[("root", &root)]),
                query(&[("path", ""), ("root", &root)]),
                // A caller-supplied root must equal the persisted one, even a
                // trivially containing filesystem root.
                query(&[("path", &file), ("root", &widened)]),
                query(&[("path", &file), ("root", &sibling_root)]),
                query(&[("path", &sibling_file), ("root", &root)]),
                query(&[("path", &notes), ("root", &root)]),
                query(&[("path", &wrong_ext), ("root", &root)]),
                query(&[("path", &escape), ("root", &root)]),
            ] {
                assert_eq!(
                    send(&state, &query).await,
                    (
                        400,
                        r#"{"ok":false,"error":"path outside memory dirs"}"#.to_owned()
                    ),
                    "{query}"
                );
            }
        });
    }

    #[test]
    fn repeated_query_values_reproduce_the_fastify_arrays() {
        let fixture = Fixture::new();
        fixture.persist_root(&path_text(&fixture.root()));
        let file = path_text(&fixture.put("proj/memory/a-fact.md", "x"));
        let missing = path_text(&fixture.root().join("proj/memory/missing.md"));
        let root = path_text(&fixture.root());
        let state = fixture.state();
        run(async {
            let repeated_path = format!(
                "path={}&path={}&root={}",
                encode(&file),
                encode(&missing),
                encode(&root)
            );
            assert_eq!(
                send(&state, &repeated_path).await,
                (
                    500,
                    concat!(
                        r#"{"statusCode":500,"code":"ERR_INVALID_ARG_TYPE","#,
                        r#""error":"Internal Server Error","#,
                        r#""message":"The \"paths[0]\" argument must be of type string. "#,
                        r#"Received an instance of Array"}"#
                    )
                    .to_owned()
                )
            );

            let repeated_root = format!(
                "path={}&root={}&root={}",
                encode(&file),
                encode(&root),
                encode(&root)
            );
            assert_eq!(
                send(&state, &repeated_root).await,
                (
                    500,
                    concat!(
                        r#"{"statusCode":500,"error":"Internal Server Error","#,
                        r#""message":"p.startsWith is not a function"}"#
                    )
                    .to_owned()
                )
            );

            // `!p` is checked before the root is touched.
            let empty_with_repeated_root =
                format!("path=&root={}&root={}", encode(&root), encode(&root));
            assert_eq!(send(&state, &empty_with_repeated_root).await.0, 400);
            // The path is resolved before the root, so its throw wins.
            assert_eq!(
                send(&state, &format!("{repeated_path}&root={}", encode(&root)))
                    .await
                    .0,
                500
            );

            // Bracket syntax is a literal key, not `path`; a bare key is empty.
            assert_eq!(
                send(&state, &format!("path[x]=1&root={}", encode(&root)))
                    .await
                    .0,
                400
            );
            assert_eq!(
                send(&state, &format!("path&root={}", encode(&root)))
                    .await
                    .0,
                400
            );
        });
    }

    #[test]
    fn a_persisted_lone_surrogate_root_never_authorizes_a_lossy_root() {
        let fixture = Fixture::new();
        // Raw token: the persisted root ends in an unpaired surrogate, which a
        // UTF-8 query string can only spell as U+FFFD.
        let prefix = format!(
            "{}{}",
            path_text(&fixture.root()),
            std::path::MAIN_SEPARATOR
        );
        let mut token = serde_json::to_string(&prefix).unwrap();
        token.pop();
        token.push_str("\\ud800\"");
        fixture.persist_root_token(&token);
        let lossy_root = format!("{prefix}\u{fffd}");
        let lossy_file = path_text(&PathBuf::from(&lossy_root).join("proj/memory/a-fact.md"));
        let state = fixture.state();
        run(async {
            // Supplied root differs from the persisted root at the raw-unit level.
            assert_eq!(
                send(
                    &state,
                    &query(&[("path", &lossy_file), ("root", &lossy_root)])
                )
                .await
                .0,
                400
            );
            // Falling back to the persisted root still cannot contain the
            // lossy spelling, and must not panic on the lone surrogate.
            assert_eq!(send(&state, &query(&[("path", &lossy_file)])).await.0, 400);
            assert_eq!(
                send(&state, &query(&[("path", &lossy_file), ("root", &prefix)]))
                    .await
                    .0,
                400
            );
        });
    }

    #[test]
    fn integral_mtimes_use_ecmascript_number_text() {
        assert_eq!(js_number(1_729_000_000_000.0), "1729000000000");
        assert_eq!(js_number(1_729_000_000_123.5), "1729000000123.5");
    }
}
