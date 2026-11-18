// Plans (plan-session) HTTP surface. The configured root is injected by the
// host; this module never reads process env. SID validation and realpath
// containment are the security boundary that plans::get_session deliberately
// does not re-check, so they are enforced here before every detail read.
use crate::http_policy::query_values;
use crate::plans;
use axum::extract::{RawQuery, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use regex::Regex;
use serde_json::json;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

#[derive(Clone)]
struct Plans {
    root: Option<PathBuf>,
}

pub fn router(plans_root: Option<PathBuf>) -> Router {
    Router::new()
        .route("/api/plans/sessions", get(get_sessions))
        .route("/api/plans/session", get(get_session))
        .with_state(Plans { root: plans_root })
}

async fn get_sessions(State(plans_state): State<Plans>) -> Response {
    let root = plans_state
        .root
        .as_ref()
        .map(|path| path.to_string_lossy().into_owned());
    match tokio::task::spawn_blocking(move || plans::list_sessions(root.as_deref())).await {
        Ok(value) => Json(value).into_response(),
        Err(_) => backend_unavailable(),
    }
}

async fn get_session(State(plans_state): State<Plans>, RawQuery(query): RawQuery) -> Response {
    // Node checks the disabled root before it looks at sid at all.
    let Some(root) = plans_state.root else {
        return error_response("plans disabled");
    };
    let sid = match single_sid(query.as_deref()) {
        Some(sid) => sid,
        None => return error_response("bad sid"),
    };
    let outcome = tokio::task::spawn_blocking(move || {
        let dir = resolve_session_directory(&root, &sid)?;
        Ok(plans::get_session(&dir.to_string_lossy(), &sid))
    })
    .await;
    match outcome {
        Ok(Ok(value)) => Json(value).into_response(),
        Ok(Err(error)) => error_response(error),
        Err(_) => backend_unavailable(),
    }
}

// Fastify yields a string for one `sid` and an array for repeats; only a single
// form-decoded value is a string, so repeated or absent parameters are bad sids.
fn single_sid(query: Option<&str>) -> Option<String> {
    let query = query?;
    match query_values(query, "sid").as_slice() {
        [value] => Some(value.clone()),
        _ => None,
    }
}

fn resolve_session_directory(root: &Path, sid: &str) -> Result<PathBuf, &'static str> {
    if !sid_re().is_match(sid) {
        return Err("bad sid");
    }
    let root = fs::canonicalize(root).map_err(|_| "not found")?;
    let dir = fs::canonicalize(root.join(sid)).map_err(|_| "not found")?;
    // Component-wise starts_with rejects sibling prefixes such as `<root>-evil`
    // and any symlink that canonicalizes outside the root.
    if !dir.starts_with(&root) {
        return Err("bad sid");
    }
    if !dir.is_dir() {
        return Err("not found");
    }
    Ok(dir)
}

fn sid_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)^[0-9a-f-]{8,64}$").expect("constant regex is valid"))
}

fn error_response(error: &str) -> Response {
    let status = match error {
        "plans disabled" | "not found" => StatusCode::NOT_FOUND,
        _ => StatusCode::BAD_REQUEST,
    };
    (status, Json(json!({ "ok": false, "error": error }))).into_response()
}

