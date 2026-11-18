use axum::body::Body;
use axum::extract::State;
use axum::http::{Request, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
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
        .route("/api/keys", get(get_keys).put(put_keys))
        .route(
            "/api/config/state",
            get(get_config_state).put(put_config_state),
        )
        .with_state(AppState {
            state_dir,
            lock: Arc::new(Mutex::new(())),
        })
}

async fn get_keys(State(state): State<AppState>) -> Response {
    match load(
        state.state_dir.join("keys.json"),
        crate::keys::get,
        state.lock,
    )
    .await
    {
        Ok(keys) => Json(json!({ "keys": keys })).into_response(),
        Err(()) => internal_error(),
    }
}

async fn get_config_state(State(state): State<AppState>) -> Response {
    match load(
        state.state_dir.join("config-state.json"),
        crate::config_state::get,
        state.lock,
    )
    .await
    {
        Ok(value) => Json(json!({ "state": value })).into_response(),
        Err(()) => internal_error(),
    }
}

async fn put_keys(State(state): State<AppState>, request: Request<Body>) -> Response {
    let patch = match crate::http_body::parse(request).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    write(
        state.state_dir.join("keys.json"),
        crate::keys::set,
        patch,
        state.lock,
    )
    .await
}

async fn put_config_state(State(state): State<AppState>, request: Request<Body>) -> Response {
    let patch = match crate::http_body::parse(request).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    write(
        state.state_dir.join("config-state.json"),
        crate::config_state::set,
        patch,
        state.lock,
    )
    .await
}

async fn write<F>(path: PathBuf, set: F, patch: Value, lock: Arc<Mutex<()>>) -> Response
where
    F: FnOnce(&str, &Value) -> Value + Send + 'static,
{
    let result = tokio::task::spawn_blocking(move || {
        let _guard = lock.lock().unwrap_or_else(|error| error.into_inner());
        let path = path.to_string_lossy();
        set(&path, &patch)
    })
    .await;
    match result {
        Ok(value) => Json(value).into_response(),
        Err(_) => internal_error(),
    }
}

async fn load<F>(path: PathBuf, read: F, lock: Arc<Mutex<()>>) -> Result<Value, ()>
where
    F: FnOnce(&str) -> Value + Send + 'static,
{
    tokio::task::spawn_blocking(move || {
        let _guard = lock.lock().unwrap_or_else(|error| error.into_inner());
        let path = path.to_string_lossy();
        read(&path)
    })
    .await
    .map_err(|_| ())
}

