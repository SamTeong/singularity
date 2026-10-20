use serde_json::{Value, json};
use std::collections::HashMap;
use std::fs::{self, FileType};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::UNIX_EPOCH;

// Recursive .md walk + content search under <base>/.claude/rules (see
// rules.mjs). Node stays the configured-root owner: it resolves each picked
// base and passes [{root, dir}] scan pairs per request — `root` is kept as
// the verbatim base string the client sent (the UI groups files under it).
const FILE_CAP: usize = 2000;
const RESULT_CAP: usize = 300;
// Skip dot-dirs + heavy/vendored dirs during the recursive walk.
const SKIP_DIRS: &[&str] = &[
    ".git",
    ".obsidian",
    ".vscode",
    "node_modules",
    ".next",
    ".cache",
    "dist",
    "build",
];

struct RuleFile {
    root: String,
    path: PathBuf,
    rel: String,
    file: String,
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

// readdir order preserved (no sort); missing/unreadable dirs skip silently.
fn walk(root: &str, scan_dir: &Path, dir: &Path, out: &mut Vec<RuleFile>) {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(_) => return,
    };
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => continue,
        };
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        let kind: FileType = match entry.file_type() {
            Ok(kind) => kind,
            Err(_) => continue,
        };
        let path = entry.path();
        if kind.is_dir() {
            if !SKIP_DIRS.contains(&name.as_str()) {
                walk(root, scan_dir, &path, out);
                if out.len() >= FILE_CAP {
                    return;
                }
            }
        } else if kind.is_file() && name.to_lowercase().ends_with(".md") {
            let rel = path
                .strip_prefix(scan_dir)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            out.push(RuleFile {
                root: root.to_owned(),
                path,
                rel,
                file: name,
            });
            if out.len() >= FILE_CAP {
                return;
            }
        }
    }
}

fn rule_file_json(file: &RuleFile) -> Value {
    json!({
        "root": &file.root,
        "path": file.path.to_string_lossy(),
        "rel": &file.rel,
        "file": &file.file,
    })
}

pub fn list_files(roots: &Value) -> Value {
    let mut files: Vec<RuleFile> = Vec::new();
    let mut capped = false;
    for (root, dir) in scans(roots) {
        walk(&root, &dir, &dir, &mut files);
        if files.len() >= FILE_CAP {
            capped = true;
            break;
        }
    }
    json!({ "files": files.iter().map(rule_file_json).collect::<Vec<_>>(), "capped": capped })
}

// Search runs per keystroke; cache file lines by mtime (exact recheck per
// request) so only changed files are re-read from disk (wiki_read.rs twin).
fn line_cache() -> &'static Mutex<HashMap<PathBuf, (u128, Vec<String>)>> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, (u128, Vec<String>)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn read_lines(path: &Path) -> Option<Vec<String>> {
    let modified = fs::metadata(path).ok()?.modified().ok()?;
    let mtime_ms = modified.duration_since(UNIX_EPOCH).ok()?.as_millis();
    if let Some(lines) = line_cache()
        .lock()
        .ok()?
        .get(path)
        .and_then(|(mtime, lines)| (*mtime == mtime_ms).then(|| lines.clone()))
    {
        return Some(lines);
    }
    let text = String::from_utf8_lossy(&fs::read(path).ok()?).into_owned();
    let lines = text
        .split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line).to_owned())
        .collect::<Vec<_>>();
    line_cache()
        .lock()
        .ok()?
        .insert(path.to_path_buf(), (mtime_ms, lines.clone()));
    Some(lines)
}

// JS .slice(0, 200) analog over UTF-16 code units: cover whole chars within
// the limit (may exceed by one char when the boundary splits a surrogate pair;
// the Node bridge trims the remainder, as the wiki search does).
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

