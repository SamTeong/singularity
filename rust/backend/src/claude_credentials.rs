use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;

#[derive(Debug, PartialEq, Eq)]
pub enum ClaudeCredentialsRead {
    File(String),
    Missing,
    ReadFailure,
}

pub fn read(path: &Path) -> ClaudeCredentialsRead {
    match fs::read(path) {
        Ok(bytes) => ClaudeCredentialsRead::File(String::from_utf8_lossy(&bytes).into_owned()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            ClaudeCredentialsRead::Missing
        }
        Err(_) => ClaudeCredentialsRead::ReadFailure,
    }
}

fn write_file(path: &Path, text: &str) -> std::io::Result<()> {
    let mut options = OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)?.write_all(text.as_bytes())
}

pub fn write(path: &Path, temp_path: &Path, text: &str) -> bool {
    if write_file(temp_path, text).is_ok() && fs::rename(temp_path, path).is_ok() {
        return true;
    }
    write_file(path, text).is_ok()
}

#[cfg(test)]
mod tests {
    use super::{ClaudeCredentialsRead, read, write};
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_path(label: &str) -> std::path::PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("claude-credentials-{label}-{nonce}"))
    }

    #[test]
    fn returns_raw_utf8_with_replacement_and_preserves_bom() {
        let path = temp_path("bytes");
        fs::write(&path, [0xef, 0xbb, 0xbf, b'{', 0xff, b'}']).unwrap();

        assert_eq!(
            read(&path),
            ClaudeCredentialsRead::File("\u{feff}{\u{fffd}}".to_owned())
        );
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn distinguishes_missing_and_other_read_failures() {
        let missing = temp_path("missing");
        assert_eq!(read(&missing), ClaudeCredentialsRead::Missing);

        let directory = temp_path("directory");
        fs::create_dir(&directory).unwrap();
        assert_eq!(read(&directory), ClaudeCredentialsRead::ReadFailure);
        fs::remove_dir(directory).unwrap();
    }

    #[test]
    fn replaces_existing_credentials_through_temp_file() {
        let directory = temp_path("replace");
        fs::create_dir(&directory).unwrap();
        let path = directory.join(".credentials.json");
        let temp = directory.join(".credentials.json.123.tmp");
        fs::write(&path, "old").unwrap();

        assert!(write(&path, &temp, "rotated"));
        assert_eq!(fs::read_to_string(&path).unwrap(), "rotated");
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn falls_back_to_direct_write_when_temp_creation_fails() {
        let directory = temp_path("fallback");
        fs::create_dir(&directory).unwrap();
        let path = directory.join(".credentials.json");
        let temp = directory.join("missing").join(".credentials.json.123.tmp");

        assert!(write(&path, &temp, "rotated"));
        assert_eq!(fs::read_to_string(&path).unwrap(), "rotated");
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn returns_false_when_temp_rename_and_direct_write_fail() {
        let directory = temp_path("write-failure");
        fs::create_dir(&directory).unwrap();
        let destination = directory.join("destination");
        let temp = directory.join(".credentials.json.123.tmp");
        fs::create_dir(&destination).unwrap();

        assert!(!write(&destination, &temp, "rotated"));
        assert_eq!(fs::read_to_string(&temp).unwrap(), "rotated");
        fs::remove_dir_all(directory).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn creates_credentials_with_private_mode() {
        use std::os::unix::fs::PermissionsExt;

        let directory = temp_path("mode");
        fs::create_dir(&directory).unwrap();
        let path = directory.join(".credentials.json");
        let temp = directory.join(".credentials.json.123.tmp");

        assert!(write(&path, &temp, "rotated"));
        assert_eq!(fs::metadata(path).unwrap().permissions().mode() & 0o077, 0);
        fs::remove_dir_all(directory).unwrap();
    }
}
