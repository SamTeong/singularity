use crate::http_attempt::{self, AttemptResult, BodyReadFailure};
use reqwest::Method;
use std::time::Duration;

const TOKEN_URL: &str = "https://console.anthropic.com/v1/oauth/token";
const HEADER_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, PartialEq, Eq)]
pub enum ClaudeOauthRefreshResult {
    TransportFailure,
    TimeoutFailure,
    Response {
        status: u16,
        retry_after: Option<String>,
        body: Result<Option<String>, BodyReadFailure>,
    },
}

pub async fn refresh_claude_oauth(body: &str, header_timeout_ms: u64) -> ClaudeOauthRefreshResult {
    let timeout = Duration::from_millis(header_timeout_ms.min(HEADER_TIMEOUT.as_millis() as u64));
    refresh_at(body, TOKEN_URL, timeout).await
}

async fn refresh_at(body: &str, endpoint: &str, timeout: Duration) -> ClaudeOauthRefreshResult {
    match http_attempt::send(
        endpoint,
        Method::POST,
        Some(body.as_bytes().to_vec()),
        Some("application/json"),
        None,
        &[],
        timeout,
    )
    .await
    {
        AttemptResult::TransportFailure => ClaudeOauthRefreshResult::TransportFailure,
        AttemptResult::TimeoutFailure => ClaudeOauthRefreshResult::TimeoutFailure,
        AttemptResult::Response {
            status,
            retry_after,
            body,
        } => ClaudeOauthRefreshResult::Response {
            status,
            retry_after,
            body,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::{ClaudeOauthRefreshResult, refresh_at};
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
        let headers = String::from_utf8_lossy(&bytes).into_owned();
        let length = headers
            .lines()
            .find_map(|line| {
                let (name, value) = line.split_once(':')?;
                name.eq_ignore_ascii_case("content-length")
                    .then(|| value.trim().parse::<usize>().ok())
                    .flatten()
            })
            .unwrap_or(0);
        let mut body = vec![0; length];
        let _ = stream.read_exact(&mut body);
        format!("{headers}{}", String::from_utf8_lossy(&body))
    }

    fn run_redirect(status: u16, body: &str) -> (String, String) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}/start", listener.local_addr().unwrap());
        let server = thread::spawn(move || {
            let (mut first, _) = listener.accept().unwrap();
            let first_request = request(&mut first);
            let response = format!(
                "HTTP/1.1 {status} Redirect\r\nLocation: /next\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            );
            first.write_all(response.as_bytes()).unwrap();
            drop(first);
            let (mut second, _) = listener.accept().unwrap();
            let second_request = request(&mut second);
            second
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}")
                .unwrap();
            (first_request, second_request)
        });
        let result = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(refresh_at(body, &endpoint, Duration::from_secs(2)));
        assert!(matches!(
            result,
            ClaudeOauthRefreshResult::Response { status: 200, .. }
        ));
        server.join().unwrap()
    }

    #[test]
    fn fixed_post_redirects_rewrite_or_replay_body() {
        assert_eq!(
            super::TOKEN_URL,
            "https://console.anthropic.com/v1/oauth/token"
        );
        let body = "{\"grant_type\":\"refresh_token\",\"refresh_token\":\"synthetic\"}";
        for status in [301, 302, 303, 307, 308] {
            let (first, second) = run_redirect(status, body);
            assert!(first.starts_with("POST /start HTTP/1.1\r\n"));
            assert!(
                first
                    .to_ascii_lowercase()
                    .contains("content-type: application/json\r\n")
            );
            assert!(first.ends_with(body));
            if matches!(status, 307 | 308) {
                assert!(second.starts_with("POST /next HTTP/1.1\r\n"));
                assert!(second.ends_with(body));
                assert!(
                    second
                        .to_ascii_lowercase()
                        .contains("content-type: application/json\r\n")
                );
            } else {
                assert!(second.starts_with("GET /next HTTP/1.1\r\n"));
                assert!(!second.to_ascii_lowercase().contains("content-type:"));
                assert!(!second.ends_with(body));
            }
        }
    }

    #[test]
    fn rejects_non_http_and_userinfo_targets_without_exposing_request_body() {
        let body = "synthetic-private-refresh-token";
        let result = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(refresh_at(
                body,
                "ftp://example.test/token",
                Duration::from_secs(1),
            ));
        assert_eq!(result, ClaudeOauthRefreshResult::TransportFailure);
        assert!(!format!("{result:?}").contains(body));
        let result = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(refresh_at(
                body,
                "http://user:pass@example.test/token",
                Duration::from_secs(1),
            ));
        assert_eq!(result, ClaudeOauthRefreshResult::TransportFailure);
        assert!(!format!("{result:?}").contains(body));
    }

    #[test]
    fn redirect_limit_and_non_success_retry_after_are_preserved() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}/again", listener.local_addr().unwrap());
        let server = thread::spawn(move || {
            for _ in 0..=20 {
                let (mut stream, _) = listener.accept().unwrap();
                let _ = request(&mut stream);
                stream
                    .write_all(b"HTTP/1.1 302 Found\r\nLocation: /again\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                    .unwrap();
            }
        });
        let body = "synthetic-private-refresh-token";
        let result = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(refresh_at(body, &endpoint, Duration::from_secs(3)));
        assert_eq!(result, ClaudeOauthRefreshResult::TransportFailure);
        assert!(!format!("{result:?}").contains(body));
        server.join().unwrap();

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}/token", listener.local_addr().unwrap());
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let _ = request(&mut stream);
            stream.write_all(b"HTTP/1.1 429 Too Many Requests\r\nRetry-After: Wed, 21 Oct 2015 07:28:00 GMT\r\nContent-Length: 12\r\nConnection: close\r\n\r\nprivate-body").unwrap();
        });
        let result = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(refresh_at(body, &endpoint, Duration::from_secs(2)));
        assert_eq!(
            result,
            ClaudeOauthRefreshResult::Response {
                status: 429,
                retry_after: Some("Wed, 21 Oct 2015 07:28:00 GMT".into()),
                body: Ok(None),
            }
        );
        assert!(!format!("{result:?}").contains("private-body"));
        server.join().unwrap();
    }
}