pub fn search(roots: &Value, q: &Value) -> Value {
    let query = q.as_str().unwrap_or("").to_lowercase();
    if query.is_empty() {
        return json!({ "results": [], "capped": false });
    }
    let mut results: Vec<Value> = Vec::new();
    for (root, dir) in scans(roots) {
        let mut files: Vec<RuleFile> = Vec::new();
        walk(&root, &dir, &dir, &mut files);
        for file in &files {
            let Some(lines) = read_lines(&file.path) else {
                continue;
            };
            for (index, line) in lines.iter().enumerate() {
                if line.to_lowercase().contains(&query) {
                    let text = utf16_prefix_cover(line.trim(), 200);
                    results.push(json!({
                        "root": &file.root,
                        "path": file.path.to_string_lossy(),
                        "rel": &file.rel,
                        "file": &file.file,
                        "line": index + 1,
                        "text": text,
                    }));
                    if results.len() >= RESULT_CAP {
                        return json!({ "results": results, "capped": true });
                    }
                }
            }
        }
    }
    json!({ "results": results, "capped": false })
}

fn signed_time_ms(time: std::time::SystemTime) -> f64 {
    match time.duration_since(UNIX_EPOCH) {
        Ok(since) => since.as_secs_f64() * 1000.0,
        Err(before) => -before.duration().as_secs_f64() * 1000.0,
    }
}

fn modified_ms(path: &Path) -> Result<f64, String> {
    let modified = fs::metadata(path)
        .map_err(|error| error.to_string())?
        .modified()
        .map_err(|error| error.to_string())?;
    Ok(signed_time_ms(modified))
}

pub fn write_file(
    path: Option<&str>,
    content: Option<&str>,
    mtime: Option<f64>,
    force: bool,
) -> Value {
    let Some(path) = path.filter(|path| !path.is_empty()) else {
        return json!({"ok": false, "error": "path required"});
    };
    let Some(content) = content else {
        return json!({"ok": false, "error": "content must be a string"});
    };
    let path = Path::new(path);
    if let Some(expected) = mtime.filter(|_| !force) {
        if path.exists() {
            match modified_ms(path) {
                Ok(actual) if (actual - expected).abs() > 1.0 => {
                    return json!({"ok": false, "error": "changed on disk"});
                }
                Ok(_) => {}
                Err(error) => return json!({"ok": false, "error": error}),
            }
        }
    }
    if let Err(error) = fs::write(path, content.as_bytes()) {
        return json!({"ok": false, "error": error.to_string()});
    }
    match modified_ms(path) {
        Ok(mtime) => json!({"ok": true, "mtime": mtime}),
        Err(error) => json!({"ok": false, "error": error}),
    }
}

