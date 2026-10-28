//! Codex config read HTTP surface: `GET /api/codex-config`, mirroring
//! `server/index.mjs:615-619` -> `codex-config.mjs` `readConfig` (33-50),
//! `scopePaths` (16-21), `isKnownConfigRoot` (108-116) and the bridge's
//! `codexConfigRead` in `server/rust-backend.mjs`.
//!
//! The host injects the Codex home (`CODEX_HOME` in Node, never read here), the
//! state dir (the roots file lives under it), the user home, the process cwd and
//! Node's per-drive cwd values; this module reads no process env and no user
//! data of its own.
//!
//! Parity contract, measured against the Node route on Node v24.19.0:
//!   * `?cwd` absent or empty -> 400 `{"error":"cwd required"}`, no file access.
//!     A repeated `?cwd` arrives as a JS array, so `path.join` throws before
//!     authorization runs and Fastify answers 500 `ERR_INVALID_ARG_TYPE`.
//!   * paths are derived server-side: `join(cwd, '.codex', 'config.toml')` and
//!     `join(CODEX_HOME, 'config.toml')`, with Node's `path.join` string rules.
//!     `~` is never expanded here, so a `~` cwd yields a literal
//!     `~/.codex/config.toml` even though authorization expanded it.
//!   * `cwd` must resolve under a root persisted in
//!     `<state_dir>/codex-config-roots.json`; both sides are tilde-expanded and
//!     lexically resolved, then compared on exact UTF-16 code units (no case
//!     folding on Windows, `root + sep` prefix for children).
//!   * a persisted root that is a truthy non-string throws in `resolveRoot`
//!     (`p.startsWith is not a function`) -> 500; falsy roots are skipped and
//!     Node's `.some` short-circuits, so a match before a malformed element
//!     still answers 200. An unreadable, non-array or empty roots file falls
//!     back to the picker-roots default `["~"]`.
//!   * denied -> both scopes `{path, exists:false, content:'', mtime:0}` with
//!     the derived paths, so no file content leaks.
//!   * allowed -> `{project:{path, ...read}, user:{path, ...read}}`: `project`
//!     first, then the read payload's own `exists`, `content`, `mtime` order;
//!     a read failure throws in the bridge -> 500 with its message.
//!
//! Parity limits, reported rather than approximated:
//!   * the 500 envelopes keep the measured V8/Fastify text verbatim; another
//!     Node version may word a type error differently.
//!   * like the other native routes, JSON responses use `application/json`
//!     without Fastify's `; charset=utf-8` (shared `http_body` gap).
use crate::config_editor_auth::is_known;
use crate::config_editor_paths::join_config;
use crate::http_policy::query_values;
use crate::transcripts::TranscriptRawText;
use axum::extract::{RawQuery, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde_json::json;
use serde_json::value::RawValue;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

const ROOTS_FILE: &str = "codex-config-roots.json";
const CODEX_DIR: &str = ".codex";
const CONFIG_FILE: &str = "config.toml";
const CWD_REQUIRED: &str = "cwd required";
// Fastify's envelope text for the `path.join(cwd, ...)` TypeError (an array cwd).
const ARRAY_CWD_CODE: &str = "ERR_INVALID_ARG_TYPE";
const ARRAY_CWD_MESSAGE: &str =
    "The \"path\" argument must be of type string. Received an instance of Array";
// `resolveRoot` on a truthy non-string persisted root.
const ROOT_TYPE_MESSAGE: &str = "p.startsWith is not a function";

#[derive(Clone)]
struct CodexConfig {
    // `CODEX_HOME` as the host resolved it; joined, never expanded.
    codex_home: String,
    state_dir: PathBuf,
    home: PathBuf,
    process_cwd: PathBuf,
    // Windows only: Node's hidden per-drive cwd values (`=C:`), used by
    // `path.resolve` for drive-relative targets and roots.
    drive_cwds: Vec<(u16, PathBuf)>,
    // Shared with the other routes so root reads and writes cannot interleave.
    lock: Arc<Mutex<()>>,
}

// VERIFY: codex-config-read-router-injection
pub fn router(
    home: PathBuf,
    codex_home: PathBuf,
    state_dir: PathBuf,
    lock: Arc<Mutex<()>>,
    process_cwd: PathBuf,
    drive_cwds: Vec<(u16, PathBuf)>,
) -> Router {
    Router::new()
        .route("/api/codex-config", get(get_codex_config))
        .with_state(CodexConfig {
            codex_home: codex_home.to_string_lossy().into_owned(),
            state_dir,
            home,
            process_cwd,
            drive_cwds,
            lock,
        })
}

async fn get_codex_config(State(state): State<CodexConfig>, RawQuery(query): RawQuery) -> Response {
    // `if (!cwd)`: one empty string and an absent param are both falsy, while
    // Fastify's array for a repeated param is truthy and throws inside `join`.
    let values = query_values(query.as_deref().unwrap_or(""), "cwd");
    let cwd = match values.as_slice() {
        [] => return cwd_required(),
        [value] => value,
        _ => return array_cwd_error(),
    };
    if cwd.is_empty() {
        return cwd_required();
    }
    let cwd = cwd.clone();
    tokio::task::spawn_blocking(move || read(&state, &cwd))
        .await
        .unwrap_or_else(|_| internal_error())
}

// VERIFY: codex-config-read-scope-paths
fn read(state: &CodexConfig, cwd: &str) -> Response {
    let windows = cfg!(windows);
    // `scopePaths(cwd)` runs before authorization, so a denied request still
    // reports the server-derived paths. The empty middle part is how
    // `scopePaths`' two-argument `join(CODEX_HOME, 'config.toml')` maps onto the
    // shared three-part helper, which skips empty parts exactly like `path.join`.
    let project = join_config(cwd, CODEX_DIR, CONFIG_FILE, windows);
    let user = join_config(&state.codex_home, "", CONFIG_FILE, windows);
    let roots_json = {
        let _guard = state.lock.lock().unwrap_or_else(|error| error.into_inner());
        crate::picker_roots::get_roots(&state.state_dir.join(ROOTS_FILE))
    };
    match authorized(state, cwd, &roots_json) {
        Ok(true) => allowed(&project, &user),
        Ok(false) => denied(&project, &user),
        Err(response) => response,
    }
}

/// `isKnownConfigRoot(cwd)`'s `.some` over the persisted roots, in order.
///
/// `resolveRoot` maps a falsy element to `null` (no match) and throws on any
/// other non-string; the throw is only reached if no earlier root matched,
/// because `.some` stops at the first `true`.
fn authorized(state: &CodexConfig, cwd: &str, roots_json: &str) -> Result<bool, Response> {
    let tokens: Vec<Box<RawValue>> =
        serde_json::from_str(roots_json).map_err(|_| internal_error())?;
    let cwd_units: Vec<u16> = cwd.encode_utf16().collect();
    let mut roots = Vec::new();
    for token in &tokens {
        match classify(token.get()) {
            Root::Falsy => {}
            Root::Throws => return Err(root_type_error()),
            Root::Path(units) => {
                roots.push(units);
                // Checking after each element keeps `.some`'s short-circuit.
                if is_known(
                    &cwd_units,
                    &roots,
                    &state.home,
                    &state.process_cwd,
                    &state.drive_cwds,
                ) {
                    return Ok(true);
                }
            }
        }
    }
    Ok(false)
}

/// The three outcomes of `resolveRoot(raw)` for one persisted root element.
enum Root {
    /// Falsy (`null`, `false`, a zero number, `""`): `resolveRoot` returns null.
    Falsy,
    /// A JS string: tilde-expanded and resolved, then compared to the cwd.
    Path(Vec<u16>),
    /// Any other truthy value: `raw.startsWith` is not a function.
    Throws,
}

fn classify(token: &str) -> Root {
    if token.starts_with('"') {
        return match TranscriptRawText::from_json_token(token.to_owned())
            .and_then(|text| text.units())
        {
            Ok(units) if units.is_empty() => Root::Falsy,
            Ok(units) => Root::Path(units),
            // `picker_roots::get_roots` hands back a validated array, so a string
            // element always decodes here; anything else cannot have matched.
            Err(_) => Root::Falsy,
        };
    }
    match token {
        "null" | "false" => Root::Falsy,
        // Objects, arrays and `true` are truthy; JSON cannot spell NaN.
        "true" => Root::Throws,
        _ => match token.parse::<f64>() {
            Ok(value) if value == 0.0 => Root::Falsy,
            _ => Root::Throws,
        },
    }
}

#[derive(serde::Serialize)]
struct Reply<'a> {
    project: Scope<'a>,
    user: Scope<'a>,
}

