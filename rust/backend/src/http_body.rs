//! Fastify-compatible request body parser shared by the native JSON routes
//! (PUT keys/config-state/models, POST models restore).
//!
//! Media types are matched case-insensitively on the bare type, parameters
//! ignored. `application/json` parses JSON (UTF-8 BOM tolerated), `text/plain`
//! yields lossy UTF-8, and an absent content type maps an empty body to `null`
//! while any other body is unsupported. Payloads are capped at 1 MiB.
//!
//! Known parity gaps versus the measured Fastify probes: error bodies are sent
//! as `application/json` (Fastify adds `charset=utf-8`), and body read failures
//! use the invalid-JSON envelope. JSON nesting is bounded by serde_json's limit.
//!
//! `parse_raw` runs that same pipeline for routes that must keep the original
//! JSON token: `RawBody::raw` is the fully validated, BOM-stripped JSON token
//! with escapes untouched, so an escaped lone surrogate (`"\ud800"`) survives
//! verbatim, while `RawBody::value` is the routing representation. Rust strings
//! cannot hold a lone UTF-16 code unit, so only inside `value` unpaired
//! surrogate escapes decode as U+FFFD; the raw token stays authoritative.

use axum::Json;
use axum::body::{Body, to_bytes};
use axum::http::{HeaderMap, Request, StatusCode, header};
use axum::response::{IntoResponse, Response};
use http_body_util::LengthLimitError;
use serde_json::value::RawValue;
use serde_json::{Value, json};

const MAX_BODY: usize = 1024 * 1024;

#[derive(Clone, Copy, PartialEq, Eq)]
enum MediaKind {
    Json,
    Plain,
    Absent,
    Unsupported,
}

/// Media kind plus the lossy-decoded body text every entry point dispatches on.
struct BodyText {
    kind: MediaKind,
    text: String,
}

pub async fn parse(request: Request<Body>) -> Result<Value, Response> {
    let BodyText { kind, text } = read_body(request).await?;
    match kind {
        MediaKind::Json => parse_json(&text),
        MediaKind::Plain => Ok(Value::String(text)),
        MediaKind::Absent if text.is_empty() => Ok(Value::Null),
        MediaKind::Absent | MediaKind::Unsupported => Err(invalid_media_type()),
    }
}

/// The parsed routing value plus the original JSON token.
///
/// `raw` is `Some` only for `application/json` bodies and is the whole document
/// as validated by serde_json's raw-value scanner, which — unlike `Value` —
/// accepts escaped lone surrogates. `value` mirrors `parse` exactly, except
/// that unpaired surrogate escapes decode as U+FFFD. Duplicate keys stay
/// last-wins in both. Because the parsed map is lossy, keys differing only by
/// a lone surrogate can merge there; use `raw` when key identity matters.
pub(crate) struct RawBody {
    pub(crate) value: Value,
    pub(crate) raw: Option<Box<RawValue>>,
}

/// `parse` for routes that must echo or persist original JSON text. Media-type,
/// size, Content-Length, BOM, empty-body and prototype contracts are identical.
pub(crate) async fn parse_raw(request: Request<Body>) -> Result<RawBody, Response> {
    let BodyText { kind, text } = read_body(request).await?;
    match kind {
        MediaKind::Json => parse_json_raw(&text),
        MediaKind::Plain => Ok(RawBody {
            value: Value::String(text),
            raw: None,
        }),
        MediaKind::Absent if text.is_empty() => Ok(RawBody {
            value: Value::Null,
            raw: None,
        }),
        MediaKind::Absent | MediaKind::Unsupported => Err(invalid_media_type()),
    }
}

