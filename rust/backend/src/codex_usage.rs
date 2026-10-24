use crate::http_attempt::{self, AttemptResult};
use crate::retry_after::retry_after_ms;
use serde_json::Value;
use std::fs;
use std::future::Future;
use std::path::Path;
use std::time::Duration;

pub use crate::http_attempt::BodyReadFailure;

const USAGE_URL: &str = "https://chatgpt.com/backend-api/wham/usage";
const HEADER_TIMEOUT: Duration = Duration::from_millis(10_000);
const MAX_ATTEMPTS: u32 = 3;
const RETRYABLE: &[u16] = &[408, 429, 500, 502, 503, 504];
const MAX_RETRY_AFTER_MS: f64 = 5_000.0;

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

/// Performs one logical live Codex usage request, retrying inside the Rust operation.
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
    let authorization = format!("Bearer {}", credentials.token);
    let extra_headers = [("ChatGPT-Account-Id", credentials.account.as_str())];
    let result = fetch_with_retries(
        header_timeout,
        |timeout| fetch_attempt(endpoint, &authorization, &extra_headers, timeout),
        current_time_ms,
        |duration| async move { tokio::time::sleep(duration).await },
        jitter,
    )
    .await;
    match result {
        AttemptResult::TransportFailure => CodexUsageResult::TransportFailure,
        AttemptResult::TimeoutFailure => CodexUsageResult::TimeoutFailure,
        AttemptResult::Response {
            status,
            retry_after,
            body,
        } => CodexUsageResult::Response {
            status,
            retry_after,
            body,
        },
    }
}

async fn fetch_attempt(
    endpoint: &str,
    authorization: &str,
    extra_headers: &[(&str, &str)],
    header_timeout: Duration,
) -> AttemptResult {
    http_attempt::get(endpoint, Some(authorization), extra_headers, header_timeout).await
}

async fn fetch_with_retries<H, Fut, C, S, SF, R>(
    initial_timeout: Duration,
    mut attempt_request: H,
    mut now_ms: C,
    mut sleep: S,
    mut random: R,
) -> AttemptResult
where
    H: FnMut(Duration) -> Fut,
    Fut: Future<Output = AttemptResult>,
    C: FnMut() -> i64,
    S: FnMut(Duration) -> SF,
    SF: Future<Output = ()>,
    R: FnMut() -> f64,
{
    for attempt in 1..=MAX_ATTEMPTS {
        let timeout = if attempt == 1 {
            initial_timeout
        } else {
            HEADER_TIMEOUT
        };
        let result = attempt_request(timeout).await;
        let response_time_ms = now_ms();
        match result {
            AttemptResult::TransportFailure => {
                if attempt == MAX_ATTEMPTS {
                    return AttemptResult::TransportFailure;
                }
                sleep(backoff(attempt, &mut random)).await;
            }
            AttemptResult::TimeoutFailure => {
                if attempt == MAX_ATTEMPTS {
                    return AttemptResult::TimeoutFailure;
                }
                sleep(backoff(attempt, &mut random)).await;
            }
            AttemptResult::Response {
                status,
                retry_after,
                body,
            } => {
                if status == 200 || !RETRYABLE.contains(&status) || attempt == MAX_ATTEMPTS {
                    return AttemptResult::Response {
                        status,
                        retry_after,
                        body,
                    };
                }
                let retry_delay_ms = if status == 429 {
                    retry_after_ms(retry_after.as_deref(), response_time_ms)
                } else {
                    None
                };
                if retry_delay_ms.is_some_and(|ms| ms > MAX_RETRY_AFTER_MS) {
                    return AttemptResult::Response {
                        status,
                        retry_after,
                        body,
                    };
                }
                let delay = retry_delay_ms.map_or_else(
                    || backoff(attempt, &mut random),
                    duration_from_retry_after_ms,
                );
                sleep(delay).await;
            }
        }
    }
    unreachable!("three attempts always return")
}

