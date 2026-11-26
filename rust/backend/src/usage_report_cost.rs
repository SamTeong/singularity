//! Pricing table and per-message cost helpers for the bundled usage report.
//!
//! Mirrors the pricing/cost half of the bundled stats.mjs (`_extract_state`
//! S:245-260, `_msg_tokens` S:514-523, `_load_pricing` S:539-621 and
//! `computed_cost_from_transcript` S:628-659). Only `Pricing::load` touches the
//! filesystem; everything else is pure. Local JS coercion helpers shared with
//! `usage_report_sessions` live at the bottom of this module.

use serde_json::Value;
use std::path::Path;

const DEFAULT_THRESHOLD: f64 = 200_000.0;
const OPENAI_LONG_CONTEXT_THRESHOLD: f64 = 272_000.0;
// stats.mjs:550-556. Fixed keys always use 272k; default keys use it only when
// pricing.json omits `long_context_threshold`.
const FIXED_OPENAI_LONG_CONTEXT_KEYS: [&str; 4] =
    ["gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-sol", "gpt-6-luna"];
const DEFAULT_OPENAI_LONG_CONTEXT_KEYS: [&str; 6] = [
    "gpt-6.2-astra",
    "gpt-6.2-sol",
    "gpt-6-astra",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
];

/// `pricing.json` as the report sees it. `base`/`above` keep the document's
/// key order because `price_key` matches in that order (stats.mjs:534-537).
#[derive(Debug, Clone, PartialEq)]
pub struct Pricing {
    base: Vec<(String, [f64; 4])>,
    above: Vec<(String, [f64; 4])>,
    long_context_threshold: Option<f64>,
    default_key: String,
}

impl Default for Pricing {
    fn default() -> Self {
        Self {
            base: Vec::new(),
            above: Vec::new(),
            long_context_threshold: None,
            default_key: String::new(),
        }
    }
}

impl Pricing {
    /// `_load_pricing` (stats.mjs:555-571) file half: a missing or unreadable
    /// `<state_dir>/pricing.json` leaves every model unpriced.
    pub fn load(state_dir: impl AsRef<Path>) -> Self {
        let Ok(bytes) = std::fs::read(state_dir.as_ref().join("pricing.json")) else {
            return Self::default();
        };
        Self::from_json(&String::from_utf8_lossy(&bytes))
    }

    /// `_load_pricing` (stats.mjs:555-571) parse half. Invalid JSON, a non-object
    /// document, or a document with no usable table yields the empty default.
    pub fn from_json(text: &str) -> Self {
        let Ok(document) = serde_json::from_str::<Value>(text) else {
            return Self::default();
        };
        Self::from_document(&document)
    }

    fn from_document(document: &Value) -> Self {
        let Value::Object(map) = document else {
            return Self::default();
        };
        let base_value = map.get("base").filter(|value| truthy(value));
        // A bare `{model: rate}` map is accepted as `base` (stats.mjs:560).
        let bare = base_value.is_none()
            && !map.get("above_200k").is_some_and(truthy)
            && !map.contains_key("long_context_threshold")
            && !map.contains_key("default_key");
        let base = match base_value {
            Some(value) if object_like(value) => Some(value),
            _ if bare => Some(document),
            _ => None,
        };
        let mut pricing = Self::default();
        if let Some(base) = base {
            for (key, value) in js_entries(base) {
                if let Some(rate) = rate(value) {
                    pricing.base.push((key, rate));
                }
            }
        }
        if let Some(above) = map
            .get("above_200k")
            .filter(|value| truthy(value) && object_like(value))
        {
            for (key, value) in js_entries(above) {
                if let Some(rate) = rate(value) {
                    pricing.above.push((key, rate));
                }
            }
        }
        if let Some(Value::Number(number)) = map.get("long_context_threshold")
            && let Some(value) = number.as_f64()
            && value.is_finite()
            && value > 0.0
        {
            pricing.long_context_threshold = Some(value);
        }
        if let Some(Value::String(key)) = map.get("default_key") {
            pricing.default_key = key.clone();
        }
        pricing
    }

    /// `_price_key` (stats.mjs:575-581): first `base` key that is a substring of
    /// the lowercased model id without splitting a numeric version/date segment,
    /// else the default key when it names a real entry.
    pub fn price_key(&self, model: &str) -> Option<&str> {
        let model = model.to_lowercase();
        for (key, _) in &self.base {
            if model.match_indices(key.as_str()).any(|(at, _)| {
                !(key.as_bytes().last().is_some_and(u8::is_ascii_digit)
                    && model.as_bytes().get(at + key.len()).is_some_and(u8::is_ascii_digit))
            }) {
                return Some(key);
            }
        }
        (!self.default_key.is_empty() && self.base.iter().any(|(key, _)| *key == self.default_key))
            .then_some(self.default_key.as_str())
    }

