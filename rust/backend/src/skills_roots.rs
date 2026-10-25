use crate::transcripts::TranscriptRawText;
use serde::de::{SeqAccess, Visitor};
use serde::{Deserialize, Deserializer};
use serde_json::value::RawValue;
use std::collections::HashSet;
use std::fmt;
use std::fs;
use std::io;
use std::path::Path;

const ROOTS_PREFIX: &str = "{\"roots\":[";
const ROOTS_SUFFIX: &str = "]}";
const ROOT_CAP: usize = 50;

#[derive(Debug)]
pub enum SetRootsResult {
    BadRoots,
    Success { roots_json: String },
    StorageFailure(io::Error),
}

pub fn get_roots(roots_file: &Path, legacy_file: &Path, default_root: &str) -> String {
    read_current(roots_file)
        .or_else(|| read_legacy(legacy_file))
        .unwrap_or_else(|| array_json(&[serde_json::to_string(default_root).unwrap()]))
}

pub fn set_roots(
    roots_file: &Path,
    roots_is_array: bool,
    roots_json: Option<&str>,
) -> SetRootsResult {
    if !roots_is_array {
        return SetRootsResult::BadRoots;
    }
    let Some(roots_json) = roots_json else {
        return SetRootsResult::BadRoots;
    };
    let Ok(tokens) = parse_string_array(roots_json) else {
        return SetRootsResult::BadRoots;
    };

    let mut seen = HashSet::<Vec<u16>>::new();
    let mut retained = Vec::new();
    for token in tokens {
        let Ok(raw_text) = TranscriptRawText::from_json_token(token.clone()) else {
            return SetRootsResult::BadRoots;
        };
        let Ok(units) = raw_text.units() else {
            return SetRootsResult::BadRoots;
        };
        if units.is_empty() || !seen.insert(units) {
            continue;
        }
        retained.push(token);
        if retained.len() == ROOT_CAP {
            break;
        }
    }

    let output = serialize_tokens(&retained);
    let Some(parent) = roots_file.parent() else {
        return SetRootsResult::StorageFailure(io::Error::new(
            io::ErrorKind::InvalidInput,
            "roots file has no parent directory",
        ));
    };
    if let Err(error) = fs::create_dir_all(parent) {
        return SetRootsResult::StorageFailure(error);
    }
    if let Err(error) = fs::write(roots_file, output.as_bytes()) {
        return SetRootsResult::StorageFailure(error);
    }

    SetRootsResult::Success {
        roots_json: array_json(&retained),
    }
}

fn read_current(path: &Path) -> Option<String> {
    let content = read_json_text(path)?;
    let raw = last_object_member(&content, "roots")?;
    let tokens = parse_string_array(raw.get()).ok()?;
    if tokens.is_empty() {
        return None;
    }
    Some(array_json(&tokens))
}

fn read_legacy(path: &Path) -> Option<String> {
    let content = read_json_text(path)?;
    let raw_root = last_object_member(&content, "root")?;
    let token = raw_root.get();
    let raw_text = TranscriptRawText::from_json_token(token.to_owned()).ok()?;
    if raw_text.units().ok()?.is_empty() {
        return None;
    }
    Some(array_json(&[token.to_owned()]))
}

