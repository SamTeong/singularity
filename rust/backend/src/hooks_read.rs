use serde::Serialize;
use serde_json::Value;
use serde_json::value::RawValue;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

// Read side of hooks.mjs: bounded walk of <cwd>/.claude/hooks, first-match
// content search, and the raw file read. Node stays the configured-root owner
// and path guard: it passes [{root, dir}] scan pairs (dir = join(cwd,
// '.claude', 'hooks'), root = the verbatim client cwd) or an already-guarded
// path. Node also owns the localeCompare sorts, which Rust cannot reproduce.
const FILE_CAP: usize = 2000;

#[derive(Serialize)]
struct HookFile {
    path: String,
    rel: String,
    name: String,
}

#[derive(Serialize)]
struct Group<'a> {
    cwd: &'a str,
    files: Vec<HookFile>,
}

#[derive(Serialize)]
struct Hit<'a> {
    cwd: &'a str,
    path: String,
    rel: String,
    line: usize,
    text: String,
}

#[derive(Serialize)]
struct FileReply {
    exists: bool,
    content: String,
    mtime: f64,
}

#[derive(Serialize)]
struct ErrorReply {
    error: String,
}

fn raw<T: Serialize>(value: &T) -> Box<RawValue> {
    serde_json::value::to_raw_value(value).expect("hook payload serialization is infallible")
}

fn scans(roots: &Value) -> Vec<(String, PathBuf)> {
    roots
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|scan| {
            let root = scan["root"].as_str()?;
            let dir = scan["dir"].as_str()?;
            Some((root.to_owned(), PathBuf::from(dir)))
        })
        .collect()
}

// Mirrors listHooks: stack DFS, cap checked per popped dir (so one dir can
// overshoot it, as in Node), readdir order kept; Node sorts by rel.
fn walk(dir: &Path) -> Vec<HookFile> {
    let mut out = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while out.len() < FILE_CAP {
        let Some(current) = stack.pop() else { break };
        let Ok(entries) = crate::fs_sorted::read_dir(&current) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            let path = entry.path();
            if kind.is_dir() {
                stack.push(path);
            } else if kind.is_file() {
                let rel = path
                    .strip_prefix(dir)
                    .unwrap_or(&path)
                    .to_string_lossy()
                    .into_owned();
                out.push(HookFile {
                    path: path.to_string_lossy().into_owned(),
                    rel,
                    name: entry.file_name().to_string_lossy().into_owned(),
                });
            }
        }
    }
    out
}

pub fn list(roots: &Value) -> Box<RawValue> {
    let scans = scans(roots);
    let groups: Vec<Group> = scans
        .iter()
        .map(|(cwd, dir)| Group {
            cwd,
            files: walk(dir),
        })
        .collect();
    raw(&groups)
}

