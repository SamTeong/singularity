//! Deterministic renderer for the repository-bundled harness-usage-report.
//! It has no filesystem, process, clock, network, or credential access.

use serde_json::value::RawValue;
use std::fmt;

mod templates {
    include!("usage_report_templates.rs");
}

const BASE: &str =
    include_str!("../../../.claude/skills/harness-usage-report/scripts/sources/base.html");
const HERO: &str =
    include_str!("../../../.claude/skills/harness-usage-report/scripts/sources/hero.html");
const APP: &str =
    include_str!("../../../.claude/skills/harness-usage-report/scripts/sources/app.js");
const STYLE: &str =
    include_str!("../../../.claude/skills/harness-usage-report/scripts/sources/style.css");
const PHOSPHOR: &str =
    include_str!("../../../.claude/skills/harness-usage-report/scripts/sources/skin-phosphor.css");
const FONTS: &str =
    include_str!("../../../.claude/skills/harness-usage-report/scripts/sources/fonts.css");
const MOTION: &str =
    include_str!("../../../.claude/skills/harness-usage-report/scripts/sources/motion.html");

/// Source sessions use the same JSON token contract as the bundled JS renderer.
/// RawValue preserves escaped lone UTF-16 surrogates on leaves.
pub struct ReportPayload<'a> {
    pub sessions: &'a [Box<RawValue>],
    pub forecast: Option<&'a RawValue>,
    /// Raw JSON array to retain the source renderer's malformed-entry errors.
    pub roadmap: Option<&'a RawValue>,
    /// Injected local time, already formatted `YYYY-MM-DD HH:mm:ss`.
    pub generated_local: &'a str,
}

#[derive(Debug, PartialEq, Eq)]
pub struct RenderError(pub String);

impl fmt::Display for RenderError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for RenderError {}

#[derive(Default)]
struct Fields(Vec<(Vec<u16>, Box<RawValue>)>);

fn fields(raw: &RawValue) -> Result<Fields, RenderError> {
    let text = raw.get();
    let bytes = text.as_bytes();
    if bytes.first() != Some(&b'{') {
        return Err(RenderError("expected a JSON object".into()));
    }
    let mut cursor = 1;
    skip_ws(bytes, &mut cursor);
    let mut fields = Vec::new();
    if bytes.get(cursor) == Some(&b'}') {
        return Ok(Fields(fields));
    }
    loop {
        let key_start = cursor;
        skip_string(bytes, &mut cursor);
        let key = string_units(&text[key_start..cursor])?;
        skip_ws(bytes, &mut cursor);
        cursor += 1;
        skip_ws(bytes, &mut cursor);
        let value_start = cursor;
        skip_value(bytes, &mut cursor);
        let value = RawValue::from_string(text[value_start..cursor].to_owned())
            .map_err(|e| RenderError(e.to_string()))?;
        if let Some(index) = fields
            .iter()
            .position(|(name, _)| name.as_slice() == key.as_slice())
        {
            fields[index].1 = value;
        } else {
            fields.push((key, value));
        }
        skip_ws(bytes, &mut cursor);
        if bytes.get(cursor) == Some(&b'}') {
            return Ok(Fields(fields));
        }
        cursor += 1;
        skip_ws(bytes, &mut cursor);
    }
}

fn skip_ws(bytes: &[u8], cursor: &mut usize) {
    while bytes
        .get(*cursor)
        .is_some_and(|b| matches!(b, b' ' | b'\n' | b'\r' | b'\t'))
    {
        *cursor += 1;
    }
}
fn skip_string(bytes: &[u8], cursor: &mut usize) {
    *cursor += 1;
    while bytes[*cursor] != b'"' {
        if bytes[*cursor] == b'\\' {
            *cursor += 2;
        } else {
            *cursor += 1;
        }
    }
    *cursor += 1;
}
fn skip_value(bytes: &[u8], cursor: &mut usize) {
    match bytes[*cursor] {
        b'"' => skip_string(bytes, cursor),
        b'{' | b'[' => {
            let mut stack = vec![bytes[*cursor]];
            *cursor += 1;
            while !stack.is_empty() {
                match bytes[*cursor] {
                    b'"' => skip_string(bytes, cursor),
                    b'{' | b'[' => {
                        stack.push(bytes[*cursor]);
                        *cursor += 1;
                    }
                    b'}' | b']' => {
                        stack.pop();
                        *cursor += 1;
                    }
                    _ => *cursor += 1,
                }
            }
        }
        _ => {
            while bytes
                .get(*cursor)
                .is_some_and(|b| !matches!(b, b',' | b']' | b'}' | b' ' | b'\n' | b'\r' | b'\t'))
            {
                *cursor += 1;
            }
        }
    }
}

