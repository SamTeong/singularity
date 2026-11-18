use serde_json::{Value, json};
use std::fs;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

fn system_time_ms(time: SystemTime) -> f64 {
    match time.duration_since(UNIX_EPOCH) {
        Ok(duration) => duration.as_secs_f64() * 1000.0,
        Err(error) => -(error.duration().as_secs_f64() * 1000.0),
    }
}

fn mtime_ms(path: &Path) -> Option<f64> {
    let modified = fs::metadata(path).ok()?.modified().ok()?;
    Some(system_time_ms(modified))
}

// Node derives and authorizes the target, parses TOML, and handles backups.
// This final guard runs after the private bridge queue wait, directly before
// writing the already validated UTF-8 content.
pub fn write_file(
    path: Option<&str>,
    content: Option<&str>,
    mtime: Option<f64>,
    force: bool,
) -> Value {
    let Some(path) = path.filter(|path| !path.is_empty()) else {
        return json!({ "ok": false, "error": "path required" });
    };
    let Some(content) = content else {
        return json!({ "ok": false, "error": "content must be a string" });
    };
    let path = Path::new(path);
    if let Some(expected) = mtime.filter(|_| !force) {
        if path.exists() {
            let Some(actual) = mtime_ms(path) else {
                return json!({ "ok": false, "error": "unreadable file" });
            };
            if (actual - expected).abs() > 1.0 {
                return json!({ "ok": false, "error": "changed on disk" });
            }
        }
    }
    if let Err(error) = fs::write(path, content.as_bytes()) {
        return json!({ "ok": false, "error": error.to_string() });
    }
    match mtime_ms(path) {
        Some(mtime) => json!({ "ok": true, "mtime": mtime }),
        None => json!({ "ok": false, "error": "unreadable file" }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::{self, write};

    struct Fixture(std::path::PathBuf);

    impl Fixture {
        fn new() -> Self {
            let id = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir().join(format!("singularity-codex-config-write-{id}"));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        fn put(&self, rel: &str, content: &str) -> std::path::PathBuf {
            let path = self.0.join(rel);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            write(&path, content).unwrap();
            path
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn writes_utf8_empty_content_checks_stale_force_and_missing_parent() {
        let fixture = Fixture::new();
        let path = fixture.put("project/.codex/config.toml", "prior");
        let initial = mtime_ms(&path).unwrap();

        let saved = write_file(
            Some(path.to_str().unwrap()),
            Some("model = \"更新 ✓\""),
            None,
            false,
        );
        assert_eq!(saved["ok"], true);
        assert_eq!(fs::read_to_string(&path).unwrap(), "model = \"更新 ✓\"");

        let empty = write_file(
            Some(path.to_str().unwrap()),
            Some(""),
            saved["mtime"].as_f64(),
            false,
        );
        assert_eq!(empty["ok"], true);
        assert_eq!(fs::read_to_string(&path).unwrap(), "");

        let stale = write_file(
            Some(path.to_str().unwrap()),
            Some("rejected"),
            Some(mtime_ms(&path).unwrap() + 60_000.0),
            false,
        );
        assert_eq!(stale, json!({ "ok": false, "error": "changed on disk" }));
        assert_eq!(fs::read_to_string(&path).unwrap(), "");

        let forced = write_file(
            Some(path.to_str().unwrap()),
            Some("forced"),
            Some(initial + 10.0),
            true,
        );
        assert_eq!(forced["ok"], true);
        assert_eq!(fs::read_to_string(&path).unwrap(), "forced");

        let missing = fixture.0.join("absent/.codex/config.toml");
        let failed = write_file(Some(missing.to_str().unwrap()), Some(""), None, false);
        assert_eq!(failed["ok"], false);
        assert!(!fixture.0.join("absent").exists());
    }

    #[test]
    fn system_time_ms_preserves_fractional_values_before_and_after_epoch() {
        let before = UNIX_EPOCH
            .checked_sub(std::time::Duration::from_millis(1500))
            .unwrap();
        let after = UNIX_EPOCH + std::time::Duration::from_micros(2750123);
        assert_eq!(system_time_ms(before), -1500.0);
        assert_eq!(system_time_ms(after), 2750.123);
    }
}
