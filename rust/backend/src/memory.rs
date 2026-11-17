use serde_json::{Value, json};
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

fn raw<T: serde::Serialize>(value: &T) -> Box<serde_json::value::RawValue> {
    serde_json::value::to_raw_value(value).expect("memory payload serialization is infallible")
}

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

#[derive(serde::Serialize)]
struct ListedFile {
    project: String,
    file: String,
    path: String,
}

#[derive(serde::Serialize)]
struct SearchHit {
    project: String,
    file: String,
    path: String,
    line: usize,
    text: String,
}

static LINE_CACHE: OnceLock<Mutex<HashMap<String, (f64, Vec<String>)>>> = OnceLock::new();

fn path_text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn memory_dirs(root: &Path) -> Result<Vec<(String, std::path::PathBuf)>, String> {
    let entries = match crate::fs_sorted::read_dir(root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.to_string()),
    };
    let mut dirs = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        if !entry
            .file_type()
            .map_err(|error| error.to_string())?
            .is_dir()
        {
            continue;
        }
        let project = entry.file_name().to_string_lossy().into_owned();
        let dir = entry.path().join("memory");
        if dir.exists() {
            dirs.push((project, dir));
        }
    }
    Ok(dirs)
}

pub fn list_files(root: &str) -> Box<serde_json::value::RawValue> {
    let mut files = Vec::new();
    let dirs = match memory_dirs(Path::new(root)) {
        Ok(dirs) => dirs,
        Err(error) => return raw(&serde_json::json!({ "error": error })),
    };
    for (project, dir) in dirs {
        let entries = match crate::fs_sorted::read_dir(&dir) {
            Ok(entries) => entries,
            Err(error) => return raw(&serde_json::json!({ "error": error.to_string() })),
        };
        for entry in entries {
            let entry = match entry {
                Ok(entry) => entry,
                Err(error) => return raw(&serde_json::json!({ "error": error.to_string() })),
            };
            let file = entry.file_name().to_string_lossy().into_owned();
            if file.to_lowercase().ends_with(".md") {
                files.push(ListedFile {
                    project: project.clone(),
                    file,
                    path: path_text(&entry.path()),
                });
            }
        }
    }
    raw(&files)
}

fn cached_lines(path: &Path) -> Option<Vec<String>> {
    let modified = mtime_ms(path)?;
    let key = path_text(path);
    let cache = LINE_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Ok(cache) = cache.lock() {
        if let Some((cached_mtime, lines)) = cache.get(&key) {
            if *cached_mtime == modified {
                return Some(lines.clone());
            }
        }
    }
    let bytes = fs::read(path).ok()?;
    let content = String::from_utf8_lossy(&bytes);
    let parts: Vec<&str> = content.split('\n').collect();
    let lines: Vec<String> = parts
        .iter()
        .enumerate()
        .map(|(index, line)| {
            let line = *line;
            if index + 1 < parts.len() {
                line.strip_suffix('\r').unwrap_or(line).to_owned()
            } else {
                line.to_owned()
            }
        })
        .collect();
    if let Ok(mut cache) = cache.lock() {
        cache.insert(key, (modified, lines.clone()));
    }
    Some(lines)
}

fn utf16_prefix_cover(value: &str, limit: usize) -> String {
    let mut remaining = limit;
    let mut prefix = String::new();
    for character in value.chars() {
        if remaining == 0 {
            break;
        }
        prefix.push(character);
        remaining = remaining.saturating_sub(character.len_utf16());
    }
    // The gateway trims again before slicing; never end the cover on whitespace.
    let rest = &value[prefix.len()..];
    let tail = rest.len() - rest.trim_start().len();
    if prefix.ends_with(char::is_whitespace) {
        prefix.push_str(&rest[..tail]);
        prefix.extend(rest[tail..].chars().next());
    }
    prefix
}

pub fn search(files: &Value, query: &str) -> Box<serde_json::value::RawValue> {
    let needle = query.to_lowercase();
    if needle.is_empty() {
        return raw(&serde_json::json!({ "results": [], "capped": false }));
    }
    let mut results = Vec::new();
    for candidate in files.as_array().into_iter().flatten() {
        let (Some(project), Some(file), Some(path)) = (
            candidate["project"].as_str(),
            candidate["file"].as_str(),
            candidate["path"].as_str(),
        ) else {
            continue;
        };
        let Some(lines) = cached_lines(Path::new(path)) else {
            continue;
        };
        for (index, line) in lines.iter().enumerate() {
            if line.to_lowercase().contains(&needle) {
                results.push(SearchHit {
                    project: project.to_owned(),
                    file: file.to_owned(),
                    path: path.to_owned(),
                    line: index + 1,
                    // Node trims then slice(0, 200) after the bridge; 200 UTF-16 units
                    // of the trimmed line is enough cover without shipping huge lines.
                    text: utf16_prefix_cover(line.trim(), 200),
                });
                if results.len() >= 300 {
                    return raw(&serde_json::json!({ "results": results, "capped": true }));
                }
            }
        }
    }
    raw(&serde_json::json!({ "results": results, "capped": false }))
}