fn internal_error() -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({ "error": "internal server error" })),
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
                "singularity-http-state-{name}-{}-{nanos}",
                std::process::id()
            ));
            fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }

        fn write(&self, file: &str, contents: &str) {
            fs::write(self.0.join(file), contents).unwrap();
        }

        fn mkdir(&self, file: &str) {
            fs::create_dir_all(self.0.join(file)).unwrap();
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

    async fn get_json(address: SocketAddr, path: &str) -> (u16, Value) {
        let response = reqwest::get(format!("http://{address}{path}"))
            .await
            .unwrap();
        let status = response.status().as_u16();
        let body = response.text().await.unwrap();
        (status, serde_json::from_str(&body).unwrap())
    }

    async fn put_json(address: SocketAddr, path: &str, body: &Value) -> (u16, Value) {
        let response = reqwest::Client::new()
            .put(format!("http://{address}{path}"))
            .json(body)
            .send()
            .await
            .unwrap();
        let status = response.status().as_u16();
        let text = response.text().await.unwrap();
        (status, serde_json::from_str(&text).unwrap())
    }

    async fn put_raw(address: SocketAddr, path: &str, body: &str) -> u16 {
        reqwest::Client::new()
            .put(format!("http://{address}{path}"))
            .body(body.to_owned())
            .send()
            .await
            .unwrap()
            .status()
            .as_u16()
    }

    fn defaults() -> Value {
        json!({ "tabs": [], "active": null, "autosave": false, "expanded": [] })
    }

    #[test]
    fn concurrent_partial_key_writes_are_preserved() {
        let fixture = Fixture::new("concurrent");
        run(async {
            let (address, stop, server) = start(fixture.0.clone()).await;
            let mut tasks = Vec::new();
            for i in 0..20 {
                tasks.push(tokio::spawn(async move {
                    put_json(
                        address,
                        "/api/keys",
                        &json!({(format!("action{i}")): {"key": "a"}}),
                    )
                    .await
                }));
            }
            for task in tasks {
                assert_eq!(task.await.unwrap().0, 200);
            }
            let (_, body) = get_json(address, "/api/keys").await;
            assert_eq!(body["keys"].as_object().unwrap().len(), 20);
            stop.send(()).unwrap();
            server.await.unwrap().unwrap();
        });
    }

    #[test]
    fn missing_state_files_serve_exact_service_defaults() {
        let fixture = Fixture::new("missing");
        run(async {
            let (address, stop, server) = start(fixture.0.clone()).await;
            assert_eq!(
                get_json(address, "/api/keys").await,
                (200, json!({ "keys": {} }))
            );
            assert_eq!(
                get_json(address, "/api/config/state").await,
                (200, json!({ "state": defaults() }))
            );
            stop.send(()).unwrap();
            server.await.unwrap().unwrap();
        });
    }

    #[test]
    fn customized_state_files_are_wrapped_exactly() {
        let fixture = Fixture::new("custom");
        fixture.write(
            "keys.json",
            r#"{"open":{"key":"o","ctrl":true},"quit":{"doubleTap":"q"}}"#,
        );
        fixture.write(
            "config-state.json",
            r#"{"tabs":[{"cwd":"/repo","tool":"claude","scope":"project","path":"/repo/.claude/settings.json"}],"active":"tab-1","autosave":true,"expanded":["/repo"]}"#,
        );
        run(async {
            let (address, stop, server) = start(fixture.0.clone()).await;
            assert_eq!(
                get_json(address, "/api/keys").await,
                (
                    200,
                    json!({ "keys": {
                        "open": { "key": "o", "ctrl": true },
                        "quit": { "doubleTap": "q" }
                    }})
                )
            );
            assert_eq!(
                get_json(address, "/api/config/state").await,
                (
                    200,
                    json!({ "state": {
                        "tabs": [{"cwd":"/repo","tool":"claude","scope":"project","path":"/repo/.claude/settings.json"}],
                        "active": "tab-1",
                        "autosave": true,
                        "expanded": ["/repo"]
                    }})
                )
            );
            stop.send(()).unwrap();
            server.await.unwrap().unwrap();
        });
    }

    #[test]
    fn malformed_state_files_use_existing_service_fallbacks() {
        let fixture = Fixture::new("malformed");
        fixture.write("keys.json", "{not json");
        fixture.write("config-state.json", "[1,2]");
        run(async {
            let (address, stop, server) = start(fixture.0.clone()).await;
            assert_eq!(
                get_json(address, "/api/keys").await,
                (200, json!({ "keys": {} }))
            );
            assert_eq!(
                get_json(address, "/api/config/state").await,
                (200, json!({ "state": defaults() }))
            );
            stop.send(()).unwrap();
            server.await.unwrap().unwrap();
        });
    }

    #[test]
    fn distinct_injected_roots_do_not_leak_state() {
        let left = Fixture::new("left");
        let right = Fixture::new("right");
        left.write("keys.json", r#"{"left":{"key":"l"}}"#);
        right.write("keys.json", r#"{"right":{"key":"r"}}"#);
        right.write(
            "config-state.json",
            r#"{"active":"right-tab","autosave":true,"expanded":["/right"]}"#,
        );
        run(async {
            let (left_address, left_stop, left_server) = start(left.0.clone()).await;
            let (right_address, right_stop, right_server) = start(right.0.clone()).await;
            assert_eq!(
                get_json(left_address, "/api/keys").await,
                (200, json!({ "keys": { "left": { "key": "l" } } }))
            );
            assert_eq!(
                get_json(right_address, "/api/keys").await,
                (200, json!({ "keys": { "right": { "key": "r" } } }))
            );
            assert_eq!(
                get_json(left_address, "/api/config/state").await,
                (200, json!({ "state": defaults() }))
            );
            assert_eq!(
                get_json(right_address, "/api/config/state").await,
                (
                    200,
                    json!({ "state": {
                        "tabs": [],
                        "active": "right-tab",
                        "autosave": true,
                        "expanded": ["/right"]
                    }})
                )
            );
            left_stop.send(()).unwrap();
            right_stop.send(()).unwrap();
            left_server.await.unwrap().unwrap();
            right_server.await.unwrap().unwrap();
        });
    }

    #[test]
    fn puts_sanitize_delete_and_patch_then_reads_match() {
        let fixture = Fixture::new("puts");
        run(async {
            let (address, stop, server) = start(fixture.0.clone()).await;
            assert_eq!(
                put_json(
                    address,
                    "/api/keys",
                    &json!({
                        "open": { "key": "o", "ctrl": true, "junk": 1 },
                        "quit": { "doubleTap": "q" },
                        "gone": { "key": "g" }
                    })
                )
                .await,
                (
                    200,
                    json!({ "ok": true, "keys": {
                        "open": { "key": "o", "ctrl": true },
                        "quit": { "doubleTap": "q" },
                        "gone": { "key": "g" }
                    }})
                )
            );
            assert_eq!(
                get_json(address, "/api/keys").await,
                (
                    200,
                    json!({ "keys": {
                        "open": { "key": "o", "ctrl": true },
                        "quit": { "doubleTap": "q" },
                        "gone": { "key": "g" }
                    }})
                )
            );
            assert_eq!(
                put_json(address, "/api/keys", &json!({ "gone": null })).await,
                (
                    200,
                    json!({ "ok": true, "keys": {
                        "open": { "key": "o", "ctrl": true },
                        "quit": { "doubleTap": "q" }
                    }})
                )
            );
            assert_eq!(
                put_json(
                    address,
                    "/api/config/state",
                    &json!({ "active": "tab-1", "autosave": true })
                )
                .await,
                (
                    200,
                    json!({ "ok": true, "state": {
                        "tabs": [],
                        "active": "tab-1",
                        "autosave": true,
                        "expanded": []
                    }})
                )
            );
            assert_eq!(
                get_json(address, "/api/config/state").await,
                (
                    200,
                    json!({ "state": {
                        "tabs": [],
                        "active": "tab-1",
                        "autosave": true,
                        "expanded": []
                    }})
                )
            );
            stop.send(()).unwrap();
            server.await.unwrap().unwrap();
        });
    }

    #[test]
    fn parser_errors_leave_storage_unchanged() {
        let fixture = Fixture::new("parse-error");
        fixture.write("keys.json", r#"{"open":{"key":"o"}}"#);
        fixture.write("config-state.json", r#"{"active":"keep"}"#);
        run(async {
            let (address, stop, server) = start(fixture.0.clone()).await;
            assert!(put_raw(address, "/api/keys", "{not json").await >= 400);
            assert!(put_raw(address, "/api/config/state", "{not json").await >= 400);
            assert_eq!(
                get_json(address, "/api/keys").await,
                (200, json!({ "keys": { "open": { "key": "o" } } }))
            );
            assert_eq!(
                get_json(address, "/api/config/state").await,
                (
                    200,
                    json!({ "state": {
                        "tabs": [],
                        "active": "keep",
                        "autosave": false,
                        "expanded": []
                    }})
                )
            );
            stop.send(()).unwrap();
            server.await.unwrap().unwrap();
        });
    }

    #[test]
    fn write_failures_return_ok_false_at_http_200() {
        let fixture = Fixture::new("io-error");
        fixture.mkdir("keys.json");
        fixture.mkdir("config-state.json");
        run(async {
            let (address, stop, server) = start(fixture.0.clone()).await;
            let (status, body) = put_json(address, "/api/keys", &json!({ "a": null })).await;
            assert_eq!(status, 200);
            assert_eq!(body["ok"], false);
            assert!(body["error"].is_string());
            let (status, body) =
                put_json(address, "/api/config/state", &json!({ "autosave": true })).await;
            assert_eq!(status, 200);
            assert_eq!(body["ok"], false);
            assert!(body["error"].is_string());
            stop.send(()).unwrap();
            server.await.unwrap().unwrap();
        });
    }

    #[test]
    fn distinct_roots_isolate_writes() {
        let left = Fixture::new("put-left");
        let right = Fixture::new("put-right");
        run(async {
            let (left_address, left_stop, left_server) = start(left.0.clone()).await;
            let (right_address, right_stop, right_server) = start(right.0.clone()).await;
            put_json(
                left_address,
                "/api/keys",
                &json!({ "left": { "key": "l" } }),
            )
            .await;
            put_json(
                left_address,
                "/api/config/state",
                &json!({ "active": "left-tab" }),
            )
            .await;
            assert_eq!(
                get_json(right_address, "/api/keys").await,
                (200, json!({ "keys": {} }))
            );
            assert_eq!(
                get_json(right_address, "/api/config/state").await,
                (200, json!({ "state": defaults() }))
            );
            assert_eq!(
                get_json(left_address, "/api/keys").await,
                (200, json!({ "keys": { "left": { "key": "l" } } }))
            );
            left_stop.send(()).unwrap();
            right_stop.send(()).unwrap();
            left_server.await.unwrap().unwrap();
            right_server.await.unwrap().unwrap();
        });
    }

    #[test]
    fn null_and_plain_bodies_are_accepted_noops() {
        let fixture = Fixture::new("noop");
        run(async {
            let (address, stop, server) = start(fixture.0.clone()).await;
            assert_eq!(
                put_json(address, "/api/keys", &Value::Null).await,
                (200, json!({ "ok": true, "keys": {} }))
            );
            assert_eq!(
                put_json(address, "/api/keys", &json!("text")).await,
                (200, json!({ "ok": true, "keys": {} }))
            );
            assert_eq!(
                put_json(address, "/api/config/state", &Value::Null).await,
                (200, json!({ "ok": true, "state": defaults() }))
            );
            assert_eq!(
                put_json(address, "/api/config/state", &json!(5)).await,
                (200, json!({ "ok": true, "state": defaults() }))
            );
            stop.send(()).unwrap();
            server.await.unwrap().unwrap();
        });
    }

    #[test]
    fn head_requests_are_served_without_a_body() {
        let fixture = Fixture::new("head");
        run(async {
            let (address, stop, server) = start(fixture.0.clone()).await;
            let response = reqwest::Client::new()
                .head(format!("http://{address}/api/keys"))
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), 200);
            assert!(response.bytes().await.unwrap().is_empty());
            stop.send(()).unwrap();
            server.await.unwrap().unwrap();
        });
    }
}
