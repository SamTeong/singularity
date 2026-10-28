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
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tokio::net::TcpListener;

#[derive(Clone)]
pub struct HttpServices {
    pub state_dir: PathBuf,
    pub plans_root: Option<PathBuf>,
    pub report_request: Arc<crate::usage_report::Request>,
    pub sampler: Arc<crate::sysstats::Sampler>,
    pub status: crate::status::StatusService,
    pub memory: Option<crate::http_memory_root::MemoryServices>,
    pub config: Option<ConfigServices>,
}

/// Host paths the Claude and Codex config editor routes share.
#[derive(Clone)]
pub struct ConfigServices {
    pub home: PathBuf,
    pub codex_home: PathBuf,
    pub state_dir: PathBuf,
    pub backups_dir: PathBuf,
    pub cwd: PathBuf,
    pub drive_cwds: Vec<(u16, PathBuf)>,
}

impl ConfigServices {
    fn from_env(state_dir: PathBuf, backups_dir: PathBuf) -> io::Result<Self> {
        let home = crate::memory_root::current_node_home()?;
        // `process.env.CODEX_HOME || join(homedir(), '.codex')`
        let codex_home = std::env::var_os("CODEX_HOME")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".codex"));
        Ok(Self {
            home,
            codex_home,
            state_dir,
            backups_dir,
            cwd: std::env::current_dir()?,
            drive_cwds: crate::wiki_root::current_drive_cwds(),
        })
    }

    fn router(self) -> Router {
        // One lock for both roots files, so reads and writes cannot interleave.
        let lock = Arc::new(Mutex::new(()));
        let Self {
            home,
            codex_home,
            state_dir,
            backups_dir,
            cwd,
            drive_cwds,
        } = self;
        Router::new()
            .merge(crate::http_config_roots::router(
                state_dir.clone(),
                lock.clone(),
            ))
            .merge(crate::http_config_scan::router())
            .merge(crate::http_claude_theme::router(home.clone()))
            .merge(crate::http_claude_config_read::router(home.clone()))
            .merge(crate::http_claude_config_search::router(home.clone()))
            .merge(crate::http_claude_config_write::router(
                home.clone(),
                state_dir.clone(),
                backups_dir.clone(),
                lock.clone(),
                cwd.clone(),
                drive_cwds.clone(),
            ))
            .merge(crate::http_codex_config_read::router(
                home.clone(),
                codex_home.clone(),
                state_dir.clone(),
                lock.clone(),
                cwd.clone(),
                drive_cwds.clone(),
            ))
            .merge(crate::http_codex_config_search::router(
                home.clone(),
                codex_home.clone(),
                state_dir.clone(),
                lock.clone(),
                cwd.clone(),
                drive_cwds.clone(),
            ))
            .merge(crate::http_codex_config_write::router(
                home,
                codex_home,
                state_dir,
                backups_dir,
                lock,
                cwd,
                drive_cwds,
            ))
    }
}

impl HttpServices {
    pub fn new(state_dir: PathBuf, report_request: crate::usage_report::Request) -> Self {
        Self {
            state_dir,
            plans_root: None,
            report_request: Arc::new(report_request),
            sampler: Arc::new(crate::sysstats::Sampler::start()),
            status: crate::status::StatusService::new(),
            memory: None,
            config: None,
        }
    }

    fn from_env() -> io::Result<Self> {
        let home = std::env::var("SINGULARITY_HOME")
            .ok()
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                io::Error::new(io::ErrorKind::InvalidInput, "SINGULARITY_HOME is required")
            })?;
        let env = [
            "HOME",
            "USERPROFILE",
            "USAGE_REPORT_STATE",
            "SING_USAGE_REPORTS",
        ]
        .into_iter()
        .filter_map(|key| {
            std::env::var(key)
                .ok()
                .map(|value| (key.to_owned(), json!(value)))
        })
        .collect();
        let mut services = Self::new(
            PathBuf::from(&home).join("state"),
            crate::usage_report::Request {
                reports_dir: String::new(),
                env: serde_json::Value::Object(env),
            },
        );
        let backups_dir = PathBuf::from(home).join("cache").join("backups");
        services.memory = Some(crate::http_memory_root::MemoryServices::from_env(
            services.state_dir.clone(),
            backups_dir.clone(),
        )?);
        services.config = Some(ConfigServices::from_env(
            services.state_dir.clone(),
            backups_dir,
        )?);
        if let Some(root) = std::env::var_os("SING_PLANS_ROOT").filter(|value| !value.is_empty()) {
            let root = PathBuf::from(root);
            services.plans_root = Some(if root.is_absolute() {
                root
            } else {
                std::env::current_dir()?.join(root)
            });
        }
        Ok(services)
    }
}