#[derive(serde::Serialize)]
struct Scope<'a> {
    path: &'a str,
    exists: bool,
    content: &'a str,
    mtime: &'a RawValue,
}

impl<'a> Scope<'a> {
    fn read(path: &'a str, file: &'a FileState) -> Self {
        Self {
            path,
            exists: file.exists,
            content: &file.content,
            mtime: &file.mtime,
        }
    }

    fn denied(path: &'a str, zero: &'a RawValue) -> Self {
        Self {
            path,
            exists: false,
            content: "",
            mtime: zero,
        }
    }
}

struct FileState {
    exists: bool,
    content: String,
    // `mtime` stays a JSON number; only its text follows ECMAScript rules,
    // because Node's bridge parses and re-stringifies the payload.
    mtime: Box<RawValue>,
}

fn denied(project: &str, user: &str) -> Response {
    let zero = RawValue::from_string("0".to_owned()).expect("literal raw number");
    Json(Reply {
        project: Scope::denied(project, &zero),
        user: Scope::denied(user, &zero),
    })
    .into_response()
}

fn allowed(project_path: &str, user_path: &str) -> Response {
    let project = match read_file(project_path) {
        Ok(file) => file,
        Err(error) => return read_failure(&error),
    };
    let user = match read_file(user_path) {
        Ok(file) => file,
        Err(error) => return read_failure(&error),
    };
    Json(Reply {
        project: Scope::read(project_path, &project),
        user: Scope::read(user_path, &user),
    })
    .into_response()
}

