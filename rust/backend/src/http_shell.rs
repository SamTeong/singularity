//! Static assets, the HTML shell, the SPA fallback and `GET /api/env`.
//!
//! Mirrors `server/index.mjs:194-195` (`webDist`/`hasShell`), `:305-345`
//! (`@fastify/static` rooted at `webDist` with `index: false`, `sendShell`,
//! `GET /`, `setNotFoundHandler`) and `:520` (`GET /env`). The host injects the
//! dist directory and the display home, so `display_home()` is read once and the
//! shell injection and `/api/env` cannot disagree — the same single-source rule
//! Node states at `:317-319` and `:518-520`.
//!
//! Ordering is Node's: `@fastify/static` is registered before the route table
//! and the 404 handler, so an unmatched GET/HEAD that names a real file under
//! `webDist` is served before the shell fallback is considered. Shell auth,
//! token redirect and the origin/host allowlist are the outer host layer's job
//! (`http_server::enforce_transport_policy`); nothing here re-checks them.
//!
//! Known gaps against Node, all declared in the slice findings: static files are
//! read whole into memory where `@fastify/static` streams them; `If-Match` /
//! `If-Unmodified-Since` preconditions (412) and range requests are not
//! implemented; `String.replace`'s `$&` / `` $` `` / `$'` pattern expansion in
//! the injection is not reproduced, so a display home containing `$` differs;
//! malformed percent-escapes stay literal instead of raising the router's
//! `URIError`; and JSON replies rely on the outer Fastify-charset layer, like
//! the sibling route modules.
use crate::http_policy::HttpPolicy;
use axum::Json;
use axum::Router;
use axum::body::Body;
use axum::extract::State;
use axum::http::{HeaderMap, HeaderValue, Method, Request, StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const INDEX_FILE: &str = "index.html";
/// `@fastify/static` default: `cacheControl: true`, `maxAge: 0`.
const CACHE_CONTROL: &str = "public, max-age=0";

#[derive(Clone)]
struct Shell {
    dist_dir: PathBuf,
    /// `displayHome()`: `SING_HOME_DISPLAY`, else the Node-compatible home.
    home: String,
    /// Supplies the injected token and `isShellRequest` for the fallback.
    policy: HttpPolicy,
}

// VERIFY: shell-index-route
/// `GET`/`HEAD /` plus `/assets/*` and `/api/env`; see `fallback` for the rest.
pub fn router(policy: HttpPolicy, dist_dir: PathBuf, home: String) -> Router {
    Router::new()
        .route("/", get(index))
        .route("/assets/{*path}", get(assets))
        .route("/api/env", get(env))
        .with_state(Shell {
            dist_dir,
            home,
            policy,
        })
}

/// The Node `setNotFoundHandler` (`server/index.mjs:332-335`), as a router whose
/// only handler is a fallback. The host installs it with
/// `.fallback_service(http_shell::fallback(..))` in place of `not_found`.
// VERIFY: shell-spa-fallback
pub fn fallback(policy: HttpPolicy, dist_dir: PathBuf, home: String) -> Router {
    Router::new().fallback(serve_unmatched).with_state(Shell {
        dist_dir,
        home,
        policy,
    })
}

/// `displayHome()` (`server/index.mjs:70`): `SING_HOME_DISPLAY || homedir()`.
pub fn display_home() -> std::io::Result<String> {
    if let Some(value) = std::env::var_os("SING_HOME_DISPLAY").filter(|value| !value.is_empty()) {
        return Ok(value.to_string_lossy().into_owned());
    }
    Ok(crate::memory_root::current_node_home()?
        .to_string_lossy()
        .into_owned())
}

// VERIFY: shell-env-route
async fn env(State(shell): State<Shell>) -> Response {
    Json(json!({ "home": shell.home })).into_response()
}

async fn index(State(shell): State<Shell>, method: Method) -> Response {
    shell_response(&shell, &method).await
}

// VERIFY: shell-assets-route
async fn assets(
    State(shell): State<Shell>,
    method: Method,
    headers: HeaderMap,
    uri: Uri,
) -> Response {
    serve_path(&shell, uri.path(), &method, &headers).await
}

/// One URL path → one file under `web/dist`, as `@fastify/static` resolves it.
async fn serve_path(shell: &Shell, path: &str, method: &Method, headers: &HeaderMap) -> Response {
    let decoded = percent_decode(path);
    let Some(relative) = decoded.strip_prefix('/') else {
        return not_found();
    };
    match read_asset(&shell.dist_dir, relative).await {
        Some(asset) => respond_asset(asset, relative, method, headers),
        None => not_found(),
    }
}

/// `fastify-static` first, then the shell for navigations, then Node's JSON 404.
async fn serve_unmatched(State(shell): State<Shell>, request: Request<Body>) -> Response {
    let method = request.method().clone();
    let path = request.uri().path().to_owned();
    let headers = request.headers().clone();
    if matches!(method, Method::GET | Method::HEAD)
        && !is_path_or_child(&path, "/api")
        && !is_path_or_child(&path, "/ws")
    {
        let response = serve_path(&shell, &path, &method, &headers).await;
        if response.status() != StatusCode::NOT_FOUND {
            return response;
        }
    }
    let accept = headers
        .get(header::ACCEPT)
        .and_then(|value| value.to_str().ok());
    if shell.policy.is_shell_request(&method, &path, accept) {
        return shell_response(&shell, &method).await;
    }
    not_found()
}

struct Asset {
    bytes: Vec<u8>,
    modified: SystemTime,
}

async fn read_asset(dist_dir: &Path, relative: &str) -> Option<Asset> {
    let dist_dir = dist_dir.to_path_buf();
    let relative = relative.to_owned();
    tokio::task::spawn_blocking(move || read_asset_blocking(&dist_dir, &relative))
        .await
        .ok()
        .flatten()
}

fn read_asset_blocking(dist_dir: &Path, relative: &str) -> Option<Asset> {
    let path = contained_path(dist_dir, relative)?;
    let metadata = std::fs::metadata(&path).ok()?;
    if !metadata.is_file() {
        return None;
    }
    let bytes = std::fs::read(&path).ok()?;
    Some(Asset {
        bytes,
        modified: metadata.modified().unwrap_or(UNIX_EPOCH),
    })
}

/// Resolve `relative` under `dist_dir`, rejecting traversal, dotfiles (Node's
/// `serveDotFiles: false`) and anything that canonicalizes outside the root.
fn contained_path(dist_dir: &Path, relative: &str) -> Option<PathBuf> {
    let mut path = dist_dir.to_path_buf();
    for segment in relative.split('/') {
        if segment.is_empty() || segment.starts_with('.') || segment.contains(['\\', ':']) {
            return None;
        }
        path.push(segment);
    }
    let root = std::fs::canonicalize(dist_dir).ok()?;
    let resolved = std::fs::canonicalize(path).ok()?;
    resolved.starts_with(&root).then_some(resolved)
}

fn respond_asset(asset: Asset, relative: &str, method: &Method, headers: &HeaderMap) -> Response {
    let length = asset.bytes.len();
    let last_modified = httpdate::fmt_http_date(asset.modified);
    let modified_ms = asset
        .modified
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis())
        .unwrap_or(0);
    // `etag`'s stat tag, as `send` emits it.
    let etag = format!("W/\"{length:x}-{modified_ms:x}\"");
    if fresh(headers, &etag, &last_modified) {
        return not_modified(&etag, &last_modified);
    }
    let body = if *method == Method::HEAD {
        Vec::new()
    } else {
        asset.bytes
    };
    let mut response = Response::new(Body::from(body));
    let outgoing = response.headers_mut();
    if let Some(mime) = mime_type(relative) {
        outgoing.insert(header::CONTENT_TYPE, HeaderValue::from_static(mime));
    }
    insert(outgoing, header::CONTENT_LENGTH, &length.to_string());
    insert(outgoing, header::CACHE_CONTROL, CACHE_CONTROL);
    insert(outgoing, header::ETAG, &etag);
    insert(outgoing, header::LAST_MODIFIED, &last_modified);
    insert(outgoing, header::ACCEPT_RANGES, "bytes");
    response
}

