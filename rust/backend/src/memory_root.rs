// Memory root choice, FS-persisted in `<state_dir>/memory-root.json`.
// Mirrors server/memory.mjs `getMemoryRoot` / `setMemoryRoot`: the root holds one
// dir per project, each with a memory/ subdir. Defaults to `~/.claude/projects`.
// The root token stays raw so JavaScript UTF-16 values (unpaired surrogates
// included) survive without a `serde_json::Value` hop.
use crate::wiki_root::{RootValue, SetResponse, stored_root};
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};

pub(crate) const DEFAULT_ROOT: &str = "~/.claude/projects";

fn node_home_value(value: OsString, validate_profile: bool) -> std::io::Result<PathBuf> {
    #[cfg(windows)]
    let text = {
        use std::os::windows::ffi::OsStrExt;
        std::char::decode_utf16(value.encode_wide())
            .map(|unit| match unit {
                Ok(character) => character.to_string(),
                Err(_) => "\u{fffd}\u{fffd}\u{fffd}".to_owned(),
            })
            .collect::<String>()
    };
    #[cfg(not(windows))]
    let text = value.to_string_lossy().into_owned();
    #[cfg(windows)]
    if validate_profile && text.len() < 3 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "uv_os_homedir returned ENOENT",
        ));
    }
    #[cfg(not(windows))]
    let _ = validate_profile;
    Ok(PathBuf::from(text))
}

pub(crate) fn current_node_home() -> std::io::Result<PathBuf> {
    #[cfg(windows)]
    let key = "USERPROFILE";
    #[cfg(not(windows))]
    let key = "HOME";
    if let Some(value) = std::env::var_os(key) {
        return node_home_value(value, true);
    }
    let value = {
        #[allow(deprecated)]
        std::env::home_dir().map(PathBuf::into_os_string)
    };
    node_home_value(
        value.ok_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::NotFound, "uv_os_homedir failed")
        })?,
        false,
    )
}

fn root_file(state_dir: &Path) -> std::path::PathBuf {
    state_dir.join("memory-root.json")
}

fn default_root() -> RootValue {
    RootValue::from_token(format!("\"{DEFAULT_ROOT}\"")).expect("constant")
}

fn canonical_root(root: RootValue) -> RootValue {
    RootValue(root.0.slice_units(0, usize::MAX).expect("validated root"))
}

// Missing, unreadable, invalid or non-string/empty root all fall back to the literal
// default; a valid nonempty root is returned unchanged (no normalisation or expansion).
// Node's `readFileSync(..., 'utf8')` decodes invalid bytes lossily, so `from_utf8_lossy`
// keeps the same U+FFFD result instead of falling back to the default.
pub(crate) fn get_root(state_dir: &Path) -> RootValue {
    fs::read(root_file(state_dir))
        .ok()
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
        .and_then(|text| stored_root(&text))
        .map(canonical_root)
        .unwrap_or_else(default_root)
}

// Rejects a non-string or empty root with `{ok:false,error:"bad root"}`, otherwise
// creates the state dir and writes `{"root":...}` with no trailing newline.
pub(crate) fn set_root(state_dir: &Path, root: Option<RootValue>) -> SetResponse {
    let Some(root) = root.filter(|root| root.units().is_ok_and(|units| !units.is_empty())) else {
        return SetResponse {
            ok: false,
            root: None,
            error: Some("bad root".into()),
        };
    };
    let root = canonical_root(root);
    let mut bytes = b"{\"root\":".to_vec();
    if let Err(error) = serde_json::to_writer(&mut bytes, &root.0) {
        return SetResponse {
            ok: false,
            root: None,
            error: Some(error.to_string()),
        };
    }
    bytes.push(b'}');
    let written = fs::create_dir_all(state_dir)
        .map_err(|error| root_io_error(state_dir, "mkdir", error))
        .and_then(|()| {
            let file = root_file(state_dir);
            fs::write(&file, bytes).map_err(|error| root_io_error(&file, "open", error))
        });
    match written {
        Ok(()) => SetResponse {
            ok: true,
            root: Some(root),
            error: None,
        },
        Err(error) => SetResponse {
            ok: false,
            root: None,
            error: Some(error),
        },
    }
}

