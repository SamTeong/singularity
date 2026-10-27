//! Native HTTP routes for the usage report: the status blob and the newest
//! self-contained report HTML, resolved from the injected `usage_report::Request`.
//! Refresh and write routes stay out of this slice; the body transport is separate.

use crate::usage_report::{self, Request};
use axum::extract::State;
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde_json::json;
use std::sync::Arc;
use tokio::task::spawn_blocking;

pub fn router(request: Arc<Request>) -> Router {
    Router::new()
        .route("/api/usagereport/status", get(status))
        .route("/api/usagereport/report", get(report))
        .with_state(request)
}

async fn status(State(request): State<Arc<Request>>) -> Response {
    match spawn_blocking(move || usage_report::status(&request)).await {
        Ok(status) => Json(status).into_response(),
        Err(_) => task_failed(),
    }
}

async fn report(State(request): State<Arc<Request>>) -> Response {
    match spawn_blocking(move || usage_report::read(&request)).await {
        Ok(report) => match report.html {
            Some(html) => {
                ([(header::CONTENT_TYPE, "text/html; charset=utf-8")], html).into_response()
            }
            None => no_report(),
        },
        Err(_) => task_failed(),
    }
}

fn no_report() -> Response {
    (
        StatusCode::NOT_FOUND,
        Json(json!({ "ok": false, "error": "no report" })),
    )
        .into_response()
}

fn task_failed() -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({ "ok": false, "error": "usage report task failed" })),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::{create_dir_all, remove_dir_all, write};
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};
    use tokio::sync::oneshot;

    static NEXT: AtomicU64 = AtomicU64::new(0);

    type Server = (
        String,
        oneshot::Sender<()>,
        tokio::task::JoinHandle<std::io::Result<()>>,
    );

    fn runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
    }

    fn temp_dir() -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "http-reports-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        create_dir_all(&path).unwrap();
        path
    }

    fn request(reports_dir: &Path) -> Arc<Request> {
        Arc::new(Request {
            reports_dir: reports_dir.to_string_lossy().into_owned(),
            env: json!({}),
        })
    }

    async fn start(request: Arc<Request>) -> Server {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (stop, stopped) = oneshot::channel::<()>();
        let server = tokio::spawn(async move {
            axum::serve(listener, router(request))
                .with_graceful_shutdown(async move {
                    let _ = stopped.await;
                })
                .await
        });
        (format!("http://{address}"), stop, server)
    }

    async fn shutdown(server: Server) {
        let (_, stop, handle) = server;
        stop.send(()).unwrap();
        handle.await.unwrap().unwrap();
    }

    #[test]
    fn missing_report_returns_absent_status_and_404_json() {
        runtime().block_on(async {
            let dir = temp_dir();
            let server = start(request(&dir)).await;
            let client = reqwest::Client::new();

            let status: serde_json::Value = client
                .get(format!("{}/api/usagereport/status", server.0))
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            assert_eq!(status, json!({ "exists": false, "at": null }));

            let response = client
                .get(format!("{}/api/usagereport/report", server.0))
                .send()
                .await
                .unwrap();
            assert_eq!(response.status().as_u16(), 404);
            assert_eq!(
                response.headers().get("content-type").unwrap(),
                "application/json"
            );
            let body: serde_json::Value = response.json().await.unwrap();
            assert_eq!(body, json!({ "ok": false, "error": "no report" }));

            shutdown(server).await;
            remove_dir_all(&dir).ok();
        });
    }

    #[test]
    fn newest_report_is_served_as_html_and_head_has_no_body() {
        runtime().block_on(async {
            let dir = temp_dir();
            write(dir.join("report-2026-01-01.html"), "<html>old</html>").unwrap();
            write(dir.join("report-2026-02-01.html"), "<html>new</html>").unwrap();
            write(dir.join("other.html"), "ignored").unwrap();
            let server = start(request(&dir)).await;
            let client = reqwest::Client::new();

            let status: serde_json::Value = client
                .get(format!("{}/api/usagereport/status", server.0))
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            assert_eq!(status["exists"], json!(true), "{status}");
            assert!(status["at"].as_f64().is_some(), "{status}");

            let response = client
                .get(format!("{}/api/usagereport/report", server.0))
                .send()
                .await
                .unwrap();
            assert_eq!(response.status().as_u16(), 200);
            assert_eq!(
                response.headers().get("content-type").unwrap(),
                "text/html; charset=utf-8"
            );
            assert_eq!(response.text().await.unwrap(), "<html>new</html>");

            let head = client
                .head(format!("{}/api/usagereport/report", server.0))
                .send()
                .await
                .unwrap();
            assert_eq!(head.status().as_u16(), 200);
            assert!(head.bytes().await.unwrap().is_empty());

            shutdown(server).await;
            remove_dir_all(&dir).ok();
        });
    }

    #[test]
    fn malformed_utf8_is_served_lossily_and_unreadable_newest_is_missing() {
        runtime().block_on(async {
            let lossy = temp_dir();
            write(lossy.join("report-a.html"), [b'<', 0xff, b'>']).unwrap();
            let server = start(request(&lossy)).await;
            let client = reqwest::Client::new();
            let response = client
                .get(format!("{}/api/usagereport/report", server.0))
                .send()
                .await
                .unwrap();
            assert_eq!(response.status().as_u16(), 200);
            assert_eq!(response.text().await.unwrap(), "<\u{FFFD}>");
            shutdown(server).await;
            remove_dir_all(&lossy).ok();

            // A directory named like a report is listed by status (metadata works)
            // but unreadable by read, so the HTTP route reports it as missing.
            let unreadable = temp_dir();
            create_dir_all(unreadable.join("report-a.html")).unwrap();
            let server = start(request(&unreadable)).await;
            let status: serde_json::Value = client
                .get(format!("{}/api/usagereport/status", server.0))
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            assert_eq!(status["exists"], json!(true), "{status}");
            let response = client
                .get(format!("{}/api/usagereport/report", server.0))
                .send()
                .await
                .unwrap();
            assert_eq!(response.status().as_u16(), 404);
            let body: serde_json::Value = response.json().await.unwrap();
            assert_eq!(body, json!({ "ok": false, "error": "no report" }));
            shutdown(server).await;
            remove_dir_all(&unreadable).ok();
        });
    }

    #[test]
    fn injected_reports_dir_overrides_env_reports_dir() {
        runtime().block_on(async {
            let injected = temp_dir();
            let env_dir = temp_dir();
            write(injected.join("report-a.html"), "injected").unwrap();
            write(env_dir.join("report-b.html"), "env").unwrap();
            let request = Arc::new(Request {
                reports_dir: injected.to_string_lossy().into_owned(),
                env: json!({ "SING_USAGE_REPORTS": env_dir.to_string_lossy() }),
            });
            let server = start(request).await;
            let client = reqwest::Client::new();
            let response = client
                .get(format!("{}/api/usagereport/report", server.0))
                .send()
                .await
                .unwrap();
            assert_eq!(response.status().as_u16(), 200);
            assert_eq!(response.text().await.unwrap(), "injected");
            shutdown(server).await;
            remove_dir_all(&injected).ok();
            remove_dir_all(&env_dir).ok();
        });
    }
}