fn read_json_text(path: &Path) -> Option<String> {
    let bytes = fs::read(path).ok()?;
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

fn serialize_tokens(tokens: &[String]) -> String {
    format!("{ROOTS_PREFIX}{}{ROOTS_SUFFIX}", tokens.join(","))
}

fn array_json(tokens: &[String]) -> String {
    format!("[{}]", tokens.join(","))
}

fn parse_string_array(input: &str) -> Result<Vec<String>, String> {
    let array: RawArray = serde_json::from_str(input).map_err(|error| error.to_string())?;
    array
        .0
        .into_iter()
        .map(|value| {
            let token = value.get();
            if !token.starts_with('"') {
                return Err("expected JSON string token".into());
            }
            TranscriptRawText::from_json_token(token.to_owned())?;
            Ok(token.to_owned())
        })
        .collect()
}

fn last_object_member<'a>(document: &'a str, wanted: &str) -> Option<Box<RawValue>> {
    let raw: Box<RawValue> = serde_json::from_str(document).ok()?;
    let bytes = raw.get().as_bytes();
    if bytes.first() != Some(&b'{') {
        return None;
    }

    let mut cursor = 1;
    skip_space(bytes, &mut cursor);
    let mut found = None;
    while bytes.get(cursor) != Some(&b'}') {
        let key_start = cursor;
        cursor = string_end(bytes, cursor)?;
        let key_end = cursor;
        skip_space(bytes, &mut cursor);
        if bytes.get(cursor) != Some(&b':') {
            return None;
        }
        cursor += 1;
        skip_space(bytes, &mut cursor);
        let value_start = cursor;
        cursor = value_end(bytes, cursor)?;
        if json_string_equals_ascii(&bytes[key_start..key_end], wanted) {
            found = Some(
                RawValue::from_string(
                    std::str::from_utf8(&bytes[value_start..cursor])
                        .ok()?
                        .to_owned(),
                )
                .ok()?,
            );
        }
        skip_space(bytes, &mut cursor);
        match bytes.get(cursor) {
            Some(b',') => {
                cursor += 1;
                skip_space(bytes, &mut cursor);
            }
            Some(b'}') => break,
            _ => return None,
        }
    }
    found
}

fn skip_space(bytes: &[u8], cursor: &mut usize) {
    while bytes
        .get(*cursor)
        .is_some_and(|byte| matches!(byte, b' ' | b'\n' | b'\r' | b'\t'))
    {
        *cursor += 1;
    }
}

fn string_end(bytes: &[u8], start: usize) -> Option<usize> {
    if bytes.get(start) != Some(&b'"') {
        return None;
    }
    let mut cursor = start + 1;
    while let Some(byte) = bytes.get(cursor) {
        match byte {
            b'"' => return Some(cursor + 1),
            b'\\' => cursor += 2,
            _ => cursor += 1,
        }
    }
    None
}

fn value_end(bytes: &[u8], start: usize) -> Option<usize> {
    match bytes.get(start)? {
        b'"' => string_end(bytes, start),
        b'{' | b'[' => {
            let mut closers = vec![if bytes[start] == b'{' { b'}' } else { b']' }];
            let mut cursor = start + 1;
            while let Some(byte) = bytes.get(cursor) {
                match byte {
                    b'"' => cursor = string_end(bytes, cursor)?,
                    b'{' => {
                        closers.push(b'}');
                        cursor += 1;
                    }
                    b'[' => {
                        closers.push(b']');
                        cursor += 1;
                    }
                    b'}' | b']' => {
                        if closers.pop() != Some(*byte) {
                            return None;
                        }
                        cursor += 1;
                        if closers.is_empty() {
                            return Some(cursor);
                        }
                    }
                    _ => cursor += 1,
                }
            }
            None
        }
        _ => {
            let mut cursor = start;
            while bytes.get(cursor).is_some_and(|byte| {
                !matches!(byte, b',' | b']' | b'}' | b' ' | b'\n' | b'\r' | b'\t')
            }) {
                cursor += 1;
            }
            (cursor > start).then_some(cursor)
        }
    }
}

fn json_string_equals_ascii(token: &[u8], wanted: &str) -> bool {
    if token.first() != Some(&b'"') || token.last() != Some(&b'"') || !wanted.is_ascii() {
        return false;
    }
    let mut decoded = Vec::with_capacity(wanted.len());
    let mut cursor = 1;
    while cursor + 1 < token.len() {
        let byte = token[cursor];
        cursor += 1;
        if byte == b'\\' {
            let Some(escape) = token.get(cursor).copied() else {
                return false;
            };
            cursor += 1;
            match escape {
                b'u' => {
                    let Some(hex) = token.get(cursor..cursor + 4) else {
                        return false;
                    };
                    let Ok(hex) = std::str::from_utf8(hex) else {
                        return false;
                    };
                    let Ok(unit) = u16::from_str_radix(hex, 16) else {
                        return false;
                    };
                    if unit > 0x7f {
                        return false;
                    }
                    decoded.push(unit as u8);
                    cursor += 4;
                }
                b'"' | b'\\' | b'/' => decoded.push(escape),
                b'b' => decoded.push(0x08),
                b'f' => decoded.push(0x0c),
                b'n' => decoded.push(b'\n'),
                b'r' => decoded.push(b'\r'),
                b't' => decoded.push(b'\t'),
                _ => return false,
            }
        } else if byte.is_ascii() {
            decoded.push(byte);
        } else {
            return false;
        }
    }
    decoded == wanted.as_bytes()
}