    /// `_is_third_party` (stats.mjs:590-593): priced with a non-Anthropic key.
    pub fn is_third_party(&self, model: &str) -> bool {
        self.price_key(model).is_some_and(|key| {
            !(key.starts_with("opus")
                || key.starts_with("sonnet")
                || key.starts_with("haiku")
                || key.starts_with("fable")
                || key.starts_with("claude-"))
        })
    }

    /// `_maybe_warn_unknown_model` (codex.mjs:303-311) predicate: a nonempty
    /// model that looks like a Codex id but resolves to no price entry, or to
    /// the configured `default_key`, is billed at a rate that is not its own.
    pub fn should_warn_unknown_model(&self, model: &str) -> bool {
        // `/^(gpt-|codex)/i` over an ASCII-only pattern: case folding the model
        // is equivalent for these characters.
        let lower = model.to_lowercase();
        !model.is_empty()
            && (lower.starts_with("gpt-") || lower.starts_with("codex"))
            && self
                .price_key(model)
                .is_none_or(|key| key == self.default_key)
    }

    /// `_msg_cost` (stats.mjs:595-600). `None` when the model is unpriced.
    pub fn msg_cost(&self, model: &str, i: f64, o: f64, cr: f64, cc: f64) -> Option<f64> {
        let [inp, out, crp, ccp] = self.rate(self.price_key(model)?)?;
        Some((i * inp + o * out + cr * crp + cc * ccp) / 1e6)
    }

    /// `_msg_cost_tiered` (stats.mjs:605-621): the long-context rate applies per
    /// request when input-side tokens exceed the model's threshold.
    pub fn msg_cost_tiered(&self, model: &str, i: f64, o: f64, cr: f64, cc: f64) -> Option<f64> {
        let key = self.price_key(model)?;
        // Sol/Luna surcharge above 272k and haiku-5-5 above 100k are
        // model-specific quirks, not part of the pricing.json schema. The
        // remaining OpenAI keys use 272k only when no global threshold is set
        // (stats.mjs:620-622).
        let threshold = if FIXED_OPENAI_LONG_CONTEXT_KEYS.contains(&key) {
            OPENAI_LONG_CONTEXT_THRESHOLD
        } else if key == "haiku-5-5" {
            100_000.0
        } else {
            self.long_context_threshold.unwrap_or(
                if DEFAULT_OPENAI_LONG_CONTEXT_KEYS.contains(&key) {
                    OPENAI_LONG_CONTEXT_THRESHOLD
                } else {
                    DEFAULT_THRESHOLD
                },
            )
        };
        if let Some([inp, out, crp, ccp]) = self.above_rate(key)
            && i + cr + cc > threshold
        {
            return Some((i * inp + o * out + cr * crp + cc * ccp) / 1e6);
        }
        self.msg_cost(model, i, o, cr, cc)
    }

    /// `computed_cost_from_transcript` (stats.mjs:649-659) minus the subagent
    /// glob: the caller supplies the main transcript and every subagent
    /// transcript text. Summed per assistant message so the tier applies per
    /// request; the main transcript skips sidechain echoes, subagent transcripts
    /// are themselves sidechains and include them.
    pub fn computed_cost_from_transcript(&self, main_text: &str, sub_texts: &[&str]) -> f64 {
        let mut usd = self.transcript_msg_cost(main_text, false);
        for text in sub_texts {
            usd += self.transcript_msg_cost(text, true);
        }
        usd
    }

    fn rate(&self, key: &str) -> Option<[f64; 4]> {
        self.base
            .iter()
            .find(|(candidate, _)| candidate == key)
            .map(|(_, rate)| *rate)
    }

    fn above_rate(&self, key: &str) -> Option<[f64; 4]> {
        self.above
            .iter()
            .find(|(candidate, _)| candidate == key)
            .map(|(_, rate)| *rate)
    }

    fn transcript_msg_cost(&self, text: &str, include_sidechain: bool) -> f64 {
        let mut usd = 0.0;
        for line in text.split('\n') {
            let line = js_trim(line);
            if line.is_empty() {
                continue;
            }
            let Ok(entry) = serde_json::from_str::<Value>(line) else {
                continue;
            };
            if !include_sidechain && entry.get("isSidechain") == Some(&Value::Bool(true)) {
                continue;
            }
            if entry.get("isMeta") == Some(&Value::Bool(true)) {
                continue;
            }
            if entry.get("type").and_then(Value::as_str) != Some("assistant") {
                continue;
            }
            let Some(tokens) = msg_tokens(entry.get("message").unwrap_or(&Value::Null)) else {
                continue;
            };
            if let Some(cost) = self.msg_cost_tiered(
                tokens.model.as_deref().unwrap_or(""),
                tokens.i,
                tokens.o,
                tokens.cr,
                tokens.cc,
            ) {
                usd += cost;
            }
        }
        usd
    }
}

