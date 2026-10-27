//! Port of server/usage-history.mjs (GET /api/usage/history): the current 5h or
//! 7d window's account % readings per provider plus, for Claude and Codex 5h, an
//! ESTIMATED per-session split of each interval's rise by cost share. Read-only.
//! The caller (Node) resolves every root: usage-report state dir, pricing.json,
//! <CLAUDE_CONFIG_DIR>/projects and <CODEX_HOME>/sessions.
use serde_json::Value;
use serde_json::value::RawValue;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};

const TAIL_BYTES: u64 = 2 * 1024 * 1024;
// shortcut: 7d reads the last 8MB, as in Node; raise it if sampling gets denser.
const WEEK_TAIL_BYTES: u64 = 8 * 1024 * 1024;
const WEEK_BUCKET_MS: f64 = 15.0 * 60.0 * 1000.0;
const MAX_SERIES: usize = 8;
const UNATTRIBUTED: &str = "_unattributed";
const OTHER: &str = "_other";
const DAY_MS: f64 = 86_400_000.0;

pub struct Params<'a> {
    pub provider: &'a str,
    pub window: &'a str,
    pub now_ms: f64,
    pub state_dir: &'a str,
    pub pricing_path: &'a str,
    pub claude_projects: &'a str,
    pub codex_sessions: &'a str,
}

#[derive(Clone)]
struct Point {
    t: f64,
    pct: f64,
    resets_at: Option<f64>,
}

#[derive(Clone)]
struct Event {
    t: f64,
    model: Vec<u16>,
    tok: [f64; 4],
    usd: Option<f64>,
    coercion_error: bool,
    conversion_throws_immediately: bool,
}

struct ClaudeTranscript {
    cwd: Option<Vec<u16>>,
    events: Vec<Event>,
}

struct CodexRollout {
    id: Option<Vec<u16>>,
    cwd: Option<Vec<u16>>,
    events: Vec<Event>,
    models: Vec<(f64, Vec<u16>)>,
}

/// Insertion-ordered map: JS Map iteration order decides series ranking ties.
struct OMap<V> {
    idx: HashMap<String, usize>,
    entries: Vec<(String, V)>,
}

impl<V> OMap<V> {
    fn new() -> Self {
        Self {
            idx: HashMap::new(),
            entries: Vec::new(),
        }
    }
    fn get(&self, key: &str) -> Option<&V> {
        self.idx.get(key).map(|&i| &self.entries[i].1)
    }
    fn get_mut(&mut self, key: &str) -> Option<&mut V> {
        self.idx.get(key).map(|&i| &mut self.entries[i].1)
    }
    fn get_or_insert_with(&mut self, key: &str, make: impl FnOnce() -> V) -> &mut V {
        let i = match self.idx.get(key) {
            Some(&i) => i,
            None => {
                self.entries.push((key.to_owned(), make()));
                self.idx.insert(key.to_owned(), self.entries.len() - 1);
                self.entries.len() - 1
            }
        };
        &mut self.entries[i].1
    }
}

fn window_ms(window: &str) -> Option<f64> {
    match window {
        "5h" => Some(5.0 * 3.6e6),
        "7d" => Some(7.0 * DAY_MS),
        _ => None,
    }
}

fn totals_file(provider: &str) -> Option<&'static str> {
    match provider {
        "claude" => Some("usage-snapshots.jsonl"),
        "codex" => Some("codex-usage.jsonl"),
        "ollama" => Some("ollama-usage.jsonl"),
        _ => None,
    }
}

fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// `Number.isFinite(v)`: only real numbers.
fn finite(value: Option<&Value>) -> Option<f64> {
    value.and_then(Value::as_f64).filter(|n| n.is_finite())
}

/// `v ?? 0` used arithmetically, with JS Number coercion for strings and booleans.
fn num_or_zero(value: Option<&Value>) -> f64 {
    match value {
        None | Some(Value::Null) => 0.0,
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(s)) => js_number(s),
        Some(Value::Bool(b)) => u8::from(*b) as f64,
        Some(Value::Array(values)) => js_number(&js_array_string(values)),
        Some(_) => f64::NAN,
    }
}

fn js_number(value: &str) -> f64 {
    let value = value.trim_matches(js_whitespace);
    if value.is_empty() {
        0.0
    } else if value == "Infinity" || value == "+Infinity" {
        f64::INFINITY
    } else if value == "-Infinity" {
        f64::NEG_INFINITY
    } else if let Some(digits) = value
        .strip_prefix("0x")
        .or_else(|| value.strip_prefix("0X"))
    {
        js_radix_number(digits, 16)
    } else if let Some(digits) = value
        .strip_prefix("0b")
        .or_else(|| value.strip_prefix("0B"))
    {
        js_radix_number(digits, 2)
    } else if let Some(digits) = value
        .strip_prefix("0o")
        .or_else(|| value.strip_prefix("0O"))
    {
        js_radix_number(digits, 8)
    } else {
        if !valid_js_decimal(value) {
            return f64::NAN;
        }
        value.parse::<f64>().unwrap_or(f64::NAN)
    }
}

fn js_radix_number(digits: &str, radix: u32) -> f64 {
    if digits.is_empty() {
        return f64::NAN;
    }
    let width = radix.trailing_zeros() as usize;
    let mut bits = Vec::with_capacity(digits.len() * width);
    for ch in digits.chars() {
        let Some(digit) = ch.to_digit(radix) else {
            return f64::NAN;
        };
        for shift in (0..width).rev() {
            bits.push(((digit >> shift) & 1) as u8);
        }
    }
    let first = bits.iter().position(|bit| *bit != 0).unwrap_or(bits.len());
    if first == bits.len() {
        return 0.0;
    }
    let significant = &bits[first..];
    let shift = significant.len().saturating_sub(53);
    if shift > 1024 {
        return f64::INFINITY;
    }
    let mut top = significant
        .iter()
        .take(53)
        .fold(0u64, |n, bit| (n << 1) | u64::from(*bit));
    if shift > 0 {
        let guard = significant[52] != 0;
        let sticky = significant[53..].iter().any(|bit| *bit != 0);
        if guard && (sticky || top & 1 == 1) {
            top += 1;
        }
    }
    (top as f64) * 2.0f64.powi(shift as i32)
}

fn js_whitespace(ch: char) -> bool {
    matches!(ch, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' |
        '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' |
        '\u{205f}' | '\u{3000}' | '\u{feff}')
}

fn valid_js_decimal(value: &str) -> bool {
    let bytes = value.as_bytes();
    let mut i = usize::from(matches!(bytes.first(), Some(b'+' | b'-')));
    let integer_start = i;
    while bytes.get(i).is_some_and(u8::is_ascii_digit) {
        i += 1;
    }
    let has_integer = i > integer_start;
    if bytes.get(i) == Some(&b'.') {
        i += 1;
        let fraction_start = i;
        while bytes.get(i).is_some_and(u8::is_ascii_digit) {
            i += 1;
        }
        if !has_integer && i == fraction_start {
            return false;
        }
    } else if !has_integer {
        return false;
    }
    if matches!(bytes.get(i), Some(b'e' | b'E')) {
        i += 1;
        if matches!(bytes.get(i), Some(b'+' | b'-')) {
            i += 1;
        }
        let exponent_start = i;
        while bytes.get(i).is_some_and(u8::is_ascii_digit) {
            i += 1;
        }
        if i == exponent_start {
            return false;
        }
    }
    i == bytes.len()
}

fn js_array_string(values: &[Value]) -> String {
    values
        .iter()
        .map(|value| match value {
            Value::Null => String::new(),
            Value::String(s) => s.clone(),
            Value::Array(items) => js_array_string(items),
            Value::Object(_) => "[object Object]".to_owned(),
            Value::Number(n) => n.as_f64().map(js_number_string).unwrap_or_default(),
            Value::Bool(b) => b.to_string(),
            _ => String::new(),
        })
        .collect::<Vec<_>>()
        .join(",")
}

