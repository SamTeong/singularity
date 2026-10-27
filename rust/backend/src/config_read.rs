use serde::Serialize;
use serde_json::Value;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Serialize)]
struct FileReply {
    exists: bool,
    content: String,
    mtime: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Serialize)]
struct SearchHit<'a> {
    cwd: &'a str,
    scope: &'a str,
    path: &'a str,
    line: usize,
    text: String,
}

#[derive(Serialize)]
struct ScanReply {
    roots: Vec<String>,
    truncated: bool,
}

fn raw<T: Serialize>(value: &T) -> Box<serde_json::value::RawValue> {
    serde_json::value::to_raw_value(value).expect("config payload serialization is infallible")
}

fn signed_time_ms(time: SystemTime) -> f64 {
    match time.duration_since(UNIX_EPOCH) {
        Ok(since) => since.as_secs_f64() * 1000.0,
        Err(before) => -before.duration().as_secs_f64() * 1000.0,
    }
}

fn read_file(path: &str) -> Result<FileReply, String> {
    let path_buf = Path::new(path);
    let metadata = match fs::metadata(path_buf) {
        Ok(metadata) => metadata,
        Err(_) => {
            return Ok(FileReply {
                exists: false,
                content: String::new(),
                mtime: 0.0,
                error: None,
            });
        }
    };
    let bytes = fs::read(path_buf).map_err(|error| error.to_string())?;
    let modified = metadata.modified().map_err(|error| error.to_string())?;
    Ok(FileReply {
        exists: true,
        content: String::from_utf8_lossy(&bytes).into_owned(),
        mtime: signed_time_ms(modified),
        error: None,
    })
}

pub fn read(path: &str) -> Box<serde_json::value::RawValue> {
    match read_file(path) {
        Ok(reply) => raw(&reply),
        Err(error) => raw(&FileReply {
            exists: false,
            content: String::new(),
            mtime: 0.0,
            error: Some(error),
        }),
    }
}

