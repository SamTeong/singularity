use reqwest::header::{AUTHORIZATION, HeaderMap, HeaderValue, LOCATION, RETRY_AFTER};
use reqwest::redirect::Policy;
use reqwest::{Client, Method, StatusCode, Url};
use serde_json::Value;
use std::fs;
use std::path::Path;
use std::time::Duration;
use std::time::Instant;

const USAGE_URL: &str = "https://chatgpt.com/backend-api/wham/usage";
const HEADER_TIMEOUT: Duration = Duration::from_millis(10_000);
const REDIRECT_LIMIT: usize = 20;

#[derive(Debug, PartialEq, Eq)]
pub enum CodexUsageResult {
    NoSessions,
    TransportFailure,
    TimeoutFailure,
    Response {
        status: u16,
        retry_after: Option<String>,
        body: Result<Option<String>, BodyReadFailure>,
    },
}

#[derive(Debug, PartialEq, Eq)]
pub enum BodyReadFailure {
    Terminated,
}

struct CredentialSnapshot {
    token: String,
    account: String,
}

#[derive(Default)]
pub struct CodexUsageSessions {
    credentials: std::collections::HashMap<String, CredentialSnapshot>,
    next_handle: u64,
}

impl CodexUsageSessions {
    pub fn begin(&mut self, auth_path: &Path) -> Option<String> {
        let credentials = load_codex_credentials(auth_path)?;
        self.next_handle = self.next_handle.wrapping_add(1);
        let handle = format!("codex-usage-{}", self.next_handle);
        self.credentials.insert(handle.clone(), credentials);
        Some(handle)
    }

    pub fn release(&mut self, handle: &str) -> bool {
        self.credentials.remove(handle).is_some()
    }

    pub async fn fetch(&self, handle: &str) -> CodexUsageResult {
        match self.credentials.get(handle) {
            Some(credentials) => fetch_codex_usage_with_credentials(credentials).await,
            None => CodexUsageResult::NoSessions,
        }
    }
}

/// Performs exactly one live Codex usage attempt. Retry scheduling belongs to Node.
pub async fn fetch_codex_usage(auth_path: &Path) -> CodexUsageResult {
    let Some(credentials) = load_codex_credentials(auth_path) else {
        return CodexUsageResult::NoSessions;
    };
    fetch_codex_usage_with_credentials(&credentials).await
}

fn load_codex_credentials(auth_path: &Path) -> Option<CredentialSnapshot> {
    let Ok(contents) = fs::read(auth_path) else {
        return None;
    };
    let Ok(auth) = serde_json::from_slice::<Value>(&contents) else {
        return None;
    };
    let Some(tokens) = auth.get("tokens") else {
        return None;
    };
    let Some(token) = tokens.get("access_token").filter(|value| js_truthy(value)) else {
        return None;
    };
    let Some(account) = tokens.get("account_id").filter(|value| js_truthy(value)) else {
        return None;
    };
    Some(CredentialSnapshot {
        token: js_string(token),
        account: js_string(account),
    })
}

async fn fetch_codex_usage_with_credentials(credentials: &CredentialSnapshot) -> CodexUsageResult {
    fetch_with_credentials(credentials, USAGE_URL, HEADER_TIMEOUT).await
}

#[cfg(test)]
async fn fetch_with(
    auth_path: &Path,
    endpoint: &str,
    header_timeout: Duration,
) -> CodexUsageResult {
    let Some(credentials) = load_codex_credentials(auth_path) else {
        return CodexUsageResult::NoSessions;
    };
    fetch_with_credentials(&credentials, endpoint, header_timeout).await
}

