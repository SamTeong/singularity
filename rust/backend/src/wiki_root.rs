//! Wiki root persistence, authorization, and capability checks.
//!
//! String leaves stay as raw JSON tokens so JavaScript UTF-16 values (including
//! unpaired surrogates) survive the Rust line protocol without `Value`.

use crate::transcripts::TranscriptRawText;
use serde::Deserialize;
use serde::Serialize;
use serde_json::value::RawValue;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};

#[cfg(any(windows, test))]
fn drive_cwds_from(mut lookup: impl FnMut(&str) -> Option<OsString>) -> Vec<(u16, PathBuf)> {
    (b'A'..=b'Z')
        .filter_map(|drive| {
            lookup(&format!("={}:", drive as char)).map(|path| (drive as u16, PathBuf::from(path)))
        })
        .collect()
}

#[allow(dead_code)] // consumed when the staged memory routes are assembled
pub(crate) fn current_drive_cwds() -> Vec<(u16, PathBuf)> {
    #[cfg(windows)]
    {
        drive_cwds_from(|key| std::env::var_os(key))
    }
    #[cfg(not(windows))]
    {
        Vec::new()
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct RootValue(pub TranscriptRawText);

impl RootValue {
    pub fn from_token(token: String) -> Result<Self, String> {
        let value = TranscriptRawText::from_json_token(token)?;
        if value.units()?.is_empty() {
            return Err("bad root".into());
        }
        Ok(Self(value))
    }

    pub fn units(&self) -> Result<Vec<u16>, String> {
        self.0.units()
    }
}

#[derive(Serialize)]
pub struct RootResponse {
    pub root: RootValue,
}

#[derive(Serialize)]
pub struct SetResponse {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub root: Option<RootValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Serialize)]
pub struct AuthorizationResponse {
    pub authorized: bool,
}

#[derive(Serialize)]
pub struct AvailabilityResponse {
    pub available: bool,
}

#[derive(Debug)]
pub struct WireRequest {
    pub id: Option<serde_json::Value>,
    pub op: String,
    pub state_file: Option<PathBuf>,
    pub home: Option<PathBuf>,
    pub cwd: Option<PathBuf>,
    pub root: Option<RootValue>,
    pub path: Option<RootValue>,
    pub drive_cwds: Vec<(u16, PathBuf)>,
}

#[derive(Deserialize)]
struct DriveCwdWire {
    drive: String,
    path: PathBuf,
}

/// Parse and select only Wiki root operations before the generic Value request parser.
/// Raw root/path leaves and ignored fields never pass through serde_json::Value.
pub fn parse_wire_request(text: &str) -> Result<Option<WireRequest>, String> {
    let Some(fields) = raw_fields(text)? else {
        return Ok(None);
    };
    let get = |name: &str| {
        fields
            .iter()
            .rev()
            .find(|(key, _)| key == &name.encode_utf16().collect::<Vec<_>>())
            .map(|(_, value)| value.as_ref())
    };
    let Some(op) = get("op").and_then(|value| serde_json::from_str::<String>(value.get()).ok())
    else {
        return Ok(None);
    };
    if !matches!(
        op.as_str(),
        "wiki_root_get" | "wiki_root_set" | "wiki_root_authorize" | "wiki_root_available"
    ) {
        return Ok(None);
    }
    let parse_path = |name: &str| {
        get(name)
            .and_then(|value| serde_json::from_str::<String>(value.get()).ok())
            .map(PathBuf::from)
    };
    let parse_root = |name: &str| {
        get(name).and_then(|value| {
            value
                .get()
                .starts_with('"')
                .then(|| RootValue::from_token(value.get().to_owned()).ok())
                .flatten()
        })
    };
    let id = get("id").and_then(|value| serde_json::from_str(value.get()).ok());
    let drive_cwds = get("drive_cwds")
        .and_then(|value| serde_json::from_str::<Vec<DriveCwdWire>>(value.get()).ok())
        .unwrap_or_default()
        .into_iter()
        .filter_map(|entry| {
            let mut units = entry.drive.encode_utf16();
            let drive = units.next()?;
            units.next().is_none().then_some((drive, entry.path))
        })
        .collect();
    Ok(Some(WireRequest {
        id,
        op,
        state_file: parse_path("state_file"),
        home: parse_path("home"),
        cwd: parse_path("cwd"),
        root: parse_root("root"),
        path: parse_root("path"),
        drive_cwds,
    }))
}

pub fn dispatch_wire(request: &WireRequest) -> Result<String, String> {
    let state_file = request.state_file.as_deref().ok_or("bad request")?;
    let home = request.home.as_deref().ok_or("bad request")?;
    let body = match request.op.as_str() {
        "wiki_root_get" => serde_json::to_string(&RootResponse {
            root: get(state_file, home),
        }),
        "wiki_root_set" => serde_json::to_string(&set(state_file, home, request.root.clone())),
        "wiki_root_authorize" => {
            let authorized = request
                .root
                .as_ref()
                .zip(request.path.as_ref())
                .is_some_and(|(root, path)| {
                    !path.units().is_ok_and(|units| units.contains(&0))
                        && request.cwd.as_deref().is_some_and(|cwd| {
                            let persisted = get(state_file, home);
                            authorize_raw_with_drive_cwds(
                                root,
                                path,
                                &persisted,
                                home,
                                cwd,
                                &request.drive_cwds,
                            )
                        })
                });
            serde_json::to_string(&AuthorizationResponse { authorized })
        }
        "wiki_root_available" => {
            let available = request.cwd.as_deref().is_some_and(|cwd| {
                let persisted = get(state_file, home);
                available_with_drive_cwds(&persisted, home, cwd, &request.drive_cwds)
            });
            serde_json::to_string(&AvailabilityResponse { available })
        }
        _ => return Err("bad request".into()),
    }
    .map_err(|error| error.to_string())?;
    Ok(body)
}

/// Raw-aware request root extraction. Unknown fields are consumed as RawValue,
/// so oversized numeric values are accepted and duplicate `root` uses last-wins.
pub fn request_root(line: &str) -> Result<Option<RootValue>, String> {
    Ok(raw_root(line)?.and_then(|raw| {
        raw.get()
            .starts_with('"')
            .then(|| raw.get().to_owned())
            .and_then(|token| RootValue::from_token(token).ok())
    }))
}

/// Validate the entire JSON document without decoding object keys. serde_json's
/// raw-value validator accepts escaped lone surrogates that its String key
/// decoder cannot represent. The scanner then extracts only top-level fields.
fn raw_root(text: &str) -> Result<Option<Box<RawValue>>, String> {
    Ok(raw_fields(text)?.and_then(|fields| {
        let key = b"root".iter().map(|byte| *byte as u16).collect::<Vec<_>>();
        fields
            .into_iter()
            .rev()
            .find(|(field, _)| field == &key)
            .map(|(_, value)| value)
    }))
}

fn raw_fields(text: &str) -> Result<Option<Vec<(Vec<u16>, Box<RawValue>)>>, String> {
    let bytes = text.as_bytes();
    let mut start = 0;
    while bytes
        .get(start)
        .is_some_and(|byte| matches!(byte, b' ' | b'\n' | b'\r' | b'\t'))
    {
        start += 1;
    }
    let mut end = bytes.len();
    while end > start && matches!(bytes[end - 1], b' ' | b'\n' | b'\r' | b'\t') {
        end -= 1;
    }
    let trimmed = &text[start..end];
    let validated = RawValue::from_string(trimmed.to_owned()).map_err(|error| error.to_string())?;
    let bytes = validated.get().as_bytes();
    if bytes.first() != Some(&b'{') {
        return Err("expected a JSON object".into());
    }
    let mut cursor = 1;
    skip_json_whitespace(bytes, &mut cursor);
    let mut fields = Vec::new();
    if bytes.get(cursor) == Some(&b'}') {
        return Ok(Some(fields));
    }
    loop {
        let key_start = cursor;
        skip_json_string(bytes, &mut cursor);
        let key_token = &validated.get()[key_start..cursor];
        skip_json_whitespace(bytes, &mut cursor);
        cursor += 1; // validated colon
        skip_json_whitespace(bytes, &mut cursor);
        let value_start = cursor;
        skip_json_value(bytes, &mut cursor);
        let key = TranscriptRawText::from_json_token(key_token.to_owned())
            .and_then(|key| key.units())
            .unwrap_or_default();
        let value = RawValue::from_string(validated.get()[value_start..cursor].to_owned())
            .map_err(|error| error.to_string())?;
        fields.push((key, value));
        skip_json_whitespace(bytes, &mut cursor);
        if bytes.get(cursor) == Some(&b'}') {
            return Ok(Some(fields));
        }
        cursor += 1; // validated comma
        skip_json_whitespace(bytes, &mut cursor);
    }
}

fn skip_json_whitespace(bytes: &[u8], cursor: &mut usize) {
    while bytes
        .get(*cursor)
        .is_some_and(|byte| matches!(byte, b' ' | b'\n' | b'\r' | b'\t'))
    {
        *cursor += 1;
    }
}

fn skip_json_string(bytes: &[u8], cursor: &mut usize) {
    *cursor += 1; // opening quote
    while bytes[*cursor] != b'"' {
        if bytes[*cursor] == b'\\' {
            *cursor += 2;
        } else {
            *cursor += 1;
        }
    }
    *cursor += 1;
}

fn skip_json_value(bytes: &[u8], cursor: &mut usize) {
    match bytes[*cursor] {
        b'"' => skip_json_string(bytes, cursor),
        b'{' | b'[' => {
            let mut stack = vec![bytes[*cursor]];
            *cursor += 1;
            while !stack.is_empty() {
                match bytes[*cursor] {
                    b'"' => skip_json_string(bytes, cursor),
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
                .is_some_and(|byte| !matches!(byte, b',' | b'}' | b' ' | b'\n' | b'\r' | b'\t'))
            {
                *cursor += 1;
            }
        }
    }
}

/// Extracts the last root field from a stored JSON object; all read/parse/shape
/// failures use the Node-compatible default.
pub fn get(state_file: &Path, _home: &Path) -> RootValue {
    let root = fs::read_to_string(state_file)
        .ok()
        .and_then(|text| stored_root(&text))
        .unwrap_or_else(|| RootValue::from_token("\"~/wiki\"".into()).expect("constant"));
    root
}

pub(crate) fn stored_root(text: &str) -> Option<RootValue> {
    let raw = raw_root(text).ok()??;
    RootValue::from_token(raw.get().to_owned()).ok()
}

/// Persist a valid raw JSON string token. Write errors are returned verbatim.
pub fn set(state_file: &Path, _home: &Path, root: Option<RootValue>) -> SetResponse {
    let Some(root) = root else {
        return SetResponse {
            ok: false,
            root: None,
            error: Some("bad root".into()),
        };
    };
    let mut bytes = b"{\"root\":".to_vec();
    if let Err(error) = serde_json::to_writer(&mut bytes, &root.0) {
        return SetResponse {
            ok: false,
            root: None,
            error: Some(error.to_string()),
        };
    }
    bytes.push(b'}');
    if let Some(parent) = state_file.parent() {
        if let Err(error) = fs::create_dir_all(parent) {
            return SetResponse {
                ok: false,
                root: None,
                error: Some(error.to_string()),
            };
        }
    }
    match fs::write(state_file, bytes) {
        Ok(()) => SetResponse {
            ok: true,
            root: Some(root),
            error: None,
        },
        Err(error) => SetResponse {
            ok: false,
            root: None,
            error: Some(error.to_string()),
        },
    }
}

/// Resolves a JavaScript string path lexically against explicit home and cwd.
pub fn resolve(raw: &str, home: &Path, cwd: &Path) -> PathBuf {
    filesystem_path(&resolve_raw_units(
        &raw.encode_utf16().collect::<Vec<_>>(),
        home,
        cwd,
        cfg!(windows),
    ))
}

/// Converts a raw path to an OS path for callers that need a filesystem path.
/// Authorization uses `resolve_raw_units` directly and never loses code units.
pub fn resolve_raw(raw: &RootValue, home: &Path, cwd: &Path) -> Option<PathBuf> {
    resolve_raw_with_drive_cwds(raw, home, cwd, &[])
}

/// Resolves a raw root using explicit Node per-drive cwd context, when known.
pub fn resolve_raw_with_drive_cwds(
    raw: &RootValue,
    home: &Path,
    cwd: &Path,
    drive_cwds: &[(u16, PathBuf)],
) -> Option<PathBuf> {
    let units = raw.units().ok()?;
    let drive_cwds: Vec<(u16, Vec<u16>)> = drive_cwds
        .iter()
        .map(|(drive, path)| (*drive, path_units(path)))
        .collect();
    let resolved = resolve_raw_units_with_drive_cwds(&units, home, cwd, cfg!(windows), &drive_cwds);
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStringExt;
        Some(PathBuf::from(OsString::from_wide(&resolved)))
    }
    #[cfg(not(windows))]
    {
        Some(PathBuf::from(String::from_utf16_lossy(&resolved)))
    }
}

/// Pure UTF-16 lexical resolution. Keep JavaScript code units intact until the
/// filesystem boundary; Rust strings cannot represent isolated surrogates.
fn resolve_raw_units(units: &[u16], home: &Path, cwd: &Path, windows: bool) -> Vec<u16> {
    resolve_raw_units_with(units, home, cwd, windows, true)
}

fn resolve_raw_units_with(
    units: &[u16],
    home: &Path,
    cwd: &Path,
    windows: bool,
    expand_tilde: bool,
) -> Vec<u16> {
    let home = path_units(home);
    let cwd = path_units(cwd);
    if windows {
        return resolve_windows_units_with(units, &home, &cwd, &[], expand_tilde);
    }
    let is_sep = |unit: u16| unit == b'/' as u16 || (windows && unit == b'\\' as u16);
    let tilde = expand_tilde
        && units.first() == Some(&(b'~' as u16))
        && (units.len() == 1 || units.get(1).is_some_and(|unit| is_sep(*unit)));
    let tail = if tilde { &units[1..] } else { units };
    let mut input = if tilde {
        let mut joined = home;
        if !tail.is_empty() {
            joined.push(if windows { b'\\' as u16 } else { b'/' as u16 });
            joined.extend(tail.iter().copied().skip_while(|unit| is_sep(*unit)));
        }
        joined
    } else if is_absolute_units(units, windows) {
        units.to_vec()
    } else {
        let mut joined = cwd;
        joined.push(if windows { b'\\' as u16 } else { b'/' as u16 });
        joined.extend_from_slice(units);
        joined
    };
    normalize_units(&mut input, windows);
    input
}

fn path_units(path: &Path) -> Vec<u16> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        path.as_os_str().encode_wide().collect()
    }
    #[cfg(not(windows))]
    {
        path.to_string_lossy().encode_utf16().collect()
    }
}

