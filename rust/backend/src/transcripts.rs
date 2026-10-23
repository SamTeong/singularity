//! Pure transcript JSONL parsing shared by the transcript filesystem service.
//!
//! Model catalog rows are explicit inputs so transcript parsing never calls
//! back through the Node model-store bridge.
use serde::{
    Deserialize, Serialize,
    ser::{SerializeMap, Serializer},
};
use serde_json::{Map, Value, json, value::RawValue};
use std::collections::HashMap;

const TOOL_TRUNC: usize = 300;

#[derive(Deserialize)]
struct EscapedCodexEvent {
    #[serde(rename = "type")]
    kind: Option<String>,
    timestamp: Option<Value>,
    payload: Option<Box<RawValue>>,
}

#[derive(Deserialize)]
struct EscapedCodexPayload {
    #[serde(rename = "type")]
    kind: Option<String>,
    role: Option<String>,
    content: Option<Box<RawValue>>,
    output: Option<Box<RawValue>>,
    arguments: Option<Box<RawValue>>,
    name: Option<Box<RawValue>>,
    message: Option<Box<RawValue>>,
    text: Option<Box<RawValue>>,
    id: Option<Box<RawValue>>,
    session_id: Option<Box<RawValue>>,
    cwd: Option<Box<RawValue>>,
}

#[derive(Deserialize)]
struct EscapedCodexBlock {
    #[serde(rename = "type")]
    kind: Option<String>,
    text: Option<Box<RawValue>>,
}

#[derive(Clone)]
struct EscapedCodexText {
    role: String,
    kind: String,
    name: Option<Value>,
    raw_name: Option<Box<RawValue>>,
    text: TranscriptRawText,
}

fn codex_events(raw: &str) -> Vec<(Value, Vec<EscapedCodexText>)> {
    raw.split('\n')
        .filter_map(|line| {
            let line = line.strip_suffix('\r').unwrap_or(line);
            if line.is_empty() {
                return None;
            }
            if let Ok(event) = serde_json::from_str::<Value>(line) {
                return Some((event, Vec::new()));
            }
            let event = serde_json::from_str::<EscapedCodexEvent>(line).ok()?;
            if !matches!(
                event.kind.as_deref(),
                Some("response_item" | "event_msg" | "session_meta")
            ) {
                return None;
            }
            let payload = serde_json::from_str::<EscapedCodexPayload>(event.payload?.get()).ok()?;
            if event.kind.as_deref() == Some("session_meta") {
                let mut outer = Map::new();
                outer.insert("type".into(), json!("session_meta"));
                let mut payload_value = Map::new();
                payload_value.insert("type".into(), Value::Null);
                for (key, token) in [("id", payload.id), ("session_id", payload.session_id)] {
                    if let Some(token) = token {
                        if let Ok(value) = serde_json::from_str::<Value>(token.get()) {
                            payload_value.insert(key.into(), value);
                        }
                    }
                }
                outer.insert("payload".into(), Value::Object(payload_value));
                if let Some(cwd) = payload.cwd {
                    if let Ok(text) = TranscriptRawText::from_json_token(cwd.get().to_owned()) {
                        outer.insert("__rawCwdToken".into(), json!(text.0.get()));
                    }
                }
                if let Some(timestamp) = event.timestamp {
                    outer.insert("timestamp".into(), timestamp);
                }
                return Some((Value::Object(outer), Vec::new()));
            }
            let mut extracted = Vec::new();
            let mut add = |role: &str, kind: &str, token: Option<Box<RawValue>>| {
                if let Some(token) = token {
                    if let Ok(text) = TranscriptRawText::from_raw_payload(&token) {
                        extracted.push(EscapedCodexText {
                            role: role.into(),
                            kind: kind.into(),
                            name: None,
                            raw_name: None,
                            text,
                        });
                    }
                }
            };
            match (payload.kind.as_deref(), payload.role.as_deref()) {
                (Some("message"), Some("user" | "assistant")) => {
                    if let Some(content) = payload.content {
                        if let Ok(blocks) =
                            serde_json::from_str::<Vec<EscapedCodexBlock>>(content.get())
                        {
                            let role = payload.role.as_deref().unwrap();
                            let expected = if role == "user" {
                                "input_text"
                            } else {
                                "output_text"
                            };
                            for block in blocks {
                                if block.kind.as_deref() == Some(expected) {
                                    add(role, "text", block.text);
                                }
                            }
                        }
                    }
                }
                (Some("function_call" | "custom_tool_call"), _) => {
                    if let Some(token) = payload.arguments {
                        if let Ok(text) = TranscriptRawText::from_raw_json_payload(&token) {
                            let raw_name = payload
                                .name
                                .filter(|name| raw_json_truthy(name.as_ref()))
                                .unwrap_or_else(|| RawValue::from_string("\"?\"".into()).unwrap());
                            let name = serde_json::from_str(raw_name.get()).ok();
                            extracted.push(EscapedCodexText {
                                role: "assistant".into(),
                                kind: "toolUse".into(),
                                name,
                                raw_name: Some(raw_name),
                                text,
                            });
                        }
                    }
                }
                (Some("function_call_output" | "custom_tool_call_output"), _) => {
                    if let Some(output) = payload.output {
                        if output.get().starts_with('[') {
                            if let Ok(blocks) =
                                serde_json::from_str::<Vec<EscapedCodexBlock>>(output.get())
                            {
                                let mut units = Vec::new();
                                for block in blocks {
                                    if let Some(text) = block.text {
                                        if let Ok(text) = TranscriptRawText::from_raw_payload(&text)
                                        {
                                            if let Ok(part) = text.units() {
                                                units.extend(part);
                                            }
                                        }
                                    }
                                }
                                if let Ok(text) = TranscriptRawText::from_units(&units) {
                                    extracted.push(EscapedCodexText {
                                        role: "user".into(),
                                        kind: "toolResult".into(),
                                        name: None,
                                        raw_name: None,
                                        text,
                                    });
                                }
                            }
                        } else {
                            add("user", "toolResult", Some(output));
                        }
                    }
                }
                (Some("user_message"), _) if event.kind.as_deref() == Some("event_msg") => {
                    add("user", "text", payload.message.or(payload.text))
                }
                _ => {}
            }
            let mut user_units = Vec::new();
            extracted.retain(|item| {
                if item.role == "user" && item.kind == "text" {
                    if let Ok(units) = decode_string_token(item.text.0.get()) {
                        if !context_units(&units) {
                            user_units.extend(units);
                        }
                    }
                    false
                } else {
                    true
                }
            });
            if !user_units.is_empty() {
                if let Ok(text) = TranscriptRawText::from_units(&user_units) {
                    extracted.push(EscapedCodexText {
                        role: "user".into(),
                        kind: "text".into(),
                        name: None,
                        raw_name: None,
                        text,
                    });
                }
            }
            let mut outer = Map::new();
            outer.insert("type".into(), json!(event.kind));
            if let Some(timestamp) = event.timestamp {
                outer.insert("timestamp".into(), timestamp);
            }
            let payload_kind = if event.kind.as_deref() == Some("event_msg") {
                json!("user_message")
            } else {
                Value::Null
            };
            outer.insert("payload".into(), json!({"type": payload_kind}));
            Some((Value::Object(outer), extracted))
        })
        .collect()
}

#[derive(Deserialize)]
struct EscapedClaudeEvent {
    #[serde(rename = "type")]
    kind: Option<String>,
    timestamp: Option<Value>,
    cwd: Option<Box<RawValue>>,
    #[serde(rename = "aiTitle")]
    ai_title: Option<Box<RawValue>>,
    #[serde(rename = "isCompactSummary")]
    compact: Option<Value>,
    message: Option<Box<RawValue>>,
}

#[derive(Deserialize)]
struct EscapedClaudeMessage {
    content: Box<RawValue>,
    model: Option<Value>,
}