fn properties(raw: &RawValue) -> Result<Fields, RenderError> {
    if raw.get() == "null" {
        return Err(RenderError("Cannot read properties of null".into()));
    }
    if raw.get().starts_with('{') {
        fields(raw)
    } else {
        Ok(Fields::default())
    }
}

fn object_keys_nonempty(raw: &RawValue) -> Result<bool, RenderError> {
    let token = raw.get();
    if token.starts_with('{') {
        return Ok(!fields(raw)?.0.is_empty());
    }
    if token.starts_with('[') {
        let values: Vec<Box<RawValue>> =
            serde_json::from_str(token).map_err(|e| RenderError(e.to_string()))?;
        return Ok(!values.is_empty());
    }
    if token.starts_with('"') {
        return Ok(!string_units(token)?.is_empty());
    }
    Ok(false)
}

fn field<'a>(fields: &'a Fields, name: &str) -> Option<&'a RawValue> {
    let key: Vec<u16> = name.encode_utf16().collect();
    fields
        .0
        .iter()
        .find(|(k, _)| k.as_slice() == key.as_slice())
        .map(|(_, v)| v.as_ref())
}

fn string_units(token: &str) -> Result<Vec<u16>, RenderError> {
    let body = token
        .strip_prefix('"')
        .and_then(|v| v.strip_suffix('"'))
        .ok_or_else(|| RenderError("invalid JSON string".into()))?;
    let mut units = Vec::<u16>::new();
    let mut chars = body.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch != '\\' {
            let mut buf = [0; 2];
            units.extend_from_slice(ch.encode_utf16(&mut buf));
            continue;
        }
        let esc = chars
            .next()
            .ok_or_else(|| RenderError("invalid JSON escape".into()))?;
        match esc {
            '"' => units.push(0x22),
            '\\' => units.push(0x5c),
            '/' => units.push(0x2f),
            'b' => units.push(8),
            'f' => units.push(12),
            'n' => units.push(10),
            'r' => units.push(13),
            't' => units.push(9),
            'u' => {
                let mut hex = String::with_capacity(4);
                for _ in 0..4 {
                    hex.push(
                        chars
                            .next()
                            .ok_or_else(|| RenderError("invalid unicode escape".into()))?,
                    );
                }
                units.push(u16::from_str_radix(&hex, 16).map_err(|e| RenderError(e.to_string()))?);
            }
            _ => return Err(RenderError("invalid JSON escape".into())),
        }
    }
    Ok(units)
}

fn string_from_units(units: &[u16]) -> String {
    let mut out = String::from("\"");
    let mut i = 0;
    while i < units.len() {
        let u = units[i];
        if (0xd800..=0xdbff).contains(&u)
            && i + 1 < units.len()
            && (0xdc00..=0xdfff).contains(&units[i + 1])
        {
            let cp = 0x10000 + (((u as u32 - 0xd800) << 10) | (units[i + 1] as u32 - 0xdc00));
            out.push(char::from_u32(cp).unwrap());
            i += 2;
            continue;
        }
        if (0xd800..=0xdfff).contains(&u) {
            out.push_str(&format!("\\u{u:04x}"));
            i += 1;
            continue;
        }
        match u {
            0x22 => out.push_str("\\\""),
            0x5c => out.push_str("\\\\"),
            8 => out.push_str("\\b"),
            9 => out.push_str("\\t"),
            10 => out.push_str("\\n"),
            12 => out.push_str("\\f"),
            13 => out.push_str("\\r"),
            0..=31 => out.push_str(&format!("\\u{u:04x}")),
            _ => out.push(char::from_u32(u as u32).unwrap()),
        }
        i += 1;
    }
    out.push('"');
    out
}