fn is_absolute_units(units: &[u16], windows: bool) -> bool {
    units
        .first()
        .is_some_and(|unit| *unit == b'/' as u16 || (windows && *unit == b'\\' as u16))
        || (windows && units.get(1) == Some(&(b':' as u16)))
}

fn normalize_units(units: &mut Vec<u16>, windows: bool) {
    if windows {
        *units = resolve_windows_units(units, &[], &[], &[]);
        return;
    }
    let separator = if windows { b'\\' as u16 } else { b'/' as u16 };
    if windows {
        units.iter_mut().for_each(|unit| {
            if *unit == b'/' as u16 {
                *unit = separator;
            }
        });
    }
    let absolute = is_absolute_units(units, windows);
    let drive = windows && units.get(1) == Some(&(b':' as u16));
    let unc = windows && units.starts_with(&[b'\\' as u16, b'\\' as u16]);
    let prefix = if drive {
        3
    } else if unc {
        2
    } else if absolute {
        1
    } else {
        0
    };
    let mut parts: Vec<Vec<u16>> = Vec::new();
    for part in units[prefix..]
        .split(|unit| *unit == separator)
        .filter(|part| !part.is_empty())
    {
        if part == [b'.' as u16] {
            continue;
        }
        if part == [b'.' as u16, b'.' as u16] {
            if !parts.is_empty()
                && parts
                    .last()
                    .is_some_and(|last| last != &[b'.' as u16, b'.' as u16])
            {
                parts.pop();
            } else if !absolute {
                parts.push(part.to_vec());
            }
        } else {
            parts.push(part.to_vec());
        }
    }
    let mut result = units[..prefix.min(units.len())].to_vec();
    if absolute && !drive {
        result = if unc {
            vec![separator, separator]
        } else {
            vec![separator]
        };
    }
    if drive && result.len() == 2 {
        result.push(separator);
    }
    for part in parts {
        if !result.is_empty() && result.last() != Some(&separator) {
            result.push(separator);
        }
        result.extend(part);
    }
    *units = result;
}