// Companion <stem>-reference.md lookup for a rule file (see rules.mjs). The
// root is configured Node-side (SING_RULES_REF / homedir default) and passed
// per request; Rust never resolves it itself.
pub fn find_reference(path: Option<&str>, root: Option<&str>) -> Value {
    let Some(path) = path.filter(|path| !path.is_empty()) else {
        return json!({"ok": false, "error": "no path"});
    };
    let Some(root) = root else {
        return json!({"ok": false, "error": "no root"});
    };
    // Native-platform basename, mirroring node:path.basename. file_name()
    // yields None for root/".."/"." tails, which map to the no-stem failure.
    let name = Path::new(path)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let stem = if name.to_lowercase().ends_with(".md") {
        &name[..name.len() - 3]
    } else {
        &name
    };
    if stem.is_empty() {
        return json!({"ok": false, "error": "no stem"});
    }
    let reference = Path::new(root).join(format!("{stem}-reference.md"));
    if !reference.exists() {
        return json!({"ok": false, "error": "no reference"});
    }
    match fs::read(&reference) {
        Ok(bytes) => json!({
            "ok": true,
            "path": reference.to_string_lossy(),
            "content": String::from_utf8_lossy(&bytes),
        }),
        Err(error) => json!({"ok": false, "error": error.to_string()}),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::{create_dir_all, write};
    use std::time::{SystemTime, UNIX_EPOCH};

    struct Fixture(std::path::PathBuf);
    impl Fixture {
        fn new() -> Self {
            let id = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir().join(format!("singularity-rules-{id}"));
            create_dir_all(&path).unwrap();
            Self(path)
        }
        fn put(&self, rel: &str, bytes: &[u8]) {
            let path = self.0.join(rel);
            create_dir_all(path.parent().unwrap()).unwrap();
            write(path, bytes).unwrap();
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn signed_time_ms_preserves_times_before_and_after_epoch() {
        let duration = std::time::Duration::from_micros(2_750_125);
        let after = UNIX_EPOCH + duration;
        let before = UNIX_EPOCH - duration;
        assert_eq!(signed_time_ms(after), 2750.125);
        assert_eq!(signed_time_ms(before), -2750.125);
    }

    #[test]
    fn reference_lookup_pairs_stem_md_and_reads_lossy_content() {
        let f = Fixture::new();
        f.put("skills-reference.md", &[0xff, b' ', b'r', b'e', b'f']);
        let rule_path = f.0.join("nested").join("skills.md");
        let result = find_reference(rule_path.to_str(), f.0.to_str());
        assert_eq!(result["ok"], true);
        assert_eq!(
            result["path"],
            json!(f.0.join("skills-reference.md").to_string_lossy())
        );
        assert_eq!(result["content"], "\u{fffd} ref");
        assert_eq!(find_reference(rule_path.to_str(), None)["error"], "no root");
    }

    #[test]
    fn empty_or_missing_input_reports_no_path() {
        assert_eq!(
            find_reference(None, Some("root")),
            json!({"ok": false, "error": "no path"})
        );
        assert_eq!(
            find_reference(Some(""), Some("root")),
            json!({"ok": false, "error": "no path"})
        );
    }

    #[test]
    fn missing_companion_and_empty_stem_report_their_errors() {
        let f = Fixture::new();
        assert_eq!(
            find_reference(Some("lonely.md"), f.0.to_str()),
            json!({"ok": false, "error": "no reference"})
        );
        assert_eq!(
            find_reference(Some(".md"), f.0.to_str()),
            json!({"ok": false, "error": "no stem"})
        );
    }

    #[test]
    fn mixed_case_markdown_extension_is_stripped_from_the_stem() {
        let f = Fixture::new();
        f.put("term-reference.md", b"body");
        assert_eq!(
            find_reference(Some("dir/term.Md"), f.0.to_str())["ok"],
            true
        );
    }

    #[test]
    fn unreadable_companion_reports_the_read_failure() {
        let f = Fixture::new();
        // A directory named like the companion exists but cannot be read as a file.
        create_dir_all(f.0.join("fail-reference.md")).unwrap();
        let result = find_reference(Some("fail.md"), f.0.to_str());
        assert_eq!(result["ok"], false);
        assert_ne!(result["error"], "no reference");
        assert_ne!(result["error"], "");
    }

    fn scans_value(dir: &Path, root: &str) -> Value {
        json!([{ "root": root, "dir": dir.to_string_lossy() }])
    }

    fn rules_fixture() -> (Fixture, std::path::PathBuf) {
        let f = Fixture::new();
        let dir = f.0.join(".claude").join("rules");
        create_dir_all(&dir).unwrap();
        (f, dir)
    }

    #[test]
    fn list_walks_md_only_skips_dot_and_heavy_dirs_and_normalizes_rel() {
        let (f, dir) = rules_fixture();
        for rel in [
            "a.md",
            "sub/b.md",
            "ignore.txt",
            ".dot.md",
            ".dotdir/x.md",
            ".git/x.md",
            "node_modules/x.md",
            "sub/.h.md",
        ] {
            let path = dir.join(rel);
            create_dir_all(path.parent().unwrap()).unwrap();
            write(path, b"x").unwrap();
        }
        let result = list_files(&scans_value(&dir, "raw-base"));
        assert_eq!(result["capped"], false);
        let files = result["files"].as_array().unwrap();
        let mut rels: Vec<&str> = files.iter().map(|f| f["rel"].as_str().unwrap()).collect();
        rels.sort();
        assert_eq!(rels, vec!["a.md", "sub/b.md"]);
        let first = files.iter().find(|f| f["rel"] == "a.md").unwrap();
        assert_eq!(first["root"], "raw-base"); // verbatim raw client string
        assert_eq!(first["file"], "a.md");
        assert_eq!(
            first["path"],
            dir.join("a.md").to_string_lossy().to_string()
        );
        // Missing scan dirs skip silently, as unresolvable bases do Node-side.
        assert_eq!(
            list_files(&scans_value(&f.0.join("absent"), "raw")),
            json!({ "files": [], "capped": false })
        );
    }

    #[test]
    fn list_caps_at_the_file_cap_and_drops_remaining_roots() {
        let first = Fixture::new();
        let second = Fixture::new();
        let dir_a = first.0.join("rules");
        create_dir_all(&dir_a).unwrap();
        for index in 0..=FILE_CAP {
            write(dir_a.join(format!("page-{index:04}.md")), b"x").unwrap();
        }
        let dir_b = second.0.join("rules");
        create_dir_all(&dir_b).unwrap();
        write(dir_b.join("b.md"), b"x").unwrap();
        let result = list_files(&json!([
            { "root": "a", "dir": dir_a.to_string_lossy() },
            { "root": "b", "dir": dir_b.to_string_lossy() },
        ]));
        assert_eq!(result["capped"], true);
        let files = result["files"].as_array().unwrap();
        assert_eq!(files.len(), FILE_CAP);
        assert!(files.iter().all(|f| f["root"] == "a"));
    }

    #[test]
    fn search_reports_one_based_lines_and_trimmed_snippets() {
        let (_f, dir) = rules_fixture();
        write(
            dir.join("a.md"),
            b"  pad NEEDLE tail  \nno match\nneedle again",
        )
        .unwrap();
        let result = search(&scans_value(&dir, "raw"), &json!("needle"));
        assert_eq!(result["capped"], false);
        let results = result["results"].as_array().unwrap();
        assert_eq!(results.len(), 2);
        assert_eq!(results[0]["line"], 1);
        assert_eq!(results[0]["text"], "pad NEEDLE tail"); // trimmed snippet
        assert_eq!(results[0]["file"], "a.md");
        assert_eq!(results[1]["line"], 3);
    }

    #[test]
    fn search_with_empty_query_returns_nothing() {
        let (_f, dir) = rules_fixture();
        write(dir.join("a.md"), b"needle").unwrap();
        assert_eq!(
            search(&scans_value(&dir, "raw"), &json!("")),
            json!({ "results": [], "capped": false })
        );
        assert_eq!(
            search(&Value::Null, &Value::Null),
            json!({ "results": [], "capped": false })
        );
    }

    #[test]
    fn search_caps_at_the_result_cap() {
        let (_f, dir) = rules_fixture();
        let mut body = String::new();
        for index in 0..=RESULT_CAP {
            body.push_str(&format!("needle line {index}\n"));
        }
        write(dir.join("big.md"), body.as_bytes()).unwrap();
        let result = search(&scans_value(&dir, "raw"), &json!("needle"));
        assert_eq!(result["capped"], true);
        assert_eq!(result["results"].as_array().unwrap().len(), RESULT_CAP);
    }

    #[test]
    fn search_snippet_covers_200_utf16_units() {
        let (_f, dir) = rules_fixture();
        write(
            dir.join("clip.md"),
            format!("{} needle", format!("{0}{1}", "x".repeat(199), '\u{1F600}')).as_bytes(),
        )
        .unwrap();
        let result = search(&scans_value(&dir, "raw"), &json!("needle"));
        let text = result["results"][0]["text"].as_str().unwrap();
        // The 200-unit cover keeps the whole surrogate pair (201 units); the
        // Node bridge slices back to 200, as the wiki search does.
        assert_eq!(text, format!("{0}{1}", "x".repeat(199), '\u{1F600}'));
    }
}