/// `_msg_tokens` (stats.mjs:514-523): token counts from an assistant message;
/// `None` for synthetic/zero rows.
#[derive(Debug, Clone, PartialEq)]
pub struct MsgTokens {
    pub i: f64,
    pub o: f64,
    pub cr: f64,
    pub cc: f64,
    pub model: Option<String>,
}

/// `_msg_tokens` (stats.mjs:514-523). The `usage` object is only honored when it
/// is a non-null, non-array object; any other value counts as absent.
pub fn msg_tokens(msg: &Value) -> Option<MsgTokens> {
    let usage = msg
        .get("usage")
        .filter(|value| matches!(value, Value::Object(_)));
    let field = |name: &str| inum_value(usage.and_then(|usage| usage.get(name)));
    let (i, o, cr, cc) = (
        field("input_tokens"),
        field("output_tokens"),
        field("cache_read_input_tokens"),
        field("cache_creation_input_tokens"),
    );
    let model = msg.get("model").and_then(Value::as_str);
    if model == Some("<synthetic>") || (i == 0.0 && o == 0.0 && cr == 0.0 && cc == 0.0) {
        return None;
    }
    Some(MsgTokens {
        i,
        o,
        cr,
        cc,
        model: model.map(str::to_owned),
    })
}

/// `_extract_state` (stats.mjs:245-260) result. `cost` and the rate/context
/// gauge fields stay raw (`None` means JSON `null`); the numeric counters
/// pre-apply the `_inum` coercion their only consumer performs.
#[derive(Debug, Clone, PartialEq)]
pub struct CostState {
    pub cost: Option<Value>,
    pub model_id: String,
    pub model_display_name: String,
    pub duration_ms: f64,
    pub api_duration_ms: f64,
    pub lines_added: f64,
    pub lines_removed: f64,
    pub rl_5h_pct: Option<Value>,
    pub rl_7d_pct: Option<Value>,
    pub context_pct: Option<Value>,
    pub context_window_size: Option<Value>,
    pub raw: Value,
}

/// `_extract_state` (stats.mjs:245-260); `document` is a parsed statusline
/// cost-state JSON document.
pub fn extract_state(document: &Value) -> CostState {
    CostState {
        cost: dig(document, &["cost", "total_cost_usd"]).cloned(),
        model_id: string_or_blank(dig(document, &["model", "id"])),
        model_display_name: string_or_blank(dig(document, &["model", "display_name"])),
        duration_ms: inum_value(dig(document, &["cost", "total_duration_ms"])),
        api_duration_ms: inum_value(dig(document, &["cost", "total_api_duration_ms"])),
        lines_added: inum_value(dig(document, &["cost", "total_lines_added"])),
        lines_removed: inum_value(dig(document, &["cost", "total_lines_removed"])),
        rl_5h_pct: dig(document, &["rate_limits", "five_hour", "used_percentage"]).cloned(),
        rl_7d_pct: dig(document, &["rate_limits", "seven_day", "used_percentage"]).cloned(),
        context_pct: dig(document, &["context_window", "used_percentage"]).cloned(),
        context_window_size: dig(document, &["context_window", "context_window_size"]).cloned(),
        raw: document.clone(),
    }
}

/// `_dig` (stats.mjs:235-243): walk object keys; a missing key, `null`, or a
/// non-object/array intermediate yields `None`.
fn dig<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    let mut current = value;
    for key in keys {
        let Value::Object(map) = current else {
            return None;
        };
        current = map.get(*key).filter(|value| !value.is_null())?;
    }
    Some(current)
}

/// `_dig(...) || ""` then string coercion: only strings and non-zero numbers
/// survive in practice.
fn string_or_blank(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Bool(true)) => "true".into(),
        Some(Value::Number(number)) => number
            .as_f64()
            .filter(|number| *number != 0.0)
            .map_or_else(String::new, js_number),
        // shortcut: objects/arrays would print "[object Object]" or a join;
        // cost-state model fields are strings, so those shapes map to "".
        _ => String::new(),
    }
}

fn object_like(value: &Value) -> bool {
    matches!(value, Value::Object(_) | Value::Array(_))
}

/// JS truthiness of a parsed JSON value.
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number
            .as_f64()
            .is_some_and(|number| number != 0.0 && !number.is_nan()),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// `Object.entries` order: integer-like keys ascending first, then insertion