fn not_modified(etag: &str, last_modified: &str) -> Response {
    // `send`'s notModified() drops the entity headers and keeps the validators.
    let mut response = StatusCode::NOT_MODIFIED.into_response();
    let outgoing = response.headers_mut();
    insert(outgoing, header::CACHE_CONTROL, CACHE_CONTROL);
    insert(outgoing, header::ETAG, etag);
    insert(outgoing, header::LAST_MODIFIED, last_modified);
    insert(outgoing, header::ACCEPT_RANGES, "bytes");
    response
}

/// The `fresh` package's decision, as `send` applies it to cached responses.
fn fresh(headers: &HeaderMap, etag: &str, last_modified: &str) -> bool {
    let value = |name: &str| headers.get(name).and_then(|value| value.to_str().ok());
    let modified_since = value("if-modified-since");
    let none_match = value("if-none-match");
    if modified_since.is_none() && none_match.is_none() {
        return false;
    }
    if value("cache-control").is_some_and(|value| {
        value
            .split(',')
            .any(|directive| directive.trim().eq_ignore_ascii_case("no-cache"))
    }) {
        return false;
    }
    if none_match.is_some_and(|none_match| {
        none_match != "*"
            && !none_match
                .split(',')
                .any(|candidate| etag_matches(candidate.trim(), etag))
    }) {
        return false;
    }
    if let Some(modified_since) = modified_since {
        let (Ok(modified_since), Ok(last_modified)) = (
            httpdate::parse_http_date(modified_since),
            httpdate::parse_http_date(last_modified),
        ) else {
            return false;
        };
        if last_modified > modified_since {
            return false;
        }
    }
    true
}

