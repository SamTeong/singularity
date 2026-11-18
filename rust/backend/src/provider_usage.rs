//! Provider usage result normalization for the existing JSON-lines bridge.
use serde::Deserialize;
use serde::de::{MapAccess, Visitor};
use serde_json::value::RawValue;
use std::fmt;

#[derive(Debug, Deserialize)]
pub struct Request {
    pub provider: String,
    pub payload_present: bool,
    pub payload: Box<RawValue>,
    #[serde(default)]
    pub plan: Option<Box<RawValue>>,
    #[serde(default)]
    pub fetched_at: Option<String>,
}

type Fields = Option<Vec<(String, Box<RawValue>)>>;

#[derive(Deserialize)]
#[serde(transparent)]
struct RawFields(#[serde(deserialize_with = "deserialize_fields")] Vec<(String, Box<RawValue>)>);

fn deserialize_fields<'de, D>(deserializer: D) -> Result<Vec<(String, Box<RawValue>)>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    struct FieldsVisitor;
    impl<'de> Visitor<'de> for FieldsVisitor {
        type Value = Vec<(String, Box<RawValue>)>;

        fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            formatter.write_str("a JSON object")
        }

        fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
        where
            A: MapAccess<'de>,
        {
            let mut fields = Vec::new();
            while let Some(field) = map.next_entry::<String, Box<RawValue>>()? {
                fields.push(field);
            }
            Ok(fields)
        }
    }
    deserializer.deserialize_map(FieldsVisitor)
}

fn object(raw: Option<&RawValue>) -> Fields {
    let raw = raw?;
    if raw.get().starts_with('[') {
        return Some(Vec::new());
    }
    serde_json::from_str::<RawFields>(raw.get())
        .ok()
        .map(|fields| fields.0)
}

fn field<'a>(fields: &'a Fields, key: &str) -> Option<&'a RawValue> {
    fields
        .as_ref()?
        .iter()
        .find(|(name, _)| name == key)
        .map(|(_, value)| value.as_ref())
}

fn is_null(raw: &RawValue) -> bool {
    raw.get() == "null"
}

fn array_string(raw: &RawValue) -> Option<String> {
    array_string_text(raw.get())
}

fn object_has_own_to_string(raw: &RawValue) -> bool {
    field(&object(Some(raw)), "toString").is_some()
}

fn array_string_throws(raw: &RawValue) -> bool {
    let Ok(values) = serde_json::from_str::<Vec<Box<RawValue>>>(raw.get()) else {
        return false;
    };
    values
        .iter()
        .any(|value| match value.get().as_bytes().first() {
            Some(b'{') => object_has_own_to_string(value),
            Some(b'[') => array_string_throws(value),
            _ => false,
        })
}

fn array_string_text(raw: &str) -> Option<String> {
    let values: Vec<Box<RawValue>> = serde_json::from_str(raw).ok()?;
    let parts = values
        .iter()
        .map(|value| match value.get() {
            "null" => Some(String::new()),
            value if value.starts_with('"') => serde_json::from_str(value).ok(),
            value if value.starts_with('[') => array_string_text(value),
            value if value.starts_with('{') => Some("[object Object]".into()),
            value => Some(value.into()),
        })
        .collect::<Option<Vec<_>>>()?;
    Some(parts.join(","))
}

/// The small subset of JavaScript Number coercion used by provider DTOs.
fn number(raw: Option<&RawValue>) -> Result<f64, String> {
    let Some(raw) = raw else { return Ok(f64::NAN) };
    if (raw.get().starts_with('{') && object_has_own_to_string(raw))
        || (raw.get().starts_with('[') && array_string_throws(raw))
    {
        return Err("Cannot convert object to primitive value".into());
    }
    Ok(match raw.get() {
        "null" | "false" => 0.0,
        "true" => 1.0,
        value if value.starts_with('"') => serde_json::from_str::<String>(value)
            .map(|value| parse_number(&value))
            .unwrap_or(f64::NAN),
        value if value.starts_with('[') => array_string(raw)
            .map(|value| parse_number(&value))
            .unwrap_or(f64::NAN),
        value if value.starts_with('{') => f64::NAN,
        value => value.parse().unwrap_or(f64::NAN),
    })
}

