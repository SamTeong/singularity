//! `/api/background` HTTP surface (`server/index.mjs:700-731`).
//!
//! Nine routes: the bare snapshot, job CRUD, reorder, forced/manual run,
//! report listing/read and the report flag. Error bodies are always
//! `{ok:false,error}` with `Conflict → 409`, `Persist → 500`, otherwise `400`;
//! a missing report is the only `404` (`index.mjs:292`, `:723-727`).

use std::sync::Arc;

use axum::body::Body;
use axum::extract::{Path, RawQuery, State};
use axum::http::{HeaderMap, Request, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post};
use axum::{Json, Router};
use serde_json::{Map, Value, json};

use crate::background::{BackgroundError, Service};
use crate::http_policy::query_values;

#[derive(Clone)]
pub struct HttpDeps {
    pub service: Arc<Service>,
}

// VERIFY: background-http-router
/// The nine background routes, mounted under the host's `/api` router.
pub fn router(deps: HttpDeps) -> Router {
    Router::new()
        .route("/api/background", get(snapshot))
        .route("/api/background/jobs", post(create_job))
        .route(
            "/api/background/jobs/{id}",
            patch(update_job).delete(delete_job),
        )
        .route("/api/background/reorder", patch(reorder))
        .route("/api/background/run", post(run))
        .route("/api/background/reports", get(list_reports))
        .route("/api/background/reports/{task_id}", get(get_report))
        .route("/api/background/reports/{task_id}/flag", patch(set_flag))
        .with_state(deps)
}

fn error(error: BackgroundError) -> Response {
    let status = StatusCode::from_u16(error.status()).unwrap_or(StatusCode::BAD_REQUEST);
    (
        status,
        Json(json!({ "ok": false, "error": error.message() })),
    )
        .into_response()
}

/// `req.body || {}` — a null or plain-text body contributes no fields.
async fn object_body(request: Request<Body>) -> Result<Value, Response> {
    let body = crate::http_body::parse(request).await?;
    Ok(if body.is_object() { body } else { json!({}) })
}

async fn snapshot(State(deps): State<HttpDeps>) -> Json<Value> {
    Json(deps.service.snapshot())
}

async fn create_job(
    State(deps): State<HttpDeps>,
    headers: HeaderMap,
    request: Request<Body>,
) -> Response {
    let body = match object_body(request).await {
        Ok(body) => body,
        Err(response) => return response,
    };
    // VERIFY: wave3-fix-background-11
    // Node reads a repeated header as an array, and `typeof !== 'string'` turns
    // that into no key at all (`background.mjs:367`); only a single value counts.
    let mut keys = headers.get_all("idempotency-key").iter();
    let key = match (keys.next(), keys.next()) {
        (Some(value), None) => value.to_str().ok(),
        _ => None,
    };
    match deps.service.create_job(&body, key) {
        Ok(job) => Json(json!({ "ok": true, "job": job })).into_response(),
        Err(err) => error(err),
    }
}

async fn update_job(
    State(deps): State<HttpDeps>,
    Path(id): Path<String>,
    request: Request<Body>,
) -> Response {
    let body = match object_body(request).await {
        Ok(body) => body,
        Err(response) => return response,
    };
    match deps.service.update_job(&id, &body) {
        Ok(job) => Json(json!({ "ok": true, "job": job })).into_response(),
        Err(err) => error(err),
    }
}

async fn delete_job(State(deps): State<HttpDeps>, Path(id): Path<String>) -> Response {
    match deps.service.delete_job(&id) {
        Ok(()) => Json(json!({ "ok": true })).into_response(),
        Err(err) => error(err),
    }
}

async fn reorder(State(deps): State<HttpDeps>, request: Request<Body>) -> Response {
    let body = match object_body(request).await {
        Ok(body) => body,
        Err(response) => return response,
    };
    match deps.service.reorder_jobs(&body["ids"]) {
        Ok(()) => Json(json!({ "ok": true })).into_response(),
        Err(err) => error(err),
    }
}