/// Resolves Windows device, root, and path components while preserving UTF-16
/// code units. `drive_cwds` carries Node's hidden per-drive cwd values when a
/// caller has them; absent a value, another drive-relative path uses its root.
fn resolve_windows_units(
    units: &[u16],
    home: &[u16],
    cwd: &[u16],
    drive_cwds: &[(u16, Vec<u16>)],
) -> Vec<u16> {
    resolve_windows_units_with(units, home, cwd, drive_cwds, true)
}

fn resolve_windows_units_with(
    units: &[u16],
    home: &[u16],
    cwd: &[u16],
    drive_cwds: &[(u16, Vec<u16>)],
    expand_tilde: bool,
) -> Vec<u16> {
    const SEP: u16 = b'\\' as u16;
    const COLON: u16 = b':' as u16;
    let is_sep = |unit: u16| unit == SEP || unit == b'/' as u16;
    let is_drive = |path: &[u16]| {
        path.len() >= 2
            && path[1] == COLON
            && ((b'A' as u16..=b'Z' as u16).contains(&path[0])
                || (b'a' as u16..=b'z' as u16).contains(&path[0]))
    };
    let mut input = units.to_vec();
    for unit in &mut input {
        if *unit == b'/' as u16 {
            *unit = SEP;
        }
    }

    let tilde = expand_tilde
        && input.first() == Some(&(b'~' as u16))
        && (input.len() == 1 || is_sep(input[1]));
    if tilde {
        let mut expanded = home.to_vec();
        let tail = input[1..]
            .iter()
            .copied()
            .skip_while(|unit| is_sep(*unit))
            .collect::<Vec<_>>();
        if !tail.is_empty() {
            if !expanded.last().is_some_and(|unit| is_sep(*unit)) {
                expanded.push(SEP);
            }
            expanded.extend(tail);
        }
        input = expanded;
    }

    let cwd_normalized = normalize_windows_absolute(cwd);
    let cwd_device = if is_drive(&cwd_normalized) {
        cwd_normalized[..2].to_vec()
    } else {
        Vec::new()
    };
    let resolved = if input.starts_with(&[SEP, SEP])
        || (is_drive(&input) && input.len() > 2 && is_sep(input[2]))
    {
        input
    } else if is_drive(&input) {
        let device = input[..2].to_vec();
        let supplied_cwd = drive_cwds
            .iter()
            .find(|(drive, _)| lowercase_units(&[*drive, COLON]) == lowercase_units(&device))
            .map(|(_, path)| path.as_slice());
        let base =
            if !cwd_device.is_empty() && lowercase_units(&device) == lowercase_units(&cwd_device) {
                cwd_normalized
            } else {
                let candidate = supplied_cwd
                    .filter(|path| !path.is_empty())
                    .unwrap_or(&cwd_normalized);
                let candidate_has_other_absolute_device = is_drive(candidate)
                    && lowercase_units(&candidate[..2]) != lowercase_units(&device)
                    && candidate.get(2) == Some(&SEP);
                let candidate = normalize_windows_absolute(candidate);
                if supplied_cwd.is_none() || supplied_cwd.is_some_and(|path| path.is_empty()) {
                    if candidate_has_other_absolute_device {
                        [device.as_slice(), &[SEP]].concat()
                    } else {
                        candidate
                    }
                } else if candidate_has_other_absolute_device {
                    [device.as_slice(), &[SEP]].concat()
                } else if is_drive(&candidate)
                    && lowercase_units(&candidate[..2]) == lowercase_units(&device)
                {
                    candidate
                } else if candidate.starts_with(&[SEP, SEP]) {
                    // A mismatched UNC device is skipped by Node's resolver.
                    device.clone()
                } else if is_drive(&candidate) {
                    // Node skips a per-drive cwd with another device unless its
                    // root mismatch triggered the drive-root fallback above.
                    device.clone()
                } else {
                    [device.as_slice(), candidate.as_slice()].concat()
                }
            };
        if is_drive(&base) && base.len() == 2 {
            [base.as_slice(), &input[2..]].concat()
        } else {
            join_windows_path(&base, &input[2..])
        }
    } else if input.first().is_some_and(|unit| is_sep(*unit)) {
        let base = if cwd_device.is_empty() {
            Vec::new()
        } else {
            cwd_device
        };
        join_windows_path(
            &[base.as_slice(), &[SEP]].concat(),
            &input
                .iter()
                .copied()
                .skip_while(|unit| is_sep(*unit))
                .collect::<Vec<_>>(),
        )
    } else {
        join_windows_path(&cwd_normalized, &input)
    };
    let unc = resolved.starts_with(&[SEP, SEP]);
    let mut parts: Vec<Vec<u16>> = Vec::new();
    let mut prefix;
    let payload: &[u16];
    if unc {
        let raw_parts: Vec<Vec<u16>> = resolved[2..]
            .split(|unit| is_sep(*unit))
            .filter(|part| !part.is_empty())
            .map(<[u16]>::to_vec)
            .collect();
        prefix = vec![SEP, SEP];
        if let Some(server) = raw_parts.first() {
            prefix.extend(server);
        }
        prefix.push(SEP);
        if let Some(share) = raw_parts.get(1) {
            prefix.extend(share);
        }
        prefix.push(SEP);
        for part in raw_parts.iter().skip(2) {
            push_windows_part(&mut parts, part);
        }
    } else if is_drive(&resolved) {
        let drive_absolute = resolved.get(2).is_some_and(|unit| is_sep(*unit));
        let prefix_end = if drive_absolute { 3 } else { 2 }.min(resolved.len());
        prefix = resolved[..prefix_end].to_vec();
        payload = &resolved[prefix_end..];
        for part in payload
            .split(|unit| is_sep(*unit))
            .filter(|part| !part.is_empty())
        {
            push_windows_part(&mut parts, part);
        }
    } else {
        prefix = if resolved.first().is_some_and(|unit| is_sep(*unit)) {
            vec![SEP]
        } else {
            Vec::new()
        };
        payload = &resolved[prefix.len().min(resolved.len())..];
        for part in payload
            .split(|unit| is_sep(*unit))
            .filter(|part| !part.is_empty())
        {
            push_windows_part(&mut parts, part);
        }
    }
    let mut result = prefix;
    let drive_relative = is_drive(&resolved) && !resolved.get(2).is_some_and(|unit| is_sep(*unit));
    for (index, part) in parts.into_iter().enumerate() {
        if !result.last().is_some_and(|unit| is_sep(*unit)) && !(drive_relative && index == 0) {
            result.push(SEP);
        }
        result.extend(part);
    }
    if result.is_empty() {
        result.push(SEP);
    }
    result
}