fn quote_raw_string(token: &str) -> Result<String, RenderError> {
    Ok(string_from_units(&string_units(token)?))
}

fn trimmed_raw_string(token: &str) -> Result<Option<String>, RenderError> {
    let mut units = string_units(token)?;
    let whitespace = |u: u16| matches!(u, 0x0009..=0x000d | 0x0020 | 0x00a0 | 0x1680 | 0x2000..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff);
    let start = units
        .iter()
        .position(|u| !whitespace(*u))
        .unwrap_or(units.len());
    let end = units
        .iter()
        .rposition(|u| !whitespace(*u))
        .map_or(start, |i| i + 1);
    if start == end {
        return Ok(None);
    }
    units = units[start..end].to_vec();
    Ok(Some(string_from_units(&units)))
}

fn compact(raw: &RawValue) -> Result<String, RenderError> {
    let token = raw.get();
    if token.starts_with('"') {
        return quote_raw_string(token);
    }
    if token.starts_with('{') {
        let object = fields(raw)?;
        let mut ordered = object.0;
        let index = |key: &[u16]| {
            if key.is_empty()
                || key
                    .iter()
                    .any(|u| !u8::try_from(*u).is_ok_and(|b| b.is_ascii_digit()))
                || (key.len() > 1 && key[0] == b'0' as u16)
            {
                return None;
            }
            let text = String::from_utf16(key).ok()?;
            text.parse::<u32>()
                .ok()
                .filter(|n| *n != u32::MAX && n.to_string() == text)
        };
        ordered.sort_by(|(a, _), (b, _)| match (index(a), index(b)) {
            (Some(a), Some(b)) => a.cmp(&b),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => std::cmp::Ordering::Equal,
        });
        let mut entries = Vec::with_capacity(ordered.len());
        for (key, value) in ordered {
            entries.push(format!("{}:{}", string_from_units(&key), compact(&value)?));
        }
        return Ok(format!("{{{}}}", entries.join(",")));
    }
    if token.starts_with('[') {
        let values: Vec<Box<RawValue>> =
            serde_json::from_str(token).map_err(|e| RenderError(e.to_string()))?;
        let mut entries = Vec::with_capacity(values.len());
        for value in values {
            entries.push(compact(&value)?);
        }
        return Ok(format!("[{}]", entries.join(",")));
    }
    if token == "true" || token == "false" || token == "null" {
        return Ok(token.to_string());
    }
    let number = token
        .parse::<f64>()
        .map_err(|e| RenderError(e.to_string()))?;
    if !number.is_finite() {
        return Ok("null".into());
    }
    if number == 0.0 {
        return Ok("0".into());
    }
    let mut buffer = ryu_js::Buffer::new();
    Ok(buffer.format_finite(number).to_owned())
}

fn truthy(raw: &RawValue) -> bool {
    let s = raw.get();
    if s == "null" || s == "false" || s == "0" || s == "-0" || s == "\"\"" {
        return false;
    }
    if let Ok(v) = serde_json::from_str::<f64>(s) {
        return v != 0.0;
    }
    true
}