fn duration_from_retry_after_ms(ms: f64) -> Duration {
    if !ms.is_finite() || !(1.0..=2_147_483_647.0).contains(&ms) {
        Duration::from_millis(1)
    } else {
        Duration::from_millis(ms.trunc() as u64)
    }
}

fn backoff(attempt: u32, random: &mut impl FnMut() -> f64) -> Duration {
    let ceiling = 250_u64.saturating_mul(1_u64 << (attempt - 1)).min(5_000);
    Duration::from_millis((ceiling as f64 * random().clamp(0.0, 1.0)) as u64)
}

fn current_time_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn jitter() -> f64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .subsec_nanos() as f64
        / 1_000_000_000.0
}

#[cfg(test)]
mod retry_tests {
    use super::{backoff, fetch_with_retries};
    use crate::http_attempt::{AttemptResult, BodyReadFailure};
    use crate::retry_after::retry_after_ms;
    use std::collections::VecDeque;
    use std::time::Duration;

    fn response(status: u16, retry_after: Option<&str>) -> AttemptResult {
        AttemptResult::Response {
            status,
            retry_after: retry_after.map(str::to_owned),
            body: if status == 200 {
                Ok(Some("{}".to_owned()))
            } else {
                Ok(None)
            },
        }
    }

    fn run<F: std::future::Future>(future: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(future)
    }

    #[test]
    fn retries_only_the_transient_statuses_and_transport_errors() {
        for status in [408, 429, 500, 502, 503, 504] {
            let mut results = VecDeque::from([response(status, None), response(200, None)]);
            let mut calls = 0;
            let result = run(fetch_with_retries(
                Duration::from_secs(10),
                |_| {
                    calls += 1;
                    std::future::ready(results.pop_front().unwrap())
                },
                || 0,
                |_| std::future::ready(()),
                || 0.5,
            ));
            assert_eq!(calls, 2, "status {status}");
            assert!(matches!(
                result,
                AttemptResult::Response { status: 200, .. }
            ));
        }
        for status in [400, 401, 403, 404, 501] {
            let mut calls = 0;
            let result = run(fetch_with_retries(
                Duration::from_secs(10),
                |_| {
                    calls += 1;
                    std::future::ready(response(status, None))
                },
                || 0,
                |_| std::future::ready(()),
                || 0.5,
            ));
            assert_eq!(calls, 1, "status {status}");
            assert!(
                matches!(result, AttemptResult::Response { status: actual, .. } if actual == status)
            );
        }
        for failure in [
            AttemptResult::TransportFailure,
            AttemptResult::TimeoutFailure,
        ] {
            let mut results = VecDeque::from([failure, response(200, None)]);
            let mut calls = 0;
            let result = run(fetch_with_retries(
                Duration::from_secs(10),
                |_| {
                    calls += 1;
                    std::future::ready(results.pop_front().unwrap())
                },
                || 0,
                |_| std::future::ready(()),
                || 0.5,
            ));
            assert_eq!(calls, 2);
            assert!(matches!(
                result,
                AttemptResult::Response { status: 200, .. }
            ));
        }
    }

    #[test]
    fn caps_attempts_and_preserves_terminal_body_failures() {
        for failure in [
            AttemptResult::TransportFailure,
            AttemptResult::TimeoutFailure,
        ] {
            let mut calls = 0;
            let result = run(fetch_with_retries(
                Duration::from_secs(10),
                |_| {
                    calls += 1;
                    std::future::ready(failure_variant(&failure))
                },
                || 0,
                |_| std::future::ready(()),
                || 1.0,
            ));
            assert_eq!(calls, 3);
            assert_eq!(result, failure);
        }
        let mut calls = 0;
        let result = run(fetch_with_retries(
            Duration::from_secs(10),
            |_| {
                calls += 1;
                std::future::ready(AttemptResult::Response {
                    status: 200,
                    retry_after: None,
                    body: Err(BodyReadFailure::Terminated),
                })
            },
            || 0,
            |_| std::future::ready(()),
            || 0.5,
        ));
        assert_eq!(calls, 1);
        assert!(matches!(
            result,
            AttemptResult::Response {
                body: Err(BodyReadFailure::Terminated),
                ..
            }
        ));
    }