// JS String.prototype.trim differs from Rust trim for U+0085 and U+FEFF.
fn js_trim(line: &str) -> &str {
    line.trim_matches(|c: char| (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}')
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
    prefix
}

pub fn search(roots: &Value, q: &str) -> Box<serde_json::value::RawValue> {
    search_scopes(
        roots,
        q,
        &[("project", "project"), ("local", "local")],
        false,
    )
}

pub fn search_codex(roots: &Value, q: &str) -> Box<serde_json::value::RawValue> {
    search_scopes(roots, q, &[("project", "project"), ("user", "user")], true)
}

fn search_scopes(
    roots: &Value,
    q: &str,
    scopes: &[(&str, &str)],
    fail_on_read_error: bool,
) -> Box<serde_json::value::RawValue> {
    let needle = q.to_lowercase();
    let mut hits = Vec::new();
    if needle.is_empty() {
        return raw(&hits);
    }
    let mut seen = HashSet::new();
    for root in roots.as_array().into_iter().flatten() {
        let Some(cwd) = root["cwd"].as_str() else {
            continue;
        };
        let mut files = Vec::new();
        let mut failure = None;
        for &(scope, key) in scopes {
            let Some(path) = root[key].as_str() else {
                continue;
            };
            match read_file(path) {
                Ok(reply) => files.push((scope, path, reply.content)),
                Err(error) => {
                    failure = Some(error);
                    break;
                }
            }
        }
        if let Some(error) = failure {
            if fail_on_read_error {
                return raw(&serde_json::json!({ "error": error }));
            }
            continue;
        }
        for (scope, path, content) in files {
            if content.is_empty() || !seen.insert(path.to_owned()) {
                continue;
            }
            if let Some((index, line)) = content
                .split('\n')
                .enumerate()
                .find(|(_, line)| line.to_lowercase().contains(&needle))
            {
                hits.push(SearchHit {
                    cwd,
                    scope,
                    path,
                    line: index + 1,
                    text: utf16_prefix_cover(js_trim(line), 200),
                });
            }
        }
    }
    raw(&hits)
}

const SCAN_SKIP: &[&str] = &[
    "node_modules",
    "dist",
    "build",
    "worktrees",
    ".cache",
    "AppData",
    "Temp",
];

pub fn scan(root: &str, cap: f64) -> Box<serde_json::value::RawValue> {
    scan_config(
        root,
        cap,
        ".claude",
        &["settings.json", "settings.local.json"],
    )
}

pub fn scan_codex(root: &str, cap: f64) -> Box<serde_json::value::RawValue> {
    scan_config(root, cap, ".codex", &["config.toml"])
}

fn scan_config(
    root: &str,
    cap: f64,
    config_dir_name: &str,
    files: &[&str],
) -> Box<serde_json::value::RawValue> {
    let mut hits = Vec::new();
    let mut stack = vec![PathBuf::from(root)];
    let mut seen = 0usize;
    while !stack.is_empty() && (seen as f64) < cap {
        let dir = stack.pop().expect("stack is nonempty");
        seen += 1;
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        let entries: Vec<_> = entries.flatten().collect();
        if entries
            .iter()
            .any(|entry| entry.file_name() == config_dir_name)
        {
            let config_dir = dir.join(config_dir_name);
            if files.iter().any(|file| config_dir.join(file).exists()) {
                hits.push(dir.to_string_lossy().into_owned());
            }
        }
        for entry in entries {
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            let name = entry.file_name().to_string_lossy().into_owned();
            if kind.is_dir() && !name.starts_with('.') && !SCAN_SKIP.contains(&name.as_str()) {
                stack.push(entry.path());
            }
        }
    }
    raw(&ScanReply {
        roots: hits,
        truncated: (seen as f64) >= cap,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NEXT: AtomicUsize = AtomicUsize::new(0);

    fn temp_dir(label: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "sing-config-read-{label}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn read_has_missing_shape_and_replaces_invalid_utf8() {
        let dir = temp_dir("read");
        let missing = read_file(dir.join("missing").to_str().unwrap()).unwrap();
        assert!(!missing.exists);
        assert_eq!(missing.content, "");
        assert_eq!(missing.mtime, 0.0);

        let file = dir.join("settings.json");
        fs::write(&file, b"{\"theme\":\"light\"}\xff").unwrap();
        let got = read_file(file.to_str().unwrap()).unwrap();
        assert!(got.exists);
        assert!(got.content.contains('\u{fffd}'));
        assert!(got.mtime > 0.0);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn search_returns_first_matching_line_and_utf16_cover() {
        let dir = temp_dir("search");
        let project = dir.join("project.json");
        let local = dir.join("local.json");
        fs::write(&project, "  first\n  THEME: \"dark\"\n  THEME: later  ").unwrap();
        fs::write(&local, "none").unwrap();
        let roots = serde_json::json!([{
            "cwd": dir.to_string_lossy(),
            "project": project.to_string_lossy(),
            "local": local.to_string_lossy(),
        }]);
        let hits: Vec<Value> = serde_json::from_str(search(&roots, "theme").get()).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0]["line"], 2);
        assert_eq!(hits[0]["scope"], "project");
        assert_eq!(hits[0]["text"], "THEME: \"dark\"");

        let long = format!("{}😀", "x".repeat(199));
        assert_eq!(utf16_prefix_cover(&long, 200).encode_utf16().count(), 201);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn scan_skips_dotdirs_and_reports_cap_truncation() {
        let dir = temp_dir("scan");
        let own = dir.join(".claude");
        fs::create_dir_all(&own).unwrap();
        fs::write(own.join("settings.json"), "{}").unwrap();
        let hidden = dir.join(".hidden").join(".claude");
        fs::create_dir_all(&hidden).unwrap();
        fs::write(hidden.join("settings.json"), "{}").unwrap();
        fs::create_dir_all(dir.join("child")).unwrap();
        let result: Value = serde_json::from_str(scan(dir.to_str().unwrap(), 1.0).get()).unwrap();
        assert_eq!(result["roots"].as_array().unwrap().len(), 1);
        assert_eq!(result["truncated"], true);
        fs::remove_dir_all(dir).unwrap();
    }
}