fn etag_matches(candidate: &str, etag: &str) -> bool {
    candidate == etag
        || candidate == format!("W/{etag}")
        || etag.strip_prefix("W/").is_some_and(|tag| tag == candidate)
}

async fn shell_response(shell: &Shell, method: &Method) -> Response {
    let path = shell.dist_dir.join(INDEX_FILE);
    let reported = path.to_string_lossy().into_owned();
    let read = tokio::task::spawn_blocking(move || std::fs::read(path)).await;
    let bytes = match read {
        Ok(Ok(bytes)) => bytes,
        Ok(Err(error)) => return read_error(&error, &reported),
        Err(_) => return internal_error("Rust shell read failed"),
    };
    let html = String::from_utf8_lossy(&bytes);
    let html = inject(&html, &shell.home, shell.policy.token.as_deref());
    let length = html.len();
    let body = if *method == Method::HEAD {
        Vec::new()
    } else {
        html.into_bytes()
    };
    let mut response = Response::new(Body::from(body));
    let outgoing = response.headers_mut();
    insert(outgoing, header::CONTENT_TYPE, "text/html; charset=utf-8");
    insert(outgoing, header::CONTENT_LENGTH, &length.to_string());
    response
}

/// `sendShell` (`server/index.mjs:311-322`): the home script, then the token
/// script, both before the first `</head>` — Node's two `replace` calls land in
/// that order because the first replacement re-inserts the marker it matched.
fn inject(html: &str, home: &str, token: Option<&str>) -> String {
    let Some(index) = html.find("</head>") else {
        return html.to_owned();
    };
    let mut out = String::with_capacity(html.len() + 160);
    out.push_str(&html[..index]);
    out.push_str(&injection("__SING_HOME__", home));
    if let Some(token) = token {
        out.push_str(&injection("__SING_TOKEN__", token));
    }
    out.push_str(&html[index..]);
    out
}

/// `JSON.stringify` of a JavaScript string, which a serde_json string literal is.
fn injection(name: &str, value: &str) -> String {
    format!(
        "<script>window.{name}={};</script>",
        Value::String(value.to_owned())
    )
}

fn read_error(error: &std::io::Error, path: &str) -> Response {
    let message = if error.kind() == std::io::ErrorKind::NotFound {
        format!("ENOENT: no such file or directory, open '{path}'")
    } else {
        error.to_string()
    };
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({
            "statusCode": 500,
            "error": "Internal Server Error",
            "message": message,
        })),
    )
        .into_response()
}

fn internal_error(message: &str) -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({
            "statusCode": 500,
            "error": "Internal Server Error",
            "message": message,
        })),
    )
        .into_response()
}

fn not_found() -> Response {
    (StatusCode::NOT_FOUND, Json(json!({ "error": "not found" }))).into_response()
}

fn insert(headers: &mut HeaderMap, name: header::HeaderName, value: &str) {
    if let Ok(value) = HeaderValue::try_from(value) {
        headers.insert(name, value);
    }
}

fn is_path_or_child(path: &str, prefix: &str) -> bool {
    path == prefix || path.starts_with(&format!("{prefix}/"))
}

