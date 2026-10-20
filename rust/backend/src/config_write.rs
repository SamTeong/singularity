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

// Node derives and authorizes the target, parses JSON, and handles backups.
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
    use std::fs::{self, File, FileTimes, read_to_string, write};
    use std::time::Duration;

    struct Fixture(std::path::PathBuf);

    impl Fixture {
        fn new() -> Self {
            let id = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir().join(format!("singularity-config-write-{id}"));
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
    fn system_time_ms_preserves_values_before_and_after_epoch() {
        let before = UNIX_EPOCH.checked_sub(Duration::from_millis(1500)).unwrap();
        let after = UNIX_EPOCH + Duration::from_millis(2750);
        assert_eq!(system_time_ms(before), -1500.0);
        assert_eq!(system_time_ms(after), 2750.0);
    }

    #[test]
    fn writes_utf8_checks_stale_mtime_force_and_missing_parent() {
        let fixture = Fixture::new();
        let path = fixture.put("project/.claude/settings.json", "prior");
        let initial = mtime_ms(&path).unwrap();

        let saved = write_file(
            path.to_str(),
            Some("{\"theme\":\"更新 ✓\"}"),
            Some(initial),
            false,
        );
        assert_eq!(saved["ok"], true);
        assert_eq!(read_to_string(&path).unwrap(), "{\"theme\":\"更新 ✓\"}");
        assert!(saved["mtime"].as_f64().is_some());

        let empty = write_file(path.to_str(), Some(""), saved["mtime"].as_f64(), false);
        assert_eq!(empty["ok"], true);
        assert_eq!(fs::read(&path).unwrap(), b"");

        write(&path, "external").unwrap();
        let stale = write_file(path.to_str(), Some("rejected"), Some(initial - 10.0), false);
        assert_eq!(stale, json!({ "ok": false, "error": "changed on disk" }));
        assert_eq!(read_to_string(&path).unwrap(), "external");

        let forced = write_file(path.to_str(), Some("forced"), Some(initial - 10.0), true);
        assert_eq!(forced["ok"], true);
        assert_eq!(read_to_string(&path).unwrap(), "forced");

        let missing = fixture.0.join("absent/.claude/settings.json");
        let failed = write_file(missing.to_str(), Some("{}"), None, false);
        assert_eq!(failed["ok"], false);
        assert!(!missing.parent().unwrap().exists());
    }

    #[test]
    fn signed_mtime_guard_rejects_pre_epoch_changes() {
        let fixture = Fixture::new();
        let path = fixture.put("project/.claude/settings.json", "prior");
        let before_epoch = UNIX_EPOCH.checked_sub(Duration::from_secs(60)).unwrap();
        let set_time = File::open(&path)
            .and_then(|file| file.set_times(FileTimes::new().set_modified(before_epoch)));
        if let Err(error) = set_time {
            eprintln!("SKIP pre-epoch filesystem write check: {error}");
            return;
        }
        let expected = mtime_ms(&path).unwrap();
        assert!(expected < 0.0);

        let stale = write_file(
            path.to_str(),
            Some("rejected"),
            Some(expected + 10.0),
            false,
        );
        assert_eq!(stale, json!({ "ok": false, "error": "changed on disk" }));
        assert_eq!(read_to_string(&path).unwrap(), "prior");

        let saved = write_file(path.to_str(), Some("updated"), Some(expected), false);
        assert_eq!(saved["ok"], true);
        assert_eq!(read_to_string(&path).unwrap(), "updated");
    }
}
