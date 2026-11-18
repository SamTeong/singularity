//! Claude config editor read surface: `GET /api/config`, mirroring
//! `server/index.mjs:583-587` -> `config.mjs:scopePaths` + `readConfig` and the
//! `configRead` bridge in `server/rust-backend.mjs`.
//!
//! Contract: a missing or empty `cwd` is `400 {"error":"cwd required"}`. A
//! repeated `cwd` arrives from Fastify as an array, so `scopePaths`'s
//! `c.startsWith` throws and Node answers with Fastify's 500 body; that case is
//! reproduced with the measured TypeError message. Otherwise the two editable
//! scopes are `join(cwd, '.claude', 'settings.json')` and
//! `join(cwd, '.claude', 'settings.local.json')` (project, local), read through
//! `config_read::read`, and answered as
//! `{"project":{path,exists,content,mtime},"local":{...}}` in that key order —
//! `path` first inside each scope, because `readConfig` re-builds the object
//! around the bridge's fields.
//!
//! Reads are unrestricted: only writes check the pinned config roots.
//!
//! Parity notes:
//!   * `scopePaths` expands a leading `~`, `~/` or `~\` as
//!     `normalize(homedir() + cwd.slice(1))`. The extra `normalize` pass is
//!     folded into `join_config`, which normalizes the joined string; measured
//!     identical on both win32 and posix for every absolute home path, differing
//!     only for an empty or drive-relative (`C:`) home, which `os.homedir()`
//!     never returns.
//!   * `mtime` is a JS number: `readConfig` re-serializes the bridge's value, so
//!     a missing file leaves as `0`, never `0.0`. Text follows ECMAScript number
//!     rules (`ryu_js`).
//!   * A `config_read` error makes the bridge throw, so it becomes Fastify's 500
//!     with the native error text as `message`.
//!   * The injected home is used as a string path, as Node does; a non-UTF-8
//!     home component is lossily converted.
use crate::config_editor_paths::join_config;
use crate::http_policy::query_values;
use axum::extract::{RawQuery, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde_json::json;
use serde_json::value::RawValue;
use std::path::PathBuf;

// Fastify's message for the TypeError thrown by `c.startsWith('~/')` when the
// query parser has turned a repeated `cwd` into an array.
const STARTS_WITH_ERROR: &str = "c.startsWith is not a function";

#[derive(Clone)]
struct ClaudeConfig {
    home: String,
}

#[derive(serde::Serialize)]
struct ConfigReply<'a> {
    project: &'a Scope,
    local: &'a Scope,
}

#[derive(serde::Serialize)]
struct Scope {
    path: String,
    exists: bool,
    content: String,
    // `readConfig` re-serializes the bridge's number, so its text follows
    // ECMAScript rules while it stays a JSON number.
    mtime: Box<RawValue>,
}

#[derive(serde::Deserialize)]
struct ReadPayload {
    exists: bool,
    content: String,
    mtime: f64,
    #[serde(default)]
    error: Option<String>,
}

pub fn router(home: PathBuf) -> Router {
    Router::new()
        .route("/api/config", get(get_config))
        .with_state(ClaudeConfig {
            home: home.to_string_lossy().into_owned(),
        })
}

async fn get_config(State(state): State<ClaudeConfig>, RawQuery(query): RawQuery) -> Response {
    let cwd = match cwd_value(query.as_deref()) {
        Cwd::Value(cwd) => cwd,
        Cwd::Missing => return bad_request(),
        Cwd::Repeated => return fastify_internal(STARTS_WITH_ERROR),
    };
    let project = scope_path(&state.home, &cwd, "settings.json");
    let local = scope_path(&state.home, &cwd, "settings.local.json");
    let result = tokio::task::spawn_blocking(move || {
        // Node reads project first; a failure there never reaches the local scope.
        let project = read_scope(project)?;
        let local = read_scope(local)?;
        Ok::<_, String>((project, local))
    })
    .await;
    match result {
        Ok(Ok((project, local))) => Json(ConfigReply {
            project: &project,
            local: &local,
        })
        .into_response(),
        Ok(Err(message)) => fastify_internal(&message),
        Err(_) => internal_error(),
    }
}

