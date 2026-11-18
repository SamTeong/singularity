use axum::body::Body;
use axum::extract::State;
use axum::http::{Request, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{Value, json};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

#[derive(Clone)]
struct AppState {
    state_dir: PathBuf,
    lock: Arc<Mutex<()>>,
}

pub fn router(state_dir: PathBuf) -> Router {
    Router::new()
        .route("/api/models", get(get_models).put(put_models))
        .route("/api/models/restore-defaults", post(restore_defaults))
        .with_state(AppState {
            state_dir,
            lock: Arc::new(Mutex::new(())),
        })
}

async fn get_models(State(state): State<AppState>) -> Response {
    let path = models_path(&state.state_dir);
    match tokio::task::spawn_blocking(move || {
        let _guard = state.lock.lock().unwrap_or_else(|error| error.into_inner());
        crate::models::get(&path)
    })
    .await
    {
        Ok(value) => Json(value).into_response(),
        Err(_) => unavailable(),
    }
}

async fn put_models(State(state): State<AppState>, request: Request<Body>) -> Response {
    let document = match crate::http_body::parse(request).await {
        Ok(document) => document,
        Err(response) => return response,
    };
    let path = models_path(&state.state_dir);
    match tokio::task::spawn_blocking(move || {
        let _guard = state.lock.lock().unwrap_or_else(|error| error.into_inner());
        crate::models::set(&path, &document)
    })
    .await
    {
        Ok(result) => {
            let status = if result.get("ok") == Some(&Value::Bool(true)) {
                StatusCode::OK
            } else {
                StatusCode::BAD_REQUEST
            };
            (status, Json(result)).into_response()
        }
        Err(_) => unavailable(),
    }
}

async fn restore_defaults(State(state): State<AppState>, request: Request<Body>) -> Response {
    if let Err(response) = crate::http_body::parse(request).await {
        return response;
    }
    let path = models_path(&state.state_dir);
    match tokio::task::spawn_blocking(move || {
        let _guard = state.lock.lock().unwrap_or_else(|error| error.into_inner());
        crate::models::restore(&path)
    })
    .await
    {
        Ok(document) => Json(json!({ "ok": true, "state": document })).into_response(),
        Err(_) => unavailable(),
    }
}

fn models_path(state_dir: &std::path::Path) -> String {
    state_dir.join("models.json").to_string_lossy().into_owned()
}

fn unavailable() -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({ "error": "models backend unavailable" })),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::router;
    use reqwest::{Client, Method};
    use serde_json::{Value, json};
    use std::fs;
    use std::io;
    use std::net::{Ipv4Addr, SocketAddr};
    use std::path::PathBuf;
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
                "singularity-http-models-{name}-{}-{nanos}",
                std::process::id()
            ));
            fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }

        fn write(&self, file: &str, contents: &str) {
            fs::write(self.0.join(file), contents).unwrap();
        }

        fn read(&self, file: &str) -> String {
            fs::read_to_string(self.0.join(file)).unwrap()
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

    async fn start(
        state_dir: PathBuf,
    ) -> (SocketAddr, oneshot::Sender<()>, JoinHandle<io::Result<()>>) {
        let listener = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let address = listener.local_addr().unwrap();
        assert!(address.ip().is_loopback());
        let (stop, stopped) = oneshot::channel::<()>();
        let server = tokio::spawn(async move {
            axum::serve(listener, router(state_dir))
                .with_graceful_shutdown(async move {
                    let _ = stopped.await;
                })
                .await
        });
        (address, stop, server)
    }

    async fn send(
        client: &Client,
        address: SocketAddr,
        method: Method,
        path: &str,
        body: Option<&str>,
    ) -> (u16, Value) {
        let mut request = client.request(method, format!("http://{address}{path}"));
        if let Some(body) = body {
            request = request
                .header("content-type", "application/json")
                .body(body.to_owned());
        }
        let response = request.send().await.unwrap();
        let status = response.status().as_u16();
        let text = response.text().await.unwrap();
        (status, serde_json::from_str(&text).unwrap_or(Value::Null))
    }

    const VALID_DOC: &str = r#"{"models":[{"id":"opus","group":"claude","label":"Opus","enabled":true}],"defaultModel":"opus","summariserModel":""}"#;

    #[test]
    fn concurrent_catalogue_operations_do_not_race() {
        let fixture = Fixture::new("concurrent");
        run(async {
            let (address, stop, server) = start(fixture.0.clone()).await;
            let mut tasks = Vec::new();
            for i in 0..30 {
                tasks.push(tokio::spawn(async move {
                    let client = Client::new();
                    match i % 3 {
                        0 => send(&client, address, Method::GET, "/api/models", None).await,
                        1 => {
                            send(
                                &client,
                                address,
                                Method::PUT,
                                "/api/models",
                                Some(VALID_DOC),
                            )
                            .await
                        }
                        _ => {
                            send(
                                &client,
                                address,
                                Method::POST,
                                "/api/models/restore-defaults",
                                None,
                            )
                            .await
                        }
                    }
                }));
            }
            for task in tasks {
                assert_eq!(task.await.unwrap().0, 200);
            }
            serde_json::from_str::<Value>(&fixture.read("models.json")).unwrap();
            stop.send(()).unwrap();
            server.await.unwrap().unwrap();
        });
    }

    #[test]
    fn empty_state_seeds_and_serves_the_bare_catalogue() {
        let fixture = Fixture::new("seed");
        run(async {
            let (address, stop, server) = start(fixture.0.clone()).await;
            let client = Client::new();
            let (status, body) = send(&client, address, Method::GET, "/api/models", None).await;
            assert_eq!(status, 200);
            assert_eq!(body["models"].as_array().unwrap().len(), 22);
            assert_eq!(body["defaultModel"], "claude");
            assert_eq!(body["summariserModel"], "deepseek-v4-flash:cloud");
            assert!(body.get("ok").is_none());
            assert!(fixture.0.join("models.json").exists());

            let response = client
                .head(format!("http://{address}/api/models"))
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), 200);
            assert!(response.bytes().await.unwrap().is_empty());

            drop(client);
            stop.send(()).unwrap();
            server.await.unwrap().unwrap();
        });
    }

    #[test]
    fn valid_put_persists_and_reads_back_the_normalised_document() {
        let fixture = Fixture::new("put");
        run(async {
            let (address, stop, server) = start(fixture.0.clone()).await;
            let client = Client::new();
            let document = json!({
                "models": [
                    { "id": "opus", "group": "claude", "label": "Opus", "enabled": true },
                    { "id": "gpt-6-sol", "group": "codex", "label": "Sol", "enabled": false }
                ],
                "defaultModel": "opus",
                "summariserModel": ""
            });
            let (status, body) = send(
                &client,
                address,
                Method::PUT,
                "/api/models",
                Some(&document.to_string()),
            )
            .await;
            assert_eq!(status, 200);
            assert_eq!(body["ok"], true);
            assert_eq!(body["state"], document);

            let (status, read) = send(&client, address, Method::GET, "/api/models", None).await;
            assert_eq!(status, 200);
            assert_eq!(read, document);

            drop(client);
            stop.send(()).unwrap();
            server.await.unwrap().unwrap();
        });
    }

    #[test]
    fn invalid_documents_are_rejected_with_400_and_never_write() {
        let fixture = Fixture::new("invalid");
        fixture.write("models.json", VALID_DOC);
        run(async {
            let (address, stop, server) = start(fixture.0.clone()).await;
            let client = Client::new();
            for (document, error) in [
                (r#"{"models":"nope"}"#, "models must be an array".to_owned()),
                (
                    r#"{"models":[{"id":"opus","group":"claude"},{"id":"opus","group":"claude"}]}"#,
                    "duplicate model id 'opus'".to_owned(),
                ),
            ] {
                let (status, body) =
                    send(&client, address, Method::PUT, "/api/models", Some(document)).await;
                assert_eq!(status, 400, "{document}");
                assert_eq!(body, json!({ "ok": false, "error": error }));
                assert_eq!(fixture.read("models.json"), VALID_DOC);
            }

            drop(client);
            stop.send(()).unwrap();
            server.await.unwrap().unwrap();
        });
    }

    #[test]
    fn malformed_json_is_rejected_with_400_and_never_writes() {
        let fixture = Fixture::new("malformed");
        fixture.write("models.json", VALID_DOC);
        run(async {
            let (address, stop, server) = start(fixture.0.clone()).await;
            let client = Client::new();
            let (status, _) = send(
                &client,
                address,
                Method::PUT,
                "/api/models",
                Some("{not json"),
            )
            .await;
            assert_eq!(status, 400);
            assert_eq!(fixture.read("models.json"), VALID_DOC);

            drop(client);
            stop.send(()).unwrap();
            server.await.unwrap().unwrap();
        });
    }

    #[test]
    fn restore_preserves_edits_and_is_idempotent() {
        let fixture = Fixture::new("restore");
        fixture.write(
            "models.json",
            r#"{"models":[{"id":"custom","group":"claude","label":"Mine","enabled":true},{"id":"opus","group":"claude","label":"My Opus","enabled":false}],"defaultModel":"custom","summariserModel":""}"#,
        );
        run(async {
            let (address, stop, server) = start(fixture.0.clone()).await;
            let client = Client::new();
            let (status, first) = send(
                &client,
                address,
                Method::POST,
                "/api/models/restore-defaults",
                Some("{}"),
            )
            .await;
            assert_eq!(status, 200);
            assert_eq!(first["ok"], true);
            let models = first["state"]["models"].as_array().unwrap();
            assert_eq!(models.len(), 23);
            assert_eq!(models[0]["id"], "custom");
            assert_eq!(models[0]["label"], "Mine");
            assert_eq!(models[1]["id"], "opus");
            assert_eq!(models[1]["label"], "My Opus");
            assert_eq!(models[1]["enabled"], false);

            let (status, second) = send(
                &client,
                address,
                Method::POST,
                "/api/models/restore-defaults",
                Some("{}"),
            )
            .await;
            assert_eq!(status, 200);
            assert_eq!(first, second);

            drop(client);
            stop.send(()).unwrap();
            server.await.unwrap().unwrap();
        });
    }

    #[test]
    fn persistence_failures_map_to_400_with_ok_false() {
        let fixture = Fixture::new("io");
        fs::create_dir_all(fixture.0.join("models.json")).unwrap();
        run(async {
            let (address, stop, server) = start(fixture.0.clone()).await;
            let client = Client::new();
            let (status, seed) = send(&client, address, Method::GET, "/api/models", None).await;
            assert_eq!(status, 200);
            assert_eq!(seed["models"].as_array().unwrap().len(), 22);

            let (status, body) = send(
                &client,
                address,
                Method::PUT,
                "/api/models",
                Some(VALID_DOC),
            )
            .await;
            assert_eq!(status, 400);
            assert_eq!(body["ok"], false);
            assert!(!body["error"].as_str().unwrap().is_empty());
            assert!(fixture.0.join("models.json").is_dir());

            drop(client);
            stop.send(()).unwrap();
            server.await.unwrap().unwrap();
        });
    }
}