fn backend_unavailable() -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({ "ok": false, "error": "plans backend unavailable" })),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::router;
    use serde_json::{Value, json};
    use std::fs;
    use std::io;
    use std::net::{Ipv4Addr, SocketAddr};
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};
    use tokio::sync::oneshot;
    use tokio::task::JoinHandle;

    struct Fixture(PathBuf);

    impl Fixture {
        fn new(name: &str) -> Self {
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let dir = std::env::temp_dir().join(format!(
                "singularity-http-plans-{name}-{}-{nanos}",
                std::process::id()
            ));
            fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }

        fn put(&self, rel: &str, contents: &str) {
            let path = self.0.join(rel);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, contents).unwrap();
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[cfg(unix)]
    fn symlink_dir(target: &Path, link: &Path) -> io::Result<()> {
        std::os::unix::fs::symlink(target, link)
    }

    #[cfg(windows)]
    fn symlink_dir(target: &Path, link: &Path) -> io::Result<()> {
        if std::os::windows::fs::symlink_dir(target, link).is_ok() {
            return Ok(());
        }
        let result = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .output()?;
        if result.status.success() {
            Ok(())
        } else {
            Err(io::Error::other(
                String::from_utf8_lossy(&result.stderr).into_owned(),
            ))
        }
    }

    fn run<F: std::future::Future>(future: F) -> F::Output {
        tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(future)
    }

    async fn start(
        root: Option<PathBuf>,
    ) -> (SocketAddr, oneshot::Sender<()>, JoinHandle<io::Result<()>>) {
        let listener = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let address = listener.local_addr().unwrap();
        assert!(address.ip().is_loopback());
        let (stop, stopped) = oneshot::channel::<()>();
        let server = tokio::spawn(async move {
            axum::serve(listener, router(root))
                .with_graceful_shutdown(async move {
                    let _ = stopped.await;
                })
                .await
        });
        (address, stop, server)
    }

    async fn get_json(address: SocketAddr, path: &str) -> (u16, Value) {
        let response = reqwest::get(format!("http://{address}{path}"))
            .await
            .unwrap();
        let status = response.status().as_u16();
        let body = response.text().await.unwrap();
        (status, serde_json::from_str(&body).unwrap())
    }

    const SID: &str = "aaaaaaaa-1111-4111-8111-111111111111";

    #[test]
    fn http_sessions_list_is_a_bare_array_and_disabled_root_is_empty() {
        let fixture = Fixture::new("list");
        fixture.put(
            &format!("{SID}/plan.md"),
            "# Plan\nStatus: active\n\n## Objective\nShip it.\n",
        );
        fixture.put("not-a-session/plan.md", "# Plan\nStatus: active\n");
        run(async {
            let (address, stop, server) = start(Some(fixture.0.clone())).await;
            let (status, body) = get_json(address, "/api/plans/sessions").await;
            assert_eq!(status, 200);
            let rows = body.as_array().unwrap();
            assert_eq!(rows.len(), 1);
            assert_eq!(rows[0]["sid"], SID);
            assert_eq!(rows[0]["planCount"], 1);
            stop.send(()).unwrap();
            server.await.unwrap().unwrap();

            let (disabled_address, disabled_stop, disabled_server) = start(None).await;
            assert_eq!(
                get_json(disabled_address, "/api/plans/sessions").await,
                (200, json!([]))
            );
            disabled_stop.send(()).unwrap();
            disabled_server.await.unwrap().unwrap();
        });
    }

    #[test]
    fn http_sessions_list_serves_empty_for_an_absent_root() {
        let fixture = Fixture::new("absent-root");
        let missing = fixture.0.join("missing");
        run(async {
            let (address, stop, server) = start(Some(missing)).await;
            assert_eq!(
                get_json(address, "/api/plans/sessions").await,
                (200, json!([]))
            );
            stop.send(()).unwrap();
            server.await.unwrap().unwrap();
        });
    }

    #[test]
    fn http_session_serves_canonicalized_detail_for_a_valid_sid() {
        let fixture = Fixture::new("detail");
        fixture.put(
            &format!("{SID}/plan.md"),
            "# Plan A\nStatus: active\n\n## Objective\nShip plans.\n\n## Phases\n- [x] first\n",
        );
        fixture.put(&format!("{SID}/notes.md"), "# Evidence\ntext");
        run(async {
            let (address, stop, server) = start(Some(fixture.0.clone())).await;
            let (status, body) = get_json(address, &format!("/api/plans/session?sid={SID}")).await;
            assert_eq!(status, 200);
            assert_eq!(body["ok"], true);
            assert_eq!(body["sid"], SID);
            assert_eq!(body["plans"][0]["title"], "Plan A");
            assert_eq!(body["plans"][0]["phases"][0]["state"], "done");
            assert_eq!(body["notes"][0]["file"], "notes.md");
            stop.send(()).unwrap();
            server.await.unwrap().unwrap();
        });
    }

    #[test]
    fn http_session_disabled_root_is_404_plans_disabled_even_without_a_sid() {
        run(async {
            let (address, stop, server) = start(None).await;
            assert_eq!(
                get_json(address, "/api/plans/session").await,
                (404, json!({ "ok": false, "error": "plans disabled" }))
            );
            assert_eq!(
                get_json(address, &format!("/api/plans/session?sid={SID}")).await,
                (404, json!({ "ok": false, "error": "plans disabled" }))
            );
            stop.send(()).unwrap();
            server.await.unwrap().unwrap();
        });
    }

    #[test]
    fn http_session_invalid_absent_or_repeated_sid_is_400_bad_sid() {
        let fixture = Fixture::new("bad-sid");
        let long = "a".repeat(65);
        run(async {
            let (address, stop, server) = start(Some(fixture.0.clone())).await;
            for path in [
                "/api/plans/session".to_owned(),
                "/api/plans/session?sid=".to_owned(),
                "/api/plans/session?sid=abc".to_owned(),
                "/api/plans/session?sid=..".to_owned(),
                "/api/plans/session?sid=zzzzzzzz".to_owned(),
                "/api/plans/session?sid=aaaaaaaa%2Fbbbbbbbb".to_owned(),
                format!("/api/plans/session?sid={long}"),
                format!("/api/plans/session?sid={SID}&sid={SID}"),
            ] {
                assert_eq!(
                    get_json(address, &path).await,
                    (400, json!({ "ok": false, "error": "bad sid" })),
                    "{path}"
                );
            }
            stop.send(()).unwrap();
            server.await.unwrap().unwrap();
        });
    }

    #[test]
    fn http_session_absent_directory_is_404_not_found() {
        let fixture = Fixture::new("absent-session");
        run(async {
            let (address, stop, server) = start(Some(fixture.0.clone())).await;
            assert_eq!(
                get_json(address, &format!("/api/plans/session?sid={SID}")).await,
                (404, json!({ "ok": false, "error": "not found" }))
            );
            stop.send(()).unwrap();
            server.await.unwrap().unwrap();
        });
    }

    #[test]
    fn http_session_rejects_a_symlinked_session_escaping_the_root() {
        let root = Fixture::new("symlink-root");
        let outside = Fixture::new("symlink-outside");
        outside.put("plan.md", "# Plan\nStatus: active\n");
        symlink_dir(&outside.0, &root.0.join(SID)).expect("create session link");
        run(async {
            let (address, stop, server) = start(Some(root.0.clone())).await;
            assert_eq!(
                get_json(address, &format!("/api/plans/session?sid={SID}")).await,
                (400, json!({ "ok": false, "error": "bad sid" }))
            );
            stop.send(()).unwrap();
            server.await.unwrap().unwrap();
        });
    }
}