fn parse_number(value: &str) -> f64 {
    let value = value.trim();
    if value.is_empty() {
        return 0.0;
    }
    match value {
        "Infinity" | "+Infinity" => f64::INFINITY,
        "-Infinity" => f64::NEG_INFINITY,
        value if value.starts_with("0x") || value.starts_with("0X") => {
            u64::from_str_radix(&value[2..], 16)
                .map(|number| number as f64)
                .unwrap_or(f64::NAN)
        }
        value if value.starts_with("0b") || value.starts_with("0B") => {
            u64::from_str_radix(&value[2..], 2)
                .map(|number| number as f64)
                .unwrap_or(f64::NAN)
        }
        value if value.starts_with("0o") || value.starts_with("0O") => {
            u64::from_str_radix(&value[2..], 8)
                .map(|number| number as f64)
                .unwrap_or(f64::NAN)
        }
        _ => value.parse().unwrap_or(f64::NAN),
    }
}

fn truthy(raw: &RawValue) -> bool {
    match raw.get() {
        "null" | "false" => false,
        value if value.starts_with('"') => serde_json::from_str::<String>(value)
            .map(|value| !value.is_empty())
            .unwrap_or(true),
        value if value.starts_with('{') || value.starts_with('[') => true,
        value => number_text(value) != Some(0.0),
    }
}

fn number_text(value: &str) -> Option<f64> {
    value.parse().ok()
}

fn strict_finite(raw: Option<&RawValue>) -> Result<Option<f64>, String> {
    let Some(raw) = raw else { return Ok(None) };
    if raw.get().starts_with('"')
        || raw.get().starts_with('{')
        || raw.get().starts_with('[')
        || matches!(raw.get(), "null" | "true" | "false")
    {
        return Ok(None);
    }
    let value = number(Some(raw))?;
    Ok(value.is_finite().then_some(value))
}

fn json_number(value: f64) -> String {
    if value.is_finite() {
        if value == 0.0 {
            "0".into()
        } else {
            value.to_string()
        }
    } else {
        "null".into()
    }
}

fn nullish(raw: Option<&RawValue>) -> &str {
    raw.filter(|value| !is_null(value))
        .map(RawValue::get)
        .unwrap_or("null")
}

fn claude_window(raw: Option<&RawValue>) -> Result<Option<String>, String> {
    let Some(raw) = raw.filter(|value| truthy(value)) else {
        return Ok(None);
    };
    let fields = object(Some(raw));
    let Some(utilization) = field(&fields, "utilization").filter(|value| !is_null(value)) else {
        return Ok(None);
    };
    let pct_used = number(Some(utilization))?;
    let resets_at = nullish(field(&fields, "resets_at"));
    Ok(Some(format!(
        "{{\"pctUsed\":{},\"resetsAt\":{},\"models\":[]{}{}}}",
        json_number(pct_used),
        resets_at,
        if pct_used == 0.0 && resets_at == "null" {
            ",\"started\":false"
        } else {
            ""
        },
        ""
    )))
}

fn claude_models(root: &Fields) -> Result<String, String> {
    let mut rows = Vec::new();
    for (key, model) in [
        ("seven_day_sonnet", "sonnet"),
        ("seven_day_opus", "opus"),
        ("seven_day_omelette", "design"),
    ] {
        let Some(window) = field(root, key).filter(|value| truthy(value)) else {
            continue;
        };
        let fields = object(Some(window));
        let Some(utilization) = field(&fields, "utilization").filter(|value| !is_null(value))
        else {
            continue;
        };
        rows.push(format!(
            "{{\"model\":{model:?},\"pctUsed\":{}}}",
            json_number(number(Some(utilization))?)
        ));
    }
    Ok(format!("[{}]", rows.join(",")))
}

