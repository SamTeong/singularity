use serde::Serialize;
use std::fs::{self, OpenOptions};
use std::io::{Error, ErrorKind, Write};
use std::path::Path;

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ReadResult {
    Missing,
    File { text: String },
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct FsFailure {
    pub kind: &'static str,
    pub path: String,
    pub operation: &'static str,
    /// The libuv-shaped text `fs.*Sync` throws, which Fastify copies into a 500
    /// body verbatim (`usage.mjs:415-420`). VERIFY: wave4-hostedits-5
    pub message: String,
}

impl FsFailure {
    fn new(path: &str, operation: &'static str, error: Error, message: String) -> Self {
        Self {
            kind: stable_kind(error.kind()),
            path: path.to_owned(),
            operation,
            message,
        }
    }
}

/// Reconstructs Node's `fs` error message: `"{CODE}: {strerror}, {syscall}
/// '{operand}'"` (a rename appends ` -> '{to}'`). Rust's `io::Error` Display
/// carries neither the libuv text nor the operands, so the text comes from
/// `ErrorKind`; `EACCES`/`EPERM` cannot be told apart and both render `EACCES`,
/// and a kind outside the table falls back to Rust's own Display (native-only
/// text, disclosed rather than guessed).
fn node_fs_message(syscall: &str, operands: &[&str], error: &Error) -> String {
    let Some((code, text)) = node_errno(error.kind()) else {
        return error.to_string();
    };
    match operands {
        [one] => format!("{code}: {text}, {syscall} '{one}'"),
        [from, to] => format!("{code}: {text}, {syscall} '{from}' -> '{to}'"),
        _ => format!("{code}: {text}, {syscall}"),
    }
}

fn node_errno(kind: ErrorKind) -> Option<(&'static str, &'static str)> {
    Some(match kind {
        ErrorKind::NotFound => ("ENOENT", "no such file or directory"),
        ErrorKind::PermissionDenied => ("EACCES", "permission denied"),
        ErrorKind::AlreadyExists => ("EEXIST", "file already exists"),
        ErrorKind::InvalidInput => ("EINVAL", "invalid argument"),
        ErrorKind::IsADirectory => ("EISDIR", "illegal operation on a directory"),
        ErrorKind::NotADirectory => ("ENOTDIR", "not a directory"),
        ErrorKind::StorageFull => ("ENOSPC", "no space left on device"),
        _ => return None,
    })
}

fn stable_kind(kind: ErrorKind) -> &'static str {
    match kind {
        ErrorKind::NotFound => "not-found",
        ErrorKind::PermissionDenied => "permission-denied",
        ErrorKind::AlreadyExists => "already-exists",
        ErrorKind::InvalidInput => "invalid-input",
        ErrorKind::InvalidData => "invalid-data",
        ErrorKind::Interrupted => "interrupted",
        ErrorKind::StorageFull => "storage-full",
        _ => "other",
    }
}

pub fn read(path: &str) -> Result<ReadResult, FsFailure> {
    let configured = Path::new(path);
    if !configured.exists() {
        return Ok(ReadResult::Missing);
    }
    fs::read(configured)
        .map(|bytes| ReadResult::File {
            text: String::from_utf8_lossy(&bytes).into_owned(),
        })
        .map_err(|error| {
            // `readFileSync` fails at `open` with a path operand, except a directory:
            // the open succeeds and the `read` fails with no operand (EISDIR on every
            // platform, where Windows' own error is access-denied).
            let message = if configured.is_dir() {
                node_fs_message("read", &[], &Error::from(ErrorKind::IsADirectory))
            } else {
                node_fs_message("open", &[path], &error)
            };
            FsFailure::new(path, "read", error, message)
        })
}