/// order (stats.mjs:562, 564 use `Object.entries` for both tables).
fn js_entries(value: &Value) -> Vec<(String, &Value)> {
    match value {
        Value::Object(map) => {
            let mut indices = Vec::new();
            let mut rest = Vec::new();
            for (key, item) in map {
                match array_index(key) {
                    Some(index) => indices.push((index, key.clone(), item)),
                    None => rest.push((key.clone(), item)),
                }
            }
            indices.sort_by_key(|(index, ..)| *index);
            indices
                .into_iter()
                .map(|(_, key, item)| (key, item))
                .chain(rest)
                .collect()
        }
        Value::Array(items) => items
            .iter()
            .enumerate()
            .map(|(index, item)| (index.to_string(), item))
            .collect(),
        _ => Vec::new(),
    }
}

fn array_index(key: &str) -> Option<u32> {
    if key.is_empty() || (key.len() > 1 && key.starts_with('0')) {
        return None;
    }
    let index = key.parse::<u32>().ok()?;
    (index != u32::MAX && index.to_string() == key).then_some(index)
}

/// `_is_rate` (stats.mjs:551-553): exactly four finite numbers.
fn rate(value: &Value) -> Option<[f64; 4]> {
    let items = value.as_array()?;
    let [a, b, c, d] = items.as_slice() else {
        return None;
    };
    let mut out = [0.0; 4];
    for (slot, item) in out.iter_mut().zip([a, b, c, d]) {
        let number = item.as_f64()?;
        if !number.is_finite() {
            return None;
        }
        *slot = number;
    }
    Some(out)
}

/// `_inum` (stats.mjs:944-948) over a parsed JSON value.
pub(crate) fn inum_value(value: Option<&Value>) -> f64 {
    match value {
        Some(Value::Number(number)) => number
            .as_f64()
            .filter(|number| !number.is_nan())
            .map_or(0.0, f64::trunc),
        Some(Value::String(text)) => inum(Some(text)),
        _ => 0.0,
    }
}

/// `_fnum` (stats.mjs:938-942) over a CSV cell.
pub(crate) fn fnum(text: Option<&str>) -> f64 {
    match text {
        None | Some("") => 0.0,
        Some(text) => parse_float(text)
            .filter(|number| !number.is_nan())
            .unwrap_or(0.0),
    }
}

/// `_inum` (stats.mjs:944-948) over a CSV cell.
pub(crate) fn inum(text: Option<&str>) -> f64 {
    let value = fnum(text);
    if value.is_nan() { 0.0 } else { value.trunc() }
}

/// ECMAScript `parseFloat`: longest numeric prefix, and only the exact
/// `Infinity` spelling.
pub(crate) fn parse_float(text: &str) -> Option<f64> {
    let text = text.trim_start_matches(js_whitespace);
    if text.starts_with("-Infinity") {
        return Some(f64::NEG_INFINITY);
    }
    if text.starts_with("Infinity") || text.starts_with("+Infinity") {
        return Some(f64::INFINITY);
    }
    for end in (1..=text.len()).rev() {
        if !text.is_char_boundary(end) {
            continue;
        }
        let Ok(value) = text[..end].parse::<f64>() else {
            continue;
        };
        if value.is_infinite() {
            // Rust accepts `inf`/`infinity`; parseFloat does not.
            let candidate = &text[..end];
            let unsigned = candidate
                .strip_prefix('+')
                .or_else(|| candidate.strip_prefix('-'))
                .unwrap_or(candidate);
            if unsigned
                .get(..3)
                .is_some_and(|prefix| prefix.eq_ignore_ascii_case("inf"))
            {
                return None;
            }
        }
        return Some(value);
    }
    None
}

/// ECMAScript `WhiteSpace` ∪ `LineTerminator`.
pub(crate) fn js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\u{0009}'..='\u{000d}'
            | '\u{0020}'
            | '\u{00a0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
            | '\u{feff}'
    )
}

pub(crate) fn js_trim(text: &str) -> &str {
    text.trim_matches(js_whitespace)
}

/// ECMAScript number-to-string (`-0` prints `0`).
pub(crate) fn js_number(value: f64) -> String {
    if value.is_nan() {
        "NaN".into()
    } else if value.is_infinite() {
        if value > 0.0 {
            "Infinity".into()
        } else {
            "-Infinity".into()
        }
    } else if value == 0.0 {
        "0".into()
    } else {
        ryu_js::Buffer::new().format_finite(value).to_owned()
    }
}

/// `JSON.stringify` numeric token: non-finite numbers serialize as `null`.
pub(crate) fn json_number(value: f64) -> String {
    if value.is_finite() {
        js_number(value)
    } else {
        "null".into()
    }
}

