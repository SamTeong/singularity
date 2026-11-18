//! Reusable async retry primitive over `reqwest`, matching the policy in
//! `server/external-fetch.mjs:1-56`: three attempts by default, retry only
//! `{408, 429, 500, 502, 503, 504}`, exponential backoff from 250 ms to a 5 s
//! ceiling with jitter, a 10 s per-attempt timeout, and `Retry-After` honoured
//! only when it lands within that ceiling (a longer 429 is handed back instead
//! of slept out, so the caller's own schedule can decide when to return).
//!
//! `Retry-After` parsing is the shared JavaScript-compatible converter in
//! `retry_after.rs` (delta seconds, HTTP dates, `Number()` spellings), anchored
//! to the moment the response arrives. The request is cloned per attempt
//! (`reqwest::Request::try_clone`), so a non-cloneable streaming body falls back
//! to a single attempt; the caller owns the returned `reqwest::Response`.
use crate::retry_after::retry_after_ms as shared_retry_after_ms;
use reqwest::header::RETRY_AFTER;
use reqwest::{Client, Request, Response, StatusCode};
use std::future::Future;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub const RETRYABLE_STATUS: [u16; 6] = [408, 429, 500, 502, 503, 504];
pub const DEFAULT_MAX_ATTEMPTS: u32 = 3;
pub const DEFAULT_TIMEOUT_MS: u64 = 10_000;
pub const BASE_DELAY_MS: u64 = 250;
pub const MAX_DELAY_MS: u64 = 5_000;

pub fn is_retryable_status(status: u16) -> bool {
    RETRYABLE_STATUS.contains(&status)
}

/// `retryAfterMs`: `None` when the header is absent, empty or unparseable.
pub fn retry_after_ms(value: Option<&str>, response_time_ms: i64) -> Option<f64> {
    shared_retry_after_ms(value, response_time_ms)
}

#[derive(Clone, Copy, Debug)]
pub struct RetryPolicy {
    pub retry: bool,
    pub max_attempts: u32,
    pub timeout: Option<Duration>,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            retry: true,
            max_attempts: DEFAULT_MAX_ATTEMPTS,
            timeout: Some(Duration::from_millis(DEFAULT_TIMEOUT_MS)),
        }
    }
}

impl RetryPolicy {
    /// `retry: false`: exactly one attempt.
    pub fn single_attempt() -> Self {
        Self {
            retry: false,
            ..Self::default()
        }
    }
}

#[derive(Debug)]
pub enum FetchError {
    /// The request could not be sent, or the response headers never arrived.
    Transport(reqwest::Error),
    /// The per-attempt timeout elapsed on the final attempt.
    Timeout,
}

impl std::fmt::Display for FetchError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Transport(error) => write!(formatter, "{error}"),
            Self::Timeout => formatter.write_str("operation timed out"),
        }
    }
}

impl std::error::Error for FetchError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Transport(error) => Some(error),
            Self::Timeout => None,
        }
    }
}

/// `fetchExternal`: run `request` under the retry policy and return the final
/// response (retryable status or not). Errors are returned only when the last
/// attempt could not produce a response.
pub async fn fetch_external(
    client: &Client,
    request: Request,
    policy: &RetryPolicy,
) -> Result<Response, FetchError> {
    fetch_with(
        client,
        request,
        policy,
        |delay| tokio::time::sleep(delay),
        random_unit,
        epoch_ms,
    )
    .await
}