pub fn write(path: &str, temp_path: &str, text: &str) -> Result<(), FsFailure> {
    let configured = Path::new(path);
    if let Some(parent) = configured.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            // Node's operand is `dirname(OLLAMA_CFG)`, not the config path.
            let operand = parent.to_string_lossy();
            let message = node_fs_message("mkdir", &[&*operand], &error);
            FsFailure::new(path, "mkdir", error, message)
        })?;
    }

    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(temp_path).map_err(|error| {
        let message = node_fs_message("open", &[temp_path], &error);
        FsFailure::new(path, "write", error, message)
    })?;
    file.write_all(text.as_bytes()).map_err(|error| {
        // `writeSync` reports the fd, not a path.
        let message = node_fs_message("write", &[], &error);
        FsFailure::new(path, "write", error, message)
    })?;
    drop(file);
    fs::rename(temp_path, configured).map_err(|error| {
        let message = node_fs_message("rename", &[temp_path, path], &error);
        FsFailure::new(path, "rename", error, message)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::{create_dir_all, read as read_file, write as write_file};
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct Fixture(PathBuf);

    impl Fixture {
        fn new() -> Self {
            let stamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let root = std::env::temp_dir().join(format!("singularity-ollama-config-{stamp}"));
            create_dir_all(&root).unwrap();
            Self(root)
        }

        fn path(&self, name: &str) -> String {
            self.0.join(name).to_string_lossy().into_owned()
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn read_distinguishes_missing_and_preserves_lossy_text_and_bom() {
        let fixture = Fixture::new();
        let path = fixture.path("ollama.json");
        assert_eq!(read(&path), Ok(ReadResult::Missing));

        write_file(Path::new(&path), b"\xef\xbb\xbf{\"mode\":\xff}").unwrap();
        let ReadResult::File { text } = super::read(&path).unwrap() else {
            panic!("existing file must be returned");
        };
        assert!(text.starts_with('\u{feff}'));
        assert!(text.contains('\u{fffd}'));
        assert!(serde_json::from_str::<serde_json::Value>(&text).is_err());
    }

    #[test]
    fn read_error_after_exists_is_stable_and_does_not_become_missing() {
        let fixture = Fixture::new();
        let path = fixture.path("directory");
        create_dir_all(&path).unwrap();
        let error = super::read(&path).unwrap_err();
        assert_eq!(error.path, path);
        assert_eq!(error.operation, "read");
        assert!(matches!(error.kind, "permission-denied" | "other"));
    }

    #[test]
    fn write_creates_parent_and_renames_exact_text() {
        let fixture = Fixture::new();
        let path = fixture.path("deep/state/ollama.json");
        let temp_path = format!("{path}.123.456.tmp");
        super::write(&path, &temp_path, "{\"mode\":\"browser\"}").unwrap();
        assert_eq!(
            read_file(Path::new(&path)).unwrap(),
            b"{\"mode\":\"browser\"}"
        );
        assert!(!Path::new(&temp_path).exists());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }

    #[test]
    fn write_failures_report_the_stage_and_never_fall_back() {
        let fixture = Fixture::new();
        let blocked_parent = fixture.path("blocked");
        write_file(Path::new(&blocked_parent), b"file").unwrap();
        let path = format!("{blocked_parent}/ollama.json");
        let mkdir = super::write(&path, &format!("{path}.1.2.tmp"), "{}").unwrap_err();
        assert_eq!(mkdir.operation, "mkdir");
        assert!(matches!(mkdir.kind, "already-exists" | "other"));
        // Node's operand is `dirname(OLLAMA_CFG)`.
        assert!(
            mkdir.message.contains(&format!("mkdir '{blocked_parent}'")),
            "{}",
            mkdir.message
        );

        let path = fixture.path("write-failure/ollama.json");
        let temp_path = format!("{path}.1.2.tmp");
        create_dir_all(&temp_path).unwrap();
        let write_failure = super::write(&path, &temp_path, "{}").unwrap_err();
        assert_eq!(write_failure.operation, "write");
        assert!(matches!(write_failure.kind, "permission-denied" | "other"));
        // `writeFileSync` opens the temp path before writing.
        assert!(
            write_failure
                .message
                .contains(&format!("open '{temp_path}'")),
            "{}",
            write_failure.message
        );
        assert!(!Path::new(&path).exists());

        let path = fixture.path("rename-failure/ollama.json");
        let temp_path = format!("{path}.1.2.tmp");
        create_dir_all(Path::new(&path)).unwrap();
        let rename = super::write(&path, &temp_path, "{}").unwrap_err();
        assert_eq!(rename.operation, "rename");
        assert!(matches!(
            rename.kind,
            "already-exists" | "permission-denied" | "other"
        ));
        assert!(Path::new(&temp_path).exists());
        // Fastify copies this text into the 500 body (`usage.mjs:415-420`): the
        // libuv code, the syscall and both operands.
        assert!(
            rename
                .message
                .contains(&format!("rename '{temp_path}' -> '{path}'")),
            "{}",
            rename.message
        );
    }

    // VERIFY: wave4-hostedits-10
    /// The exact libuv strings Node throws; Fastify puts them in a 500 body
    /// verbatim (`usage.mjs:415-420`).
    #[test]
    fn failure_messages_follow_the_libuv_fs_shape() {
        assert_eq!(
            node_fs_message(
                "rename",
                &["/state/ollama.json.1.2.tmp", "/state/ollama.json"],
                &Error::from(ErrorKind::IsADirectory),
            ),
            "EISDIR: illegal operation on a directory, rename '/state/ollama.json.1.2.tmp' -> '/state/ollama.json'"
        );
        // `readFileSync`/`writeFileSync` surface the `open` syscall.
        assert_eq!(
            node_fs_message(
                "open",
                &["/state/ollama.json"],
                &Error::from(ErrorKind::NotFound)
            ),
            "ENOENT: no such file or directory, open '/state/ollama.json'"
        );
        assert_eq!(
            node_fs_message("mkdir", &["/state"], &Error::from(ErrorKind::AlreadyExists)),
            "EEXIST: file already exists, mkdir '/state'"
        );
        // `writeSync` reports the fd, not a path.
        assert_eq!(
            node_fs_message("write", &[], &Error::from(ErrorKind::StorageFull)),
            "ENOSPC: no space left on device, write"
        );
        // A kind the table cannot name falls back to Rust's Display (disclosed).
        let other = Error::other("boom");
        assert_eq!(node_fs_message("rename", &["a", "b"], &other), "boom");
    }
}
