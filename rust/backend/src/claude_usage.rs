use crate::http_attempt::{self, AttemptResult, BodyReadFailure};
use crate::retry_after::retry_after_ms;
use std::future::Future;
use std::time::Duration;

const USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
const HEADER_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_ATTEMPTS: u32 = 3;
const RETRYABLE: &[u16] = &[408, 429, 500, 502, 503, 504];
const MAX_RETRY_AFTER_MS: f64 = 5_000.0;

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
    let initial_timeout =
        Duration::from_millis(header_timeout_ms.min(HEADER_TIMEOUT.as_millis() as u64));
    let authorization = format!("Bearer {access_token}");
    let extra_headers = [("anthropic-beta", "oauth-2025-04-20")];
    fetch_with(
        initial_timeout,
        |timeout| http_attempt::get(USAGE_URL, Some(&authorization), &extra_headers, timeout),
        current_time_ms,
        |duration| async move { tokio::time::sleep(duration).await },
        jitter,
    )
    .await
}

async fn fetch_claude_usage_at(
    access_token: &str,
    endpoint: &str,
    timeout: Duration,
) -> ClaudeUsageResult {
    let authorization = format!("Bearer {access_token}");
    let extra_headers = [("anthropic-beta", "oauth-2025-04-20")];
    match http_attempt::get(endpoint, Some(&authorization), &extra_headers, timeout).await {
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
async fn fetch_with<H, Fut, C, S, SF, R>(
    initial_timeout: Duration,
    mut attempt_request: H,
    mut now_ms: C,
    mut sleep: S,
    mut random: R,
) -> ClaudeUsageResult
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
                    return ClaudeUsageResult::TransportFailure;
                }
                sleep(backoff(attempt, &mut random)).await;
            }
            AttemptResult::TimeoutFailure => {
                if attempt == MAX_ATTEMPTS {
                    return ClaudeUsageResult::TimeoutFailure;
                }
                sleep(backoff(attempt, &mut random)).await;
            }
            AttemptResult::Response {
                status,
                retry_after,
                body,
            } => {
                if status == 200 || !RETRYABLE.contains(&status) || attempt == MAX_ATTEMPTS {
                    return ClaudeUsageResult::Response {
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
                // Apply the strict business cutoff to the original delay before timer coercion.
                if retry_delay_ms.is_some_and(|ms| ms > MAX_RETRY_AFTER_MS) {
                    return ClaudeUsageResult::Response {
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
    // Node normalizes out-of-range values to 1 ms, then truncates accepted fractions.
    if !ms.is_finite() || !(1.0..=2_147_483_647.0).contains(&ms) {
        Duration::from_millis(1)
    } else {
        Duration::from_millis(ms.trunc() as u64)
    }
}

fn backoff(attempt: u32, random: &mut impl FnMut() -> f64) -> Duration {
    let ceiling = 250_u64.saturating_mul(1_u64 << (attempt - 1)).min(5_000);
    let millis = (ceiling as f64 * random().clamp(0.0, 1.0)) as u64;
    Duration::from_millis(millis)
}

fn jitter() -> f64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    let ticks = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .subsec_nanos();
    ticks as f64 / 1_000_000_000.0
}

#[cfg(test)]
mod http_contract_tests {
    use super::{ClaudeUsageResult, USAGE_URL, fetch_claude_usage_at};
    use std::time::Duration as HttpContractDuration;
    #[test]
    fn fixed_usage_contract_and_token_redaction() {
        use std::io::{Read, Write};
        use std::net::TcpListener;
        use std::thread;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}/api/oauth/usage", listener.local_addr().unwrap());
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut bytes = Vec::new();
            let mut byte = [0];
            while !bytes.ends_with(b"\r\n\r\n") {
                if stream.read(&mut byte).unwrap_or(0) == 0 {
                    break;
                }
                bytes.push(byte[0]);
            }
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}")
                .unwrap();
            String::from_utf8_lossy(&bytes).into_owned()
        });
        let token = "synthetic-claude-token";
        let result = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(fetch_claude_usage_at(
                token,
                &endpoint,
                HttpContractDuration::from_secs(2),
            ));
        assert!(matches!(
            result,
            ClaudeUsageResult::Response { status: 200, .. }
        ));
        let headers = server.join().unwrap().to_ascii_lowercase();
        assert!(headers.starts_with("get /api/oauth/usage http/1.1\r\n"));
        assert!(headers.contains("authorization: bearer synthetic-claude-token\r\n"));
        assert!(headers.contains("anthropic-beta: oauth-2025-04-20\r\n"));
        assert_eq!(USAGE_URL, "https://api.anthropic.com/api/oauth/usage");
    }

    #[test]
    fn non_success_body_is_not_returned_and_network_errors_are_redacted() {
        use std::io::{Read, Write};
        use std::net::TcpListener;
        use std::thread;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}/", listener.local_addr().unwrap());
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut bytes = Vec::new();
            let mut byte = [0];
            while !bytes.ends_with(b"\r\n\r\n") {
                if stream.read(&mut byte).unwrap_or(0) == 0 {
                    break;
                }
                bytes.push(byte[0]);
            }
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
                HttpContractDuration::from_secs(2),
            ));
        assert_eq!(
            result,
            ClaudeUsageResult::Response {
                status: 429,
                retry_after: Some("66".into()),
                body: Ok(None),
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
                HttpContractDuration::from_secs(2),
            ));
        assert_eq!(failure, ClaudeUsageResult::TransportFailure);
        assert!(!format!("{failure:?}").contains(token));
    }
}