#[derive(Deserialize)]
struct EscapedClaudeBlock {
    #[serde(rename = "type")]
    kind: Option<String>,
    text: Option<Box<RawValue>>,
    thinking: Option<Box<RawValue>>,
    content: Option<Box<RawValue>>,
    input: Option<Box<RawValue>>,
    name: Option<Value>,
}

#[derive(Clone)]
struct EscapedClaudeText {
    kind: String,
    name: Option<Value>,
    text: TranscriptRawText,
}

fn claude_events(raw: &str) -> Vec<(Value, Vec<EscapedClaudeText>)> {
    raw.split('\n')
        .filter_map(|line| {
            let line = line.strip_suffix('\r').unwrap_or(line);
            if line.is_empty() {
                return None;
            }
            if let Ok(event) = serde_json::from_str::<Value>(line) {
                return Some((event, Vec::new()));
            }
            let parsed = serde_json::from_str::<EscapedClaudeEvent>(line).ok()?;
            let message = parsed.message.as_ref().and_then(|message| {
                serde_json::from_str::<EscapedClaudeMessage>(message.get()).ok()
            });
            let mut extracted = Vec::new();
            let mut add = |kind: &str, name: Option<Value>, token: Option<Box<RawValue>>| {
                if let Some(token) = token {
                    let parsed = if kind == "toolUse" {
                        TranscriptRawText::from_raw_json_payload(&token)
                    } else {
                        TranscriptRawText::from_raw_payload(&token)
                    };
                    if let Ok(text) = parsed {
                        extracted.push(EscapedClaudeText {
                            kind: kind.into(),
                            name,
                            text,
                        });
                    }
                }
            };
            if let Some(message) = &message {
                if message.content.get().starts_with('"') {
                    add("text", None, Some(message.content.clone()));
                } else if let Ok(blocks) =
                    serde_json::from_str::<Vec<EscapedClaudeBlock>>(message.content.get())
                {
                    for block in blocks {
                        match (parsed.kind.as_deref(), block.kind.as_deref()) {
                            (Some("user"), Some("text")) => add("text", None, block.text),
                            (Some("user"), Some("tool_result")) => {
                                add("toolResult", None, block.content)
                            }
                            (Some("assistant"), Some("text")) => add("text", None, block.text),
                            (Some("assistant"), Some("thinking")) => {
                                add("thinking", None, block.thinking)
                            }
                            (Some("assistant"), Some("tool_use")) => {
                                add("toolUse", block.name, block.input)
                            }
                            _ => {}
                        }
                    }
                }
            }
            let mut event = Map::new();
            event.insert("type".into(), json!(parsed.kind));
            if let Some(value) = parsed.timestamp {
                event.insert("timestamp".into(), value);
            }
            if let Some(value) = parsed.cwd {
                if let Ok(text) = TranscriptRawText::from_json_token(value.get().to_owned()) {
                    event.insert("__rawCwdToken".into(), json!(text.0.get()));
                }
            }
            if let Some(value) = parsed.compact {
                event.insert("isCompactSummary".into(), value);
            }
            if let Some(value) = parsed.ai_title {
                if let Ok(text) = TranscriptRawText::from_json_token(value.get().to_owned()) {
                    event.insert("__rawTitleToken".into(), json!(text.0.get()));
                }
            }
            if let Some(message) = message {
                event.insert(
                    "message".into(),
                    json!({"content": null, "model": message.model}),
                );
            }
            Some((Value::Object(event), extracted))
        })
        .collect()
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(value) => value.as_f64().unwrap_or(0.0) != 0.0,
        Value::String(value) => !value.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

fn raw_json_truthy(token: &RawValue) -> bool {
    serde_json::from_str::<Value>(token.get())
        .map(|value| truthy(&value))
        .unwrap_or_else(|_| token.get() != "\"\"")
}

fn raw_value_text(value: &Value) -> Option<TranscriptRawText> {
    value
        .as_str()
        .and_then(|text| TranscriptRawText::from_text(text).ok())
}

/// A JSON string leaf that preserves JavaScript UTF-16 code units, including
/// an unpaired surrogate. Serialize parser output directly; do not convert it
/// through `serde_json::Value`.
#[derive(Clone, Debug)]
pub struct TranscriptRawText(Box<RawValue>);

impl TranscriptRawText {
    /// Accepts one JSON string token, including escaped lone surrogates.
    pub fn from_json_token(token: String) -> Result<Self, String> {
        let raw = RawValue::from_string(token).map_err(|error| error.to_string())?;
        let bytes = raw.get().as_bytes();
        if bytes.first() != Some(&b'"') || bytes.last() != Some(&b'"') {
            return Err("transcript raw text must be a JSON string token".into());
        }
        Ok(Self(raw))
    }

    fn from_raw_payload(token: &RawValue) -> Result<Self, String> {
        if token.get().starts_with('"') {
            Self::from_json_token(token.get().to_owned())
        } else {
            Self::from_text(&stringify_json_token(token.get())?)
        }
    }

    fn from_raw_json_payload(token: &RawValue) -> Result<Self, String> {
        if token.get().starts_with('"') {
            return Self::from_raw_payload(token);
        }
        Self::from_text(&stringify_json_token(token.get())?)
    }

    fn from_units(units: &[u16]) -> Result<Self, String> {
        let mut token = String::from("\"");
        let mut index = 0;
        while index < units.len() {
            let unit = units[index];
            if (0xd800..=0xdbff).contains(&unit)
                && units
                    .get(index + 1)
                    .is_some_and(|next| (0xdc00..=0xdfff).contains(next))
            {
                let scalar = 0x10000
                    + (((unit as u32 - 0xd800) << 10)
                        | (*units.get(index + 1).unwrap() as u32 - 0xdc00));
                token.push(char::from_u32(scalar).ok_or("invalid UTF-16 pair")?);
                index += 2;
                continue;
            }
            match unit {
                0x0022 => token.push_str("\\\""),
                0x005c => token.push_str("\\\\"),
                0x0008 => token.push_str("\\b"),
                0x000c => token.push_str("\\f"),
                0x000a => token.push_str("\\n"),
                0x000d => token.push_str("\\r"),
                0x0009 => token.push_str("\\t"),
                0x0000..=0x001f | 0xd800..=0xdfff => {
                    use std::fmt::Write as _;
                    write!(&mut token, "\\u{unit:04x}").map_err(|error| error.to_string())?;
                }
                _ => token.push(char::from_u32(unit as u32).ok_or("invalid UTF-16 unit")?),
            }
            index += 1;
        }
        token.push('"');
        Self::from_json_token(token)
    }

    fn from_text(text: &str) -> Result<Self, String> {
        Self::from_units(&text.encode_utf16().collect::<Vec<_>>())
    }

    fn truncate_units(&self, limit: usize) -> Result<Self, String> {
        let units = self.units()?;
        if units.len() <= limit {
            return Ok(self.clone());
        }
        let mut cut = units[..limit].to_vec();
        cut.push('…' as u16);
        Self::from_units(&cut)
    }

    /// Returns the JavaScript UTF-16 code units represented by this string.
    pub fn units(&self) -> Result<Vec<u16>, String> {
        decode_string_token(self.0.get())
    }

    /// Slices the string by JavaScript UTF-16 offsets and returns a raw token.
    pub fn slice_units(&self, start: usize, end: usize) -> Result<Self, String> {
        let units = self.units()?;
        let start = start.min(units.len());
        let end = end.max(start).min(units.len());
        Self::from_units(&units[start..end])
    }

    /// Finds a Unicode-scalar query using JavaScript-style lowercase matching.
    pub fn find_case_insensitive(&self, query: &str) -> Result<Option<usize>, String> {
        let units = self.units()?;
        let lowered = lowercase_utf16(&units);
        let needle = query.to_lowercase().encode_utf16().collect::<Vec<_>>();
        if needle.is_empty() {
            return Ok(Some(0));
        }
        Ok(lowered
            .windows(needle.len())
            .position(|window| window == needle))
    }
}

fn lowercase_utf16(units: &[u16]) -> Vec<u16> {
    let mut lowered = Vec::new();
    let mut index = 0;
    while index < units.len() {
        let unit = units[index];
        if (0xd800..=0xdbff).contains(&unit)
            && units
                .get(index + 1)
                .is_some_and(|next| (0xdc00..=0xdfff).contains(next))
        {
            let scalar = 0x10000
                + (((unit as u32 - 0xd800) << 10)
                    | (*units.get(index + 1).unwrap() as u32 - 0xdc00));
            if let Some(ch) = char::from_u32(scalar) {
                for lower in ch.to_lowercase() {
                    let mut buffer = [0; 2];
                    lowered.extend_from_slice(lower.encode_utf16(&mut buffer));
                }
            }
            index += 2;
        } else if (0xd800..=0xdfff).contains(&unit) {
            lowered.push(unit);
            index += 1;
        } else {
            if let Some(ch) = char::from_u32(unit as u32) {
                for lower in ch.to_lowercase() {
                    let mut buffer = [0; 2];
                    lowered.extend_from_slice(lower.encode_utf16(&mut buffer));
                }
            }
            index += 1;
        }
    }
    lowered
}

impl Serialize for TranscriptRawText {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.0.serialize(serializer)
    }
}

