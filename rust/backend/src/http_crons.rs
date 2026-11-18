//! Cron HTTP routes: `GET /api/crons`, `POST /api/crons`,
//! `POST /api/crons/:id`, `DELETE /api/crons/:id`, `POST /api/crons/:id/run`.
//!
//! Ports `server/index.mjs:686-702` and the error mapping in
//! `errStatus` (`:292`): validation and `no such cron` are 400, an idempotency
//! mismatch is 409, and a genuine disk write failure is 500. Every failure is
//! `{ok:false, error:<message>}` with the reference's message string verbatim.
//!
//! `GET` returns the bare snapshot array (`crons.mjs:188-190`), never
//! `{crons:…}`. `POST /api/crons` reads `Idempotency-Key` from the header only;
//! a body field of the same name is ignored, exactly like
//! `index.mjs:688` spreading the body and then overriding the key.
//!
//! Handlers that touch disk or spawn a PTY run on `spawn_blocking`, like
//! `http_utilities.rs:344-358`, because `Registry::create` and the atomic
//! write retry ladder are synchronous and may sleep.

use std::sync::Arc;

use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, Request, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{Value, json};

use crate::crons::{CronError, CronsService};
use crate::http_body::parse;

// VERIFY: crons-router
/// Mounts the five cron routes. The outer server layer owns auth, origin and
/// token checks.
pub fn router(service: Arc<CronsService>) -> Router {
    Router::new()
        .route("/api/crons", get(list).post(create))
        .route("/api/crons/{id}", post(update).delete(remove))
        .route("/api/crons/{id}/run", post(run))
        .with_state(service)
}

// VERIFY: crons-http-get
/// `app.get('/crons', async () => snapshotCrons())` (`index.mjs:686`).
async fn list(State(service): State<Arc<CronsService>>) -> Response {
    Json(service.snapshot_value()).into_response()
}

// VERIFY: crons-http-create
/// `POST /crons` (`index.mjs:687-690`).
async fn create(
    State(service): State<Arc<CronsService>>,
    headers: HeaderMap,
    request: Request<Body>,
) -> Response {
    let body = match parse(request).await {
        Ok(body) => body,
        Err(response) => return response,
    };
    let key = idempotency_key(&headers);
    respond(blocking(move || service.create(&body, key.as_deref())).await)
}

// VERIFY: crons-http-update
/// `POST /crons/:id` — the UI sends POST, not PATCH (`index.mjs:691-694`).
async fn update(
    State(service): State<Arc<CronsService>>,
    Path(id): Path<String>,
    request: Request<Body>,
) -> Response {
    let body = match parse(request).await {
        Ok(body) => body,
        Err(response) => return response,
    };
    respond(blocking(move || service.update(&id, &body)).await)
}

// VERIFY: crons-http-delete
/// `DELETE /crons/:id` (`index.mjs:695-698`).
async fn remove(State(service): State<Arc<CronsService>>, Path(id): Path<String>) -> Response {
    match blocking(move || service.delete(&id)).await {
        Ok(Ok(())) => Json(json!({ "ok": true })).into_response(),
        Ok(Err(error)) => error.into_response(),
        Err(_) => internal_error(),
    }
}

// VERIFY: crons-run-response
/// `POST /crons/:id/run` (`index.mjs:699-702`): `{ok:true, cron:<agent>}`.
/// The reference returns the internal agent object; this returns the
/// `AgentWire` snapshot (a documented narrowing — the UI ignores the field).
async fn run(State(service): State<Arc<CronsService>>, Path(id): Path<String>) -> Response {
    respond(blocking(move || service.run(&id)).await)
}

/// The `Idempotency-Key` header (`index.mjs:688`). A non-UTF-8 or blank value
/// is treated as absent.
fn idempotency_key(headers: &HeaderMap) -> Option<String> {
    headers
        .get("idempotency-key")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

async fn blocking<T, F>(job: F) -> Result<T, tokio::task::JoinError>
where
    F: FnOnce() -> T + Send + 'static,
    T: Send + 'static,
{
    tokio::task::spawn_blocking(job).await
}

fn respond(result: Result<Result<Value, CronError>, tokio::task::JoinError>) -> Response {
    match result {
        Ok(Ok(value)) => Json(json!({ "ok": true, "cron": value })).into_response(),
        Ok(Err(error)) => error.into_response(),
        Err(_) => internal_error(),
    }
}

fn internal_error() -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({ "ok": false, "error": "Internal Server Error" })),
    )
        .into_response()
}

// VERIFY: crons-error-map
/// `errStatus` (`index.mjs:292`) as an axum response.
impl IntoResponse for CronError {
    fn into_response(self) -> Response {
        let status = StatusCode::from_u16(self.status_code()).unwrap_or(StatusCode::BAD_REQUEST);
        (
            status,
            Json(json!({ "ok": false, "error": self.message() })),
        )
            .into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_registry::{PtyPort, Registry, RegistryConfig};
    use crate::agent_spawn::{Bins, LaunchSpec, SpawnPaths};
    use crate::bus::Bus;
    use crate::crons::{CronsConfig, KILL_CONFIRM, TICK_INTERVAL};
    use std::collections::BTreeMap;
    use std::path::PathBuf;
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicU32, AtomicUsize, Ordering};