/// `backend.codexConfigRead(path)` over `config_read::read`: the bridge throws
/// on the payload's `error`, which Fastify answers as a 500 with that message.
fn read_file(path: &str) -> Result<FileState, String> {
    let raw = crate::config_read::read(path);
    let payload: ReadPayload =
        serde_json::from_str(raw.get()).map_err(|error| error.to_string())?;
    if let Some(error) = payload.error {
        return Err(error);
    }
    let mtime =
        RawValue::from_string(js_number(payload.mtime)).map_err(|error| error.to_string())?;
    Ok(FileState {
        exists: payload.exists,
        content: payload.content,
        mtime,
    })
}

#[derive(serde::Deserialize)]
struct ReadPayload {
    exists: bool,
    content: String,
    mtime: f64,
    #[serde(default)]
    error: Option<String>,
}

// VERIFY: codex-config-read-js-mtime
/// Node turns the payload's `mtime` into a JS number and `JSON.stringify`s it
/// again, so `1729000000000.0` leaves as `1729000000000`.
fn js_number(value: f64) -> String {
    let mut buffer = ryu_js::Buffer::new();
    buffer.format_finite(value).to_owned()
}

fn cwd_required() -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({ "error": CWD_REQUIRED })),
    )
        .into_response()
}

// Fastify's default error envelope for the thrown `path.join` TypeError.
fn array_cwd_error() -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({
            "statusCode": 500,
            "code": ARRAY_CWD_CODE,
            "error": "Internal Server Error",
            "message": ARRAY_CWD_MESSAGE,
        })),
    )
        .into_response()
}

// Fastify's default error envelope for the thrown `p.startsWith` TypeError.
fn root_type_error() -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({
            "statusCode": 500,
            "error": "Internal Server Error",
            "message": ROOT_TYPE_MESSAGE,
        })),
    )
        .into_response()
}