/// Serializable parser response. Keeping message text as RawValue avoids a
/// lossy Value conversion at the later daemon framing boundary.
#[derive(Serialize)]
pub struct TranscriptOutput {
    ok: bool,
    meta: TranscriptMeta,
    messages: Vec<TranscriptMessage>,
}

struct TranscriptMeta {
    values: Map<String, Value>,
    raw_fields: HashMap<String, TranscriptRawText>,
}

impl Serialize for TranscriptMeta {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(self.values.len() + self.raw_fields.len()))?;
        for (key, value) in &self.values {
            if !self.raw_fields.contains_key(key) {
                map.serialize_entry(key, value)?;
            }
        }
        for (key, value) in &self.raw_fields {
            map.serialize_entry(key, value)?;
        }
        map.end()
    }
}

struct TranscriptMessage {
    ts: Value,
    role: String,
    kind: String,
    name: Option<Value>,
    raw_name: Option<Box<RawValue>>,
    text: TranscriptRawText,
    recap: bool,
}

impl Serialize for TranscriptMessage {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(
            4 + usize::from(self.name.is_some() || self.raw_name.is_some())
                + usize::from(self.recap),
        ))?;
        map.serialize_entry("ts", &self.ts)?;
        map.serialize_entry("role", &self.role)?;
        map.serialize_entry("kind", &self.kind)?;
        if let Some(name) = &self.raw_name {
            map.serialize_entry("name", name)?;
        } else if let Some(name) = &self.name {
            map.serialize_entry("name", name)?;
        }
        map.serialize_entry("text", &self.text)?;
        if self.recap {
            map.serialize_entry("recap", &self.recap)?;
        }
        map.end()
    }
}

impl TranscriptOutput {
    pub fn to_json(&self) -> Result<String, String> {
        serde_json::to_string(self).map_err(|error| error.to_string())
    }

    /// Returns a raw metadata JSON token, preserving escaped UTF-16 strings.
    pub fn raw_meta_token(&self, key: &str) -> Option<&RawValue> {
        self.meta.raw_fields.get(key).map(|value| value.0.as_ref())
    }

    /// Iterates message fields without serializing and reparsing the response.
    pub fn raw_messages(&self) -> impl Iterator<Item = TranscriptMessageRef<'_>> {
        self.messages.iter().map(|message| TranscriptMessageRef {
            ts: &message.ts,
            role: &message.role,
            kind: &message.kind,
            name: message.name.as_ref(),
            raw_name: message.raw_name.as_deref(),
            text: &message.text,
        })
    }

    #[cfg(test)]
    fn to_value(&self) -> Value {
        serde_json::from_str(&self.to_json().unwrap()).unwrap()
    }
}

pub struct TranscriptMessageRef<'a> {
    pub ts: &'a Value,
    pub role: &'a str,
    pub kind: &'a str,
    pub name: Option<&'a Value>,
    pub raw_name: Option<&'a RawValue>,
    pub text: &'a TranscriptRawText,
}

fn decode_string_token(token: &str) -> Result<Vec<u16>, String> {
    let bytes = token.as_bytes();
    if bytes.len() < 2 || bytes[0] != b'"' || bytes[bytes.len() - 1] != b'"' {
        return Err("expected JSON string token".into());
    }
    let mut units = Vec::new();
    let mut index = 1;
    while index < bytes.len() - 1 {
        if bytes[index] != b'\\' {
            let tail = std::str::from_utf8(&bytes[index..bytes.len() - 1])
                .map_err(|error| error.to_string())?;
            let ch = tail.chars().next().ok_or("invalid JSON string token")?;
            if ch <= '\u{001f}' {
                return Err("unescaped control character in JSON string".into());
            }
            units.extend(ch.encode_utf16(&mut [0; 2]).iter().copied());
            index += ch.len_utf8();
            continue;
        }
        index += 1;
        let escape = *bytes.get(index).ok_or("incomplete JSON escape")?;
        index += 1;
        match escape {
            b'"' => units.push(0x22),
            b'\\' => units.push(0x5c),
            b'/' => units.push(0x2f),
            b'b' => units.push(0x08),
            b'f' => units.push(0x0c),
            b'n' => units.push(0x0a),
            b'r' => units.push(0x0d),
            b't' => units.push(0x09),
            b'u' => {
                let hex = std::str::from_utf8(
                    bytes
                        .get(index..index + 4)
                        .ok_or("incomplete Unicode escape")?,
                )
                .map_err(|error| error.to_string())?;
                units.push(u16::from_str_radix(hex, 16).map_err(|error| error.to_string())?);
                index += 4;
            }
            _ => return Err("invalid JSON escape".into()),
        }
    }
    Ok(units)
}

fn truncate(value: &Value, limit: usize) -> Result<TranscriptRawText, String> {
    let text = match value {
        Value::String(text) => text.clone(),
        other => {
            stringify_json_token(&serde_json::to_string(other).map_err(|error| error.to_string())?)?
        }
    };
    TranscriptRawText::from_text(&text)?.truncate_units(limit)
}

fn truncate_json(value: &Value, limit: usize) -> Result<TranscriptRawText, String> {
    if let Value::String(text) = value {
        return TranscriptRawText::from_text(text)?.truncate_units(limit);
    }
    let token = serde_json::to_string(value).map_err(|error| error.to_string())?;
    TranscriptRawText::from_text(&stringify_json_token(&token)?)?.truncate_units(limit)
}

fn render_json_string(units: &[u16]) -> String {
    let mut out = String::from("\"");
    let mut index = 0;
    while index < units.len() {
        let unit = units[index];
        match unit {
            0x22 => out.push_str("\\\""),
            0x5c => out.push_str("\\\\"),
            0x08 => out.push_str("\\b"),
            0x0c => out.push_str("\\f"),
            0x0a => out.push_str("\\n"),
            0x0d => out.push_str("\\r"),
            0x09 => out.push_str("\\t"),
            0..=0x1f => out.push_str(&format!("\\u{unit:04x}")),
            0xd800..=0xdbff
                if units
                    .get(index + 1)
                    .is_some_and(|next| (0xdc00..=0xdfff).contains(next)) =>
            {
                let low = units[index + 1];
                let scalar = 0x10000 + (((unit as u32 - 0xd800) << 10) | (low as u32 - 0xdc00));
                out.push(char::from_u32(scalar).unwrap());
                index += 1;
            }
            0xd800..=0xdfff => out.push_str(&format!("\\u{unit:04x}")),
            _ => out.push(char::from_u32(unit as u32).unwrap()),
        }
        index += 1;
    }
    out.push('"');
    out
}

struct JsonTokenRenderer<'a> {
    bytes: &'a [u8],
    at: usize,
    preserve_number_tokens: bool,
}

