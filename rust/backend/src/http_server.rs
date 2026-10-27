use crate::http_policy::HttpPolicy;
use axum::body::{Body, Bytes, to_bytes};
use axum::extract::State;
use axum::http::{HeaderValue, Request, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::{Json, Router};
use serde_json::json;
use std::future::Future;
use std::io;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use tokio::net::TcpListener;

pub fn router(policy: HttpPolicy) -> Router {
    Router::new()
        .fallback(not_found)
        .layer(middleware::from_fn_with_state(
            policy,
            enforce_transport_policy,
        ))
}

pub async fn bind(port: u16) -> io::Result<TcpListener> {
    TcpListener::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port)).await
}

pub async fn serve<F>(listener: TcpListener, policy: HttpPolicy, shutdown: F) -> io::Result<()>
where
    F: Future<Output = ()> + Send + 'static,
{
    axum::serve(listener, router(policy))
        .with_graceful_shutdown(shutdown)
        .await
}

pub async fn collect_raw_body(body: Body, limit: usize) -> Result<Bytes, axum::Error> {
    to_bytes(body, limit).await
}

pub fn run_from_env() -> io::Result<()> {
    let policy = HttpPolicy::from_env()
        .map_err(|message| io::Error::new(io::ErrorKind::InvalidInput, message))?;
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    runtime.block_on(async move {
        let listener = bind(policy.daemon_port).await?;
        eprintln!("native HTTP listener bound to {}", listener.local_addr()?);
        serve(listener, policy, shutdown_signal()).await
    })
}

async fn enforce_transport_policy(
    State(policy): State<HttpPolicy>,
    request: Request<Body>,
    next: Next,
) -> Response {
    if let Err(error) = policy.request_allowed(request.headers()) {
        return (StatusCode::FORBIDDEN, Json(json!({ "error": error }))).into_response();
    }

    let path = request.uri().path();
    let method = request.method();
    let is_api = path == "/api" || path.starts_with("/api/");
    let api_exempt = matches!(path, "/api/health" | "/api/capabilities");
    let open_asset = path == "/assets" || path.starts_with("/assets/");
    if is_api && !api_exempt && !open_asset {
        match policy.api_authenticated(request.headers(), request.uri().query()) {
            Ok(true) => {}
            Ok(false) => return api_unauthorized_response(),
            Err(_) => return cookie_decode_error_response(),
        }
    }

    if policy.is_shell_request(
        method,
        path,
        request
            .headers()
            .get(header::ACCEPT)
            .and_then(|v| v.to_str().ok()),
    ) && policy.token.is_some()
    {
        if let Some(token) = policy.shell_token_query(request.uri().query()) {
            let location = policy.shell_redirect_location(path, request.uri().query());
            let mut response = StatusCode::FOUND.into_response();
            if let Ok(value) = HeaderValue::try_from(location) {
                response.headers_mut().insert(header::LOCATION, value);
            }
            if let Ok(value) = HeaderValue::try_from(shell_token_cookie(&token)) {
                response.headers_mut().insert(header::SET_COOKIE, value);
            }
            return response;
        }
        match policy.shell_authenticated(request.headers()) {
            Ok(true) => {}
            Ok(false) => return shell_unauthorized_response(),
            Err(_) => return cookie_decode_error_response(),
        }
    }

    next.run(request).await
}

async fn not_found() -> Response {
    (StatusCode::NOT_FOUND, Json(json!({ "error": "not found" }))).into_response()
}

fn api_unauthorized_response() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        Json(json!({ "error": "unauthorized" })),
    )
        .into_response()
}

fn cookie_decode_error_response() -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({
            "statusCode": 500,
            "error": "Internal Server Error",
            "message": "URI malformed"
        })),
    )
        .into_response()
}

fn shell_unauthorized_response() -> Response {
    let mut response = (
        StatusCode::UNAUTHORIZED,
        "Unauthorized — open this URL with ?token=<your SING_TOKEN>",
    )
        .into_response();
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/plain; charset=utf-8"),
    );
    response
}

#[cfg(test)]
mod tests {
    use super::{
        api_unauthorized_response, bind, cookie_decode_error_response, router, serve,
        shell_token_cookie, shell_unauthorized_response,
    };
    use crate::http_policy::HttpPolicy;
    use axum::body::to_bytes;
    use axum::http::StatusCode;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::sync::oneshot;