async fn read_body(request: Request<Body>) -> Result<BodyText, Response> {
    let kind = classify(request.headers());
    let length = request
        .headers()
        .get(header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<usize>().ok());
    if kind == MediaKind::Unsupported
        || (kind == MediaKind::Absent
            && (length.is_some_and(|value| value > 0)
                || request.headers().contains_key(header::TRANSFER_ENCODING)))
    {
        // Fastify rejects an unsupported declared type without reading the body.
        return Err(invalid_media_type());
    }
    if length.is_some_and(|value| value > MAX_BODY) {
        return Err(body_too_large());
    }
    let bytes = match to_bytes(request.into_body(), MAX_BODY).await {
        Ok(bytes) => bytes,
        Err(error) => {
            return Err(if kind == MediaKind::Absent {
                invalid_media_type()
            } else if exceeds_limit(error) {
                body_too_large()
            } else {
                invalid_json_body()
            });
        }
    };
    let text = String::from_utf8_lossy(&bytes).into_owned();
    if kind != MediaKind::Absent && text.len() > MAX_BODY {
        return Err(body_too_large());
    }
    if kind != MediaKind::Absent && length.is_some_and(|value| value != text.len()) {
        return Err(invalid_content_length());
    }
    Ok(BodyText { kind, text })
}

fn classify(headers: &HeaderMap) -> MediaKind {
    let Some(value) = headers.get(header::CONTENT_TYPE) else {
        return MediaKind::Absent;
    };
    let Ok(value) = value.to_str() else {
        return MediaKind::Unsupported;
    };
    let media = value.split(';').next().unwrap_or("").trim();
    if media.eq_ignore_ascii_case("application/json") {
        MediaKind::Json
    } else if media.eq_ignore_ascii_case("text/plain") {
        MediaKind::Plain
    } else {
        MediaKind::Unsupported
    }
}

fn json_source(text: &str) -> Result<&str, Response> {
    if text.is_empty() {
        return Err(empty_json_body());
    }
    Ok(text.strip_prefix('\u{FEFF}').unwrap_or(text))
}

fn parse_json(text: &str) -> Result<Value, Response> {
    let text = json_source(text)?;
    let Ok(value) = serde_json::from_str::<Value>(text) else {
        return Err(invalid_json_body());
    };
    if !prototype_safe(&value) {
        return Err(invalid_json_body());
    }
    Ok(value)
}

fn parse_json_raw(text: &str) -> Result<RawBody, Response> {
    let text = json_source(text)?;
    // Raw-value validation scans every token, so the whole document (including
    // a lone surrogate that `Value` cannot decode) must be well-formed JSON.
    let Ok(raw) = RawValue::from_string(text.to_owned()) else {
        return Err(invalid_json_body());
    };
    let Ok(value) = serde_json::from_str::<Value>(text)
        .or_else(|_| serde_json::from_str::<Value>(&lossy_surrogates(text)))
    else {
        return Err(invalid_json_body());
    };
    if !prototype_safe(&value) {
        return Err(invalid_json_body());
    }
    Ok(RawBody {
        value,
        raw: Some(raw),
    })
}

/// Rewrite unpaired UTF-16 surrogate escapes as `\ufffd` so serde_json can build
/// a `Value`; Fastify accepts them because they are legal JavaScript strings.
/// Paired escapes and escaped backslashes are left alone.
fn lossy_surrogates(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut copied = 0;
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b'\\' {
            index += 1;
            continue;
        }
        let Some(&escape) = bytes.get(index + 1) else {
            break;
        };
        if escape != b'u' {
            index += 2;
            continue;
        }
        let Some(hex) = text.get(index + 2..index + 6) else {
            index += 1;
            continue;
        };
        let Ok(unit) = u16::from_str_radix(hex, 16) else {
            index += 1;
            continue;
        };
        if (0xD800..=0xDBFF).contains(&unit) {
            if let Some(after) = paired_low_surrogate(text, index + 6) {
                index = after;
                continue;
            }
        }
        if (0xD800..=0xDFFF).contains(&unit) {
            out.push_str(&text[copied..index]);
            out.push_str("\\ufffd");
            copied = index + 6;
        }
        index += 6;
    }
    out.push_str(&text[copied..]);
    out
}

