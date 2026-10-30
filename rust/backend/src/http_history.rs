//! History HTTP surface: `GET /api/history` and `POST /api/history/regenerate`
//! (`server/index.mjs:875-897`).
//!
//! The daily History service owns scanning, summarization and persistence;
//! this module only coerces the query/body the way Node's Fastify route does
//! (`Number(req.query.days) || 7`, `req.body?.date`) and maps failures to the
//! same `{ok:false, error}` bodies. The host merges [`router`] into the `/api`
//! tree after `http_server`'s auth/origin layers.
use crate::history::{HistoryQuery, HistoryService, normalize_days};
use crate::http_body::parse;
use crate::http_policy::query_values;
use axum::body::Body;
use axum::extract::{RawQuery, State};
use axum::http::{Request, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{Value, json};
use std::sync::Arc;

/// `POST /api/history/regenerate` without a date (`server/index.mjs:991`).
const DATE_REQUIRED: &str = "date required";
/// A truthy non-string `date` (`42`, `true`, an array) has no single Node
/// contract to copy: `regenerateDay` builds an entry with that value and then
/// sorts with `a.date.localeCompare(b.date)` (`server/history.mjs:464`), which
/// throws once the file holds a second entry, so Node answers 200 for a
/// one-entry file and an error otherwise. The Rust surface answers a
/// deterministic `invalid date` instead; disclosed deviation.
const INVALID_DATE: &str = "invalid date";

// VERIFY: http_history-router-injection
/// Two routes over the shared service. The outer server layer owns auth,
/// origin and token checks.
pub fn router(service: Arc<HistoryService>) -> Router {
    Router::new()
        .route("/api/history", get(history_get))
        .route("/api/history/regenerate", post(history_regenerate))
        .with_state(service)
}

/// `GET /api/history` (`server/index.mjs:972`).
async fn history_get(
    State(service): State<Arc<HistoryService>>,
    RawQuery(raw): RawQuery,
) -> Response {
    let query = HistoryQuery {
        days: normalize_days(number_param(raw.as_deref(), "days")),
        from: string_param(raw.as_deref(), "from"),
        to: string_param(raw.as_deref(), "to"),
    };
    match service.get(&query).await {
        Ok(body) => Json(body).into_response(),
        Err(message) => internal_error(&message),
    }
}

/// `POST /api/history/regenerate` (`server/index.mjs:989`).
async fn history_regenerate(
    State(service): State<Arc<HistoryService>>,
    request: Request<Body>,
) -> Response {
    let body = match parse(request).await {
        Ok(body) => body,
        Err(response) => return response,
    };
    let date = match body.get("date") {
        Some(Value::String(date)) if !date.is_empty() => date.clone(),
        Some(value) if truthy(value) => return bad_request(INVALID_DATE),
        _ => return bad_request(DATE_REQUIRED),
    };
    match service.regenerate(&date, None).await {
        Ok(entry) => Json(json!({ "ok": true, "entry": entry })).into_response(),
        Err(message) => bad_request(&message),
    }
}

/// `Number(req.query[name])`: absent is `NaN` (=> the `|| 7` default), a single
/// value goes through JavaScript `Number()`, a repeated key is an array whose
/// string form (`"a,b"`) is `NaN`.
fn number_param(raw: Option<&str>, name: &str) -> f64 {
    let Some(raw) = raw else {
        return f64::NAN;
    };
    let values = query_values(raw, name);
    match values.len() {
        1 => js_number(&values[0]),
        _ => f64::NAN,
    }
}

/// `req.query[name]` as the route compares/filters it: a repeated key becomes
/// its array string form (`"a,b"`), an empty value is falsy and dropped.
fn string_param(raw: Option<&str>, name: &str) -> Option<String> {
    let raw = raw?;
    let values = query_values(raw, name);
    match values.len() {
        0 => None,
        1 => values.into_iter().next().filter(|value| !value.is_empty()),
        _ => Some(values.join(",")),
    }
}

/// JavaScript `Number(string)` for query-string shapes (same documented gap as
/// the transcripts route: Rust additionally accepts `inf`/`NaN` spellings).
fn js_number(text: &str) -> f64 {
    let trimmed =
        text.trim_matches(|character: char| character.is_whitespace() || character == '\u{FEFF}');
    if trimmed.is_empty() {
        return 0.0;
    }
    let (sign, digits) = match trimmed.strip_prefix('-') {
        Some(rest) => (-1.0, rest),
        None => (1.0, trimmed.strip_prefix('+').unwrap_or(trimmed)),
    };
    if digits.eq_ignore_ascii_case("infinity") {
        return sign * f64::INFINITY;
    }
    for (prefix, radix) in [("0x", 16), ("0o", 8), ("0b", 2)] {
        if let Some(rest) = digits
            .strip_prefix(prefix)
            .or_else(|| digits.strip_prefix(&prefix.to_uppercase()))
        {
            return u64::from_str_radix(rest, radix)
                .map(|value| sign * value as f64)
                .unwrap_or(f64::NAN);
        }
    }
    digits
        .parse::<f64>()
        .map(|value| sign * value)
        .unwrap_or(f64::NAN)
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(number) => number.as_f64().is_some_and(|value| value != 0.0),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

fn bad_request(message: &str) -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({ "ok": false, "error": message })),
    )
        .into_response()
}

fn internal_error(message: &str) -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({ "ok": false, "error": message })),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn days_coerces_like_number_or_seven() {
        assert!(number_param(Some("days=3"), "days") == 3.0);
        assert!(number_param(Some("days="), "days") == 0.0);
        assert!(number_param(None, "days").is_nan());
        assert!(number_param(Some("days=7&days=8"), "days").is_nan());
        assert!(number_param(Some("days=0x10"), "days") == 16.0);
    }

    #[test]
    fn normalize_days_falls_back_for_zero_and_nan() {
        assert_eq!(normalize_days(0.0), 7.0);
        assert_eq!(normalize_days(f64::NAN), 7.0);
        assert_eq!(normalize_days(3.0), 3.0);
        assert_eq!(normalize_days(-2.0), -2.0);
    }

    #[test]
    fn from_and_to_keep_fastify_shapes() {
        assert_eq!(
            string_param(Some("from=2026-01-01"), "from").as_deref(),
            Some("2026-01-01")
        );
        assert_eq!(string_param(Some("from="), "from"), None);
        assert_eq!(
            string_param(Some("to=a&to=b"), "to").as_deref(),
            Some("a,b")
        );
        assert_eq!(string_param(None, "to"), None);
        assert_eq!(string_param(Some("days=1"), "to"), None);
    }

    #[test]
    fn date_body_values_follow_javascript_truthiness() {
        assert!(truthy(&json!("2026-01-01")));
        assert!(!truthy(&json!("")));
        assert!(!truthy(&json!(0)));
        assert!(truthy(&json!(1)));
    }
}
