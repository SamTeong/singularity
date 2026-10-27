//! Pure aggregation of Claude transcript text for usage reports.
//!
//! Surfaced strings remain JSON string tokens. This preserves escaped UTF-16
//! (including lone surrogates) until a later serialization boundary.

use serde_json::value::RawValue;

#[derive(Clone, Debug, PartialEq)]
pub struct JsonText(String);

impl JsonText {
    pub fn json_token(&self) -> &str {
        &self.0
    }

    pub fn raw_value(&self) -> Result<Box<RawValue>, String> {
        RawValue::from_string(self.0.clone()).map_err(|error| error.to_string())
    }

    fn from_token(token: &str) -> Self {
        Self(token.to_owned())
    }

    fn empty() -> Self {
        Self("\"\"".into())
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct TranscriptFacets {
    pub tools: Vec<(JsonText, CountValue)>,
    pub agents: Vec<(JsonText, CountValue)>,
    pub skills: Vec<(JsonText, CountValue)>,
    pub tool_errors: f64,
    pub compactions: f64,
    pub cwd: JsonText,
    pub branch: JsonText,
}

#[derive(Clone, Debug, PartialEq)]
pub enum CountValue {
    Number(f64),
    String(JsonText),
}

impl Default for TranscriptFacets {
    fn default() -> Self {
        Self {
            tools: Vec::new(),
            agents: Vec::new(),
            skills: Vec::new(),
            tool_errors: 0.0,
            compactions: 0.0,
            cwd: JsonText::empty(),
            branch: JsonText::empty(),
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct TranscriptTotals {
    pub last_model: JsonText,
    pub input_tokens: f64,
    pub output_tokens: f64,
    pub cache_read_tokens: f64,
    pub cache_creation_tokens: f64,
    pub end_epoch: Option<f64>,
    pub start_epoch: Option<f64>,
    pub turns: f64,
    pub tool_calls: f64,
    pub facets: TranscriptFacets,
}

impl Default for TranscriptTotals {
    fn default() -> Self {
        Self {
            last_model: JsonText::empty(),
            input_tokens: 0.0,
            output_tokens: 0.0,
            cache_read_tokens: 0.0,
            cache_creation_tokens: 0.0,
            end_epoch: None,
            start_epoch: None,
            turns: 0.0,
            tool_calls: 0.0,
            facets: TranscriptFacets::default(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TranscriptError(pub String);

impl std::fmt::Display for TranscriptError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for TranscriptError {}

fn entries(token: &str) -> Result<Vec<(String, String)>, String> {
    crate::transcripts::ordered_json_object_entries_preserving_numbers(token)
}

fn get<'a>(fields: &'a [(String, String)], key: &str) -> Option<&'a str> {
    let token = format!("{key:?}");
    fields
        .iter()
        .find(|(candidate, _)| candidate == &token)
        .map(|(_, value)| value.as_str())
}

fn object(token: &str) -> Vec<(String, String)> {
    entries(token).unwrap_or_default()
}

fn array(token: &str) -> Vec<String> {
    let wrapped = format!("{{\"value\":{token}}}");
    entries(&wrapped)
        .ok()
        .and_then(|fields| get(&fields, "value").map(str::to_owned))
        .and_then(|value| serde_json::from_str::<Vec<Box<RawValue>>>(&value).ok())
        .map(|values| {
            values
                .into_iter()
                .map(|value| value.get().to_owned())
                .collect()
        })
        .unwrap_or_default()
}

fn token_string(token: &str) -> Option<&str> {
    token.starts_with('"').then_some(token)
}

fn string_value(token: &str) -> Option<String> {
    serde_json::from_str::<String>(token).ok()
}

fn truthy(token: &str) -> bool {
    match token {
        "null" | "false" | "0" | "-0" | "\"\"" => false,
        _ => token
            .parse::<f64>()
            .map_or(true, |number| !number.is_nan() && number != 0.0),
    }
}

fn js_string(token: &str) -> Result<String, TranscriptError> {
    if has_noncallable_to_string(token) {
        return Err(TranscriptError(
            "TypeError: Cannot convert object to primitive value".into(),
        ));
    }
    if let Some(value) = string_value(token) {
        return Ok(value);
    }
    Ok(match token {
        "null" => "null".into(),
        "true" => "true".into(),
        "false" => "false".into(),
        _ if token.starts_with('{') => "[object Object]".into(),
        _ if token.starts_with('[') => array(token)
            .iter()
            .map(|value| {
                if value == "null" {
                    Ok(String::new())
                } else {
                    js_string(value)
                }
            })
            .collect::<Result<Vec<_>, _>>()?
            .join(","),
        _ => token.to_owned(),
    })
}

fn string_units(token: &str) -> Option<Vec<u16>> {
    let bytes = token.as_bytes();
    if bytes.len() < 2 || bytes[0] != b'"' || *bytes.last()? != b'"' {
        return None;
    }
    let mut units = Vec::new();
    let mut at = 1;
    while at < bytes.len() - 1 {
        if bytes[at] == b'\\' {
            at += 1;
            match *bytes.get(at)? {
                b'"' => units.push(b'"' as u16),
                b'\\' => units.push(b'\\' as u16),
                b'/' => units.push(b'/' as u16),
                b'b' => units.push(8),
                b'f' => units.push(12),
                b'n' => units.push(10),
                b'r' => units.push(13),
                b't' => units.push(9),
                b'u' => {
                    let end = at + 5;
                    let hex = std::str::from_utf8(bytes.get(at + 1..end)?).ok()?;
                    units.push(u16::from_str_radix(hex, 16).ok()?);
                    at = end - 1;
                }
                _ => return None,
            }
            at += 1;
        } else {
            let text = token.get(at..bytes.len() - 1)?;
            let ch = text.chars().next()?;
            units.extend(ch.encode_utf16(&mut [0; 2]).iter().copied());
            at += ch.len_utf8();
        }
    }
    Some(units)
}

fn quote_units(units: &[u16]) -> String {
    let mut out = String::from("\"");
    let mut at = 0;
    while at < units.len() {
        let unit = units[at];
        match unit {
            0x22 => out.push_str("\\\""),
            0x5c => out.push_str("\\\\"),
            0x08 => out.push_str("\\b"),
            0x0c => out.push_str("\\f"),
            0x0a => out.push_str("\\n"),
            0x0d => out.push_str("\\r"),
            0x09 => out.push_str("\\t"),
            0x00..=0x1f => out.push_str(&format!("\\u{unit:04x}")),
            0xd800..=0xdbff
                if at + 1 < units.len() && (0xdc00..=0xdfff).contains(&units[at + 1]) =>
            {
                let scalar = char::decode_utf16([unit, units[at + 1]])
                    .next()
                    .and_then(Result::ok)
                    .expect("a surrogate pair decodes");
                out.push(scalar);
                at += 1;
            }
            0xd800..=0xdfff => out.push_str(&format!("\\u{unit:04x}")),
            _ => out.push(char::from_u32(u32::from(unit)).expect("non-surrogate UTF-16 unit")),
        }
        at += 1;
    }
    out.push('"');
    out
}

fn js_string_units(token: &str) -> Vec<u16> {
    if let Some(units) = string_units(token) {
        return units;
    }
    match token {
        "null" => "null".encode_utf16().collect(),
        "true" => "true".encode_utf16().collect(),
        "false" => "false".encode_utf16().collect(),
        _ if token.starts_with('{') => "[object Object]".encode_utf16().collect(),
        _ if token.starts_with('[') => {
            let mut units = Vec::new();
            for (index, value) in array(token).iter().enumerate() {
                if index > 0 {
                    units.push(b',' as u16);
                }
                if value != "null" {
                    units.extend(js_string_units(value));
                }
            }
            units
        }
        _ => {
            let number = token.parse::<f64>().unwrap_or(f64::NAN);
            let text = if number.is_nan() {
                "NaN".to_owned()
            } else if number == f64::INFINITY {
                "Infinity".to_owned()
            } else if number == f64::NEG_INFINITY {
                "-Infinity".to_owned()
            } else {
                ryu_js::Buffer::new().format_finite(number).to_owned()
            };
            text.encode_utf16().collect()
        }
    }
}

fn property_key(token: &str) -> Result<String, TranscriptError> {
    if has_noncallable_to_string(token) {
        return Err(TranscriptError(
            "TypeError: Cannot convert object to primitive value".into(),
        ));
    }
    Ok(quote_units(&js_string_units(token)))
}

fn has_noncallable_to_string(token: &str) -> bool {
    if token.starts_with('{') {
        return get(&object(token), "toString").is_some();
    }
    token.starts_with('[')
        && array(token)
            .iter()
            .any(|item| has_noncallable_to_string(item))
}

fn js_parse_float_whitespace(c: char) -> bool {
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

fn parse_float(token: &str) -> Result<Option<f64>, TranscriptError> {
    let text = js_string(token)?;
    let text = text.trim_start_matches(js_parse_float_whitespace);
    if text.starts_with("-Infinity") {
        return Ok(Some(f64::NEG_INFINITY));
    }
    if text.starts_with("Infinity") || text.starts_with("+Infinity") {
        return Ok(Some(f64::INFINITY));
    }
    for end in (1..=text.len()).rev() {
        if text.is_char_boundary(end) {
            if let Ok(value) = text[..end].parse::<f64>() {
                // Rust accepts case-insensitive `inf`/`infinity`; JavaScript
                // parseFloat accepts only the exact `Infinity` spelling. Keep
                // numeric overflow (for example, 1e309) as infinity.
                if value.is_infinite() {
                    let candidate = &text[..end];
                    let unsigned = candidate
                        .strip_prefix('+')
                        .or_else(|| candidate.strip_prefix('-'))
                        .unwrap_or(candidate);
                    if unsigned
                        .get(..3)
                        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("inf"))
                    {
                        return Ok(None);
                    }
                }
                return Ok(Some(value));
            }
        }
    }
    Ok(None)
}

fn inum(token: Option<&str>) -> Result<f64, TranscriptError> {
    let Some(token) = token else { return Ok(0.0) };
    if token == "null" || token == "\"\"" {
        return Ok(0.0);
    }
    Ok(parse_float(token)?
        .filter(|value| !value.is_nan())
        .map_or(0.0, f64::trunc))
}

fn add_count(counts: &mut Vec<(JsonText, CountValue)>, key: &str) {
    if key == "\"__proto__\"" {
        return;
    }
    if let Some((_, count)) = counts
        .iter_mut()
        .find(|(candidate, _)| candidate.json_token() == key)
    {
        match count {
            CountValue::Number(value) => *value += 1.0,
            CountValue::String(value) => {
                value.0 = serde_json::to_string(&format!(
                    "{}1",
                    string_value(value.json_token()).unwrap_or_default()
                ))
                .unwrap();
            }
        }
    } else {
        let inherited = string_count_for_inherited(key);
        counts.push((
            JsonText::from_token(key),
            inherited.unwrap_or(CountValue::Number(1.0)),
        ));
    }
}

fn string_count_for_inherited(key: &str) -> Option<CountValue> {
    inherited_function_string(key).map(|text| {
        CountValue::String(JsonText::from_token(
            &serde_json::to_string(&format!("{text}1")).unwrap(),
        ))
    })
}

/// String form of the Object.prototype method a plain `{}` inherits for `key`.
fn inherited_function_string(key: &str) -> Option<String> {
    let name = string_value(key)?;
    let method = [
        "constructor",
        "__defineGetter__",
        "__defineSetter__",
        "hasOwnProperty",
        "__lookupGetter__",
        "__lookupSetter__",
        "isPrototypeOf",
        "propertyIsEnumerable",
        "toString",
        "valueOf",
        "toLocaleString",
    ];
    method.contains(&name.as_str()).then(|| {
        let function_name = if name == "constructor" {
            "Object"
        } else {
            &name
        };
        format!("function {function_name}() {{ [native code] }}")
    })
}

fn skill_tags_units(content: &[u16]) -> Vec<String> {
    let mut found = Vec::new();
    let open: Vec<u16> = "<command-name>/".encode_utf16().collect();
    let close: Vec<u16> = "</command-name>".encode_utf16().collect();
    let mut at = 0;
    while at + open.len() <= content.len() {
        let Some(offset) = content[at..].windows(open.len()).position(|w| w == open) else {
            break;
        };
        let start = at + offset + open.len();
        let mut end = start;
        while end < content.len()
            && (ascii_alphanumeric(content[end])
                || (content[end] <= 0x7f && b":_-".contains(&(content[end] as u8))))
        {
            end += 1;
        }
        let name = &content[start..end];
        let valid = name.first().is_some_and(|unit| ascii_alphanumeric(*unit))
            && content
                .get(end..end + close.len())
                .is_some_and(|value| value == close);
        if valid {
            let name = String::from_utf16(name).expect("skill names are ASCII");
            if !BUILTINS.contains(&name.as_str()) {
                found.push(name);
            }
            at = end + close.len();
        } else {
            // JavaScript's global regex resumes one UTF-16 code unit after a failed start.
            at = start - open.len() + 1;
        }
    }
    found
}

fn ascii_alphanumeric(unit: u16) -> bool {
    matches!(unit, 0x30..=0x39 | 0x41..=0x5a | 0x61..=0x7a)
}

fn skill_tags_token(token: &str) -> Vec<String> {
    string_units(token).map_or_else(Vec::new, |units| skill_tags_units(&units))
}

const BUILTINS: &[&str] = &[
    "add-dir",
    "agents",
    "bug",
    "clear",
    "compact",
    "config",
    "context",
    "copy",
    "cost",
    "dev",
    "doctor",
    "effort",
    "exit",
    "export",
    "fast",
    "get-started",
    "help",
    "hooks",
    "init",
    "login",
    "mcp",
    "memory",
    "model",
    "models",
    "permissions",
    "plugin",
    "plugins",
    "PR",
    "resume",
    "shortcuts",
    "status",
    "statusline",
    "terminal-setup",
    "voice",
    "workflows",
];

fn record_fields(line: &str) -> Result<Option<Vec<(String, String)>>, TranscriptError> {
    if line == "null" {
        return Err(TranscriptError("null transcript record".into()));
    }
    match entries(line) {
        Ok(fields) => Ok(Some(fields)),
        Err(_) => {
            // The general token parser is object-shaped; validate non-objects so
            // valid primitive/array JSON follows JavaScript property access.
            if serde_json::from_str::<Box<RawValue>>(line).is_ok() {
                Ok(None)
            } else {
                Ok(None)
            }
        }
    }
}

fn parse_file(
    text: &str,
    date_to_epoch: fn(&str) -> Option<f64>,
) -> Result<TranscriptTotals, TranscriptError> {
    let mut result = TranscriptTotals::default();
    let mut last_model_epoch = None;
    for line in text.split('\n') {
        let line = line.trim_matches(|c: char| {
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
        });
        if line.is_empty() {
            continue;
        }
        let Some(fields) = record_fields(line)? else {
            continue;
        };
        if get(&fields, "isSidechain") == Some("true") || get(&fields, "isMeta") == Some("true") {
            continue;
        }
        let facets = &mut result.facets;
        if get(&fields, "cwd").is_some_and(truthy) {
            facets.cwd = JsonText::from_token(get(&fields, "cwd").unwrap());
        }
        if get(&fields, "gitBranch").is_some_and(truthy) {
            facets.branch = JsonText::from_token(get(&fields, "gitBranch").unwrap());
        }
        if get(&fields, "isCompactSummary") == Some("true") {
            facets.compactions += 1.0;
        }
        let timestamp = get(&fields, "timestamp");
        let ts = if timestamp.is_some_and(truthy) {
            match timestamp.and_then(string_value) {
                Some(value) => date_to_epoch(&value),
                // Date rejects strings containing an unpaired surrogate; decoding only fails
                // here for such raw JSON string tokens, after JS `.replace` would succeed.
                None if timestamp.is_some_and(|value| value.starts_with('"')) => None,
                None => {
                    return Err(TranscriptError(
                        "TypeError: s.replace is not a function".into(),
                    ));
                }
            }
        } else {
            None
        };
        if let Some(ts) = ts.filter(|value| *value != 0.0) {
            result.end_epoch = Some(result.end_epoch.map_or(ts, |old| old.max(ts)));
            result.start_epoch = Some(result.start_epoch.map_or(ts, |old| old.min(ts)));
        }
        let typ = get(&fields, "type").and_then(string_value);
        if typ.as_deref() == Some("user") {
            let msg = object(
                get(&fields, "message")
                    .filter(|value| value.starts_with('{'))
                    .unwrap_or("{}"),
            );
            let content = get(&msg, "content").unwrap_or("null");
            let blocks = array(content);
            if token_string(content).is_some()
                || blocks
                    .iter()
                    .any(|block| get(&object(block), "type") == Some("\"text\""))
            {
                result.turns += 1.0;
            }
            for block in &blocks {
                let block = object(block);
                if get(&block, "type") == Some("\"tool_result\"")
                    && get(&block, "is_error").is_some_and(truthy)
                {
                    facets.tool_errors += 1.0;
                }
            }
            if token_string(content).is_some() {
                for skill in skill_tags_token(content) {
                    add_count(
                        &mut facets.skills,
                        &format!("{}", serde_json::to_string(&skill).unwrap()),
                    );
                }
            } else {
                for block in blocks
                    .iter()
                    .filter_map(|token| get(&object(token), "text").map(str::to_owned))
                {
                    for skill in skill_tags_token(&block) {
                        add_count(&mut facets.skills, &serde_json::to_string(&skill).unwrap());
                    }
                }
            }
            continue;
        }
        if typ.as_deref() != Some("assistant") {
            continue;
        }
        let msg = object(
            get(&fields, "message")
                .filter(|value| value.starts_with('{'))
                .unwrap_or("{}"),
        );
        let content = array(get(&msg, "content").unwrap_or("null"));
        for block in content {
            let block = object(&block);
            if get(&block, "type") != Some("\"tool_use\"") {
                continue;
            }
            result.tool_calls += 1.0;
            let name = get(&block, "name")
                .filter(|value| truthy(value))
                .unwrap_or("\"?\"");
            add_count(&mut facets.tools, &property_key(name)?);
            let input = object(
                get(&block, "input")
                    .filter(|value| value.starts_with('{'))
                    .unwrap_or("{}"),
            );
            if name == "\"Agent\"" {
                add_count(
                    &mut facets.agents,
                    get(&input, "subagent_type")
                        .filter(|value| truthy(value))
                        .map(|value| property_key(value))
                        .transpose()?
                        .as_deref()
                        .unwrap_or("\"general-purpose\""),
                );
            } else if name == "\"Skill\"" {
                add_count(
                    &mut facets.skills,
                    get(&input, "command")
                        .filter(|value| truthy(value))
                        .or_else(|| get(&input, "skill").filter(|value| truthy(value)))
                        .map(|value| property_key(value))
                        .transpose()?
                        .as_deref()
                        .unwrap_or("\"?\""),
                );
            }
        }
        let usage = object(
            get(&msg, "usage")
                .filter(|value| value.starts_with('{'))
                .unwrap_or("{}"),
        );
        let i = inum(get(&usage, "input_tokens"))?;
        let o = inum(get(&usage, "output_tokens"))?;
        let cr = inum(get(&usage, "cache_read_input_tokens"))?;
        let cc = inum(get(&usage, "cache_creation_input_tokens"))?;
        let model = get(&msg, "model").unwrap_or("null");
        if model == "\"<synthetic>\"" || (i == 0.0 && o == 0.0 && cr == 0.0 && cc == 0.0) {
            continue;
        }
        result.input_tokens += i;
        result.output_tokens += o;
        result.cache_read_tokens += cr;
        result.cache_creation_tokens += cc;
        if truthy(model) {
            if ts.is_some() && (last_model_epoch.is_none() || ts >= last_model_epoch) {
                last_model_epoch = ts;
                result.last_model = JsonText::from_token(model);
            }
        }
    }
    Ok(result)
}

pub fn parse_transcript_text(
    text: &str,
    date_to_epoch: fn(&str) -> Option<f64>,
) -> Result<TranscriptTotals, TranscriptError> {
    parse_file(text, date_to_epoch)
}

pub fn session_totals(
    main: Option<&str>,
    nested: &[&str],
    date_to_epoch: fn(&str) -> Option<f64>,
) -> Result<TranscriptTotals, TranscriptError> {
    let mut total = match main {
        Some(text) => parse_file(text, date_to_epoch)?,
        None => TranscriptTotals::default(),
    };
    for text in nested {
        let child = parse_file(text, date_to_epoch)?;
        total.input_tokens += child.input_tokens;
        total.output_tokens += child.output_tokens;
        total.cache_read_tokens += child.cache_read_tokens;
        total.cache_creation_tokens += child.cache_creation_tokens;
        total.turns += child.turns;
        total.tool_calls += child.tool_calls;
        merge_counts(&mut total.facets.tools, child.facets.tools);
        merge_counts(&mut total.facets.agents, child.facets.agents);
        merge_counts(&mut total.facets.skills, child.facets.skills);
        total.facets.tool_errors += child.facets.tool_errors;
        total.facets.compactions += child.facets.compactions;
        if !truthy(total.facets.cwd.json_token()) {
            total.facets.cwd = child.facets.cwd;
        }
        if !truthy(total.facets.branch.json_token()) {
            total.facets.branch = child.facets.branch;
        }
        if let Some(epoch) = child.end_epoch {
            total.end_epoch = Some(total.end_epoch.map_or(epoch, |old| old.max(epoch)));
        }
        if let Some(epoch) = child.start_epoch {
            total.start_epoch = Some(total.start_epoch.map_or(epoch, |old| old.min(epoch)));
        }
    }
    Ok(total)
}

fn js_number(value: f64) -> String {
    if value.is_finite() {
        ryu_js::Buffer::new().format_finite(value).to_owned()
    } else {
        "null".into()
    }
}

fn merge_counts(target: &mut Vec<(JsonText, CountValue)>, additions: Vec<(JsonText, CountValue)>) {
    for (key, count) in additions {
        if let Some((_, current)) = target
            .iter_mut()
            .find(|(old, _)| old.json_token() == key.json_token())
        {
            match (current, count) {
                (CountValue::Number(left), CountValue::Number(right)) => *left += right,
                (left @ CountValue::Number(_), CountValue::String(right)) => {
                    *left = CountValue::String(JsonText::from_token(
                        &serde_json::to_string(&format!(
                            "{}{}",
                            match left {
                                CountValue::Number(n) => js_number(*n),
                                _ => unreachable!(),
                            },
                            string_value(right.json_token()).unwrap_or_default()
                        ))
                        .unwrap(),
                    ))
                }
                (CountValue::String(left), CountValue::Number(right)) => {
                    left.0 = serde_json::to_string(&format!(
                        "{}{}",
                        string_value(left.json_token()).unwrap_or_default(),
                        js_number(right)
                    ))
                    .unwrap()
                }
                (CountValue::String(left), CountValue::String(right)) => {
                    left.0 = serde_json::to_string(&format!(
                        "{}{}",
                        string_value(left.json_token()).unwrap_or_default(),
                        string_value(right.json_token()).unwrap_or_default()
                    ))
                    .unwrap()
                }
            }
        } else {
            // JS `(a[name] || 0) + n`: an absent inherited name reads the prototype function.
            let count = match count {
                CountValue::String(value) => CountValue::String(JsonText::from_token(
                    &serde_json::to_string(&format!(
                        "{}{}",
                        inherited_function_string(key.json_token()).unwrap_or_else(|| "0".into()),
                        string_value(value.json_token()).unwrap_or_default()
                    ))
                    .unwrap(),
                )),
                value => value,
            };
            target.push((key, count));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    use std::process::Command;

    fn epoch(value: &str) -> Option<f64> {
        value.parse().ok()
    }

    #[test]
    fn aggregates_main_and_nested_transcript_rows() {
        let main = r#"{"type":"assistant","timestamp":"1","message":{"model":"model-a","usage":{"input_tokens":"12.9x","output_tokens":3},"content":[{"type":"tool_use","name":"Read"}]}}"#;
        let nested = r#"{"type":"assistant","timestamp":"2","message":{"model":"model-b","usage":{"input_tokens":2},"content":[]}}"#;
        let totals = session_totals(Some(main), &[nested], epoch).unwrap();
        assert_eq!(totals.input_tokens, 14.0);
        assert_eq!(totals.last_model.json_token(), "\"model-a\"");
        assert_eq!(totals.facets.tools[0].0.json_token(), "\"Read\"");
        assert_eq!(totals.tool_calls, 1.0);
    }

    #[test]
    fn nested_inherited_name_absent_from_main_reads_prototype_function() {
        let nested =
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"toString"}]}}"#;
        let totals = session_totals(None, &[nested], epoch).unwrap();
        let native = "function toString() { [native code] }";
        assert_eq!(
            totals.facets.tools[0].1,
            CountValue::String(JsonText::from_token(
                &serde_json::to_string(&format!("{native}{native}1")).unwrap()
            ))
        );
    }

    #[test]
    fn duplicate_fields_last_wins_and_surrogate_keys_do_not_break_objects() {
        let text = r#"{"ignored\ud83d":{"value":"\ud83d"},"type":"user","type":"assistant","message":{"usage":{"input_tokens":1,"input_tokens":7},"model":"m","content":[]}}"#;
        let totals = parse_transcript_text(text, epoch).unwrap();
        assert_eq!(totals.input_tokens, 7.0);
        let surfaced = JsonText::from_token(r#""\ud83d""#);
        assert_eq!(surfaced.raw_value().unwrap().get(), r#""\ud83d""#);
    }

    #[test]
    fn malformed_rows_skip_but_null_is_an_error() {
        let totals = parse_transcript_text(
            "garbage\n{\"type\":\"user\",\"message\":{\"content\":\"\"}}",
            epoch,
        )
        .unwrap();
        assert_eq!(totals.turns, 1.0);
        assert!(parse_transcript_text("null", epoch).is_err());
        assert!(!truthy("NaN"));
        assert!(!truthy("-0.0"));
        assert!(truthy("[]"));
        assert!(truthy("{}"));
    }

    #[test]
    fn shared_node_oracle_fixture_expected_totals() {
        let main = include_str!("../tests/fixtures/usage_report_transcript_main.jsonl");
        let nested = include_str!("../tests/fixtures/usage_report_transcript_nested.jsonl");
        let totals = session_totals(Some(main), &[nested], |_| Some(1.0)).unwrap();
        assert_eq!(totals.input_tokens, 22.0);
        assert_eq!(totals.output_tokens, 7.0);
        assert_eq!(totals.cache_read_tokens, 1.0);
        assert_eq!(totals.cache_creation_tokens, 5.0);
        assert_eq!(totals.turns, 1.0);
        assert_eq!(totals.tool_calls, 30.0);
        assert_eq!(totals.facets.compactions, 1.0);
        assert_eq!(totals.facets.tool_errors, 1.0);
        assert_eq!(totals.facets.skills[0].0.json_token(), "\"custom-skill\"");
        assert_eq!(totals.facets.cwd.json_token(), r#""\ud83d""#);
    }

    fn count_json(value: &CountValue) -> String {
        match value {
            CountValue::Number(number) => js_number(*number),
            CountValue::String(text) => raw_json(text),
        }
    }

    fn js_index(token: &str) -> Option<u32> {
        let value = string_value(token)?;
        let index = value.parse::<u32>().ok()?;
        (index != u32::MAX && index.to_string() == value).then_some(index)
    }

    fn raw_json(value: &JsonText) -> String {
        value.raw_value().unwrap().get().to_owned()
    }

    fn facets_json(items: &[(JsonText, CountValue)]) -> String {
        let mut indexed = Vec::new();
        let mut strings = Vec::new();
        for (position, (key, count)) in items.iter().enumerate() {
            if let Some(index) = js_index(key.json_token()) {
                indexed.push((index, position, key, count));
            } else {
                strings.push((position, key, count));
            }
        }
        indexed.sort_by_key(|(index, _, _, _)| *index);
        let mut fields = indexed
            .into_iter()
            .map(|(_, _, key, count)| format!("{}:{}", raw_json(key), count_json(count)))
            .collect::<Vec<_>>();
        fields.extend(
            strings
                .into_iter()
                .map(|(_, key, count)| format!("{}:{}", raw_json(key), count_json(count))),
        );
        format!("{{{}}}", fields.join(","))
    }

    fn totals_json(totals: &TranscriptTotals) -> String {
        let epoch = |value: Option<f64>| value.map_or_else(|| "null".into(), js_number);
        let fields = [
            format!("\"last_model\":{}", raw_json(&totals.last_model)),
            format!("\"input_tokens\":{}", js_number(totals.input_tokens)),
            format!("\"output_tokens\":{}", js_number(totals.output_tokens)),
            format!(
                "\"cache_read_tokens\":{}",
                js_number(totals.cache_read_tokens)
            ),
            format!(
                "\"cache_creation_tokens\":{}",
                js_number(totals.cache_creation_tokens)
            ),
            format!("\"end_epoch\":{}", epoch(totals.end_epoch)),
            format!("\"start_epoch\":{}", epoch(totals.start_epoch)),
            format!("\"turns\":{}", js_number(totals.turns)),
            format!("\"tool_calls\":{}", js_number(totals.tool_calls)),
            format!(
                "\"facets\":{{\"tools\":{},\"tool_errors\":{},\"agents\":{},\
                 \"skills\":{},\"compactions\":{},\"cwd\":{},\"branch\":{}}}",
                facets_json(&totals.facets.tools),
                js_number(totals.facets.tool_errors),
                facets_json(&totals.facets.agents),
                facets_json(&totals.facets.skills),
                js_number(totals.facets.compactions),
                raw_json(&totals.facets.cwd),
                raw_json(&totals.facets.branch),
            ),
        ];
        format!("{{{}}}", fields.join(","))
    }

    fn compare_json(actual: &str, expected: &str, path: &str) {
        if actual.starts_with('{') && expected.starts_with('{') {
            let actual_fields = entries(actual).unwrap();
            let expected_fields = entries(expected).unwrap();
            assert_eq!(actual_fields.len(), expected_fields.len(), "{path} keys");
            for ((actual_key, actual_value), (expected_key, expected_value)) in
                actual_fields.iter().zip(&expected_fields)
            {
                assert_eq!(actual_key, expected_key, "{path} key order");
                compare_json(actual_value, expected_value, actual_key);
            }
        } else if actual.starts_with('[') && expected.starts_with('[') {
            let actual_values = array(actual);
            let expected_values = array(expected);
            assert_eq!(actual_values.len(), expected_values.len(), "{path} length");
            for (index, (actual_value, expected_value)) in
                actual_values.iter().zip(&expected_values).enumerate()
            {
                compare_json(actual_value, expected_value, &format!("{path}[{index}]"));
            }
        } else {
            assert_eq!(actual, expected, "{path} type/value");
        }
    }

    fn run_node_oracle(case: &str) -> String {
        let binary = std::env::var_os("NODE_BINARY")
            .expect("NODE_BINARY must name an absolute Node executable for the parity test");
        let binary = Path::new(&binary);
        assert!(binary.is_absolute(), "NODE_BINARY must be absolute");
        let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
        let oracle = manifest.join("tests/usage_report_transcript_oracle.mjs");
        let temp = std::env::temp_dir().join(format!("usage-report-oracle-{}", std::process::id()));
        std::fs::create_dir_all(&temp).unwrap();
        let mut command = Command::new(binary);
        command.arg(oracle).env_clear();
        command.arg(format!("--{case}-case"));
        for name in ["SystemRoot", "WINDIR", "SystemDrive", "ComSpec", "PATH"] {
            if let Some(value) = std::env::var_os(name) {
                command.env(name, value);
            }
        }
        command
            .env("HOME", &temp)
            .env("USERPROFILE", &temp)
            .env("PROFILE", &temp)
            .env("APPDATA", &temp)
            .env("TEMP", &temp)
            .env("TMP", &temp)
            .env("TMPDIR", &temp);
        let output = command.output().expect("launch source-bound Node oracle");
        assert!(
            output.status.success(),
            "Node oracle failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap().trim().to_owned()
    }

    fn fixture_epoch(value: &str) -> Option<f64> {
        match value {
            "2024-01-01T00:00:01Z" => Some(1_704_067_201.0),
            "2024-01-01T00:00:02Z" => Some(1_704_067_202.0),
            "2024-01-01T00:00:03Z" => Some(1_704_067_203.0),
            "2024-01-01T00:00:04Z" => Some(1_704_067_204.0),
            "2024-01-01T00:00:05Z" => Some(1_704_067_205.0),
            "2024-01-01T00:00:06Z" => Some(1_704_067_206.0),
            "1970-01-01T00:00:00Z" => Some(0.0),
            _ => None,
        }
    }

    #[test]
    fn rust_totals_match_source_bound_node_vm_recursively() {
        let main = include_str!("../tests/fixtures/usage_report_transcript_main.jsonl");
        let nested = include_str!("../tests/fixtures/usage_report_transcript_nested.jsonl");
        let rust_totals = session_totals(Some(main), &[nested], fixture_epoch).unwrap();
        let rust_json = totals_json(&rust_totals);
        let node_json = run_node_oracle("normal");
        compare_json(&node_json, &rust_json, "result");
    }

    #[test]
    fn null_record_error_matches_source_bound_node_vm() {
        let null_text = include_str!("../tests/fixtures/usage_report_transcript_null.jsonl");
        assert!(session_totals(Some(null_text), &[], fixture_epoch).is_err());
        let node_json = run_node_oracle("null");
        let fields = entries(&node_json).unwrap();
        assert_eq!(get(&fields, "oracle_error"), Some("\"TypeError\""));
    }

    #[test]
    fn prototype_coercion_errors_match_source_bound_node_vm() {
        let text = include_str!("../tests/fixtures/usage_report_transcript_type_error.jsonl");
        let error = session_totals(Some(text), &[], fixture_epoch).unwrap_err();
        assert!(error.0.starts_with("TypeError:"));
        let node_json = run_node_oracle("type-error");
        let fields = entries(&node_json).unwrap();
        assert_eq!(get(&fields, "oracle_error"), Some("\"TypeError\""));
    }

    #[test]
    fn truthy_non_string_timestamps_match_source_type_error() {
        let text = include_str!("../tests/fixtures/usage_report_transcript_timestamp-error.jsonl");
        assert!(
            parse_transcript_text(text, fixture_epoch)
                .unwrap_err()
                .0
                .starts_with("TypeError:")
        );
        let node_json = run_node_oracle("timestamp-error");
        assert_eq!(
            get(&entries(&node_json).unwrap(), "oracle_error"),
            Some("\"TypeError\"")
        );
        let falsey = "{\"type\":\"user\",\"timestamp\":0,\"message\":{\"content\":\"x\"}}";
        assert_eq!(
            parse_transcript_text(falsey, fixture_epoch).unwrap().turns,
            1.0
        );
    }

    #[test]
    fn object_and_nested_array_token_coercions_match_source_type_errors() {
        for (text, case) in [
            (
                include_str!("../tests/fixtures/usage_report_transcript_inum-object-error.jsonl"),
                "inum-object-error",
            ),
            (
                include_str!("../tests/fixtures/usage_report_transcript_inum-array-error.jsonl"),
                "inum-array-error",
            ),
        ] {
            assert!(
                parse_transcript_text(text, fixture_epoch)
                    .unwrap_err()
                    .0
                    .starts_with("TypeError:")
            );
            let node_json = run_node_oracle(case);
            assert_eq!(
                get(&entries(&node_json).unwrap(), "oracle_error"),
                Some("\"TypeError\"")
            );
        }
    }

    #[test]
    fn model_update_uses_javascript_truthiness_and_preserves_raw_types() {
        let text = include_str!("../tests/fixtures/usage_report_transcript_model-truthiness.jsonl");
        let totals = parse_transcript_text(text, fixture_epoch).unwrap();
        assert_eq!(totals.input_tokens, 6.0);
        assert_eq!(totals.last_model.json_token(), "5");
        assert_eq!(run_node_oracle("model-truthiness"), totals_json(&totals));
    }

    #[test]
    fn skill_scanning_preserves_lone_surrogates_and_retries_overlapping_regex_starts() {
        let surrogate =
            include_str!("../tests/fixtures/usage_report_transcript_surrogate-skill.jsonl");
        let overlap =
            include_str!("../tests/fixtures/usage_report_transcript_overlapping-skill.jsonl");
        for (text, case) in [
            (surrogate, "surrogate-skill"),
            (overlap, "overlapping-skill"),
        ] {
            let totals = parse_transcript_text(text, fixture_epoch).unwrap();
            if case == "surrogate-skill" {
                assert_eq!(totals.facets.skills.len(), 2);
                assert_eq!(totals.facets.skills[0].0.json_token(), "\"foo\"");
                assert_eq!(totals.facets.skills[1].0.json_token(), "\"bar\"");
            } else {
                assert_eq!(totals.facets.skills.len(), 1);
                assert_eq!(totals.facets.skills[0].0.json_token(), "\"foo\"");
            }
            assert_eq!(run_node_oracle(case), totals_json(&totals));
        }
    }

    #[test]
    fn parse_float_trims_javascript_bom_whitespace() {
        let text = include_str!("../tests/fixtures/usage_report_transcript_feff-inum.jsonl");
        let totals = parse_transcript_text(text, fixture_epoch).unwrap();
        assert_eq!(totals.input_tokens, 4.0);
        assert_eq!(run_node_oracle("feff-inum"), totals_json(&totals));
    }

    #[test]
    fn parse_float_matches_javascript_infinity_and_numeric_prefix_grammar() {
        let cases = [
            ("\"Infinity\"", Some(f64::INFINITY)),
            ("\"+Infinity\"", Some(f64::INFINITY)),
            ("\"-Infinity\"", Some(f64::NEG_INFINITY)),
            ("\"Infinityx\"", Some(f64::INFINITY)),
            ("\"+Infinityx\"", Some(f64::INFINITY)),
            ("\"-Infinityx\"", Some(f64::NEG_INFINITY)),
            ("\"infinity\"", None),
            ("\"inf\"", None),
            ("\"12.9x\"", Some(12.9)),
            ("\"1e309\"", Some(f64::INFINITY)),
            ("\"-1e309\"", Some(f64::NEG_INFINITY)),
            ("\"1e309x\"", Some(f64::INFINITY)),
        ];
        for (token, expected) in cases {
            assert_eq!(parse_float(token).unwrap(), expected, "{token}");
        }
        let expected = [
            "Infinity",
            "Infinity",
            "-Infinity",
            "Infinity",
            "Infinity",
            "-Infinity",
            "0",
            "0",
            "12",
            "Infinity",
            "-Infinity",
            "Infinity",
        ];
        let oracle: Vec<String> =
            serde_json::from_str(&run_node_oracle("parsefloat-grammar")).unwrap();
        assert_eq!(oracle, expected);
    }
}
