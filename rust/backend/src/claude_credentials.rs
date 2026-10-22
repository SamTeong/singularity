use std::fs;
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

#[cfg(test)]
mod tests {
    use super::{ClaudeCredentialsRead, read};
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
}