fn js_number_string(value: f64) -> String {
    if !value.is_finite() {
        return if value.is_nan() {
            "NaN".into()
        } else if value.is_sign_negative() {
            "-Infinity".into()
        } else {
            "Infinity".into()
        };
    }
    ryu_js::Buffer::new().format_finite(value).to_owned()
}

fn array_conversion_error(value: &Value) -> bool {
    match value {
        Value::Array(items) => items.iter().any(number_conversion_error),
        _ => false,
    }
}

fn number_conversion_error(value: &Value) -> bool {
    match value {
        Value::Object(object) => object.contains_key("toString"),
        Value::Array(_) => array_conversion_error(value),
        _ => false,
    }
}

fn token_conversion_error(value: Option<&Value>) -> bool {
    value.is_some_and(number_conversion_error)
}

fn parse_json_value(text: &str) -> Option<Value> {
    if let Ok(value) = serde_json::from_str::<Value>(text) {
        return Some(value);
    }
    // JSON.parse accepts escaped unpaired UTF-16 surrogates; serde_json::Value
    // cannot represent them. Keep the row and its arithmetic fields readable.
    let _: Box<RawValue> = serde_json::from_str(text).ok()?;
    let bytes = text.as_bytes();
    let mut repaired = String::with_capacity(text.len());
    let mut cursor = 0;
    while cursor < bytes.len() {
        if bytes.get(cursor) == Some(&b'\\')
            && bytes.get(cursor + 1).is_some_and(|next| {
                matches!(next, b'\\' | b'"' | b'/' | b'b' | b'f' | b'n' | b'r' | b't')
            })
        {
            repaired.push_str(&text[cursor..cursor + 2]);
            cursor += 2;
            continue;
        }
        if bytes.get(cursor..cursor + 2) == Some(b"\\u")
            && bytes
                .get(cursor + 2..cursor + 6)
                .is_some_and(|hex| hex.iter().all(u8::is_ascii_hexdigit))
        {
            let unit = u16::from_str_radix(&text[cursor + 2..cursor + 6], 16).ok()?;
            if (0xd800..=0xdfff).contains(&unit) {
                let paired = (0xd800..=0xdbff).contains(&unit)
                    && bytes.get(cursor + 6..cursor + 8) == Some(b"\\u")
                    && bytes.get(cursor + 8..cursor + 12).is_some_and(|hex| {
                        hex.iter().all(u8::is_ascii_hexdigit)
                            && u16::from_str_radix(&text[cursor + 8..cursor + 12], 16)
                                .is_ok_and(|next| (0xdc00..=0xdfff).contains(&next))
                    });
                if paired {
                    repaired.push_str(&text[cursor..cursor + 12]);
                    cursor += 12;
                    continue;
                }
                repaired.push_str("\\ufffd");
                cursor += 6;
                continue;
            }
        }
        let ch = text[cursor..].chars().next()?;
        repaired.push(ch);
        cursor += ch.len_utf8();
    }
    serde_json::from_str(&repaired).ok()
}

/// `Math.max(a, b)`: NaN wins, unlike f64::max.
fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.max(b)
    }
}

/// `Date.parse(v)` with JS ToString coercion; NaN when invalid or undefined.
fn js_date(value: Option<&Value>) -> f64 {
    let Some(value) = value else { return f64::NAN };
    let Ok(raw) = serde_json::value::to_raw_value(value) else {
        return f64::NAN;
    };
    crate::usage_snapshot::parse_fetched_at(&raw).map_or(f64::NAN, |ms| ms as f64)
}

fn js_date_checked(value: Option<&Value>) -> Result<f64, String> {
    if value.is_some_and(|value| {
        value
            .as_object()
            .is_some_and(|object| object.contains_key("toString"))
    }) {
        return Err("Cannot convert object to primitive value".into());
    }
    Ok(js_date(value))
}

/// `Math.round(n * 100) / 100` (ties toward +Infinity).
fn round2(n: f64) -> f64 {
    let x = n * 100.0;
    let f = x.floor();
    (if x - f >= 0.5 { f + 1.0 } else { f }) / 100.0
}

/// JSON.stringify of a number.
fn js_num(n: f64) -> String {
    if !n.is_finite() {
        "null".into()
    } else if n == 0.0 {
        "0".into()
    } else {
        ryu_js::Buffer::new().format_finite(n).to_owned()
    }
}

fn js_str(s: &str) -> String {
    serde_json::to_string(s).expect("string serialization is infallible")
}

fn js_str_units(units: &[u16]) -> String {
    let mut out = String::from("\"");
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
            out.push(char::from_u32(scalar).expect("valid UTF-16 pair"));
            index += 2;
            continue;
        }
        match unit {
            0x0022 => out.push_str("\\\""),
            0x005c => out.push_str("\\\\"),
            0x0008 => out.push_str("\\b"),
            0x000c => out.push_str("\\f"),
            0x000a => out.push_str("\\n"),
            0x000d => out.push_str("\\r"),
            0x0009 => out.push_str("\\t"),
            0x0000..=0x001f | 0xd800..=0xdfff => {
                use std::fmt::Write as _;
                write!(&mut out, "\\u{unit:04x}").expect("writing to String");
            }
            _ => out.push(char::from_u32(unit as u32).expect("non-surrogate UTF-16 unit")),
        }
        index += 1;
    }
    out.push('\"');
    out
}

/// `new Date(t).toISOString()`; Err where JS throws RangeError.
fn iso(t: f64) -> Result<String, String> {
    let t = t.trunc();
    if !t.is_finite() || t.abs() > 8.64e15 {
        return Err("Invalid time value".into());
    }
    crate::usage_snapshot::window_anchor_timestamp_iso(t as i64)
        .ok_or_else(|| "Invalid time value".into())
}

/// Node `path.basename` (win32 flavour on Windows).
fn basename(path: &str) -> &str {
    let is_sep = |c: char| c == '/' || (cfg!(windows) && c == '\\');
    let mut p = path;
    if cfg!(windows)
        && p.len() >= 2
        && p.as_bytes()[1] == b':'
        && p.as_bytes()[0].is_ascii_alphabetic()
    {
        p = &p[2..];
    }
    let p = p.trim_end_matches(is_sep);
    p.rfind(is_sep).map_or(p, |i| &p[i + 1..])
}

/// `id.slice(-8)` in UTF-16 code units, including a split surrogate pair.
fn last8_units(id: &str) -> Vec<u16> {
    let units: Vec<u16> = id.encode_utf16().collect();
    if units.len() <= 8 {
        units
    } else {
        units[units.len() - 8..].to_vec()
    }
}

fn internal_key(units: &[u16]) -> String {
    use std::fmt::Write as _;
    let mut key = String::with_capacity(5 + units.len() * 4);
    key.push_str("u16:");
    for unit in units {
        write!(&mut key, "{unit:04x}").expect("writing to String");
    }
    key
}

fn internal_key_units(key: &str) -> Vec<u16> {
    key.strip_prefix("u16:")
        .unwrap_or_default()
        .as_bytes()
        .chunks_exact(4)
        .filter_map(|chunk| {
            std::str::from_utf8(chunk)
                .ok()
                .and_then(|hex| u16::from_str_radix(hex, 16).ok())
        })
        .collect()
}