    static NEXT_FIXTURE: AtomicUsize = AtomicUsize::new(0);

    struct FakePort {
        next_pid: AtomicU32,
        kills: Mutex<Vec<String>>,
    }

    impl PtyPort for FakePort {
        fn spawn(&self, _id: &str, _generation: u64, _spec: LaunchSpec) -> Result<u32, String> {
            Ok(self.next_pid.fetch_add(1, Ordering::SeqCst))
        }
        fn write(&self, _id: &str, _data: &[u8]) -> Result<(), String> {
            Ok(())
        }
        fn resize(&self, _id: &str, _cols: u16, _rows: u16) -> Result<(), String> {
            Ok(())
        }
        fn kill(&self, id: &str) -> Result<(), String> {
            self.kills.lock().unwrap().push(id.to_owned());
            Ok(())
        }
    }

    #[derive(Default)]
    struct NoTimers;

    impl crate::crons::TimerPort for NoTimers {
        fn arm(&self, _key: &str, _after: std::time::Duration) -> u64 {
            0
        }
        fn cancel(&self, _key: &str) {}
    }

    struct Fixture {
        root: PathBuf,
        state_file: PathBuf,
    }

    impl Fixture {
        fn new(unwritable: bool) -> (Self, Arc<CronsService>) {
            let index = NEXT_FIXTURE.fetch_add(1, Ordering::SeqCst);
            let root = std::env::temp_dir().join(format!(
                "singularity-http-crons-{}-{index}",
                std::process::id()
            ));
            std::fs::create_dir_all(root.join("state")).unwrap();
            std::fs::create_dir_all(root.join("repo")).unwrap();
            let state_file = if unwritable {
                root.join("missing/crons.json")
            } else {
                root.join("state/crons.json")
            };
            let fixture = Self { root, state_file };
            let registry = Arc::new(Registry::new(
                Bus::new(),
                Arc::new(FakePort {
                    next_pid: AtomicU32::new(2000),
                    kills: Mutex::new(Vec::new()),
                }),
                RegistryConfig {
                    state_file: fixture.root.join("state/agents.json"),
                    bins: fixture.bins(),
                    parent_env: BTreeMap::new(),
                    clock: Arc::new(|| 1_700_000_000_000),
                },
            ));
            let service = Arc::new(CronsService::new(
                registry,
                Bus::new(),
                CronsConfig {
                    state_file: fixture.state_file.clone(),
                    clock: Arc::new(|| 1_700_000_000_000),
                    tick: TICK_INTERVAL,
                    idle_kill_after: KILL_CONFIRM,
                },
                Arc::new(NoTimers),
            ));
            (fixture, service)
        }

        fn repo(&self) -> String {
            self.root.join("repo").to_string_lossy().into_owned()
        }

        fn body(&self) -> Value {
            json!({
                "title": "route",
                "cronExpr": "* * * * *",
                "description": "p",
                "cwd": self.repo(),
            })
        }

