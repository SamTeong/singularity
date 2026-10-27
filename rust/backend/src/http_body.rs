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

use axum::Json;
use axum::body::{Body, to_bytes};
use axum::http::{HeaderMap, Request, StatusCode, header};
use axum::response::{IntoResponse, Response};
use http_body_util::LengthLimitError;
use serde_json::{Value, json};

const MAX_BODY: usize = 1024 * 1024;

#[derive(Clone, Copy, PartialEq, Eq)]
enum MediaKind {
    Json,
    Plain,
    Absent,
    Unsupported,
}

pub async fn parse(request: Request<Body>) -> Result<Value, Response> {
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
    let text = String::from_utf8_lossy(&bytes);
    if kind != MediaKind::Absent && text.len() > MAX_BODY {
        return Err(body_too_large());
    }
    if kind != MediaKind::Absent && length.is_some_and(|value| value != text.len()) {
        return Err(invalid_content_length());
    }
    match kind {
        MediaKind::Json => parse_json(&text),
        MediaKind::Plain => Ok(Value::String(text.into_owned())),
        MediaKind::Absent if bytes.is_empty() => Ok(Value::Null),
        MediaKind::Absent | MediaKind::Unsupported => Err(invalid_media_type()),
    }
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

fn parse_json(text: &str) -> Result<Value, Response> {
    if text.is_empty() {
        return Err(empty_json_body());
    }
    let text = text.strip_prefix('\u{FEFF}').unwrap_or(text);
    let Ok(value) = serde_json::from_str::<Value>(text) else {
        return Err(invalid_json_body());
    };
    if !prototype_safe(&value) {
        return Err(invalid_json_body());
    }
    Ok(value)
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
    use super::{MAX_BODY, parse};
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
}
