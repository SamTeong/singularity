use serde_json::{Value, json};
use std::fs;
use std::path::Path;
use std::time::UNIX_EPOCH;

fn mtime_ms(path: &Path) -> Option<f64> {
    let modified = fs::metadata(path).ok()?.modified().ok()?;
    Some(match modified.duration_since(UNIX_EPOCH) {
        Ok(duration) => duration.as_secs_f64() * 1000.0,
        Err(error) => -(error.duration().as_secs_f64() * 1000.0),
    })
}

pub fn write(path: Option<&str>, content: &Value, mtime: Option<f64>, force: bool) -> Value {
    let Some(path) = path else {
        return json!({ "ok": false, "error": "bad path" });
    };
    let Some(path_content) = content.as_str() else {
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
    if let Err(error) = fs::write(path, path_content.as_bytes()) {
        return json!({ "ok": false, "error": error.to_string() });
    }
    match mtime_ms(path) {
        Some(mtime) => json!({ "ok": true, "mtime": mtime }),
        None => json!({ "ok": false, "error": "unreadable file" }),
    }
}

pub fn create(path: Option<&str>, kind: Option<&str>) -> Value {
    let Some(path) = path else {
        return json!({ "ok": false, "error": "bad path" });
    };
    if Path::new(path).exists() {
        return json!({ "ok": false, "error": "already exists" });
    }
    let result = if kind == Some("dir") {
        fs::create_dir_all(path)
    } else {
        fs::write(path, [])
    };
    match result {
        Ok(()) => json!({ "ok": true }),
        Err(error) => json!({ "ok": false, "error": error.to_string() }),
    }
}

pub fn delete(path: Option<&str>) -> Value {
    let Some(path) = path else {
        return json!({ "ok": false, "error": "bad path" });
    };
    let path = Path::new(path);
    if !path.exists() {
        return json!({ "ok": false, "error": "not found" });
    }
    let result = match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            #[cfg(windows)]
            {
                if path.is_dir() {
                    fs::remove_dir(path)
                } else {
                    fs::remove_file(path)
                }
            }
            #[cfg(not(windows))]
            {
                fs::remove_file(path)
            }
        }
        Ok(metadata) if metadata.is_dir() => fs::remove_dir_all(path),
        Ok(_) => fs::remove_file(path),
        Err(error) => return json!({ "ok": false, "error": error.to_string() }),
    };
    match result {
        Ok(()) => json!({ "ok": true }),
        Err(error) => json!({ "ok": false, "error": error.to_string() }),
    }
}

pub fn rename(from: Option<&str>, to: Option<&str>) -> Value {
    let (Some(from), Some(to)) = (from, to) else {
        return json!({ "ok": false, "error": "bad path" });
    };
    if !Path::new(from).exists() {
        return json!({ "ok": false, "error": "not found" });
    }
    if Path::new(to).exists() {
        return json!({ "ok": false, "error": "already exists" });
    }
    match fs::rename(from, to) {
        Ok(()) => json!({ "ok": true }),
        Err(error) => json!({ "ok": false, "error": error.to_string() }),
    }
}