pub(crate) fn json_string(text: &str) -> String {
    serde_json::to_string(text).expect("JSON string serialization")
}

/// `JSON.stringify` of a parsed value: numbers re-render in ECMAScript form
/// (so `1.0` becomes `1`, out-of-range magnitudes become `null`).
pub(crate) fn js_json(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => number.as_f64().map_or_else(|| "null".into(), json_number),
        Value::String(text) => json_string(text),
        // shortcut: JSON.stringify sorts integer-like keys ascending; facets
        // keys are tool/agent/skill names, so document order is kept.
        Value::Array(items) => format!(
            "[{}]",
            items.iter().map(js_json).collect::<Vec<_>>().join(",")
        ),
        Value::Object(map) => format!(
            "{{{}}}",
            map.iter()
                .map(|(key, item)| format!("{}:{}", json_string(key), js_json(item)))
                .collect::<Vec<_>>()
                .join(",")
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn pricing(document: &str) -> Pricing {
        Pricing::from_json(document)
    }

    #[test]
    fn loads_bare_and_layered_tables_with_js_key_order() {
        let bare = pricing(r#"{"opus":[1,2,3,4],"z":[5,6,7,8]}"#);
        assert_eq!(bare.price_key("claude-opus-4"), Some("opus"));
        assert_eq!(bare.price_key("unknown"), None);
        assert_eq!(
            bare.msg_cost("opus", 1e6, 1e6, 0.0, 0.0),
            Some(3.0),
            "$1 in + $2 out per MTok"
        );

        let layered = pricing(
            r#"{"1":[0,0,0,0],"base":{"z":[1,2,3,4],"a":[5,6,7,8]},"above_200k":{"z":[10,20,30,40]},"long_context_threshold":12,"default_key":"a"}"#,
        );
        assert_eq!(layered.price_key("model-z"), Some("z"));
        assert_eq!(layered.price_key("nothing-matches"), Some("a"));
        assert_eq!(layered.msg_cost("model-z", 1e6, 0.0, 0.0, 0.0), Some(1.0));
        // 12-token threshold from the document, not the 200k default.
        assert_eq!(
            layered.msg_cost_tiered("model-z", 13.0, 0.0, 0.0, 0.0),
            Some(13.0 * 10.0 / 1e6)
        );
        assert_eq!(
            layered.msg_cost_tiered("model-z", 12.0, 0.0, 0.0, 0.0),
            Some(12.0 / 1e6)
        );
        // Bare documents never leak top-level non-rate values into `base`.
        assert_eq!(bare.price_key("1"), None);
    }

    #[test]
    fn invalid_documents_leave_every_model_unpriced() {
        for document in [
            "not json",
            "[]",
            "\"x\"",
            "null",
            "{}",
            r#"{"base":5}"#,
            r#"{"base":null}"#,
            r#"{"base":{"m":[1,2,3]}}"#,
            r#"{"base":{"m":[1,2,3,"4"]}}"#,
            r#"{"base":{"m":[1,2,3,1e400]}}"#,
            r#"{"base":{"m":null}}"#,
        ] {
            let table = pricing(document);
            assert_eq!(table.price_key("m"), None, "{document}");
            assert_eq!(table.msg_cost("m", 1.0, 1.0, 1.0, 1.0), None, "{document}");
        }
        assert_eq!(
            pricing(r#"{"base":{"m":[1,2,3,4]}}"#).price_key("m"),
            Some("m")
        );
    }

    #[test]
    fn price_key_scans_in_order_and_respects_default_key_truthiness() {
        let table = pricing(r#"{"base":{"opus-5-5":[1,2,3,4],"opus":[5,6,7,8]},"default_key":""}"#);
        assert_eq!(table.price_key("claude-opus-5-5"), Some("opus-5-5"));
        assert_eq!(table.price_key("claude-opus-4"), Some("opus"));
        assert_eq!(table.price_key(""), None, "empty model resolves unpriced");
    }

    #[test]
    fn price_key_falls_back_to_default_key_only_when_priced() {
        let table = pricing(r#"{"base":{"opus":[1,2,3,4]},"default_key":"missing"}"#);
        assert_eq!(table.price_key("unknown"), None);
        let table = pricing(r#"{"base":{"opus":[1,2,3,4]},"default_key":"opus"}"#);
        assert_eq!(table.price_key("unknown"), Some("opus"));
        // Non-string default keys are ignored (stats.mjs:569).
        assert_eq!(
            pricing(r#"{"base":{"opus":[1,2,3,4]},"default_key":7}"#).price_key("unknown"),
            None
        );
    }

    #[test]
    fn pricing_catalog_resolves_versions_without_matching_date_prefixes() {
        let catalog: Value = serde_json::from_str(include_str!("../../../server/model-pricing-catalog.json")).unwrap();
        let table = pricing(&catalog["pricing"].to_string());
        for (key, _) in &table.base {
            let model = if key.starts_with("gpt-") || key.starts_with("claude-") {
                key.clone()
            } else {
                format!("claude-{key}-20261119")
            };
            assert_eq!(table.price_key(&model), Some(key.as_str()), "{model}");
        }
        assert!(!table.is_third_party("claude-3-5-haiku-20241022"));
        assert_eq!(table.price_key("claude-fable-5-20260609"), Some("fable-5"));
    }

    #[test]
    fn third_party_detection_uses_the_key_family_prefix() {
        let table = pricing(
            r#"{"base":{"opus":[1,2,3,4],"sonnet":[1,2,3,4],"haiku":[1,2,3,4],"fable":[1,2,3,4],"glm":[1,2,3,4],"Opus":[1,2,3,4]}}"#,
        );
        assert!(!table.is_third_party("claude-opus-4"));
        assert!(!table.is_third_party("claude-sonnet-4"));
        assert!(!table.is_third_party("claude-haiku-4"));
        assert!(!table.is_third_party("fable-5"));
        assert!(table.is_third_party("glm-5"));
        assert!(table.is_third_party("totally-unpriced") == false);
        // Models are lowercased before the ordered scan, so "claude-Opus"
        // matches the earlier "opus" key; an uppercase "Opus" key is
        // unreachable from a model id.
        assert_eq!(table.price_key("claude-Opus"), Some("opus"));
        assert!(!table.is_third_party("claude-Opus"));
        // An explicit `claude-*` pricing key is Anthropic too: the report keeps
        // Claude Code's authoritative billed cost instead of the estimate.
        let claude = pricing(
            r#"{"base":{"claude-3-5-sonnet":[3,15,0.3,3.75],"claude-3-opus":[15,75,1.5,18.75]}}"#,
        );
        assert_eq!(
            claude.price_key("claude-3-5-sonnet-20241022"),
            Some("claude-3-5-sonnet")
        );
        assert!(!claude.is_third_party("claude-3-5-sonnet-20241022"));
        assert!(!claude.is_third_party("claude-3-opus-20240229"));
    }

    #[test]
    fn unknown_codex_models_warn_only_when_pricing_falls_through() {
        let table =
            pricing(r#"{"base":{"opus":[1,2,3,4],"gpt-6-sol":[1,2,3,4]},"default_key":"opus"}"#);
        assert!(table.should_warn_unknown_model("gpt-6.1-sol"));
        assert!(table.should_warn_unknown_model("codex-mini"));
        assert!(table.should_warn_unknown_model("GPT-6.1-sol"));
        assert!(!table.should_warn_unknown_model("gpt-6-sol"));
        assert!(!table.should_warn_unknown_model(""));
        assert!(!table.should_warn_unknown_model("claude-opus-4"));
        let unpriced = pricing(r#"{"base":{"opus":[1,2,3,4]}}"#);
        assert!(unpriced.should_warn_unknown_model("gpt-6-sol"));
        assert!(!unpriced.should_warn_unknown_model("codex-opus"));
    }

    #[test]
    fn tiered_cost_applies_model_specific_thresholds() {
        let table = pricing(
            r#"{"base":{"gpt-6-sol":[1,1,1,1],"gpt-6-luna":[1,1,1,1],"gpt-6.1-sol":[1,1,1,1],"gpt-6.1-terra":[1,1,1,1],"haiku-5-5":[1,1,1,1],"sonnet":[1,1,1,1]},"above_200k":{"gpt-6-sol":[10,10,10,10],"gpt-6-luna":[10,10,10,10],"gpt-6.1-sol":[10,10,10,10],"gpt-6.1-terra":[10,10,10,10],"haiku-5-5":[10,10,10,10],"sonnet":[10,10,10,10]}}"#,
        );
        for model in ["gpt-6-sol", "gpt-6-luna", "gpt-6.1-sol", "gpt-6.1-terra"] {
            assert_eq!(
                table.msg_cost_tiered(model, 272_000.0, 0.0, 0.0, 0.0),
                Some(272_000.0 / 1e6),
                "{model} at threshold"
            );
            assert_eq!(
                table.msg_cost_tiered(model, 272_001.0, 0.0, 0.0, 0.0),
                Some(2_720_010.0 / 1e6),
                "{model} above threshold"
            );
        }
        assert_eq!(
            table.msg_cost_tiered("haiku-5-5", 100_001.0, 0.0, 0.0, 0.0),
            Some(1_000_010.0 / 1e6)
        );
        assert_eq!(
            table.msg_cost_tiered("sonnet", 200_001.0, 0.0, 0.0, 0.0),
            Some(2_000_010.0 / 1e6)
        );
        assert_eq!(
            table.msg_cost_tiered("sonnet", 200_000.0, 0.0, 0.0, 0.0),
            Some(200_000.0 / 1e6)
        );
        // cache reads and creates count toward the input-side sum.
        assert_eq!(
            table.msg_cost_tiered("sonnet", 0.0, 0.0, 150_000.0, 50_001.0),
            Some((150_000.0 + 50_001.0) * 10.0 / 1e6)
        );
        assert_eq!(table.msg_cost_tiered("unpriced", 1.0, 1.0, 1.0, 1.0), None);
    }

    #[test]
    fn omitted_threshold_uses_272k_for_known_openai_long_context_keys() {
        let table = pricing(
            r#"{"base":{"gpt-5.6-sol":[1,1,1,1],"gpt-6.2-astra":[1,1,1,1]},"above_200k":{"gpt-5.6-sol":[10,10,10,10],"gpt-6.2-astra":[10,10,10,10]}}"#,
        );
        for model in ["gpt-5.6-sol", "gpt-6.2-astra"] {
            let at = table
                .msg_cost_tiered(model, 272_000.0, 0.0, 0.0, 0.0)
                .unwrap();
            let above = table
                .msg_cost_tiered(model, 272_001.0, 0.0, 0.0, 0.0)
                .unwrap();
            assert!((at - 0.272).abs() < 1e-9, "{model} at 272k");
            assert!((above - 2.720_01).abs() < 1e-9, "{model} above 272k");
        }

        // An explicitly configured global threshold overrides the 272k default.
        let configured = pricing(
            r#"{"base":{"gpt-5.6-sol":[1,1,1,1]},"above_200k":{"gpt-5.6-sol":[10,10,10,10]},"long_context_threshold":300000}"#,
        );
        let below = configured
            .msg_cost_tiered("gpt-5.6-sol", 272_001.0, 0.0, 0.0, 0.0)
            .unwrap();
        let above = configured
            .msg_cost_tiered("gpt-5.6-sol", 300_001.0, 0.0, 0.0, 0.0)
            .unwrap();
        assert!((below - 0.272_001).abs() < 1e-9);
        assert!((above - 3.000_01).abs() < 1e-9);
    }

    #[test]
    fn msg_tokens_skips_synthetic_zero_and_malformed_usage() {
        let message = json!({"model":"opus","usage":{"input_tokens":1.9,"output_tokens":"2","cache_read_input_tokens":3,"cache_creation_input_tokens":4}});
        assert_eq!(
            msg_tokens(&message),
            Some(MsgTokens {
                i: 1.0,
                o: 2.0,
                cr: 3.0,
                cc: 4.0,
                model: Some("opus".into())
            })
        );
        assert_eq!(
            msg_tokens(&json!({"model":"<synthetic>","usage":{"input_tokens":5}})),
            None
        );
        assert_eq!(msg_tokens(&json!({"model":"opus"})), None);
        assert_eq!(
            msg_tokens(&json!({"model":"opus","usage":[{"input_tokens":5}]})),
            None,
            "array usage counts as absent"
        );
        assert_eq!(msg_tokens(&Value::Null), None);
        assert_eq!(
            msg_tokens(&json!({"usage":{"input_tokens":true,"output_tokens":2}})),
            Some(MsgTokens {
                i: 0.0,
                o: 2.0,
                cr: 0.0,
                cc: 0.0,
                model: None
            })
        );
    }

    #[test]
    fn transcript_cost_filters_rows_and_includes_subagent_sidechains() {
        let table = pricing(r#"{"base":{"opus":[1,2,3,4]}}"#);
        let main = concat!(
            "",
            "\n",
            "not json\n",
            "{\"type\":\"user\",\"message\":{\"model\":\"opus\",\"usage\":{\"input_tokens\":1000000}}}\n",
            "{\"type\":\"assistant\",\"isMeta\":true,\"message\":{\"model\":\"opus\",\"usage\":{\"input_tokens\":1000000}}}\n",
            "{\"type\":\"assistant\",\"isSidechain\":true,\"message\":{\"model\":\"opus\",\"usage\":{\"input_tokens\":1000000}}}\n",
            "{\"type\":\"assistant\",\"message\":{\"model\":\"opus\",\"usage\":{\"input_tokens\":1000000,\"output_tokens\":1000000}}}\r\n",
            "{\"type\":\"assistant\",\"message\":{\"model\":\"unpriced\",\"usage\":{\"input_tokens\":1000000}}}\n",
            "{\"type\":\"assistant\",\"message\":{\"model\":\"opus\",\"usage\":{\"input_tokens\":0,\"output_tokens\":0}}}\n"
        );
        assert_eq!(table.computed_cost_from_transcript(main, &[]), 3.0);

        let sub = concat!(
            "{\"type\":\"assistant\",\"isSidechain\":true,\"message\":{\"model\":\"opus\",\"usage\":{\"input_tokens\":1000000}}}\n",
            "{\"type\":\"assistant\",\"isMeta\":true,\"isSidechain\":true,\"message\":{\"model\":\"opus\",\"usage\":{\"input_tokens\":1000000}}}\n"
        );
        assert_eq!(table.computed_cost_from_transcript("", &[sub]), 1.0);
        assert_eq!(table.computed_cost_from_transcript(main, &[sub]), 4.0);
        assert_eq!(table.computed_cost_from_transcript("", &[]), 0.0);
    }

    #[test]
    fn extracts_cost_state_with_js_defaults() {
        let document = json!({
            "cost": {
                "total_cost_usd": "1.25",
                "total_duration_ms": 12.9,
                "total_api_duration_ms": "8",
                "total_lines_added": 0,
                "total_lines_removed": true
            },
            "model": {"id": "claude-opus-4", "display_name": 5},
            "rate_limits": {
                "five_hour": {"used_percentage": 12.5},
                "seven_day": {"used_percentage": null}
            },
            "context_window": {"used_percentage": 0, "context_window_size": 200000}
        });
        let state = extract_state(&document);
        assert_eq!(state.cost, Some(json!("1.25")));
        assert_eq!(state.model_id, "claude-opus-4");
        assert_eq!(state.model_display_name, "5");
        assert_eq!(state.duration_ms, 12.0);
        assert_eq!(state.api_duration_ms, 8.0);
        assert_eq!(state.lines_added, 0.0);
        assert_eq!(state.lines_removed, 0.0, "true coerces to 0 via _inum");
        assert_eq!(state.rl_5h_pct, Some(json!(12.5)));
        assert_eq!(state.rl_7d_pct, None);
        assert_eq!(state.context_pct, Some(json!(0)));
        assert_eq!(state.context_window_size, Some(json!(200000)));
        assert_eq!(state.raw, document);

        let empty = extract_state(&json!({}));
        assert_eq!(empty.cost, None);
        assert_eq!(empty.model_id, "");
        assert_eq!(empty.duration_ms, 0.0);
        assert_eq!(empty.rl_5h_pct, None);
        assert_eq!(extract_state(&Value::Null).raw, Value::Null);
    }

    #[test]
    fn pricing_load_reads_the_state_directory_and_tolerates_absence() {
        let directory = std::env::temp_dir().join(format!(
            "singularity-cost-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&directory).unwrap();
        assert_eq!(Pricing::load(&directory), Pricing::default());
        std::fs::write(directory.join("pricing.json"), r#"{"haiku-5-5":[1,2,3,4]}"#).unwrap();
        assert_eq!(
            Pricing::load(&directory).price_key("haiku-5-5"),
            Some("haiku-5-5")
        );
        std::fs::remove_dir_all(&directory).ok();
    }

    #[test]
    fn js_coercion_helpers_match_the_node_versions() {
        assert_eq!(fnum(None), 0.0);
        assert_eq!(fnum(Some("")), 0.0);
        assert_eq!(fnum(Some("  +7abc")), 7.0);
        assert_eq!(fnum(Some("1e")), 1.0);
        assert_eq!(fnum(Some("Infinity")), f64::INFINITY);
        assert_eq!(fnum(Some("infinity")), 0.0);
        assert_eq!(inum(Some("12.9")), 12.0);
        assert_eq!(inum(Some("-1e309")), f64::NEG_INFINITY);
        assert_eq!(inum_value(Some(&json!("12.9"))), 12.0);
        assert_eq!(inum_value(Some(&json!(true))), 0.0);
        assert_eq!(js_trim("\u{00a0} x \u{feff}"), "x");
        assert_eq!(js_number(1.0), "1");
        assert_eq!(js_number(-0.0), "0");
        assert_eq!(js_number(1e-7), "1e-7");
        assert_eq!(json_number(f64::NAN), "null");
        assert_eq!(json_number(1.5), "1.5");
        // Parsed (not a float literal: `1e400` overflows `f64` and is denied by
        // `overflowing_literals`); arbitrary precision keeps the magnitude, and
        // `JSON.stringify` serializes a non-finite number as `null`.
        let nested: Value =
            serde_json::from_str(r#"{"a":[1.0,2.5,null,true,"x"],"b":{"c":1e400}}"#).unwrap();
        assert_eq!(
            js_json(&nested),
            r#"{"a":[1,2.5,null,true,"x"],"b":{"c":null}}"#
        );
    }
}