enum Cwd {
    Missing,
    Repeated,
    Value(String),
}

// VERIFY: claude-config-cwd-query
/// `req.query.cwd`: absent or falsy -> 400; repeated (a Fastify array) -> 500.
fn cwd_value(query: Option<&str>) -> Cwd {
    match query_values(query.unwrap_or_default(), "cwd").as_slice() {
        [] => Cwd::Missing,
        [value] if value.is_empty() => Cwd::Missing,
        [value] => Cwd::Value(value.clone()),
        _ => Cwd::Repeated,
    }
}

// VERIFY: claude-config-scope-paths
/// `config.mjs:scopePaths(cwd)[scope]`: the `~` root is expanded before joining.
fn scope_path(home: &str, cwd: &str, filename: &str) -> String {
    let windows = cfg!(windows);
    let cwd = match cwd.strip_prefix('~') {
        Some("") => join_config(home, "", "", windows),
        Some(rest) if rest.starts_with('/') || rest.starts_with('\\') => {
            join_config(home, rest, "", windows)
        }
        _ => cwd.to_owned(),
    };
    join_config(&cwd, ".claude", filename, windows)
}

// VERIFY: claude-config-scope-read
/// The bridge's `configRead`: a payload error is thrown, not returned.
fn read_scope(path: String) -> Result<Scope, String> {
    let raw = crate::config_read::read(&path);
    let payload: ReadPayload =
        serde_json::from_str(raw.get()).map_err(|error| error.to_string())?;
    if let Some(error) = payload.error {
        return Err(error);
    }
    let mtime = RawValue::from_string(
        ryu_js::Buffer::new()
            .format_finite(payload.mtime)
            .to_owned(),
    )
    .expect("ECMAScript number text is valid JSON");
    Ok(Scope {
        path,
        exists: payload.exists,
        content: payload.content,
        mtime,
    })
}

fn bad_request() -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({ "error": "cwd required" })),
    )
        .into_response()
}