fn basename_units(path: &[u16]) -> &[u16] {
    let is_sep = |unit: &u16| *unit == b'/' as u16 || (cfg!(windows) && *unit == b'\\' as u16);
    let mut path = path;
    if cfg!(windows)
        && path.len() >= 2
        && path[1] == b':' as u16
        && matches!(path[0], 0x41..=0x5a | 0x61..=0x7a)
    {
        path = &path[2..];
    }
    let end = path
        .iter()
        .rposition(|unit| !is_sep(unit))
        .map_or(0, |i| i + 1);
    let path = &path[..end];
    path.iter()
        .rposition(is_sep)
        .map_or(path, |i| &path[i + 1..])
}

fn raw_units(input: &str, path: &[&str], fallback: Option<&Value>) -> Option<Vec<u16>> {
    fallback
        .filter(|value| value.is_string())
        .and_then(|_| crate::transcripts::raw_json_string_at(input, path))
        .and_then(|text| text.units().ok())
}

fn safe_dir(dir: &Path) -> Vec<String> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    #[allow(unused_mut)]
    let mut names: Vec<String> = entries
        .filter_map(|e| e.ok()?.file_name().into_string().ok())
        .collect();
    // libuv scandir sorts by byte order on Unix; Windows keeps the OS order, like Node.
    #[cfg(unix)]
    names.sort();
    names
}

/// [mtimeMs, size] as Node's statSync reports them.
fn file_stat(path: &Path) -> Option<(f64, u64)> {
    let meta = fs::metadata(path).ok()?;
    let mtime = meta.modified().ok()?;
    let ms = match mtime.duration_since(std::time::UNIX_EPOCH) {
        Ok(d) => d.as_secs() as f64 * 1e3 + f64::from(d.subsec_nanos()) / 1e6,
        Err(e) => {
            -(e.duration().as_secs() as f64 * 1e3 + f64::from(e.duration().subsec_nanos()) / 1e6)
        }
    };
    Some((ms, meta.len()))
}

fn parse_row(text: &str) -> Option<Value> {
    // Arrays parse as rows in Node too, but carry none of the fields read here.
    serde_json::from_str::<Value>(text)
        .ok()
        .filter(Value::is_object)
}

/// Parsed rows of the last `bytes` of a log (window start's partial line dropped),
/// narrowed to the last `keep` bytes with the same rule. Node caches this
/// incrementally; its own test pins that result to this cold read.
fn tail_rows(file: &Path, bytes: u64, keep: u64) -> Vec<(Value, String)> {
    let Ok(mut handle) = fs::File::open(file) else {
        return Vec::new();
    };
    let Ok(size) = handle.metadata().map(|m| m.len()) else {
        return Vec::new();
    };
    let pos = size.saturating_sub(bytes);
    let mut buf = Vec::new();
    if handle.seek(SeekFrom::Start(pos)).is_err() || handle.read_to_end(&mut buf).is_err() {
        return Vec::new();
    }
    let mut lead = pos > 0;
    let mut rows: Vec<(u64, Option<(Value, String)>)> = Vec::new();
    let mut at = 0usize;
    while let Some(nl) = buf[at..].iter().position(|&b| b == b'\n').map(|i| at + i) {
        if lead {
            lead = false;
        } else if nl > at {
            rows.push((pos + at as u64, {
                let raw = String::from_utf8_lossy(&buf[at..nl]).into_owned();
                parse_row(&raw).map(|value| (value, raw))
            }));
        }
        at = nl + 1;
    }
    if !lead && at < buf.len() {
        rows.push((pos + at as u64, {
            let raw = String::from_utf8_lossy(&buf[at..]).into_owned();
            parse_row(&raw).map(|value| (value, raw))
        }));
    }
    let from = size as i128 - keep as i128;
    rows.into_iter()
        .filter(|(off, _)| from <= 0 || i128::from(*off) > from)
        .filter_map(|(_, v)| v)
        .collect()
}

fn newest_snapshot_archive(state_dir: &Path) -> Option<PathBuf> {
    let re = regex::Regex::new(r"^usage-snapshots-[0-9]{4}-[0-9]{2}\.jsonl$").expect("valid regex");
    let mut names: Vec<String> = safe_dir(state_dir)
        .into_iter()
        .filter(|n| re.is_match(n))
        .collect();
    names.sort();
    names.pop().map(|n| state_dir.join(n))
}

fn totals_window<'v>(provider: &str, window: &str, row: &'v Value) -> Option<&'v Value> {
    let key = match (provider, window) {
        ("claude", "5h") => "five_hour",
        ("claude", _) => "seven_day",
        (_, "5h") => "session",
        _ => "weekly",
    };
    if provider == "claude" {
        let nested = row.get("raw").and_then(|raw| raw.get(key));
        if !matches!(nested, None | Some(Value::Null)) {
            return nested;
        }
    }
    row.get(key)
}

/// [{t, pct, resetsAt}] oldest first.
fn read_totals(provider: &str, window: &str, state_dir: &Path) -> Result<Vec<Point>, String> {
    let bytes = if window == "7d" {
        WEEK_TAIL_BYTES
    } else {
        TAIL_BYTES
    };
    let path = state_dir.join(totals_file(provider).unwrap_or_default());
    let mut lines = tail_rows(&path, bytes, bytes);
    // Claude's archive + live file are one stream.
    let live = file_stat(&path).map_or(0, |(_, size)| size);
    if provider == "claude" && live < bytes {
        if let Some(archive) = newest_snapshot_archive(state_dir) {
            let mut joined = tail_rows(&archive, bytes, bytes - live);
            joined.append(&mut lines);
            lines = joined;
        }
    }
    let mut rows = Vec::new();
    for (r, _) in &lines {
        let w = totals_window(provider, window, r);
        let t = js_date_checked(r.get("fetched_at"))?;
        let Some(pct) = finite(w.and_then(|w| w.get("utilization"))) else {
            continue;
        };
        if t.is_nan() {
            continue;
        }
        // Old Codex rows carry resets_at as epoch seconds.
        let raw = w.and_then(|w| w.get("resets_at"));
        let resets_at = match raw {
            Some(Value::Number(n)) => n.as_f64().map_or(f64::NAN, |n| n * 1000.0),
            other if truthy(other) => js_date(other),
            _ => f64::NAN,
        };
        rows.push(Point {
            t,
            pct,
            resets_at: (!resets_at.is_nan()).then_some(resets_at),
        });
    }
    rows.sort_by(|a, b| a.t.total_cmp(&b.t));
    Ok(rows)
}

type Cache<T> = LazyLock<Mutex<HashMap<PathBuf, (f64, u64, Arc<T>)>>>;
static CLAUDE_CACHE: Cache<ClaudeTranscript> = LazyLock::new(Default::default);
static CODEX_CACHE: Cache<CodexRollout> = LazyLock::new(Default::default);

/// Parsed transcript per path, reused while (mtime, size) hold.
fn parse_cached<T>(cache: &Cache<T>, path: &Path, parse: fn(&str) -> T) -> Option<Arc<T>> {
    let (mtime, size) = file_stat(path)?;
    let mut map = cache.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((m, s, hit)) = map.get(path) {
        if *m == mtime && *s == size {
            return Some(hit.clone());
        }
    }
    let bytes = fs::read(path).ok()?;
    let parsed = Arc::new(parse(&String::from_utf8_lossy(&bytes)));
    map.insert(path.to_owned(), (mtime, size, parsed.clone()));
    Some(parsed)
}

fn prune_cache<T>(cache: &Cache<T>, keep: &HashSet<&Path>) {
    cache
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .retain(|p, _| keep.contains(p.as_path()));
}

fn string_of(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).map(str::to_owned)
}

/// SameValueZero key for a truthy primitive id; objects never match (identity).
fn id_key(value: Option<&Value>, raw: Option<Vec<u16>>) -> Option<String> {
    if !truthy(value) {
        return None;
    }
    match value? {
        Value::String(_) => Some(format!("s{}", internal_key(&raw?))),
        Value::Number(n) => n.as_f64().map(|n| format!("n{n}")),
        Value::Bool(_) => Some("true".into()),
        _ => None,
    }
}