pub fn read_memory_file(path: &str) -> Box<serde_json::value::RawValue> {
    let path = Path::new(path);
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return raw(&serde_json::json!({ "ok": false, "error": "not found" }));
        }
        Err(error) => return raw(&serde_json::json!({ "ok": false, "error": error.to_string() })),
    };
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) => return raw(&serde_json::json!({ "ok": false, "error": error.to_string() })),
    };
    let Some(modified) = metadata.modified().ok().map(system_time_ms) else {
        return raw(&serde_json::json!({ "ok": false, "error": "modified time unavailable" }));
    };
    raw(
        &serde_json::json!({ "ok": true, "content": String::from_utf8_lossy(&bytes), "mtime": modified }),
    )
}

// Node authorizes the persisted Memory root and handles backups. This final
// check runs after the private bridge queue wait, directly before the write.
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
    use std::fs::{File, FileTimes, create_dir_all, read, read_to_string, write};
    use std::time::Duration;

    struct Fixture(PathBuf);

    use std::path::PathBuf;

    impl Fixture {
        fn new() -> Self {
            let id = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir().join(format!("singularity-memory-{id}"));
            create_dir_all(&path).unwrap();
            Self(path)
        }
        fn put(&self, rel: &str, content: &str) -> PathBuf {
            let path = self.0.join(rel);
            create_dir_all(path.parent().unwrap()).unwrap();
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
    fn writes_and_checks_pre_epoch_file_times() {
        let fixture = Fixture::new();
        let path = fixture.put("project/memory/fact.md", "prior");
        let before_epoch = UNIX_EPOCH.checked_sub(Duration::from_secs(60)).unwrap();
        let set_time_result = File::open(&path)
            .and_then(|file| file.set_times(FileTimes::new().set_modified(before_epoch)));
        if let Err(error) = set_time_result {
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

    #[test]
    fn writes_utf8_empty_content_checks_mtime_and_preserves_missing_parent_failure() {
        let fixture = Fixture::new();
        let path = fixture.put("project/memory/fact.md", "prior");
        let initial = mtime_ms(&path).unwrap();
        let saved = write_file(path.to_str(), Some("記憶 🧪"), Some(initial), false);
        assert_eq!(saved["ok"], true);
        assert_eq!(read_to_string(&path).unwrap(), "記憶 🧪");
        assert!(saved["mtime"].as_f64().is_some());

        let empty = write_file(path.to_str(), Some(""), None, false);
        assert_eq!(empty["ok"], true);
        assert_eq!(read(&path).unwrap(), b"");

        write(&path, "external").unwrap();
        let actual = mtime_ms(&path).unwrap();
        let stale = write_file(path.to_str(), Some("rejected"), Some(actual - 10.0), false);
        assert_eq!(stale, json!({ "ok": false, "error": "changed on disk" }));
        assert_eq!(read_to_string(&path).unwrap(), "external");
        let forced = write_file(path.to_str(), Some("forced"), Some(actual - 10.0), true);
        assert_eq!(forced["ok"], true);
        assert_eq!(read_to_string(&path).unwrap(), "forced");

        let missing = fixture.0.join("absent/child.md");
        let failed = write_file(missing.to_str(), Some("x"), None, false);
        assert_eq!(failed["ok"], false);
        assert!(!missing.parent().unwrap().exists());
    }

    #[test]
    fn search_caps_hit_text_before_serialising() {
        let fixture = Fixture::new();
        let path = fixture.put(
            "project/memory/fact.md",
            &format!("  needle {}", "x".repeat(100_000)),
        );
        let files =
            json!([{ "project": "project", "file": "fact.md", "path": path.to_str().unwrap() }]);
        let result: Value = serde_json::from_str(search(&files, "needle").get()).unwrap();
        let text = result["results"][0]["text"].as_str().unwrap();
        assert_eq!(text.encode_utf16().count(), 200);
        assert!(text.starts_with("needle x"));
    }

    #[test]
    fn hit_text_cover_survives_gateway_trim_at_the_cut() {
        let line = format!("needle{} tail", "x".repeat(193));
        let cover = utf16_prefix_cover(&line, 200);
        assert_eq!(cover, format!("needle{} t", "x".repeat(193)));
        assert_eq!(utf16_prefix_cover("short", 200), "short");
    }
}