fn is_json_number(token: &str) -> bool {
    let bytes = token.as_bytes();
    let mut at = 0;
    if bytes.get(at) == Some(&b'-') {
        at += 1;
    }
    match bytes.get(at) {
        Some(b'0') => at += 1,
        Some(b'1'..=b'9') => {
            at += 1;
            while bytes.get(at).is_some_and(u8::is_ascii_digit) {
                at += 1;
            }
        }
        _ => return false,
    }
    if bytes.get(at) == Some(&b'.') {
        at += 1;
        let fraction_start = at;
        while bytes.get(at).is_some_and(u8::is_ascii_digit) {
            at += 1;
        }
        if at == fraction_start {
            return false;
        }
    }
    if matches!(bytes.get(at), Some(b'e' | b'E')) {
        at += 1;
        if matches!(bytes.get(at), Some(b'+' | b'-')) {
            at += 1;
        }
        let exponent_start = at;
        while bytes.get(at).is_some_and(u8::is_ascii_digit) {
            at += 1;
        }
        if at == exponent_start {
            return false;
        }
    }
    at == bytes.len()
}

impl JsonTokenRenderer<'_> {
    fn is_json_whitespace(byte: u8) -> bool {
        matches!(byte, b' ' | b'\t' | b'\n' | b'\r')
    }

    fn whitespace(&mut self) {
        while self
            .bytes
            .get(self.at)
            .is_some_and(|byte| Self::is_json_whitespace(*byte))
        {
            self.at += 1;
        }
    }

    fn string(&mut self) -> Result<Vec<u16>, String> {
        let start = self.at;
        self.at += 1;
        let mut escaped = false;
        while let Some(byte) = self.bytes.get(self.at).copied() {
            self.at += 1;
            if escaped {
                escaped = false;
                continue;
            }
            if byte == b'\\' {
                escaped = true;
                continue;
            }
            if byte == b'"' {
                let token =
                    std::str::from_utf8(&self.bytes[start..self.at]).map_err(|e| e.to_string())?;
                return decode_string_token(token);
            }
        }
        Err("unterminated JSON string".into())
    }

    fn object_entries(&mut self) -> Result<Vec<(Vec<u16>, String)>, String> {
        if self.bytes.get(self.at) != Some(&b'{') {
            return Err("expected JSON object".into());
        }
        self.at += 1;
        self.whitespace();
        let mut entries: Vec<(Vec<u16>, String)> = Vec::new();
        if self.bytes.get(self.at) != Some(&b'}') {
            loop {
                self.whitespace();
                if self.bytes.get(self.at) != Some(&b'"') {
                    return Err("invalid JSON object key".into());
                }
                let key = self.string()?;
                self.whitespace();
                if self.bytes.get(self.at) != Some(&b':') {
                    return Err("invalid JSON object separator".into());
                }
                self.at += 1;
                let value = self.value()?;
                if let Some(entry) = entries.iter_mut().find(|(prior, _)| *prior == key) {
                    entry.1 = value;
                } else {
                    entries.push((key, value));
                }
                self.whitespace();
                match self.bytes.get(self.at) {
                    Some(b',') => self.at += 1,
                    Some(b'}') => break,
                    _ => return Err("invalid JSON object".into()),
                }
            }
        }
        self.at += 1;
        let index = |key: &[u16]| -> Option<u32> {
            if key.is_empty()
                || key
                    .iter()
                    .any(|unit| !(b'0' as u16..=b'9' as u16).contains(unit))
                || (key.len() > 1 && key[0] == b'0' as u16)
            {
                return None;
            }
            let text = String::from_utf16(key).ok()?;
            let value = text.parse::<u64>().ok()?;
            (value <= 4_294_967_294).then_some(value as u32)
        };
        let mut indexed: Vec<_> = entries
            .iter()
            .filter_map(|entry| index(&entry.0).map(|n| (n, entry)))
            .collect();
        indexed.sort_by_key(|(n, _)| *n);
        let mut ordered: Vec<&(Vec<u16>, String)> =
            indexed.into_iter().map(|(_, entry)| entry).collect();
        ordered.extend(entries.iter().filter(|entry| index(&entry.0).is_none()));
        Ok(ordered.into_iter().cloned().collect())
    }

    fn value(&mut self) -> Result<String, String> {
        self.whitespace();
        match self
            .bytes
            .get(self.at)
            .copied()
            .ok_or("missing JSON value")?
        {
            b'"' => Ok(render_json_string(&self.string()?)),
            b'[' => {
                self.at += 1;
                self.whitespace();
                let mut values = Vec::new();
                if self.bytes.get(self.at) != Some(&b']') {
                    loop {
                        values.push(self.value()?);
                        self.whitespace();
                        match self.bytes.get(self.at) {
                            Some(b',') => self.at += 1,
                            Some(b']') => break,
                            _ => return Err("invalid JSON array".into()),
                        }
                    }
                }
                self.at += 1;
                Ok(format!("[{}]", values.join(",")))
            }
            b'{' => {
                let fields = self
                    .object_entries()?
                    .into_iter()
                    .map(|(key, value)| format!("{}:{}", render_json_string(&key), value))
                    .collect::<Vec<_>>()
                    .join(",");
                Ok(format!("{{{fields}}}"))
            }
            _ => {
                let start = self.at;
                while self
                    .bytes
                    .get(self.at)
                    .is_some_and(|byte| !Self::is_json_whitespace(*byte) && !b",]}".contains(byte))
                {
                    self.at += 1;
                }
                let token =
                    std::str::from_utf8(&self.bytes[start..self.at]).map_err(|e| e.to_string())?;
                match token {
                    "true" | "false" | "null" => Ok(token.into()),
                    _ => {
                        if !is_json_number(token) {
                            return Err("invalid JSON number".into());
                        }
                        if self.preserve_number_tokens {
                            return Ok(token.into());
                        }
                        let number = token.parse::<f64>().map_err(|e| e.to_string())?;
                        if !number.is_finite() {
                            return Ok("null".into());
                        }
                        if number == 0.0 {
                            return Ok("0".into());
                        }
                        let mut buffer = ryu_js::Buffer::new();
                        Ok(buffer.format(number).to_owned())
                    }
                }
            }
        }
    }
}

pub(crate) fn ordered_json_object_entries_preserving_numbers(
    input: &str,
) -> Result<Vec<(String, String)>, String> {
    let mut parser = JsonTokenRenderer {
        bytes: input.as_bytes(),
        at: 0,
        preserve_number_tokens: true,
    };
    parser.whitespace();
    let entries = parser.object_entries()?;
    parser.whitespace();
    if parser.at != parser.bytes.len() {
        return Err("trailing JSON data".into());
    }
    Ok(entries
        .into_iter()
        .map(|(key, value)| (render_json_string(&key), value))
        .collect())
}

fn stringify_json_token(token: &str) -> Result<String, String> {
    let mut parser = JsonTokenRenderer {
        bytes: token.as_bytes(),
        at: 0,
        preserve_number_tokens: false,
    };
    let value = parser.value()?;
    parser.whitespace();
    if parser.at != parser.bytes.len() {
        return Err("trailing JSON data".into());
    }
    Ok(value)
}

fn context_units(value: &[u16]) -> bool {
    let value = trim_utf16_whitespace(value);
    let wrapped = |start: &str, end: &str| {
        value.starts_with(&start.encode_utf16().collect::<Vec<_>>())
            && value.ends_with(&end.encode_utf16().collect::<Vec<_>>())
    };
    let agents = value
        .strip_prefix(
            "# AGENTS.md instructions"
                .encode_utf16()
                .collect::<Vec<_>>()
                .as_slice(),
        )
        .is_some_and(|rest| {
            let rest = trim_utf16_whitespace(rest);
            rest.starts_with(&"<INSTRUCTIONS>".encode_utf16().collect::<Vec<_>>())
                && rest.ends_with(&"</INSTRUCTIONS>".encode_utf16().collect::<Vec<_>>())
        });
    agents
        || wrapped("<environment_context>", "</environment_context>")
        || wrapped("<recommended_plugins>", "</recommended_plugins>")
        || wrapped("<user_instructions>", "</user_instructions>")
        || wrapped("<turn_aborted>", "</turn_aborted>")
}