/// Percent-decode a URL path; malformed escapes stay literal instead of erroring.
fn percent_decode(path: &str) -> String {
    let bytes = path.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let pair = bytes
                .get(index + 1)
                .copied()
                .and_then(hex)
                .zip(bytes.get(index + 2).copied().and_then(hex));
            if let Some((high, low)) = pair {
                decoded.push((high << 4) | low);
                index += 3;
                continue;
            }
        }
        decoded.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&decoded).into_owned()
}

fn hex(byte: u8) -> Option<u8> {
    (byte as char).to_digit(16).map(|digit| digit as u8)
}

/// `mime.lookup` for the extensions a Vite build emits, with the `charset` that
/// `mime.charsets.lookup` adds. An unknown extension gets no `Content-Type`.
fn mime_type(relative: &str) -> Option<&'static str> {
    let name = relative.rsplit('/').next().unwrap_or(relative);
    let (_, extension) = name.rsplit_once('.')?;
    let mime = match extension.to_ascii_lowercase().as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "js" | "mjs" | "cjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" => "application/json; charset=utf-8",
        "webmanifest" => "application/manifest+json; charset=utf-8",
        "txt" => "text/plain; charset=utf-8",
        "csv" => "text/csv; charset=utf-8",
        "md" => "text/markdown; charset=utf-8",
        "xml" => "application/xml",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "ico" => "image/vnd.microsoft.icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "eot" => "application/vnd.ms-fontobject",
        "wasm" => "application/wasm",
        "pdf" => "application/pdf",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        "zip" => "application/zip",
        "gz" => "application/gzip",
        _ => return None,
    };
    Some(mime)
}