fn join_windows_path(base: &[u16], tail: &[u16]) -> Vec<u16> {
    if base.is_empty() {
        return tail.to_vec();
    }
    let mut joined = base.to_vec();
    if !joined
        .last()
        .is_some_and(|unit| *unit == b'\\' as u16 || *unit == b'/' as u16)
    {
        joined.push(b'\\' as u16);
    }
    joined.extend_from_slice(tail);
    joined
}

fn normalize_windows_absolute(path: &[u16]) -> Vec<u16> {
    let mut normalized = path.to_vec();
    for unit in &mut normalized {
        if *unit == b'/' as u16 {
            *unit = b'\\' as u16;
        }
    }
    if normalized.starts_with(&[b'\\' as u16, b'\\' as u16])
        || (normalized.len() >= 3 && normalized[1] == b':' as u16 && normalized[2] == b'\\' as u16)
    {
        resolve_windows_units(&normalized, &[], &[], &[])
    } else {
        normalized
    }
}

fn push_windows_part(parts: &mut Vec<Vec<u16>>, part: &[u16]) {
    if part == [b'.' as u16] {
        return;
    }
    if part == [b'.' as u16, b'.' as u16] {
        if parts
            .last()
            .is_some_and(|last| last != &[b'.' as u16, b'.' as u16])
        {
            parts.pop();
        }
        return;
    }
    parts.push(part.to_vec());
}

pub fn authorize(root: &str, target: &str, persisted: &str, home: &Path, cwd: &Path) -> bool {
    let expected = resolve(persisted, home, cwd);
    let supplied = resolve(root, home, cwd);
    if !same_path(&expected, &supplied) {
        return false;
    }
    let target = resolve(target, home, cwd);
    target.strip_prefix(&expected).is_ok()
        && target.to_string_lossy().to_lowercase().ends_with(".md")
}

pub fn authorize_raw(
    root: &RootValue,
    target: &RootValue,
    persisted: &RootValue,
    home: &Path,
    cwd: &Path,
) -> bool {
    authorize_raw_with_drive_cwds(root, target, persisted, home, cwd, &[])
}

/// Windows callers that know Node's per-drive cwd state pass those paths here.
/// The HTTP bridge must provide each available hidden `=X:` environment value.
pub fn authorize_raw_with_drive_cwds(
    root: &RootValue,
    target: &RootValue,
    persisted: &RootValue,
    home: &Path,
    cwd: &Path,
    drive_cwds: &[(u16, PathBuf)],
) -> bool {
    let Ok(expected_input) = persisted.units() else {
        return false;
    };
    let Ok(supplied_input) = root.units() else {
        return false;
    };
    let windows = cfg!(windows);
    let drive_cwds: Vec<(u16, Vec<u16>)> = drive_cwds
        .iter()
        .map(|(drive, path)| (*drive, path_units(path)))
        .collect();
    let expected =
        resolve_raw_units_with_drive_cwds(&expected_input, home, cwd, windows, &drive_cwds);
    let supplied =
        resolve_raw_units_with_drive_cwds(&supplied_input, home, cwd, windows, &drive_cwds);
    if !same_units(&expected, &supplied, windows) {
        return false;
    }
    let Ok(target_input) = target.units() else {
        return false;
    };
    let target = resolve_raw_units_with_drive_cwds(&target_input, home, cwd, windows, &drive_cwds);
    contained_units(&expected, &target, windows)
        && lowercase_units(&target).ends_with(&[46, 109, 100])
}

fn resolve_raw_units_with_drive_cwds(
    units: &[u16],
    home: &Path,
    cwd: &Path,
    windows: bool,
    drive_cwds: &[(u16, Vec<u16>)],
) -> Vec<u16> {
    if windows {
        resolve_windows_units(units, &path_units(home), &path_units(cwd), drive_cwds)
    } else {
        resolve_raw_units(units, home, cwd, false)
    }
}

/// Crate-private primitive for the memory path policy: pure UTF-16 lexical
/// resolution with an explicit platform and Node's per-drive cwd inputs.
///
/// `expand_tilde` mirrors `server/memory.mjs` `resolveRoot`: `~`, `~/`, and
/// `~\` all expand by appending the remainder to home before normalization
/// (on POSIX `~\x` therefore keeps a literal backslash, as `memory.mjs` does).
/// Targets pass `false`, because Node's `resolve` never expands `~`. Wiki
/// callers keep their own tilde rules through the wrappers above.
#[allow(dead_code)] // consumed by the incoming memory module
pub(crate) fn resolve_units(
    units: &[u16],
    home: &Path,
    cwd: &Path,
    drive_cwds: &[(u16, PathBuf)],
    windows: bool,
    expand_tilde: bool,
) -> Vec<u16> {
    let expanded = (expand_tilde
        && units.first() == Some(&(b'~' as u16))
        && (units.len() == 1
            || units
                .get(1)
                .is_some_and(|unit| *unit == b'/' as u16 || *unit == b'\\' as u16)))
    .then(|| [path_units(home).as_slice(), &units[1..]].concat());
    let units = expanded.as_deref().unwrap_or(units);
    if windows {
        let drive_cwds: Vec<(u16, Vec<u16>)> = drive_cwds
            .iter()
            .map(|(drive, path)| (*drive, path_units(path)))
            .collect();
        resolve_windows_units_with(
            units,
            &path_units(home),
            &path_units(cwd),
            &drive_cwds,
            false,
        )
    } else {
        resolve_raw_units_with(units, home, cwd, false, false)
    }
}