// The bridge's `new Error(result.error)`: no code, message verbatim.
fn read_failure(message: &str) -> Response {
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
    use super::{
        CODEX_DIR, CONFIG_FILE, CodexConfig, ROOTS_FILE, authorized, get_codex_config, js_number,
        router,
    };
    use axum::body::to_bytes;
    use axum::extract::{RawQuery, State};
    use axum::response::Response;
    use serde_json::Value;
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
            let path = std::env::temp_dir().join(format!(
                "http-codex-config-read-{}-{unique}-{id}",
                std::process::id()
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        fn home(&self) -> PathBuf {
            self.0.join("home")
        }

        fn codex_home(&self) -> PathBuf {
            self.home().join(".codex")
        }

        fn state_dir(&self) -> PathBuf {
            self.0.join("state")
        }

        fn root(&self) -> PathBuf {
            self.0.join("roots").join("one")
        }

        fn project_path(&self) -> PathBuf {
            self.root().join(CODEX_DIR).join(CONFIG_FILE)
        }

        fn user_path(&self) -> PathBuf {
            self.codex_home().join(CONFIG_FILE)
        }

        fn process_cwd(&self) -> PathBuf {
            self.0.join("work")
        }

        fn state(&self) -> CodexConfig {
            CodexConfig {
                codex_home: self.codex_home().to_string_lossy().into_owned(),
                state_dir: self.state_dir(),
                home: self.home(),
                process_cwd: self.process_cwd(),
                drive_cwds: Vec::new(),
                lock: Arc::new(Mutex::new(())),
            }
        }

        fn write_roots(&self, text: &str) {
            fs::create_dir_all(self.state_dir()).unwrap();
            fs::write(self.state_dir().join(ROOTS_FILE), text).unwrap();
        }

        fn store_roots(&self, roots: &[&str]) {
            self.write_roots(&serde_json::to_string(roots).unwrap());
        }

        fn write_file(&self, path: &Path, text: &str) {
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, text).unwrap();
        }

        fn write_project(&self, text: &str) {
            self.write_file(&self.project_path(), text);
        }

        fn write_user(&self, text: &str) {
            self.write_file(&self.user_path(), text);
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

    fn cwd_query(cwd: &str) -> Option<String> {
        Some(format!("cwd={}", encode(cwd)))
    }

    async fn collect(response: Response) -> (u16, String) {
        let status = response.status().as_u16();
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        (status, String::from_utf8(bytes.to_vec()).unwrap())
    }

    async fn send(state: &CodexConfig, query: Option<String>) -> (u16, String) {
        collect(get_codex_config(State(state.clone()), RawQuery(query)).await).await
    }

    fn path_json(path: &Path) -> String {
        serde_json::to_string(&text(path)).unwrap()
    }

    /// The "no content" body is exact, which also pins the key order: `project`
    /// then `user`, each `path`, `exists`, `content`, `mtime`.
    fn empty_scopes_body(project: &Path, user: &Path) -> String {
        format!(
            r#"{{"project":{{"path":{},"exists":false,"content":"","mtime":0}},"user":{{"path":{},"exists":false,"content":"","mtime":0}}}}"#,
            path_json(project),
            path_json(user),
        )
    }

    fn project_object(payload: &Value) -> &Value {
        &payload["project"]
    }

    /// `path` before `exists` before `content` before `mtime`, and `project`
    /// before `user`, as the Node object literal and spread produce.
    fn assert_key_order(body: &str) {
        let at = |needle: &str| {
            body.find(needle)
                .unwrap_or_else(|| panic!("{needle} in {body}"))
        };
        let keys = [
            "\"project\"",
            "\"path\"",
            "\"exists\"",
            "\"content\"",
            "\"mtime\"",
        ];
        for pair in keys.windows(2) {
            assert!(
                at(pair[0]) < at(pair[1]),
                "{} before {}: {body}",
                pair[0],
                pair[1]
            );
        }
        assert!(
            body.find("\"user\"").unwrap() < body.rfind("\"mtime\"").unwrap(),
            "{body}"
        );
    }

    // VERIFY: codex-config-read-denied
    #[test]
    fn denied_cwd_reports_paths_without_reading_files() {
        let fixture = Fixture::new();
        fixture.store_roots(&[&text(&fixture.root())]);
        fixture.write_project("model = \"x\"\n");
        fixture.write_user("model = \"y\"\n");
        let outside = text(&fixture.0.join("elsewhere"));
        run(async {
            let (status, body) = send(&fixture.state(), cwd_query(&outside)).await;
            assert_eq!(status, 200);
            // The paths follow the requested cwd even when it is denied.
            let project = Path::new(&outside).join(CODEX_DIR).join(CONFIG_FILE);
            assert_eq!(body, empty_scopes_body(&project, &fixture.user_path()));
        });
    }

    // VERIFY: codex-config-read-allowed
    #[test]
    fn allowed_cwd_reads_both_scopes_with_path_first_key_order() {
        let fixture = Fixture::new();
        fixture.store_roots(&[&text(&fixture.root())]);
        fixture.write_project("model = \"x\"\n");
        fixture.write_user("model = \"y\"\n");
        let cwd = text(&fixture.root());
        run(async {
            let (status, body) = send(&fixture.state(), cwd_query(&cwd)).await;
            assert_eq!(status, 200, "{body}");
            assert_key_order(&body);
            let payload: Value = serde_json::from_str(&body).unwrap();
            let project = project_object(&payload);
            assert_eq!(
                project["path"],
                Value::String(text(&fixture.project_path()))
            );
            assert_eq!(project["exists"], Value::Bool(true));
            assert_eq!(
                project["content"],
                Value::String("model = \"x\"\n".to_owned())
            );
            assert!(project["mtime"].as_f64().is_some_and(|mtime| mtime > 0.0));
            let user = &payload["user"];
            assert_eq!(user["path"], Value::String(text(&fixture.user_path())));
            assert_eq!(user["content"], Value::String("model = \"y\"\n".to_owned()));
            assert!(payload["project"].get("error").is_none());
        });
    }

    #[test]
    fn allowed_missing_files_are_empty_scopes_with_integer_zero_mtime() {
        let fixture = Fixture::new();
        fixture.store_roots(&[&text(&fixture.root())]);
        let cwd = text(&fixture.root());
        run(async {
            let (status, body) = send(&fixture.state(), cwd_query(&cwd)).await;
            assert_eq!(status, 200);
            assert!(
                body.contains(r#""exists":false,"content":"","mtime":0}"#),
                "mtime must serialize as the JS number 0: {body}"
            );
            let payload: Value = serde_json::from_str(&body).unwrap();
            assert_eq!(
                payload["project"]["path"],
                Value::String(text(&fixture.project_path()))
            );
            assert_eq!(
                payload["user"]["path"],
                Value::String(text(&fixture.user_path()))
            );
        });
    }

    // VERIFY: codex-config-read-root-containment
    #[test]
    fn nested_cwd_matches_but_siblings_and_case_changes_do_not() {
        let fixture = Fixture::new();
        fixture.store_roots(&[&text(&fixture.root())]);
        let nested = fixture.root().join("work").join("deep");
        fixture.write_file(&nested.join(CODEX_DIR).join(CONFIG_FILE), "nested = true\n");
        let sibling = text(&fixture.0.join("roots").join("one-extra"));
        run(async {
            let (status, body) = send(&fixture.state(), cwd_query(&text(&nested))).await;
            assert_eq!(status, 200);
            let payload: Value = serde_json::from_str(&body).unwrap();
            assert_eq!(payload["project"]["exists"], Value::Bool(true));
            assert_eq!(
                payload["project"]["content"],
                Value::String("nested = true\n".to_owned())
            );

            let (status, body) = send(&fixture.state(), cwd_query(&sibling)).await;
            assert_eq!(status, 200);
            let sibling_project = Path::new(&sibling).join(CODEX_DIR).join(CONFIG_FILE);
            assert_eq!(
                body,
                empty_scopes_body(&sibling_project, &fixture.user_path())
            );

            // Node compares resolved strings exactly: on Windows a case-only
            // difference is a different string and the cwd stays unauthorized.
            if cfg!(windows) {
                let folded = text(&fixture.root()).to_uppercase();
                assert_ne!(folded, text(&fixture.root()));
                let (status, body) = send(&fixture.state(), cwd_query(&folded)).await;
                assert_eq!(status, 200);
                assert!(
                    body.contains(r#""exists":false,"content":"""#),
                    "case-different cwd must be denied: {body}"
                );
            }
        });
    }

    // VERIFY: codex-config-read-tilde
    #[test]
    fn tilde_root_expands_home_and_tilde_cwd_stays_literal_in_the_path() {
        let fixture = Fixture::new();
        fixture.store_roots(&["~"]);
        // cwd is home itself, so the project file is home/.codex/config.toml —
        // the same file as the user scope, exactly as Node's `scopePaths` says.
        fixture.write_file(
            &fixture.home().join(CODEX_DIR).join(CONFIG_FILE),
            "model = \"x\"\n",
        );
        let home = text(&fixture.home());
        run(async {
            let (status, body) = send(&fixture.state(), cwd_query(&home)).await;
            assert_eq!(status, 200);
            let payload: Value = serde_json::from_str(&body).unwrap();
            assert_eq!(payload["project"]["exists"], Value::Bool(true));
            assert_eq!(
                payload["project"]["content"],
                Value::String("model = \"x\"\n".to_owned())
            );

            // Outside the home root stays denied.
            let outside = text(&fixture.0.join("elsewhere"));
            let (status, body) = send(&fixture.state(), cwd_query(&outside)).await;
            assert_eq!(status, 200);
            assert!(body.contains(r#""exists":false,"content":"""#), "{body}");
        });

        // A `~` cwd is expanded for authorization but joined literally.
        let state = fixture.state();
        let home_roots = serde_json::to_string(&[text(&fixture.home())]).unwrap();
        assert_eq!(
            authorized(&state, "~", &home_roots).map_err(|_| ()),
            Ok(true)
        );
        assert_eq!(
            authorized(&state, "~/work", &home_roots).map_err(|_| ()),
            Ok(true)
        );
        assert_eq!(
            authorized(&state, "~other", &home_roots).map_err(|_| ()),
            Ok(false)
        );
        let literal = text(&Path::new("~").join(CODEX_DIR).join(CONFIG_FILE));
        run(async {
            let (status, body) = send(&fixture.state(), cwd_query("~")).await;
            assert_eq!(status, 200);
            let payload: Value = serde_json::from_str(&body).unwrap();
            assert_eq!(payload["project"]["path"], Value::String(literal));
        });
    }

    // VERIFY: codex-config-read-roots-fallback
    #[test]
    fn unreadable_or_empty_roots_file_falls_back_to_the_tilde_default() {
        let fixture = Fixture::new();
        fixture.write_project("model = \"x\"\n");
        let cwd = text(&fixture.root());
        for contents in ["{", "[]", "null", r#"{"roots":["x"]}"#, "\u{feff}[\"x\"]"] {
            // A defaulted `["~"]` cannot authorize the project root, but it does
            // authorize the home cwd, which is what makes the fallback visible.
            fixture.write_roots(contents);
            fixture.write_file(
                &fixture.home().join(CODEX_DIR).join(CONFIG_FILE),
                "home = true\n",
            );
            run(async {
                let (status, body) =
                    send(&fixture.state(), cwd_query(&text(&fixture.home()))).await;
                assert_eq!(status, 200, "{contents}");
                assert!(
                    body.contains(r#""project":{"path"#) && body.contains(r#""exists":true"#),
                    "{contents}: {body}"
                );
                let (status, body) = send(&fixture.state(), cwd_query(&cwd)).await;
                assert_eq!(status, 200, "{contents}");
                assert!(
                    body.contains(r#""exists":false,"content":"""#),
                    "{contents}: {body}"
                );
            });
        }
    }

    // VERIFY: codex-config-read-root-types
    #[test]
    fn malformed_root_elements_throw_only_when_node_reaches_them() {
        let fixture = Fixture::new();
        let state = fixture.state();
        let root = serde_json::to_string(&text(&fixture.root())).unwrap();
        let root_text = text(&fixture.root());
        let authorized_with = |roots: &str| authorized(&state, &root_text, roots).map_err(|_| ());

        for roots in [
            r#"[null,false,0]"#.to_owned(),
            r#"[null,false,0,""]"#.to_owned(),
            r#"[0,-0,0.0,0e5]"#.to_owned(),
            r#"[]"#.to_owned(),
            r#"[""]"#.to_owned(),
            r#"[0e999]"#.to_owned(),
        ] {
            assert_eq!(authorized_with(&roots), Ok(false), "{roots}");
        }
        // Truthy non-strings throw `p.startsWith is not a function`.
        for roots in [
            "[5]".to_owned(),
            "[1]".to_owned(),
            "[true]".to_owned(),
            "[{}]".to_owned(),
            "[[]]".to_owned(),
            "[1e999]".to_owned(),
            format!("[5,{root}]"),
        ] {
            assert_eq!(authorized_with(&roots), Err(()), "{roots}");
            fixture.write_roots(&roots);
            run(async {
                let (status, body) = send(&fixture.state(), cwd_query(&root_text)).await;
                assert_eq!(status, 500, "{roots}");
                assert_eq!(
                    body,
                    r#"{"statusCode":500,"error":"Internal Server Error","message":"p.startsWith is not a function"}"#,
                    "{roots}"
                );
            });
        }
        // `.some` short-circuits: a match before the malformed element wins.
        for roots in [
            format!("[{root},5]"),
            format!(r#"["",{root},{{}}]"#),
            format!(r#"[null,{root},true]"#),
        ] {
            assert_eq!(authorized_with(&roots), Ok(true), "{roots}");
            fixture.write_roots(&roots);
            run(async {
                let (status, _) = send(&fixture.state(), cwd_query(&root_text)).await;
                assert_eq!(status, 200, "{roots}");
            });
        }
    }

    // VERIFY: codex-config-read-cwd-query
    #[test]
    fn absent_empty_and_repeated_cwd_follow_node() {
        let fixture = Fixture::new();
        fixture.store_roots(&[&text(&fixture.root())]);
        run(async {
            for query in [
                None,
                Some("cwd=".to_owned()),
                Some("cwd".to_owned()),
                Some("other=x".to_owned()),
            ] {
                let (status, body) = send(&fixture.state(), query.clone()).await;
                assert_eq!(status, 400, "{query:?}");
                assert_eq!(body, r#"{"error":"cwd required"}"#, "{query:?}");
            }
            for query in [
                "cwd=a&cwd=b".to_owned(),
                "cwd=&cwd=".to_owned(),
                "cwd=x&cwd=".to_owned(),
            ] {
                let (status, body) = send(&fixture.state(), Some(query.clone())).await;
                assert_eq!(status, 500, "{query}");
                assert_eq!(
                    body,
                    r#"{"statusCode":500,"code":"ERR_INVALID_ARG_TYPE","error":"Internal Server Error","message":"The \"path\" argument must be of type string. Received an instance of Array"}"#,
                    "{query}"
                );
            }
        });
    }

    // VERIFY: codex-config-read-failure
    #[test]
    fn unreadable_scope_is_a_500_with_the_bridge_message() {
        let fixture = Fixture::new();
        fixture.store_roots(&[&text(&fixture.root())]);
        let cwd = text(&fixture.root());
        // A directory where the project file should be: `read` fails, so the
        // bridge throws before either scope is returned.
        fs::create_dir_all(fixture.project_path()).unwrap();
        run(async {
            let (status, body) = send(&fixture.state(), cwd_query(&cwd)).await;
            assert_eq!(status, 500, "{body}");
            let payload: Value = serde_json::from_str(&body).unwrap();
            assert_eq!(payload["statusCode"], Value::from(500));
            assert_eq!(
                payload["error"],
                Value::String("Internal Server Error".to_owned())
            );
            assert!(
                payload["message"]
                    .as_str()
                    .is_some_and(|message| !message.is_empty()),
                "{body}"
            );
            assert!(payload.get("code").is_none(), "{body}");
        });

        // The user scope is read second and fails the same way.
        let fixture = Fixture::new();
        fixture.store_roots(&[&text(&fixture.root())]);
        fixture.write_project("model = \"x\"\n");
        fs::create_dir_all(fixture.user_path()).unwrap();
        let cwd = text(&fixture.root());
        run(async {
            let (status, _) = send(&fixture.state(), cwd_query(&cwd)).await;
            assert_eq!(status, 500);
        });
    }

    #[test]
    fn js_number_matches_javascript_number_text() {
        assert_eq!(js_number(0.0), "0");
        assert_eq!(js_number(1729000000000.0), "1729000000000");
        assert_eq!(js_number(1729000000000.123), "1729000000000.123");
    }

    #[test]
    fn router_builds_with_injected_paths() {
        let fixture = Fixture::new();
        let _router = router(
            fixture.home(),
            fixture.codex_home(),
            fixture.state_dir(),
            Arc::new(Mutex::new(())),
            fixture.process_cwd(),
            Vec::new(),
        );
    }
}