/// Offset just past a low-surrogate escape at `start`, when the escape there is
/// `\uDC00`-`\uDFFF`; a high surrogate followed by it is a valid pair.
fn paired_low_surrogate(text: &str, start: usize) -> Option<usize> {
    let bytes = text.as_bytes();
    if bytes.get(start) != Some(&b'\\') || bytes.get(start + 1) != Some(&b'u') {
        return None;
    }
    let unit = u16::from_str_radix(text.get(start + 2..start + 6)?, 16).ok()?;
    (0xDC00..=0xDFFF).contains(&unit).then_some(start + 6)
}

fn prototype_safe(value: &Value) -> bool {
    match value {
        Value::Object(map) => map.iter().all(|(key, property)| {
            key != "__proto__"
                && !(key == "constructor"
                    && matches!(property, Value::Object(object) if object.contains_key("prototype")))
                && prototype_safe(property)
        }),
        Value::Array(items) => items.iter().all(prototype_safe),
        _ => true,
    }
}

fn exceeds_limit(error: axum::Error) -> bool {
    error
        .into_inner()
        .downcast_ref::<LengthLimitError>()
        .is_some()
}

fn json_error(status: StatusCode, code: &str, error: &str, message: &str) -> Response {
    (
        status,
        Json(json!({
            "statusCode": status.as_u16(),
            "code": code,
            "error": error,
            "message": message,
        })),
    )
        .into_response()
}

fn invalid_media_type() -> Response {
    json_error(
        StatusCode::UNSUPPORTED_MEDIA_TYPE,
        "FST_ERR_CTP_INVALID_MEDIA_TYPE",
        "Unsupported Media Type",
        "Unsupported Media Type",
    )
}

fn invalid_content_length() -> Response {
    json_error(
        StatusCode::BAD_REQUEST,
        "FST_ERR_CTP_INVALID_CONTENT_LENGTH",
        "Bad Request",
        "Request body size did not match Content-Length",
    )
}

fn empty_json_body() -> Response {
    json_error(
        StatusCode::BAD_REQUEST,
        "FST_ERR_CTP_EMPTY_JSON_BODY",
        "Bad Request",
        "Body cannot be empty when content-type is set to 'application/json'",
    )
}

fn invalid_json_body() -> Response {
    json_error(
        StatusCode::BAD_REQUEST,
        "FST_ERR_CTP_INVALID_JSON_BODY",
        "Bad Request",
        "Body is not valid JSON but content-type is set to 'application/json'",
    )
}

fn body_too_large() -> Response {
    json_error(
        StatusCode::PAYLOAD_TOO_LARGE,
        "FST_ERR_CTP_BODY_TOO_LARGE",
        "Payload Too Large",
        "Request body is too large",
    )
}

#[cfg(test)]
mod tests {
    use super::{MAX_BODY, RawBody, parse, parse_raw};
    use axum::body::{Body, Bytes, to_bytes};
    use axum::http::{Request, header};
    use axum::response::Response;
    use serde_json::{Value, json};

    fn request(content_type: Option<&str>, body: &[u8]) -> Request<Body> {
        let mut builder = Request::builder().method("PUT").uri("/probe");
        if let Some(value) = content_type {
            builder = builder.header(header::CONTENT_TYPE, value);
        }
        builder
            .body(Body::from(Bytes::copy_from_slice(body)))
            .unwrap()
    }

    fn run<F: std::future::Future>(future: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(future)
    }

    fn envelope(status: u16, code: &str, error: &str, message: &str) -> Value {
        json!({
            "statusCode": status,
            "code": code,
            "error": error,
            "message": message,
        })
    }

    fn invalid_media_type() -> Value {
        envelope(
            415,
            "FST_ERR_CTP_INVALID_MEDIA_TYPE",
            "Unsupported Media Type",
            "Unsupported Media Type",
        )
    }

    fn empty_json() -> Value {
        envelope(
            400,
            "FST_ERR_CTP_EMPTY_JSON_BODY",
            "Bad Request",
            "Body cannot be empty when content-type is set to 'application/json'",
        )
    }