fn current_time_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::{
        AttemptResult, BodyReadFailure, ClaudeUsageResult, duration_from_retry_after_ms, fetch_with,
    };
    use std::collections::VecDeque;
    use std::future::Future;
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

    fn run<F: Future>(future: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(future)
    }

    #[test]
    fn retries_recompute_timeout_and_stop_at_retry_after_cutoff_without_sleeping() {
        let mut results = VecDeque::from([response(503, None), response(429, Some("5.0001"))]);
        let mut timeouts = Vec::new();
        let mut sleeps = Vec::new();
        let result = run(fetch_with(
            Duration::from_millis(321),
            |timeout| {
                timeouts.push(timeout);
                std::future::ready(results.pop_front().unwrap())
            },
            || 1_900_000_000_000,
            |duration| {
                sleeps.push(duration);
                std::future::ready(())
            },
            || 0.0,
        ));
        assert_eq!(
            result,
            ClaudeUsageResult::Response {
                status: 429,
                retry_after: Some("5.0001".to_owned()),
                body: Ok(None),
            }
        );
        assert_eq!(
            timeouts,
            [Duration::from_millis(321), Duration::from_secs(10)]
        );
        assert_eq!(sleeps.len(), 1);
        assert_eq!(sleeps[0], Duration::ZERO);
    }

    #[test]
    fn retry_after_schedule_matches_node_timer_coercion() {
        assert_eq!(duration_from_retry_after_ms(0.0), Duration::from_millis(1));
        assert_eq!(duration_from_retry_after_ms(0.5), Duration::from_millis(1));
        assert_eq!(
            duration_from_retry_after_ms(0.999),
            Duration::from_millis(1)
        );
        assert_eq!(duration_from_retry_after_ms(1.0), Duration::from_millis(1));
        assert_eq!(duration_from_retry_after_ms(1.1), Duration::from_millis(1));
        assert_eq!(
            duration_from_retry_after_ms(1.999),
            Duration::from_millis(1)
        );
        assert_eq!(duration_from_retry_after_ms(2.5), Duration::from_millis(2));
        assert_eq!(
            duration_from_retry_after_ms(4_999.5),
            Duration::from_millis(4_999)
        );
        assert_eq!(
            duration_from_retry_after_ms(5_000.0),
            Duration::from_millis(5_000)
        );
    }

    #[test]
    fn transport_failure_retries_and_terminal_body_is_preserved() {
        let mut results = VecDeque::from([AttemptResult::TransportFailure, response(200, None)]);
        let mut calls = 0;
        let result = run(fetch_with(
            Duration::from_secs(2),
            |_| {
                calls += 1;
                std::future::ready(results.pop_front().unwrap())
            },
            || 0,
            |_| std::future::ready(()),
            || 0.5,
        ));
        assert_eq!(calls, 2);
        assert_eq!(
            result,
            ClaudeUsageResult::Response {
                status: 200,
                retry_after: None,
                body: Ok(Some("{}".to_owned())),
            }
        );
        let _: Result<Option<String>, BodyReadFailure> = Ok(None);
    }

    #[test]
    fn timeout_failure_retries_with_fresh_timeout_and_backoff() {
        let mut results = VecDeque::from([AttemptResult::TimeoutFailure, response(200, None)]);
        let mut timeouts = Vec::new();
        let mut sleeps = Vec::new();
        let result = run(fetch_with(
            Duration::from_millis(321),
            |timeout| {
                timeouts.push(timeout);
                std::future::ready(results.pop_front().unwrap())
            },
            || 0,
            |duration| {
                sleeps.push(duration);
                std::future::ready(())
            },
            || 0.5,
        ));
        assert_eq!(
            timeouts,
            [Duration::from_millis(321), Duration::from_secs(10)]
        );
        assert_eq!(sleeps, [Duration::from_millis(125)]);
        assert_eq!(
            result,
            ClaudeUsageResult::Response {
                status: 200,
                retry_after: None,
                body: Ok(Some("{}".to_owned())),
            }
        );
    }

    #[test]
    fn status_matrix_retries_only_the_claude_transient_set() {
        for status in [408, 429, 500, 502, 503, 504] {
            let mut results = VecDeque::from([response(status, None), response(200, None)]);
            let mut calls = 0;
            let result = run(fetch_with(
                Duration::from_secs(1),
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
                ClaudeUsageResult::Response { status: 200, .. }
            ));
        }
        for status in [400, 401, 403, 404, 501] {
            let mut calls = 0;
            let result = run(fetch_with(
                Duration::from_secs(1),
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
                matches!(result, ClaudeUsageResult::Response { status: actual, .. } if actual == status)
            );
        }
    }

    #[test]
    fn three_attempt_cap_and_strict_retry_after_cutoff() {
        let mut calls = 0;
        let mut sleeps = Vec::new();
        let result = run(fetch_with(
            Duration::from_secs(1),
            |_| {
                calls += 1;
                std::future::ready(response(503, None))
            },
            || 0,
            |delay| {
                sleeps.push(delay);
                std::future::ready(())
            },
            || 0.5,
        ));
        assert_eq!(calls, 3);
        assert_eq!(sleeps.len(), 2);
        assert!(matches!(
            result,
            ClaudeUsageResult::Response { status: 503, .. }
        ));

        for (header, expected_calls) in [("4.999", 3), ("5", 3), ("5.001", 1)] {
            let mut calls = 0;
            let result = run(fetch_with(
                Duration::from_secs(1),
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
                ClaudeUsageResult::Response { status: 429, .. }
            ));
        }
    }

    #[test]
    fn date_retry_after_uses_the_post_response_time_anchor() {
        let mut results = VecDeque::from([
            response(429, Some("2030-03-01T00:00:02Z")),
            response(200, None),
        ]);
        let mut sleeps = Vec::new();
        let result = run(fetch_with(
            Duration::from_secs(1),
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
            ClaudeUsageResult::Response { status: 200, .. }
        ));
        assert_eq!(sleeps, [Duration::from_secs(2)]);
    }
}
