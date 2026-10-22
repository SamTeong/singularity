use crate::http_attempt::{self, AttemptResult, BodyReadFailure};
use std::time::Duration;

const USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
const HEADER_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, PartialEq, Eq)]
pub enum ClaudeUsageResult {
    TransportFailure,
    TimeoutFailure,
    Response {
        status: u16,
        retry_after: Option<String>,
        body: Result<Option<String>, BodyReadFailure>,
    },
}

pub async fn fetch_claude_usage(access_token: &str, header_timeout_ms: u64) -> ClaudeUsageResult {
    let timeout = Duration::from_millis(header_timeout_ms.min(HEADER_TIMEOUT.as_millis() as u64));
    fetch_claude_usage_at(access_token, USAGE_URL, timeout).await
}

async fn fetch_claude_usage_at(
    access_token: &str,
    endpoint: &str,
    timeout: Duration,
) -> ClaudeUsageResult {
    let authorization = format!("Bearer {access_token}");
    match http_attempt::get(
        endpoint,
        Some(&authorization),
        &[("anthropic-beta", "oauth-2025-04-20")],
        timeout,
    )
    .await
    {
        AttemptResult::TransportFailure => ClaudeUsageResult::TransportFailure,
        AttemptResult::TimeoutFailure => ClaudeUsageResult::TimeoutFailure,
        AttemptResult::Response {
            status,
            retry_after,
            body,
        } => ClaudeUsageResult::Response {
            status,
            retry_after,
            body,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::{ClaudeUsageResult, fetch_claude_usage_at};
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::thread;
    use std::time::Duration;

    fn request(stream: &mut TcpStream) -> String {
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let mut bytes = Vec::new();
        let mut byte = [0];
        while !bytes.ends_with(b"\r\n\r\n") {
            if stream.read(&mut byte).unwrap_or(0) == 0 {
                break;
            }
            bytes.push(byte[0]);
        }
        String::from_utf8_lossy(&bytes).into_owned()
    }

    #[test]
    fn fixed_usage_contract_and_token_redaction() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}/api/oauth/usage", listener.local_addr().unwrap());
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let received = request(&mut stream);
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}")
                .unwrap();
            received
        });
        let token = "synthetic-claude-token";
        let result = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(fetch_claude_usage_at(
                token,
                &endpoint,
                Duration::from_secs(2),
            ));
        assert!(matches!(
            result,
            ClaudeUsageResult::Response { status: 200, .. }
        ));
        let headers = server.join().unwrap().to_ascii_lowercase();
        assert!(headers.starts_with("get /api/oauth/usage http/1.1\r\n"));
        assert!(headers.contains("authorization: bearer synthetic-claude-token\r\n"));
        assert!(headers.contains("anthropic-beta: oauth-2025-04-20\r\n"));
        assert_eq!(
            super::USAGE_URL,
            "https://api.anthropic.com/api/oauth/usage"
        );
    }

    #[test]
    fn non_success_body_is_not_returned_and_network_errors_are_redacted() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}/", listener.local_addr().unwrap());
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let _ = request(&mut stream);
            stream.write_all(b"HTTP/1.1 429 Too Many Requests\r\nRetry-After: 66\r\nContent-Length: 10\r\nConnection: close\r\n\r\nsecretbody").unwrap();
        });
        let token = "synthetic-private-token";
        let result = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(fetch_claude_usage_at(
                token,
                &endpoint,
                Duration::from_secs(2),
            ));
        assert_eq!(
            result,
            ClaudeUsageResult::Response {
                status: 429,
                retry_after: Some("66".into()),
                body: Ok(None)
            }
        );
        assert!(!format!("{result:?}").contains(token));
        server.join().unwrap();
        let failure = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(fetch_claude_usage_at(
                token,
                "not a URL",
                Duration::from_secs(2),
            ));
        assert_eq!(failure, ClaudeUsageResult::TransportFailure);
        assert!(!format!("{failure:?}").contains(token));
    }
}