async fn fetch_with<S, F, R, N>(
    client: &Client,
    request: Request,
    policy: &RetryPolicy,
    sleep: S,
    random: R,
    now: N,
) -> Result<Response, FetchError>
where
    S: Fn(Duration) -> F,
    F: Future<Output = ()>,
    R: Fn() -> f64,
    N: Fn() -> i64,
{
    let retryable = policy.retry && policy.max_attempts > 1;
    // Cloning once up front proves the body can be replayed; a streaming body
    // that cannot be cloned keeps the single-attempt contract.
    let template = retryable.then(|| request.try_clone()).flatten();
    let attempts = if template.is_some() {
        policy.max_attempts
    } else {
        1
    };
    let mut original = Some(request);
    let mut attempt = 1;
    while attempt <= attempts {
        let current = if attempt == attempts {
            original.take().expect("request is consumed once")
        } else {
            template
                .as_ref()
                .and_then(Request::try_clone)
                .expect("a cloned request stays cloneable")
        };
        let sent = match policy.timeout {
            Some(timeout) => match tokio::time::timeout(timeout, client.execute(current)).await {
                Ok(result) => result,
                Err(_) => {
                    if attempt == attempts {
                        return Err(FetchError::Timeout);
                    }
                    sleep(Duration::from_millis(backoff_ms(attempt, random()))).await;
                    attempt += 1;
                    continue;
                }
            },
            None => client.execute(current).await,
        };
        let response = match sent {
            Ok(response) => response,
            Err(error) => {
                if attempt == attempts {
                    return Err(FetchError::Transport(error));
                }
                sleep(Duration::from_millis(backoff_ms(attempt, random()))).await;
                attempt += 1;
                continue;
            }
        };
        if !is_retryable_status(response.status().as_u16()) || attempt == attempts {
            return Ok(response);
        }
        let retry_after = if response.status() == StatusCode::TOO_MANY_REQUESTS {
            response
                .headers()
                .get(RETRY_AFTER)
                .and_then(|value| value.to_str().ok())
                .and_then(|value| retry_after_ms(Some(value), now()))
        } else {
            None
        };
        if retry_after.is_some_and(|millis| millis > MAX_DELAY_MS as f64) {
            return Ok(response);
        }
        let delay = retry_after.map_or_else(
            || Duration::from_millis(backoff_ms(attempt, random())),
            |millis| Duration::from_secs_f64((millis.max(0.0)) / 1_000.0),
        );
        sleep(delay).await;
        attempt += 1;
    }
    unreachable!("the attempt loop always returns")
}

/// `Math.floor(min(5000, 250 * 2 ** (attempt - 1)) * random())`.
fn backoff_ms(attempt: u32, random: f64) -> u64 {
    let ceiling = BASE_DELAY_MS
        .saturating_mul(1_u64 << attempt.saturating_sub(1).min(31))
        .min(MAX_DELAY_MS);
    (ceiling as f64 * random.clamp(0.0, 1.0)).floor() as u64
}

fn epoch_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0)
}

