use reqwest::header::{AUTHORIZATION, HeaderMap, HeaderValue, LOCATION, RETRY_AFTER};
use reqwest::redirect::Policy;
use reqwest::{Client, Method, StatusCode, Url};
use std::time::{Duration, Instant};

const REDIRECT_LIMIT: usize = 20;

#[derive(Debug, PartialEq, Eq)]
pub enum BodyReadFailure {
    Terminated,
}

#[derive(Debug, PartialEq, Eq)]
pub enum AttemptResult {
    TransportFailure,
    TimeoutFailure,
    Response {
        status: u16,
        retry_after: Option<String>,
        body: Result<Option<String>, BodyReadFailure>,
    },
}

pub async fn get(
    endpoint: &str,
    authorization: Option<&str>,
    extra_headers: &[(&str, &str)],
    header_timeout: Duration,
) -> AttemptResult {
    let Ok(mut url) = Url::parse(endpoint) else {
        return AttemptResult::TransportFailure;
    };
    if has_userinfo(&url) || !matches!(url.scheme(), "http" | "https") {
        return AttemptResult::TransportFailure;
    }
    let mut authorization = match authorization {
        Some(value) => match HeaderValue::from_str(value) {
            Ok(value) => Some(value),
            Err(_) => return AttemptResult::TransportFailure,
        },
        None => None,
    };
    let mut fixed_headers = HeaderMap::new();
    for (name, value) in extra_headers {
        let (Ok(name), Ok(value)) = (
            reqwest::header::HeaderName::from_bytes(name.as_bytes()),
            HeaderValue::from_str(value),
        ) else {
            return AttemptResult::TransportFailure;
        };
        fixed_headers.insert(name, value);
    }
    let Ok(client) = Client::builder().redirect(Policy::none()).build() else {
        return AttemptResult::TransportFailure;
    };
    let deadline = Instant::now() + header_timeout;
    let mut redirects = 0;
    loop {
        let mut headers = fixed_headers.clone();
        if let Some(value) = &authorization {
            headers.insert(AUTHORIZATION, value.clone());
        }
        let Ok(request) = client
            .request(Method::GET, url.clone())
            .headers(headers)
            .build()
        else {
            return AttemptResult::TransportFailure;
        };
        let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
            return AttemptResult::TimeoutFailure;
        };
        let response = match tokio::time::timeout(remaining, client.execute(request)).await {
            Err(_) => return AttemptResult::TimeoutFailure,
            Ok(Err(_)) => return AttemptResult::TransportFailure,
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
                return AttemptResult::Response {
                    status: status.as_u16(),
                    retry_after,
                    body: Ok(None),
                };
            };
            if redirects >= REDIRECT_LIMIT {
                return AttemptResult::TransportFailure;
            }
            let Ok(location) = location.to_str() else {
                return AttemptResult::TransportFailure;
            };
            let Ok(next) = url.join(location) else {
                return AttemptResult::TransportFailure;
            };
            if has_userinfo(&next) || !matches!(next.scheme(), "http" | "https") {
                return AttemptResult::TransportFailure;
            }
            if origin(&url) != origin(&next) {
                authorization = None;
            }
            url = next;
            redirects += 1;
            continue;
        }
        if status != StatusCode::OK {
            return AttemptResult::Response {
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
        return AttemptResult::Response {
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