// Node labels these common failure cases by the attempted operation and path.
// Other platform errors retain their native text until their mapping is verified.
pub(crate) fn root_io_error(path: &Path, operation: &str, error: std::io::Error) -> String {
    let description = if operation == "mkdir" && path.is_file() {
        Some("EEXIST: file already exists")
    } else if operation == "mkdir" && path.ancestors().skip(1).any(Path::is_file) {
        Some("ENOTDIR: not a directory")
    } else if operation == "open" && path.is_dir() {
        Some("EISDIR: illegal operation on a directory")
    } else if cfg!(unix) && error.raw_os_error() == Some(13) {
        Some("EACCES: permission denied")
    } else if cfg!(windows)
        && operation == "mkdir"
        && matches!(error.raw_os_error(), Some(123 | 267))
        && path.components().any(|component| match component {
            std::path::Component::Normal(name) => name
                .to_string_lossy()
                .contains(['*', '?', ':', '<', '>', '|', '"']),
            _ => false,
        })
    {
        Some("ENOENT: no such file or directory")
    } else if cfg!(windows) && operation == "open" && error.raw_os_error() == Some(32) {
        Some("EBUSY: resource busy or locked")
    } else if cfg!(windows)
        && operation == "open"
        && error.raw_os_error() == Some(5)
        && fs::metadata(path).is_ok_and(|metadata| metadata.permissions().readonly())
    {
        Some("EPERM: operation not permitted")
    } else {
        None
    };
    match description {
        Some(description) => format!("{description}, {operation} '{}'", path.display()),
        None => error.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::{DEFAULT_ROOT, get_root, node_home_value, set_root};
    use crate::wiki_root::{RootValue, SetResponse, request_root, stored_root};
    use serde_json::json;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    #[cfg(windows)]
    #[test]
    fn memory_node_home_matches_windows_profile_edge_cases() {
        use std::ffi::OsString;
        use std::os::windows::ffi::OsStringExt;

        for short in ["", "xy"] {
            assert_eq!(
                node_home_value(OsString::from(short), true)
                    .unwrap_err()
                    .kind(),
                std::io::ErrorKind::NotFound
            );
        }
        assert_eq!(
            node_home_value(OsString::from_wide(&[67, 58, 92, 0xd800]), true).unwrap(),
            PathBuf::from("C:\\\u{fffd}\u{fffd}\u{fffd}")
        );
    }

    #[cfg(unix)]
    #[test]
    fn memory_node_home_preserves_empty_posix_home() {
        use std::os::unix::ffi::OsStringExt;

        assert_eq!(
            node_home_value(std::ffi::OsString::new(), true).unwrap(),
            PathBuf::new()
        );
        assert_eq!(
            node_home_value(
                std::ffi::OsString::from_vec(b"/tmp/\xff\xc0\x80".to_vec()),
                true
            )
            .unwrap(),
            PathBuf::from("/tmp/\u{fffd}\u{fffd}\u{fffd}")
        );
    }

    #[cfg(unix)]
    #[test]
    fn setter_formats_posix_permission_errors_like_node() {
        for operation in ["mkdir", "open", "stat"] {
            let path = Path::new("/missing/isolated-path");
            assert_eq!(
                super::root_io_error(path, operation, std::io::Error::from_raw_os_error(13)),
                format!(
                    "EACCES: permission denied, {operation} '{}'",
                    path.display()
                )
            );
        }
    }

    static TEMP_DIR_ID: AtomicU64 = AtomicU64::new(0);

    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            let unique = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let id = TEMP_DIR_ID.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir()
                .join(format!("memory-root-{}-{unique}-{id}", std::process::id()));
            fs::create_dir(&path).unwrap();
            Self(path)
        }

        fn state_dir(&self) -> PathBuf {
            self.0.join("state")
        }

        fn write_file(&self, root: &str) {
            self.write_bytes(root.as_bytes());
        }

        fn write_bytes(&self, bytes: &[u8]) {
            let dir = self.state_dir();
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join("memory-root.json"), bytes).unwrap();
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn root_file(state_dir: &Path) -> PathBuf {
        state_dir.join("memory-root.json")
    }

    // Builds the same raw token the wire carries: a JSON string, never a `Value`.
    fn root_value(text: &str) -> RootValue {
        RootValue::from_token(serde_json::to_string(text).unwrap()).unwrap()
    }

    fn units(root: RootValue) -> Vec<u16> {
        root.units().unwrap()
    }

    fn expect_units(root: RootValue, expected: &str) {
        assert_eq!(units(root), expected.encode_utf16().collect::<Vec<_>>());
    }

    #[test]
    fn getter_defaults_on_missing_malformed_and_invalid_roots() {
        let temp = TempDir::new();
        let state_dir = temp.state_dir();
        expect_units(get_root(&state_dir), DEFAULT_ROOT);

        for raw in [
            "{",
            "null",
            "42",
            r#""text""#,
            "[]",
            "{}",
            r#"{"root":42}"#,
            r#"{"root":null}"#,
            r#"{"root":["/x"]}"#,
            r#"{"root":""}"#,
            r#"{"other":"/x"}"#,
            r#"{"\ud800":1}"#,
            r#"{"root":"\ud800""#,
            "\u{feff}{\"root\":\"/x\"}",
            "\u{a0}{\"root\":\"/x\"}",
        ] {
            temp.write_file(raw);
            expect_units(get_root(&state_dir), DEFAULT_ROOT);
        }

        // A state dir that is a file cannot be read: default, no panic.
        let blocker = temp.0.join("blocker");
        fs::write(&blocker, "not a directory").unwrap();
        expect_units(get_root(&blocker), DEFAULT_ROOT);
    }

    #[test]
    fn getter_returns_valid_roots_verbatim() {
        let temp = TempDir::new();
        let state_dir = temp.state_dir();
        for root in [
            "/srv/memory",
            " ",
            "~/projects",
            "  /a/../b  ",
            "記憶 🧪",
            "a\u{0}b",
        ] {
            temp.write_file(&json!({ "root": root }).to_string());
            expect_units(get_root(&state_dir), root);
        }
        for (raw, expected) in [
            (r#"{"root":"\ud800"}"#, vec![0xd800]),
            (r#"{"root":"a\ud800b"}"#, vec![97, 0xd800, 98]),
            (r#"{"root":"𐀀\ud801"}"#, vec![0xd800, 0xdc00, 0xd801]),
        ] {
            temp.write_file(raw);
            assert_eq!(units(get_root(&state_dir)), expected, "{raw}");
        }
        // Extra fields and whitespace in the stored object are irrelevant.
        temp.write_file(r#"  { "extra": true, "root": "/kept", "n": [1] }  "#);
        expect_units(get_root(&state_dir), "/kept");

        // Node's lossy UTF-8 read turns an invalid byte into U+FFFD, not the default.
        temp.write_bytes(b"{\"root\":\"\xff\"}");
        assert_eq!(units(get_root(&state_dir)), vec![0xfffd]);
    }

    #[test]
    fn setter_rejects_non_string_and_empty_roots_without_writing() {
        let temp = TempDir::new();
        let state_dir = temp.state_dir();
        assert_eq!(
            serde_json::to_string(&set_root(&state_dir, None)).unwrap(),
            r#"{"ok":false,"error":"bad root"}"#
        );
        let empty = RootValue::from_token(r#""""#.into());
        assert!(empty.is_err());
        assert_eq!(
            serde_json::to_string(&set_root(&state_dir, empty.ok())).unwrap(),
            r#"{"ok":false,"error":"bad root"}"#
        );
        assert!(!state_dir.exists());
    }

    #[test]
    fn setter_persists_exact_bytes_and_creates_the_state_dir() {
        let temp = TempDir::new();
        let nested = temp.0.join("nested").join("state");
        let result = set_root(&nested, Some(root_value("/srv/memory")));
        assert_eq!(
            serde_json::to_string(&result).unwrap(),
            r#"{"ok":true,"root":"/srv/memory"}"#
        );
        assert_eq!(
            fs::read(root_file(&nested)).unwrap(),
            br#"{"root":"/srv/memory"}"#.as_slice()
        );
        expect_units(get_root(&nested), "/srv/memory");

        // Overwriting replaces the previous value; whitespace roots stay verbatim.
        assert!(set_root(&nested, Some(root_value("  ~/x  "))).ok);
        assert_eq!(
            fs::read_to_string(root_file(&nested)).unwrap(),
            r#"{"root":"  ~/x  "}"#
        );
        expect_units(get_root(&nested), "  ~/x  ");
    }

    #[test]
    fn setter_reports_filesystem_errors() {
        let temp = TempDir::new();
        let blocked = temp.0.join("blocked");
        fs::write(&blocked, "not a directory").unwrap();
        let result = set_root(&blocked, Some(root_value("/srv/memory")));
        assert!(!result.ok);
        assert_eq!(
            result.error.as_deref(),
            Some(format!("EEXIST: file already exists, mkdir '{}'", blocked.display()).as_str())
        );
        let child = blocked.join("state");
        let result = set_root(&child, Some(root_value("/srv/memory")));
        assert_eq!(
            result.error.as_deref(),
            Some(format!("ENOTDIR: not a directory, mkdir '{}'", child.display()).as_str())
        );

        // A directory squatting on the file name fails the write too.
        let state_dir = temp.state_dir();
        fs::create_dir_all(root_file(&state_dir)).unwrap();
        let result = set_root(&state_dir, Some(root_value("/srv/memory")));
        assert!(!result.ok);
        assert_eq!(
            result.error.as_deref(),
            Some(
                format!(
                    "EISDIR: illegal operation on a directory, open '{}'",
                    root_file(&state_dir).display()
                )
                .as_str()
            )
        );
    }

    #[test]
    #[cfg(windows)]
    fn setter_handles_long_windows_paths_like_node() {
        let temp = TempDir::new();
        let mut state = temp.0.clone();
        for index in 0..6 {
            state.push(format!("{}{index}", "a".repeat(45)));
        }
        state.push("state");
        assert!(state.to_string_lossy().len() > 260);
        let result = set_root(&state, Some(root_value("/srv/memory")));
        assert!(result.ok, "{:?}", result.error);
    }

    #[test]
    #[cfg(windows)]
    fn setter_reports_locked_root_file_like_node() {
        use std::os::windows::fs::OpenOptionsExt;
        let temp = TempDir::new();
        let state = temp.state_dir();
        fs::create_dir_all(&state).unwrap();
        let file = root_file(&state);
        let locked = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .share_mode(0)
            .open(&file)
            .unwrap();
        let result = set_root(&state, Some(root_value("/srv/memory")));
        assert_eq!(
            result.error.as_deref(),
            Some(format!("EBUSY: resource busy or locked, open '{}'", file.display()).as_str())
        );
        drop(locked);
    }

    #[test]
    #[cfg(windows)]
    fn setter_reports_invalid_state_paths_like_node() {
        let temp = TempDir::new();
        for suffix in [
            "bad*name",
            "bad?name",
            "bad*name/child",
            "bad:name",
            "bad<name",
            "bad>name",
            "bad|name",
            "bad\"name",
        ] {
            let state = temp.0.join(suffix);
            let result = set_root(&state, Some(root_value("/srv/memory")));
            assert_eq!(
                result.error.as_deref(),
                Some(
                    format!(
                        "ENOENT: no such file or directory, mkdir '{}'",
                        state.display()
                    )
                    .as_str()
                )
            );
        }
    }

    #[test]
    #[cfg(windows)]
    fn setter_reports_readonly_root_file_like_node() {
        let temp = TempDir::new();
        let state = temp.state_dir();
        fs::create_dir_all(&state).unwrap();
        let file = root_file(&state);
        fs::write(&file, "old").unwrap();
        let mut permissions = fs::metadata(&file).unwrap().permissions();
        permissions.set_readonly(true);
        fs::set_permissions(&file, permissions.clone()).unwrap();
        let result = set_root(&state, Some(root_value("/srv/memory")));
        permissions.set_readonly(false);
        fs::set_permissions(&file, permissions).unwrap();
        assert_eq!(
            result.error.as_deref(),
            Some(format!("EPERM: operation not permitted, open '{}'", file.display()).as_str())
        );
    }

    #[test]
    fn defaults_are_not_affected_by_a_previous_setter_failure() {
        let temp = TempDir::new();
        let state_dir = temp.state_dir();
        set_root(&state_dir, None);
        expect_units(get_root(&state_dir), DEFAULT_ROOT);
        assert!(!root_file(&state_dir).exists());
    }

    #[test]
    fn stored_root_duplicate_keys_last_wins_with_surrogates() {
        let units = |text: &str| stored_root(text).map(|root| root.units().unwrap());
        assert_eq!(units(r#"{"root":"a","root":"\ud800"}"#), Some(vec![0xd800]));
        assert_eq!(units(r#"{"root":"\ud800","root":"b"}"#), Some(vec![98]));
        // A lone-surrogate key is decoded as units and ignored, not fatal.
        assert_eq!(units("{\"\\ud800\":1,\"root\":\"x\"}"), Some(vec![120]));
        assert_eq!(units(r#"{"root":42,"root":"b"}"#), Some(vec![98]));
        assert_eq!(units(r#"{"root":""}"#), None);
        assert!(stored_root("{").is_none());
        assert_eq!(DEFAULT_ROOT, "~/.claude/projects");
    }

    #[test]
    fn setter_rejects_empty_root_constructed_directly() {
        let temp = TempDir::new();
        let state_dir = temp.state_dir();
        let raw = crate::transcripts::TranscriptRawText::from_json_token("\"\"".into()).unwrap();
        let response = set_root(&state_dir, Some(RootValue(raw)));
        assert!(!response.ok);
        assert_eq!(response.error.as_deref(), Some("bad root"));
        assert!(!state_dir.exists());
    }

    #[test]
    fn setter_round_trips_lone_surrogate() {
        let temp = TempDir::new();
        let nested = temp.0.join("nested").join("state");
        let lone = RootValue::from_token(r#""\ud800""#.into()).unwrap();
        let result = set_root(&nested, Some(lone));
        assert_eq!(
            serde_json::to_string(&result).unwrap(),
            r#"{"ok":true,"root":"\ud800"}"#
        );
        assert_eq!(
            fs::read(root_file(&nested)).unwrap(),
            br#"{"root":"\ud800"}"#.as_slice()
        );
        assert_eq!(units(get_root(&nested)), vec![0xd800]);
    }

    #[test]
    fn set_response_escapes_raw_text_and_round_trips() {
        let lone = RootValue::from_token(r#""\ud800""#.into()).unwrap();
        let body = serde_json::to_string(&SetResponse {
            ok: true,
            root: Some(lone),
            error: None,
        })
        .unwrap();
        assert_eq!(body, r#"{"ok":true,"root":"\ud800"}"#);
        // The serialized body is itself a valid wire request carrying the same units.
        assert_eq!(units(request_root(&body).unwrap().unwrap()), vec![0xd800]);

        let bad = serde_json::to_string(&SetResponse {
            ok: false,
            root: None,
            error: Some("bad root".into()),
        })
        .unwrap();
        assert_eq!(bad, r#"{"ok":false,"error":"bad root"}"#);
    }

    #[test]
    fn wire_root_duplicates_last_wins_and_malformed_is_an_error() {
        let units = |line: &str| {
            request_root(line)
                .unwrap()
                .map(|root| root.units().unwrap())
        };
        assert_eq!(units(r#"{"root":"a","root":"b"}"#), Some(vec![98]));
        assert_eq!(units(r#"{"root":"\ud800","root":"b"}"#), Some(vec![98]));
        assert_eq!(units(r#"{"root":42}"#), None);
        assert_eq!(units(r#"{"root":""}"#), None);
        assert_eq!(units(r#"{"other":"/x"}"#), None);
        assert!(request_root("{").is_err());
        assert!(request_root("").is_err());
    }
}