struct RawArray(Vec<Box<RawValue>>);

impl<'de> Deserialize<'de> for RawArray {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct RawArrayVisitor;
        impl<'de> Visitor<'de> for RawArrayVisitor {
            type Value = RawArray;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("a JSON array")
            }

            fn visit_seq<S>(self, mut sequence: S) -> Result<Self::Value, S::Error>
            where
                S: SeqAccess<'de>,
            {
                let mut values = Vec::new();
                while let Some(value) = sequence.next_element::<Box<RawValue>>()? {
                    values.push(value);
                }
                Ok(RawArray(values))
            }
        }
        deserializer.deserialize_seq(RawArrayVisitor)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static TEMP_DIR_ID: AtomicU64 = AtomicU64::new(0);

    struct TempDir(std::path::PathBuf);

    impl TempDir {
        fn new() -> Self {
            let unique = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let id = TEMP_DIR_ID.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir()
                .join(format!("skills-roots-{}-{unique}-{id}", std::process::id()));
            fs::create_dir(&path).unwrap();
            Self(path)
        }

        fn path(&self, name: &str) -> std::path::PathBuf {
            self.0.join(name)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn write(path: &Path, value: &[u8]) {
        fs::write(path, value).unwrap();
    }

    #[test]
    fn getter_falls_back_current_legacy_default_and_uses_last_duplicate() {
        let temp = TempDir::new();
        let current = temp.path("skills-roots.json");
        let legacy = temp.path("skills-root.json");
        write(&current, br#"{"roots":["first"],"roots":["","last"]}"#);
        write(&legacy, br#"{"root":"older","root":"legacy"}"#);
        assert_eq!(get_roots(&current, &legacy, "default"), r#"["","last"]"#);

        write(&current, br#"{"roots":[]}"#);
        assert_eq!(get_roots(&current, &legacy, "default"), r#"["legacy"]"#);
        fs::remove_file(&legacy).unwrap();
        assert_eq!(get_roots(&current, &legacy, "default"), r#"["default"]"#);
    }

    #[test]
    fn getter_skips_malformed_non_object_empty_and_mixed_sources() {
        let temp = TempDir::new();
        let current = temp.path("current.json");
        let legacy = temp.path("legacy.json");
        for invalid in [
            b"{".as_slice(),
            b"null",
            b"[]",
            br#"{"roots":[]}"#,
            br#"{"roots":["ok",1]}"#,
        ] {
            write(&current, invalid);
            write(&legacy, br#"{"root":"fallback"}"#);
            assert_eq!(get_roots(&current, &legacy, "default"), r#"["fallback"]"#);
        }
        write(&current, br#"{"roots":["current"]}"#);
        assert_eq!(
            get_roots(&current, &temp.path("missing.json"), "default"),
            r#"["current"]"#
        );
        write(&legacy, br#"{"root":"","root":""}"#);
        assert_eq!(
            get_roots(&temp.path("missing.json"), &legacy, "default"),
            r#"["default"]"#
        );
    }

    #[test]
    fn getter_replaces_invalid_utf8_and_preserves_lone_surrogates() {
        let temp = TempDir::new();
        let current = temp.path("current.json");
        let legacy = temp.path("legacy.json");
        write(&current, br#"{"roots":["\ud800"]}"#);
        assert_eq!(get_roots(&current, &legacy, "default"), r#"["\ud800"]"#);
        write(&current, b"{\"roots\":[\"\xff\"]}");
        assert_eq!(get_roots(&current, &legacy, "default"), "[\"�\"]");
    }

    #[test]
    fn getter_ignores_unrelated_lone_surrogate_keys_and_uses_escaped_duplicate_names() {
        let temp = TempDir::new();
        let current = temp.path("current.json");
        let legacy = temp.path("legacy.json");
        write(
            &current,
            br#"{"\ud800":0,"roots":["first"],"other":"\udfff","ro\u006fts":["last"]}"#,
        );
        assert_eq!(get_roots(&current, &legacy, "default"), r#"["last"]"#);

        fs::remove_file(&current).unwrap();
        write(
            &legacy,
            br#"{"\ud800":0,"root":"first","other":"\udfff","r\u006fot":"last-legacy"}"#,
        );
        assert_eq!(
            get_roots(&current, &legacy, "default"),
            r#"["last-legacy"]"#
        );
    }

    #[test]
    fn getter_rejects_bom_and_trailing_content_before_falling_back() {
        let temp = TempDir::new();
        let current = temp.path("current.json");
        let legacy = temp.path("legacy.json");
        write(&legacy, br#"{"root":"fallback"}"#);
        write(&current, b"\xef\xbb\xbf{\"roots\":[\"invalid\"]}");
        assert_eq!(get_roots(&current, &legacy, "default"), r#"["fallback"]"#);
        write(&current, br#"{"roots":["invalid"]} trailing"#);
        assert_eq!(get_roots(&current, &legacy, "default"), r#"["fallback"]"#);
    }

    #[test]
    fn setter_filters_deduplicates_by_utf16_caps_and_writes_exact_bytes() {
        let temp = TempDir::new();
        let file = temp.path("nested/state/skills-roots.json");
        let mut candidates = vec![
            "\"\"".to_owned(),
            "\" \"".to_owned(),
            "\"x\"".to_owned(),
            "\"x\"".to_owned(),
            "\"\\ud800\"".to_owned(),
            "\"\\ud801\"".to_owned(),
        ];
        for index in 0..55 {
            candidates.push(format!("\"root-{index}\""));
        }
        let result = set_roots(&file, true, Some(&array_json(&candidates)));
        let SetRootsResult::Success { roots_json } = result else {
            panic!("expected successful roots write")
        };
        let expected = [
            "\" \"",
            "\"x\"",
            "\"\\ud800\"",
            "\"\\ud801\"",
            "\"root-0\"",
            "\"root-1\"",
            "\"root-2\"",
            "\"root-3\"",
            "\"root-4\"",
            "\"root-5\"",
            "\"root-6\"",
            "\"root-7\"",
            "\"root-8\"",
            "\"root-9\"",
            "\"root-10\"",
            "\"root-11\"",
            "\"root-12\"",
            "\"root-13\"",
            "\"root-14\"",
            "\"root-15\"",
            "\"root-16\"",
            "\"root-17\"",
            "\"root-18\"",
            "\"root-19\"",
            "\"root-20\"",
            "\"root-21\"",
            "\"root-22\"",
            "\"root-23\"",
            "\"root-24\"",
            "\"root-25\"",
            "\"root-26\"",
            "\"root-27\"",
            "\"root-28\"",
            "\"root-29\"",
            "\"root-30\"",
            "\"root-31\"",
            "\"root-32\"",
            "\"root-33\"",
            "\"root-34\"",
            "\"root-35\"",
            "\"root-36\"",
            "\"root-37\"",
            "\"root-38\"",
            "\"root-39\"",
            "\"root-40\"",
            "\"root-41\"",
            "\"root-42\"",
            "\"root-43\"",
            "\"root-44\"",
            "\"root-45\"",
        ]
        .join(",");
        assert_eq!(roots_json, format!("[{expected}]"));
        assert_eq!(
            fs::read_to_string(file).unwrap(),
            format!("{{\"roots\":[{expected}]}}")
        );
    }

    #[test]
    fn setter_handles_non_array_empty_result_and_storage_failure_structurally() {
        let temp = TempDir::new();
        let file = temp.path("state/roots.json");
        assert!(matches!(
            set_roots(&file, false, None),
            SetRootsResult::BadRoots
        ));
        assert!(matches!(
            set_roots(&file, true, Some("[1]")),
            SetRootsResult::BadRoots
        ));
        assert!(
            matches!(set_roots(&file, true, Some("[\"\"]")), SetRootsResult::Success { roots_json } if roots_json == "[]")
        );
        let blocker = temp.path("blocker");
        write(&blocker, b"file");
        let failure = set_roots(&blocker.join("roots.json"), true, Some("[]"));
        assert!(matches!(failure, SetRootsResult::StorageFailure(_)));
    }
}