// String.prototype.trim: JS whitespace adds U+FEFF and lacks U+0085.
fn js_trim(line: &str) -> &str {
    line.trim_matches(|c: char| (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}')
}

// JS .slice(0, 200) cover over UTF-16 units; the Node bridge trims a split
// surrogate pair back to 200 (rules.rs twin).
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

// Mirrors searchHooks: first matching line per file, dedup by path across
// roots (first root wins). Node sorts the hits by path.
pub fn search(roots: &Value, q: &str) -> Box<RawValue> {
    let needle = q.to_lowercase();
    let scans = scans(roots);
    let mut hits: Vec<Hit> = Vec::new();
    if !needle.is_empty() {
        let mut seen = HashSet::new();
        for (cwd, dir) in &scans {
            for file in walk(dir) {
                if !seen.insert(file.path.clone()) {
                    continue;
                }
                let Ok(bytes) = fs::read(&file.path) else {
                    continue;
                };
                let content = String::from_utf8_lossy(&bytes);
                let Some((index, line)) = content
                    .split('\n')
                    .enumerate()
                    .find(|(_, line)| line.to_lowercase().contains(&needle))
                else {
                    continue;
                };
                hits.push(Hit {
                    cwd,
                    path: file.path,
                    rel: file.rel,
                    line: index + 1,
                    text: utf16_prefix_cover(js_trim(line), 200),
                });
            }
        }
    }
    raw(&hits)
}

fn signed_time_ms(time: SystemTime) -> f64 {
    match time.duration_since(UNIX_EPOCH) {
        Ok(since) => since.as_secs_f64() * 1000.0,
        Err(before) => -before.duration().as_secs_f64() * 1000.0,
    }
}

// readHook body after the Node guard: missing -> exists:false; a read/stat
// failure is reported as {error} so the bridge rethrows, as readFileSync does.
pub fn read(path: &str) -> Box<RawValue> {
    let path = Path::new(path);
    if !path.exists() {
        return raw(&FileReply {
            exists: false,
            content: String::new(),
            mtime: 0.0,
        });
    }
    let result = fs::read(path).and_then(|bytes| {
        let modified = fs::metadata(path)?.modified()?;
        Ok(FileReply {
            exists: true,
            content: String::from_utf8_lossy(&bytes).into_owned(),
            mtime: signed_time_ms(modified),
        })
    });
    match result {
        Ok(reply) => raw(&reply),
        Err(error) => raw(&ErrorReply {
            error: error.to_string(),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs::{create_dir_all, write};

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let id = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir().join(format!("singularity-hooks-read-{id}"));
            create_dir_all(path.join(".claude").join("hooks")).unwrap();
            Self(path)
        }
        fn hooks(&self) -> PathBuf {
            self.0.join(".claude").join("hooks")
        }
        fn put(&self, rel: &str, bytes: &[u8]) -> PathBuf {
            let path = self.hooks().join(rel);
            create_dir_all(path.parent().unwrap()).unwrap();
            write(&path, bytes).unwrap();
            path
        }
        fn scans(&self, root: &str) -> Value {
            json!([{ "root": root, "dir": self.hooks().to_string_lossy() }])
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn parse(raw: Box<RawValue>) -> Value {
        serde_json::from_str(raw.get()).unwrap()
    }

    #[test]
    fn list_walks_nested_files_with_native_rel_and_keeps_missing_dirs_empty() {
        let f = Fixture::new();
        f.put("a.mjs", b"1");
        f.put("sub/.dot/b.ps1", b"2");
        let groups = parse(list(&json!([
            { "root": "raw-cwd", "dir": f.hooks().to_string_lossy() },
            { "root": "gone", "dir": f.0.join("absent").to_string_lossy() },
        ])));
        assert_eq!(groups[0]["cwd"], "raw-cwd");
        assert_eq!(groups[1], json!({ "cwd": "gone", "files": [] }));
        let mut files = groups[0]["files"].as_array().unwrap().clone();
        files.sort_by(|a, b| a["rel"].as_str().cmp(&b["rel"].as_str()));
        let rel = Path::new("sub").join(".dot").join("b.ps1");
        assert_eq!(
            files[0],
            json!({ "path": f.hooks().join("a.mjs").to_string_lossy(), "rel": "a.mjs", "name": "a.mjs" })
        );
        assert_eq!(
            files[1],
            json!({ "path": f.hooks().join(&rel).to_string_lossy(), "rel": rel.to_string_lossy(), "name": "b.ps1" })
        );
    }

    #[test]
    fn list_cap_is_checked_per_directory_like_node() {
        let f = Fixture::new();
        for index in 0..FILE_CAP + 5 {
            f.put(&format!("f{index}.sh"), b"x");
        }
        f.put("deeper/late.sh", b"x");
        let groups = parse(list(&f.scans("r")));
        // The root dir alone overshoots the cap, so the queued subdir is never read.
        assert_eq!(groups[0]["files"].as_array().unwrap().len(), FILE_CAP + 5);
    }

    #[test]
    fn search_reports_first_match_per_file_trimmed_and_dedups_roots() {
        let f = Fixture::new();
        f.put(
            "h.mjs",
            "\u{feff} const a\r\n\t NEEDLE one \r\nneedle two".as_bytes(),
        );
        f.put("none.mjs", b"nothing here");
        let scans = json!([
            { "root": "first", "dir": f.hooks().to_string_lossy() },
            { "root": "second", "dir": f.hooks().to_string_lossy() },
        ]);
        let hits = parse(search(&scans, "needle"));
        assert_eq!(hits.as_array().unwrap().len(), 1);
        assert_eq!(hits[0]["cwd"], "first");
        assert_eq!(hits[0]["line"], 2);
        assert_eq!(hits[0]["text"], "NEEDLE one");
        assert_eq!(hits[0]["rel"], "h.mjs");
        assert_eq!(parse(search(&scans, "")), json!([]));
    }

    #[test]
    fn search_snippet_covers_200_utf16_units() {
        let f = Fixture::new();
        let line = format!("{}\u{1F600} needle", "x".repeat(199));
        f.put("clip.mjs", line.as_bytes());
        let hits = parse(search(&f.scans("r"), "needle"));
        assert_eq!(hits[0]["text"], format!("{}\u{1F600}", "x".repeat(199)));
    }

    #[test]
    fn read_returns_lossy_content_mtime_and_missing_shape() {
        let f = Fixture::new();
        let path = f.put("r.mjs", &[b'o', b'k', 0xff]);
        let reply = parse(read(path.to_str().unwrap()));
        assert_eq!(reply["exists"], true);
        assert_eq!(reply["content"], "ok\u{fffd}");
        assert!(reply["mtime"].as_f64().unwrap() > 0.0);
        let missing = parse(read(f.hooks().join("nope").to_str().unwrap()));
        assert_eq!(
            missing,
            json!({ "exists": false, "content": "", "mtime": 0.0 })
        );
        let dir = parse(read(f.hooks().to_str().unwrap()));
        assert!(dir["error"].as_str().is_some());
    }
}