async fn run(State(deps): State<HttpDeps>, RawQuery(query): RawQuery) -> Response {
    // `req.query.force === '1'` — a repeated `force` is an array, not `'1'`.
    let values = query_values(query.as_deref().unwrap_or_default(), "force");
    let force = values.len() == 1 && values[0] == "1";
    match deps.service.run_now(force).await {
        Ok(task_id) => Json(json!({ "ok": true, "taskId": task_id })).into_response(),
        Err(err) => error(err),
    }
}

// VERIFY: wave3-fix-background-13
// Neither report GET is wrapped in `try` in Node, so a report read failure is
// the default 500 (`index.mjs:725-727`); only a missing report is a 404.
async fn list_reports(State(deps): State<HttpDeps>) -> Response {
    match deps.service.list_reports() {
        Ok(reports) => Json(json!({ "reports": reports })).into_response(),
        Err(err) => error(err),
    }
}

async fn get_report(State(deps): State<HttpDeps>, Path(task_id): Path<String>) -> Response {
    let report = match deps.service.get_report(&task_id) {
        Ok(Some(report)) => report,
        Ok(None) => {
            return (
                StatusCode::NOT_FOUND,
                Json(json!({ "ok": false, "error": "not found" })),
            )
                .into_response();
        }
        Err(err) => return error(err),
    };
    let mut body = Map::new();
    body.insert("ok".to_owned(), json!(true));
    if let Value::Object(fields) = report {
        for (key, value) in fields {
            body.insert(key, value);
        }
    }
    Json(Value::Object(body)).into_response()
}