#[cfg(test)]
mod tests {
    use super::{contained_path, fallback, inject, percent_decode, router};
    use crate::http_policy::HttpPolicy;
    use axum::Router;
    use axum::http::StatusCode;
    use std::fs;
    use std::net::SocketAddr;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};
    use tokio::sync::oneshot;

    const HOME: &str = "C:/http-fixture/home";
    const TOKEN: &str = "token_1";

    struct Fixture(PathBuf);

    impl Fixture {
        fn new(name: &str) -> Self {
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let root = std::env::temp_dir().join(format!(
                "singularity-http-shell-{name}-{}-{nanos}",
                std::process::id()
            ));
            fs::create_dir_all(root.join("dist/assets")).unwrap();
            fs::write(
                root.join("dist/index.html"),
                "<!doctype html><html><head><title>shell</title></head><body><div id=\"root\"></div></body></html>",
            )
            .unwrap();
            fs::write(root.join("dist/assets/app.js"), "console.log(1)\n").unwrap();
            fs::write(root.join("dist/assets/style.css"), "body{color:red}\n").unwrap();
            fs::write(root.join("dist/assets/logo.svg"), "<svg/>\n").unwrap();
            fs::write(root.join("dist/assets/blob.bin"), [0u8, 1, 2]).unwrap();
            fs::write(root.join("dist/assets/.hidden.js"), "hidden").unwrap();
            fs::write(root.join("dist/favicon.ico"), [0u8, 0, 1, 0]).unwrap();
            fs::write(root.join("secret.txt"), "outside").unwrap();
            Self(root)
        }

        fn dist(&self) -> PathBuf {
            self.0.join("dist")
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

    fn policy(port: u16, token: Option<&str>) -> HttpPolicy {
        HttpPolicy {
            daemon_port: port,
            vite_port: 5317,
            token: token.map(str::to_owned),
        }
    }

    async fn start(app: Router) -> (SocketAddr, oneshot::Sender<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        assert!(address.ip().is_loopback());
        let (stop, stopped) = oneshot::channel::<()>();
        tokio::spawn(async move {
            axum::serve(listener, app)
                .with_graceful_shutdown(async move {
                    let _ = stopped.await;
                })
                .await
                .unwrap();
        });
        (address, stop)
    }

    fn client() -> reqwest::Client {
        reqwest::Client::builder().no_proxy().build().unwrap()
    }

    async fn serve(fixture: &Fixture, token: Option<&str>) -> (SocketAddr, oneshot::Sender<()>) {
        let app = router(policy(4317, token), fixture.dist(), HOME.to_owned());
        start(app).await
    }

    fn header_value(response: &reqwest::Response, name: &str) -> Option<String> {
        response
            .headers()
            .get(name)
            .map(|value| value.to_str().unwrap().to_owned())
    }

    #[test]
    fn http_shell_index_injects_home_then_token_for_get_and_head() {
        let fixture = Fixture::new("index");
        run(async {
            let (address, stop) = serve(&fixture, Some(TOKEN)).await;
            let response = client()
                .get(format!("http://{address}/"))
                .header("accept", "text/html")
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(
                header_value(&response, "content-type").as_deref(),
                Some("text/html; charset=utf-8")
            );
            let length = header_value(&response, "content-length").unwrap();
            let body = response.text().await.unwrap();
            assert_eq!(length.parse::<usize>().unwrap(), body.len());
            assert_eq!(
                body,
                concat!(
                    "<!doctype html><html><head><title>shell</title>",
                    "<script>window.__SING_HOME__=\"C:/http-fixture/home\";</script>",
                    "<script>window.__SING_TOKEN__=\"token_1\";</script>",
                    "</head><body><div id=\"root\"></div></body></html>"
                )
            );

            let response = client()
                .head(format!("http://{address}/"))
                .header("accept", "text/html")
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(
                header_value(&response, "content-type").as_deref(),
                Some("text/html; charset=utf-8")
            );
            assert_eq!(
                header_value(&response, "content-length").as_deref(),
                Some(length.as_str())
            );
            assert!(response.bytes().await.unwrap().is_empty());

            stop.send(()).unwrap();
        });
    }

    #[test]
    fn http_shell_injection_uses_the_first_head_close_and_needs_no_token() {
        assert_eq!(
            inject("<head></head><head></head>", "C:\\Users\\sate", Some(TOKEN)),
            concat!(
                "<head><script>window.__SING_HOME__=\"C:\\\\Users\\\\sate\";</script>",
                "<script>window.__SING_TOKEN__=\"token_1\";</script></head><head></head>"
            )
        );
        assert_eq!(
            inject("<head></head>", "C:/home", None),
            "<head><script>window.__SING_HOME__=\"C:/home\";</script></head>"
        );
        assert_eq!(inject("<html></html>", "C:/home", None), "<html></html>");
        assert_eq!(
            inject("<head></head>", "C:/a\"b\u{1}c", None),
            "<head><script>window.__SING_HOME__=\"C:/a\\\"b\\u0001c\";</script></head>"
        );
    }

    #[test]
    fn http_shell_missing_index_returns_the_fastify_enoent_500() {
        let fixture = Fixture::new("missing-index");
        fs::remove_file(fixture.dist().join("index.html")).unwrap();
        run(async {
            let (address, stop) = serve(&fixture, None).await;
            let response = client()
                .get(format!("http://{address}/"))
                .header("accept", "text/html")
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
            let body: serde_json::Value = response.json().await.unwrap();
            assert_eq!(body["statusCode"], 500);
            assert_eq!(body["error"], "Internal Server Error");
            let message = body["message"].as_str().unwrap();
            assert!(message.starts_with("ENOENT: no such file or directory, open '"));
            assert!(message.ends_with("index.html'"), "{message}");
            stop.send(()).unwrap();
        });
    }

    #[test]
    fn http_shell_assets_set_type_cache_and_validator_headers() {
        let fixture = Fixture::new("assets");
        run(async {
            let (address, stop) = serve(&fixture, None).await;
            for (path, mime, body) in [
                (
                    "/assets/app.js",
                    Some("text/javascript; charset=utf-8"),
                    "console.log(1)\n",
                ),
                (
                    "/assets/style.css",
                    Some("text/css; charset=utf-8"),
                    "body{color:red}\n",
                ),
                ("/assets/logo.svg", Some("image/svg+xml"), "<svg/>\n"),
                ("/assets/blob.bin", None, ""),
            ] {
                let response = client()
                    .get(format!("http://{address}{path}"))
                    .send()
                    .await
                    .unwrap();
                assert_eq!(response.status(), StatusCode::OK, "{path}");
                assert_eq!(
                    header_value(&response, "content-type").as_deref(),
                    mime,
                    "{path}"
                );
                assert_eq!(
                    header_value(&response, "cache-control").as_deref(),
                    Some("public, max-age=0"),
                    "{path}"
                );
                assert_eq!(
                    header_value(&response, "accept-ranges").as_deref(),
                    Some("bytes"),
                    "{path}"
                );
                let length = header_value(&response, "content-length").unwrap();
                let expected = fs::metadata(fixture.dist().join(path.trim_start_matches('/')))
                    .unwrap()
                    .len();
                assert_eq!(length.parse::<u64>().unwrap(), expected, "{path}");
                let bytes = response.bytes().await.unwrap();
                assert_eq!(bytes.len() as u64, expected, "{path}");
                if !body.is_empty() {
                    assert_eq!(String::from_utf8_lossy(&bytes), body, "{path}");
                }
            }

            let response = client()
                .get(format!("http://{address}/assets/app.js"))
                .send()
                .await
                .unwrap();
            let etag = header_value(&response, "etag").unwrap();
            let modified = fs::metadata(fixture.dist().join("assets/app.js"))
                .unwrap()
                .modified()
                .unwrap()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_millis();
            assert_eq!(
                etag,
                format!("W/\"{:x}-{:x}\"", "console.log(1)\n".len(), modified)
            );
            let last_modified = header_value(&response, "last-modified").unwrap();
            assert!(httpdate::parse_http_date(&last_modified).is_ok());

            let response = client()
                .head(format!("http://{address}/assets/app.js"))
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(
                header_value(&response, "content-type").as_deref(),
                Some("text/javascript; charset=utf-8")
            );
            assert_eq!(
                header_value(&response, "etag").as_deref(),
                Some(etag.as_str())
            );
            assert!(response.bytes().await.unwrap().is_empty());
            stop.send(()).unwrap();
        });
    }

    #[test]
    fn http_shell_asset_conditionals_return_304_without_entity_headers() {
        let fixture = Fixture::new("conditional");
        run(async {
            let (address, stop) = serve(&fixture, None).await;
            let url = format!("http://{address}/assets/app.js");
            let response = client().get(&url).send().await.unwrap();
            let etag = header_value(&response, "etag").unwrap();
            let last_modified = header_value(&response, "last-modified").unwrap();
            response.bytes().await.unwrap();

            let revalidated = client()
                .get(&url)
                .header("if-none-match", &etag)
                .send()
                .await
                .unwrap();
            assert_eq!(revalidated.status(), StatusCode::NOT_MODIFIED);
            assert_eq!(header_value(&revalidated, "content-type"), None);
            assert_eq!(
                header_value(&revalidated, "cache-control").as_deref(),
                Some("public, max-age=0")
            );
            assert_eq!(
                header_value(&revalidated, "etag").as_deref(),
                Some(etag.as_str())
            );
            assert!(revalidated.bytes().await.unwrap().is_empty());

            let by_date = client()
                .get(&url)
                .header("if-modified-since", &last_modified)
                .send()
                .await
                .unwrap();
            assert_eq!(by_date.status(), StatusCode::NOT_MODIFIED);

            for (name, value) in [
                ("if-none-match", "\"other\""),
                ("if-modified-since", "Thu, 01 Jan 1970 00:00:00 GMT"),
                ("cache-control", "no-cache"),
            ] {
                let response = client().get(&url).header(name, value).send().await.unwrap();
                assert_eq!(response.status(), StatusCode::OK, "{name}: {value}");
                response.bytes().await.unwrap();
            }

            let stale_pair = client()
                .get(&url)
                .header("if-none-match", &etag)
                .header("if-modified-since", "Thu, 01 Jan 1970 00:00:00 GMT")
                .send()
                .await
                .unwrap();
            assert_eq!(stale_pair.status(), StatusCode::OK);
            stale_pair.bytes().await.unwrap();
            stop.send(()).unwrap();
        });
    }

    #[test]
    fn http_shell_asset_rejects_traversal_dotfiles_and_missing_files() {
        let fixture = Fixture::new("traversal");
        run(async {
            let (address, stop) = serve(&fixture, None).await;
            for path in [
                "/assets/missing.js",
                "/assets/.hidden.js",
                "/assets/%2e%2e/secret.txt",
                "/assets/%2E%2E%2Fsecret.txt",
                "/assets/..%5csecret.txt",
            ] {
                let response = client()
                    .get(format!("http://{address}{path}"))
                    .header("accept", "text/html")
                    .send()
                    .await
                    .unwrap();
                assert_eq!(response.status(), StatusCode::NOT_FOUND, "{path}");
            }
            // Only the paths axum's own matcher accepts reach the handler; the
            // rest are answered by axum's empty 404, which is still a 404.
            for path in ["/assets/missing.js", "/assets/.hidden.js"] {
                let response = client()
                    .get(format!("http://{address}{path}"))
                    .send()
                    .await
                    .unwrap();
                assert_eq!(
                    response.text().await.unwrap(),
                    "{\"error\":\"not found\"}",
                    "{path}"
                );
            }
            let directory = client()
                .get(format!("http://{address}/assets/"))
                .send()
                .await
                .unwrap();
            assert_eq!(directory.status(), StatusCode::NOT_FOUND);
            stop.send(()).unwrap();
        });
    }

    #[test]
    fn http_shell_fallback_serves_shell_for_navigations_and_json_404_otherwise() {
        let fixture = Fixture::new("fallback");
        run(async {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = listener.local_addr().unwrap().port();
            drop(listener);
            let app = Router::new().fallback_service(fallback(
                policy(port, None),
                fixture.dist(),
                HOME.to_owned(),
            ));
            let (address, stop) = start(app).await;

            let shell = client()
                .get(format!("http://{address}/tasks"))
                .header("accept", "text/html")
                .send()
                .await
                .unwrap();
            assert_eq!(shell.status(), StatusCode::OK);
            let body = shell.text().await.unwrap();
            assert!(
                body.contains("window.__SING_HOME__=\"C:/http-fixture/home\""),
                "{body}"
            );
            assert!(body.contains("</head><body>"), "{body}");

            for (method, path, accept, expected) in [
                ("GET", "/tasks", "application/json", 404),
                ("POST", "/tasks", "text/html", 404),
                ("GET", "/assets/missing.js", "text/html", 404),
                ("GET", "/api/private", "text/html", 404),
            ] {
                let request = client()
                    .request(method.parse().unwrap(), format!("http://{address}{path}"))
                    .header("accept", accept);
                let response = request.send().await.unwrap();
                assert_eq!(response.status().as_u16(), expected, "{method} {path}");
                let body: serde_json::Value = response.json().await.unwrap();
                assert_eq!(body, serde_json::json!({ "error": "not found" }), "{path}");
            }

            let asset = client()
                .get(format!("http://{address}/assets/style.css"))
                .send()
                .await
                .unwrap();
            assert_eq!(asset.status(), StatusCode::OK);
            assert_eq!(
                header_value(&asset, "content-type").as_deref(),
                Some("text/css; charset=utf-8")
            );
            assert_eq!(asset.text().await.unwrap(), "body{color:red}\n");

            let favicon = client()
                .get(format!("http://{address}/favicon.ico"))
                .header("accept", "text/html")
                .send()
                .await
                .unwrap();
            assert_eq!(favicon.status(), StatusCode::OK);
            assert_eq!(
                header_value(&favicon, "content-type").as_deref(),
                Some("image/vnd.microsoft.icon")
            );
            stop.send(()).unwrap();
        });
    }

    #[test]
    fn http_shell_env_returns_the_injected_display_home() {
        let fixture = Fixture::new("env");
        run(async {
            let (address, stop) = serve(&fixture, Some(TOKEN)).await;
            let response = client()
                .get(format!("http://{address}/api/env"))
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            let body: serde_json::Value = response.json().await.unwrap();
            assert_eq!(body, serde_json::json!({ "home": HOME }));
            stop.send(()).unwrap();
        });
    }

    #[test]
    fn http_shell_helpers_decode_paths_and_keep_malformed_escapes_literal() {
        assert_eq!(percent_decode("/assets/a%20b.js"), "/assets/a b.js");
        assert_eq!(percent_decode("/assets/100%"), "/assets/100%");
        assert_eq!(percent_decode("/assets/%zz.js"), "/assets/%zz.js");
        assert_eq!(percent_decode("/%E2%9C%93"), "/\u{2713}");
    }

    #[test]
    fn http_shell_contained_path_keeps_resolution_inside_dist() {
        let fixture = Fixture::new("contained");
        let dist = fixture.dist();
        assert!(contained_path(&dist, "assets/app.js").is_some());
        assert!(contained_path(&dist, "favicon.ico").is_some());
        for relative in [
            "",
            "..",
            "../secret.txt",
            "assets/../../secret.txt",
            ".hidden.js",
            "assets/.hidden.js",
            "assets\\app.js",
            "C:/Windows/win.ini",
            "assets/",
        ] {
            assert_eq!(contained_path(&dist, relative), None, "{relative:?}");
        }
    }
}