/// Fastify's default error handler body for a thrown handler error.
fn fastify_internal(message: &str) -> Response {
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
    use super::{ClaudeConfig, Cwd, cwd_value, get_config, router, scope_path};
    use axum::body::to_bytes;
    use axum::extract::{RawQuery, State};
    use serde_json::Value;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct Fixture {
        root: PathBuf,
    }

    impl Fixture {
        fn new(label: &str) -> Self {
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let root = std::env::temp_dir().join(format!(
                "http-claude-config-read-{label}-{}-{nanos}",
                std::process::id()
            ));
            fs::create_dir_all(&root).unwrap();
            Self { root }
        }

        fn home(&self) -> PathBuf {
            self.root.join("home")
        }

        fn home_text(&self) -> String {
            self.home().to_string_lossy().into_owned()
        }

        fn cwd(&self) -> PathBuf {
            self.root.join("project")
        }

        fn cwd_text(&self) -> String {
            self.cwd().to_string_lossy().into_owned()
        }

        fn state(&self) -> ClaudeConfig {
            ClaudeConfig {
                home: self.home_text(),
            }
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn run<F: std::future::Future>(future: F) -> F::Output {
        tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(future)
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

    /// The expected scope path for a cwd the tests spell component by component,
    /// so `..`-free paths match Node's `path.join` on the running platform.
    fn joined(parts: &[&str]) -> String {
        parts
            .iter()
            .fold(PathBuf::new(), |path, part| path.join(part))
            .to_string_lossy()
            .into_owned()
    }

    fn quoted(value: &str) -> String {
        serde_json::to_string(value).unwrap()
    }

    async fn send(state: &ClaudeConfig, query: Option<&str>) -> (u16, String) {
        let response = get_config(State(state.clone()), RawQuery(query.map(str::to_owned))).await;
        let status = response.status().as_u16();
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        (status, String::from_utf8(bytes.to_vec()).unwrap())
    }

    fn body_value(body: &str) -> Value {
        serde_json::from_str(body).unwrap()
    }

    // VERIFY: claude-config-cwd-required
    #[test]
    fn missing_or_empty_cwd_is_rejected() {
        let fixture = Fixture::new("cwd-required");
        run(async {
            for query in [
                None,
                Some(""),
                Some("cwd="),
                Some("cwd"),
                Some("other=x"),
                Some("cwd=&other=x"),
            ] {
                let (status, body) = send(&fixture.state(), query).await;
                assert_eq!(status, 400, "{query:?}");
                assert_eq!(body, r#"{"error":"cwd required"}"#, "{query:?}");
            }
        });
    }

    // VERIFY: claude-config-repeated-cwd
    #[test]
    fn repeated_cwd_reproduces_the_fastify_type_error() {
        let fixture = Fixture::new("cwd-repeated");
        let encoded = encode(&fixture.cwd_text());
        run(async {
            for query in [
                "cwd=a&cwd=b".to_owned(),
                "cwd=&cwd=".to_owned(),
                "cwd=%7E&cwd=%7E".to_owned(),
                format!("cwd={encoded}&cwd={encoded}"),
                // One empty and one real value is still a Fastify array.
                format!("cwd=&cwd={encoded}"),
            ] {
                let (status, body) = send(&fixture.state(), Some(&query)).await;
                assert_eq!(status, 500, "{query}");
                assert_eq!(
                    body,
                    r#"{"statusCode":500,"error":"Internal Server Error","message":"c.startsWith is not a function"}"#,
                    "{query}"
                );
            }
        });
    }

    // VERIFY: claude-config-tilde-and-relative
    #[test]
    fn tilde_and_relative_cwds_resolve_to_the_scope_files() {
        let fixture = Fixture::new("scope-paths");
        let home = fixture.home_text();
        let cwd = fixture.cwd_text();
        // `normalize(home + '\\work')`: win32 collapses the doubled separator,
        // posix keeps the backslash inside one component (`PathBuf::join` would
        // treat `\\work` as root-relative on Windows, so spell it per platform).
        let backslash_work = if cfg!(windows) {
            joined(&[home.as_str(), "work"])
        } else {
            joined(&[home.as_str(), "\\work"])
        };
        let mut cases = vec![
            ("~".to_owned(), home.clone()),
            ("~/work".to_owned(), joined(&[home.as_str(), "work"])),
            ("~\\work".to_owned(), backslash_work),
            ("~x".to_owned(), "~x".to_owned()),
            ("work".to_owned(), "work".to_owned()),
            (cwd.clone(), cwd.clone()),
        ];
        if cfg!(windows) {
            // The expansion's trailing separator is dropped by the scope join.
            cases.push(("~/work/".to_owned(), joined(&[home.as_str(), "work"])));
        }
        run(async {
            for (cwd, base) in cases {
                let project = joined(&[base.as_str(), ".claude", "settings.json"]);
                let local = joined(&[base.as_str(), ".claude", "settings.local.json"]);
                let query = format!("cwd={}", encode(&cwd));
                let (status, body) = send(&fixture.state(), Some(&query)).await;
                assert_eq!(status, 200, "{cwd}");
                let value = body_value(&body);
                assert_eq!(value["project"]["path"], Value::String(project), "{cwd}");
                assert_eq!(value["local"]["path"], Value::String(local), "{cwd}");
            }
        });
    }

    // VERIFY: claude-config-missing-shape
    #[test]
    fn missing_scope_files_report_the_node_shape_and_key_order() {
        let fixture = Fixture::new("missing");
        let cwd = fixture.cwd_text();
        run(async {
            let query = format!("cwd={}", encode(&cwd));
            let (status, body) = send(&fixture.state(), Some(&query)).await;
            assert_eq!(status, 200);
            let project = joined(&[cwd.as_str(), ".claude", "settings.json"]);
            let local = joined(&[cwd.as_str(), ".claude", "settings.local.json"]);
            // `mtime` is `0`, not serde's `0.0`: Node re-serializes the JS number.
            assert_eq!(
                body,
                format!(
                    "{{\"project\":{{\"path\":{},\"exists\":false,\"content\":\"\",\"mtime\":0}},\
                     \"local\":{{\"path\":{},\"exists\":false,\"content\":\"\",\"mtime\":0}}}}",
                    quoted(&project),
                    quoted(&local)
                )
            );
        });
    }

    // VERIFY: claude-config-existing-and-invalid-utf8
    #[test]
    fn existing_scope_files_return_content_and_mtime() {
        let fixture = Fixture::new("existing");
        let cwd = fixture.cwd_text();
        let claude = fixture.cwd().join(".claude");
        fs::create_dir_all(&claude).unwrap();
        fs::write(claude.join("settings.json"), br#"{ "theme": "dark" }"#).unwrap();
        fs::write(claude.join("settings.local.json"), b"{\"v\":\xff}").unwrap();
        run(async {
            let query = format!("cwd={}", encode(&cwd));
            let (status, body) = send(&fixture.state(), Some(&query)).await;
            assert_eq!(status, 200);
            let payload = body_value(&body);
            assert_eq!(payload["project"]["exists"], true);
            assert_eq!(payload["project"]["content"], r#"{ "theme": "dark" }"#);
            assert!(payload["project"]["mtime"].as_f64().unwrap() > 0.0);
            assert_eq!(
                payload["project"]["path"],
                joined(&[cwd.as_str(), ".claude", "settings.json"])
            );
            // Invalid UTF-8 becomes U+FFFD, as `String::from_utf8_lossy` does.
            assert_eq!(payload["local"]["exists"], true);
            assert_eq!(payload["local"]["content"], "{\"v\":\u{fffd}}");
            assert!(payload["local"]["mtime"].as_f64().unwrap() > 0.0);
        });
    }

    // VERIFY: claude-config-read-error
    #[test]
    fn unreadable_scope_maps_to_the_fastify_error_body() {
        let fixture = Fixture::new("unreadable");
        let cwd = fixture.cwd_text();
        // A directory at the settings path passes `metadata` but not `read`.
        fs::create_dir_all(fixture.cwd().join(".claude").join("settings.json")).unwrap();
        run(async {
            let query = format!("cwd={}", encode(&cwd));
            let (status, body) = send(&fixture.state(), Some(&query)).await;
            assert_eq!(status, 500);
            let payload = body_value(&body);
            assert_eq!(payload["statusCode"], 500);
            assert_eq!(payload["error"], "Internal Server Error");
            // The bridge throws `new Error(result.error)`; Fastify relays its text.
            assert!(
                payload["message"]
                    .as_str()
                    .is_some_and(|message| !message.is_empty())
            );
        });
    }

    // VERIFY: claude-config-query-and-router-anchor
    #[test]
    fn query_parsing_and_router_state_match_the_route_contract() {
        assert!(matches!(cwd_value(None), Cwd::Missing));
        assert!(matches!(cwd_value(Some("cwd=")), Cwd::Missing));
        assert!(matches!(cwd_value(Some("other=1")), Cwd::Missing));
        assert!(matches!(cwd_value(Some("cwd=a&cwd=b")), Cwd::Repeated));
        assert!(matches!(cwd_value(Some("cwd=a")), Cwd::Value(value) if value == "a"));

        let fixture = Fixture::new("router");
        let _router = router(fixture.home());
        let home = fixture.home_text();
        assert_eq!(
            scope_path(&home, "~", "settings.json"),
            joined(&[home.as_str(), ".claude", "settings.json"])
        );
        assert_eq!(
            scope_path(&home, "relative", "settings.local.json"),
            joined(&["relative", ".claude", "settings.local.json"])
        );
    }
}
