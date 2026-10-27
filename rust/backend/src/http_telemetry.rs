use crate::http_policy::query_values;
use crate::status::StatusService;
use crate::sysstats::{Sampler, SysStats};
use axum::extract::{RawQuery, State};
use axum::routing::get;
use axum::{Json, Router};
use serde_json::{Value, json};
use std::process;
use std::sync::Arc;

#[derive(Clone)]
struct Telemetry {
    sampler: Arc<Sampler>,
    status: StatusService,
}

pub fn router(sampler: Arc<Sampler>, status: StatusService) -> Router {
    Router::new()
        .route("/api/health", get(health))
        .route("/api/sysstats", get(sysstats))
        .route("/api/status", get(status_get))
        .with_state(Telemetry { sampler, status })
}

async fn health() -> Json<Value> {
    // clients stays 0 until the native server owns the websocket.
    Json(json!({ "ok": true, "pid": process::id(), "clients": 0 }))
}

async fn sysstats(State(telemetry): State<Telemetry>) -> Json<SysStats> {
    Json(telemetry.sampler.snapshot())
}

async fn status_get(State(telemetry): State<Telemetry>, RawQuery(query): RawQuery) -> Json<Value> {
    let force = force_requested(query.as_deref());
    Json(telemetry.status.get_status(force).await)
}

// Fastify compares req.query.force to '1', so a repeated parameter becomes an
// array and never matches; query_values already form-decodes keys and values.
fn force_requested(query: Option<&str>) -> bool {
    let Some(query) = query else {
        return false;
    };
    let values = query_values(query, "force");
    matches!(values.as_slice(), [value] if value.as_str() == "1")
}

#[cfg(test)]
mod tests {
    use super::{force_requested, router};
    use crate::status::StatusService;
    use crate::sysstats::Sampler;
    use axum::http::StatusCode;
    use axum::http::header::{ALLOW, CONTENT_TYPE};
    use serde_json::{Value, json};
    use std::sync::Arc;
    use tokio::sync::oneshot;

    struct Fixture {
        base: String,
        stop: Option<oneshot::Sender<()>>,
        server: tokio::task::JoinHandle<std::io::Result<()>>,
        client: reqwest::Client,
    }

    impl Fixture {
        async fn start() -> Self {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            assert!(address.ip().is_loopback());
            let (stop, stopped) = oneshot::channel::<()>();
            let app = router(Arc::new(Sampler::start()), StatusService::new());
            let server = tokio::spawn(async move {
                axum::serve(listener, app)
                    .with_graceful_shutdown(async move {
                        let _ = stopped.await;
                    })
                    .await
            });
            Self {
                base: format!("http://{address}"),
                stop: Some(stop),
                server,
                client: reqwest::Client::builder().build().unwrap(),
            }
        }

        async fn finish(mut self) {
            // Drop the pooled keep-alive connection so graceful shutdown can settle.
            drop(self.client);
            self.stop.take().unwrap().send(()).unwrap();
            self.server.await.unwrap().unwrap();
        }
    }

    fn runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
    }

    #[test]
    fn health_envelope_head_and_method_parity_on_ephemeral_loopback() {
        runtime().block_on(async {
            let fixture = Fixture::start().await;

            let response = fixture
                .client
                .get(format!("{}/api/health", fixture.base))
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(
                response.headers()[CONTENT_TYPE],
                "application/json",
                "health content type"
            );
            let body: Value = response.json().await.unwrap();
            assert_eq!(
                body,
                json!({ "ok": true, "pid": std::process::id(), "clients": 0 })
            );
            assert_eq!(
                body.as_object()
                    .unwrap()
                    .keys()
                    .map(String::as_str)
                    .collect::<Vec<_>>(),
                ["ok", "pid", "clients"],
                "health key order"
            );

            let head = fixture
                .client
                .head(format!("{}/api/health", fixture.base))
                .send()
                .await
                .unwrap();
            assert_eq!(head.status(), StatusCode::OK);
            assert!(head.bytes().await.unwrap().is_empty(), "HEAD has no body");

            let post = fixture
                .client
                .post(format!("{}/api/health", fixture.base))
                .send()
                .await
                .unwrap();
            assert_eq!(post.status(), StatusCode::METHOD_NOT_ALLOWED);
            assert_eq!(post.headers()[ALLOW], "GET,HEAD");

            // 405 short-circuits before the handler, so no status provider is contacted.
            let status_post = fixture
                .client
                .post(format!("{}/api/status", fixture.base))
                .send()
                .await
                .unwrap();
            assert_eq!(status_post.status(), StatusCode::METHOD_NOT_ALLOWED);

            fixture.finish().await;
        });
    }

    #[test]
    fn sysstats_envelope_matches_sampler_snapshot_on_ephemeral_loopback() {
        runtime().block_on(async {
            let fixture = Fixture::start().await;

            let body: Value = fixture
                .client
                .get(format!("{}/api/sysstats", fixture.base))
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            let object = body.as_object().unwrap();
            assert_eq!(
                object.keys().map(String::as_str).collect::<Vec<_>>(),
                ["cpu", "mem", "history"],
                "sysstats key order"
            );
            assert!(
                body["cpu"].is_null() || body["cpu"].as_u64().is_some_and(|cpu| cpu <= 100),
                "cpu reading: {}",
                body["cpu"]
            );
            assert_eq!(
                body["mem"]
                    .as_object()
                    .unwrap()
                    .keys()
                    .map(String::as_str)
                    .collect::<Vec<_>>(),
                ["total", "used", "pct"],
                "memory key order"
            );
            let total = body["mem"]["total"].as_u64().unwrap();
            assert!(total > 0, "total memory: {total}");
            assert!(body["mem"]["used"].as_u64().unwrap() <= total);
            assert!(body["mem"]["pct"].as_u64().unwrap() <= 100);
            assert_eq!(body["history"]["stepMs"], 2000);
            assert_eq!(
                body["history"]["cpu"].as_array().unwrap().len(),
                body["history"]["mem"].as_array().unwrap().len()
            );

            fixture.finish().await;
        });
    }

    #[test]
    fn force_query_requires_exactly_one_decoded_value_of_one() {
        assert!(force_requested(Some("force=1")));
        assert!(force_requested(Some("other=0&force=1")));
        assert!(force_requested(Some("force=%31")));
        assert!(force_requested(Some("%66orce=1")));

        assert!(!force_requested(None));
        assert!(!force_requested(Some("")));
        assert!(!force_requested(Some("force=0")));
        assert!(!force_requested(Some("force=")));
        assert!(!force_requested(Some("force")));
        assert!(!force_requested(Some("other=1")));
        assert!(!force_requested(Some("force=1&force=1")));
        assert!(!force_requested(Some("force=1&force=0")));
        assert!(!force_requested(Some("force=1&force=%31")));
    }
}