    fn invalid_json() -> Value {
        envelope(
            400,
            "FST_ERR_CTP_INVALID_JSON_BODY",
            "Bad Request",
            "Body is not valid JSON but content-type is set to 'application/json'",
        )
    }

    fn too_large() -> Value {
        envelope(
            413,
            "FST_ERR_CTP_BODY_TOO_LARGE",
            "Payload Too Large",
            "Request body is too large",
        )
    }

    async fn error_body(response: Response) -> (u16, Value) {
        let status = response.status().as_u16();
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        (status, serde_json::from_slice(&body).unwrap())
    }

    async fn expect_value(content_type: Option<&str>, body: &[u8]) -> Value {
        match parse(request(content_type, body)).await {
            Ok(value) => value,
            Err(response) => {
                let (status, body) = error_body(response).await;
                panic!("expected a value, got {status} {body}");
            }
        }
    }

    async fn expect_error(content_type: Option<&str>, body: &[u8]) -> (u16, Value) {
        match parse(request(content_type, body)).await {
            Ok(value) => panic!("expected an error, parsed {value}"),
            Err(response) => error_body(response).await,
        }
    }

    async fn expect_raw(content_type: Option<&str>, body: &[u8]) -> RawBody {
        match parse_raw(request(content_type, body)).await {
            Ok(parsed) => parsed,
            Err(response) => {
                let (status, body) = error_body(response).await;
                panic!("expected a raw body, got {status} {body}");
            }
        }
    }

    async fn expect_raw_error(content_type: Option<&str>, body: &[u8]) -> (u16, Value) {
        match parse_raw(request(content_type, body)).await {
            Ok(parsed) => panic!("expected an error, parsed {}", parsed.value),
            Err(response) => error_body(response).await,
        }
    }

    fn raw_text(parsed: &RawBody) -> Option<&str> {
        parsed.raw.as_deref().map(|raw| raw.get())
    }

    #[test]
    fn absent_content_type_accepts_only_an_empty_body() {
        run(async {
            assert_eq!(expect_value(None, b"").await, Value::Null);
            assert_eq!(
                expect_error(Some(""), b"").await,
                (415, invalid_media_type())
            );
            let mut chunked = request(None, b"");
            chunked
                .headers_mut()
                .insert(header::TRANSFER_ENCODING, "chunked".parse().unwrap());
            assert_eq!(
                error_body(parse(chunked).await.unwrap_err()).await,
                (415, invalid_media_type())
            );
            assert_eq!(
                expect_error(None, b"abc").await,
                (415, invalid_media_type())
            );
            assert_eq!(
                expect_error(None, &vec![b'x'; MAX_BODY + 1]).await,
                (415, invalid_media_type())
            );
        });
    }

    #[test]
    fn framing_and_lossy_decoding_match_fastify_wire_probes() {
        run(async {
            assert_eq!(
                expect_error(Some("text/plain"), &vec![0xff; MAX_BODY / 3 + 1]).await,
                (413, too_large())
            );
            assert_eq!(
                expect_value(Some("text/plain"), &vec![0xff; MAX_BODY / 3])
                    .await
                    .as_str()
                    .unwrap()
                    .len(),
                MAX_BODY - 1
            );
            for (content_type, bytes) in [
                ("application/json", b"\"\xFF\"".as_slice()),
                ("text/plain", b"\xFF".as_slice()),
            ] {
                assert_eq!(
                    expect_value(Some(content_type), bytes).await,
                    json!("\u{FFFD}")
                );
                let mut framed = request(Some(content_type), bytes);
                framed
                    .headers_mut()
                    .insert(header::CONTENT_LENGTH, bytes.len().into());
                let error = parse(framed).await.unwrap_err();
                assert_eq!(
                    error_body(error).await,
                    (
                        400,
                        envelope(
                            400,
                            "FST_ERR_CTP_INVALID_CONTENT_LENGTH",
                            "Bad Request",
                            "Request body size did not match Content-Length"
                        )
                    )
                );
            }
            let mut framed = request(Some("application/json"), b"{}");
            framed
                .headers_mut()
                .insert(header::CONTENT_LENGTH, (MAX_BODY + 1).into());
            assert_eq!(
                error_body(parse(framed).await.unwrap_err()).await,
                (413, too_large())
            );
        });
    }