async fn fetch_with_credentials(
    credentials: &CredentialSnapshot,
    endpoint: &str,
    header_timeout: Duration,
) -> CodexUsageResult {
    let Ok(mut url) = Url::parse(endpoint) else {
        return CodexUsageResult::TransportFailure;
    };
    if has_userinfo(&url) || !matches!(url.scheme(), "http" | "https") {
        return CodexUsageResult::TransportFailure;
    }
    let Ok(authorization) = HeaderValue::from_str(&format!("Bearer {}", credentials.token)) else {
        return CodexUsageResult::TransportFailure;
    };
    let Ok(account_header) = HeaderValue::from_str(&credentials.account) else {
        return CodexUsageResult::TransportFailure;
    };
    let Ok(client) = Client::builder().redirect(Policy::none()).build() else {
        return CodexUsageResult::TransportFailure;
    };
    let mut authorization = Some(authorization);
    let mut redirects = 0;
    let deadline = Instant::now() + header_timeout;

    loop {
        let mut headers = HeaderMap::new();
        if let Some(value) = &authorization {
            headers.insert(AUTHORIZATION, value.clone());
        }
        headers.insert("ChatGPT-Account-Id", account_header.clone());
        let request = client
            .request(Method::GET, url.clone())
            .headers(headers)
            .build();
        let Ok(request) = request else {
            return CodexUsageResult::TransportFailure;
        };
        let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
            return CodexUsageResult::TimeoutFailure;
        };
        let response = tokio::time::timeout(remaining, client.execute(request)).await;
        let response = match response {
            Err(_) => return CodexUsageResult::TimeoutFailure,
            Ok(Err(_)) => return CodexUsageResult::TransportFailure,
            Ok(Ok(response)) => response,
        };
        let status = response.status();
        let retry_after = response
            .headers()
            .get(RETRY_AFTER)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);
        if is_redirect(status) {
            let Some(location) = response.headers().get(LOCATION) else {
                return CodexUsageResult::Response {
                    status: status.as_u16(),
                    retry_after,
                    body: Ok(None),
                };
            };
            if redirects >= REDIRECT_LIMIT {
                return CodexUsageResult::TransportFailure;
            }
            let Ok(location) = location.to_str() else {
                return CodexUsageResult::TransportFailure;
            };
            let Ok(next) = url.join(location) else {
                return CodexUsageResult::TransportFailure;
            };
            if has_userinfo(&next) || !matches!(next.scheme(), "http" | "https") {
                return CodexUsageResult::TransportFailure;
            }
            if origin(&url) != origin(&next) {
                authorization = None;
            }
            url = next;
            redirects += 1;
            continue;
        }
        if status != StatusCode::OK {
            return CodexUsageResult::Response {
                status: status.as_u16(),
                retry_after,
                body: Ok(None),
            };
        }
        let body = match response.bytes().await {
            Ok(bytes) => {
                let text = String::from_utf8_lossy(&bytes).into_owned();
                Ok(Some(
                    text.strip_prefix('\u{feff}').unwrap_or(&text).to_owned(),
                ))
            }
            Err(_) => Err(BodyReadFailure::Terminated),
        };
        return CodexUsageResult::Response {
            status: status.as_u16(),
            retry_after,
            body,
        };
    }
}

fn has_userinfo(url: &Url) -> bool {
    !url.username().is_empty() || url.password().is_some()
}

fn origin(url: &Url) -> (String, Option<String>, Option<u16>) {
    (
        url.scheme().to_owned(),
        url.host_str().map(str::to_owned),
        url.port_or_known_default(),
    )
}

fn is_redirect(status: StatusCode) -> bool {
    matches!(status.as_u16(), 301 | 302 | 303 | 307 | 308)
}

fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(value) => js_number(value).is_some_and(|value| value != 0.0),
        Value::String(value) => !value.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

