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
}

impl FsFailure {
    fn new(path: &str, operation: &'static str, error: Error) -> Self {
        Self {
            kind: stable_kind(error.kind()),
            path: path.to_owned(),
            operation,
        }
    }
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
        .map_err(|error| FsFailure::new(path, "read", error))
}

pub fn write(path: &str, temp_path: &str, text: &str) -> Result<(), FsFailure> {
    let configured = Path::new(path);
    if let Some(parent) = configured.parent() {
        fs::create_dir_all(parent).map_err(|error| FsFailure::new(path, "mkdir", error))?;
    }

    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(temp_path)
        .map_err(|error| FsFailure::new(path, "write", error))?;
    file.write_all(text.as_bytes())
        .map_err(|error| FsFailure::new(path, "write", error))?;
    drop(file);
    fs::rename(temp_path, configured).map_err(|error| FsFailure::new(path, "rename", error))
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

        let path = fixture.path("write-failure/ollama.json");
        let temp_path = format!("{path}.1.2.tmp");
        create_dir_all(&temp_path).unwrap();
        let write_failure = super::write(&path, &temp_path, "{}").unwrap_err();
        assert_eq!(write_failure.operation, "write");
        assert!(matches!(write_failure.kind, "permission-denied" | "other"));
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
    }
}