fn claude(req: &Request) -> Result<String, String> {
    if !req.payload_present || is_null(&req.payload) {
        return Err("Cannot read properties of null (reading 'five_hour')".into());
    }
    let root = object(Some(&req.payload));
    let session = claude_window(field(&root, "five_hour"))?.unwrap_or_else(|| "null".into());
    let weekly = match claude_window(field(&root, "seven_day"))? {
        Some(window) => window.replace(
            "\"models\":[]",
            &format!("\"models\":{}", claude_models(&root)?),
        ),
        None => "null".into(),
    };

    let extra_fields = field(&root, "extra_usage")
        .filter(|value| value.get().starts_with('{') || value.get().starts_with('['))
        .and_then(|value| object(Some(value)));
    let extra = if let Some(fields) = extra_fields {
        let fields = Some(fields);
        let pct = match field(&fields, "utilization").filter(|value| !is_null(value)) {
            Some(value) => json_number(number(Some(value))?),
            None => {
                let spend = field(&root, "spend")
                    .filter(|value| truthy(value))
                    .and_then(|value| object(Some(value)));
                match field(&spend, "percent").filter(|value| !is_null(value)) {
                    Some(value) => json_number(number(Some(value))?),
                    None => "null".into(),
                }
            }
        };
        format!(
            "{{\"enabled\":{},\"used\":{},\"monthlyLimit\":{},\"pctUsed\":{},\"resetsAt\":{}}}",
            nullish(field(&fields, "is_enabled")),
            nullish(field(&fields, "used_credits")),
            nullish(field(&fields, "monthly_limit")),
            pct,
            nullish(field(&fields, "resets_at"))
        )
    } else {
        "null".into()
    };

    Ok(format!(
        "{{\"ok\":true,\"source\":\"claude\",\"plan\":{},\"session\":{},\"weekly\":{},\"extra\":{}}}",
        nullish(req.plan.as_deref()),
        session,
        weekly,
        extra
    ))
}

fn codex_window(raw: Option<&RawValue>) -> Result<Option<(f64, f64, String, bool)>, String> {
    let fields = object(raw);
    let duration = number(field(&fields, "limit_window_seconds"))?;
    let Some(pct) = strict_finite(field(&fields, "used_percent"))? else {
        return Ok(None);
    };
    if !duration.is_finite() {
        return Ok(None);
    }
    let unstarted = number(field(&fields, "reset_after_seconds"))? >= duration;
    let reset = if unstarted {
        "null".into()
    } else if let Some(seconds) = strict_finite(field(&fields, "reset_at"))? {
        let milliseconds = (seconds * 1000.0).trunc();
        if !milliseconds.is_finite() || milliseconds.abs() > 8.64e15 {
            return Err("Invalid time value".into());
        }
        let milliseconds = milliseconds as i64;
        let date =
            time::OffsetDateTime::from_unix_timestamp_nanos(i128::from(milliseconds) * 1_000_000)
                .map_err(|_| "Invalid time value".to_owned())?
                .to_offset(time::UtcOffset::UTC);
        let year = date.year();
        let year = if (0..=9999).contains(&year) {
            format!("{year:04}")
        } else {
            format!("{year:+07}")
        };
        let date = format!(
            "{year}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
            u8::from(date.month()),
            date.day(),
            date.hour(),
            date.minute(),
            date.second(),
            date.millisecond()
        );
        serde_json::to_string(&date).map_err(|error| error.to_string())?
    } else {
        "null".into()
    };
    Ok(Some((duration, pct, reset, unstarted)))
}

fn codex(req: &Request) -> Result<String, String> {
    let root = object(Some(&req.payload));
    let rate_limit = object(field(&root, "rate_limit"));
    let mut session = None;
    let mut weekly = None;
    for key in ["primary_window", "secondary_window"] {
        let Some((duration, pct, reset, unstarted)) = codex_window(field(&rate_limit, key))? else {
            continue;
        };
        let window = format!(
            "{{\"pctUsed\":{},\"resetsAt\":{},\"models\":[]{}}}",
            json_number(pct),
            reset,
            if unstarted { ",\"started\":false" } else { "" }
        );
        if duration >= 86400.0 {
            weekly = Some(window);
        } else {
            session = Some(window);
        }
    }
    if session.is_none() && weekly.is_none() {
        return Ok("null".into());
    }
    Ok(format!(
        "{{\"ok\":true,\"source\":\"codex\",\"plan\":{},\"fetchedAt\":{},\"session\":{},\"weekly\":{}}}",
        nullish(field(&root, "plan_type")),
        serde_json::to_string(req.fetched_at.as_deref().unwrap_or("")).unwrap(),
        session.unwrap_or_else(|| "null".into()),
        weekly.unwrap_or_else(|| "null".into())
    ))
}

