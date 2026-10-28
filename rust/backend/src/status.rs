use reqwest::{Client, StatusCode, header::RETRY_AFTER};
use serde_json::{Map, Value, json};
use std::{
    collections::HashMap,
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use time::OffsetDateTime;

const TTL_MS: u64 = 20_000;
const HEADER_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_RETRY_AFTER_MS: u64 = 5_000;
const RETRYABLE: [u16; 6] = [408, 429, 500, 502, 503, 504];

#[derive(Clone)]
struct Provider {
    key: &'static str,
    label: &'static str,
    page_url: String,
}

#[derive(Clone, Default)]
struct Slot {
    data: Option<Value>,
    at: u64,
}

type Clock = Arc<dyn Fn() -> u64 + Send + Sync>;
type Delay = Arc<dyn Fn(Duration) -> Pin<Box<dyn Future<Output = ()> + Send>> + Send + Sync>;
type Random = Arc<dyn Fn() -> f64 + Send + Sync>;

#[derive(Clone)]
pub struct StatusService {
    client: Client,
    providers: [Provider; 2],
    cache: Arc<Mutex<HashMap<&'static str, Slot>>>,
    now: Clock,
    delay: Delay,
    random: Random,
}

impl StatusService {
    pub fn new() -> Self {
        Self::with_parts(
            provider_client(),
            [
                Provider {
                    key: "openai",
                    label: "OpenAI",
                    page_url: "https://status.openai.com".to_owned(),
                },
                Provider {
                    key: "claude",
                    label: "Claude",
                    page_url: "https://status.claude.com".to_owned(),
                },
            ],
            Arc::new(|| millis(SystemTime::now())),
            Arc::new(|duration| Box::pin(tokio::time::sleep(duration))),
            Arc::new(jitter),
        )
    }

    fn with_parts(
        client: Client,
        providers: [Provider; 2],
        now: Clock,
        delay: Delay,
        random: Random,
    ) -> Self {
        Self {
            client,
            cache: Arc::new(Mutex::new(
                providers.iter().map(|p| (p.key, Slot::default())).collect(),
            )),
            providers,
            now,
            delay,
            random,
        }
    }

    pub async fn get_status(&self, force: bool) -> Value {
        let mut out = Map::new();
        for provider in &self.providers {
            out.insert(provider.key.to_owned(), self.pull(provider, force).await);
        }
        Value::Object(out)
    }

    async fn pull(&self, provider: &Provider, force: bool) -> Value {
        let now = (self.now)();
        let cached = self
            .cache
            .lock()
            .expect("status cache poisoned")
            .get(provider.key)
            .cloned()
            .unwrap_or_default();
        if !force && cached.data.is_some() && now.saturating_sub(cached.at) < TTL_MS {
            return cached.data.expect("checked above");
        }

        let attempted_at = iso_ms(now);
        let result = self.fetch_provider(provider).await;
        let success = result.get("ok").and_then(Value::as_bool) == Some(true);
        let mut cache = self.cache.lock().expect("status cache poisoned");
        let slot = cache.entry(provider.key).or_default();
        if success {
            let mut data = result;
            let object = data.as_object_mut().expect("provider payload is an object");
            object.insert("fetchedAt".to_owned(), Value::String(attempted_at.clone()));
            object.insert(
                "lastAttemptAt".to_owned(),
                Value::String(attempted_at.clone()),
            );
            object.insert("lastSuccessAt".to_owned(), Value::String(attempted_at));
            object.insert("refreshError".to_owned(), Value::Null);
            object.insert("stale".to_owned(), Value::Bool(false));
            slot.data = Some(data.clone());
            slot.at = (self.now)();
            return data;
        }
        // `result.error || 'unknown error'` — the fresh error wins over the cached one.
        let error = result
            .get("error")
            .filter(|value| truthy(value))
            .cloned()
            .unwrap_or_else(|| Value::String("unknown error".to_owned()));
        let data = match slot.data.take() {
            // A failure after a success keeps the last-good payload and only marks it stale.
            Some(mut previous) => {
                let object = previous
                    .as_object_mut()
                    .expect("provider payload is an object");
                object.insert("lastAttemptAt".to_owned(), Value::String(attempted_at));
                object.insert("refreshError".to_owned(), error);
                object.insert("stale".to_owned(), Value::Bool(true));
                previous
            }
            // The first failure is cached too, with no success timestamps yet.
            None => {
                let mut first = result;
                let object = first
                    .as_object_mut()
                    .expect("provider payload is an object");
                object.insert("fetchedAt".to_owned(), Value::Null);
                object.insert("lastAttemptAt".to_owned(), Value::String(attempted_at));
                object.insert("lastSuccessAt".to_owned(), Value::Null);
                object.insert("refreshError".to_owned(), error);
                object.insert("stale".to_owned(), Value::Bool(true));
                first
            }
        };
        slot.data = Some(data.clone());
        data
    }

    async fn fetch_provider(&self, provider: &Provider) -> Value {
        let url = format!("{}/api/v2/summary.json", provider.page_url);
        match fetch_json(&self.client, &url, &self.now, &self.delay, &self.random).await {
            Ok(raw) => match normalize(&raw, provider) {
                Ok(value) => value,
                Err(error) => failure(provider, format!("parse error: {error}")),
            },
            Err(FetchError::Http(status)) => failure(provider, format!("HTTP {}", status.as_u16())),
            Err(FetchError::Parse(error)) => failure(provider, format!("parse error: {error}")),
            Err(FetchError::Request(error)) => {
                failure(provider, format!("request failed: {error}"))
            }
        }
    }
}

fn provider_client() -> Client {
    Client::builder()
        .redirect(reqwest::redirect::Policy::limited(20))
        .build()
        .expect("status HTTP client should build")
}

enum FetchError {
    Request(String),
    Parse(String),
    Http(StatusCode),
}

async fn fetch_json(
    client: &Client,
    url: &str,
    now: &Clock,
    delay: &Delay,
    random: &Random,
) -> Result<Value, FetchError> {
    fetch_json_with_timeout(client, url, now, delay, random, HEADER_TIMEOUT).await
}

async fn fetch_json_with_timeout(
    client: &Client,
    url: &str,
    now: &Clock,
    delay: &Delay,
    random: &Random,
    header_timeout: Duration,
) -> Result<Value, FetchError> {
    for attempt in 1..=3 {
        let sent = tokio::time::timeout(header_timeout, client.get(url).send()).await;
        let response = match sent {
            Err(_) => {
                if attempt == 3 {
                    return Err(FetchError::Request("operation timed out".to_owned()));
                }
                delay(backoff(attempt, random)).await;
                continue;
            }
            Ok(Err(error)) => {
                if attempt == 3 {
                    return Err(FetchError::Request(error.to_string()));
                }
                delay(backoff(attempt, random)).await;
                continue;
            }
            Ok(Ok(response)) => response,
        };

        let status = response.status();
        if status == StatusCode::OK {
            return response
                .json::<Value>()
                .await
                .map_err(|error| FetchError::Parse(error.to_string()));
        }
        if !RETRYABLE.contains(&status.as_u16()) || attempt == 3 {
            return Err(FetchError::Http(status));
        }
        let retry_after = if status == StatusCode::TOO_MANY_REQUESTS {
            response
                .headers()
                .get(RETRY_AFTER)
                .and_then(|value| value.to_str().ok())
                .and_then(|value| retry_after_ms(value, now()))
        } else {
            None
        };
        if retry_after.is_some_and(|ms| ms > MAX_RETRY_AFTER_MS) {
            return Err(FetchError::Http(status));
        }
        delay(Duration::from_millis(
            retry_after.unwrap_or_else(|| backoff_ms(attempt, random)),
        ))
        .await;
    }
    unreachable!("three attempts always return")
}

fn backoff(attempt: u32, random: &Random) -> Duration {
    Duration::from_millis(backoff_ms(attempt, random))
}

fn backoff_ms(attempt: u32, random: &Random) -> u64 {
    let ceiling = 250_u64.saturating_mul(1_u64 << (attempt - 1)).min(5_000);
    (ceiling as f64 * random().clamp(0.0, 1.0)) as u64
}

fn retry_after_ms(value: &str, now_ms: u64) -> Option<u64> {
    if value.is_empty() {
        return None;
    }
    if let Ok(seconds) = value.parse::<f64>() {
        return seconds
            .is_finite()
            .then_some((seconds.max(0.0) * 1_000.0) as u64);
    }
    let at = httpdate::parse_http_date(value).ok()?;
    Some(millis(at).saturating_sub(now_ms))
}

fn millis(time: SystemTime) -> u64 {
    time.duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

/// `new Date(ms).toISOString()` for `attemptedAt`.
fn iso_ms(ms: u64) -> String {
    let Ok(date) = OffsetDateTime::from_unix_timestamp_nanos(i128::from(ms) * 1_000_000) else {
        return String::new();
    };
    let date = date.to_offset(time::UtcOffset::UTC);
    let year = date.year();
    let year = if (0..=9999).contains(&year) {
        format!("{year:04}")
    } else {
        format!("{year:+07}")
    };
    format!(
        "{year}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        u8::from(date.month()),
        date.day(),
        date.hour(),
        date.minute(),
        date.second(),
        date.millisecond()
    )
}

fn jitter() -> f64 {
    let ticks = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .subsec_nanos();
    (ticks as f64) / 1_000_000_000.0
}

fn failure(provider: &Provider, error: String) -> Value {
    json!({ "ok": false, "key": provider.key, "label": provider.label, "pageUrl": provider.page_url, "error": error })
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(value) => value.as_f64().is_some_and(|number| number != 0.0),
        Value::String(value) => !value.is_empty(),
        _ => true,
    }
}

fn nullish(value: Option<&Value>, fallback: Value) -> Value {
    value
        .filter(|value| !value.is_null())
        .cloned()
        .unwrap_or(fallback)
}

fn normalize(raw: &Value, provider: &Provider) -> Result<Value, String> {
    let object = raw
        .as_object()
        .ok_or_else(|| "summary is not an object".to_owned())?;
    let page = object.get("page").and_then(Value::as_object);
    let status = object.get("status").and_then(Value::as_object);
    let components_raw = object.get("components").filter(|value| truthy(value));
    let components = match components_raw {
        None => Vec::new(),
        Some(Value::Array(rows)) => rows
            .iter()
            .filter_map(|row| {
                let row = row.as_object()?;
                if row.get("group") == Some(&Value::Bool(true))
                    || !row.get("status").is_some_and(truthy)
                {
                    return None;
                }
                let mut item = Map::new();
                for key in ["name", "status"] {
                    if let Some(value) = row.get(key) {
                        item.insert(key.to_owned(), value.clone());
                    }
                }
                Some(Value::Object(item))
            })
            .collect(),
        Some(_) => return Err("components.filter is not a function".to_owned()),
    };
    let incidents = map_events(object.get("incidents"), "incidents")?;
    let maintenances = map_events(
        object.get("scheduled_maintenances"),
        "scheduled_maintenances",
    )?;
    Ok(json!({
        "ok": true,
        "key": provider.key,
        "label": provider.label,
        "pageUrl": provider.page_url,
        "updatedAt": nullish(page.and_then(|page| page.get("updated_at")), Value::Null),
        "indicator": nullish(status.and_then(|status| status.get("indicator")), json!("none")),
        "description": nullish(status.and_then(|status| status.get("description")), json!("")),
        "components": components,
        "incidents": incidents,
        "maintenances": maintenances,
    }))
}

fn map_events(value: Option<&Value>, field: &str) -> Result<Vec<Value>, String> {
    if !value.is_some_and(truthy) {
        return Ok(Vec::new());
    }
    let Value::Array(rows) = value.expect("truthy value exists") else {
        return Err(format!("{field}.map is not a function"));
    };
    rows.iter()
        .map(|row| {
            let row = row
                .as_object()
                .ok_or_else(|| format!("{field} row has no properties"))?;
            let mut event = Map::new();
            for key in ["name", "impact", "status", "shortlink"] {
                if let Some(value) = row.get(key) {
                    event.insert(key.to_owned(), value.clone());
                }
            }
            event.insert(
                "createdAt".to_owned(),
                nullish(row.get("created_at"), Value::Null),
            );
            Ok(Value::Object(event))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{Read, Write},
        net::TcpListener,
        sync::{
            atomic::{AtomicU64, Ordering},
            mpsc,
        },
        thread,
    };

    fn provider() -> Provider {
        Provider {
            key: "claude",
            label: "Claude",
            page_url: "https://status.claude.com".to_owned(),
        }
    }

    #[test]
    fn normalization_preserves_absence_nulls_order_and_defaults() {
        let raw = json!({
            "page": { "updated_at": null }, "status": { "indicator": null },
            "components": [null, {"name":"group","status":"operational","group":true}, {"name":"x","status":"partial_outage","extra":true}],
            "incidents": [{"name":"i","created_at":null}], "scheduled_maintenances": []
        });
        let value = normalize(&raw, &provider()).unwrap();
        assert_eq!(value["indicator"], "none");
        assert_eq!(value["description"], "");
        assert_eq!(value["updatedAt"], Value::Null);
        assert_eq!(
            value["components"],
            json!([{"name":"x","status":"partial_outage"}])
        );
        assert_eq!(value["incidents"][0], json!({"name":"i","createdAt":null}));
        assert!(value["incidents"][0].get("impact").is_none());
    }

    #[test]
    fn status_retry_classes_and_retry_after_are_pinned() {
        assert!(RETRYABLE.contains(&408) && RETRYABLE.contains(&429) && RETRYABLE.contains(&504));
        assert!(!RETRYABLE.contains(&404));
        assert_eq!(retry_after_ms("1.5", 0), Some(1500));
        assert_eq!(retry_after_ms("-1", 0), Some(0));
        assert_eq!(retry_after_ms("invalid", 0), None);
        let now = millis(httpdate::parse_http_date("Sun, 06 Nov 1994 08:49:37 GMT").unwrap());
        assert_eq!(
            retry_after_ms("Sun, 06 Nov 1994 08:49:38 GMT", now),
            Some(1000)
        );
    }

    fn delayed_loopback(
        count: usize,
        header_delay: Duration,
        body_delay: Duration,
    ) -> (String, thread::JoinHandle<Result<usize, String>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        listener.set_nonblocking(true).unwrap();
        let server = thread::spawn(move || {
            let mut accepted = 0;
            for _ in 0..count {
                let mut stream = accept_bounded(&listener);
                accepted += 1;
                if let Err(error) =
                    read_request_headers_bounded(&mut stream, Duration::from_millis(500))
                {
                    return Err(format!("accepted request headers: {error}"));
                }
                if !header_delay.is_zero() {
                    thread::sleep(header_delay);
                }
                let body = r#"{"ok":true}"#;
                let headers = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                if stream.write_all(headers.as_bytes()).is_ok() {
                    let _ = stream.flush();
                    if !body_delay.is_zero() {
                        thread::sleep(body_delay);
                    }
                    let _ = stream.write_all(body.as_bytes());
                }
            }
            Ok(accepted)
        });
        (format!("http://{address}"), server)
    }

    fn read_request_headers_bounded(
        stream: &mut std::net::TcpStream,
        budget: Duration,
    ) -> std::io::Result<()> {
        let deadline = std::time::Instant::now() + budget;
        let mut bytes = [0; 4096];
        let mut request = Vec::new();
        loop {
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            if remaining.is_zero() {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::TimedOut,
                    "request headers exceeded fixture deadline",
                ));
            }
            stream.set_read_timeout(Some(remaining.min(Duration::from_millis(25))))?;
            match stream.read(&mut bytes) {
                Ok(0) => {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::UnexpectedEof,
                        "peer closed before request headers completed",
                    ));
                }
                Ok(read) => {
                    request.extend_from_slice(&bytes[..read]);
                    if request.windows(4).any(|window| window == b"\r\n\r\n") {
                        return Ok(());
                    }
                }
                Err(error)
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                    ) => {}
                Err(error) => return Err(error),
            }
        }
    }

    #[test]
    fn header_timeout_retries_three_times_but_body_read_is_outside_timeout() {
        let delay: Delay = Arc::new(|_| Box::pin(async {}));
        let random: Random = Arc::new(|| 0.0);
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let (url, server) = delayed_loopback(3, Duration::from_millis(240), Duration::ZERO);
        let now: Clock = Arc::new(|| 0);
        let result = runtime.block_on(fetch_json_with_timeout(
            &provider_client(),
            &url,
            &now,
            &delay,
            &random,
            Duration::from_millis(80),
        ));
        assert!(
            matches!(result, Err(FetchError::Request(message)) if message == "operation timed out")
        );
        assert_eq!(server.join().unwrap().unwrap(), 3);

        let (url, server) = delayed_loopback(1, Duration::ZERO, Duration::from_millis(1_200));
        let result = runtime.block_on(fetch_json_with_timeout(
            &provider_client(),
            &url,
            &now,
            &delay,
            &random,
            Duration::from_millis(1_000),
        ));
        let result_summary = match &result {
            Ok(value) => format!("Ok({value})"),
            Err(FetchError::Request(message)) => format!("Request({message})"),
            Err(FetchError::Parse(message)) => format!("Parse({message})"),
            Err(FetchError::Http(status)) => format!("Http({status})"),
        };
        assert!(
            matches!(&result, Ok(value) if value == &json!({"ok":true})),
            "unexpected fetch result: {result_summary}"
        );
        assert_eq!(server.join().unwrap().unwrap(), 1);
    }

    #[test]
    fn incomplete_loopback_request_headers_end_the_worker_within_deadline() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let client = std::net::TcpStream::connect(address).unwrap();
        let (stream, _) = listener.accept().unwrap();
        let (finished_tx, finished_rx) = std::sync::mpsc::channel();
        let worker = thread::spawn(move || {
            let mut stream = stream;
            let result = read_request_headers_bounded(&mut stream, Duration::from_millis(300));
            finished_tx.send(result).unwrap();
        });

        let result = finished_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("fixture worker did not stop after incomplete request headers");
        assert_eq!(result.unwrap_err().kind(), std::io::ErrorKind::TimedOut);
        worker.join().unwrap();
        drop(client);
    }

    fn loopback(responses: Vec<(u16, &'static str)>) -> (String, thread::JoinHandle<Vec<String>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let mut requests = Vec::new();
            for (status, body) in responses {
                let mut stream = accept_bounded(&listener);
                let mut bytes = [0; 4096];
                let mut request = Vec::new();
                loop {
                    let count = stream.read(&mut bytes).unwrap();
                    if count == 0 {
                        break;
                    }
                    request.extend_from_slice(&bytes[..count]);
                    if request.windows(4).any(|window| window == b"\r\n\r\n") {
                        break;
                    }
                }
                requests.push(
                    String::from_utf8_lossy(&request)
                        .lines()
                        .next()
                        .unwrap_or_default()
                        .to_owned(),
                );
                let reason = match status {
                    200 => "OK",
                    404 => "Not Found",
                    429 => "Too Many Requests",
                    _ => "Service Unavailable",
                };
                let retry = if status == 429 {
                    "Retry-After: 60\r\n"
                } else {
                    ""
                };
                write!(stream, "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n{retry}Connection: close\r\n\r\n{body}", body.len()).unwrap();
            }
            requests
        });
        (format!("http://{address}"), server)
    }

    fn concurrent_status_loopback() -> (String, thread::JoinHandle<Vec<String>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let mut requests = Vec::new();
            let body = r#"{"status":{"indicator":"none"}}"#;
            let mut openai_streams = Vec::new();
            for _ in 0..2 {
                let mut stream = accept_bounded(&listener);
                requests.push(read_request(&mut stream));
                // Hold the first provider responses until both independent calls are in flight.
                openai_streams.push(stream);
            }
            for mut stream in openai_streams {
                stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).unwrap();
            }
            for _ in 0..2 {
                let mut stream = accept_bounded(&listener);
                requests.push(read_request(&mut stream));
                stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).unwrap();
            }
            requests
        });
        (format!("http://{address}"), server)
    }

    fn read_request(stream: &mut std::net::TcpStream) -> String {
        let mut bytes = [0; 4096];
        let mut request = Vec::new();
        loop {
            let count = stream.read(&mut bytes).unwrap();
            if count == 0 {
                break;
            }
            request.extend_from_slice(&bytes[..count]);
            if request.windows(4).any(|window| window == b"\r\n\r\n") {
                break;
            }
        }
        String::from_utf8_lossy(&request)
            .lines()
            .next()
            .unwrap_or_default()
            .to_owned()
    }

    fn accept_bounded(listener: &TcpListener) -> std::net::TcpStream {
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        loop {
            match listener.accept() {
                Ok((stream, _)) => {
                    stream.set_nonblocking(false).unwrap();
                    return stream;
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    assert!(
                        std::time::Instant::now() < deadline,
                        "loopback request timed out"
                    );
                    thread::sleep(Duration::from_millis(5));
                }
                Err(error) => panic!("loopback accept failed: {error}"),
            }
        }
    }

    fn retry_after_loopback(
        retry_after: String,
        arrival: Option<(Arc<AtomicU64>, u64)>,
        count: usize,
    ) -> (String, thread::JoinHandle<usize>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            for index in 0..count {
                let mut stream = accept_bounded(&listener);
                let mut bytes = [0; 4096];
                let mut request = Vec::new();
                loop {
                    let read = stream.read(&mut bytes).unwrap();
                    if read == 0 {
                        break;
                    }
                    request.extend_from_slice(&bytes[..read]);
                    if request.windows(4).any(|window| window == b"\r\n\r\n") {
                        break;
                    }
                }
                if index == 0 {
                    if let Some((clock, arrival_ms)) = &arrival {
                        clock.store(*arrival_ms, Ordering::SeqCst);
                    }
                }
                let (status, reason, body, retry) = if index == 0 {
                    (
                        429,
                        "Too Many Requests",
                        "{}",
                        format!("Retry-After: {retry_after}\r\n"),
                    )
                } else {
                    (200, "OK", r#"{"ok":true}"#, String::new())
                };
                let response = format!(
                    "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n{retry}Connection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(response.as_bytes());
            }
            count
        });
        (format!("http://{address}"), server)
    }

    fn redirect_loopback(redirects: usize) -> (String, thread::JoinHandle<usize>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let request_count = redirects.min(20) + 1;
            for hop in 0..request_count {
                let mut stream = accept_bounded(&listener);
                let mut bytes = [0; 4096];
                let mut request = Vec::new();
                loop {
                    let read = stream.read(&mut bytes).unwrap();
                    if read == 0 {
                        break;
                    }
                    request.extend_from_slice(&bytes[..read]);
                    if request.windows(4).any(|window| window == b"\r\n\r\n") {
                        break;
                    }
                }
                let response = if hop < redirects {
                    format!(
                        "HTTP/1.1 302 Found\r\nLocation: /{}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                        hop + 1
                    )
                } else {
                    "HTTP/1.1 200 OK\r\nContent-Length: 11\r\nConnection: close\r\n\r\n{\"ok\":true}".to_owned()
                };
                let _ = stream.write_all(response.as_bytes());
            }
            request_count
        });
        (format!("http://{address}/0"), server)
    }

    #[test]
    fn retries_three_attempts_and_providers_are_serial_per_call() {
        let ok = r#"{"status":{"indicator":"none"}}"#;
        let (url, server) = loopback(vec![(503, "{}"), (503, "{}"), (200, ok), (200, ok)]);
        let providers = [
            Provider {
                key: "openai",
                label: "OpenAI",
                page_url: format!("{url}/openai"),
            },
            Provider {
                key: "claude",
                label: "Claude",
                page_url: format!("{url}/claude"),
            },
        ];
        let now = Arc::new(AtomicU64::new(100));
        let service = StatusService::with_parts(
            provider_client(),
            providers,
            Arc::new(move || now.load(Ordering::SeqCst)),
            Arc::new(|_| Box::pin(async {})),
            Arc::new(|| 0.0),
        );
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        assert!(
            runtime.block_on(service.get_status(false))["openai"]["ok"]
                .as_bool()
                .unwrap()
        );
        let requests = server.join().unwrap();
        assert_eq!(requests.len(), 4);
        assert!(requests[0].contains("/openai/api/v2/summary.json"));
        assert!(requests[1].contains("/openai/api/v2/summary.json"));
        assert!(requests[2].contains("/openai/api/v2/summary.json"));
        assert!(requests[3].contains("/claude/api/v2/summary.json"));
    }

    #[test]
    fn retry_after_over_five_seconds_returns_429_without_another_attempt() {
        let (url, server) = loopback(vec![(429, "{}")]);
        let delay: Delay = Arc::new(|_| Box::pin(async {}));
        let random: Random = Arc::new(|| 0.0);
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let now: Clock = Arc::new(|| 0);
        let result = runtime.block_on(fetch_json(&provider_client(), &url, &now, &delay, &random));
        assert!(
            matches!(result, Err(FetchError::Http(status)) if status == StatusCode::TOO_MANY_REQUESTS)
        );
        assert_eq!(server.join().unwrap().len(), 1);
    }

    #[test]
    fn retry_after_boundary_and_http_date_use_response_arrival_time() {
        let random: Random = Arc::new(|| 0.0);
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();

        let exact_now = Arc::new(AtomicU64::new(0));
        let exact_delays = Arc::new(Mutex::new(Vec::new()));
        let delay: Delay = {
            let now = exact_now.clone();
            let delays = exact_delays.clone();
            Arc::new(move |duration| {
                delays.lock().unwrap().push(duration.as_millis() as u64);
                now.fetch_add(duration.as_millis() as u64, Ordering::SeqCst);
                Box::pin(async {})
            })
        };
        let (url, server) = retry_after_loopback("5".to_owned(), None, 2);
        let clock: Clock = Arc::new({
            let now = exact_now.clone();
            move || now.load(Ordering::SeqCst)
        });
        let result = runtime.block_on(fetch_json(
            &provider_client(),
            &url,
            &clock,
            &delay,
            &random,
        ));
        assert!(matches!(result, Ok(value) if value["ok"] == true));
        assert_eq!(*exact_delays.lock().unwrap(), vec![5_000]);
        assert_eq!(server.join().unwrap(), 2);

        let over_delays = Arc::new(Mutex::new(Vec::new()));
        let delay: Delay = {
            let delays = over_delays.clone();
            Arc::new(move |duration| {
                delays.lock().unwrap().push(duration.as_millis() as u64);
                Box::pin(async {})
            })
        };
        let (url, server) = retry_after_loopback("5.001".to_owned(), None, 1);
        let result = runtime.block_on(fetch_json(
            &provider_client(),
            &url,
            &clock,
            &delay,
            &random,
        ));
        assert!(
            matches!(result, Err(FetchError::Http(status)) if status == StatusCode::TOO_MANY_REQUESTS)
        );
        assert!(over_delays.lock().unwrap().is_empty());
        assert_eq!(server.join().unwrap(), 1);

        let date_now = Arc::new(AtomicU64::new(0));
        let date_delays = Arc::new(Mutex::new(Vec::new()));
        let delay: Delay = {
            let now = date_now.clone();
            let delays = date_delays.clone();
            Arc::new(move |duration| {
                delays.lock().unwrap().push(duration.as_millis() as u64);
                now.fetch_add(duration.as_millis() as u64, Ordering::SeqCst);
                Box::pin(async {})
            })
        };
        let (url, server) = retry_after_loopback(
            "Thu, 01 Jan 1970 00:00:09 GMT".to_owned(),
            Some((date_now.clone(), 4_000)),
            2,
        );
        let clock: Clock = Arc::new(move || date_now.load(Ordering::SeqCst));
        let result = runtime.block_on(fetch_json(
            &provider_client(),
            &url,
            &clock,
            &delay,
            &random,
        ));
        assert!(matches!(result, Ok(value) if value["ok"] == true));
        assert_eq!(*date_delays.lock().unwrap(), vec![5_000]);
        assert_eq!(server.join().unwrap(), 2);
    }

    #[test]
    fn provider_client_matches_fetch_twenty_redirect_limit() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let (url, server) = redirect_loopback(20);
        let response = runtime.block_on(provider_client().get(url).send()).unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(server.join().unwrap(), 21);

        let (url, server) = redirect_loopback(21);
        let response = runtime.block_on(provider_client().get(url).send());
        assert!(response.is_err());
        assert_eq!(server.join().unwrap(), 21);
    }

    #[test]
    fn independent_concurrent_status_calls_do_not_coalesce() {
        let (url, server) = concurrent_status_loopback();
        let now = Arc::new(AtomicU64::new(100));
        let service = StatusService::with_parts(
            provider_client(),
            [
                Provider {
                    key: "openai",
                    label: "OpenAI",
                    page_url: format!("{url}/openai"),
                },
                Provider {
                    key: "claude",
                    label: "Claude",
                    page_url: format!("{url}/claude"),
                },
            ],
            Arc::new(move || now.load(Ordering::SeqCst)),
            Arc::new(|_| Box::pin(async {})),
            Arc::new(|| 0.5),
        );
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let first = tokio::spawn({
                let service = service.clone();
                async move { service.get_status(false).await }
            });
            let second = tokio::spawn({
                let service = service.clone();
                async move { service.get_status(false).await }
            });
            assert!(first.await.unwrap()["openai"]["ok"].as_bool().unwrap());
            assert!(second.await.unwrap()["claude"]["ok"].as_bool().unwrap());
        });
        let requests = server.join().unwrap();
        assert_eq!(requests.len(), 4);
        assert!(
            requests[..2]
                .iter()
                .all(|request| request.contains("/openai/api/v2/summary.json"))
        );
        assert!(
            requests[2..]
                .iter()
                .all(|request| request.contains("/claude/api/v2/summary.json"))
        );
    }

    #[test]
    fn http_status_route_preserves_cache_and_force_queries() {
        let ok = r#"{"status":{"indicator":"none"}}"#;
        let changed = r#"{"status":{"indicator":"minor"}}"#;
        let (url, providers) = loopback(vec![(200, ok), (200, ok), (200, changed), (200, changed)]);
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let mut services = crate::http_server::HttpServices::new(
                std::env::temp_dir().join("unused-status-http-state"),
                crate::usage_report::Request {
                    reports_dir: String::new(),
                    env: json!({}),
                },
            );
            services.status = test_service(&url, Arc::new(AtomicU64::new(500)));
            let listener = crate::http_server::bind(0).await.unwrap();
            let address = listener.local_addr().unwrap();
            let policy = crate::http_policy::HttpPolicy {
                daemon_port: address.port(),
                vite_port: address.port(),
                token: None,
            };
            let (stop, stopped) = tokio::sync::oneshot::channel();
            let server = tokio::spawn(crate::http_server::serve(
                listener,
                policy,
                services,
                async {
                    let _ = stopped.await;
                },
            ));
            let client = reqwest::Client::new();
            let first = client
                .get(format!("http://{address}/api/status"))
                .send()
                .await
                .unwrap()
                .error_for_status()
                .unwrap()
                .json::<Value>()
                .await
                .unwrap();
            assert_eq!(first["openai"]["indicator"], "none");
            assert_eq!(first["claude"]["indicator"], "none");
            for suffix in ["", "?force=1&force=1", "?force=0"] {
                let cached = client
                    .get(format!("http://{address}/api/status{suffix}"))
                    .send()
                    .await
                    .unwrap()
                    .error_for_status()
                    .unwrap()
                    .json::<Value>()
                    .await
                    .unwrap();
                assert_eq!(cached, first);
            }
            let forced = client
                .get(format!("http://{address}/api/status?%66orce=%31"))
                .send()
                .await
                .unwrap()
                .error_for_status()
                .unwrap()
                .json::<Value>()
                .await
                .unwrap();
            assert_eq!(forced["openai"]["indicator"], "minor");
            assert_eq!(forced["claude"]["indicator"], "minor");
            drop(client);
            stop.send(()).unwrap();
            server.await.unwrap().unwrap();
        });
        assert_eq!(providers.join().unwrap().len(), 4);
    }

    fn test_service(url: &str, now: Arc<AtomicU64>) -> StatusService {
        let providers = [
            Provider {
                key: "openai",
                label: "OpenAI",
                page_url: url.to_owned(),
            },
            Provider {
                key: "claude",
                label: "Claude",
                page_url: url.to_owned(),
            },
        ];
        StatusService::with_parts(
            provider_client(),
            providers,
            Arc::new(move || now.load(Ordering::SeqCst)),
            Arc::new(|_| Box::pin(async {})),
            Arc::new(|| 0.5),
        )
    }

    #[test]
    fn failed_overlapping_refresh_returns_latest_success_without_timestamp_change() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let (first_received_tx, first_received_rx) = mpsc::channel();
        let (release_failure_tx, release_failure_rx) = mpsc::channel();
        let server = thread::spawn(move || {
            let mut streams = Vec::new();
            for _ in 0..2 {
                let mut stream = accept_bounded(&listener);
                let mut bytes = [0; 4096];
                let mut request = Vec::new();
                loop {
                    let read = stream.read(&mut bytes).unwrap();
                    if read == 0 {
                        break;
                    }
                    request.extend_from_slice(&bytes[..read]);
                    if request.windows(4).any(|window| window == b"\r\n\r\n") {
                        break;
                    }
                }
                streams.push(stream);
                if streams.len() == 1 {
                    first_received_tx.send(()).unwrap();
                }
            }
            let mut successful = streams.pop().unwrap();
            let successful_body =
                r#"{"page":{"updated_at":"winner"},"status":{"indicator":"none"}}"#;
            write!(successful, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{successful_body}", successful_body.len()).unwrap();
            drop(successful);
            release_failure_rx
                .recv_timeout(Duration::from_secs(10))
                .expect("failure release timed out");
            let mut failed = streams.pop().unwrap();
            write!(
                failed,
                "HTTP/1.1 404 Not Found\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}"
            )
            .unwrap();
            2
        });

        let now = Arc::new(AtomicU64::new(1_000));
        let service = test_service(&url, now.clone());
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap();
        let (failed_refresh, successful_refresh, server_result) = runtime.block_on(async {
            let failing = {
                let service = service.clone();
                tokio::spawn(async move { service.pull(&service.providers[0], true).await })
            };
            tokio::task::spawn_blocking(move || {
                first_received_rx
                    .recv_timeout(Duration::from_secs(10))
                    .expect("first refresh request timed out")
            })
            .await
            .unwrap();
            let succeeding = {
                let service = service.clone();
                tokio::spawn(async move { service.pull(&service.providers[0], true).await })
            };
            let success = succeeding.await.unwrap();
            now.store(2_000, Ordering::SeqCst);
            release_failure_tx.send(()).unwrap();
            let failure_result = failing.await.unwrap();
            (failure_result, success, server.join().unwrap())
        });
        assert!(successful_refresh["ok"].as_bool().unwrap());
        assert_eq!(successful_refresh["stale"], false);
        assert_eq!(successful_refresh["refreshError"], Value::Null);
        // The failure that resolves after the success keeps every last-good field and only
        // marks the payload stale, without moving `fetchedAt`/`lastSuccessAt`.
        assert_eq!(failed_refresh["ok"], true);
        assert_eq!(failed_refresh["updatedAt"], "winner");
        for field in ["fetchedAt", "lastSuccessAt", "lastAttemptAt"] {
            assert_eq!(failed_refresh[field], successful_refresh[field]);
        }
        assert_eq!(failed_refresh["refreshError"], "HTTP 404");
        assert_eq!(failed_refresh["stale"], true);
        let slot = service.cache.lock().unwrap()["openai"].clone();
        assert_eq!(slot.data.unwrap(), failed_refresh);
        assert_eq!(slot.at, 1_000);
        assert_eq!(server_result, 2);
    }

    #[test]
    fn first_error_is_cached_and_refresh_only_moves_the_attempt_stamp() {
        let (url, server) = loopback(vec![
            (404, "{}"),
            (404, "{}"),
            (410, "{}"),
            (410, "{}"),
            (410, "{}"),
            (410, "{}"),
        ]);
        let now = Arc::new(AtomicU64::new(1000));
        let service = test_service(&url, now.clone());
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let first = runtime.block_on(service.get_status(false));
        assert_eq!(first["openai"]["error"], "HTTP 404");
        assert_eq!(first["openai"]["refreshError"], "HTTP 404");
        assert_eq!(first["openai"]["fetchedAt"], Value::Null);
        assert_eq!(first["openai"]["lastSuccessAt"], Value::Null);
        assert_eq!(first["openai"]["lastAttemptAt"], "1970-01-01T00:00:01.000Z");
        assert_eq!(first["openai"]["stale"], true);
        assert_eq!(runtime.block_on(service.get_status(false)), first);
        // A failed attempt never touches the cache timestamp.
        assert_eq!(service.cache.lock().unwrap()["openai"].at, 0);

        now.store(21_001, Ordering::SeqCst);
        let refreshed = runtime.block_on(service.get_status(false));
        assert_eq!(
            refreshed["openai"]["lastAttemptAt"],
            "1970-01-01T00:00:21.001Z"
        );
        assert_eq!(refreshed["openai"]["fetchedAt"], Value::Null);
        assert_eq!(refreshed["openai"]["lastSuccessAt"], Value::Null);
        // Node spreads the cached payload, so `error` keeps the first failure's message while
        // `refreshError` tracks the latest attempt.
        assert_eq!(refreshed["openai"]["error"], "HTTP 404");
        assert_eq!(refreshed["openai"]["refreshError"], "HTTP 410");
        assert_eq!(refreshed["openai"]["stale"], true);
        assert_eq!(service.cache.lock().unwrap()["openai"].at, 0);
        assert_eq!(runtime.block_on(service.get_status(true)), refreshed);
        assert_eq!(service.cache.lock().unwrap()["openai"].at, 0);
        assert_eq!(server.join().unwrap().len(), 6);
    }

    #[test]
    fn failed_refresh_keeps_success_and_recovery_replaces_it() {
        let ok = r#"{"page":{"updated_at":"old"},"status":{"indicator":"none"}}"#;
        let recovered = r#"{"page":{"updated_at":"new"},"status":{"indicator":"minor"}}"#;
        let (url, server) = loopback(vec![
            (200, ok),
            (200, ok),
            (404, "{}"),
            (404, "{}"),
            (200, recovered),
            (200, recovered),
        ]);
        let now = Arc::new(AtomicU64::new(500));
        let service = test_service(&url, now.clone());
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let first = runtime.block_on(service.get_status(false));
        assert_eq!(first["openai"]["stale"], false);
        assert_eq!(first["openai"]["refreshError"], Value::Null);
        assert_eq!(first["openai"]["lastSuccessAt"], "1970-01-01T00:00:00.500Z");
        now.store(20_501, Ordering::SeqCst);
        let stale = runtime.block_on(service.get_status(false));
        assert_eq!(stale["openai"]["ok"], true);
        assert_eq!(stale["openai"]["updatedAt"], "old");
        assert_eq!(stale["openai"]["indicator"], "none");
        assert_eq!(stale["openai"]["fetchedAt"], first["openai"]["fetchedAt"]);
        assert_eq!(
            stale["openai"]["lastSuccessAt"],
            first["openai"]["lastSuccessAt"]
        );
        assert_eq!(stale["openai"]["lastAttemptAt"], "1970-01-01T00:00:20.501Z");
        assert_eq!(stale["openai"]["refreshError"], "HTTP 404");
        assert_eq!(stale["openai"]["stale"], true);
        assert!(stale["openai"].get("error").is_none());
        assert_eq!(service.cache.lock().unwrap()["openai"].at, 500);
        let recovered = runtime.block_on(service.get_status(true));
        assert_eq!(recovered["openai"]["updatedAt"], "new");
        assert_eq!(recovered["openai"]["stale"], false);
        assert_eq!(recovered["openai"]["refreshError"], Value::Null);
        assert_eq!(
            recovered["openai"]["lastSuccessAt"],
            "1970-01-01T00:00:20.501Z"
        );
        assert_ne!(
            recovered["openai"]["fetchedAt"],
            first["openai"]["fetchedAt"]
        );
        assert_eq!(server.join().unwrap().len(), 6);
    }

    #[test]
    fn refresh_bookkeeping_matches_node_success_failure_recovery() {
        let initial = r#"{"status":{"indicator":"none","description":"All good"}}"#;
        let recovered = r#"{"status":{"indicator":"minor","description":"Recovered"}}"#;
        let (openai_url, openai_server) = loopback(vec![
            (200, initial),
            (404, "{}"),
            (410, "{}"),
            (200, recovered),
        ]);
        let (claude_url, claude_server) =
            loopback(vec![(200, initial), (404, "{}"), (410, "{}"), (415, "{}")]);
        let now = Arc::new(AtomicU64::new(1_000));
        let service = StatusService::with_parts(
            provider_client(),
            [
                Provider {
                    key: "openai",
                    label: "OpenAI",
                    page_url: openai_url,
                },
                Provider {
                    key: "claude",
                    label: "Claude",
                    page_url: claude_url,
                },
            ],
            Arc::new({
                let now = now.clone();
                move || now.load(Ordering::SeqCst)
            }),
            Arc::new(|_| Box::pin(async {})),
            Arc::new(|| 0.5),
        );
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();

        let first = runtime.block_on(service.get_status(true));
        assert_eq!(first["openai"]["lastSuccessAt"], "1970-01-01T00:00:01.000Z");
        assert_eq!(first["openai"]["lastAttemptAt"], "1970-01-01T00:00:01.000Z");
        assert_eq!(first["openai"]["fetchedAt"], "1970-01-01T00:00:01.000Z");
        assert_eq!(first["openai"]["refreshError"], Value::Null);
        assert_eq!(first["openai"]["stale"], false);

        now.store(61_000, Ordering::SeqCst);
        let first_failure = runtime.block_on(service.get_status(true));
        assert_eq!(first_failure["openai"]["ok"], true);
        assert_eq!(first_failure["openai"]["indicator"], "none");
        assert_eq!(first_failure["openai"]["description"], "All good");
        assert_eq!(first_failure["openai"]["stale"], true);
        assert_eq!(first_failure["openai"]["refreshError"], "HTTP 404");
        assert_eq!(
            first_failure["openai"]["lastSuccessAt"],
            first["openai"]["lastSuccessAt"]
        );
        assert_eq!(
            first_failure["openai"]["lastAttemptAt"],
            "1970-01-01T00:01:01.000Z"
        );
        assert_eq!(
            first_failure["claude"]["lastSuccessAt"],
            first["claude"]["lastSuccessAt"]
        );

        now.store(121_000, Ordering::SeqCst);
        let repeated = runtime.block_on(service.get_status(true));
        assert_eq!(repeated["openai"]["refreshError"], "HTTP 410");
        assert_eq!(
            repeated["openai"]["lastSuccessAt"],
            first["openai"]["lastSuccessAt"]
        );
        assert_eq!(
            repeated["openai"]["lastAttemptAt"],
            "1970-01-01T00:02:01.000Z"
        );
        assert!(repeated["openai"].get("error").is_none());
        // A failure after a success never copies the failure's `error`; only `refreshError` moves.
        assert!(repeated["claude"].get("error").is_none());
        assert_eq!(repeated["claude"]["refreshError"], "HTTP 410");
        assert_eq!(
            repeated["claude"]["lastSuccessAt"],
            first["claude"]["lastSuccessAt"]
        );

        now.store(181_000, Ordering::SeqCst);
        let recovery = runtime.block_on(service.get_status(true));
        assert_eq!(recovery["openai"]["indicator"], "minor");
        assert_eq!(recovery["openai"]["stale"], false);
        assert_eq!(recovery["openai"]["refreshError"], Value::Null);
        assert_eq!(
            recovery["openai"]["lastSuccessAt"],
            "1970-01-01T00:03:01.000Z"
        );
        assert_eq!(
            recovery["claude"]["lastSuccessAt"],
            first["claude"]["lastSuccessAt"]
        );
        assert!(recovery["openai"].get("error").is_none());
        assert_eq!(openai_server.join().unwrap().len(), 4);
        assert_eq!(claude_server.join().unwrap().len(), 4);
    }
}