/// tok = [input, output, cacheRead, cacheWrite]; deduped on message.id, last line wins.
fn parse_claude_transcript(content: &str) -> ClaudeTranscript {
    let mut events: Vec<Event> = Vec::new();
    let mut seen: HashMap<String, usize> = HashMap::new();
    let mut cwd: Option<Vec<u16>> = None;
    for line in content.split('\n') {
        if line.is_empty() {
            continue;
        }
        if cwd.as_deref().is_none_or(|units| units.is_empty()) && line.contains("\"cwd\"") {
            if let Some(v) = parse_json_value(line) {
                cwd = raw_units(line, &["cwd"], v.get("cwd"));
            }
        }
        if !line.contains("\"type\":\"assistant\"") {
            continue;
        }
        let Some(o) = parse_json_value(line) else {
            continue;
        };
        let m = o.get("message");
        let u = m.and_then(|m| m.get("usage"));
        if !truthy(u) {
            continue;
        }
        let tok = [
            "input_tokens",
            "output_tokens",
            "cache_read_input_tokens",
            "cache_creation_input_tokens",
        ]
        .map(|k| num_or_zero(u.and_then(|u| u.get(k))));
        let coercion_error = [
            "input_tokens",
            "output_tokens",
            "cache_read_input_tokens",
            "cache_creation_input_tokens",
        ]
        .iter()
        .any(|k| token_conversion_error(u.and_then(|u| u.get(*k))));
        let e = Event {
            t: js_date(o.get("timestamp")),
            model: raw_units(line, &["message", "model"], m.and_then(|m| m.get("model")))
                .unwrap_or_default(),
            tok,
            usd: None,
            coercion_error,
            conversion_throws_immediately: false,
        };
        let key = id_key(
            m.and_then(|m| m.get("id")),
            raw_units(line, &["message", "id"], m.and_then(|m| m.get("id"))),
        );
        if let Some(&i) = key.as_ref().and_then(|k| seen.get(k)) {
            events[i] = Event {
                t: events[i].t,
                ..e
            };
            continue;
        }
        if let Some(k) = key {
            seen.insert(k, events.len());
        }
        events.push(e);
    }
    ClaudeTranscript { cwd, events }
}

/// JS `===` between two token totals (None = undefined); objects never equal.
fn same_total(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(Value::Null), Some(Value::Null)) => true,
        (Some(Value::Number(x)), Some(Value::Number(y))) => x.as_f64() == y.as_f64(),
        (Some(Value::String(x)), Some(Value::String(y))) => x == y,
        (Some(Value::Bool(x)), Some(Value::Bool(y))) => x == y,
        _ => false,
    }
}

/// Codex input_tokens includes cached_input_tokens; a token_count whose running
/// total did not move is a repeat.
fn parse_codex_rollout(content: &str) -> CodexRollout {
    let mut out = CodexRollout {
        id: None,
        cwd: None,
        events: Vec::new(),
        models: Vec::new(),
    };
    let mut model = Vec::new();
    let mut last_total: Option<Value> = Some(Value::Null);
    for line in content.split('\n') {
        if line.is_empty() {
            continue;
        }
        let Some(o) = parse_json_value(line) else {
            continue;
        };
        let kind = o.get("type").and_then(Value::as_str);
        let payload = o.get("payload");
        if kind == Some("session_meta") {
            out.id =
                raw_units(line, &["payload", "id"], payload.and_then(|p| p.get("id"))).or(out.id);
            out.cwd = raw_units(
                line,
                &["payload", "cwd"],
                payload.and_then(|p| p.get("cwd")),
            )
            .or(out.cwd);
        }
        if kind == Some("turn_context") {
            if let Some(m) = payload
                .and_then(|p| p.get("model"))
                .and_then(Value::as_str)
                .filter(|m| !m.is_empty())
            {
                model = raw_units(
                    line,
                    &["payload", "model"],
                    Some(&Value::String(m.to_owned())),
                )
                .unwrap_or_else(|| m.encode_utf16().collect());
                out.models
                    .push((js_date(o.get("timestamp")), model.clone()));
            }
        }
        if kind != Some("event_msg")
            || payload.and_then(|p| p.get("type")).and_then(Value::as_str) != Some("token_count")
        {
            continue;
        }
        let info = payload.and_then(|p| p.get("info")).filter(|i| !i.is_null());
        let total = info
            .and_then(|i| i.get("total_token_usage"))
            .filter(|u| !u.is_null())
            .and_then(|u| u.get("total_tokens"));
        let last = info.and_then(|i| i.get("last_token_usage"));
        if !truthy(last) || same_total(total, last_total.as_ref()) {
            continue;
        }
        last_total = total.cloned();
        let get = |k: &str| num_or_zero(last.and_then(|l| l.get(k)));
        let cached = get("cached_input_tokens");
        out.events.push(Event {
            t: js_date(o.get("timestamp")),
            model: model.clone(),
            tok: [
                js_max(0.0, get("input_tokens") - cached),
                get("output_tokens"),
                cached,
                get("cache_write_input_tokens"),
            ],
            usd: None,
            coercion_error: [
                "input_tokens",
                "output_tokens",
                "cached_input_tokens",
                "cache_write_input_tokens",
            ]
            .iter()
            .any(|k| token_conversion_error(last.and_then(|l| l.get(*k)))),
            conversion_throws_immediately: true,
        });
    }
    out
}

/// Transcripts touched since `since`; subagent transcripts count toward their parent.
fn claude_files(root: &Path, since: f64) -> Vec<(PathBuf, String)> {
    let mut out = Vec::new();
    let mut subs = Vec::new();
    for proj in safe_dir(root) {
        let dir = root.join(&proj);
        for f in safe_dir(&dir) {
            if let Some(id) = f.strip_suffix(".jsonl") {
                out.push((dir.join(&f), id.to_owned()));
                continue;
            }
            let sub = dir.join(&f).join("subagents");
            for s in safe_dir(&sub) {
                if s.ends_with(".jsonl") {
                    subs.push((sub.join(&s), f.clone()));
                }
            }
        }
    }
    out.extend(subs);
    out.retain(|(p, _)| file_stat(p).map_or(0.0, |(m, _)| m) >= since);
    out
}

/// Rollouts under sessions/YYYY/MM/DD by local start date, from the day before the window.
fn codex_files(root: &Path, since: f64, now: f64) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    let mut t = since - DAY_MS;
    while t <= now + DAY_MS {
        let d = t.min(now);
        if let Some((y, m, day, ..)) =
            crate::usage_snapshot::local_parts((d / 1000.0).floor() as i64)
        {
            let dir = root
                .join(y.to_string())
                .join(format!("{m:02}"))
                .join(format!("{day:02}"));
            if !dirs.contains(&dir) {
                dirs.push(dir);
            }
        }
        t += DAY_MS;
    }
    let mut out = Vec::new();
    for dir in &dirs {
        for f in safe_dir(dir) {
            if f.starts_with("rollout-") && f.ends_with(".jsonl") {
                out.push(dir.join(f));
            }
        }
    }
    out.retain(|p| file_stat(p).map_or(0.0, |(m, _)| m) >= since);
    out
}