pub(crate) fn same_units(a: &[u16], b: &[u16], windows: bool) -> bool {
    if windows {
        lowercase_units(a) == lowercase_units(b)
    } else {
        a == b
    }
}

pub(crate) fn contained_units(root: &[u16], target: &[u16], windows: bool) -> bool {
    if !windows {
        return target == root
            || (target.starts_with(root) && target.get(root.len()) == Some(&(b'/' as u16)));
    }
    let mut root = lowercase_units(root);
    let mut target = lowercase_units(target);
    root.iter_mut().chain(target.iter_mut()).for_each(|unit| {
        if *unit == b'/' as u16 {
            *unit = b'\\' as u16;
        }
    });
    target == root
        || (target.starts_with(&root)
            && (root.last() == Some(&(b'\\' as u16))
                || target.get(root.len()) == Some(&(b'\\' as u16))))
}

fn same_path_raw(a: &Path, b: &Path) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        lowercase_units(&a.as_os_str().encode_wide().collect::<Vec<_>>())
            == lowercase_units(&b.as_os_str().encode_wide().collect::<Vec<_>>())
    }
    #[cfg(not(windows))]
    {
        a == b
    }
}

fn lowercase_units(units: &[u16]) -> Vec<u16> {
    let mut result = Vec::new();
    let mut scalar_span = String::new();
    let mut index = 0;
    while index < units.len() {
        let first = units[index];
        if (0xd800..=0xdbff).contains(&first)
            && units
                .get(index + 1)
                .is_some_and(|unit| (0xdc00..=0xdfff).contains(unit))
        {
            let scalar =
                0x10000 + (((first as u32 - 0xd800) << 10) | (units[index + 1] as u32 - 0xdc00));
            if let Some(ch) = char::from_u32(scalar) {
                scalar_span.push(ch);
            }
            index += 2;
        } else if (0xd800..=0xdfff).contains(&first) {
            append_lowercase_span(&mut result, &scalar_span);
            scalar_span.clear();
            result.push(first);
            index += 1;
        } else {
            if let Some(ch) = char::from_u32(first as u32) {
                scalar_span.push(ch);
            }
            index += 1;
        }
    }
    append_lowercase_span(&mut result, &scalar_span);
    result
}

fn append_lowercase_span(output: &mut Vec<u16>, span: &str) {
    output.extend(span.to_lowercase().encode_utf16());
}

fn same_path(a: &Path, b: &Path) -> bool {
    #[cfg(windows)]
    {
        a.to_string_lossy().to_lowercase() == b.to_string_lossy().to_lowercase()
    }
    #[cfg(not(windows))]
    {
        a == b
    }
}

pub fn available(persisted: &RootValue, home: &Path, cwd: &Path) -> bool {
    available_with_drive_cwds(persisted, home, cwd, &[])
}

/// Capability probe variant that preserves Node's per-drive cwd context.
pub fn available_with_drive_cwds(
    persisted: &RootValue,
    home: &Path,
    cwd: &Path,
    drive_cwds: &[(u16, PathBuf)],
) -> bool {
    let Ok(root) = persisted.units() else {
        return false;
    };
    let drive_cwds: Vec<(u16, Vec<u16>)> = drive_cwds
        .iter()
        .map(|(drive, path)| (*drive, path_units(path)))
        .collect();
    let root = resolve_raw_units_with_drive_cwds(&root, home, cwd, cfg!(windows), &drive_cwds);
    let root = filesystem_path(&root);
    fs::read_dir(root).ok().is_some_and(|entries| {
        entries.filter_map(Result::ok).any(|entry| {
            let name = entry.file_name();
            !name.to_string_lossy().starts_with('.')
                && entry.file_type().is_ok_and(|kind| kind.is_dir())
        })
    })
}

/// Node filesystem string APIs convert isolated UTF-16 surrogates to U+FFFD;
/// lexical comparisons above retain the original code units.
fn filesystem_path(units: &[u16]) -> PathBuf {
    #[cfg(windows)]
    {
        PathBuf::from(String::from_utf16_lossy(units))
    }
    #[cfg(not(windows))]
    {
        PathBuf::from(String::from_utf16_lossy(units))
    }
}

