use crate::transcripts::TranscriptRawText;
use serde::de::{SeqAccess, Visitor};
use serde::{Deserialize, Deserializer};
use serde_json::value::RawValue;
use std::collections::HashSet;
use std::fmt;
use std::fs;
use std::io;
use std::path::Path;

const DEFAULT_ROOTS: &str = "[\"~\"]";
const ROOT_CAP: usize = 50;

#[derive(Debug)]
pub enum SetRootsResult {
    Success { roots_json: String },
    StorageFailure(io::Error),
}

pub fn get_roots(path: &Path) -> String {
    let Ok(bytes) = fs::read(path) else {
        return DEFAULT_ROOTS.to_owned();
    };
    let content = String::from_utf8_lossy(&bytes);
    let Ok(tokens) = parse_raw_array(&content) else {
        return DEFAULT_ROOTS.to_owned();
    };
    if tokens.is_empty() {
        return DEFAULT_ROOTS.to_owned();
    }
    content.into_owned()
}

pub fn set_roots(path: &Path, roots_json: &str) -> SetRootsResult {
    let Ok(tokens) = parse_raw_array(roots_json) else {
        return SetRootsResult::Success {
            roots_json: "[]".to_owned(),
        };
    };
    let mut seen = HashSet::<Vec<u16>>::new();
    let mut retained = Vec::new();
    for token in tokens {
        if !token.get().starts_with('"') {
            continue;
        }
        let raw = token.get().to_owned();
        let Ok(text) = TranscriptRawText::from_json_token(raw.clone()) else {
            continue;
        };
        let Ok(units) = text.units() else {
            continue;
        };
        if units.is_empty() || !seen.insert(units) {
            continue;
        }
        retained.push(raw);
        if retained.len() == ROOT_CAP {
            break;
        }
    }

    let output = pretty_array(&retained);
    let Some(parent) = path.parent() else {
        return SetRootsResult::StorageFailure(io::Error::new(
            io::ErrorKind::InvalidInput,
            "picker roots file has no parent directory",
        ));
    };
    if let Err(error) = fs::create_dir_all(parent) {
        return SetRootsResult::StorageFailure(error);
    }
    if let Err(error) = fs::write(path, output.as_bytes()) {
        return SetRootsResult::StorageFailure(error);
    }

    SetRootsResult::Success {
        roots_json: compact_array(&retained),
    }
}

fn parse_raw_array(input: &str) -> Result<Vec<Box<RawValue>>, serde_json::Error> {
    let array: RawArray = serde_json::from_str(input)?;
    Ok(array.0)
}

fn compact_array(tokens: &[String]) -> String {
    format!("[{}]", tokens.join(","))
}

fn pretty_array(tokens: &[String]) -> String {
    if tokens.is_empty() {
        return "[]".to_owned();
    }
    format!("[\n  {}\n]", tokens.join(",\n  "))
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
                .join(format!("picker-roots-{}-{unique}-{id}", std::process::id()));
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

    #[test]
    fn getter_preserves_raw_arbitrary_array_and_defaults_on_bad_inputs() {
        let temp = TempDir::new();
        let path = temp.path("roots.json");
        assert_eq!(get_roots(&path), DEFAULT_ROOTS);
        for bytes in [b"\xef\xbb\xbf[\"x\"]".as_slice(), b"{", b"[]", b"null"] {
            fs::write(&path, bytes).unwrap();
            assert_eq!(get_roots(&path), DEFAULT_ROOTS);
        }
        let source = "[ 1e999 , {\"x\": 1, \"x\": 2}, \"\\ud800\", [false, null] ]";
        fs::write(&path, source).unwrap();
        assert_eq!(get_roots(&path), source);

        let surrogate_key = r#"[{"\ud800": {"value": "\udfff"}}]"#;
        fs::write(&path, surrogate_key).unwrap();
        assert_eq!(get_roots(&path), surrogate_key);

        fs::write(&path, b"[\"\xff\"]").unwrap();
        assert_eq!(get_roots(&path), "[\"\u{fffd}\"]");
    }

    #[test]
    fn setter_deduplicates_by_utf16_caps_and_writes_exact_pretty_bytes() {
        let temp = TempDir::new();
        let path = temp.path("nested/roots.json");
        let input = r#"["a","\u0061","\ud800","\ud800","","b"]"#;
        let result = set_roots(&path, input);
        let SetRootsResult::Success { roots_json } = result else {
            panic!("setter should succeed")
        };
        assert_eq!(roots_json, r#"["a","\ud800","b"]"#);
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "[\n  \"a\",\n  \"\\ud800\",\n  \"b\"\n]"
        );

        let values = (0..60)
            .map(|index| format!("\"root-{index}\""))
            .collect::<Vec<_>>()
            .join(",");
        let result = set_roots(&path, &format!("[{values}]"));
        let SetRootsResult::Success { roots_json } = result else {
            panic!("setter should succeed")
        };
        assert_eq!(parse_raw_array(&roots_json).unwrap().len(), ROOT_CAP);
        assert!(!fs::read(&path).unwrap().ends_with(b"\n"));
    }

    #[test]
    fn setter_writes_empty_array_and_returns_native_storage_failure() {
        let temp = TempDir::new();
        let path = temp.path("roots.json");
        let result = set_roots(&path, "[1, null, \"\"]");
        assert!(matches!(result, SetRootsResult::Success { roots_json } if roots_json == "[]"));
        assert_eq!(fs::read(&path).unwrap(), b"[]");

        let directory = temp.path("directory");
        fs::create_dir(&directory).unwrap();
        let result = set_roots(&directory, "[]");
        assert!(matches!(result, SetRootsResult::StorageFailure(_)));
    }
}