/// Per-session statusline cost rises; rows with a 5h % also push history points.
fn claude_cost_events(state_dir: &Path, pts: &mut Vec<Point>) -> OMap<Vec<Event>> {
    let file = state_dir.join("cost-history.jsonl");
    let mut rows = tail_rows(
        &state_dir.join("cost-history.jsonl.1"),
        TAIL_BYTES,
        TAIL_BYTES,
    );
    rows.extend(tail_rows(&file, TAIL_BYTES, TAIL_BYTES));
    let mut last: HashMap<String, f64> = HashMap::new();
    let mut out = OMap::new();
    for (r, raw) in &rows {
        let t = js_date(r.get("ts"));
        if t.is_nan() {
            continue;
        }
        if let (Some(pct), Some(reset)) = (
            finite(r.get("five_hour_pct")),
            finite(r.get("five_hour_resets_at")),
        ) {
            pts.push(Point {
                t,
                pct,
                resets_at: Some(reset * 1000.0),
            });
        }
        // shortcut: non-string session ids are skipped; JS would key them by value.
        let Some(id_units) =
            raw_units(raw, &["session_id"], r.get("session_id")).filter(|units| !units.is_empty())
        else {
            continue;
        };
        let Some(cost) = finite(r.get("cost_usd")) else {
            continue;
        };
        let key = internal_key(&id_units);
        let usd = last.get(&key).map_or(0.0, |base| js_max(0.0, cost - base));
        last.insert(key.clone(), cost);
        out.get_or_insert_with(&key, Vec::new).push(Event {
            t,
            model: Vec::new(),
            tok: [0.0; 4],
            usd: Some(usd),
            coercion_error: false,
            conversion_throws_immediately: false,
        });
    }
    out
}

struct Turns {
    first: f64,
    last: f64,
    base: Value,
    events: Vec<Event>,
    mixed: bool,
}

/// Codex Stop-hook rows: rises of each session's running total_token_usage.
fn codex_turn_events(state_dir: &Path) -> OMap<Turns> {
    let mut out: OMap<Turns> = OMap::new();
    for (r, raw) in tail_rows(&state_dir.join("codex-usage.jsonl"), TAIL_BYTES, TAIL_BYTES) {
        let u = r.get("total_token_usage");
        let t = js_date(r.get("fetched_at"));
        let id =
            raw_units(&raw, &["session_id"], r.get("session_id")).filter(|units| !units.is_empty());
        let total = finite(u.and_then(|u| u.get("total_tokens")));
        let (Some(id), Some(total), Some(u)) = (id, total, u) else {
            continue;
        };
        let key = internal_key(&id);
        if t.is_nan() {
            continue;
        }
        let Some(s) = out.get_mut(&key) else {
            out.get_or_insert_with(&key, || Turns {
                first: t,
                last: t,
                base: u.clone(),
                events: Vec::new(),
                mixed: false,
            });
            continue;
        };
        if total < finite(s.base.get("total_tokens")).unwrap_or(f64::NAN) {
            s.mixed = true;
        }
        let d = |k: &str| js_max(0.0, num_or_zero(u.get(k)) - num_or_zero(s.base.get(k)));
        let cached = d("cached_input_tokens");
        let tok = [
            js_max(0.0, d("input_tokens") - cached),
            d("output_tokens"),
            cached,
            d("cache_write_input_tokens"),
        ];
        let coercion_error = [
            "input_tokens",
            "cached_input_tokens",
            "output_tokens",
            "cache_write_input_tokens",
        ]
        .iter()
        .any(|k| token_conversion_error(u.get(*k)) || token_conversion_error(s.base.get(*k)));
        s.events.push(Event {
            t,
            model: Vec::new(),
            tok,
            usd: None,
            coercion_error,
            conversion_throws_immediately: true,
        });
        s.base = u.clone();
        s.last = t;
    }
    out
}

struct Session {
    id: Vec<u16>,
    label: Vec<u16>,
    events: Vec<Event>,
}

fn add(
    out: &mut OMap<Session>,
    id: &[u16],
    cwd: Option<&[u16]>,
    events: impl IntoIterator<Item = Event>,
    since: f64,
    now: f64,
) {
    let key = internal_key(id);
    let s = out.get_or_insert_with(&key, || Session {
        id: id.to_vec(),
        label: {
            let mut label = Vec::new();
            if let Some(cwd) = cwd.filter(|c| !c.is_empty()) {
                label.extend(basename_units(cwd));
                label.extend(" · ".encode_utf16());
            }
            label.extend(if id.len() <= 8 {
                id.to_vec()
            } else {
                id[id.len() - 8..].to_vec()
            });
            label
        },
        events: Vec::new(),
    });
    s.events.extend(events.into_iter().filter(|e| {
        (e.conversion_throws_immediately && e.coercion_error) || (e.t >= since && e.t <= now)
    }));
}

fn claude_sessions(
    p: &Params,
    since: f64,
    files: &[(PathBuf, String)],
    cost_points: &mut Vec<Point>,
) -> OMap<Session> {
    let mut out = OMap::new();
    for (path, id) in files {
        if let Some(r) = parse_cached(&CLAUDE_CACHE, path, parse_claude_transcript) {
            add(
                &mut out,
                &id.encode_utf16().collect::<Vec<_>>(),
                r.cwd.as_deref().map(|cwd| cwd),
                r.events.iter().cloned(),
                since,
                p.now_ms,
            );
        }
    }
    prune_cache(
        &CLAUDE_CACHE,
        &files.iter().map(|(p, _)| p.as_path()).collect(),
    );
    // Statusline cost replaces transcript spend from a session's first (baseline) row on.
    for (id, events) in claude_cost_events(Path::new(p.state_dir), cost_points).entries {
        if let Some(s) = out.get_mut(&id) {
            s.events.retain(|e| e.t < events[0].t);
        }
        add(
            &mut out,
            &internal_key_units(&id),
            None,
            events,
            since,
            p.now_ms,
        );
    }
    out
}

fn codex_sessions(p: &Params, since: f64, files: &[PathBuf]) -> OMap<Session> {
    let mut out = OMap::new();
    let turns = codex_turn_events(Path::new(p.state_dir));
    for path in files {
        let Some(r) = parse_cached(&CODEX_CACHE, path, parse_codex_rollout) else {
            continue;
        };
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or_default();
        let id = r.id.clone().unwrap_or_else(|| {
            name.strip_suffix(".jsonl")
                .unwrap_or(name)
                .encode_utf16()
                .collect()
        });
        let key = internal_key(&id);
        let cwd = r.cwd.as_deref().map(|cwd| cwd);
        let Some(s) = turns.get(&key).filter(|s| !s.mixed) else {
            add(
                &mut out,
                &id,
                cwd,
                r.events.iter().cloned(),
                since,
                p.now_ms,
            );
            continue;
        };
        // +1s: fetched_at has whole-second resolution.
        let outside = r
            .events
            .iter()
            .filter(|e| e.t < s.first + 1000.0 || e.t >= s.last + 1000.0)
            .cloned();
        add(&mut out, &id, cwd, outside, since, p.now_ms);
        let model_at = |t: f64| {
            let bound = ((t / 1000.0).floor() + 1.0) * 1000.0;
            r.models
                .iter()
                .rev()
                .find(|(mt, _)| *mt < bound)
                .or(r.models.first())
                .map(|(_, m)| m.clone())
                .or_else(|| r.events.first().map(|e| e.model.clone()))
                .unwrap_or_default()
        };
        let priced = s.events.iter().map(|e| Event {
            model: model_at(e.t),
            ..e.clone()
        });
        add(
            &mut out,
            &id,
            None,
            priced.collect::<Vec<_>>(),
            since,
            p.now_ms,
        );
    }
    prune_cache(&CODEX_CACHE, &files.iter().map(PathBuf::as_path).collect());
    out
}