        fn bins(&self) -> Bins {
            let mut paths = Vec::new();
            for name in ["claude.exe", "ollama.exe", "codex.exe"] {
                let path = self.root.join("bin").join(name);
                std::fs::create_dir_all(path.parent().unwrap()).unwrap();
                std::fs::write(&path, b"").unwrap();
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))
                        .unwrap();
                }
                paths.push(path.to_string_lossy().into_owned());
            }
            Bins::resolve(
                Some(&paths[0]),
                Some(&paths[1]),
                Some(&paths[2]),
                SpawnPaths {
                    home: self.root.join("home"),
                    scope_root: None,
                    cache_dir: self.root.join("cache"),
                    codex_home: self.root.join("codex-home"),
                    models_state: self.root.join("state/models.json"),
                },
            )
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    fn request(body: &Value) -> Request<Body> {
        Request::builder()
            .method("POST")
            .header("content-type", "application/json")
            .body(Body::from(serde_json::to_vec(body).unwrap()))
            .unwrap()
    }

    fn headers(key: Option<&str>) -> HeaderMap {
        let mut headers = HeaderMap::new();
        if let Some(key) = key {
            headers.insert("idempotency-key", key.parse().unwrap());
        }
        headers
    }

    async fn body_of(response: Response) -> (u16, Value) {
        let status = response.status().as_u16();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        (status, serde_json::from_slice(&bytes).unwrap())
    }

    fn run<F: std::future::Future>(future: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(future)
    }

    // VERIFY: crons-http-get-bare-array
    #[test]
    fn get_returns_the_bare_snapshot_array() {
        run(async {
            let (_fixture, service) = Fixture::new(false);
            let (status, body) = body_of(list(State(service)).await).await;
            assert_eq!(status, 200);
            assert!(body.is_array());
        });
    }

    // VERIFY: crons-http-create-shape
    #[test]
    fn create_uses_the_header_key_and_returns_ok_cron() {
        run(async {
            let (fixture, service) = Fixture::new(false);
            let payload = fixture.body();

            let (status, body) = body_of(
                create(
                    State(service.clone()),
                    headers(Some("header-key")),
                    request(&payload),
                )
                .await,
            )
            .await;
            assert_eq!(status, 200);
            assert_eq!(body["ok"], json!(true));
            assert_eq!(body["cron"]["title"], json!("route"));
            assert_eq!(body["cron"]["idempotencyKey"], json!("header-key"));

            // The body field of the same name is ignored (`index.mjs:688`).
            let mut with_body_key = payload.clone();
            with_body_key["idempotencyKey"] = json!("body-key");
            let (status, body) = body_of(
                create(
                    State(service.clone()),
                    headers(Some("header-key")),
                    request(&with_body_key),
                )
                .await,
            )
            .await;
            assert_eq!(status, 200);
            assert_eq!(body["cron"]["idempotencyKey"], json!("header-key"));

            let mut changed = payload.clone();
            changed["title"] = json!("changed");
            let (status, body) = body_of(
                create(
                    State(service.clone()),
                    headers(Some("header-key")),
                    request(&changed),
                )
                .await,
            )
            .await;
            assert_eq!(status, 409);
            assert_eq!(body["ok"], json!(false));
            assert_eq!(
                body["error"],
                json!("Idempotency-Key was already used with a different payload")
            );
        });
    }

    // VERIFY: crons-http-errors
    #[test]
    fn validation_notfound_and_persist_map_to_400_and_500() {
        run(async {
            let (fixture, service) = Fixture::new(false);
            let missing =
                json!({ "cronExpr": "* * * * *", "description": "p", "cwd": fixture.repo() });
            let (status, body) =
                body_of(create(State(service.clone()), HeaderMap::new(), request(&missing)).await)
                    .await;
            assert_eq!(status, 400);
            assert_eq!(
                body["error"],
                json!("title, cronExpr, description, cwd required")
            );

            let (status, body) = body_of(
                update(
                    State(service.clone()),
                    Path("missing".to_owned()),
                    request(&json!({})),
                )
                .await,
            )
            .await;
            assert_eq!(status, 400);
            assert_eq!(body["error"], json!("no such cron"));

            let (status, body) =
                body_of(remove(State(service.clone()), Path("missing".to_owned())).await).await;
            assert_eq!(status, 400);
            assert_eq!(body["error"], json!("no such cron"));

            let (unwritable_fixture, unwritable) = Fixture::new(true);
            let (status, body) = body_of(
                create(
                    State(unwritable),
                    HeaderMap::new(),
                    request(&unwritable_fixture.body()),
                )
                .await,
            )
            .await;
            assert_eq!(status, 500);
            assert_eq!(body["ok"], json!(false));
            assert!(
                body["error"]
                    .as_str()
                    .unwrap()
                    .starts_with("crons.json write failed:")
            );
        });
    }

    // VERIFY: crons-http-update-delete-run
    #[test]
    fn update_delete_and_run_return_the_reference_envelopes() {
        run(async {
            let (fixture, service) = Fixture::new(false);
            let (_, created) = body_of(
                create(
                    State(service.clone()),
                    HeaderMap::new(),
                    request(&fixture.body()),
                )
                .await,
            )
            .await;
            let id = created["cron"]["id"].as_str().unwrap().to_owned();

            let (status, body) = body_of(
                update(
                    State(service.clone()),
                    Path(id.clone()),
                    request(&json!({ "title": "renamed" })),
                )
                .await,
            )
            .await;
            assert_eq!(status, 200);
            assert_eq!(body["cron"]["title"], json!("renamed"));

            let (status, body) =
                body_of(super::run(State(service.clone()), Path(id.clone())).await).await;
            assert_eq!(status, 200);
            assert_eq!(body["ok"], json!(true));
            assert!(body["cron"]["id"].is_string(), "run returns the agent wire");
            assert!(body["cron"]["status"].is_string());

            let (status, body) = body_of(super::remove(State(service), Path(id)).await).await;
            assert_eq!(status, 200);
            assert_eq!(body, json!({ "ok": true }));
        });
    }

    // VERIFY: crons-http-run-overlap
    #[test]
    fn a_second_manual_run_while_the_first_is_live_is_a_400() {
        run(async {
            let (fixture, service) = Fixture::new(false);
            let mut disabled = fixture.body();
            disabled["enabled"] = json!(false);
            let (_, created) =
                body_of(create(State(service.clone()), HeaderMap::new(), request(&disabled)).await)
                    .await;
            let id = created["cron"]["id"].as_str().unwrap().to_owned();
            let (status, _) =
                body_of(super::run(State(service.clone()), Path(id.clone())).await).await;
            assert_eq!(status, 200);
            let (status, body) = body_of(super::run(State(service), Path(id)).await).await;
            assert_eq!(status, 400);
            assert_eq!(body["error"], json!("previous run still active"));
        });
    }
}