fn parse_float(raw: &RawValue) -> Option<f64> {
    let text = js_string(raw);
    let is_ecmascript_whitespace = |ch: char| {
        matches!(
            ch,
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
    };
    let trimmed = text.trim_start_matches(is_ecmascript_whitespace);
    if ["Infinity", "+Infinity"]
        .iter()
        .any(|s| trimmed.starts_with(s))
    {
        return Some(f64::INFINITY);
    }
    if trimmed.starts_with("-Infinity") {
        return Some(f64::NEG_INFINITY);
    }
    for end in (1..=trimmed.len()).rev() {
        if !trimmed.is_char_boundary(end) {
            continue;
        }
        if let Ok(value) = trimmed[..end].parse::<f64>() {
            return Some(value);
        }
    }
    None
}

fn inum(raw: Option<&RawValue>) -> Option<f64> {
    let raw = raw?;
    if raw.get() == "null" || raw.get() == "\"\"" {
        return None;
    }
    parse_float(raw).filter(|n| !n.is_nan()).map(f64::trunc)
}

fn js_string(raw: &RawValue) -> String {
    let s = raw.get();
    if s == "null" {
        return "null".into();
    }
    if let Ok(v) = serde_json::from_str::<String>(s) {
        return v;
    }
    if s.starts_with('[') {
        if let Ok(values) = serde_json::from_str::<Vec<Box<RawValue>>>(s) {
            return values
                .iter()
                .map(|v| {
                    if v.get() == "null" {
                        String::new()
                    } else {
                        js_string(v)
                    }
                })
                .collect::<Vec<_>>()
                .join(",");
        }
        return String::new();
    }
    if s.starts_with('{') {
        return "[object Object]".into();
    }
    if let Ok(value) = s.parse::<f64>() {
        if value.is_infinite() {
            return if value.is_sign_negative() {
                "-Infinity"
            } else {
                "Infinity"
            }
            .into();
        }
        if value == 0.0 {
            return "0".into();
        }
        if value.is_finite() {
            let mut buffer = ryu_js::Buffer::new();
            return buffer.format_finite(value).to_owned();
        }
    }
    s.to_string()
}

fn quote(value: &str) -> String {
    serde_json::to_string(value).expect("string serialization")
}

fn projection(raw: &RawValue) -> Result<String, RenderError> {
    let session = properties(raw)?;
    let mut out = Vec::new();
    for (source, target) in [
        ("ts", "ts"),
        ("sid", "sid"),
        ("cost", "cost"),
        ("model", "model"),
        ("disp", "disp"),
        ("in", "in"),
        ("out", "out"),
        ("cr", "cr"),
        ("cc", "cc"),
        ("tok", "tok"),
        ("dur", "dur"),
        ("api", "api"),
        ("la", "la"),
        ("lr", "lr"),
        ("rl5", "r5"),
        ("rl7", "r7"),
        ("turns", "turns"),
        ("tools", "tools"),
        ("hour", "hour"),
        ("dow", "dow"),
    ] {
        if let Some(value) = field(&session, source) {
            out.push(format!("{}:{}", quote(target), compact(value)?));
        }
    }
    if let Some(facets_raw) = field(&session, "facets").filter(|v| truthy(v)) {
        let facets = properties(facets_raw)?;
        let mut projected = Vec::new();
        for (source, target) in [("tools", "t"), ("agents", "a"), ("skills", "s")] {
            if let Some(value) = field(&facets, source).filter(|v| truthy(v)) {
                if object_keys_nonempty(value)? {
                    projected.push(format!("{}:{}", quote(target), compact(value)?));
                }
            }
        }
        for (source, target) in [("compactions", "ce"), ("tool_errors", "te")] {
            let n = inum(field(&facets, source));
            if let Some(n) = n.filter(|n| *n != 0.0) {
                let json_number = if n.is_finite() {
                    compact(
                        &RawValue::from_string(n.to_string())
                            .map_err(|e| RenderError(e.to_string()))?,
                    )?
                } else {
                    "null".into()
                };
                projected.push(format!("{}:{}", quote(target), json_number));
            }
        }
        if let Some(cwd) = field(&facets, "cwd").filter(|v| truthy(v)) {
            if !cwd.get().starts_with('"') {
                return Err(RenderError("fc.cwd.trim is not a function".into()));
            }
            if let Some(value) = trimmed_raw_string(cwd.get())? {
                projected.push(format!("\"cwd\":{value}"));
            }
        }
        if !projected.is_empty() {
            out.push(format!("\"facets\":{{{}}}", projected.join(",")));
        }
    }
    Ok(format!("{{{}}}", out.join(",")))
}

fn esc(input: &str) -> String {
    input
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#x27;")
}

fn fill(template: &str, slots: &[(&str, &str)]) -> String {
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(open) = rest.find("{{") {
        out.push_str(&rest[..open]);
        let after = &rest[open + 2..];
        if let Some(close) = after.find("}}") {
            let key = &after[..close];
            if let Some((_, value)) = slots.iter().find(|(name, _)| *name == key) {
                out.push_str(value);
            } else {
                out.push_str(&rest[open..open + close + 4]);
            }
            rest = &after[close + 2..];
        } else {
            out.push_str(&rest[open..]);
            rest = "";
        }
    }
    out.push_str(rest);
    out
}

struct Suggestion {
    status: String,
    area: String,
    text: String,
}

fn string_member(fields: &Fields, key: &str) -> Result<String, RenderError> {
    Ok(match field(fields, key) {
        None => String::new(),
        Some(value) if value.get() == "null" => String::new(),
        Some(value) => js_string(value),
    })
}

fn roadmap(raw: Option<&RawValue>) -> Result<String, RenderError> {
    let Some(raw) = raw.filter(|v| truthy(v)) else {
        return Ok("<p class='muted'>Run <code>/harness-usage-report-suggestions</code> for the pipeline improvement roadmap (capture → schema → aggregation → visualization).</p>".into());
    };
    let entries: Vec<Box<RawValue>> =
        serde_json::from_str(raw.get()).map_err(|e| RenderError(e.to_string()))?;
    let mut items = Vec::new();
    for (i, entry) in entries.iter().enumerate() {
        let f = properties(entry)?;
        items.push((
            i,
            Suggestion {
                status: string_member(&f, "status")?,
                area: string_member(&f, "area")?,
                text: string_member(&f, "text")?,
            },
        ));
    }
    items.sort_by(|(ia, a), (ib, b)| a.status.cmp(&b.status).then(ia.cmp(ib)));
    let mut rows = String::new();
    for (_, item) in &items {
        let badge = match item.status.as_str() {
            "available" => "st-ok",
            "partial" => "st-part",
            "idea" => "st-idea",
            "done" => "st-done",
            _ => "st-idea",
        };
        rows.push_str(&format!("<div class='sg rv' data-st='{}'><span class='sg-b {}'>{}</span><span class='sg-a'>{}</span><span class='sg-t'>{}</span></div>", esc(&item.status), badge, esc(&item.status), esc(&item.area), esc(&item.text)));
    }
    let mut tags: Vec<&str> = items
        .iter()
        .map(|(_, v)| v.status.as_str())
        .filter(|s| matches!(*s, "available" | "partial" | "idea" | "done"))
        .collect();
    tags.sort_unstable();
    tags.dedup();
    let chips = tags.iter().map(|tag| {
        let (swatch,label) = match *tag { "available"=>("var(--sage)","Available"),"partial"=>("var(--amber)","Partial"),"idea"=>("var(--azure)","Idea"),_=>("var(--ink-faint)","Done") };
        format!("<button class='lg-item' type='button' data-st='{}'><span class='lg-swatch' style='background:{}'></span>{}</button>", esc(tag), swatch, label)
    }).collect::<Vec<_>>().join("");
    let filter = if chips.is_empty() {
        String::new()
    } else {
        format!(
            "<div class='filter-bar' id='road-fbar'><span class='filter-lbl'>Roadmap</span>{chips}<button class='lg-all active' type='button'>all</button></div>"
        )
    };
    Ok(format!(
        "{filter}<div class='sgs' id='road-sgs'>{rows}</div>"
    ))
}

/// Render full bundled report HTML. Errors represent malformed source sessions
/// or roadmap entries that the JavaScript renderer also rejects.
pub fn render_html(payload: &ReportPayload<'_>) -> Result<String, RenderError> {
    let generated = esc(payload.generated_local);
    let hero = fill(HERO, &[("GENERATED", &generated)]);
    let style = format!("{FONTS}\n{STYLE}\n{PHOSPHOR}");
    let mut sessions = Vec::with_capacity(payload.sessions.len());
    for session in payload.sessions {
        sessions.push(projection(session)?);
    }
    let sessions_json = format!("[{}]", sessions.join(",")).replace('<', "\\u003c");
    let forecast = match payload.forecast.filter(|v| truthy(v)) {
        Some(value) => compact(value)?.replace('<', "\\u003c"),
        None => "{}".into(),
    };
    let scripts = format!(
        "<script>\nvar SESSIONS={sessions_json};\nvar FORECAST={forecast};\n{APP}\n{}\n{}</script>",
        templates::SIDEBAR_JS,
        templates::FILTERRAIL_JS
    );
    let roadmap_html = fill(
        templates::ROADMAP_HTML,
        &[("ROADMAP_BODY", &roadmap(payload.roadmap)?)],
    );
    let slots = [
        ("STYLE", style.as_str()),
        ("HERO", hero.as_str()),
        ("FILTERRAIL", templates::FILTERRAIL_HTML),
        ("BURN", templates::BURN_HTML),
        ("BREAKDOWN", templates::BREAKDOWN_HTML),
        ("TOKEN_ECONOMICS", templates::TOKEN_ECONOMICS_HTML),
        ("EFFICIENCY", templates::EFFICIENCY_HTML),
        ("RATE_LIMITS", templates::RATE_LIMITS_HTML),
        ("WHEN_YOU_WORK", templates::WHEN_YOU_WORK_HTML),
        ("SESSIONS", templates::SESSIONS_HTML),
        ("USAGE_PATTERNS", templates::USAGE_PATTERNS_HTML),
        ("PROJECTS", templates::PROJECTS_HTML),
        ("MODELS", templates::MODELS_HTML),
        ("ROADMAP", roadmap_html.as_str()),
        ("FOOTER", templates::FOOTER_HTML),
        ("SCRIPTS", scripts.as_str()),
        ("MOTION", MOTION),
        ("SIDEBAR", templates::SIDEBAR_HTML),
    ];
    Ok(fill(BASE, &slots))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw(s: &str) -> Box<RawValue> {
        RawValue::from_string(s.to_string()).unwrap()
    }

    #[test]
    fn complete_document_projects_facets_and_preserves_raw_utf16_and_assets() {
        let sessions = [raw(
            r#"{"ts":null,"sid":"\ud83d","rl5":3,"facets":{"tools":{"edit":2},"compactions":"2.9x","cwd":" /repo "}}"#,
        )];
        let forecast = raw(r#"{"gauges":["</script><x>"]}"#);
        let p = ReportPayload {
            sessions: &sessions,
            forecast: Some(&forecast),
            roadmap: None,
            generated_local: "2026-10-25 <& 01:02:03",
        };
        let html = render_html(&p).unwrap();
        assert!(html.contains("var SESSIONS=[{\"ts\":null,\"sid\":\"\\ud83d\",\"r5\":3,\"facets\":{\"t\":{\"edit\":2},\"ce\":2,\"cwd\":\"/repo\"}}];"));
        assert!(html.contains("FORECAST={\"gauges\":[\"\\u003c/script>"));
        for asset in [APP, STYLE, PHOSPHOR, FONTS, MOTION] {
            assert!(html.contains(asset));
        }
        assert!(html.contains("<title>AI Coding Usage Report</title>"));
        assert!(html.contains("Know exactly what your coding agents cost you."));
        assert!(html.contains("generated 2026-10-25 &lt;&amp; 01:02:03"));
        assert!(!html.contains("{{"));
        assert!(html.contains(templates::SIDEBAR_JS) && html.contains(templates::FILTERRAIL_JS));
    }

    #[test]
    fn roadmap_status_chips_sort_escape_and_malformed_entries_error() {
        let road = raw(
            r#"[{"status":"idea","area":"<area>","text":"a&b"},{"status":"done","area":"x","text":"y"},{"status":"mystery","area":"z","text":"q"}]"#,
        );
        let p = ReportPayload {
            sessions: &[],
            forecast: None,
            roadmap: Some(&road),
            generated_local: "2026-01-02 03:04:05",
        };
        let html = render_html(&p).unwrap();
        assert!(html.contains("data-st='idea'") && html.contains("data-st='done'"));
        assert!(html.contains("<span class='sg-a'>&lt;area&gt;</span>"));
        assert!(html.contains("data-st='idea'><span class='lg-swatch'"));
        let malformed = raw("[null]");
        let bad = ReportPayload {
            roadmap: Some(&malformed),
            ..p
        };
        assert!(render_html(&bad).is_err());
    }
}