fn js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".to_owned(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => js_number(value).map(js_number_string).unwrap_or_default(),
        Value::String(value) => value.clone(),
        Value::Array(values) => values
            .iter()
            .map(|value| {
                if value.is_null() {
                    String::new()
                } else {
                    js_string(value)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_owned(),
    }
}

fn js_number(value: &serde_json::Number) -> Option<f64> {
    value
        .as_f64()
        .or_else(|| value.to_string().parse::<f64>().ok())
}

fn js_number_string(value: f64) -> String {
    if value.is_infinite() {
        return if value.is_sign_negative() {
            "-Infinity".to_owned()
        } else {
            "Infinity".to_owned()
        };
    }
    let mut buffer = ryu_js::Buffer::new();
    buffer.format_finite(value).to_owned()
}

#[cfg(test)]
mod tests {
    use super::{
        BodyReadFailure, CodexUsageResult, fetch_with, fetch_with_credentials, js_string,
        js_truthy, load_codex_credentials,
    };
    use serde_json::{Value, json};
    use std::fs;
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::thread;
    use std::time::Duration;

    static NEXT_FILE: AtomicU64 = AtomicU64::new(0);

    fn auth_file(contents: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "codex-usage-{}-{}.json",
            std::process::id(),
            NEXT_FILE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::write(&path, contents).unwrap();
        path
    }

    fn read_request(stream: &mut TcpStream) -> String {
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let mut request = Vec::new();
        let mut byte = [0; 1];
        while !request.ends_with(b"\r\n\r\n") {
            if stream.read(&mut byte).unwrap_or(0) == 0 {
                break;
            }
            request.push(byte[0]);
        }
        String::from_utf8_lossy(&request).into_owned()
    }

    fn serve(listener: TcpListener, responses: Vec<String>) -> thread::JoinHandle<Vec<String>> {
        thread::spawn(move || {
            let mut requests = Vec::new();
            for response in responses {
                let (mut stream, _) = listener.accept().unwrap();
                requests.push(read_request(&mut stream));
                stream.write_all(response.as_bytes()).unwrap();
                stream.flush().unwrap();
            }
            requests
        })
    }

    fn serve_bytes(
        listener: TcpListener,
        responses: Vec<Vec<u8>>,
    ) -> thread::JoinHandle<Vec<String>> {
        thread::spawn(move || {
            let mut requests = Vec::new();
            for response in responses {
                let (mut stream, _) = listener.accept().unwrap();
                requests.push(read_request(&mut stream));
                stream.write_all(&response).unwrap();
                stream.flush().unwrap();
            }
            requests
        })
    }

    fn response(status: &str, headers: &str, body: &str) -> String {
        format!(
            "HTTP/1.1 {status}\r\n{headers}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
    }

    fn runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
    }

    #[test]
    fn auth_values_follow_javascript_truthiness_and_string_conversion() {
        assert!(!js_truthy(&json!(0)));
        assert!(!js_truthy(&json!("")));
        assert!(js_truthy(&json!([])));
        assert!(js_truthy(&json!({})));
        assert_eq!(js_string(&json!(["a", null, 2])), "a,,2");
        assert_eq!(
            js_string(&serde_json::from_str::<Value>("[9007199254740993,[1e21]]").unwrap()),
            "9007199254740992,1e+21"
        );
        assert_eq!(
            js_string(&json!({"secret": "never serialized"})),
            "[object Object]"
        );
    }

    #[test]
    fn numeric_auth_headers_match_javascript_number_string_conversion() {
        let cases = [
            ("9007199254740993", Some("9007199254740992")),
            ("1e20", Some("100000000000000000000")),
            ("1e21", Some("1e+21")),
            ("-0", None),
            ("1e-400", None),
            ("1e400", Some("Infinity")),
            ("[-0]", Some("0")),
            ("[9007199254740993,[1e21]]", Some("9007199254740992,1e+21")),
        ];

        for (account_json, expected_header) in cases {
            let auth = auth_file(&format!(
                r#"{{"tokens":{{"access_token":"fixture-token","account_id":{account_json}}}}}"#
            ));
            if let Some(expected_header) = expected_header {
                let listener = TcpListener::bind("127.0.0.1:0").unwrap();
                let endpoint = format!("http://{}/", listener.local_addr().unwrap());
                let server = serve(listener, vec![response("200 OK", "", "{}")]);
                assert!(matches!(
                    runtime().block_on(fetch_with(&auth, &endpoint, Duration::from_secs(2))),
                    CodexUsageResult::Response { status: 200, .. }
                ));
                let requests = server.join().unwrap();
                assert!(
                    requests[0].contains(&format!("chatgpt-account-id: {expected_header}\r\n")),
                    "account JSON {account_json} produced request {request:?}",
                    request = requests[0]
                );
            } else {
                assert_eq!(
                    load_codex_credentials(&auth).map(|credentials| credentials.account),
                    None,
                    "account JSON {account_json} should be JavaScript-falsy"
                );
            }
            let _ = fs::remove_file(auth);
        }
    }

    #[test]
    fn missing_malformed_and_incomplete_auth_return_no_sessions() {
        let missing = std::env::temp_dir().join("codex-usage-missing-auth.json");
        let malformed = auth_file("{");
        let incomplete = auth_file(r#"{"tokens":{"access_token":"token"}}"#);
        let rt = runtime();
        assert_eq!(
            rt.block_on(fetch_with(
                &missing,
                "http://127.0.0.1/",
                Duration::from_secs(1)
            )),
            CodexUsageResult::NoSessions
        );
        assert_eq!(
            rt.block_on(fetch_with(
                &malformed,
                "http://127.0.0.1/",
                Duration::from_secs(1)
            )),
            CodexUsageResult::NoSessions
        );
        assert_eq!(
            rt.block_on(fetch_with(
                &incomplete,
                "http://127.0.0.1/",
                Duration::from_secs(1)
            )),
            CodexUsageResult::NoSessions
        );
        let _ = fs::remove_file(malformed);
        let _ = fs::remove_file(incomplete);
    }

    #[test]
    fn sends_get_headers_and_returns_status_retry_after_and_replacement_decoded_body() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}/", listener.local_addr().unwrap());
        let body = b"{\"value\":\"\xff\"}";
        let mut wire = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        )
        .into_bytes();
        wire.extend_from_slice(body);
        let server = serve_bytes(listener, vec![wire]);
        let auth = auth_file(r#"{"tokens":{"access_token":"token-123","account_id":"acct-456"}}"#);
        let credentials = load_codex_credentials(&auth).unwrap();
        let result = runtime().block_on(fetch_with_credentials(
            &credentials,
            &endpoint,
            Duration::from_secs(2),
        ));
        assert_eq!(
            result,
            CodexUsageResult::Response {
                status: 200,
                retry_after: None,
                body: Ok(Some("{\"value\":\"�\"}".to_owned())),
            }
        );
        let request = server.join().unwrap().remove(0).to_ascii_lowercase();
        assert!(request.starts_with("get / http/1.1\r\n"));
        assert!(request.contains("authorization: bearer token-123\r\n"));
        assert!(request.contains("chatgpt-account-id: acct-456\r\n"));
        let _ = fs::remove_file(auth);
    }

    #[test]
    fn credential_snapshot_survives_auth_file_rotation_between_attempts() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}/", listener.local_addr().unwrap());
        let server = serve(
            listener,
            vec![
                response("503 Service Unavailable", "", ""),
                response("200 OK", "", "{}"),
            ],
        );
        let auth =
            auth_file(r#"{"tokens":{"access_token":"account-A-token","account_id":"account-A"}}"#);
        let mut sessions = super::CodexUsageSessions::default();
        let handle = sessions.begin(&auth).unwrap();
        fs::write(
            &auth,
            r#"{"tokens":{"access_token":"account-B-token","account_id":"account-B"}}"#,
        )
        .unwrap();
        let rt = runtime();
        assert!(matches!(
            rt.block_on(fetch_with_credentials(
                sessions.credentials.get(&handle).unwrap(),
                &endpoint,
                Duration::from_secs(2)
            )),
            CodexUsageResult::Response { status: 503, .. }
        ));
        assert!(matches!(
            rt.block_on(fetch_with_credentials(
                sessions.credentials.get(&handle).unwrap(),
                &endpoint,
                Duration::from_secs(2)
            )),
            CodexUsageResult::Response { status: 200, .. }
        ));
        let requests = server.join().unwrap();
        assert!(requests.iter().all(|request| {
            request
                .to_ascii_lowercase()
                .contains("authorization: bearer account-a-token\r\n")
        }));
        assert!(requests.iter().all(|request| {
            request
                .to_ascii_lowercase()
                .contains("chatgpt-account-id: account-a\r\n")
        }));
        assert!(sessions.release(&handle));
        assert!(!sessions.release(&handle));
        assert_eq!(
            rt.block_on(sessions.fetch(&handle)),
            CodexUsageResult::NoSessions
        );
        let _ = fs::remove_file(auth);
    }

    #[test]
    fn missing_redirect_location_is_a_response_and_invalid_location_fails_fetch() {
        let auth = auth_file(r#"{"tokens":{"access_token":"t","account_id":"a"}}"#);
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}/", listener.local_addr().unwrap());
        let server = serve(listener, vec![response("302 Found", "", "")]);
        assert!(matches!(
            runtime().block_on(fetch_with(&auth, &endpoint, Duration::from_secs(2))),
            CodexUsageResult::Response { status: 302, .. }
        ));
        let _ = server.join().unwrap();

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}/", listener.local_addr().unwrap());
        let server = serve(
            listener,
            vec![response("302 Found", "Location: http://[invalid\r\n", "")],
        );
        assert_eq!(
            runtime().block_on(fetch_with(&auth, &endpoint, Duration::from_secs(2))),
            CodexUsageResult::TransportFailure
        );
        let _ = server.join().unwrap();
        let _ = fs::remove_file(auth);
    }

    #[test]
    fn follows_redirects_and_drops_authorization_when_origin_changes() {
        let first = TcpListener::bind("127.0.0.1:0").unwrap();
        let second = TcpListener::bind("127.0.0.1:0").unwrap();
        let second_url = format!("http://{}/end", second.local_addr().unwrap());
        let first_url = format!("http://{}/start", first.local_addr().unwrap());
        let first_server = serve(
            first,
            vec![response(
                "302 Found",
                &format!("Location: {second_url}\r\n"),
                "",
            )],
        );
        let second_server = serve(second, vec![response("200 OK", "", "ok")]);
        let auth = auth_file(
            r#"{"tokens":{"access_token":"private-token","account_id":"private-account"}}"#,
        );
        assert!(matches!(
            runtime().block_on(fetch_with(&auth, &first_url, Duration::from_secs(2))),
            CodexUsageResult::Response { status: 200, .. }
        ));
        let first_request = first_server.join().unwrap().remove(0).to_ascii_lowercase();
        let second_request = second_server.join().unwrap().remove(0).to_ascii_lowercase();
        assert!(first_request.contains("authorization: bearer private-token"));
        assert!(first_request.contains("chatgpt-account-id: private-account"));
        assert!(!second_request.contains("authorization:"));
        assert!(second_request.contains("chatgpt-account-id: private-account"));
        let _ = fs::remove_file(auth);
    }

    #[test]
    fn rejects_a_twenty_first_redirect() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}/", listener.local_addr().unwrap());
        let redirects = (0..21)
            .map(|_| response("302 Found", &format!("Location: {endpoint}\r\n"), ""))
            .collect();
        let server = serve(listener, redirects);
        let auth = auth_file(r#"{"tokens":{"access_token":"t","account_id":"a"}}"#);
        assert_eq!(
            runtime().block_on(fetch_with(&auth, &endpoint, Duration::from_secs(2))),
            CodexUsageResult::TransportFailure
        );
        assert_eq!(server.join().unwrap().len(), 21);
        let _ = fs::remove_file(auth);
    }

    #[test]
    fn preserves_non_success_status_and_retry_after() {
        for (status, status_line) in [
            (401, "401 Unauthorized"),
            (403, "403 Forbidden"),
            (429, "429 Too Many Requests"),
            (503, "503 Service Unavailable"),
        ] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let endpoint = format!("http://{}/", listener.local_addr().unwrap());
            let server = serve(
                listener,
                vec![response(status_line, "Retry-After: March 1, 2030\r\n", "")],
            );
            let auth = auth_file(r#"{"tokens":{"access_token":"t","account_id":"a"}}"#);
            assert_eq!(
                runtime().block_on(fetch_with(&auth, &endpoint, Duration::from_secs(2))),
                CodexUsageResult::Response {
                    status,
                    retry_after: Some("March 1, 2030".to_owned()),
                    body: Ok(None),
                }
            );
            let _ = server.join();
            let _ = fs::remove_file(auth);
        }
    }

    #[test]
    fn body_failure_is_classified_after_headers_and_non_success_status_keeps_retry_after() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}/", listener.local_addr().unwrap());
        let server = serve(
            listener,
            vec![response(
                "429 Too Many Requests",
                "Retry-After: 0x10\r\n",
                "",
            )],
        );
        let auth = auth_file(r#"{"tokens":{"access_token":"t","account_id":"a"}}"#);
        assert_eq!(
            runtime().block_on(fetch_with(&auth, &endpoint, Duration::from_secs(2))),
            CodexUsageResult::Response {
                status: 429,
                retry_after: Some("0x10".to_owned()),
                body: Ok(None),
            }
        );
        let _ = server.join().unwrap();
        let _ = fs::remove_file(auth);

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}/", listener.local_addr().unwrap());
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let _ = read_request(&mut stream);
            stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Length: 50\r\nConnection: close\r\n\r\nshort",
                )
                .unwrap();
        });
        let auth = auth_file(r#"{"tokens":{"access_token":"t","account_id":"a"}}"#);
        assert_eq!(
            runtime().block_on(fetch_with(&auth, &endpoint, Duration::from_secs(2))),
            CodexUsageResult::Response {
                status: 200,
                retry_after: None,
                body: Err(BodyReadFailure::Terminated),
            }
        );
        let _ = server.join();
        let _ = fs::remove_file(auth);
    }

    #[test]
    fn timeout_covers_headers_but_not_body_transfer() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}/", listener.local_addr().unwrap());
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let _ = read_request(&mut stream);
            thread::sleep(Duration::from_millis(80));
            let _ = stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok");
        });
        let auth = auth_file(r#"{"tokens":{"access_token":"t","account_id":"a"}}"#);
        assert_eq!(
            runtime().block_on(fetch_with(&auth, &endpoint, Duration::from_millis(20))),
            CodexUsageResult::TimeoutFailure
        );
        let _ = server.join();

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}/", listener.local_addr().unwrap());
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let _ = read_request(&mut stream);
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n")
                .unwrap();
            stream.flush().unwrap();
            thread::sleep(Duration::from_millis(80));
            stream.write_all(b"ok").unwrap();
        });
        let auth = auth_file(r#"{"tokens":{"access_token":"t","account_id":"a"}}"#);
        assert!(matches!(
            runtime().block_on(fetch_with(&auth, &endpoint, Duration::from_millis(40))),
            CodexUsageResult::Response { status: 200, body: Ok(Some(body)), .. } if body == "ok"
        ));
        let _ = server.join();
        let _ = fs::remove_file(auth);
    }

    #[test]
    fn redirect_hops_share_one_headers_deadline() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}/", listener.local_addr().unwrap());
        let server = thread::spawn(move || {
            let (mut first, _) = listener.accept().unwrap();
            let _ = read_request(&mut first);
            thread::sleep(Duration::from_millis(30));
            let _ = first.write_all(b"HTTP/1.1 302 Found\r\nLocation: /next\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
            let (mut second, _) = listener.accept().unwrap();
            let _ = read_request(&mut second);
            thread::sleep(Duration::from_millis(50));
            let _ = second
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok");
        });
        let auth = auth_file(r#"{"tokens":{"access_token":"t","account_id":"a"}}"#);
        assert_eq!(
            runtime().block_on(fetch_with(&auth, &endpoint, Duration::from_millis(60))),
            CodexUsageResult::TimeoutFailure
        );
        let _ = server.join();
        let _ = fs::remove_file(auth);
    }
}