fn trim_utf16_whitespace(units: &[u16]) -> &[u16] {
    let start = units
        .iter()
        .position(|unit| !char::from_u32(*unit as u32).is_some_and(char::is_whitespace))
        .unwrap_or(units.len());
    let end = units
        .iter()
        .rposition(|unit| !char::from_u32(*unit as u32).is_some_and(char::is_whitespace))
        .map_or(start, |index| index + 1);
    &units[start..end]
}

fn js_slice(value: &str, limit: usize) -> Result<TranscriptRawText, String> {
    TranscriptRawText::from_text(value)?.truncate_units(limit)
}

fn model_id(value: &Value) -> Option<&str> {
    value.as_str()
}

fn group<'a>(catalog: &'a [Value], id: &str) -> Option<&'a str> {
    catalog.iter().find_map(|row| {
        (row.get("id").and_then(Value::as_str) == Some(id))
            .then(|| row.get("group").and_then(Value::as_str))
            .flatten()
    })
}

fn claude_model_alias(value: &Value, catalog: &[Value]) -> Value {
    let Some(id) = model_id(value) else {
        return value.clone();
    };
    if id.is_empty() || group(catalog, id) == Some("claude") || !id.starts_with("claude-") {
        return value.clone();
    }
    for (prefix, alias) in [
        ("claude-opus-", "opus"),
        ("claude-sonnet-", "sonnet"),
        ("claude-haiku-", "haiku"),
        ("claude-fable-", "fable"),
    ] {
        if let Some(version) = id.strip_prefix(prefix) {
            if version.chars().next().is_some_and(|ch| ch.is_ascii_digit())
                && id.ends_with("[1m]")
                && (alias == "opus" || alias == "sonnet")
            {
                return json!(format!("{alias}[1m]"));
            }
            return json!(alias);
        }
    }
    value.clone()
}

fn restore_ollama_tag(value: Value, catalog: &[Value]) -> Value {
    let Some(id) = value.as_str() else {
        return value;
    };
    if id.is_empty() || id.contains(':') {
        return value;
    }
    let hits: Vec<&str> = catalog
        .iter()
        .filter_map(|row| {
            let candidate = row.get("id")?.as_str()?;
            (row.get("group").and_then(Value::as_str) == Some("ollama")
                && candidate.split(':').next() == Some(id))
            .then_some(candidate)
        })
        .collect();
    if hits.len() == 1 {
        json!(hits[0])
    } else {
        json!(id)
    }
}

fn codex_content_text(content: &Value) -> String {
    content
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|part| part.get("text").and_then(Value::as_str))
        .collect()
}

fn codex_output_text(output: &Value) -> String {
    if output.is_array() {
        codex_content_text(output)
    } else if truthy(output) {
        output
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| output.to_string())
    } else {
        String::new()
    }
}

fn codex_context_text(text: &str) -> bool {
    let text = text.trim();
    let wrapped = |start: &str, end: &str| text.starts_with(start) && text.ends_with(end);
    let agents = text
        .strip_prefix("# AGENTS.md instructions")
        .is_some_and(|rest| {
            let rest = rest.trim_start();
            rest.starts_with("<INSTRUCTIONS>") && rest.ends_with("</INSTRUCTIONS>")
        });
    agents
        || wrapped("<environment_context>", "</environment_context>")
        || wrapped("<recommended_plugins>", "</recommended_plugins>")
        || wrapped("<user_instructions>", "</user_instructions>")
        || wrapped("<turn_aborted>", "</turn_aborted>")
}

fn codex_user_text(content: &Value) -> String {
    content
        .as_array()
        .into_iter()
        .flatten()
        .filter(|part| {
            !part
                .get("text")
                .and_then(Value::as_str)
                .is_some_and(codex_context_text)
        })
        .filter_map(|part| part.get("text").and_then(Value::as_str))
        .collect()
}

fn push_message(
    messages: &mut Vec<TranscriptMessage>,
    ts: &Value,
    role: &str,
    kind: &str,
    text: TranscriptRawText,
    name: Option<&Value>,
    recap: bool,
) {
    messages.push(TranscriptMessage {
        ts: ts.clone(),
        role: role.to_owned(),
        kind: kind.to_owned(),
        name: name.cloned(),
        raw_name: None,
        text,
        recap,
    });
}

/// Parse a Claude JSONL transcript into the legacy readSession envelope.
pub fn parse_claude(raw: &str, catalog: &[Value]) -> Result<TranscriptOutput, String> {
    parse_claude_with_tool_limit(raw, catalog, TOOL_TRUNC)
}

/// Parses Claude JSONL with a caller-selected UTF-16 tool-text limit.
pub fn parse_claude_with_tool_limit(
    raw: &str,
    catalog: &[Value],
    tool_limit: usize,
) -> Result<TranscriptOutput, String> {
    let mut cwd = Value::Null;
    let mut raw_cwd = None;
    let mut cwd_seen = false;
    let mut title = Value::Null;
    let mut raw_title = None;
    let mut turns = 0;
    let mut first_ts = Value::Null;
    let mut last_ts = Value::Null;
    let mut last_model = Value::Null;
    let mut messages = Vec::new();
    for (event, escaped_texts) in claude_events(raw) {
        if !event.is_object() {
            continue;
        }
        if !cwd_seen && event.get("__rawCwdToken").and_then(Value::as_str).is_some() {
            raw_cwd = event["__rawCwdToken"]
                .as_str()
                .and_then(|token| TranscriptRawText::from_json_token(token.to_owned()).ok());
            cwd_seen = raw_cwd.is_some();
        } else if !cwd_seen && truthy(&event["cwd"]) {
            cwd = event["cwd"].clone();
            cwd_seen = true;
        }
        if event["type"] == "ai-title" {
            if let Some(token) = event.get("__rawTitleToken").and_then(Value::as_str) {
                raw_title = TranscriptRawText::from_json_token(token.to_owned()).ok();
            } else if truthy(&event["aiTitle"]) {
                title = event["aiTitle"].clone();
                raw_title = None;
            }
        }
        if truthy(&event["timestamp"]) {
            if first_ts.is_null() {
                first_ts = event["timestamp"].clone();
            }
            last_ts = event["timestamp"].clone();
        }
        let ts = event
            .get("timestamp")
            .cloned()
            .filter(|v| !v.is_null())
            .unwrap_or(Value::Null);
        let message = &event["message"];
        if !truthy(message) {
            continue;
        }
        let recap = truthy(&event["isCompactSummary"]);
        if event["type"] == "user" {
            let content = &message["content"];
            if let Some(text) = content.as_str() {
                push_message(
                    &mut messages,
                    &ts,
                    "user",
                    "text",
                    TranscriptRawText::from_text(text)?,
                    None,
                    recap,
                );
            } else if let Some(blocks) = content.as_array() {
                for block in blocks {
                    if block["type"] == "tool_result" {
                        push_message(
                            &mut messages,
                            &ts,
                            "user",
                            "toolResult",
                            truncate(&block["content"], tool_limit)?,
                            None,
                            false,
                        );
                    } else if block["type"] == "text" {
                        if let Some(text) = block["text"].as_str() {
                            push_message(
                                &mut messages,
                                &ts,
                                "user",
                                "text",
                                TranscriptRawText::from_text(text)?,
                                None,
                                recap,
                            );
                        }
                    }
                }
            }
        } else if event["type"] == "assistant" {
            turns += 1;
            if truthy(&message["model"]) {
                last_model = message["model"].clone();
            }
            if let Some(blocks) = message["content"].as_array() {
                for block in blocks {
                    match block["type"].as_str().unwrap_or("") {
                        "text" => {
                            if let Some(text) = block["text"].as_str() {
                                push_message(
                                    &mut messages,
                                    &ts,
                                    "assistant",
                                    "text",
                                    TranscriptRawText::from_text(text)?,
                                    None,
                                    false,
                                );
                            }
                        }
                        "thinking" => {
                            if let Some(text) = block["thinking"].as_str() {
                                push_message(
                                    &mut messages,
                                    &ts,
                                    "assistant",
                                    "thinking",
                                    TranscriptRawText::from_text(text)?,
                                    None,
                                    false,
                                );
                            }
                        }
                        "tool_use" => push_message(
                            &mut messages,
                            &ts,
                            "assistant",
                            "toolUse",
                            truncate_json(&block["input"], tool_limit)?,
                            block.get("name"),
                            false,
                        ),
                        _ => {}
                    }
                }
            }
        }
        for escaped in escaped_texts {
            let role = if event["type"] == "assistant" {
                "assistant"
            } else {
                "user"
            };
            let text = if escaped.kind == "toolResult" || escaped.kind == "toolUse" {
                escaped.text.truncate_units(tool_limit)?
            } else {
                escaped.text
            };
            push_message(
                &mut messages,
                &ts,
                role,
                &escaped.kind,
                text,
                escaped.name.as_ref(),
                if escaped.kind == "text" { recap } else { false },
            );
        }
    }
    let model = restore_ollama_tag(claude_model_alias(&last_model, catalog), catalog);
    let mut meta = Map::new();
    meta.insert("cwd".into(), cwd.clone());
    meta.insert("title".into(), title.clone());
    meta.insert("turns".into(), json!(turns));
    meta.insert("firstTs".into(), first_ts);
    meta.insert("lastTs".into(), last_ts);
    meta.insert("model".into(), model);
    let mut raw_fields = HashMap::new();
    if let Some(value) = raw_cwd.or_else(|| raw_value_text(&cwd)) {
        raw_fields.insert("cwd".into(), value);
    }
    if let Some(value) = raw_title.or_else(|| raw_value_text(&title)) {
        raw_fields.insert("title".into(), value);
    }
    Ok(TranscriptOutput {
        ok: true,
        meta: TranscriptMeta {
            values: meta,
            raw_fields,
        },
        messages,
    })
}

