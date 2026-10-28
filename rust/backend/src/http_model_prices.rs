//! `GET`/`PUT /api/models/prices`: the harness-usage-report price override
//! document, mirroring `server/index.mjs:512-516` (`createModelPricesHandler`,
//! `createModelPricesPutHandler`) over `server/model-prices.mjs:15-49,63-99`.
//!
//! `GET` reads through `model_prices::read_pricing` (never creates the file) and
//! replies with the normalized flat document — `{base, above_200k,
//! long_context_threshold, default_key}` — the shape the Node bridge reshapes at
//! `server/rust-backend.mjs:411-424`. Node parses the bridge's JSON and lets
//! Fastify re-serialize it, so numbers leave in ECMAScript form (`1.0` → `1`,
//! `1e30` → `1e+30`, out-of-range magnitudes → `null`); `js_json` reproduces
//! that. A document serde_json cannot decode (an escaped lone surrogate key,
//! which `read_pricing` preserves verbatim) is replied with its original token
//! rather than failing.
//!
//! `PUT` ports the Node validator byte for byte (same 400 `{error}` texts), then
//! writes `JSON.stringify(doc, null, 2)` through `model_prices::write_pricing`
//! and echoes the validated document, dropping unknown body keys. Validation
//! follows JavaScript object semantics: keys are trimmed and ordered with
//! integer-like keys first (`Object.entries`), key length counts UTF-16 code
//! units, and rates/threshold keep only values that survive `Number` conversion.
//! No lock: Node's route has none, so writes stay last-write-wins.
//!
//! Deviations from Node, neither reachable through a healthy daemon: a
//! `spawn_blocking` join failure answers 500 `{"error":"model prices backend
//! unavailable"}`, and a storage failure reports the Rust `io::Error` text where
//! Node reported its own `e.message`.
use crate::usage_report_cost::{js_json, js_trim, json_number};
use axum::body::Body;
use axum::extract::State;
use axum::http::{Request, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde_json::value::RawValue;
use serde_json::{Map, Number, Value, json};
use std::collections::HashSet;
use std::path::PathBuf;
use std::str::FromStr;

const MAX_KEY: usize = 64;
const THRESHOLD_ERROR: &str = "long_context_threshold must be a positive integer";
// `defaultKey in base` walks the prototype chain, so these inherited names pass
// even when no base table defines them.
const OBJECT_PROTOTYPE_KEYS: [&str; 12] = [
    "constructor",
    "__proto__",
    "hasOwnProperty",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toLocaleString",
    "toString",
    "valueOf",
    "__defineGetter__",
    "__defineSetter__",
    "__lookupGetter__",
    "__lookupSetter__",
];
const BACKEND_UNAVAILABLE: &str = "model prices backend unavailable";

#[derive(Clone)]
struct Prices {
    path: PathBuf,
}

// VERIFY: http_model_prices.rs: route("/api/models/prices", get(get_prices).put(put_prices))
/// The host injects the resolved `pricing.json` path
/// (`USAGE_REPORT_STATE` else `<home>/.agents/.harness-usage-report/state`).
pub fn router(pricing_path: PathBuf) -> Router {
    Router::new()
        .route("/api/models/prices", get(get_prices).put(put_prices))
        .with_state(Prices { path: pricing_path })
}

// VERIFY: http_model_prices.rs: async fn get_prices
async fn get_prices(State(state): State<Prices>) -> Response {
    let read = tokio::task::spawn_blocking(move || {
        crate::model_prices::read_pricing(&state.path.to_string_lossy())
    })
    .await;
    let Ok(raw) = read else {
        return backend_unavailable();
    };
    let Some(pricing) = pricing_token(raw.get()) else {
        return backend_unavailable();
    };
    // Node re-serializes the parsed document; keep the raw token only when the
    // parser cannot represent it (a lone surrogate escape).
    let text = serde_json::from_str::<Value>(pricing.get())
        .map(|value| js_json(&value))
        .unwrap_or_else(|_| pricing.get().to_owned());
    match RawValue::from_string(text) {
        Ok(raw) => Json(raw).into_response(),
        Err(_) => backend_unavailable(),
    }
}

// VERIFY: http_model_prices.rs: async fn put_prices
async fn put_prices(State(state): State<Prices>, request: Request<Body>) -> Response {
    let body = match crate::http_body::parse(request).await {
        Ok(body) => body,
        Err(response) => return response,
    };
    let doc = match validate(&body) {
        Ok(doc) => doc,
        Err(error) => return bad_request(&error),
    };
    let text = serde_json::to_string_pretty(&doc).expect("validated document serializes");
    let path = state.path;
    let written = tokio::task::spawn_blocking(move || {
        crate::model_prices::write_pricing(&path.to_string_lossy(), &text)
    })
    .await;
    match written {
        Ok(Ok(())) => Json(doc).into_response(),
        Ok(Err(error)) => bad_request(&error),
        Err(_) => backend_unavailable(),
    }
}

/// The `pricing` member of `read_pricing`'s `{pricing, base_keys}` document.
fn pricing_token(raw: &str) -> Option<Box<RawValue>> {
    let key = "pricing".encode_utf16().collect::<Vec<_>>();
    crate::wiki_root::raw_fields(raw)
        .ok()??
        .into_iter()
        .rev()
        .find(|(field, _)| field == &key)
        .map(|(_, value)| value)
}

/// `server/model-prices.mjs:40-49` `validate`: the normalized document, or the
/// first user-facing message (the route turns it into a 400 `{error}`).
fn validate(doc: &Value) -> Result<Value, String> {
    let Some(object) = doc.as_object() else {
        return Err("doc must be an object".to_owned());
    };
    let base = validate_table(object.get("base"), "base")?;
    // `doc.above_200k ?? {}`: absent and null both start empty.
    let above_200k = match object.get("above_200k") {
        None | Some(Value::Null) => Map::new(),
        Some(value) => validate_table(Some(value), "above_200k")?,
    };
    let threshold = match object.get("long_context_threshold") {
        Some(Value::Number(number)) => match number.as_f64() {
            Some(value) if value.is_finite() && value.fract() == 0.0 && value > 0.0 => {
                js_number(value)
            }
            _ => return Err(THRESHOLD_ERROR.to_owned()),
        },
        _ => return Err(THRESHOLD_ERROR.to_owned()),
    };
    let default_key = match object.get("default_key") {
        Some(Value::String(value)) => js_trim(value).to_owned(),
        _ => String::new(),
    };
    if !default_key.is_empty()
        && !base.contains_key(&default_key)
        && !OBJECT_PROTOTYPE_KEYS.contains(&default_key.as_str())
    {
        return Err(format!("default_key '{default_key}' must be a base key"));
    }
    let mut normalized = Map::new();
    normalized.insert("base".to_owned(), Value::Object(base));
    normalized.insert("above_200k".to_owned(), Value::Object(above_200k));
    normalized.insert("long_context_threshold".to_owned(), threshold);
    normalized.insert("default_key".to_owned(), Value::String(default_key));
    Ok(Value::Object(normalized))
}

/// `server/model-prices.mjs:22-36` `validateTable`.
fn validate_table(table: Option<&Value>, label: &str) -> Result<Map<String, Value>, String> {
    let Some(Value::Object(table)) = table else {
        return Err(format!("{label} must be an object"));
    };
    let mut seen = HashSet::new();
    let mut entries = Vec::with_capacity(table.len());
    for (raw_key, rate) in js_object_entries(table) {
        let key = js_trim(raw_key).to_owned();
        if key.is_empty() {
            return Err(format!("{label} key must not be empty"));
        }
        if key.encode_utf16().count() > MAX_KEY {
            return Err(format!("{label} key too long (max {MAX_KEY}): '{raw_key}'"));
        }
        if !seen.insert(key.clone()) {
            return Err(format!("{label} key '{key}' is duplicated"));
        }
        let Some(rate) = validate_rate(rate) else {
            return Err(format!(
                "{label} rate for '{key}' must be [input, output, cacheRead, cacheWrite] as finite numbers >= 0"
            ));
        };
        entries.push((key, rate));
    }
    // Rebuilding the table in JavaScript assignment order: integer-like keys
    // sort ascending ahead of the remaining insertion order.
    Ok(js_key_order(entries).into_iter().collect())
}

/// `server/model-prices.mjs:15-17` `isRate`, with the rate re-rendered as
/// `JSON.stringify` would print it.
fn validate_rate(rate: &Value) -> Option<Value> {
    let Value::Array(items) = rate else {
        return None;
    };
    if items.len() != 4 {
        return None;
    }
    let mut out = Vec::with_capacity(4);
    for item in items {
        let Value::Number(number) = item else {
            return None;
        };
        let value = number.as_f64()?;
        if !value.is_finite() || value < 0.0 {
            return None;
        }
        out.push(js_number(value));
    }
    Some(Value::Array(out))
}

/// `JSON.stringify` number token for a validated JavaScript number.
fn js_number(value: f64) -> Value {
    Value::Number(
        Number::from_str(&json_number(value)).expect("ECMAScript number text is valid JSON"),
    )
}

/// `Object.entries` order: integer-like keys ascending, then the rest in
/// insertion order (`preserve_order` keeps the document order).
fn js_object_entries(table: &Map<String, Value>) -> Vec<(&String, &Value)> {
    let entries = table.iter().collect::<Vec<_>>();
    let mut indexed = entries
        .iter()
        .enumerate()
        .filter_map(|(position, (key, _))| js_array_index(key).map(|index| (index, position)))
        .collect::<Vec<_>>();
    indexed.sort_by_key(|(index, _)| *index);
    let indexed_positions = indexed
        .iter()
        .map(|(_, position)| *position)
        .collect::<HashSet<_>>();
    let mut ordered = indexed
        .iter()
        .map(|(_, position)| entries[*position])
        .collect::<Vec<_>>();
    ordered.extend(
        entries
            .into_iter()
            .enumerate()
            .filter(|(position, _)| !indexed_positions.contains(position))
            .map(|(_, entry)| entry),
    );
    ordered
}

fn js_key_order(entries: Vec<(String, Value)>) -> Vec<(String, Value)> {
    let mut slots = entries.into_iter().map(Some).collect::<Vec<_>>();
    let mut indexed = slots
        .iter()
        .enumerate()
        .filter_map(|(position, entry)| {
            js_array_index(&entry.as_ref()?.0).map(|index| (index, position))
        })
        .collect::<Vec<_>>();
    indexed.sort_by_key(|(index, _)| *index);
    let mut ordered = Vec::with_capacity(slots.len());
    for (_, position) in indexed {
        ordered.push(slots[position].take().expect("unique position"));
    }
    ordered.extend(slots.into_iter().flatten());
    ordered
}

/// `Array.prototype` index rule used by JavaScript property ordering.
fn js_array_index(key: &str) -> Option<u32> {
    if key.is_empty() || (key.len() > 1 && key.starts_with('0')) {
        return None;
    }
    if !key.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let value = key.parse::<u64>().ok()?;
    (value <= 4_294_967_294).then_some(value as u32)
}

fn bad_request(message: &str) -> Response {
    (StatusCode::BAD_REQUEST, Json(json!({ "error": message }))).into_response()
}

fn backend_unavailable() -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({ "error": BACKEND_UNAVAILABLE })),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::{BACKEND_UNAVAILABLE, router};
    use serde_json::Value;
    use std::fs;
    use std::net::{Ipv4Addr, SocketAddr};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};
    use tokio::sync::oneshot;
    use tokio::task::JoinHandle;

    static FIXTURE_ID: AtomicU64 = AtomicU64::new(0);

    struct Fixture(PathBuf);

    impl Fixture {
        fn new() -> Self {
            let unique = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let id = FIXTURE_ID.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "http-model-prices-{}-{unique}-{id}",
                std::process::id()
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }

        fn pricing(&self) -> PathBuf {
            self.0.join("state").join("pricing.json")
        }

        fn write(&self, text: &str) {
            fs::create_dir_all(self.0.join("state")).unwrap();
            fs::write(self.pricing(), text).unwrap();
        }

        fn read(&self) -> String {
            fs::read_to_string(self.pricing()).unwrap_or_default()
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

    async fn start(
        pricing: PathBuf,
    ) -> (
        SocketAddr,
        oneshot::Sender<()>,
        JoinHandle<std::io::Result<()>>,
    ) {
        let listener = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let address = listener.local_addr().unwrap();
        assert!(address.ip().is_loopback());
        let (stop, stopped) = oneshot::channel::<()>();
        let server = tokio::spawn(async move {
            axum::serve(listener, router(pricing))
                .with_graceful_shutdown(async move {
                    let _ = stopped.await;
                })
                .await
        });
        (address, stop, server)
    }

    async fn get(address: SocketAddr) -> (u16, String) {
        let response = reqwest::get(format!("http://{address}/api/models/prices"))
            .await
            .unwrap();
        let status = response.status().as_u16();
        (status, response.text().await.unwrap())
    }

    async fn put(address: SocketAddr, content_type: Option<&str>, body: &str) -> (u16, String) {
        let mut builder = reqwest::Client::new()
            .put(format!("http://{address}/api/models/prices"))
            .body(body.to_owned());
        if let Some(content_type) = content_type {
            builder = builder.header("content-type", content_type);
        }
        let response = builder.send().await.unwrap();
        let status = response.status().as_u16();
        (status, response.text().await.unwrap())
    }

    async fn put_json(address: SocketAddr, body: &Value) -> (u16, String) {
        put(address, Some("application/json"), &body.to_string()).await
    }

    fn error_body(message: &str) -> String {
        format!(r#"{{"error":"{message}"}}"#)
    }

    #[test]
    fn missing_file_serves_defaults_without_creating_it() {
        let fixture = Fixture::new();
        run(async {
            let (address, stop, server) = start(fixture.pricing()).await;
            assert_eq!(
                get(address).await,
                (
                    200,
                    r#"{"base":{},"above_200k":{},"long_context_threshold":200000,"default_key":""}"#
                        .to_owned()
                )
            );
            assert!(!fixture.0.join("state").exists());
            stop.send(()).unwrap();
            server.await.unwrap().unwrap();
        });
    }

    #[test]
    fn layered_and_bare_files_normalize_like_node() {
        let fixture = Fixture::new();
        fixture.write(
            r#"{"base":{"z":[1,2,3,4],"a":[5,6,7,8]},"above_200k":null,"long_context_threshold":120000.0,"default_key":"z"}"#,
        );
        run(async {
            let (address, stop, server) = start(fixture.pricing()).await;
            assert_eq!(
                get(address).await,
                (
                    200,
                    r#"{"base":{"z":[1,2,3,4],"a":[5,6,7,8]},"above_200k":{},"long_context_threshold":120000,"default_key":"z"}"#
                        .to_owned()
                )
            );
            stop.send(()).unwrap();
            server.await.unwrap().unwrap();
        });
        fixture.write(r#"{"opus":[99,99,99,99]}"#);
        run(async {
            let (address, stop, server) = start(fixture.pricing()).await;
            assert_eq!(
                get(address).await,
                (
                    200,
                    r#"{"base":{"opus":[99,99,99,99]},"above_200k":{},"long_context_threshold":200000,"default_key":""}"#
                        .to_owned()
                )
            );
            stop.send(()).unwrap();
            server.await.unwrap().unwrap();
        });
    }

    #[test]
    fn get_keeps_lone_surrogate_tokens_and_never_writes() {
        let fixture = Fixture::new();
        fixture.write(r#"{"base":{"\ud800":[1,2,3,4]}}"#);
        run(async {
            let (address, stop, server) = start(fixture.pricing()).await;
            let (status, body) = get(address).await;
            assert_eq!(status, 200);
            assert!(body.contains(r#""\ud800":[1,2,3,4]"#), "{body}");
            assert_eq!(fixture.read(), r#"{"base":{"\ud800":[1,2,3,4]}}"#);
            stop.send(()).unwrap();
            server.await.unwrap().unwrap();
        });
    }

    #[test]
    fn put_validates_writes_pretty_json_and_echoes_the_document() {
        let fixture = Fixture::new();
        run(async {
            let (address, stop, server) = start(fixture.pricing()).await;
            let (status, body) = put_json(
                address,
                &serde_json::json!({
                    "base": {"opus": [15, 75, 1.5, 18.75]},
                    "above_200k": {},
                    "long_context_threshold": 200000,
                    "default_key": "opus",
                    "path": "/ignored"
                }),
            )
            .await;
            assert_eq!(status, 200);
            assert_eq!(
                body,
                r#"{"base":{"opus":[15,75,1.5,18.75]},"above_200k":{},"long_context_threshold":200000,"default_key":"opus"}"#
            );
            assert_eq!(
                fixture.read(),
                "{\n  \"base\": {\n    \"opus\": [\n      15,\n      75,\n      1.5,\n      18.75\n    ]\n  },\n  \"above_200k\": {},\n  \"long_context_threshold\": 200000,\n  \"default_key\": \"opus\"\n}"
            );
            let (status, body) = get(address).await;
            assert_eq!(status, 200);
            assert_eq!(
                body,
                r#"{"base":{"opus":[15,75,1.5,18.75]},"above_200k":{},"long_context_threshold":200000,"default_key":"opus"}"#
            );
            stop.send(()).unwrap();
            server.await.unwrap().unwrap();
        });
    }

    #[test]
    fn put_orders_integer_like_keys_like_javascript() {
        let fixture = Fixture::new();
        run(async {
            let (address, stop, server) = start(fixture.pricing()).await;
            let (status, body) = put(
                address,
                Some("application/json"),
                r#"{"base":{"z":[1,2,3,4],"2":[5,6,7,8],"1":[9,9,9,9]," opus ":[1,1,1,1]},"above_200k":{"9":[1,1,1,1],"a":[2,2,2,2]},"long_context_threshold":1,"default_key":" opus "}"#,
            )
            .await;
            assert_eq!(status, 200);
            assert_eq!(
                body,
                r#"{"base":{"1":[9,9,9,9],"2":[5,6,7,8],"z":[1,2,3,4],"opus":[1,1,1,1]},"above_200k":{"9":[1,1,1,1],"a":[2,2,2,2]},"long_context_threshold":1,"default_key":"opus"}"#
            );
            stop.send(()).unwrap();
            server.await.unwrap().unwrap();
        });
    }

    #[test]
    fn put_default_key_accepts_inherited_object_names() {
        let fixture = Fixture::new();
        run(async {
            let (address, stop, server) = start(fixture.pricing()).await;
            for name in ["toString", "__proto__", "hasOwnProperty"] {
                let body =
                    format!(r#"{{"base":{{}},"long_context_threshold":1,"default_key":"{name}"}}"#);
                let (status, response) = put(address, Some("application/json"), &body).await;
                assert_eq!(status, 200, "{body}: {response}");
            }
            stop.send(()).unwrap();
            server.await.unwrap().unwrap();
        });
    }

    #[test]
    fn put_writes_ecmascript_number_spellings() {
        let fixture = Fixture::new();
        run(async {
            let (address, stop, server) = start(fixture.pricing()).await;
            let (status, body) = put(
                address,
                Some("application/json"),
                r#"{"base":{"m":[1e30,1e-7,0.000001,-0]},"long_context_threshold":1e30}"#,
            )
            .await;
            assert_eq!(status, 200);
            assert_eq!(
                body,
                r#"{"base":{"m":[1e+30,1e-7,0.000001,0]},"above_200k":{},"long_context_threshold":1e+30,"default_key":""}"#
            );
            let written = fixture.read();
            assert!(
                written.contains(
                    "\"m\": [\n      1e+30,\n      1e-7,\n      0.000001,\n      0\n    ]"
                ),
                "{written}"
            );
            assert!(
                written.contains("\"long_context_threshold\": 1e+30"),
                "{written}"
            );
            stop.send(()).unwrap();
            server.await.unwrap().unwrap();
        });
    }

    #[test]
    fn put_rejects_each_invalid_field_with_the_node_message() {
        let fixture = Fixture::new();
        let long_key = "x".repeat(65);
        let rate_error = |label: &str, key: &str| {
            error_body(&format!(
                "{label} rate for '{key}' must be [input, output, cacheRead, cacheWrite] as finite numbers >= 0"
            ))
        };
        let cases: Vec<(String, String)> = vec![
            ("null".to_owned(), error_body("doc must be an object")),
            ("[]".to_owned(), error_body("doc must be an object")),
            (
                r#"{"above_200k":{},"long_context_threshold":1}"#.to_owned(),
                error_body("base must be an object"),
            ),
            (
                r#"{"base":"nope","long_context_threshold":1}"#.to_owned(),
                error_body("base must be an object"),
            ),
            (
                r#"{"base":{"":[1,2,3,4]},"long_context_threshold":1}"#.to_owned(),
                error_body("base key must not be empty"),
            ),
            (
                format!(r#"{{"base":{{"{long_key}":[1,2,3,4]}},"long_context_threshold":1}}"#),
                error_body(&format!("base key too long (max 64): '{long_key}'")),
            ),
            (
                r#"{"base":{"opus":[1,2,3,4]," opus ":[5,6,7,8]},"long_context_threshold":1}"#
                    .to_owned(),
                error_body("base key 'opus' is duplicated"),
            ),
            (
                r#"{"base":{"opus":[1,2,3]},"long_context_threshold":1}"#.to_owned(),
                rate_error("base", "opus"),
            ),
            (
                r#"{"base":{"opus":[1,2,3,-1]},"long_context_threshold":1}"#.to_owned(),
                rate_error("base", "opus"),
            ),
            (
                r#"{"base":{"opus":[1,2,3,1e400]},"long_context_threshold":1}"#.to_owned(),
                rate_error("base", "opus"),
            ),
            (
                r#"{"base":{"opus":["1",2,3,4]},"long_context_threshold":1}"#.to_owned(),
                rate_error("base", "opus"),
            ),
            (
                r#"{"base":{"opus":[1,2,3,4]},"above_200k":[],"long_context_threshold":1}"#
                    .to_owned(),
                error_body("above_200k must be an object"),
            ),
            (
                r#"{"base":{"opus":[1,2,3,4]},"long_context_threshold":0}"#.to_owned(),
                error_body("long_context_threshold must be a positive integer"),
            ),
            (
                r#"{"base":{"opus":[1,2,3,4]},"long_context_threshold":200000.5}"#.to_owned(),
                error_body("long_context_threshold must be a positive integer"),
            ),
            (
                r#"{"base":{"opus":[1,2,3,4]},"long_context_threshold":"1"}"#.to_owned(),
                error_body("long_context_threshold must be a positive integer"),
            ),
            (
                r#"{"base":{"opus":[1,2,3,4]}}"#.to_owned(),
                error_body("long_context_threshold must be a positive integer"),
            ),
            (
                r#"{"base":{"opus":[1,2,3,4]},"long_context_threshold":200000,"default_key":"sonnet"}"#
                    .to_owned(),
                error_body("default_key 'sonnet' must be a base key"),
            ),
        ];
        run(async {
            let (address, stop, server) = start(fixture.pricing()).await;
            for (body, expected) in cases {
                let (status, response) = put(address, Some("application/json"), &body).await;
                assert_eq!(
                    (status, response.as_str()),
                    (400, expected.as_str()),
                    "{body}"
                );
            }
            // Nothing above reached the file.
            assert_eq!(fixture.read(), "");
            stop.send(()).unwrap();
            server.await.unwrap().unwrap();
        });
    }

    #[test]
    fn put_write_failure_is_a_400_and_body_errors_keep_fastify_envelopes() {
        let fixture = Fixture::new();
        fs::create_dir_all(fixture.pricing()).unwrap();
        run(async {
            let (address, stop, server) = start(fixture.pricing()).await;
            let (status, response) = put(
                address,
                Some("application/json"),
                r#"{"base":{"opus":[1,2,3,4]},"long_context_threshold":1}"#,
            )
            .await;
            assert_eq!(status, 400);
            let payload: Value = serde_json::from_str(&response).unwrap();
            assert!(
                payload["error"]
                    .as_str()
                    .is_some_and(|error| !error.is_empty())
            );

            let (status, response) = put(address, Some("application/json"), "{not json").await;
            assert_eq!(status, 400);
            let payload: Value = serde_json::from_str(&response).unwrap();
            assert_eq!(payload["code"], "FST_ERR_CTP_INVALID_JSON_BODY");

            let (status, _) = put(address, Some("text/plain"), "plain").await;
            assert_eq!(status, 400);
            stop.send(()).unwrap();
            server.await.unwrap().unwrap();
        });
    }

    #[test]
    fn spawn_blocking_failure_answer_is_the_node_fallback() {
        // The handler-level fallback is otherwise unreachable: `read_pricing`
        // cannot fail and the blocking write does not panic.
        assert_eq!(BACKEND_UNAVAILABLE, "model prices backend unavailable");
        assert_eq!(
            super::backend_unavailable().status(),
            axum::http::StatusCode::INTERNAL_SERVER_ERROR
        );
    }
}