/// Serializes a correlated response without routing the raw root through Value.
pub fn correlated_root_json(id: &str, root: &RootValue) -> Result<String, serde_json::Error> {
    #[derive(Serialize)]
    struct Body<'a> {
        root: &'a RootValue,
    }
    #[derive(Serialize)]
    struct Envelope<'a> {
        id: &'a str,
        body: Body<'a>,
    }
    serde_json::to_string(&Envelope {
        id,
        body: Body { root },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(windows)]
    use std::os::windows::ffi::OsStrExt as TestOsStrExt;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn memory_drive_cwds_preserve_present_and_empty_values() {
        let drives = drive_cwds_from(|key| match key {
            "=C:" => Some(OsString::from(r"C:\work")),
            "=D:" => Some(OsString::new()),
            _ => None,
        });
        assert_eq!(
            drives,
            vec![
                (b'C' as u16, PathBuf::from(r"C:\work")),
                (b'D' as u16, PathBuf::new()),
            ]
        );
    }

    fn fixture(owner: &str) -> PathBuf {
        let base = std::env::temp_dir().join(format!(
            "wiki-root-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        println!("[wiki-fixture] owner={owner} allocated={}", base.display());
        base
    }

    fn cleanup_fixture(owner: &str, base: &Path) {
        println!(
            "[wiki-fixture] owner={owner} cleanup-start={}",
            base.display()
        );
        let result = fs::remove_dir_all(base);
        println!(
            "[wiki-fixture] owner={owner} cleanup-result={result:?} remains={}",
            base.exists()
        );
    }

    #[test]
    fn raw_transport_dispatches_wiki_envelopes_before_value_parsing() {
        let text = r#"{"op":"wiki_root_set","id":"raw-1","state_file":"state.json","home":"home","root":"first","root":"\ud800","ignored":1e400,"\ud800":18446744073709551616}"#;
        let request = parse_wire_request(text).unwrap().unwrap();
        assert_eq!(request.op, "wiki_root_set");
        assert_eq!(request.id, Some(serde_json::json!("raw-1")));
        assert_eq!(request.root.unwrap().units().unwrap(), vec![0xd800]);
        let raw_path = parse_wire_request(
            r#"{"op":"wiki_root_authorize","root":"r","path":"a\ud800b.md","state_file":"s","home":"h","cwd":"c"}"#,
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            raw_path.path.unwrap().units().unwrap(),
            vec![97, 0xd800, 98, 46, 109, 100]
        );

        let ignored_lone_key = r#"{"op":"wiki_root_get","id":"raw-2","state_file":"state.json","home":"home","\ud800":1e400}"#;
        assert_eq!(
            parse_wire_request(ignored_lone_key).unwrap().unwrap().op,
            "wiki_root_get"
        );
        assert!(parse_wire_request(r#"{"op":"wiki_root_get","broken":}"#).is_err());
        assert!(
            parse_wire_request(r#"{"op":"wiki_root_get","root":1,"root":""}"#)
                .unwrap()
                .unwrap()
                .root
                .is_none()
        );
        let missing_root =
            parse_wire_request(r#"{"op":"wiki_root_set","state_file":"s","home":"h"}"#)
                .unwrap()
                .unwrap();
        assert_eq!(
            dispatch_wire(&missing_root).unwrap(),
            r#"{"ok":false,"error":"bad root"}"#
        );
    }

    #[test]
    fn raw_transport_dispatches_all_four_operations_with_drive_context() {
        let base = fixture("raw_transport_dispatches_all_four_operations_with_drive_context");
        fs::create_dir_all(base.join("wiki").join("visible")).unwrap();
        fs::write(base.join("wiki").join("page.md"), "page").unwrap();
        let state = base.join("state").join("wiki-root.json");
        let home = base.join("home");
        let cwd = base.clone();
        let root = base.join("wiki").to_string_lossy().to_string();
        let request = |op: &str, extra: &str| {
            format!(
                r#"{{"op":"{op}","id":"wire-{op}","state_file":{},"home":{},"cwd":{},"drive_cwds":[{{"drive":"D","path":"D:\\\\docs"}}]{extra}}}"#,
                serde_json::to_string(&state).unwrap(),
                serde_json::to_string(&home).unwrap(),
                serde_json::to_string(&cwd).unwrap()
            )
        };
        let set = parse_wire_request(&request(
            "wiki_root_set",
            &format!(",\"root\":{}", serde_json::to_string(&root).unwrap()),
        ))
        .unwrap()
        .unwrap();
        assert_eq!(
            dispatch_wire(&set).unwrap(),
            format!(
                r#"{{"ok":true,"root":{}}}"#,
                serde_json::to_string(&root).unwrap()
            )
        );
        let get = parse_wire_request(&request("wiki_root_get", ""))
            .unwrap()
            .unwrap();
        assert_eq!(
            dispatch_wire(&get).unwrap(),
            format!(r#"{{"root":{}}}"#, serde_json::to_string(&root).unwrap())
        );
        let available = parse_wire_request(&request("wiki_root_available", ""))
            .unwrap()
            .unwrap();
        assert_eq!(dispatch_wire(&available).unwrap(), r#"{"available":true}"#);
        let authorize = parse_wire_request(&request(
            "wiki_root_authorize",
            &format!(
                ",\"root\":{},\"path\":{}",
                serde_json::to_string(&root).unwrap(),
                serde_json::to_string(&base.join("wiki/page.md")).unwrap()
            ),
        ))
        .unwrap()
        .unwrap();
        assert_eq!(dispatch_wire(&authorize).unwrap(), r#"{"authorized":true}"#);
        let nul_target = parse_wire_request(&request(
            "wiki_root_authorize",
            &format!(
                ",\"root\":{},\"path\":{}",
                serde_json::to_string(&root).unwrap(),
                serde_json::to_string(&format!("{}\\nul\0.md", root)).unwrap()
            ),
        ))
        .unwrap()
        .unwrap();
        assert_eq!(
            dispatch_wire(&nul_target).unwrap(),
            r#"{"authorized":false}"#
        );
        cleanup_fixture(
            "raw_transport_dispatches_all_four_operations_with_drive_context",
            &base,
        );
    }

    #[test]
    fn raw_transport_duplicate_overflow_and_surrogates() {
        let root = request_root(r#"{"id":"x","root":"first","root":"\ud800","huge":1e400,"integer":184467440737095516160}"#).unwrap().unwrap();
        assert_eq!(root.units().unwrap(), vec![0xd800]);
        assert_eq!(
            correlated_root_json("x", &root).unwrap(),
            r#"{"id":"x","body":{"root":"\ud800"}}"#
        );
        assert!(request_root("{").is_err());
        assert!(request_root("null").is_err());
        assert!(request_root(r#"{"root":""}"#).unwrap().is_none());
        assert!(request_root(r#"{"root":1e400,"extra":1e400}"#).is_ok());
        assert!(
            request_root(r#"{"root":7,"extra":184467440737095516160}"#)
                .unwrap()
                .is_none()
        );
        assert!(
            request_root(r#"{"\ud800":184467440737095516160,"root":"ok"}"#)
                .unwrap()
                .is_some()
        );
        assert_eq!(
            request_root(r#"{"root":"a\u0000b"}"#)
                .unwrap()
                .unwrap()
                .units()
                .unwrap(),
            vec![97, 0, 98]
        );
        assert_eq!(
            request_root(r#"{"root":"\ud800\udc00\ud801"}"#)
                .unwrap()
                .unwrap()
                .units()
                .unwrap(),
            vec![0xd800, 0xdc00, 0xd801]
        );
        assert!(
            request_root(r#"{"ignored":{"nested":["text",{"key":"value"}]},"root":"ok"}"#)
                .unwrap()
                .is_some()
        );
        let lone = RootValue::from_token(r#""\ud800""#.into()).unwrap();
        #[cfg(not(windows))]
        assert!(resolve_raw(&lone, Path::new("/home/test"), Path::new("/work")).is_some());
        #[cfg(windows)]
        {
            use std::os::windows::ffi::OsStrExt;
            let resolved =
                resolve_raw(&lone, Path::new(r"C:\home\test"), Path::new(r"C:\work")).unwrap();
            assert!(
                resolved
                    .as_os_str()
                    .encode_wide()
                    .any(|unit| unit == 0xd800)
            );
        }
    }

    #[test]
    fn stored_state_defaults_and_duplicate_last_wins() {
        assert!(stored_root("{").is_none());
        assert!(stored_root("null").is_none());
        assert!(stored_root(r#"{"root":""}"#).is_none());
        assert_eq!(
            stored_root(r#"{"root":"a","root":"b","ignored":1e400}"#)
                .unwrap()
                .units()
                .unwrap(),
            vec![98]
        );
        assert_eq!(
            stored_root(r#"{"\ud800":184467440737095516160,"root":"ok"}"#)
                .unwrap()
                .units()
                .unwrap(),
            vec![111, 107]
        );
        assert!(stored_root(r#"{"root":"ok"} trailing"#).is_none());
        for whitespace in ["\u{00a0}", "\u{feff}"] {
            assert!(stored_root(&format!("{whitespace}{{\"root\":\"kept\"}}")).is_none());
            assert!(request_root(&format!("{whitespace}{{\"root\":\"kept\"}}")).is_err());
        }
        assert_eq!(
            stored_root(" \t\r\n{\"root\":\"kept\"}\n\t ")
                .unwrap()
                .units()
                .unwrap(),
            vec![107, 101, 112, 116]
        );
        assert_eq!(
            request_root(" \t\r\n{\"root\":\"kept\"}\n\t ")
                .unwrap()
                .unwrap()
                .units()
                .unwrap(),
            vec![107, 101, 112, 116]
        );
    }

    #[test]
    fn contextual_casefold_and_raw_path_identity() {
        assert_eq!(
            lowercase_units(&"ΟΣ".encode_utf16().collect::<Vec<_>>()),
            "ος".encode_utf16().collect::<Vec<_>>()
        );
        assert_eq!(
            lowercase_units(&[0x039f, 0x034f, 0x03a3]),
            "ο͏ς".encode_utf16().collect::<Vec<_>>()
        );
        #[cfg(windows)]
        {
            use std::os::windows::ffi::OsStringExt;
            let lone = PathBuf::from(OsString::from_wide(&[
                b'C' as u16,
                b':' as u16,
                b'\\' as u16,
                0xd800,
            ]));
            let replacement = PathBuf::from(OsString::from_wide(&[
                b'C' as u16,
                b':' as u16,
                b'\\' as u16,
                0xfffd,
            ]));
            assert!(!same_path_raw(&lone, &replacement));
            let base = fixture("raw_path_units_preserve_surrogates_on_windows");
            let alias_root = base.join("root-�");
            fs::create_dir_all(alias_root.join("visible-child")).unwrap();
            let raw_units = alias_root.as_os_str().encode_wide().collect::<Vec<_>>();
            assert_eq!(filesystem_path(&raw_units), alias_root);
            let raw_token = serde_json::to_string(&String::from_utf16_lossy(&raw_units))
                .unwrap()
                .replace('�', "\\ud800");
            let raw_root = RootValue::from_token(raw_token).unwrap();
            assert!(available(&raw_root, &base, &base));
            cleanup_fixture("raw_path_units_preserve_surrogates_on_windows", &base);
        }
    }

    #[test]
    fn raw_path_units_keep_surrogates_through_lexical_policy() {
        let home = Path::new("/home/test");
        let cwd = Path::new("/work");
        let path = |s: &str| s.encode_utf16().collect::<Vec<_>>();
        let root = path("/work/wiki");
        let target = path("/work/wiki/lone-\u{fffd}.md");
        let raw_target = path("/work/wiki/lone-\u{fffd}.md");
        let mut raw_target = raw_target;
        let marker = raw_target.iter().position(|unit| *unit == 0xfffd).unwrap();
        raw_target[marker] = 0xd800;
        let actual = resolve_raw_units(&raw_target, home, cwd, false);
        assert!(contained_units(&root, &actual, false));
        assert!(!same_units(&actual, &target, false));
        assert!(lowercase_units(&actual).ends_with(&[46, 109, 100]));
        let root = RootValue::from_token(r#""/work/wiki""#.into()).unwrap();
        let file = RootValue::from_token(r#""/work/wiki/lone-\ud800.md""#.into()).unwrap();
        assert!(authorize_raw(&root, &file, &root, home, cwd));
        assert!(!authorize_raw(&root, &root, &root, home, cwd));
        let sibling = RootValue::from_token(r#""/work/wiki-neighbor/a.md""#.into()).unwrap();
        assert!(!authorize_raw(&root, &sibling, &root, home, cwd));
    }

    #[test]
    fn windows_raw_path_parity_cases() {
        let scalar_path_value =
            |path: &str| RootValue::from_token(serde_json::to_string(path).unwrap()).unwrap();
        let home = Path::new(r"C:\Users\test");
        let cwd = Path::new(r"C:\work");
        let units = |s: &str| s.encode_utf16().collect::<Vec<_>>();
        let root = resolve_raw_units(&units(r"C:\work\wiki\."), home, cwd, true);
        for target in [r"C:/work/wiki/child/../a.MD", r"C:\work\WIKI\a.md"] {
            let target = resolve_raw_units(&units(target), home, cwd, true);
            assert!(contained_units(&root, &target, true));
            assert!(lowercase_units(&target).ends_with(&[46, 109, 100]));
        }
        assert!(same_units(
            &root,
            &resolve_raw_units(&units(r"c:\WORK\wiki"), home, cwd, true),
            true
        ));
        assert!(!contained_units(
            &root,
            &resolve_raw_units(&units(r"C:\work\wiki-neighbor\a.md"), home, cwd, true),
            true
        ));
        assert!(contained_units(&root, &root, true));
        assert!(!lowercase_units(&root).ends_with(&[46, 109, 100]));
        assert!(contained_units(
            &units(r"C:\"),
            &resolve_raw_units(&units(r"C:\wiki\a.md"), home, cwd, true),
            true
        ));
        assert!(same_units(
            &resolve_raw_units(&units(r"\\server\share\wiki"), home, cwd, true),
            &resolve_raw_units(&units(r"\\SERVER\SHARE\wiki\."), home, cwd, true),
            true
        ));
        let root_value = RootValue::from_token(r#""C:\\work\\wiki""#.into()).unwrap();
        let target_value = RootValue::from_token(r#""C:/work/WIKI/child/../a.MD""#.into()).unwrap();
        assert!(authorize_raw(
            &root_value,
            &target_value,
            &root_value,
            home,
            cwd
        ));
        assert!(!authorize_raw(
            &root_value,
            &root_value,
            &root_value,
            home,
            cwd
        ));
        let md_root = RootValue::from_token(r#""C:\\work\\root.MD""#.into()).unwrap();
        assert!(authorize_raw(&md_root, &md_root, &md_root, home, cwd));
        assert!(same_units(
            &resolve_raw_units(&units("~\\wiki"), home, cwd, true),
            &units(r"C:\Users\test\wiki"),
            true
        ));
        assert!(same_units(
            &resolve_raw_units(&units(r"C:\work\wiki.md"), home, cwd, true),
            &resolve_raw_units(&units(r"C:\work\wiki.MD"), home, cwd, true),
            true
        ));
        assert_eq!(
            resolve_raw_units(&units(r"\work\wiki\a.md"), home, cwd, true),
            units(r"C:\work\wiki\a.md")
        );
        assert_eq!(
            resolve_raw_units(&units("C:foo"), home, cwd, true),
            units(r"C:\work\foo")
        );
        assert_eq!(
            resolve_raw_units(&units("D:foo"), home, cwd, true),
            units(r"D:\foo")
        );
        assert_eq!(
            resolve_windows_units(
                &units("D:foo"),
                &units(r"C:\Users\test"),
                &units(r"C:\work"),
                &[(b'D' as u16, units(r"D:\docs"))]
            ),
            units(r"D:\docs\foo")
        );
        assert_eq!(
            resolve_windows_units(
                &units("D:foo"),
                &units(r"C:\Users\test"),
                &units(r"C:\work"),
                &[(b'D' as u16, units(r"C:\other"))]
            ),
            units(r"D:\foo")
        );
        assert_eq!(
            resolve_windows_units(
                &units("D:foo"),
                &units(r"C:\Users\test"),
                &units(r"C:\work"),
                &[(b'D' as u16, units("C:/other"))]
            ),
            units(r"D:foo")
        );
        assert_eq!(
            resolve_windows_units(
                &units("D:foo"),
                &units(r"C:\Users\test"),
                &units(r"C:\work"),
                &[(b'D' as u16, units("docs"))]
            ),
            units(r"D:docs\foo")
        );
        assert_eq!(
            resolve_windows_units(
                &units("D:foo"),
                &units(r"C:\Users\test"),
                &units(r"C:\work"),
                &[(b'D' as u16, units(""))]
            ),
            units(r"D:\foo")
        );
        assert_eq!(
            resolve_windows_units(
                &units("D:foo"),
                &units(r"C:\Users\test"),
                &units(r"C:\work"),
                &[(b'D' as u16, units(r"D:docs"))]
            ),
            units(r"D:docs\foo")
        );
        assert_eq!(
            resolve_windows_units(
                &units("D:foo"),
                &units(r"C:\Users\test"),
                &units(r"C:\work"),
                &[(b'D' as u16, units(r"C:docs"))]
            ),
            units(r"D:foo")
        );
        assert_eq!(
            resolve_windows_units(
                &units("D:foo"),
                &units(r"C:\Users\test"),
                &units(r"C:\work"),
                &[(b'D' as u16, units(r"\\server\share"))]
            ),
            units(r"D:foo")
        );
        assert_eq!(
            resolve_raw_units(&units(r"\\server\share\..\wiki\a.md"), home, cwd, true),
            units(r"\\server\share\wiki\a.md")
        );
        assert_eq!(
            resolve_raw_units(&units(r"C:/work\wiki/./sub/../a.md"), home, cwd, true),
            units(r"C:\work\wiki\a.md")
        );
        assert_eq!(
            resolve_raw_units(&units(r"C:\"), home, cwd, true),
            units(r"C:\")
        );
        assert_eq!(
            resolve_raw_units(&units(r"\\server\share\"), home, cwd, true),
            units(r"\\server\share\")
        );

        let root = scalar_path_value(r"C:\work\wiki");
        let root_relative = scalar_path_value(r"\work\wiki\a.md");
        assert!(authorize_raw(&root, &root_relative, &root, home, cwd));
        let drive_relative = scalar_path_value("D:a.md");
        let drive_root = scalar_path_value(r"D:\docs");
        assert!(authorize_raw_with_drive_cwds(
            &drive_root,
            &drive_relative,
            &drive_root,
            home,
            cwd,
            &[(b'D' as u16, PathBuf::from(r"D:\docs"))],
        ));
    }

    #[test]
    fn persistence_capability_and_lexical_authorization() {
        let base = fixture("persistence_capability_and_lexical_authorization");
        let state = base.join("state/wiki-root.json");
        let root = RootValue::from_token(
            serde_json::to_string(&base.join("wiki").display().to_string()).unwrap(),
        )
        .unwrap();
        assert!(set(&state, &base, Some(root.clone())).ok);
        let wiki = base.join("wiki");
        fs::create_dir_all(wiki.join("child")).unwrap();
        assert!(available(&root, &base, &base));
        assert!(authorize(
            wiki.to_str().unwrap(),
            wiki.join("child/a.MD").to_str().unwrap(),
            wiki.to_str().unwrap(),
            &base,
            &base
        ));
        assert!(!authorize(
            wiki.to_str().unwrap(),
            wiki.to_str().unwrap(),
            wiki.to_str().unwrap(),
            &base,
            &base
        ));
        assert!(!authorize(
            wiki.to_str().unwrap(),
            base.join("wiki-neighbor/a.md").to_str().unwrap(),
            wiki.to_str().unwrap(),
            &base,
            &base
        ));
        let file_parent = base.join("file-as-parent");
        fs::write(&file_parent, "not a directory").unwrap();
        let before = fs::metadata(&file_parent)
            .map(|metadata| (metadata.is_file(), metadata.is_dir(), metadata.len()));
        println!(
            "[wiki-fixture] owner=persistence_capability_and_lexical_authorization before-set base={} base-exists={} file-parent={} metadata={before:?}",
            base.display(),
            base.exists(),
            file_parent.display()
        );
        let bad = set(
            &file_parent.join("state.json"),
            &base,
            Some(RootValue::from_token("\"ok\"".into()).unwrap()),
        );
        let after = fs::metadata(&file_parent)
            .map(|metadata| (metadata.is_file(), metadata.is_dir(), metadata.len()));
        println!(
            "[wiki-fixture] owner=persistence_capability_and_lexical_authorization after-set base={} base-exists={} file-parent={} metadata={after:?} bad.ok={} bad.error={:?}",
            base.display(),
            base.exists(),
            file_parent.display(),
            bad.ok,
            bad.error
        );
        assert!(
            !bad.ok && bad.error.is_some(),
            "unexpected set result for file parent: ok={} error={:?}; before={before:?} after={after:?}; base={} file_parent={}",
            bad.ok,
            bad.error,
            base.display(),
            file_parent.display()
        );
        cleanup_fixture("persistence_capability_and_lexical_authorization", &base);
    }

    #[test]
    fn memory_primitive_expands_root_tilde_but_never_the_target() {
        let home = Path::new("/home/test");
        let cwd = Path::new("/work");
        let units = |s: &str| s.encode_utf16().collect::<Vec<_>>();
        assert_eq!(
            resolve_units(&units("~"), home, cwd, &[], false, true),
            units("/home/test")
        );
        assert_eq!(
            resolve_units(&units("~/.claude/projects"), home, cwd, &[], false, true),
            units("/home/test/.claude/projects")
        );
        // `memory.mjs` accepts `~\` on POSIX; the backslash stays literal.
        assert_eq!(
            resolve_units(&units(r"~\.claude\projects"), home, cwd, &[], false, true),
            units(r"/home/test\.claude\projects")
        );
        assert_eq!(
            resolve_units(&units("~user/a.md"), home, cwd, &[], false, true),
            units("/work/~user/a.md")
        );
        assert_eq!(
            resolve_units(&units("~/wiki/a.md"), home, cwd, &[], false, false),
            units("/work/~/wiki/a.md")
        );
        assert_eq!(
            resolve_units(&units(r"~\wiki\a.md"), home, cwd, &[], false, false),
            units(r"/work/~\wiki\a.md")
        );
    }

    #[test]
    fn memory_primitive_honours_platform_and_drive_cwd_inputs() {
        let home = Path::new(r"C:\Users\test");
        let cwd = Path::new(r"C:\work");
        let units = |s: &str| s.encode_utf16().collect::<Vec<_>>();
        let drive = b'D' as u16;
        assert_eq!(
            resolve_units(
                &units("D:foo"),
                home,
                cwd,
                &[(drive, PathBuf::from(r"D:\docs"))],
                true,
                false
            ),
            units(r"D:\docs\foo")
        );
        assert_eq!(
            resolve_units(&units("D:foo"), home, cwd, &[], true, false),
            units(r"D:\foo")
        );
        assert_eq!(
            resolve_units(&units(r"~\wiki"), home, cwd, &[], true, true),
            units(r"C:\Users\test\wiki")
        );
        assert_eq!(
            resolve_units(&units(r"~\wiki\a.md"), home, cwd, &[], true, false),
            units(r"C:\work\~\wiki\a.md")
        );
        // Platform choice is explicit, so Windows rules run on any host.
        assert_eq!(
            resolve_units(
                &units("C:/work/wiki/./sub/../a.md"),
                home,
                cwd,
                &[],
                true,
                false
            ),
            units(r"C:\work\wiki\a.md")
        );
    }

    #[test]
    fn existing_wiki_resolution_keeps_its_tilde_behaviour() {
        let home = Path::new("/home/test");
        let cwd = Path::new("/work");
        let units = |s: &str| s.encode_utf16().collect::<Vec<_>>();
        assert_eq!(
            resolve_raw_units(&units("~/wiki"), home, cwd, false),
            units("/home/test/wiki")
        );
        assert_eq!(
            resolve_raw_units(&units(r"~\wiki"), home, cwd, false),
            units(r"/work/~\wiki")
        );
        assert_eq!(
            resolve_raw_units_with_drive_cwds(&units("~/wiki/a.md"), home, cwd, false, &[]),
            units("/home/test/wiki/a.md")
        );
    }
}