/// `Math.random()` equivalent: an xorshift stream in `[0, 1)`, seeded once from
/// the clock and the process id.
fn random_unit() -> f64 {
    static STATE: AtomicU64 = AtomicU64::new(0);
    let mut current = STATE.load(Ordering::Relaxed);
    loop {
        let next = if current == 0 {
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|elapsed| elapsed.as_nanos() as u64)
                .unwrap_or(0x9E37_79B9_7F4A_7C15);
            (nanos ^ (u64::from(std::process::id()) << 32)) | 1
        } else {
            let mut value = current;
            value ^= value << 13;
            value ^= value >> 7;
            value ^= value << 17;
            value
        };
        match STATE.compare_exchange_weak(current, next, Ordering::Relaxed, Ordering::Relaxed) {
            Ok(_) => return (next >> 11) as f64 / (1_u64 << 53) as f64,
            Err(actual) => current = actual,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        FetchError, RETRYABLE_STATUS, RetryPolicy, fetch_external, fetch_with, is_retryable_status,
        retry_after_ms,
    };
    use axum::Router;
    use axum::extract::State;
    use axum::http::{StatusCode, header};
    use axum::response::{IntoResponse, Response};
    use axum::routing::get;
    use std::io;
    use std::net::{Ipv4Addr, SocketAddr};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;
    use tokio::sync::oneshot;
    use tokio::task::JoinHandle;

    const DATE_HEADER: &str = "Wed, 21 Oct 2015 07:28:00 GMT";

    async fn transient(State(calls): State<Arc<AtomicUsize>>) -> StatusCode {
        if calls.fetch_add(1, Ordering::SeqCst) == 0 {
            StatusCode::SERVICE_UNAVAILABLE
        } else {
            StatusCode::OK
        }
    }

    async fn unavailable() -> StatusCode {
        StatusCode::SERVICE_UNAVAILABLE
    }

    async fn retry_after_short() -> impl IntoResponse {
        (StatusCode::TOO_MANY_REQUESTS, [(header::RETRY_AFTER, "1")])
    }

    async fn retry_after_long() -> impl IntoResponse {
        (StatusCode::TOO_MANY_REQUESTS, [(header::RETRY_AFTER, "66")])
    }

    async fn date_then_ok(State(calls): State<Arc<AtomicUsize>>) -> Response {
        if calls.fetch_add(1, Ordering::SeqCst) == 0 {
            (
                StatusCode::TOO_MANY_REQUESTS,
                [(header::RETRY_AFTER, DATE_HEADER)],
            )
                .into_response()
        } else {
            StatusCode::OK.into_response()
        }
    }

    async fn slow() -> StatusCode {
        tokio::time::sleep(Duration::from_millis(200)).await;
        StatusCode::OK
    }

    fn app() -> Router {
        Router::new()
            .merge(
                Router::new()
                    .route("/transient", get(transient))
                    .with_state(Arc::new(AtomicUsize::new(0))),
            )
            .merge(
                Router::new()
                    .route("/date", get(date_then_ok))
                    .with_state(Arc::new(AtomicUsize::new(0))),
            )
            .route("/unavailable", get(unavailable))
            .route("/short", get(retry_after_short))
            .route("/long", get(retry_after_long))
            .route("/slow", get(slow))
    }

    fn run<F: std::future::Future>(future: F) -> F::Output {
        tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(future)
    }

    async fn start() -> (SocketAddr, oneshot::Sender<()>, JoinHandle<io::Result<()>>) {
        let listener = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let address = listener.local_addr().unwrap();
        assert!(address.ip().is_loopback());
        let (stop, stopped) = oneshot::channel::<()>();
        let server = tokio::spawn(async move {
            axum::serve(listener, app())
                .with_graceful_shutdown(async move {
                    let _ = stopped.await;
                })
                .await
        });
        (address, stop, server)
    }

    fn request(address: SocketAddr, path: &str) -> reqwest::Request {
        reqwest::Client::new()
            .get(format!("http://{address}{path}"))
            .build()
            .unwrap()
    }

    fn recorder() -> Arc<Mutex<Vec<u64>>> {
        Arc::new(Mutex::new(Vec::new()))
    }

    fn waits(slept: &Arc<Mutex<Vec<u64>>>) -> Vec<u64> {
        slept.lock().unwrap().clone()
    }

    #[test]
    fn retry_classification_covers_transient_responses_only() {
        for status in RETRYABLE_STATUS {
            assert!(is_retryable_status(status), "{status}");
        }
        for status in [200, 400, 401, 403, 404, 501] {
            assert!(!is_retryable_status(status), "{status}");
        }
    }

    #[test]
    fn retry_after_accepts_delta_seconds_and_http_dates() {
        assert_eq!(retry_after_ms(Some("2"), 0), Some(2_000.0));
        assert_eq!(retry_after_ms(Some("0x10"), 0), Some(16_000.0));
        let anchor = crate::usage_snapshot::parse_date_ms("Wed, 21 Oct 2015 07:27:58 GMT").unwrap();
        assert_eq!(retry_after_ms(Some(DATE_HEADER), anchor), Some(2_000.0));
        assert_eq!(retry_after_ms(Some("invalid"), 0), None);
        assert_eq!(retry_after_ms(Some(""), 0), None);
        assert_eq!(retry_after_ms(None, 0), None);
    }

    #[test]
    fn transient_response_is_retried_until_it_succeeds() {
        run(async {
            let (address, stop, server) = start().await;
            let response = fetch_external(
                &reqwest::Client::new(),
                request(address, "/unavailable"),
                &RetryPolicy::single_attempt(),
            )
            .await
            .unwrap();
            assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);

            let response = fetch_external(
                &reqwest::Client::new(),
                request(address, "/transient"),
                &RetryPolicy::default(),
            )
            .await
            .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            stop.send(()).unwrap();
            server.await.unwrap().unwrap();
        });
    }

    #[test]
    fn retry_opt_out_makes_exactly_one_attempt() {
        run(async {
            let (address, stop, server) = start().await;
            let response = fetch_external(
                &reqwest::Client::new(),
                request(address, "/unavailable"),
                &RetryPolicy::single_attempt(),
            )
            .await
            .unwrap();
            assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
            stop.send(()).unwrap();
            server.await.unwrap().unwrap();
        });
    }

    #[test]
    fn transient_failure_uses_exponential_backoff_with_jitter() {
        run(async {
            let (address, stop, server) = start().await;
            let slept = recorder();
            let response = fetch_with(
                &reqwest::Client::new(),
                request(address, "/transient"),
                &RetryPolicy::default(),
                |delay| {
                    let slept = slept.clone();
                    async move { slept.lock().unwrap().push(delay.as_millis() as u64) }
                },
                || 0.5,
                || 0,
            )
            .await
            .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(waits(&slept), vec![125]);
            stop.send(()).unwrap();
            server.await.unwrap().unwrap();
        });
    }

    #[test]
    fn retry_after_date_anchors_to_response_time() {
        run(async {
            let (address, stop, server) = start().await;
            let anchor =
                crate::usage_snapshot::parse_date_ms("Wed, 21 Oct 2015 07:27:58 GMT").unwrap();
            let slept = recorder();
            let response = fetch_with(
                &reqwest::Client::new(),
                request(address, "/date"),
                &RetryPolicy::default(),
                |delay| {
                    let slept = slept.clone();
                    async move { slept.lock().unwrap().push(delay.as_millis() as u64) }
                },
                || 0.5,
                move || anchor,
            )
            .await
            .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(waits(&slept), vec![2_000]);
            stop.send(()).unwrap();
            server.await.unwrap().unwrap();
        });
    }

    #[test]
    fn long_retry_after_returns_the_429_instead_of_sleeping_it_out() {
        run(async {
            let (address, stop, server) = start().await;
            let slept = recorder();
            let response = fetch_with(
                &reqwest::Client::new(),
                request(address, "/long"),
                &RetryPolicy::default(),
                |delay| {
                    let slept = slept.clone();
                    async move { slept.lock().unwrap().push(delay.as_millis() as u64) }
                },
                || 0.5,
                || 0,
            )
            .await
            .unwrap();
            assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
            assert!(waits(&slept).is_empty());
            stop.send(()).unwrap();
            server.await.unwrap().unwrap();
        });
    }

    #[test]
    fn short_retry_after_still_retries_within_the_ceiling() {
        run(async {
            let (address, stop, server) = start().await;
            let slept = recorder();
            let response = fetch_with(
                &reqwest::Client::new(),
                request(address, "/short"),
                &RetryPolicy::default(),
                |delay| {
                    let slept = slept.clone();
                    async move { slept.lock().unwrap().push(delay.as_millis() as u64) }
                },
                || 0.5,
                || 0,
            )
            .await
            .unwrap();
            assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
            assert_eq!(waits(&slept), vec![1_000, 1_000]);
            stop.send(()).unwrap();
            server.await.unwrap().unwrap();
        });
    }

    #[test]
    fn timeout_failures_retry_until_the_last_attempt_then_error() {
        run(async {
            let (address, stop, server) = start().await;
            let slept = recorder();
            let policy = RetryPolicy {
                timeout: Some(Duration::from_millis(20)),
                ..RetryPolicy::default()
            };
            let result = fetch_with(
                &reqwest::Client::new(),
                request(address, "/slow"),
                &policy,
                |delay| {
                    let slept = slept.clone();
                    async move { slept.lock().unwrap().push(delay.as_millis() as u64) }
                },
                || 0.5,
                || 0,
            )
            .await;
            assert!(matches!(result, Err(FetchError::Timeout)));
            assert_eq!(waits(&slept), vec![125, 250]);
            stop.send(()).unwrap();
            server.await.unwrap().unwrap();
        });
    }
}