/// JS Object.keys order: array-index keys ascending, then insertion order.
fn js_key_order(map: &serde_json::Map<String, Value>) -> Vec<String> {
    let index = |k: &str| {
        (k == "0"
            || (!k.starts_with('0') && !k.is_empty() && k.bytes().all(|b| b.is_ascii_digit())))
        .then(|| k.parse::<u64>().ok().filter(|n| *n < 4_294_967_295))
        .flatten()
    };
    let mut ints: Vec<(u64, String)> = map
        .keys()
        .filter_map(|k| index(k).map(|n| (n, k.clone())))
        .collect();
    ints.sort();
    let mut keys: Vec<String> = ints.into_iter().map(|(_, k)| k).collect();
    keys.extend(map.keys().filter(|k| index(k).is_none()).cloned());
    keys
}

/// pricing.json: first `base` key that is a substring of the model id wins, else
/// default_key. Rates are $/MTok; the above_200k tier is ignored, as in Node.
fn pricer(path: &str) -> impl Fn(&[u16], &[f64; 4]) -> f64 {
    let doc: Value =
        serde_json::from_str(crate::model_prices::read_pricing(path).get()).unwrap_or(Value::Null);
    let pricing = doc.get("pricing");
    let base = pricing
        .and_then(|p| p.get("base"))
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let def = string_of(pricing.and_then(|p| p.get("default_key"))).unwrap_or_default();
    let keys = js_key_order(&base);
    move |model, tok| {
        let key = keys
            .iter()
            .find(|k| {
                let needle = k.encode_utf16().collect::<Vec<_>>();
                needle.is_empty()
                    || model
                        .windows(needle.len())
                        .any(|window| window == needle.as_slice())
            })
            .unwrap_or(&def);
        let rate = base.get(key);
        if !truthy(rate) {
            return 0.0;
        }
        // shortcut: only number/null/bool rate entries coerce like JS; others are NaN.
        let at = |i: usize| match rate.and_then(|r| r.get(i)) {
            Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
            Some(Value::Null) => 0.0,
            Some(Value::Bool(b)) => f64::from(u8::from(*b)),
            _ => f64::NAN,
        };
        tok.iter()
            .enumerate()
            .fold(0.0, |sum, (i, n)| sum + n * at(i))
            / 1e6
    }
}

struct Row {
    ts: f64,
    pct: f64,
    shares: HashMap<String, f64>,
    unattributed: f64,
}

