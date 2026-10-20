use serde_json::{Value, json};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::thread;
use std::time::Duration;

const TELEMETRY_MAX_RECORDS: usize = 1000;

fn replace(path: &str, contents: &str) -> Result<(), String> {
    let tmp = format!("{path}.{}.tmp", std::process::id());
    fs::write(&tmp, contents).map_err(|error| error.to_string())?;
    for attempt in 1..=5 {
        match fs::rename(&tmp, path) {
            Ok(()) => return Ok(()),
            Err(error)
                if attempt < 5
                    && (error.kind() == std::io::ErrorKind::PermissionDenied
                        || matches!(error.raw_os_error(), Some(16 | 32))) =>
            {
                thread::sleep(Duration::from_millis(20 * attempt));
            }
            Err(error) => return Err(error.to_string()),
        }
    }
    Err("atomic replacement retries exhausted".to_owned())
}

pub fn load(path: &str) -> Value {
    let contents = match fs::read_to_string(path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return json!({ "state": null });
        }
        Err(error) => return json!({ "error": error.to_string() }),
    };
    match serde_json::from_str::<Value>(&contents) {
        Ok(state) => json!({ "state": state }),
        Err(error) => json!({ "error": error.to_string() }),
    }
}

pub fn save(path: &str, state: &Value) -> Value {
    let contents = match serde_json::to_string_pretty(state) {
        Ok(contents) => contents,
        Err(error) => return json!({ "error": error.to_string() }),
    };
    match replace(path, &contents) {
        Ok(()) => json!({ "ok": true }),
        Err(error) => json!({ "error": error }),
    }
}

pub fn append_telemetry(path: &str, record: &Value) -> Value {
    let file = Path::new(path);
    if let Some(parent) = file.parent() {
        if let Err(error) = fs::create_dir_all(parent) {
            return json!({ "error": error.to_string() });
        }
    }
    let line = match serde_json::to_string(record) {
        Ok(line) => line,
        Err(error) => return json!({ "error": error.to_string() }),
    };
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut output = match options.open(path) {
        Ok(output) => output,
        Err(error) => return json!({ "error": error.to_string() }),
    };
    if let Err(error) = writeln!(output, "{line}") {
        return json!({ "error": error.to_string() });
    }
    drop(output);

    let contents = match fs::read_to_string(path) {
        Ok(contents) => contents,
        Err(error) => return json!({ "error": error.to_string() }),
    };
    let lines: Vec<_> = contents.trim_end().lines().collect();
    if lines.len() > TELEMETRY_MAX_RECORDS {
        let retained = lines[lines.len() - TELEMETRY_MAX_RECORDS..].join("\n") + "\n";
        if let Err(error) = replace(path, &retained) {
            return json!({ "error": error });
        }
    }
    json!({ "ok": true })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct Fixture(std::path::PathBuf);
    impl Fixture {
        fn new() -> Self {
            let id = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir().join(format!("singularity-window-anchor-{id}"));
            fs::create_dir_all(&path).unwrap();
            Self(path)
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
    fn load_and_save_use_the_configured_path_and_pretty_json() {
        let fixture = Fixture::new();
        let path = fixture.path("state.json");
        assert_eq!(load(&path), json!({ "state": null }));
        let state = json!({ "codex": { "lastResult": "Ok" } });
        assert_eq!(save(&path, &state), json!({ "ok": true }));
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            serde_json::to_string_pretty(&state).unwrap()
        );
        assert_eq!(load(&path), json!({ "state": state }));
        let updated = json!({ "codex": { "lastResult": "Skipped" } });
        assert_eq!(save(&path, &updated), json!({ "ok": true }));
        assert_eq!(load(&path), json!({ "state": updated }));
    }

    #[test]
    fn telemetry_appends_json_lines_and_retains_the_last_thousand() {
        let fixture = Fixture::new();
        let path = fixture.path("nested/runs.jsonl");
        assert_eq!(
            append_telemetry(&path, &json!({ "index": 0 })),
            json!({ "ok": true })
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        let existing = (0..1001)
            .map(|index| json!({ "index": index }).to_string())
            .collect::<Vec<_>>()
            .join("\n")
            + "\n";
        fs::write(&path, existing).unwrap();
        assert_eq!(
            append_telemetry(&path, &json!({ "index": 1001 })),
            json!({ "ok": true })
        );
        let lines: Vec<_> = fs::read_to_string(path)
            .unwrap()
            .lines()
            .map(str::to_owned)
            .collect();
        assert_eq!(lines.len(), 1000);
        assert_eq!(
            serde_json::from_str::<Value>(&lines[0]).unwrap()["index"],
            2
        );
        assert_eq!(
            serde_json::from_str::<Value>(lines.last().unwrap()).unwrap()["index"],
            1001
        );
    }

    #[test]
    fn persistence_errors_are_returned_to_the_bridge() {
        let fixture = Fixture::new();
        assert!(load(&fixture.path("."))["error"].is_string());
        assert!(save(&fixture.path("missing-parent/state.json"), &json!({}))["error"].is_string());
    }
}
