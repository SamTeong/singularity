use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde_json::{Value, json};
use std::path::PathBuf;

#[derive(Clone)]
struct AppState {
    state_dir: PathBuf,
}

pub fn router(state_dir: PathBuf) -> Router {
    Router::new()
        .route("/api/keys", get(get_keys))
        .route("/api/config/state", get(get_config_state))
        .with_state(AppState { state_dir })
}

async fn get_keys(State(state): State<AppState>) -> Response {
    match load(state.state_dir.join("keys.json"), crate::keys::get).await {
        Ok(keys) => Json(json!({ "keys": keys })).into_response(),
        Err(()) => internal_error(),
    }
}

async fn get_config_state(State(state): State<AppState>) -> Response {
    match load(
        state.state_dir.join("config-state.json"),
        crate::config_state::get,
    )
    .await
    {
        Ok(value) => Json(json!({ "state": value })).into_response(),
        Err(()) => internal_error(),
    }
}

async fn load<F>(path: PathBuf, read: F) -> Result<Value, ()>
where
    F: FnOnce(&str) -> Value + Send + 'static,
{
    tokio::task::spawn_blocking(move || {
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

    fn defaults() -> Value {
        json!({ "tabs": [], "active": null, "autosave": false, "expanded": [] })
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