    #[test]
    fn json_accepts_bom_case_insensitive_types_and_parameters() {
        run(async {
            assert_eq!(
                expect_value(Some("application/json"), b"null").await,
                Value::Null
            );
            assert_eq!(
                expect_value(Some("application/json"), br#"{"ok":true}"#).await,
                json!({ "ok": true })
            );
            assert_eq!(
                expect_value(Some("Application/JSON"), b"{}").await,
                json!({})
            );
            assert_eq!(
                expect_value(Some("application/json; charset=latin1"), b"{}").await,
                json!({})
            );
            assert_eq!(
                expect_value(Some("application/json"), b"\xEF\xBB\xBF{}").await,
                json!({})
            );
        });
    }

    #[test]
    fn empty_whitespace_and_malformed_json_use_fastify_envelopes() {
        run(async {
            assert_eq!(
                expect_error(Some("application/json"), b"").await,
                (400, empty_json())
            );
            for body in [b" ".as_slice(), b"{", b"\xEF\xBB\xBF"] {
                assert_eq!(
                    expect_error(Some("application/json"), body).await,
                    (400, invalid_json()),
                    "{}",
                    String::from_utf8_lossy(body)
                );
            }
        });
    }

    #[test]
    fn prototype_pollution_is_rejected_at_any_depth() {
        run(async {
            let polluted: [&[u8]; 6] = [
                br#"{"__proto__":{"polluted":true}}"#,
                br#"{"__proto__":0}"#,
                br#"{"x":[{"__proto__":null}]}"#,
                br#"{"__proto__":{},"__proto__":0}"#,
                br#"{"constructor":{"prototype":{"polluted":true}}}"#,
                br#"{"constructor":{"prototype":0}}"#,
            ];
            for body in polluted {
                assert_eq!(
                    expect_error(Some("application/json"), body).await,
                    (400, invalid_json()),
                    "{}",
                    String::from_utf8_lossy(body)
                );
            }
            for body in [br#"{"constructor":1}"#.as_slice(), br#"{"constructor":{}}"#] {
                assert!(
                    matches!(
                        expect_value(Some("application/json"), body).await,
                        Value::Object(_)
                    ),
                    "{}",
                    String::from_utf8_lossy(body)
                );
            }
        });
    }

    #[test]
    fn plain_text_is_lossy_utf8_including_empty_bodies() {
        run(async {
            assert_eq!(
                expect_value(Some("text/plain"), br#"{"ok":true}"#).await,
                json!(r#"{"ok":true}"#)
            );
            assert_eq!(expect_value(Some("text/plain"), b"").await, json!(""));
            assert_eq!(expect_value(Some("TEXT/PLAIN"), b"ok").await, json!("ok"));
            assert_eq!(
                expect_value(Some("text/plain; charset=utf-8"), b"ok").await,
                json!("ok")
            );
            assert_eq!(
                expect_value(Some("text/plain"), b"\xFF").await,
                json!("\u{FFFD}")
            );
        });
    }

    #[test]
    fn unsupported_media_types_are_rejected_without_reading() {
        run(async {
            for content_type in [
                "application/octet-stream",
                "application/vnd.test+json",
                "application/json-suffix",
            ] {
                assert_eq!(
                    expect_error(Some(content_type), b"abc").await,
                    (415, invalid_media_type()),
                    "{content_type}"
                );
            }
            assert_eq!(
                expect_error(Some("application/octet-stream"), b"").await,
                (415, invalid_media_type())
            );
            let oversized = vec![b'x'; MAX_BODY + 1];
            assert_eq!(
                expect_error(Some("application/octet-stream"), &oversized).await,
                (415, invalid_media_type())
            );
        });
    }

    #[test]
    fn one_mib_boundary_is_inclusive_and_oversized_is_413() {
        run(async {
            let prefix: &[u8] = br#"{"d":""#;
            let mut body = Vec::with_capacity(MAX_BODY);
            body.extend_from_slice(prefix);
            body.extend(std::iter::repeat_n(b'x', MAX_BODY - prefix.len() - 2));
            body.extend_from_slice(b"\"}");
            assert_eq!(body.len(), MAX_BODY);
            assert!(matches!(
                expect_value(Some("application/json"), &body).await,
                Value::Object(_)
            ));

            body.push(b' ');
            assert_eq!(body.len(), MAX_BODY + 1);
            assert_eq!(
                expect_error(Some("application/json"), &body).await,
                (413, too_large())
            );
        });
    }

    #[test]
    fn parse_still_rejects_lone_surrogates() {
        run(async {
            assert_eq!(
                expect_error(Some("application/json"), br#"{"s":"\ud800"}"#).await,
                (400, invalid_json())
            );
        });
    }

    #[test]
    fn raw_json_keeps_surrogate_escapes_and_parses_the_rest() {
        run(async {
            let parsed =
                expect_raw(Some("application/json"), br#"{"root":"\ud800","ok":true}"#).await;
            assert_eq!(raw_text(&parsed), Some(r#"{"root":"\ud800","ok":true}"#));
            assert_eq!(parsed.value, json!({ "root": "\u{FFFD}", "ok": true }));

            // a paired escape decodes exactly and stays raw
            let parsed = expect_raw(Some("application/json"), br#"{"s":"\uD83D\uDE00"}"#).await;
            assert_eq!(parsed.value, json!({ "s": "\u{1F600}" }));
            assert_eq!(raw_text(&parsed), Some(r#"{"s":"\uD83D\uDE00"}"#));

            for body in [
                br#"{"e":"\uD83D\uDE00","l":"\udc00"}"#.as_slice(),
                br#"{"l":"\udc00","e":"\uD83D\uDE00"}"#.as_slice(),
            ] {
                let parsed = expect_raw(Some("application/json"), body).await;
                assert_eq!(parsed.value, json!({ "e": "\u{1F600}", "l": "\u{FFFD}" }));
            }

            // an escaped backslash before "ud800" is text, not an escape
            let parsed = expect_raw(Some("application/json"), br#"{"s":"\\ud800"}"#).await;
            assert_eq!(parsed.value, json!({ "s": "\\ud800" }));
            assert_eq!(raw_text(&parsed), Some(r#"{"s":"\\ud800"}"#));

            // adjacent lone highs are both lossy; the raw token keeps both
            let parsed = expect_raw(Some("application/json"), br#"{"s":"\ud800\ud800"}"#).await;
            assert_eq!(parsed.value, json!({ "s": "\u{FFFD}\u{FFFD}" }));
            assert_eq!(raw_text(&parsed), Some(r#"{"s":"\ud800\ud800"}"#));
        });
    }

    #[test]
    fn raw_json_rejects_prototype_poison_with_surrogates_present() {
        run(async {
            let polluted: [&[u8]; 5] = [
                br#"{"__proto__":{"polluted":true},"s":"\ud800"}"#,
                br#"{"s":"\ud800","__proto__":0}"#,
                br#"{"constructor":{"prototype":0},"s":"\ud800"}"#,
                br#"{"construc\u0074or":{"prototype":0},"s":"\ud800"}"#,
                br#"{"x":[{"__proto__":null}],"s":"\ud800"}"#,
            ];
            for body in polluted {
                assert_eq!(
                    expect_raw_error(Some("application/json"), body).await,
                    (400, invalid_json()),
                    "{}",
                    String::from_utf8_lossy(body)
                );
            }
            // keys that only resemble poison after lossy decoding stay accepted
            let accepted: [&[u8]; 2] = [
                br#"{"constructor":{},"s":"\ud800"}"#,
                br#"{"__proto__\ud800":{},"s":"\ud800"}"#,
            ];
            for body in accepted {
                assert!(
                    expect_raw(Some("application/json"), body)
                        .await
                        .value
                        .is_object(),
                    "{}",
                    String::from_utf8_lossy(body)
                );
            }
        });
    }

    #[test]
    fn raw_json_validates_the_whole_document() {
        run(async {
            assert_eq!(
                expect_raw_error(Some("application/json"), b"").await,
                (400, empty_json())
            );
            let malformed: [&[u8]; 5] = [
                br#"{"s":"\ud800""#,
                br#"{"s":"\ud800"} {}"#,
                br#"{"s":"\ud800","#,
                br#"{"s":"\u12"}"#,
                br#"{"s":"\q","t":"\ud800"}"#,
            ];
            for body in malformed {
                assert_eq!(
                    expect_raw_error(Some("application/json"), body).await,
                    (400, invalid_json()),
                    "{}",
                    String::from_utf8_lossy(body)
                );
            }
        });
    }

    #[test]
    fn raw_json_is_last_key_wins_and_keeps_its_token() {
        run(async {
            let parsed = expect_raw(Some("application/json"), br#"{"a":"\ud800","a":2}"#).await;
            assert_eq!(parsed.value, json!({ "a": 2 }));
            assert_eq!(raw_text(&parsed), Some(r#"{"a":"\ud800","a":2}"#));

            let parsed = expect_raw(Some("application/json"), br#"{"a":1,"a":"\ud800"}"#).await;
            assert_eq!(parsed.value, json!({ "a": "\u{FFFD}" }));
            assert_eq!(raw_text(&parsed), Some(r#"{"a":1,"a":"\ud800"}"#));

            // duplicate keys holding the same lone surrogate agree with JSON.parse
            let parsed =
                expect_raw(Some("application/json"), br#"{"a\ud800":1,"a\ud800":2}"#).await;
            assert_eq!(parsed.value["a\u{FFFD}"], json!(2));
        });
    }

    #[test]
    fn raw_entry_shares_the_transport_contracts() {
        run(async {
            assert_eq!(
                expect_raw_error(Some("application/octet-stream"), br#"{"s":"\ud800"}"#).await,
                (415, invalid_media_type())
            );

            let mut body = b"\xEF\xBB\xBF".to_vec();
            body.extend_from_slice(br#"{"s":"\ud800"}"#);
            let parsed = expect_raw(Some("application/json"), &body).await;
            assert_eq!(raw_text(&parsed), Some(r#"{"s":"\ud800"}"#));

            let mut framed = request(Some("application/json"), b"\"\xFF\"");
            framed
                .headers_mut()
                .insert(header::CONTENT_LENGTH, 4usize.into());
            let error = match parse_raw(framed).await {
                Ok(parsed) => panic!("expected an error, parsed {}", parsed.value),
                Err(response) => response,
            };
            assert_eq!(
                error_body(error).await,
                (
                    400,
                    envelope(
                        400,
                        "FST_ERR_CTP_INVALID_CONTENT_LENGTH",
                        "Bad Request",
                        "Request body size did not match Content-Length"
                    )
                )
            );
        });
    }

    #[test]
    fn raw_entry_keeps_text_plain_and_absent_semantics() {
        run(async {
            let parsed = expect_raw(Some("text/plain"), br#"{"s":"\ud800"}"#).await;
            assert_eq!(parsed.value, json!(r#"{"s":"\ud800"}"#));
            assert!(parsed.raw.is_none());

            let parsed = expect_raw(Some("text/plain"), b"").await;
            assert_eq!(parsed.value, json!(""));
            assert!(parsed.raw.is_none());

            let parsed = expect_raw(None, b"").await;
            assert_eq!(parsed.value, Value::Null);
            assert!(parsed.raw.is_none());

            assert_eq!(
                expect_raw_error(None, b"abc").await,
                (415, invalid_media_type())
            );
        });
    }
}