pub fn router(policy: HttpPolicy, services: HttpServices) -> Router {
    let memory = services
        .memory
        .map(|memory| memory.router())
        .unwrap_or_default();
    let config = services
        .config
        .map(ConfigServices::router)
        .unwrap_or_default();
    Router::new()
        .merge(memory)
        .merge(config)
        .merge(crate::http_telemetry::router(
            services.sampler,
            services.status,
        ))
        .merge(crate::http_models::router(services.state_dir.clone()))
        .merge(crate::http_plans::router(services.plans_root))
        .merge(crate::http_state::router(services.state_dir))
        .merge(crate::http_reports::router(services.report_request))
        .fallback(not_found)
        .method_not_allowed_fallback(not_found)
        .layer(middleware::from_fn_with_state(
            policy,
            enforce_transport_policy,
        ))
}

pub async fn bind(port: u16) -> io::Result<TcpListener> {
    TcpListener::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port)).await
}

pub async fn serve<F>(
    listener: TcpListener,
    policy: HttpPolicy,
    services: HttpServices,
    shutdown: F,
) -> io::Result<()>
where
    F: Future<Output = ()> + Send + 'static,
{
    axum::serve(listener, router(policy, services))
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
        let services = HttpServices::from_env()?;
        let listener = bind(policy.daemon_port).await?;
        eprintln!("native HTTP listener bound to {}", listener.local_addr()?);
        serve(listener, policy, services, shutdown_signal()).await
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
        ConfigServices, HttpServices, api_unauthorized_response, bind,
        cookie_decode_error_response, router, serve, shell_token_cookie,
        shell_unauthorized_response,
    };
    use crate::http_policy::HttpPolicy;
    use axum::body::to_bytes;
    use axum::http::StatusCode;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::sync::oneshot;

    fn test_services() -> HttpServices {
        HttpServices::new(
            std::env::temp_dir().join(format!("unused-http-test-state-{}", std::process::id())),
            crate::usage_report::Request {
                reports_dir: String::new(),
                env: serde_json::json!({}),
            },
        )
    }

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
                    test_services(),
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
    fn http_config_editor_routes_mount_beside_existing_routes() {
        let root =
            std::env::temp_dir().join(format!("http-config-mount-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let mut services = HttpServices::new(
            root.join("state"),
            crate::usage_report::Request {
                reports_dir: String::new(),
                env: serde_json::json!({}),
            },
        );
        services.config = Some(ConfigServices {
            home: root.join("home"),
            codex_home: root.join("home").join(".codex"),
            state_dir: root.join("state"),
            backups_dir: root.join("backups"),
            cwd: root.clone(),
            drive_cwds: Vec::new(),
        });
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                let listener = bind(0).await.unwrap();
                let address = listener.local_addr().unwrap();
                let (stop, stopped) = oneshot::channel::<()>();
                let server = tokio::spawn(serve(
                    listener,
                    HttpPolicy {
                        daemon_port: address.port(),
                        vite_port: 5317,
                        token: None,
                    },
                    services,
                    async move {
                        let _ = stopped.await;
                    },
                ));
                for (path, expected) in [
                    ("/api/config/roots", "{\"roots\":[\"~\"]}"),
                    ("/api/codex-config/roots", "{\"roots\":[\"~\"]}"),
                    ("/api/claude/theme", "{\"theme\":\"dark\"}"),
                ] {
                    let mut connection =
                        tokio::net::TcpStream::connect(address).await.unwrap();
                    connection
                        .write_all(
                            format!(
                                "GET {path} HTTP/1.1\r\nHost: localhost:{}\r\nConnection: close\r\n\r\n",
                                address.port()
                            )
                            .as_bytes(),
                        )
                        .await
                        .unwrap();
                    let mut response = Vec::new();
                    connection.read_to_end(&mut response).await.unwrap();
                    let response = String::from_utf8(response).unwrap();
                    assert!(response.starts_with("HTTP/1.1 200"), "{path}: {response}");
                    assert!(response.ends_with(expected), "{path}: {response}");
                }
                stop.send(()).unwrap();
                server.await.unwrap().unwrap();
            });
        let _ = std::fs::remove_dir_all(&root);
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
                        }, test_services()),
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

                for path in ["/api/sysstats", "/api/status", "/api/keys", "/api/config/state", "/api/usagereport/status", "/api/usagereport/report", "/api/plans/sessions", "/api/plans/session?sid=bad"] {
                    let denied = send_request(address, &format!(
                        "GET {path} HTTP/1.1\r\nHost: localhost:{}\r\nConnection: close\r\n\r\n", address.port()
                    )).await;
                    assert!(denied.starts_with("HTTP/1.1 401"), "{path}: {denied}");
                }
                let health = send_request(address, &format!(
                    "GET /api/health HTTP/1.1\r\nHost: localhost:{}\r\nConnection: close\r\n\r\n", address.port()
                )).await;
                assert!(health.starts_with("HTTP/1.1 200"), "{health}");
                assert!(health.contains("\"ok\":true"), "{health}");
                for auth in ["X-Sing-Token: token_1", "Cookie: sing_token=token_1"] {
                    let allowed = send_request(address, &format!(
                        "GET /api/keys HTTP/1.1\r\nHost: localhost:{}\r\n{auth}\r\nConnection: close\r\n\r\n", address.port()
                    )).await;
                    assert!(allowed.starts_with("HTTP/1.1 200"), "{allowed}");
                    assert!(allowed.contains("{\"keys\":{}}"), "{allowed}");
                }
                let bad_origin = send_request(address, &format!(
                    "GET /api/keys HTTP/1.1\r\nHost: localhost:{}\r\nOrigin: https://evil.test\r\nX-Sing-Token: token_1\r\nConnection: close\r\n\r\n", address.port()
                )).await;
                assert!(bad_origin.starts_with("HTTP/1.1 403"), "{bad_origin}");
                let wrong_method = send_request(address, &format!(
                    "POST /api/keys HTTP/1.1\r\nHost: localhost:{}\r\nX-Sing-Token: token_1\r\nConnection: close\r\nContent-Length: 0\r\n\r\n", address.port()
                )).await;
                assert!(wrong_method.starts_with("HTTP/1.1 404"), "{wrong_method}");

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

    #[test]
    fn http_mutation_routes_authenticate_before_parsing_or_writing() {
        tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                let root = std::env::temp_dir().join(format!(
                    "http-mutations-{}-{}",
                    std::process::id(),
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap()
                        .as_nanos()
                ));
                let services = HttpServices::new(
                    root.clone(),
                    crate::usage_report::Request {
                        reports_dir: String::new(),
                        env: serde_json::json!({}),
                    },
                );
                let listener = bind(0).await.unwrap();
                let address = listener.local_addr().unwrap();
                let policy = HttpPolicy {
                    daemon_port: address.port(),
                    vite_port: 5317,
                    token: Some("token_1".into()),
                };
                let (stop, stopped) = oneshot::channel();
                let server = tokio::spawn(serve(listener, policy, services, async {
                    let _ = stopped.await;
                }));
                let client = reqwest::Client::new();
                for path in ["/api/keys", "/api/config/state", "/api/models"] {
                    let denied = client
                        .put(format!("http://{address}{path}"))
                        .header("content-type", "application/json")
                        .body("{")
                        .send()
                        .await
                        .unwrap();
                    assert_eq!(denied.status().as_u16(), 401, "{path}");
                }
                let denied = client
                    .post(format!("http://{address}/api/models/restore-defaults"))
                    .send()
                    .await
                    .unwrap();
                assert_eq!(denied.status().as_u16(), 401);
                assert!(!root.exists());
                let denied = client
                    .put(format!("http://{address}/api/keys"))
                    .header("x-sing-token", "token_1")
                    .header("origin", "https://evil.test")
                    .json(&serde_json::json!({"alpha":{"key":"x"}}))
                    .send()
                    .await
                    .unwrap();
                assert_eq!(denied.status().as_u16(), 403);
                assert!(!root.exists());
                let bad = client
                    .put(format!("http://{address}/api/keys"))
                    .header("x-sing-token", "token_1")
                    .header("content-type", "application/json")
                    .body("{")
                    .send()
                    .await
                    .unwrap();
                assert_eq!(bad.status().as_u16(), 400);
                assert!(!root.exists());
                let saved = client
                    .put(format!("http://{address}/api/keys"))
                    .header("x-sing-token", "token_1")
                    .json(&serde_json::json!({"alpha":{"key":"x"}}))
                    .send()
                    .await
                    .unwrap();
                assert_eq!(saved.status().as_u16(), 200);
                assert_eq!(
                    saved.json::<serde_json::Value>().await.unwrap()["keys"]["alpha"]["key"],
                    "x"
                );
                let saved = client
                    .put(format!("http://{address}/api/config/state"))
                    .header("cookie", "sing_token=token_1")
                    .json(&serde_json::json!({"active":"owned"}))
                    .send()
                    .await
                    .unwrap();
                assert_eq!(saved.status().as_u16(), 200);
                assert_eq!(
                    saved.json::<serde_json::Value>().await.unwrap()["state"]["active"],
                    "owned"
                );
                let restored = client
                    .post(format!("http://{address}/api/models/restore-defaults"))
                    .header("x-sing-token", "token_1")
                    .send()
                    .await
                    .unwrap();
                assert_eq!(restored.status().as_u16(), 200);
                assert_eq!(
                    restored.json::<serde_json::Value>().await.unwrap()["ok"],
                    true
                );
                assert!(root.join("models.json").is_file());
                drop(client);
                stop.send(()).unwrap();
                server.await.unwrap().unwrap();
                std::fs::remove_dir_all(root).unwrap();
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