async fn set_flag(
    State(deps): State<HttpDeps>,
    Path(task_id): Path<String>,
    request: Request<Body>,
) -> Response {
    let body = match object_body(request).await {
        Ok(body) => body,
        Err(response) => return response,
    };
    let flagged = crate::background::js_truthy(&body["flagged"]);
    match deps.service.set_report_flag(&task_id, flagged) {
        Ok(result) => {
            let mut body = Map::new();
            body.insert("ok".to_owned(), json!(true));
            if let Value::Object(fields) = result {
                for (key, value) in fields {
                    body.insert(key, value);
                }
            }
            Json(Value::Object(body)).into_response()
        }
        Err(err) => error(err),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::background::{
        BackgroundDeps, BackgroundRegistry, BackgroundTasks, BoxFuture, NewBackgroundTask,
        SessionTokens,
    };
    use crate::bus::Bus;
    use axum::http::StatusCode;
    use serde_json::{Value, json};
    use std::fs;
    use std::io;
    use std::net::{Ipv4Addr, SocketAddr};
    use std::path::{Path, PathBuf};
    use std::sync::Mutex;
    use std::time::{SystemTime, UNIX_EPOCH};
    use tokio::sync::oneshot;
    use tokio::task::JoinHandle;

    struct Fixture {
        dir: PathBuf,
        tasks: Arc<FakeTasks>,
    }

    impl Fixture {
        fn new(name: &str) -> Self {
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let dir = std::env::temp_dir().join(format!(
                "singularity-http-background-{name}-{}-{nanos}",
                std::process::id()
            ));
            fs::create_dir_all(dir.join("state")).unwrap();
            Self {
                dir,
                tasks: Arc::new(FakeTasks::default()),
            }
        }

        fn service(&self, usage_fails: bool) -> Arc<Service> {
            Service::new(BackgroundDeps {
                state_dir: self.dir.join("state"),
                reports_dir: self.dir.join(".reports"),
                bus: Bus::new(),
                registry: Arc::new(FakeRegistry),
                tasks: self.tasks.clone(),
                usage: Arc::new(FakeUsage { fails: usage_fails }),
                route: Arc::new(|_, _| json!({ "isClaudeModel": true })),
                tokens: Arc::new(FakeTokens),
                clock: Arc::new(|| 1_000_000_000_000),
                write_atomic: Arc::new(|path: &Path, bytes: &[u8]| fs::write(path, bytes)),
            })
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.dir);
        }
    }

    #[derive(Default)]
    struct FakeTasks {
        tasks: Mutex<Vec<Value>>,
    }

    impl BackgroundTasks for FakeTasks {
        fn snapshot(&self) -> Value {
            json!({ "tasks": self.tasks.lock().unwrap().clone(), "history": [] })
        }

        fn create<'a>(&'a self, spec: NewBackgroundTask) -> BoxFuture<'a, Result<Value, String>> {
            Box::pin(async move {
                let id = format!("task-{}", self.tasks.lock().unwrap().len());
                let task = json!({
                    "id": id, "title": spec.title, "tags": spec.tags,
                    "column": "todo", "repo": spec.repo, "model": spec.model,
                    "backgroundJobId": spec.background_job_id,
                    "backgroundRunId": spec.background_run_id,
                });
                self.tasks.lock().unwrap().push(task.clone());
                Ok(task)
            })
        }

        fn update<'a>(&'a self, id: &'a str, patch: Value) -> BoxFuture<'a, Result<Value, String>> {
            Box::pin(async move {
                let mut tasks = self.tasks.lock().unwrap();
                let task = tasks
                    .iter_mut()
                    .find(|task| task.get("id").and_then(Value::as_str) == Some(id))
                    .ok_or_else(|| "no such task".to_owned())?;
                if let (Value::Object(fields), Value::Object(patch)) = (task, patch) {
                    for (key, value) in patch {
                        fields.insert(key, value);
                    }
                }
                Ok(tasks
                    .iter()
                    .find(|task| task.get("id").and_then(Value::as_str) == Some(id))
                    .cloned()
                    .unwrap())
            })
        }
    }

    struct FakeUsage {
        fails: bool,
    }

    impl crate::background::BackgroundUsage for FakeUsage {
        fn usage<'a>(&'a self) -> BoxFuture<'a, Result<Value, String>> {
            let fails = self.fails;
            Box::pin(async move {
                if fails {
                    Err("usage failed".to_owned())
                } else {
                    Ok(json!({
                        "claude": { "ok": true, "session": { "pctUsed": 10 }, "weekly": { "pctUsed": 10 } }
                    }))
                }
            })
        }
    }

    struct FakeRegistry;

    impl BackgroundRegistry for FakeRegistry {
        fn is_live(&self, _id: &str) -> bool {
            false
        }
        fn input(&self, _id: &str, _data: &str) {}
        fn kill(&self, _id: &str) -> Result<(), String> {
            Ok(())
        }
    }

    struct FakeTokens;

    impl SessionTokens for FakeTokens {
        fn tokens<'a>(
            &'a self,
            _cwd: String,
            _session_id: String,
            _tool: String,
        ) -> BoxFuture<'a, Result<i64, String>> {
            Box::pin(async { Ok(0) })
        }
    }

    fn run<F: std::future::Future>(future: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(future)
    }

    struct Server {
        address: SocketAddr,
        stop: Option<oneshot::Sender<()>>,
        handle: JoinHandle<io::Result<()>>,
    }

    impl Server {
        async fn start(service: Arc<Service>) -> Self {
            let listener = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
                .await
                .unwrap();
            let address = listener.local_addr().unwrap();
            let (stop, stopped) = oneshot::channel::<()>();
            let handle = tokio::spawn(async move {
                axum::serve(listener, router(HttpDeps { service }))
                    .with_graceful_shutdown(async move {
                        let _ = stopped.await;
                    })
                    .await
            });
            Self {
                address,
                stop: Some(stop),
                handle,
            }
        }
    }

    impl Drop for Server {
        fn drop(&mut self) {
            if let Some(stop) = self.stop.take() {
                let _ = stop.send(());
            }
            self.handle.abort();
        }
    }

    async fn send(
        address: SocketAddr,
        method: &str,
        path: &str,
        body: Option<&Value>,
        idempotency: Option<&str>,
    ) -> (u16, Value) {
        let mut request = reqwest::Client::new()
            .request(method.parse().unwrap(), format!("http://{address}{path}"));
        if let Some(body) = body {
            request = request.json(body);
        }
        if let Some(key) = idempotency {
            request = request.header("idempotency-key", key);
        }
        let response = request.send().await.unwrap();
        let status = response.status().as_u16();
        let text = response.text().await.unwrap();
        (status, serde_json::from_str(&text).unwrap())
    }

    async fn get(address: SocketAddr, path: &str) -> (u16, Value) {
        send(address, "GET", path, None, None).await
    }

    #[test]
    fn job_crud_routes_match_node_bodies_and_status_codes() {
        let fixture = Fixture::new("crud");
        run(async {
            let server = Server::start(fixture.service(false)).await;
            let address = server.address;
            assert_eq!(
                get(address, "/api/background").await,
                (
                    200,
                    json!({
                        "config": { "jobs": [] },
                        "lastTick": Value::Null,
                        "liveTaskId": Value::Null,
                        "nextDueAt": 1_000_000_000_000i64 + 3_600_000,
                    })
                )
            );

            let body = json!({ "title": "a", "description": "d", "cwd": "C:\\x" });
            let (status, created) = send(
                address,
                "POST",
                "/api/background/jobs",
                Some(&body),
                Some("k1"),
            )
            .await;
            assert_eq!(status, 200);
            assert_eq!(created["ok"], json!(true));
            let id = created["job"]["id"].as_str().unwrap().to_owned();
            assert_eq!(created["job"]["conclude"], json!("inreview"));

            // identical retry returns the same record; a changed payload is 409.
            let (_, retry) = send(
                address,
                "POST",
                "/api/background/jobs",
                Some(&body),
                Some("k1"),
            )
            .await;
            assert_eq!(retry["job"]["id"], json!(id));
            let (status, conflict) = send(
                address,
                "POST",
                "/api/background/jobs",
                Some(&json!({ "title": "changed", "description": "d", "cwd": "C:\\x" })),
                Some("k1"),
            )
            .await;
            assert_eq!(status, 409);
            assert_eq!(conflict["ok"], json!(false));

            let (status, invalid) = send(
                address,
                "POST",
                "/api/background/jobs",
                Some(&json!({})),
                None,
            )
            .await;
            assert_eq!(status, 400);
            assert_eq!(invalid["error"], json!("title, description, cwd required"));

            let (status, updated) = send(
                address,
                "PATCH",
                &format!("/api/background/jobs/{id}"),
                Some(&json!({ "title": "edited", "thresholds": { "claude": { "start": 1 } } })),
                None,
            )
            .await;
            assert_eq!(status, 200);
            assert_eq!(updated["job"]["title"], json!("edited"));
            assert_eq!(updated["job"]["thresholds"]["claude"]["stop"], json!(75));

            let (status, _) = send(
                address,
                "PATCH",
                "/api/background/jobs/nope",
                Some(&json!({})),
                None,
            )
            .await;
            assert_eq!(status, 400);

            let (status, listed) = get(address, "/api/background/reports").await;
            assert_eq!(status, 200);
            assert_eq!(listed, json!({ "reports": [] }));

            assert_eq!(
                send(
                    address,
                    "DELETE",
                    &format!("/api/background/jobs/{id}"),
                    None,
                    None
                )
                .await,
                (200, json!({ "ok": true }))
            );
        });
    }

    #[test]
    fn reorder_and_run_routes_honour_force_and_single_flight() {
        let fixture = Fixture::new("run");
        run(async {
            let service = fixture.service(true); // usage fails unless the gate is forced
            let server = Server::start(service).await;
            let address = server.address;
            let (_, first) = send(
                address,
                "POST",
                "/api/background/jobs",
                Some(&json!({ "title": "a", "description": "d", "cwd": "C:\\x" })),
                None,
            )
            .await;
            let second = send(
                address,
                "POST",
                "/api/background/jobs",
                Some(&json!({ "title": "b", "description": "d", "cwd": "C:\\x" })),
                None,
            )
            .await
            .1;
            let first_id = first["job"]["id"].as_str().unwrap().to_owned();
            let second_id = second["job"]["id"].as_str().unwrap().to_owned();

            assert_eq!(
                send(
                    address,
                    "PATCH",
                    "/api/background/reorder",
                    Some(&json!({ "ids": [second_id, first_id] })),
                    None,
                )
                .await,
                (200, json!({ "ok": true }))
            );
            let (_, snapshot) = get(address, "/api/background").await;
            assert_eq!(snapshot["config"]["jobs"][0]["id"], json!(second_id));

            // `force=true` is not the literal `'1'`, so the usage gate still applies.
            let (status, failed) = send(
                address,
                "POST",
                "/api/background/run?force=true",
                None,
                None,
            )
            .await;
            assert_eq!(status, 400);
            assert_eq!(failed["error"], json!("usage failed"));

            let (status, ran) =
                send(address, "POST", "/api/background/run?force=1", None, None).await;
            assert_eq!(status, 200);
            assert_eq!(ran["ok"], json!(true));
            assert_eq!(ran["taskId"], json!("task-0"));

            // VERIFY: wave3-fix-background-14
            // The new card is live (tagged, `todo`) until it concludes, and Node
            // refuses every further run while a live card exists
            // (`background.mjs:177-202`); conclude it so the next assertion
            // covers only the query decode.
            fixture.tasks.tasks.lock().unwrap()[0]["column"] = json!("done");

            // `force=%31` decodes to `1`, like Fastify's query parser.
            let (status, _) =
                send(address, "POST", "/api/background/run?force=%31", None, None).await;
            assert_eq!(status, 200);
        });
    }

    #[test]
    fn report_routes_serve_content_flags_and_404s() {
        let fixture = Fixture::new("reports");
        let report = fixture.dir.join(".reports").join("abc");
        fs::create_dir_all(&report).unwrap();
        fs::write(report.join("Report.md"), "# report\n").unwrap();
        fixture.tasks.tasks.lock().unwrap().push(json!({
            "id": "bg1", "title": "BG", "tags": ["background"], "column": "inreview",
            "reportDir": report.to_string_lossy(), "createdAt": 1,
        }));
        run(async {
            let server = Server::start(fixture.service(false)).await;
            let address = server.address;
            let (status, listed) = get(address, "/api/background/reports").await;
            assert_eq!(status, 200);
            assert_eq!(listed["reports"][0]["taskId"], json!("bg1"));
            assert_eq!(listed["reports"][0]["hasReport"], json!(true));

            let (status, report) = get(address, "/api/background/reports/bg1").await;
            assert_eq!(status, 200);
            assert_eq!(
                report,
                json!({ "ok": true, "taskId": "bg1", "title": "BG", "content": "# report\n" })
            );

            assert_eq!(
                get(address, "/api/background/reports/nope").await,
                (404, json!({ "ok": false, "error": "not found" }))
            );

            let (status, flagged) = send(
                address,
                "PATCH",
                "/api/background/reports/bg1/flag",
                Some(&json!({ "flagged": false })),
                None,
            )
            .await;
            assert_eq!(status, 200);
            assert_eq!(
                flagged,
                json!({ "ok": true, "taskId": "bg1", "flagged": false })
            );
            let (_, listed) = get(address, "/api/background/reports").await;
            assert_eq!(listed["reports"][0]["flagged"], json!(false));

            let (status, _) = send(
                address,
                "PATCH",
                "/api/background/reports/nope/flag",
                Some(&json!({ "flagged": true })),
                None,
            )
            .await;
            assert_eq!(status, 400);
        });
    }

    // F4: a background record with no reportDir makes Node's listing throw, so
    // the bare report GETs answer 500 (`index.mjs:725-727`).
    #[test]
    fn report_routes_answer_500_for_an_unusable_report_dir() {
        let fixture = Fixture::new("reports-broken");
        fixture.tasks.tasks.lock().unwrap().push(json!({
            "id": "bg1", "title": "BG", "tags": ["background"], "column": "inreview", "createdAt": 1,
        }));
        run(async {
            let server = Server::start(fixture.service(false)).await;
            let address = server.address;
            assert_eq!(get(address, "/api/background/reports").await.0, 500);
            assert_eq!(get(address, "/api/background/reports/bg1").await.0, 500);
            // The flag route is wrapped in Node, so the same failure is a 400.
            let (status, _) = send(
                address,
                "PATCH",
                "/api/background/reports/bg1/flag",
                Some(&json!({ "flagged": false })),
                None,
            )
            .await;
            assert_eq!(status, 400);
        });
    }

    #[test]
    fn background_routes_reject_unsupported_media_types_like_fastify() {
        let fixture = Fixture::new("media");
        run(async {
            let server = Server::start(fixture.service(false)).await;
            let response = reqwest::Client::new()
                .post(format!("http://{}/api/background/jobs", server.address))
                .header("content-type", "application/octet-stream")
                .body("{}")
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::UNSUPPORTED_MEDIA_TYPE);
        });
    }
}