fn ollama(req: &Request) -> String {
    let data = object(Some(&req.payload));
    format!(
        "{{\"ok\":{},\"source\":\"ollama\",\"plan\":{},\"session\":{},\"weekly\":{},\"extra\":null,\"fetchedAt\":{},\"stale\":{},\"needsAuth\":{},\"error\":{}}}",
        field(&data, "ok")
            .filter(|value| truthy(value))
            .map(|_| "true")
            .unwrap_or("false"),
        nullish(field(&data, "plan")),
        nullish(field(&data, "session")),
        nullish(field(&data, "weekly")),
        nullish(field(&data, "fetchedAt")),
        field(&data, "stale")
            .filter(|value| truthy(value))
            .map(|_| "true")
            .unwrap_or("false"),
        field(&data, "needsAuth")
            .filter(|value| truthy(value))
            .map(|_| "true")
            .unwrap_or("false"),
        nullish(field(&data, "error"))
    )
}

pub fn normalize(req: &Request) -> Result<Box<RawValue>, String> {
    let output = match req.provider.as_str() {
        "claude" => claude(req)?,
        "codex" => codex(req)?,
        "ollama" => ollama(req),
        _ => return Err("unknown provider".into()),
    };
    RawValue::from_string(output).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(provider: &str, payload: &str, plan: Option<&str>, fetched_at: Option<&str>) -> String {
        let request: Request = serde_json::from_str(&format!(
            "{{\"provider\":{provider:?},\"payload_present\":true,\"payload\":{payload},\"plan\":{},\"fetched_at\":{}}}",
            plan.unwrap_or("null"),
            fetched_at.map(|value| format!("{value:?}")).unwrap_or_else(|| "null".into())
        )).unwrap();
        normalize(&request).unwrap().get().to_owned()
    }

    fn normalize_payload(provider: &str, payload: &str) -> Result<String, String> {
        let request: Request = serde_json::from_str(&format!(
            "{{\"provider\":{provider:?},\"payload_present\":true,\"payload\":{payload}}}"
        ))
        .unwrap();
        normalize(&request).map(|value| value.get().to_owned())
    }

    #[test]
    fn claude_distinguishes_null_missing_and_primitive_roots() {
        let absent: Request =
            serde_json::from_str(r#"{"provider":"claude","payload_present":false,"payload":null}"#)
                .unwrap();
        assert!(normalize(&absent).unwrap_err().contains("five_hour"));
        let explicit_null: Request =
            serde_json::from_str(r#"{"provider":"claude","payload_present":true,"payload":null}"#)
                .unwrap();
        assert!(normalize(&explicit_null).unwrap_err().contains("five_hour"));
    }

    #[test]
    fn claude_preserves_windows_model_splits_and_zero_reset_shape() {
        let result = run(
            "claude",
            r#"{"five_hour":{"utilization":"0","resets_at":null},"seven_day":{"utilization":63},"seven_day_sonnet":{"utilization":"31"},"seven_day_omelette":{"utilization":5},"extra_usage":{"is_enabled":false,"used_credits":0,"monthly_limit":20,"utilization":null},"spend":{"percent":"12"}}"#,
            Some("\"max\""),
            None,
        );
        assert!(result.contains(r#""plan":"max""#));
        assert!(result.contains(r#""started":false"#));
        assert!(result.contains(r#""model":"design","pctUsed":5"#));
        assert!(result.contains(r#""enabled":false,"used":0,"monthlyLimit":20,"pctUsed":12"#));
    }

    #[test]
    fn claude_primitive_roots_and_missing_values_return_null_fields() {
        for payload in ["7", r#""text""#, "[]"] {
            assert_eq!(
                run("claude", payload, None, None),
                r#"{"ok":true,"source":"claude","plan":null,"session":null,"weekly":null,"extra":null}"#
            );
        }
        let result = run("claude", r#"{"five_hour":{},"seven_day":null}"#, None, None);
        assert!(result.contains(r#""session":null,"weekly":null"#));
    }

    #[test]
    fn number_coercion_preserves_object_errors_and_ordinary_object_nan() {
        let ordinary_object: Box<RawValue> = serde_json::from_str("{}").unwrap();
        assert!(number(Some(&ordinary_object)).unwrap().is_nan());

        for payload in [
            r#"{"toString":1}"#,
            r#"[{"toString":null}]"#,
            r#"[[{"toString":false}]]"#,
        ] {
            let value: Box<RawValue> = serde_json::from_str(payload).unwrap();
            assert_eq!(
                number(Some(&value)).unwrap_err(),
                "Cannot convert object to primitive value"
            );
        }
    }

    #[test]
    fn provider_number_coercion_errors_propagate_for_claude_and_codex_fields() {
        for payload in [
            r#"{"five_hour":{"utilization":{"toString":1}}}"#,
            r#"{"seven_day":{"utilization":1},"seven_day_sonnet":{"utilization":{"toString":1}}}"#,
            r#"{"extra_usage":{"utilization":{"toString":1}}}"#,
            r#"{"extra_usage":{"utilization":null},"spend":{"percent":{"toString":1}}}"#,
            r#"{"five_hour":{"utilization":[[{"toString":1}]]}}"#,
        ] {
            assert!(
                normalize_payload("claude", payload)
                    .unwrap_err()
                    .contains("Cannot convert object to primitive value"),
                "Claude payload {payload} should retain its Number coercion error"
            );
        }

        for window in [
            r#"{"used_percent":1,"limit_window_seconds":{"toString":1}}"#,
            r#"{"used_percent":1,"limit_window_seconds":60,"reset_after_seconds":{"toString":1}}"#,
        ] {
            let payload = format!(r#"{{"rate_limit":{{"primary_window":{window}}}}}"#);
            assert!(
                normalize_payload("codex", &payload)
                    .unwrap_err()
                    .contains("Cannot convert object to primitive value"),
                "Codex window {window} should retain its Number coercion error"
            );
        }
    }

    #[test]
    fn codex_uses_strict_finite_percent_and_numeric_duration_coercion() {
        let result = run(
            "codex",
            r#"{"plan_type":null,"rate_limit":{"primary_window":{"used_percent":30,"limit_window_seconds":"18000","reset_after_seconds":18000,"reset_at":1780000000},"secondary_window":{"used_percent":"40","limit_window_seconds":604800}}}"#,
            None,
            Some("2026-01-01T00:00:00.000Z"),
        );
        assert!(
            result.contains(
                r#""session":{"pctUsed":30,"resetsAt":null,"models":[],"started":false}"#
            )
        );
        assert!(result.contains(r#""weekly":null"#));
        assert!(!result.contains("extra"));
    }

    #[test]
    fn codex_weekly_only_and_no_usable_windows_match_source_shape() {
        let weekly = run(
            "codex",
            r#"{"rate_limit":{"primary_window":{"used_percent":101,"limit_window_seconds":604800,"reset_after_seconds":1,"reset_at":1780000000}}}"#,
            None,
            Some("fetched"),
        );
        assert!(weekly.contains(r#""session":null,"weekly":{"pctUsed":101"#));
        assert_eq!(
            run(
                "codex",
                r#"{"rate_limit":{"primary_window":{"used_percent":"101","limit_window_seconds":604800}}}"#,
                None,
                None
            ),
            "null"
        );
    }

    #[test]
    fn ollama_keeps_nullish_values_and_truthy_flags() {
        let result = run(
            "ollama",
            r#"{"ok":"yes","plan":"","session":false,"weekly":0,"stale":[],"needsAuth":{},"error":null}"#,
            None,
            None,
        );
        assert_eq!(
            result,
            r#"{"ok":true,"source":"ollama","plan":"","session":false,"weekly":0,"extra":null,"fetchedAt":null,"stale":true,"needsAuth":true,"error":null}"#
        );
    }
}