/// Parse a Codex rollout into the legacy readSession envelope.
pub fn parse_codex(raw: &str) -> Result<TranscriptOutput, String> {
    parse_codex_with_tool_limit(raw, TOOL_TRUNC)
}

/// Parses a Codex rollout with a caller-selected UTF-16 tool-text limit.
pub fn parse_codex_with_tool_limit(
    raw: &str,
    tool_limit: usize,
) -> Result<TranscriptOutput, String> {
    let parsed_with_raw = codex_events(raw);
    let mut duplicate_users = HashMap::<Vec<u16>, usize>::new();
    for (event, escaped_texts) in &parsed_with_raw {
        let payload = &event["payload"];
        if event["type"] == "response_item"
            && payload["type"] == "message"
            && payload["role"] == "user"
        {
            let text = codex_user_text(&payload["content"]);
            if !text.is_empty() {
                *duplicate_users
                    .entry(text.encode_utf16().collect())
                    .or_default() += 1;
            }
        }
        for escaped in escaped_texts {
            if event["type"] == "response_item" && escaped.role == "user" && escaped.kind == "text"
            {
                if let Ok(units) = decode_string_token(escaped.text.0.get()) {
                    *duplicate_users.entry(units).or_default() += 1;
                }
            }
        }
    }
    let mut cwd = Value::Null;
    let mut raw_cwd = None;
    let mut session_id = Value::Null;
    let title = Value::Null;
    let mut turns = 0;
    let mut first_ts = Value::Null;
    let mut last_ts = Value::Null;
    let mut last_model = Value::Null;
    let mut messages = Vec::new();
    let mut raw_title = None;
    for (event, escaped_texts) in parsed_with_raw {
        if !event.is_object() {
            continue;
        }
        let ts = event
            .get("timestamp")
            .cloned()
            .filter(|v| !v.is_null())
            .unwrap_or(Value::Null);
        if truthy(&ts) {
            if first_ts.is_null() {
                first_ts = ts.clone();
            }
            last_ts = ts.clone();
        }
        let payload = &event["payload"];
        match event["type"].as_str().unwrap_or("") {
            "session_meta" => {
                if session_id.is_null() {
                    session_id = payload
                        .get("session_id")
                        .filter(|v| truthy(v))
                        .or_else(|| payload.get("id"))
                        .cloned()
                        .unwrap_or(Value::Null);
                }
                if cwd.is_null() {
                    raw_cwd =
                        event
                            .get("__rawCwdToken")
                            .and_then(Value::as_str)
                            .and_then(|token| {
                                TranscriptRawText::from_json_token(token.to_owned()).ok()
                            });
                }
                if cwd.is_null() && raw_cwd.is_none() && truthy(&payload["cwd"]) {
                    cwd = payload["cwd"].clone();
                }
            }
            "turn_context" => {
                if truthy(&payload["model"]) {
                    last_model = payload["model"].clone();
                }
            }
            "response_item" => match payload["type"].as_str().unwrap_or("") {
                "message" if payload["role"] == "user" => {
                    let text = codex_user_text(&payload["content"]);
                    if !text.is_empty() {
                        push_message(
                            &mut messages,
                            &ts,
                            "user",
                            "text",
                            TranscriptRawText::from_text(&text)?,
                            None,
                            false,
                        );
                        if raw_title.is_none() {
                            raw_title = Some(js_slice(&text, 120)?);
                        }
                    }
                }
                "message" if payload["role"] == "assistant" => {
                    turns += 1;
                    let text = codex_content_text(&payload["content"]);
                    if !text.is_empty() {
                        push_message(
                            &mut messages,
                            &ts,
                            "assistant",
                            "text",
                            TranscriptRawText::from_text(&text)?,
                            None,
                            false,
                        );
                    }
                }
                "reasoning" => {
                    let mut parts = Vec::new();
                    if let Some(values) = payload["summary"].as_array() {
                        parts.extend(values.iter());
                    }
                    if let Some(values) = payload["content"].as_array() {
                        parts.extend(values.iter());
                    }
                    let text: String = parts
                        .into_iter()
                        .filter_map(|p| p["text"].as_str())
                        .collect();
                    if !text.is_empty() {
                        push_message(
                            &mut messages,
                            &ts,
                            "assistant",
                            "thinking",
                            TranscriptRawText::from_text(&text)?,
                            None,
                            false,
                        );
                    }
                }
                "function_call" | "custom_tool_call" => {
                    let name = payload
                        .get("name")
                        .filter(|v| truthy(v))
                        .cloned()
                        .unwrap_or(json!("?"));
                    let args = payload
                        .get("arguments")
                        .filter(|v| truthy(v))
                        .or_else(|| payload.get("input"))
                        .cloned()
                        .unwrap_or(json!(""));
                    push_message(
                        &mut messages,
                        &ts,
                        "assistant",
                        "toolUse",
                        truncate_json(&args, tool_limit)?,
                        Some(&name),
                        false,
                    );
                }
                "function_call_output" | "custom_tool_call_output" => push_message(
                    &mut messages,
                    &ts,
                    "user",
                    "toolResult",
                    truncate(&json!(codex_output_text(&payload["output"])), tool_limit)?,
                    None,
                    false,
                ),
                "agent_message" => {
                    let text = codex_content_text(&payload["content"]);
                    if !text.is_empty() {
                        let author = payload["author"].as_str().unwrap_or("agent");
                        push_message(
                            &mut messages,
                            &ts,
                            "assistant",
                            "text",
                            TranscriptRawText::from_text(&format!("{author}: {text}"))?,
                            None,
                            false,
                        );
                    }
                }
                _ => {}
            },
            "event_msg" => match payload["type"].as_str().unwrap_or("") {
                "user_message" => {
                    let text = payload
                        .get("message")
                        .filter(|v| truthy(v))
                        .or_else(|| payload.get("text"))
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    if !text.is_empty() {
                        let key: Vec<u16> = text.encode_utf16().collect();
                        if let Some(count) = duplicate_users.get_mut(&key) {
                            if *count > 0 {
                                *count -= 1;
                                continue;
                            }
                        }
                        push_message(
                            &mut messages,
                            &ts,
                            "user",
                            "text",
                            TranscriptRawText::from_text(text)?,
                            None,
                            false,
                        );
                        if raw_title.is_none() {
                            raw_title = Some(js_slice(text, 120)?);
                        }
                    }
                }
                "mcp_tool_call_end" => {
                    let name = payload["invocation"]
                        .get("tool")
                        .filter(|v| truthy(v))
                        .cloned()
                        .unwrap_or(json!("?"));
                    let text = name
                        .as_str()
                        .map(str::to_owned)
                        .unwrap_or_else(|| name.to_string());
                    push_message(
                        &mut messages,
                        &ts,
                        "assistant",
                        "toolUse",
                        TranscriptRawText::from_text(&text)?,
                        Some(&name),
                        false,
                    );
                }
                _ => {}
            },
            _ => {}
        }
        for escaped in escaped_texts {
            if event["type"] == "event_msg" && escaped.role == "user" && escaped.kind == "text" {
                let key = decode_string_token(escaped.text.0.get())?;
                if let Some(count) = duplicate_users.get_mut(&key) {
                    if *count > 0 {
                        *count -= 1;
                        continue;
                    }
                }
            }
            if escaped.role == "assistant" && escaped.kind == "text" {
                turns += 1;
            }
            if escaped.role == "user" && raw_title.is_none() && escaped.kind == "text" {
                raw_title = Some(escaped.text.truncate_units(120)?);
            }
            push_message(
                &mut messages,
                &ts,
                &escaped.role,
                &escaped.kind,
                escaped.text,
                escaped.name.as_ref(),
                false,
            );
            if let Some(message) = messages.last_mut() {
                message.raw_name = escaped.raw_name;
            }
        }
    }
    let mut meta = Map::new();
    meta.insert("cwd".into(), cwd.clone());
    meta.insert("title".into(), title.clone());
    meta.insert("turns".into(), json!(turns));
    meta.insert("firstTs".into(), first_ts);
    meta.insert("lastTs".into(), last_ts);
    meta.insert("model".into(), last_model);
    meta.insert("source".into(), json!("codex"));
    meta.insert("sessionId".into(), session_id);
    let mut raw_fields = HashMap::new();
    if let Some(value) = raw_cwd.or_else(|| raw_value_text(&cwd)) {
        raw_fields.insert("cwd".into(), value);
    }
    if let Some(value) = raw_title.or_else(|| raw_value_text(&title)) {
        raw_fields.insert("title".into(), value);
    }
    Ok(TranscriptOutput {
        ok: true,
        meta: TranscriptMeta {
            values: meta,
            raw_fields,
        },
        messages,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn catalog() -> Vec<Value> {
        vec![
            json!({"id":"opus","group":"claude"}),
            json!({"id":"glm-5.2:cloud","group":"ollama"}),
            json!({"id":"glm-5.3:cloud","group":"ollama"}),
            json!({"id":"glm-5.3:local","group":"ollama"}),
        ]
    }

    #[test]
    fn shared_claude_fixture_matches_legacy_shape() {
        let fixture = include_str!("../../../server/fixtures/transcripts/claude.jsonl");
        let ordinary = fixture
            .lines()
            .filter(|line| !line.contains("escaped "))
            .collect::<Vec<_>>()
            .join("\n");
        let crlf = ordinary.replace('\n', "\r\n");
        let result = parse_claude(&crlf, &catalog()).unwrap().to_value();
        assert_eq!(
            result,
            json!({
                "ok":true,
                "meta":{"cwd":"C:\\repo","title":"Final title","turns":1,"firstTs":"2026-10-21T01:00:00Z","lastTs":"2026-10-21T01:00:01Z","model":"opus"},
                "messages":[
                    {"ts":"2026-10-21T01:00:00Z","role":"user","kind":"text","text":"hello 🌍","recap":true},
                    {"ts":"2026-10-21T01:00:00Z","role":"user","kind":"toolResult","text":"tool output"},
                    {"ts":"2026-10-21T01:00:01Z","role":"assistant","kind":"text","text":"answer"},
                    {"ts":"2026-10-21T01:00:01Z","role":"assistant","kind":"thinking","text":"reason"},
                    {"ts":"2026-10-21T01:00:01Z","role":"assistant","kind":"toolUse","name":"Read","text":"small args"}
                ]
            })
        );
    }

    #[test]
    fn shared_codex_fixture_filters_wrappers_and_suppresses_duplicate_user_event() {
        let result = parse_codex(include_str!(
            "../../../server/fixtures/transcripts/codex.jsonl"
        ))
        .unwrap()
        .to_value();
        assert_eq!(
            result,
            json!({
                "ok":true,
                "meta":{"cwd":"C:\\repo","title":"real prompt","turns":1,"firstTs":"2026-10-21T02:00:00Z","lastTs":"2026-10-21T02:00:06Z","model":"gpt-6.1-sol","source":"codex","sessionId":"root-session"},
                "messages":[
                    {"ts":"2026-10-21T02:00:02Z","role":"user","kind":"text","text":"real prompt"},
                    {"ts":"2026-10-21T02:00:04Z","role":"assistant","kind":"text","text":"answer"},
                    {"ts":"2026-10-21T02:00:05Z","role":"assistant","kind":"toolUse","name":"shell_command","text":"{\"command\":\"echo hi\"}"}
                ]
            })
        );
    }

    #[test]
    fn codex_title_stays_with_first_response_item_user_prompt() {
        let raw = concat!(
            r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"First item-only prompt"}]}}"#,
            "\n",
            r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Inspect this rollout"}]}}"#,
            "\n",
            r#"{"type":"event_msg","payload":{"type":"user_message","message":"Inspect this rollout"}}"#,
        );
        let parsed = parse_codex(raw).unwrap();
        assert_eq!(
            parsed
                .raw_meta_token("title")
                .map(|token| decode_string_token(token.get()).unwrap()),
            Some("First item-only prompt".encode_utf16().collect())
        );
    }

    #[test]
    fn explicit_catalog_restores_only_unique_ollama_tag() {
        let unique = parse_claude(
            include_str!("../../../server/fixtures/transcripts/claude-ollama.jsonl"),
            &catalog(),
        )
        .unwrap()
        .to_value();
        assert_eq!(unique["meta"]["model"], "glm-5.2:cloud");
        let ambiguous = restore_ollama_tag(json!("glm-5.3"), &catalog());
        assert_eq!(ambiguous, "glm-5.3");
    }

    #[test]
    fn shared_tool_truncation_fixture_matches_legacy_limit() {
        let fixture = include_str!("../../../server/fixtures/transcripts/tool-truncation.jsonl");
        let raw = fixture.replace("REPEAT301", &"x".repeat(301));
        let result = parse_claude(&raw, &catalog()).unwrap().to_value();
        assert_eq!(
            result["messages"][0]["text"],
            format!("{}…", "x".repeat(300))
        );
    }

    #[test]
    fn tool_truncation_limit_can_match_search_specific_contract() {
        let fixture = include_str!("../../../server/fixtures/transcripts/tool-truncation.jsonl");
        let raw = fixture.replace("REPEAT301", &"x".repeat(501));
        let result = parse_claude_with_tool_limit(&raw, &catalog(), 500)
            .unwrap()
            .to_value();
        assert_eq!(
            result["messages"][0]["text"],
            format!("{}…", "x".repeat(500))
        );
    }

    #[test]
    fn split_emoji_boundary_serializes_the_legacy_lone_surrogate() {
        let fixture = include_str!("../../../server/fixtures/transcripts/unicode-boundary.jsonl");
        let raw = fixture.replace("REPEAT299", &"x".repeat(299));
        let result = parse_claude(&raw, &catalog()).unwrap().to_json().unwrap();
        assert!(result.contains(&format!("{}\\ud83d…", "x".repeat(299))));
    }

    #[test]
    fn shared_claude_fixture_retains_escaped_lone_surrogate_source_text() {
        let fixture = include_str!("../../../server/fixtures/transcripts/claude.jsonl");
        let output = parse_claude(fixture, &catalog())
            .unwrap()
            .to_json()
            .unwrap();
        assert!(output.contains(r#""text":"escaped \ud83d""#));
        assert!(output.contains(r#""lastTs":"2026-10-21T01:00:02Z""#));
    }

    #[test]
    fn nested_claude_source_escaped_fixture_preserves_all_consumed_text_blocks() {
        let output = parse_claude(
            include_str!("../../../server/fixtures/transcripts/claude-source-escaped.jsonl"),
            &catalog(),
        )
        .unwrap()
        .to_json()
        .unwrap();
        for text in [
            r#"nested user \ud83d"#,
            r#"tool result \ude00"#,
            r#"assistant text \ud83d"#,
            r#"assistant thinking \ude00"#,
        ] {
            assert!(output.contains(text), "missing {text} in {output}");
        }
        assert!(output.contains(r#""text":"{\"query\":\"\\ud83d\"}""#));
    }

    #[test]
    fn escaped_claude_metadata_fixture_preserves_raw_utf16_tokens() {
        let parsed = parse_claude(
            include_str!("../../../server/fixtures/transcripts/claude-metadata-escaped.jsonl"),
            &catalog(),
        )
        .unwrap();
        assert_eq!(
            parsed.raw_meta_token("cwd").unwrap().get(),
            r#""C:\\repo\ud83d""#
        );
        assert_eq!(
            parsed.raw_meta_token("title").unwrap().get(),
            r#""Claude title \ude00""#
        );
        assert_eq!(
            parsed
                .raw_meta_token("cwd")
                .map(|token| decode_string_token(token.get()).unwrap()),
            Some("C:\\repo".encode_utf16().chain([0xd83d]).collect())
        );
        assert_eq!(
            parsed
                .raw_meta_token("title")
                .map(|token| decode_string_token(token.get()).unwrap()),
            Some("Claude title ".encode_utf16().chain([0xde00]).collect())
        );
        assert_eq!(
            parsed.raw_messages().next().unwrap().text.units().unwrap(),
            "Claude message "
                .encode_utf16()
                .chain([0xd83d])
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn codex_source_escaped_fixture_preserves_user_and_tool_text() {
        let output = parse_codex(include_str!(
            "../../../server/fixtures/transcripts/codex-source-escaped.jsonl"
        ))
        .unwrap()
        .to_json()
        .unwrap();
        for text in [
            r#"codex user \ud83d"#,
            r#"codex assistant \ude00"#,
            r#"codex args \ud83d"#,
            r#"codex output \ude00"#,
        ] {
            assert!(output.contains(text), "missing {text} in {output}");
        }
    }

    #[test]
    fn codex_parser_parity_fixture_filters_wrappers_and_matches_js_json_stringify() {
        let parsed = parse_codex(include_str!(
            "../../../server/fixtures/transcripts/codex-parser-parity.jsonl"
        ))
        .unwrap();
        let output = parsed.to_json().unwrap();
        assert!(output.contains(r#""title":"same \ud83d prompt""#));
        assert!(output.contains(r#""text":"same \ud83d prompt""#));
        assert!(!output.contains("environment_context"));
        assert!(!output.contains("recommended_plugins"));
        assert!(output.contains(r#"\"2\":\"two\",\"10\":\"ten\""#));
        assert!(output.contains("100000000000000000000"));
        assert!(output.contains("9007199254740992"));
        assert!(output.contains(r#"\"duplicate\":\"last\""#));
        assert!(output.contains(r#"\\ud83d"#));
        assert!(output.contains("surrogate key"));
        assert_eq!(
            parsed.raw_meta_token("cwd").unwrap().get(),
            r#""C:\\repo\ud83d""#
        );
        assert_eq!(
            parsed
                .raw_meta_token("title")
                .map(|token| decode_string_token(token.get()).unwrap()),
            Some(
                "same "
                    .encode_utf16()
                    .chain([0xd83d])
                    .chain(" prompt".encode_utf16())
                    .collect()
            )
        );
        assert_eq!(
            parsed.raw_messages().last().unwrap().text.units().unwrap(),
            "array first array second "
                .encode_utf16()
                .chain([0xde00])
                .collect::<Vec<_>>()
        );
        let tool_messages = parsed
            .raw_messages()
            .filter(|message| message.kind == "toolUse")
            .collect::<Vec<_>>();
        assert_eq!(tool_messages.len(), 3);
        assert_eq!(tool_messages[0].ts, &json!("2026-10-21T05:00:03Z"));
        assert_eq!(tool_messages[0].role, "assistant");
        assert_eq!(tool_messages[0].kind, "toolUse");
        assert_eq!(
            tool_messages[0].name.and_then(Value::as_str),
            Some("parity")
        );
        assert_eq!(tool_messages[1].ts, &json!("2026-10-21T05:00:03Z"));
        assert_eq!(tool_messages[1].role, "assistant");
        assert_eq!(tool_messages[1].kind, "toolUse");
        assert_eq!(tool_messages[1].name.and_then(Value::as_str), Some("?"));
        assert_eq!(tool_messages[2].ts, &json!("2026-10-21T05:00:03Z"));
        assert_eq!(tool_messages[2].role, "assistant");
        assert_eq!(tool_messages[2].kind, "toolUse");
        assert_eq!(tool_messages[2].name, None);
        assert_eq!(
            tool_messages[2].raw_name.map(RawValue::get),
            Some(r#""tool\ud83d""#)
        );
        assert!(output.contains(r#""name":"tool\ud83d""#));
    }

    #[test]
    fn recursive_stringifier_matches_ecmascript_key_and_number_rules() {
        assert_eq!(
            stringify_json_token(r#" {"10":"ten","2":"two","01":"leading","4294967295":"max","n":{"a":1e20,"b":1e21,"c":1e-6,"d":1e-7,"e":-0,"f":9007199254740993}} "#).unwrap(),
            r#"{"2":"two","10":"ten","01":"leading","4294967295":"max","n":{"a":100000000000000000000,"b":1e+21,"c":0.000001,"d":1e-7,"e":0,"f":9007199254740992}}"#
        );
        assert_eq!(
            stringify_json_token(r#"{"x":"first","x":"last","\ud83d":"key"}"#).unwrap(),
            r#"{"x":"last","\ud83d":"key"}"#
        );
    }

    #[test]
    fn raw_text_accepts_and_serializes_an_escaped_lone_surrogate() {
        let text = TranscriptRawText::from_json_token(r#""\ud83d""#.to_owned()).unwrap();
        assert_eq!(text.0.get(), r#""\ud83d""#);
        let nested = serde_json::to_string(&text).unwrap();
        assert_eq!(nested, r#""\ud83d""#);
    }

    #[test]
    fn raw_text_supports_utf16_slice_and_case_insensitive_search() {
        let text = TranscriptRawText::from_json_token(r#""a\ud83dBC xyz""#.to_owned()).unwrap();
        assert_eq!(text.find_case_insensitive("bc").unwrap(), Some(2));
        assert_eq!(text.slice_units(1, 2).unwrap().0.get(), r#""\ud83d""#);
    }

    #[test]
    fn utf16_slice_can_cut_at_the_high_surrogate_boundary() {
        let text = format!("{}😀", "x".repeat(299));
        let sliced = js_slice(&text, 300).unwrap();
        assert_eq!(sliced.0.get(), format!("\"{}\\ud83d…\"", "x".repeat(299)));
    }
}
