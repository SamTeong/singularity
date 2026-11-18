//! Task board HTTP surface: `GET/POST /api/tasks`,
//! `POST /api/tasks/:id/status`, `POST /api/tasks/:id/conclude` and
//! `DELETE /api/tasks/history/:id`.
//!
//! Ports `server/index.mjs:666-682` (route bodies) and the `errStatus` mapping
//! at `:253`: `statusCode` first, else `persistFailure → 500`, else 400. Bodies
//! are parsed with the shared Fastify-compatible [`crate::http_body::parse`],
//! so a malformed or unsupported body keeps the same envelope it would get on
//! any other native JSON route.
//!
//! The host merges this router into the `/api` tree after the auth/origin
//! layers; nothing here reads the process environment.

use std::sync::Arc;

use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{Request, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use serde_json::{Value, json};

use crate::task_service::{TaskError, TaskService};

/// The daemon-owned board the five routes operate on.
pub struct TasksDeps {
    pub tasks: Arc<TaskService>,
}

// VERIFY: http-tasks-router
/// `app.get('/tasks')`, `app.post('/tasks')`, `app.post('/tasks/:id/status')`,
/// `app.post('/tasks/:id/conclude')`, `app.delete('/tasks/history/:id')`
/// (`index.mjs:666-682`).
pub fn router(deps: TasksDeps) -> Router {
    Router::new()
        .route("/api/tasks", get(list).post(create))
        .route("/api/tasks/{id}/status", post(update_status))
        .route("/api/tasks/{id}/conclude", post(conclude))
        .route("/api/tasks/history/{id}", delete(delete_history))
        .with_state(deps.tasks)
}

// VERIFY: wave3-tasks-10
/// `errStatus(e)` (`index.mjs:253`): `e.statusCode || (persistFailure ? 500 : 400)`.
/// `statusCode` wins; a falsy `0` falls through like JS `||`.
pub fn status_for(error: &TaskError) -> StatusCode {
    if let Some(code) = error.status_code.filter(|code| *code != 0) {
        return StatusCode::from_u16(code).unwrap_or(StatusCode::BAD_REQUEST);
    }
    if error.persist_failure {
        StatusCode::INTERNAL_SERVER_ERROR
    } else {
        StatusCode::BAD_REQUEST
    }
}

fn error_response(error: &TaskError) -> Response {
    (
        status_for(error),
        Json(json!({ "ok": false, "error": error.message })),
    )
        .into_response()
}

// VERIFY: http-tasks-list
/// `app.get('/tasks', () => snapshotTasks())` (`index.mjs:666`): the bare
/// snapshot, no `ok` envelope.
async fn list(State(tasks): State<Arc<TaskService>>) -> Response {
    Json(tasks.snapshot()).into_response()
}

// VERIFY: http-tasks-create
/// `app.post('/tasks', ...)` (`index.mjs:667-671`).
async fn create(State(tasks): State<Arc<TaskService>>, request: Request<Body>) -> Response {
    let body = match crate::http_body::parse(request).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    match tasks.create(&body).await {
        Ok(task) => Json(json!({ "ok": true, "task": task })).into_response(),
        Err(error) => error_response(&error),
    }
}

// VERIFY: http-tasks-update-status
/// `app.post('/tasks/:id/status', ...)` (`index.mjs:672-676`).
async fn update_status(
    State(tasks): State<Arc<TaskService>>,
    Path(id): Path<String>,
    request: Request<Body>,
) -> Response {
    let body = match crate::http_body::parse(request).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    match tasks.update(&id, &body).await {
        Ok(task) => Json(json!({ "ok": true, "task": task })).into_response(),
        Err(error) => error_response(&error),
    }
}

// VERIFY: http-tasks-conclude
/// `app.post('/tasks/:id/conclude', ...)` (`index.mjs:677-679`). A missing or
/// non-string `outcome` reaches `concludeTask` as `undefined` in Node and gets
/// the `bad outcome` message, so it is rendered as `""` here.
async fn conclude(
    State(tasks): State<Arc<TaskService>>,
    Path(id): Path<String>,
    request: Request<Body>,
) -> Response {
    let body = match crate::http_body::parse(request).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    let outcome = body.get("outcome").and_then(Value::as_str).unwrap_or("");
    match tasks.conclude(&id, outcome).await {
        Ok(()) => Json(json!({ "ok": true })).into_response(),
        Err(error) => error_response(&error),
    }
}

// VERIFY: http-tasks-delete-history
/// `app.delete('/tasks/history/:id', ...)` (`index.mjs:680-682`).
async fn delete_history(State(tasks): State<Arc<TaskService>>, Path(id): Path<String>) -> Response {
    match tasks.delete_history(&id).await {
        Ok(()) => Json(json!({ "ok": true })).into_response(),
        Err(error) => error_response(&error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::task_service::TaskService;
    use crate::task_service::test_support::{
        FakeGit, FakeSpawner, Fixture, fixed_clock, service, task,
    };
    use axum::body::to_bytes;
    use axum::http::{Method, header};

    fn run<F: std::future::Future>(future: F) -> F::Output {
        tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(future)
    }

    fn request(method: Method, uri: &str, body: Option<Value>) -> Request<Body> {
        let builder = Request::builder().method(method).uri(uri);
        match body {
            Some(value) => builder
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(serde_json::to_string(&value).unwrap()))
                .unwrap(),
            None => builder.body(Body::empty()).unwrap(),
        }
    }

    async fn collect(response: Response) -> (u16, Value) {
        let status = response.status().as_u16();
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    fn post_request(uri: &str, body: Value) -> Request<Body> {
        request(Method::POST, uri, Some(body))
    }

    fn board(tag: &str) -> (Fixture, Arc<TaskService>) {
        let fixture = Fixture::new(tag);
        let (service, _bus) = service(
            &fixture,
            FakeSpawner::new(),
            FakeGit::new(),
            fixed_clock(1000),
        );
        (fixture, service)
    }

    // VERIFY: wave3-tasks-11
    /// Exercises the real router over an ephemeral loopback listener: a path or
    /// verb typo would surface as 404/405. Uses a live server instead of
    /// `tower::ServiceExt::oneshot` because `tower` is not a direct dependency
    /// (Cargo.toml is host-owned); coverage of the route table is the same.
    #[test]
    fn every_task_route_is_served_over_http() {
        run(async {
            let (_fixture, service) = board("routes");
            service.seed(task("t1"));
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
            let app = router(TasksDeps {
                tasks: service.clone(),
            });
            let server = tokio::spawn(async move {
                axum::serve(listener, app)
                    .with_graceful_shutdown(async move {
                        let _ = stopped.await;
                    })
                    .await
            });
            let client = reqwest::Client::new();
            let base = format!("http://{address}");

            let response = client
                .get(format!("{base}/api/tasks"))
                .send()
                .await
                .unwrap();
            assert_eq!(response.status().as_u16(), 200);
            let body: Value = response.json().await.unwrap();
            assert_eq!(body["tasks"][0]["id"], "t1");

            // A wrong verb on a matched path is 405, proving the method routing.
            let response = client
                .get(format!("{base}/api/tasks/t1/status"))
                .send()
                .await
                .unwrap();
            assert_eq!(response.status().as_u16(), 405);

            // POST /api/tasks: a validation 400 proves the handler ran, not 404.
            let response = client
                .post(format!("{base}/api/tasks"))
                .json(&json!({}))
                .send()
                .await
                .unwrap();
            assert_eq!(response.status().as_u16(), 400);

            let response = client
                .post(format!("{base}/api/tasks/t1/status"))
                .json(&json!({ "column": "inprogress", "state": "working" }))
                .send()
                .await
                .unwrap();
            assert_eq!(response.status().as_u16(), 200);
            let body: Value = response.json().await.unwrap();
            assert_eq!(body["task"]["column"], "inprogress");

            let response = client
                .post(format!("{base}/api/tasks/t1/conclude"))
                .json(&json!({ "outcome": "completed" }))
                .send()
                .await
                .unwrap();
            assert_eq!(response.status().as_u16(), 200);

            let response = client
                .delete(format!("{base}/api/tasks/history/t1"))
                .send()
                .await
                .unwrap();
            assert_eq!(response.status().as_u16(), 200);

            // An unknown id still reaches the handler (400), not a 404.
            let response = client
                .post(format!("{base}/api/tasks/missing/status"))
                .json(&json!({}))
                .send()
                .await
                .unwrap();
            assert_eq!(response.status().as_u16(), 400);
            let body: Value = response.json().await.unwrap();
            assert_eq!(body["error"], "no such task");

            stop.send(()).unwrap();
            server.await.unwrap().unwrap();
        });
    }

    // VERIFY: http-tasks-tests-list
    #[test]
    fn list_returns_the_bare_snapshot() {
        run(async {
            let (_fixture, service) = board("list");
            service.seed(task("t1"));
            let (status, body) = collect(list(State(service)).await).await;
            assert_eq!(status, 200);
            assert_eq!(body["tasks"].as_array().unwrap().len(), 1);
            assert_eq!(body["history"], json!([]));
            assert!(body.get("ok").is_none());
        });
    }

    // VERIFY: http-tasks-tests-create
    #[test]
    fn create_returns_ok_task_and_400_messages() {
        run(async {
            let (fixture, service) = board("create");
            let repo = fixture.root.to_string_lossy().into_owned();
            let (status, body) = collect(
                create(
                    State(service.clone()),
                    post_request(
                        "/api/tasks",
                        json!({ "repo": repo, "title": "T", "description": "D" }),
                    ),
                )
                .await,
            )
            .await;
            assert_eq!(status, 200);
            assert_eq!(body["ok"], true);
            assert_eq!(body["task"]["title"], "T");
            assert_eq!(body["task"]["column"], "todo");

            let (status, body) = collect(
                create(
                    State(service.clone()),
                    post_request("/api/tasks", json!({ "title": "T", "description": "D" })),
                )
                .await,
            )
            .await;
            assert_eq!(status, 400);
            assert_eq!(body["ok"], false);
            assert_eq!(body["error"], "repo, title and description required");

            let (status, body) = collect(
                create(
                    State(service),
                    post_request(
                        "/api/tasks",
                        json!({ "repo": repo, "title": "T", "description": "D", "tags": {} }),
                    ),
                )
                .await,
            )
            .await;
            assert_eq!(status, 400);
            assert_eq!(body["error"], "tags.map is not a function");
        });
    }

    // VERIFY: http-tasks-tests-status
    #[test]
    fn update_status_maps_domain_errors_to_400_and_success_to_ok() {
        run(async {
            let (_fixture, service) = board("status");
            service.seed(task("t1"));
            let (status, body) = collect(
                update_status(
                    State(service.clone()),
                    Path("t1".to_owned()),
                    post_request("/api/tasks/t1/status", json!({ "column": "nope" })),
                )
                .await,
            )
            .await;
            assert_eq!(status, 400);
            assert_eq!(
                body["error"],
                "bad column (expected todo|inprogress|inreview|done)"
            );

            let (status, body) = collect(
                update_status(
                    State(service.clone()),
                    Path("t1".to_owned()),
                    post_request(
                        "/api/tasks/t1/status",
                        json!({ "column": "todo", "state": "working" }),
                    ),
                )
                .await,
            )
            .await;
            assert_eq!(status, 400);
            assert_eq!(
                body["error"],
                "bad state for todo (expected analyzing|clarifying|awaiting plan approval|rate-limited)"
            );

            let (status, body) = collect(
                update_status(
                    State(service.clone()),
                    Path("t1".to_owned()),
                    post_request(
                        "/api/tasks/t1/status",
                        json!({ "column": "inprogress", "state": "working" }),
                    ),
                )
                .await,
            )
            .await;
            assert_eq!(status, 200);
            assert_eq!(body["ok"], true);
            assert_eq!(body["task"]["column"], "inprogress");
            assert_eq!(body["task"]["transitions"].as_array().unwrap().len(), 1);

            let (status, body) = collect(
                update_status(
                    State(service),
                    Path("missing".to_owned()),
                    post_request("/api/tasks/missing/status", json!({})),
                )
                .await,
            )
            .await;
            assert_eq!(status, 400);
            assert_eq!(body["error"], "no such task");
        });
    }

    // VERIFY: http-tasks-tests-conclude
    #[test]
    fn conclude_validates_the_outcome_and_returns_ok() {
        run(async {
            let (_fixture, service) = board("conclude");
            service.seed(task("t1"));
            let (status, body) = collect(
                conclude(
                    State(service.clone()),
                    Path("t1".to_owned()),
                    post_request("/api/tasks/t1/conclude", json!({ "outcome": "nope" })),
                )
                .await,
            )
            .await;
            assert_eq!(status, 400);
            assert_eq!(body["error"], "bad outcome (expected completed|abandoned)");

            let (status, body) = collect(
                conclude(
                    State(service.clone()),
                    Path("t1".to_owned()),
                    post_request("/api/tasks/t1/conclude", json!({ "outcome": "completed" })),
                )
                .await,
            )
            .await;
            assert_eq!(status, 200);
            assert_eq!(body, json!({ "ok": true }));
            assert_eq!(service.history_len(), 1);
        });
    }

    // VERIFY: http-tasks-tests-delete-history
    #[test]
    fn delete_history_returns_ok_then_400_when_missing() {
        run(async {
            let (_fixture, service) = board("delete");
            service.seed(task("t1"));
            service.conclude("t1", "abandoned").await.unwrap();
            let (status, body) =
                collect(delete_history(State(service.clone()), Path("t1".to_owned())).await).await;
            assert_eq!(status, 200);
            assert_eq!(body, json!({ "ok": true }));

            let (status, body) =
                collect(delete_history(State(service), Path("t1".to_owned())).await).await;
            assert_eq!(status, 400);
            assert_eq!(body["error"], "no such history entry");
        });
    }

    // VERIFY: wave3-tasks-tests-status-precedence
    #[test]
    fn status_code_takes_precedence_over_persist_failure() {
        let plain = TaskError::bad("boom");
        assert_eq!(status_for(&plain), StatusCode::BAD_REQUEST);
        let persist = TaskError::persist("boom");
        assert_eq!(status_for(&persist), StatusCode::INTERNAL_SERVER_ERROR);
        let mut explicit = TaskError::bad("boom");
        explicit.status_code = Some(418);
        assert_eq!(status_for(&explicit), StatusCode::IM_A_TEAPOT);
        // `e.statusCode || (...)` — a set status wins over persistFailure.
        explicit.persist_failure = true;
        assert_eq!(status_for(&explicit), StatusCode::IM_A_TEAPOT);
        // A falsy code (0) falls through, like JS `||`.
        let mut zero = TaskError::persist("boom");
        zero.status_code = Some(0);
        assert_eq!(status_for(&zero), StatusCode::INTERNAL_SERVER_ERROR);
    }

    // VERIFY: http-tasks-tests-persist-500
    #[test]
    fn a_persist_failure_maps_to_500() {
        run(async {
            let (fixture, service) = board("persist-500");
            service.seed(task("t1"));
            std::fs::create_dir_all(&fixture.config().tasks_file).unwrap();
            let (status, body) = collect(
                update_status(
                    State(service),
                    Path("t1".to_owned()),
                    post_request("/api/tasks/t1/status", json!({ "column": "inprogress" })),
                )
                .await,
            )
            .await;
            assert_eq!(status, 500);
            assert_eq!(body["ok"], false);
            assert!(
                body["error"]
                    .as_str()
                    .unwrap()
                    .starts_with("tasks.json write failed: ")
            );
        });
    }
}