    #[test]
    fn http_listener_lifecycle_uses_ephemeral_loopback_and_injected_shutdown() {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                let listener = bind(0).await.unwrap();
                let address = listener.local_addr().unwrap();
                assert!(address.ip().is_loopback());
                let (stop, stopped) = oneshot::channel::<()>();
                let server = tokio::spawn(serve(
                    listener,
                    HttpPolicy {
                        daemon_port: address.port(),
                        vite_port: 5317,
                        token: None,
                    },
                    async move {
                        let _ = stopped.await;
                    },
                ));

                let mut connection = tokio::net::TcpStream::connect(address).await.unwrap();
                connection
                    .write_all(
                        format!(
                            "GET /lifecycle HTTP/1.1\r\nHost: localhost:{}\r\nConnection: close\r\n\r\n",
                            address.port()
                        )
                        .as_bytes(),
                    )
                    .await
                    .unwrap();
                let mut response = Vec::new();
                connection.read_to_end(&mut response).await.unwrap();
                let response = String::from_utf8(response).unwrap();
                assert!(response.starts_with("HTTP/1.1 404"), "{response}");
                assert!(response.contains("{\"error\":\"not found\"}"), "{response}");

                stop.send(()).unwrap();
                server.await.unwrap().unwrap();
                assert!(tokio::net::TcpStream::connect(address).await.is_err());
            });
    }

    #[test]
    fn http_configured_token_middleware_authenticates_on_ephemeral_loopback() {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                let listener = bind(0).await.unwrap();
                let address = listener.local_addr().unwrap();
                let (stop, stopped) = oneshot::channel::<()>();
                let server = tokio::spawn(async move {
                    axum::serve(
                        listener,
                        router(HttpPolicy {
                            daemon_port: address.port(),
                            vite_port: 5317,
                            token: Some("token_1".to_owned()),
                        }),
                    )
                    .with_graceful_shutdown(async move {
                        let _ = stopped.await;
                    })
                    .await
                });

                let api = send_request(
                    address,
                    &format!(
                        "GET /api/private HTTP/1.1\r\nHost: localhost:{}\r\nConnection: close\r\n\r\n",
                        address.port()
                    ),
                )
                .await;
                assert!(api.starts_with("HTTP/1.1 401"), "{api}");

                let evil_host = send_request(
                    address,
                    &format!(
                        "GET /api/private HTTP/1.1\r\nHost: evil.test:{}\r\nConnection: close\r\n\r\n",
                        address.port()
                    ),
                )
                .await;
                assert!(evil_host.starts_with("HTTP/1.1 403"), "{evil_host}");

                let query_token = send_request(
                    address,
                    &format!(
                        "GET /?keep=yes&token=token_1 HTTP/1.1\r\nHost: localhost:{}\r\nAccept: text/html\r\nConnection: close\r\n\r\n",
                        address.port()
                    ),
                )
                .await;
                assert!(query_token.starts_with("HTTP/1.1 302"), "{query_token}");
                let location = query_token
                    .lines()
                    .find(|line| line.to_ascii_lowercase().starts_with("location:"))
                    .unwrap();
                assert_eq!(location.to_ascii_lowercase(), "location: /?keep=yes");
                assert!(!location.contains("token_1"));
                assert!(query_token.to_ascii_lowercase().contains(
                    "set-cookie: sing_token=token_1; httponly; samesite=strict; path=/"
                ));

                let cookie_shell = send_request(
                    address,
                    &format!(
                        "GET /deep HTTP/1.1\r\nHost: localhost:{}\r\nAccept: text/html\r\nCookie: sing_token=token_1\r\nConnection: close\r\n\r\n",
                        address.port()
                    ),
                )
                .await;
                assert!(cookie_shell.starts_with("HTTP/1.1 404"), "{cookie_shell}");

                stop.send(()).unwrap();
                server.await.unwrap().unwrap();
            });
    }

    async fn send_request(address: std::net::SocketAddr, request: &str) -> String {
        let mut connection = tokio::net::TcpStream::connect(address).await.unwrap();
        connection.write_all(request.as_bytes()).await.unwrap();
        let mut response = Vec::new();
        connection.read_to_end(&mut response).await.unwrap();
        String::from_utf8(response).unwrap()
    }

    #[test]
    fn http_unauthorized_responses_match_shared_legacy_fixture() {
        let fixtures: serde_json::Value =
            serde_json::from_str(include_str!("../tests/fixtures/http-policy.json")).unwrap();
        assert_eq!(
            shell_token_cookie("token_1"),
            fixtures["responses"]["shell_cookie"].as_str().unwrap()
        );
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                let shell = shell_unauthorized_response();
                assert_eq!(shell.status(), StatusCode::UNAUTHORIZED);
                assert_eq!(
                    shell.headers()[axum::http::header::CONTENT_TYPE],
                    "text/plain; charset=utf-8"
                );
                let shell_body = to_bytes(shell.into_body(), usize::MAX).await.unwrap();
                assert_eq!(
                    std::str::from_utf8(&shell_body).unwrap(),
                    fixtures["responses"]["shell_unauthorized"]
                        .as_str()
                        .unwrap()
                );

                let api = api_unauthorized_response();
                assert_eq!(
                    api.status().as_u16(),
                    fixtures["responses"]["api_unauthorized"]["status"]
                        .as_u64()
                        .unwrap() as u16
                );
                let api_body = to_bytes(api.into_body(), usize::MAX).await.unwrap();
                assert_eq!(
                    serde_json::from_slice::<serde_json::Value>(&api_body).unwrap(),
                    fixtures["responses"]["api_unauthorized"]["body"]
                );
            });
    }

    #[test]
    fn http_malformed_cookie_response_matches_legacy_uri_error_shape() {
        let response = cookie_decode_error_response();
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
        let fixtures: serde_json::Value =
            serde_json::from_str(include_str!("../tests/fixtures/http-policy.json")).unwrap();
        let expected = &fixtures["cookie_policy"]["error_response"];
        assert_eq!(
            response.status().as_u16(),
            expected["status"].as_u64().unwrap() as u16
        );
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
                assert_eq!(
                    serde_json::from_slice::<serde_json::Value>(&body).unwrap(),
                    expected["body"]
                );
            });
    }
}

fn shell_token_cookie(token: &str) -> String {
    format!("sing_token={token}; HttpOnly; SameSite=Strict; Path=/")
}

#[cfg(unix)]
async fn shutdown_signal() {
    use tokio::signal::unix::{SignalKind, signal};

    let Ok(mut terminate) = signal(SignalKind::terminate()) else {
        let _ = tokio::signal::ctrl_c().await;
        return;
    };
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {},
        _ = terminate.recv() => {},
    }
}

#[cfg(not(unix))]
async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
}