/// Split each interval's % rise across the sessions that spent in it, by cost share.
fn attribute(
    points: &[Point],
    sessions: &OMap<Session>,
    cost: impl Fn(&[u16], &[f64; 4]) -> f64,
) -> Result<String, String> {
    if sessions.entries.iter().any(|(_, session)| {
        session
            .events
            .iter()
            .any(|event| event.conversion_throws_immediately && event.coercion_error)
    }) {
        return Err("Cannot convert object to primitive value".into());
    }
    let mut cum: OMap<f64> = OMap::new();
    let snapshot = |cum: &OMap<f64>| cum.entries.iter().cloned().collect::<HashMap<_, _>>();
    let mut unattributed = points.first().map_or(0.0, |p| p.pct);
    let mut rows = Vec::new();
    for (i, p) in points.iter().enumerate() {
        if i > 0 {
            let prev = &points[i - 1];
            let rise = p.pct - prev.pct;
            if rise < 0.0 {
                // A drop: shrink every share in proportion.
                let f = if prev.pct > 0.0 {
                    p.pct / prev.pct
                } else {
                    0.0
                };
                for (_, v) in &mut cum.entries {
                    *v *= f;
                }
                unattributed *= f;
                rows.push(Row {
                    ts: p.t,
                    pct: p.pct,
                    shares: snapshot(&cum),
                    unattributed,
                });
                continue;
            }
            let mut spend: OMap<f64> = OMap::new();
            let mut total = 0.0;
            for (id, s) in &sessions.entries {
                for e in &s.events {
                    if e.t <= prev.t || e.t > p.t {
                        continue;
                    }
                    let c = e.usd.unwrap_or_else(|| cost(&e.model, &e.tok));
                    if e.coercion_error && c.is_nan() {
                        return Err("Cannot convert object to primitive value".into());
                    }
                    *spend.get_or_insert_with(id, || 0.0) += c;
                    total += c;
                }
            }
            if total > 0.0 {
                for (id, c) in &spend.entries {
                    *cum.get_or_insert_with(id, || 0.0) += rise * c / total;
                }
            } else {
                unattributed += rise;
            }
        }
        rows.push(Row {
            ts: p.t,
            pct: p.pct,
            shares: snapshot(&cum),
            unattributed,
        });
    }
    let empty = HashMap::new();
    let last = rows.last().map_or(&empty, |r| &r.shares);
    let share = |shares: &HashMap<String, f64>, id: &str| shares.get(id).copied().unwrap_or(0.0);
    let mut ranked: Vec<&String> = cum
        .entries
        .iter()
        .map(|(id, _)| id)
        .filter(|id| share(last, id) > 0.0)
        .collect();
    ranked.sort_by(|a, b| {
        share(last, b)
            .partial_cmp(&share(last, a))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let (shown, folded) = ranked.split_at(ranked.len().min(MAX_SERIES));
    let mut series: Vec<String> = shown
        .iter()
        .map(|id| {
            let session = sessions.get(id);
            let id_units = session.map_or_else(|| internal_key_units(id), |s| s.id.clone());
            let label = session.map_or_else(|| id_units.clone(), |s| s.label.clone());
            format!(
                "{{\"id\":{},\"label\":{}}}",
                js_str_units(&id_units),
                js_str_units(&label)
            )
        })
        .collect();
    if !folded.is_empty() {
        series.push(format!(
            "{{\"id\":\"{OTHER}\",\"label\":\"Other sessions ({})\"}}",
            folded.len()
        ));
    }
    series.push(format!(
        "{{\"id\":\"{UNATTRIBUTED}\",\"label\":\"Unattributed\"}}"
    ));
    let mut out_points = Vec::new();
    for r in &rows {
        let mut fields: Vec<String> = shown
            .iter()
            .map(|id| {
                let id_units = sessions
                    .get(id)
                    .map_or_else(|| internal_key_units(id), |s| s.id.clone());
                format!(
                    "{}:{}",
                    js_str_units(&id_units),
                    js_num(round2(share(&r.shares, id)))
                )
            })
            .collect();
        if !folded.is_empty() {
            let sum = folded
                .iter()
                .fold(0.0, |sum, id| sum + share(&r.shares, id));
            fields.push(format!("\"{OTHER}\":{}", js_num(round2(sum))));
        }
        fields.push(format!(
            "\"{UNATTRIBUTED}\":{}",
            js_num(round2(r.unattributed))
        ));
        out_points.push(format!(
            "{{\"ts\":{},\"pct\":{},\"sessions\":{{{}}}}}",
            js_str(&iso(r.ts)?),
            js_num(r.pct),
            fields.join(",")
        ));
    }
    Ok(format!(
        "\"sessions\":[{}],\"points\":[{}]",
        series.join(","),
        out_points.join(",")
    ))
}

/// GET /api/usage/history document as JSON text; `null` for an unknown provider or window.
pub fn get(p: &Params) -> Result<String, String> {
    let (Some(_), Some(span)) = (totals_file(p.provider), window_ms(p.window)) else {
        return Ok("null".into());
    };
    let state_dir = Path::new(p.state_dir);
    let rows = read_totals(p.provider, p.window, state_dir)?;
    let estimated = p.provider != "ollama" && p.window == "5h";
    let head = format!(
        "\"provider\":{},\"window\":{}",
        js_str(p.provider),
        js_str(p.window)
    );
    // No reset on the newest reading, or a reset already past: no window running.
    let Some(resets_at) = rows
        .last()
        .and_then(|r| r.resets_at)
        .filter(|r| *r > p.now_ms)
    else {
        return Ok(format!(
            "{{{head},\"windowStart\":null,\"resetsAt\":null,\"points\":[],\"sessions\":[],\"estimated\":{estimated}}}"
        ));
    };
    let start = resets_at - span;
    let mut points: Vec<Point> = rows
        .into_iter()
        .filter(|r| r.t >= start && r.t <= resets_at)
        .collect();
    if p.window == "7d" {
        let bucket = |t: f64| (t / WEEK_BUCKET_MS).floor();
        points = (0..points.len())
            .filter(|&i| {
                bucket(points[i].t) != points.get(i + 1).map_or(f64::INFINITY, |n| bucket(n.t))
            })
            .map(|i| points[i].clone())
            .collect();
    }
    let doc = format!(
        "{head},\"windowStart\":{},\"resetsAt\":{},\"estimated\":{estimated}",
        js_str(&iso(start)?),
        js_str(&iso(resets_at)?)
    );
    if !estimated {
        let pts = points
            .iter()
            .map(|pt| {
                Ok(format!(
                    "{{\"ts\":{},\"pct\":{},\"sessions\":{{}}}}",
                    js_str(&iso(pt.t)?),
                    js_num(pt.pct)
                ))
            })
            .collect::<Result<Vec<_>, String>>()?;
        return Ok(format!(
            "{{{doc},\"points\":[{}],\"sessions\":[]}}",
            pts.join(",")
        ));
    }
    let mut cost_points = Vec::new();
    let sessions = if p.provider == "claude" {
        let files = claude_files(Path::new(p.claude_projects), start);
        claude_sessions(p, start, &files, &mut cost_points)
    } else {
        let files = codex_files(Path::new(p.codex_sessions), start, p.now_ms);
        codex_sessions(p, start, &files)
    };
    if p.provider == "claude" {
        // Statusline rows fill the sparse snapshots: this window's (resets_at within 60s),
        // then consecutive equal readings collapse.
        points.extend(cost_points.into_iter().filter(|c| {
            c.resets_at
                .is_some_and(|r| (r - resets_at).abs() <= 60_000.0)
                && c.t >= start
                && c.t <= resets_at
        }));
        points.sort_by(|a, b| a.t.total_cmp(&b.t));
        points = (0..points.len())
            .filter(|&i| i == 0 || points[i].pct != points[i - 1].pct)
            .map(|i| points[i].clone())
            .collect();
    }
    Ok(format!(
        "{{{doc},{}}}",
        attribute(&points, &sessions, pricer(p.pricing_path))?
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn js_number_covers_javascript_string_numeric_forms() {
        assert_eq!(js_number("0xF4240"), 1_000_000.0);
        assert_eq!(js_number("0b11110100001001000000"), 1_000_000.0);
        assert_eq!(js_number("0o3641100"), 1_000_000.0);
        assert_eq!(js_number("\u{feff}\u{00a0}1000000\u{2028}"), 1_000_000.0);
        assert_eq!(js_number("+Infinity"), f64::INFINITY);
        assert!(js_number("-0x10").is_nan());
        assert!(js_number("NaN").is_nan());
        assert!(js_number("\u{0085}1").is_nan());
        assert_eq!(num_or_zero(Some(&serde_json::json!([]))), 0.0);
        assert_eq!(
            num_or_zero(Some(&serde_json::json!(["1000000"]))),
            1_000_000.0
        );
        assert!(num_or_zero(Some(&serde_json::json!([1, 2]))).is_nan());
        assert_eq!(num_or_zero(Some(&Value::Null)), 0.0);
        assert_eq!(num_or_zero(Some(&Value::Bool(true))), 1.0);
        assert_eq!(num_or_zero(Some(&Value::Bool(false))), 0.0);
        assert!(num_or_zero(Some(&serde_json::json!({}))).is_nan());
        assert!(token_conversion_error(Some(
            &serde_json::json!({"toString": 1})
        )));
        assert!(token_conversion_error(Some(
            &serde_json::json!([{"toString": null}])
        )));
        assert!(token_conversion_error(Some(
            &serde_json::json!([[{"toString": false}]])
        )));
        assert!(!token_conversion_error(Some(
            &serde_json::json!({"nested": {"toString": 1}})
        )));
        assert_eq!(js_number("0x20000000000001"), 9_007_199_254_740_992.0);
        assert_eq!(js_number("0x20000000000003"), 9_007_199_254_740_996.0);
    }

    const NOW: f64 = 1_768_478_400_000.0; // 2026-01-15T12:00:00Z

    // Same files as the Node oracle run (original server/usage-history.mjs).
    const FILES: &[(&str, &str)] = &[
        (
            "state/pricing.json",
            r#"{"base":{"opus":[1,0,0,0],"gpt-6":[1,0.5,0,0]},"default_key":"opus"}"#,
        ),
        (
            "state/usage-snapshots.jsonl",
            concat!(
                r#"{"fetched_at":"2026-01-15T07:00:00Z","raw":{"five_hour":{"utilization":90,"resets_at":"2026-01-15T08:30:00Z"}}}"#,
                "\n",
                r#"{"fetched_at":"2026-01-15T09:00:00Z","raw":{"five_hour":{"utilization":10.0,"resets_at":"2026-01-15T13:00:00.000Z"}}}"#,
                "\n",
                r#"{"fetched_at":"2026-01-15T10:00:00Z","raw":{"five_hour":{"utilization":20,"resets_at":"2026-01-15T13:00:00.000Z"}}}"#,
                "\n",
                r#"{"fetched_at":"2026-01-15T11:00:00Z","five_hour":{"utilization":33.333,"resets_at":"2026-01-15T13:00:00.000Z"}}"#,
                "\n",
                "not json\n",
            ),
        ),
        (
            "state/cost-history.jsonl",
            concat!(
                r#"{"ts":"2026-01-15T10:30:00Z","session_id":"sess-c","cost_usd":5,"five_hour_pct":25,"five_hour_resets_at":1768482000}"#,
                "\n",
                r#"{"ts":"2026-01-15T10:40:00Z","session_id":"sess-c","cost_usd":5.0002,"five_hour_pct":25,"five_hour_resets_at":1768482000}"#,
                "\n",
            ),
        ),
        (
            "claude/projects/C--repo/sess-a.jsonl",
            concat!(
                r#"{"cwd":"/work/repo","type":"user"}"#,
                "\n",
                r#"{"type":"assistant","timestamp":"2026-01-15T09:10:00Z","message":{"id":"m1","model":"claude-opus","usage":{"input_tokens":50}}}"#,
                "\n",
                r#"{"type":"assistant","timestamp":"2026-01-15T09:11:00Z","message":{"id":"m1","model":"claude-opus","usage":{"input_tokens":100,"output_tokens":3}}}"#,
                "\n",
                r#"{"type":"assistant","timestamp":"2026-01-15T10:20:00Z","message":{"id":"m2","model":"claude-opus","usage":{"input_tokens":300}}}"#,
                "\n",
            ),
        ),
        (
            "claude/projects/C--repo/sess-b/subagents/agent-1.jsonl",
            concat!(
                r#"{"type":"assistant","timestamp":"2026-01-15T09:20:00Z","message":{"id":"m3","model":"unknown","usage":{"input_tokens":100}}}"#,
                "\n"
            ),
        ),
        (
            "state/codex-usage.jsonl",
            concat!(
                r#"{"fetched_at":"2026-01-15T09:00:00Z","session":{"utilization":5,"resets_at":1768482000}}"#,
                "\n",
                r#"{"fetched_at":"2026-01-15T09:01:01Z","session_id":"thread-x","total_token_usage":{"input_tokens":1000,"cached_input_tokens":0,"output_tokens":0,"total_tokens":1000}}"#,
                "\n",
                r#"{"fetched_at":"2026-01-15T10:00:00Z","session":{"utilization":15,"resets_at":"2026-01-15T13:00:00Z"},"weekly":{"utilization":40,"resets_at":"2026-01-20T00:00:00Z"}}"#,
                "\n",
                r#"{"fetched_at":"2026-01-15T10:01:01Z","session_id":"thread-x","total_token_usage":{"input_tokens":1300,"cached_input_tokens":100,"output_tokens":10,"total_tokens":1310}}"#,
                "\n",
                r#"{"fetched_at":"2026-01-15T11:00:00Z","session":{"utilization":25,"resets_at":"2026-01-15T13:00:00Z"},"weekly":{"utilization":41,"resets_at":"2026-01-20T00:00:00Z"}}"#,
                "\n",
                r#"{"fetched_at":"2026-01-15T11:05:00Z","session":{"utilization":25,"resets_at":"2026-01-15T13:00:00Z"},"weekly":{"utilization":42,"resets_at":"2026-01-20T00:00:00Z"}}"#,
                "\n",
            ),
        ),
        (
            "codex/sessions/2026/01/15/rollout-x.jsonl",
            concat!(
                r#"{"timestamp":"2026-01-15T09:00:00Z","type":"session_meta","payload":{"id":"thread-x","cwd":"/work/proj"}}"#,
                "\n",
                r#"{"timestamp":"2026-01-15T09:00:00Z","type":"turn_context","payload":{"model":"gpt-6-pro"}}"#,
                "\n",
                r#"{"timestamp":"2026-01-15T09:00:30Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"total_tokens":1},"last_token_usage":{"input_tokens":100}}}}"#,
                "\n",
                r#"{"timestamp":"2026-01-15T10:01:01.500Z","type":"turn_context","payload":{"model":"gpt-6-luna"}}"#,
                "\n",
                r#"{"timestamp":"2026-01-15T10:30:00Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"total_tokens":2},"last_token_usage":{"input_tokens":200,"cached_input_tokens":50,"output_tokens":7}}}}"#,
                "\n",
                r#"{"timestamp":"2026-01-15T10:31:00Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"total_tokens":2},"last_token_usage":{"input_tokens":200}}}}"#,
                "\n",
            ),
        ),
        (
            "codex/sessions/2026/01/15/rollout-y.jsonl",
            concat!(
                r#"{"timestamp":"2026-01-15T09:00:00Z","type":"session_meta","payload":{"id":"01a14896-0000-7000-8000-0000thread-y","cwd":"/work/proj2"}}"#,
                "\n",
                r#"{"timestamp":"2026-01-15T09:00:00Z","type":"turn_context","payload":{"model":"gpt-6"}}"#,
                "\n",
                r#"{"timestamp":"2026-01-15T09:30:00Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"total_tokens":5},"last_token_usage":{"input_tokens":120}}}}"#,
                "\n",
            ),
        ),
    ];

    // Captured from `node s1-oracle.mjs server/usage-history.mjs` at 90a0858.
    const ORACLE: &[(&str, &str, &str)] = &[
        (
            "claude",
            "5h",
            r#"{"provider":"claude","window":"5h","windowStart":"2026-01-15T08:00:00.000Z","resetsAt":"2026-01-15T13:00:00.000Z","estimated":true,"sessions":[{"id":"sess-a","label":"repo · sess-a"},{"id":"sess-c","label":"sess-c"},{"id":"sess-b","label":"sess-b"},{"id":"_unattributed","label":"Unattributed"}],"points":[{"ts":"2026-01-15T09:00:00.000Z","pct":10,"sessions":{"sess-a":0,"sess-c":0,"sess-b":0,"_unattributed":10}},{"ts":"2026-01-15T10:00:00.000Z","pct":20,"sessions":{"sess-a":5,"sess-c":0,"sess-b":5,"_unattributed":10}},{"ts":"2026-01-15T10:30:00.000Z","pct":25,"sessions":{"sess-a":10,"sess-c":0,"sess-b":5,"_unattributed":10}},{"ts":"2026-01-15T11:00:00.000Z","pct":33.333,"sessions":{"sess-a":10,"sess-c":8.33,"sess-b":5,"_unattributed":10}}]}"#,
        ),
        (
            "codex",
            "5h",
            r#"{"provider":"codex","window":"5h","windowStart":"2026-01-15T08:00:00.000Z","resetsAt":"2026-01-15T13:00:00.000Z","estimated":true,"sessions":[{"id":"thread-x","label":"proj · thread-x"},{"id":"01a14896-0000-7000-8000-0000thread-y","label":"proj2 · thread-y"},{"id":"_unattributed","label":"Unattributed"}],"points":[{"ts":"2026-01-15T09:00:00.000Z","pct":5,"sessions":{"thread-x":0,"01a14896-0000-7000-8000-0000thread-y":0,"_unattributed":5}},{"ts":"2026-01-15T10:00:00.000Z","pct":15,"sessions":{"thread-x":4.55,"01a14896-0000-7000-8000-0000thread-y":5.45,"_unattributed":5}},{"ts":"2026-01-15T11:00:00.000Z","pct":25,"sessions":{"thread-x":14.55,"01a14896-0000-7000-8000-0000thread-y":5.45,"_unattributed":5}},{"ts":"2026-01-15T11:05:00.000Z","pct":25,"sessions":{"thread-x":14.55,"01a14896-0000-7000-8000-0000thread-y":5.45,"_unattributed":5}}]}"#,
        ),
        (
            "codex",
            "7d",
            r#"{"provider":"codex","window":"7d","windowStart":"2026-01-13T00:00:00.000Z","resetsAt":"2026-01-20T00:00:00.000Z","estimated":false,"points":[{"ts":"2026-01-15T10:00:00.000Z","pct":40,"sessions":{}},{"ts":"2026-01-15T11:05:00.000Z","pct":42,"sessions":{}}],"sessions":[]}"#,
        ),
        (
            "ollama",
            "5h",
            r#"{"provider":"ollama","window":"5h","windowStart":null,"resetsAt":null,"points":[],"sessions":[],"estimated":false}"#,
        ),
        ("claude", "1d", "null"),
    ];

    #[test]
    fn usage_history_matches_node_oracle_fixture() {
        let root = std::env::temp_dir().join(format!("usage-history-test-{}", std::process::id()));
        for (rel, text) in FILES {
            let path = root.join(rel);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, text).unwrap();
        }
        let dir = |rel: &str| root.join(rel).to_string_lossy().into_owned();
        let (state, pricing, projects, sessions) = (
            dir("state"),
            dir("state/pricing.json"),
            dir("claude/projects"),
            dir("codex/sessions"),
        );
        for (provider, window, expected) in ORACLE {
            let params = Params {
                provider,
                window,
                now_ms: NOW,
                state_dir: &state,
                pricing_path: &pricing,
                claude_projects: &projects,
                codex_sessions: &sessions,
            };
            assert_eq!(
                get(&params).unwrap(),
                *expected,
                "Node oracle fixture: {provider} {window}"
            );
            // A second call takes the parse-cache path and must not change the doc.
            assert_eq!(
                get(&params).unwrap(),
                *expected,
                "cached: {provider} {window}"
            );
        }
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn usage_history_js_helpers() {
        assert_eq!(round2(0.125), 0.13);
        assert_eq!(round2(-0.125), -0.12);
        assert!(js_max(0.0, f64::NAN).is_nan());
        assert_eq!(js_num(-0.0), "0");
        assert_eq!(js_num(1e21), "1e+21");
        assert_eq!(
            last8_units("01a14896-0000-7000-8000-0000thread-y"),
            "thread-y".encode_utf16().collect::<Vec<_>>()
        );
        assert_eq!(
            last8_units("1234567😀"),
            "234567😀".encode_utf16().collect::<Vec<_>>()
        );
        assert_eq!(basename("/work/repo/"), "repo");
    }
}