    #[test]
    fn each_retry_starts_with_the_fixed_header_timeout() {
        let mut timeouts = Vec::new();
        let result = run(fetch_with_retries(
            Duration::from_millis(10_000),
            |timeout| {
                timeouts.push(timeout);
                std::future::ready(response(503, None))
            },
            || 0,
            |_| std::future::ready(()),
            || 0.0,
        ));
        assert_eq!(
            timeouts,
            [
                Duration::from_millis(10_000),
                Duration::from_millis(10_000),
                Duration::from_millis(10_000),
            ]
        );
        assert!(matches!(
            result,
            AttemptResult::Response { status: 503, .. }
        ));
    }

    fn failure_variant(failure: &AttemptResult) -> AttemptResult {
        match failure {
            AttemptResult::TransportFailure => AttemptResult::TransportFailure,
            AttemptResult::TimeoutFailure => AttemptResult::TimeoutFailure,
            _ => unreachable!(),
        }
    }

    #[test]
    fn jitter_uses_exponential_bounds_and_retry_after_uses_response_anchor() {
        assert_eq!(backoff(1, &mut || 0.0), Duration::ZERO);
        assert_eq!(backoff(1, &mut || 1.0), Duration::from_millis(250));
        assert_eq!(backoff(2, &mut || 0.5), Duration::from_millis(250));
        assert_eq!(backoff(3, &mut || 1.0), Duration::from_millis(1_000));
        assert_eq!(backoff(6, &mut || 1.0), Duration::from_millis(5_000));

        let mut results = VecDeque::from([
            response(429, Some("2030-03-01T00:00:02Z")),
            response(200, None),
        ]);
        let mut sleeps = Vec::new();
        let result = run(fetch_with_retries(
            Duration::from_secs(10),
            |_| std::future::ready(results.pop_front().unwrap()),
            || 1_898_553_600_000,
            |delay| {
                sleeps.push(delay);
                std::future::ready(())
            },
            || 0.5,
        ));
        assert!(matches!(
            result,
            AttemptResult::Response { status: 200, .. }
        ));
        assert_eq!(sleeps, [Duration::from_secs(2)]);

        let vectors: Vec<serde_json::Value> = serde_json::from_str(include_str!(
            "../../../server/fixtures/retry-after-parity.json"
        ))
        .unwrap();
        for vector in vectors {
            let value = vector["value"].as_str();
            let anchor = vector["anchor"].as_i64().unwrap();
            let expected = vector["expected"]
                .as_f64()
                .or_else(|| (vector["expected"] == "Infinity").then_some(f64::INFINITY));
            assert_eq!(retry_after_ms(value, anchor), expected, "{value:?}");
        }

        for (header, expected_calls) in [("5", 3), ("5.001", 1)] {
            let mut calls = 0;
            let result = run(fetch_with_retries(
                Duration::from_secs(10),
                |_| {
                    calls += 1;
                    std::future::ready(response(429, Some(header)))
                },
                || 0,
                |_| std::future::ready(()),
                || 0.5,
            ));
            assert_eq!(calls, expected_calls, "Retry-After {header}");
            assert!(matches!(
                result,
                AttemptResult::Response { status: 429, .. }
            ));
        }
    }
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
        BodyReadFailure, CodexUsageResult, fetch_attempt, fetch_with, fetch_with_credentials,
        js_string, js_truthy, load_codex_credentials,
    };
    use crate::http_attempt::AttemptResult;
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

    fn accept_bounded(listener: &TcpListener) -> Option<TcpStream> {
        if let Err(error) = listener.set_nonblocking(true) {
            eprintln!("loopback fixture accept setup failed: {error}");
            return None;
        }
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        loop {
            match listener.accept() {
                Ok((stream, _)) => {
                    if let Err(error) = stream.set_nonblocking(false) {
                        eprintln!("loopback fixture stream setup failed: {error}");
                        return None;
                    }
                    if let Err(error) = stream.set_write_timeout(Some(Duration::from_secs(2))) {
                        eprintln!("loopback fixture write timeout setup failed: {error}");
                        return None;
                    }
                    return Some(stream);
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    if std::time::Instant::now() >= deadline {
                        eprintln!("loopback fixture accept deadline expired");
                        return None;
                    }
                    thread::sleep(Duration::from_millis(10));
                }
                Err(error) => {
                    eprintln!("loopback fixture accept failed: {error}");
                    return None;
                }
            }
        }
    }

    fn serve(listener: TcpListener, responses: Vec<String>) -> thread::JoinHandle<Vec<String>> {
        listener.set_nonblocking(true).unwrap();
        thread::spawn(move || {
            let mut requests = Vec::new();
            for response in responses {
                let Some(mut stream) = accept_bounded(&listener) else {
                    break;
                };
                requests.push(read_request(&mut stream));
                stream.write_all(response.as_bytes()).unwrap();
            }
            requests
        })
    }

    fn serve_bytes(
        listener: TcpListener,
        responses: Vec<Vec<u8>>,
    ) -> thread::JoinHandle<Vec<String>> {
        listener.set_nonblocking(true).unwrap();
        thread::spawn(move || {
            let mut requests = Vec::new();
            for response in responses {
                let Some(mut stream) = accept_bounded(&listener) else {
                    break;
                };
                requests.push(read_request(&mut stream));
                stream.write_all(&response).unwrap();
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
    fn fixture_reads_headers_after_client_delays_its_request() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = serve(listener, vec![response("200 OK", "", "ok")]);
        let mut client = TcpStream::connect(address).unwrap();
        client
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        client
            .set_write_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        thread::sleep(Duration::from_millis(50));
        client
            .write_all(b"GET /fixture HTTP/1.1\r\nHost: localhost\r\n\r\n")
            .unwrap();
        let mut response = Vec::new();
        client.read_to_end(&mut response).unwrap();
        let (joined, join_result) = std::sync::mpsc::channel();
        thread::spawn(move || joined.send(server.join()).unwrap());
        let requests = join_result
            .recv_timeout(Duration::from_secs(6))
            .expect("fixture thread should finish within its accept/read bounds")
            .unwrap();

        assert_eq!(requests.len(), 1, "fixture should accept the client");
        assert_eq!(
            requests[0], "GET /fixture HTTP/1.1\r\nHost: localhost\r\n\r\n",
            "fixture should read complete headers after the delayed write"
        );
        assert!(
            response.ends_with(b"ok"),
            "fixture should send its response"
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
                let result =
                    runtime().block_on(fetch_with(&auth, &endpoint, Duration::from_secs(2)));
                let requests = server.join().unwrap();
                assert!(matches!(
                    result,
                    CodexUsageResult::Response { status: 200, .. }
                ));
                assert!(
                    requests.first().is_some_and(|request| request
                        .contains(&format!("chatgpt-account-id: {expected_header}\r\n"))),
                    "account JSON {account_json} should produce its expected account header"
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
        let requests = server.join().unwrap();
        assert_eq!(
            result,
            CodexUsageResult::Response {
                status: 200,
                retry_after: None,
                body: Ok(Some("{\"value\":\"�\"}".to_owned())),
            }
        );
        let request = requests[0].to_ascii_lowercase();
        assert!(request.starts_with("get / http/1.1\r\n"));
        assert!(request.contains("authorization: bearer token-123\r\n"));
        assert!(request.contains("chatgpt-account-id: acct-456\r\n"));
        let _ = fs::remove_file(auth);
    }

    #[test]
    fn credential_snapshot_survives_auth_file_rotation_between_attempts() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}/", listener.local_addr().unwrap());
        let auth =
            auth_file(r#"{"tokens":{"access_token":"account-A-token","account_id":"account-A"}}"#);
        listener.set_nonblocking(true).unwrap();
        let server_auth = auth.clone();
        let server = thread::spawn(move || {
            let mut requests = Vec::new();
            for (index, wire) in [
                response("503 Service Unavailable", "", ""),
                response("503 Service Unavailable", "", ""),
                response("503 Service Unavailable", "", ""),
                response("200 OK", "", "{}"),
            ]
            .into_iter()
            .enumerate()
            {
                let Some(mut stream) = accept_bounded(&listener) else {
                    break;
                };
                requests.push(read_request(&mut stream));
                stream.write_all(wire.as_bytes()).unwrap();
                if index == 0 {
                    fs::write(
                        &server_auth,
                        r#"{"tokens":{"access_token":"account-B-token","account_id":"account-B"}}"#,
                    )
                    .unwrap();
                }
            }
            requests
        });
        let mut sessions = super::CodexUsageSessions::default();
        let handle = sessions.begin(&auth).unwrap();
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
        assert_eq!(
            requests.len(),
            4,
            "first logical fetch makes three attempts"
        );
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
            let responses = if status == 503 {
                vec![response(status_line, "Retry-After: March 1, 2030\r\n", ""); 3]
            } else {
                vec![response(status_line, "Retry-After: March 1, 2030\r\n", "")]
            };
            let server = serve(listener, responses);
            let auth = auth_file(r#"{"tokens":{"access_token":"t","account_id":"a"}}"#);
            let result = runtime().block_on(fetch_with(&auth, &endpoint, Duration::from_secs(2)));
            let requests = server.join().unwrap();
            assert_eq!(
                result,
                CodexUsageResult::Response {
                    status,
                    retry_after: Some("March 1, 2030".to_owned()),
                    body: Ok(None),
                }
            );
            assert_eq!(requests.len(), if status == 503 { 3 } else { 1 });
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
        listener.set_nonblocking(true).unwrap();
        let server = thread::spawn(move || {
            let Some(mut stream) = accept_bounded(&listener) else {
                return;
            };
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
            let Some(mut stream) = accept_bounded(&listener) else {
                return;
            };
            let _ = read_request(&mut stream);
            thread::sleep(Duration::from_millis(80));
            let _ = stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok");
        });
        assert_eq!(
            runtime().block_on(fetch_attempt(
                &endpoint,
                "Bearer t",
                &[("ChatGPT-Account-Id", "a")],
                Duration::from_millis(20)
            )),
            AttemptResult::TimeoutFailure
        );
        let _ = server.join();

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}/", listener.local_addr().unwrap());
        listener.set_nonblocking(true).unwrap();
        let server = thread::spawn(move || {
            let Some(mut stream) = accept_bounded(&listener) else {
                return;
            };
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
        listener.set_nonblocking(true).unwrap();
        let server = thread::spawn(move || {
            let Some(mut first) = accept_bounded(&listener) else {
                return;
            };
            let _ = read_request(&mut first);
            thread::sleep(Duration::from_millis(30));
            let _ = first.write_all(b"HTTP/1.1 302 Found\r\nLocation: /next\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
            let Some(mut second) = accept_bounded(&listener) else {
                return;
            };
            let _ = read_request(&mut second);
            thread::sleep(Duration::from_millis(50));
            let _ = second
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok");
        });
        let auth = auth_file(r#"{"tokens":{"access_token":"t","account_id":"a"}}"#);
        assert_eq!(
            runtime().block_on(fetch_attempt(
                &endpoint,
                "Bearer t",
                &[("ChatGPT-Account-Id", "a")],
                Duration::from_millis(60)
            )),
            AttemptResult::TimeoutFailure
        );
        let _ = server.join();
        let _ = fs::remove_file(auth);
    }
}
