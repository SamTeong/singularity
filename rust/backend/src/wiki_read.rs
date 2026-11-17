use regex::Regex;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::fs::{self, FileType};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::UNIX_EPOCH;

const RESULT_CAP: usize = 300;
const FILE_CAP: usize = 2000;
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
const SWEEP_WIKIS: &[&str] = &["agentic-coding", "dotnet", "iap"];
const SWEEP_TYPES: &[&str] = &["shallow", "deep", "horizon"];

#[derive(Clone)]
struct Page {
    path: PathBuf,
    rel: String,
}

fn string(value: &Value) -> Option<&str> {
    value.as_str()
}

fn js_slice(value: &str, limit: usize) -> String {
    let units = value.encode_utf16().take(limit).collect::<Vec<_>>();
    String::from_utf16_lossy(&units)
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

fn expand_root(raw: &str) -> PathBuf {
    let raw = if raw == "~" || raw.starts_with("~/") || raw.starts_with("~\\") {
        let home = std::env::var_os("USERPROFILE")
            .or_else(|| std::env::var_os("HOME"))
            .map(PathBuf::from);
        if let Some(home) = home {
            home.join(
                raw.strip_prefix('~')
                    .unwrap_or("")
                    .trim_start_matches(['/', '\\']),
            )
        } else {
            PathBuf::from(raw)
        }
    } else {
        PathBuf::from(raw)
    };
    if raw.is_absolute() {
        raw
    } else {
        std::env::current_dir().unwrap_or_default().join(raw)
    }
}

fn skipped(name: &str) -> bool {
    name.starts_with('.') || SKIP_DIRS.contains(&name)
}

fn wiki_dirs(root: &Path) -> Vec<(String, PathBuf)> {
    let mut wikis = match fs::read_dir(root) {
        Ok(entries) => entries
            .filter_map(Result::ok)
            .filter_map(|entry| {
                let name = entry.file_name().to_string_lossy().into_owned();
                let kind = entry.file_type().ok()?;
                (kind.is_dir() && !skipped(&name)).then(|| (name, entry.path()))
            })
            .collect::<Vec<_>>(),
        Err(_) => Vec::new(),
    };
    wikis.sort_by(|a, b| {
        a.0.to_lowercase()
            .cmp(&b.0.to_lowercase())
            .then_with(|| a.0.cmp(&b.0))
    });
    wikis
}

fn apply_wiki_order(wikis: &mut [(String, PathBuf)], order: &Value) {
    let Some(names) = order.as_array() else {
        return;
    };
    let positions = names
        .iter()
        .enumerate()
        .filter_map(|(index, value)| value.as_str().map(|name| (name.to_owned(), index)))
        .collect::<HashMap<_, _>>();
    wikis.sort_by(|a, b| match (positions.get(&a.0), positions.get(&b.0)) {
        (Some(a), Some(b)) => a.cmp(b),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => {
            a.0.to_lowercase()
                .cmp(&b.0.to_lowercase())
                .then_with(|| a.0.cmp(&b.0))
        }
    });
}

fn walk(dir: &Path, wiki_root: &Path, out: &mut Vec<Page>) {
    if out.len() >= FILE_CAP {
        return;
    }
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
                walk(&path, wiki_root, out);
                if out.len() >= FILE_CAP {
                    return;
                }
            }
        } else if kind.is_file() && name.to_lowercase().ends_with(".md") {
            let rel = path
                .strip_prefix(wiki_root)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            out.push(Page { path, rel });
            if out.len() >= FILE_CAP {
                return;
            }
        }
    }
}

// read_dir order is filesystem-dependent (sorted on NTFS, not on ext4).
fn sort_pages(pages: &mut [Page]) {
    pages.sort_by(|a, b| {
        a.rel
            .to_lowercase()
            .cmp(&b.rel.to_lowercase())
            .then_with(|| a.rel.cmp(&b.rel))
    });
}

fn files(root_value: &Value, order: &Value) -> Value {
    let Some(raw) = string(root_value).filter(|raw| !raw.is_empty()) else {
        return json!({ "wikis": [], "capped": false, "error": "bad path" });
    };
    let root = expand_root(raw);
    if !root.exists() {
        return json!({ "wikis": [], "capped": false, "error": "not found" });
    }
    let mut wikis = Vec::new();
    let mut total = 0usize;
    let mut capped = false;
    let mut directories = wiki_dirs(&root);
    apply_wiki_order(&mut directories, order);
    for (name, path) in directories {
        let mut pages = Vec::new();
        walk(&path, &path, &mut pages);
        sort_pages(&mut pages);
        if pages.len() >= FILE_CAP {
            capped = true;
        }
        total += pages.len();
        wikis.push(json!({
            "name": name,
            "path": path.to_string_lossy(),
            "pages": pages.into_iter().map(|page| json!({
                "path": page.path.to_string_lossy(),
                "rel": page.rel,
            })).collect::<Vec<_>>(),
        }));
        if total >= FILE_CAP {
            capped = true;
            break;
        }
    }
    json!({ "wikis": wikis, "capped": capped })
}

fn valid_day(day: &str) -> bool {
    let bytes = day.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return false;
    }
    let (Ok(year), Ok(month), Ok(date)) = (
        day[0..4].parse::<u32>(),
        day[5..7].parse::<u32>(),
        day[8..10].parse::<u32>(),
    ) else {
        return false;
    };
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let max_day = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => return false,
    };
    date > 0 && date <= max_day
}

fn parse_sweep_history(markdown: &str) -> HashMap<&'static str, Option<String>> {
    static HEADINGS: OnceLock<Regex> = OnceLock::new();
    let re = HEADINGS.get_or_init(|| {
        Regex::new(
            r"(?im)^## \[(\d{4}-\d{2}-\d{2})\] (shallow|deep|horizon)(?: continuation)?(?:$|\s|\|)",
        )
        .expect("constant sweep heading regex is valid")
    });
    let mut latest: HashMap<&'static str, Option<String>> = SWEEP_TYPES
        .iter()
        .map(|name| (*name, None))
        .collect::<HashMap<_, _>>();
    let headings = re.captures_iter(markdown).collect::<Vec<_>>();
    for capture in &headings {
        let whole = capture.get(0).unwrap();
        let date = capture.get(1).unwrap().as_str();
        if !valid_day(date) {
            continue;
        }
        let kind = capture.get(2).unwrap().as_str().to_lowercase();
        let rest = &markdown[whole.end()..];
        let body_end = rest.find("\n## ").unwrap_or(rest.len());
        let body = &rest[..body_end];
        let summary_lines = body
            .lines()
            .filter(|line| {
                let trimmed = line.trim_start();
                !["NEW:", "UPDATE:", "OVERTURNS:", "UNVERIFIED:"]
                    .iter()
                    .any(|tag| {
                        trimmed
                            .trim_start_matches(['-', '*', ' '])
                            .to_uppercase()
                            .starts_with(tag)
                    })
            })
            .collect::<Vec<_>>();
        let summary = Regex::new(r"(?i)(^|[^A-Za-z0-9_])New partial( context:)")
            .unwrap()
            .replace_all(&summary_lines.join("\n"), "$1New additional$2")
            .into_owned();
        let summary = js_slice(&summary, 1200);
        let interrupted = Regex::new(r"(?i)(^|[^A-Za-z0-9_])(?:partial(?:ly)?|interrupted|aborted|stopped before|tool-call cap|not completed|incomplete|failed|did not|cancell?ed|timed out)(?:$|[^A-Za-z0-9_])")
            .unwrap()
            .is_match(&summary);
        let completed = Regex::new(r"(?im)^\s*(?:[-*]\s*)?(?:(?:whole|entire)\s+)?sweep\s+(?:was\s+)?completed[ \t]*(?:$|[.:\-–—])")
            .unwrap().is_match(&summary);
        let heading_text = whole.as_str();
        let continuation_completed = heading_text.to_lowercase().contains("continuation")
            && Regex::new(r"(?im)^\s*(?:[-*]\s*)?continuation\s+(?:was\s+)?completed\b")
                .unwrap()
                .is_match(&summary);
        if interrupted && !completed && !continuation_completed {
            continue;
        }
        let slot = latest.get_mut(kind.as_str()).unwrap();
        if slot
            .as_ref()
            .is_none_or(|existing| date > existing.as_str())
        {
            *slot = Some(date.to_owned());
        }
    }
    latest
}

fn sweeps(root_value: &Value) -> Value {
    let root = string(root_value)
        .filter(|root| !root.is_empty())
        .map(expand_root);
    let by_name = root
        .as_ref()
        .filter(|root| root.exists())
        .map(|root| wiki_dirs(root).into_iter().collect::<HashMap<_, _>>())
        .unwrap_or_default();
    let wikis = SWEEP_WIKIS
        .iter()
        .map(|name| {
            if *name == "iap" {
                let deep = by_name
                    .get(*name)
                    .and_then(|path| fs::read_to_string(path.join("wiki-sync.json")).ok())
                    .and_then(|json| serde_json::from_str::<Value>(&json).ok())
                    .and_then(|data| {
                        data.get("lastIngestedAt")
                            .and_then(Value::as_str)
                            .map(str::to_owned)
                    })
                    .filter(|date| valid_day(date));
                return json!({ "name": name, "shallow": null, "deep": deep, "horizon": null });
            }
            let markdown = by_name
                .get(*name)
                .and_then(|path| {
                    fs::read_to_string(path.join("meta").join("websearch-log.md")).ok()
                })
                .unwrap_or_default();
            let latest = parse_sweep_history(&markdown);
            json!({
                "name": name,
                "shallow": latest.get("shallow").cloned().flatten(),
                "deep": latest.get("deep").cloned().flatten(),
                "horizon": latest.get("horizon").cloned().flatten(),
            })
        })
        .collect::<Vec<_>>();
    json!({ "wikis": wikis })
}

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

fn search(query_value: &Value, root_value: &Value, order: &Value) -> Value {
    let query = string(query_value).unwrap_or("").to_lowercase();
    if query.is_empty() {
        return json!({ "results": [], "capped": false });
    }
    let Some(raw) = string(root_value).filter(|raw| !raw.is_empty()) else {
        return json!({ "results": [], "capped": false });
    };
    let root = expand_root(raw);
    if !root.exists() {
        return json!({ "results": [], "capped": false });
    }
    let mut results = Vec::new();
    let mut directories = wiki_dirs(&root);
    apply_wiki_order(&mut directories, order);
    for (wiki, path) in directories {
        let mut pages = Vec::new();
        walk(&path, &path, &mut pages);
        sort_pages(&mut pages);
        append_search_pages(&mut results, &wiki, pages, &query);
        if results.len() >= RESULT_CAP {
            return json!({ "results": results, "capped": true });
        }
    }
    json!({ "results": results, "capped": false })
}

fn append_search_pages(results: &mut Vec<Value>, wiki: &str, pages: Vec<Page>, query: &str) {
    for page in pages {
        let Some(lines) = read_lines(&page.path) else {
            continue;
        };
        let file = page.rel.rsplit('/').next().unwrap_or(&page.rel);
        let rel = format!("{wiki}/{}", page.rel);
        for (index, line) in lines.iter().enumerate() {
            if line.to_lowercase().contains(query) {
                let text = line.trim();
                let text = utf16_prefix_cover(text, 200);
                results.push(json!({
                    "file": file,
                    "path": page.path.to_string_lossy(),
                    "rel": rel,
                    "line": index + 1,
                    "text": text,
                }));
                if results.len() >= RESULT_CAP {
                    return;
                }
            }
        }
    }
}

fn read_file(path_value: &Value) -> Value {
    let Some(path) = string(path_value).filter(|path| !path.is_empty()) else {
        return json!({ "ok": false, "error": "not found" });
    };
    match fs::read(path) {
        Ok(content) => json!({ "ok": true, "content": String::from_utf8_lossy(&content) }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            json!({ "ok": false, "error": "not found" })
        }
        Err(error) => json!({ "ok": false, "error": error.to_string() }),
    }
}

pub fn dispatch(op: &str, root: &Value, query: &Value, path: &Value, wiki_order: &Value) -> Value {
    match op {
        "files" => files(root, wiki_order),
        "sweeps" => sweeps(root),
        "search" => search(query, root, wiki_order),
        "read" => read_file(path),
        _ => json!({ "error": "bad request" }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::{create_dir_all, write};
    use std::time::{SystemTime, UNIX_EPOCH};

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let id = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir().join(format!("singularity-wiki-read-{id}"));
            create_dir_all(&path).unwrap();
            Self(path)
        }
        fn put(&self, rel: &str, text: &str) {
            let path = self.0.join(rel);
            create_dir_all(path.parent().unwrap()).unwrap();
            write(path, text).unwrap();
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn files_sorts_pages_skips_heavy_dirs_and_caps_at_two_thousand() {
        let f = Fixture::new();
        f.put("wiki/z.md", "");
        f.put("wiki/a.md", "");
        f.put("wiki/node_modules/ignored.md", "");
        let result = files(&json!(f.0.to_string_lossy()), &Value::Null);
        assert_eq!(result["wikis"][0]["pages"][0]["rel"], "a.md");
        assert_eq!(result["wikis"][0]["pages"][1]["rel"], "z.md");
        let capped = Fixture::new();
        for index in 0..=FILE_CAP {
            capped.put(&format!("wiki/{index:04}.md"), "");
        }
        let result = files(&json!(capped.0.to_string_lossy()), &Value::Null);
        assert_eq!(
            result["wikis"][0]["pages"].as_array().unwrap().len(),
            FILE_CAP
        );
        assert_eq!(result["capped"], true);
    }

    #[test]
    fn search_preserves_lines_case_order_and_result_cap() {
        let f = Fixture::new();
        f.put("alpha/first.md", "Hello needle\nother NEEDLE");
        f.put("beta/second.md", "needle");
        let result = search(
            &json!("NEEDLE"),
            &json!(f.0.to_string_lossy()),
            &Value::Null,
        );
        let results = result["results"].as_array().unwrap();
        assert_eq!(results.len(), 3);
        assert_eq!(results[0]["line"], 1);
        assert_eq!(results[1]["line"], 2);
        assert_eq!(results[0]["rel"], "alpha/first.md");
        let capped = Fixture::new();
        for index in 0..RESULT_CAP {
            capped.put(&format!("wiki/{index:03}.md"), "needle");
        }
        assert_eq!(
            search(
                &json!("needle"),
                &json!(capped.0.to_string_lossy()),
                &Value::Null
            )["capped"],
            true
        );
    }

    #[test]
    fn search_orders_pages_like_files_not_by_read_dir() {
        // NTFS lists a.md before _b.md ('A' < '_'); the lowercase sort puts _b.md first,
        // so this fails on Windows too when search skips the sort.
        let f = Fixture::new();
        f.put("wiki/a.md", "needle");
        f.put("wiki/_b.md", "needle");
        f.put("wiki/sub/c.md", "needle");
        let result = search(
            &json!("needle"),
            &json!(f.0.to_string_lossy()),
            &Value::Null,
        );
        let rels: Vec<_> = result["results"]
            .as_array()
            .unwrap()
            .iter()
            .map(|hit| hit["rel"].as_str().unwrap().to_owned())
            .collect();
        assert_eq!(rels, ["wiki/_b.md", "wiki/a.md", "wiki/sub/c.md"]);
    }

    #[test]
    fn search_skips_unreadable_page_and_keeps_readable_hits() {
        let f = Fixture::new();
        f.put("wiki/readable.md", "needle remains searchable");
        let mut results = Vec::new();
        append_search_pages(
            &mut results,
            "wiki",
            vec![
                Page {
                    path: f.0.join("wiki/missing.md"),
                    rel: "missing.md".to_owned(),
                },
                Page {
                    path: f.0.join("wiki/readable.md"),
                    rel: "readable.md".to_owned(),
                },
            ],
            "needle",
        );
        assert_eq!(results.len(), 1);
        assert_eq!(results[0]["rel"], "wiki/readable.md");
        assert_eq!(results[0]["text"], "needle remains searchable");
    }

    #[test]
    fn sweeps_keep_valid_latest_completed_dates_and_iap_ingest() {
        let f = Fixture::new();
        f.put("agentic-coding/meta/websearch-log.md", "## [2026-10-12] shallow | lanes: all\n- NEW: —\n## [2026-10-13] shallow\n- interrupted");
        f.put(
            "dotnet/meta/websearch-log.md",
            "## [2026-02-30] deep\n- Sweep completed.",
        );
        f.put("iap/wiki-sync.json", "{\"lastIngestedAt\":\"2026-10-10\"}");
        let result = sweeps(&json!(f.0.to_string_lossy()));
        assert_eq!(result["wikis"][0]["shallow"], "2026-10-12");
        assert_eq!(result["wikis"][1]["deep"], Value::Null);
        assert_eq!(result["wikis"][2]["deep"], "2026-10-10");
    }

    #[test]
    fn sweep_parser_preserves_interruption_claim_completion_and_heading_rules() {
        let ledger = [
            "## [2026-10-20] Shallow | lanes: all",
            "- NEW: [[failed-login-handling]]",
            "- UNVERIFIED: page fetch failed; this is claim evidence, not a failed sweep.",
            "## [2026-10-19] shallow | lanes: all",
            "- Interrupted: lane 3 failed; lanes 1 and 2 completed.",
            "## [2026-10-18] deep continuation | lanes: all",
            "- Continuation completed after retry.",
            "## [2026-10-17] deep | lanes: all",
            "- Sweep completed lanes 1 and 2 only; lane 3 interrupted.",
            "## [2026-10-16] horizon | stopped before completion",
            "- This partial sweep stopped before saturation.",
            "## Notes",
            "- This heading ends the preceding sweep body.",
            "## [2026-10-15] horizon | lanes: all",
            "- Sweep completed.",
            "## [2026-02-30] horizon | lanes: all",
            "- Sweep completed.",
            "## [2026-10-14] deep-dive notes",
            "- Sweep completed.",
        ]
        .join("\n");
        let latest = parse_sweep_history(&ledger);
        assert_eq!(latest["shallow"].as_deref(), Some("2026-10-20"));
        assert_eq!(latest["deep"].as_deref(), Some("2026-10-18"));
        assert_eq!(latest["horizon"].as_deref(), Some("2026-10-15"));

        for interrupted in [
            "- Sweep not completed: lane 3 failed.",
            "- Sweep completed lanes 1 and 2 only; lane 3 interrupted.",
            "- Not completed.",
            "- Incomplete.",
            "- Lane 3 failed.",
            "- Lane 3 did not finish.",
            "- Cancelled by user.",
            "- Canceled by user.",
            "- Lane 2 timed out.",
            "- Partially done.",
        ] {
            let source = format!("## [2026-10-20] deep | lanes: all\n{interrupted}\n");
            assert_eq!(parse_sweep_history(&source)["deep"], None, "{interrupted}");
        }
        for completed in [
            "- Sweep completed.",
            "- Sweep completed: lane 3 failed then retried.",
            "- Sweep completed - lane 2 timed out on retry",
            "- Sweep completed\r\n- one lane failed and was rerun.",
        ] {
            assert_eq!(
                parse_sweep_history(&format!("## [2026-10-20] deep | lanes: all\n{completed}\n"))["deep"],
                Some("2026-10-20".to_owned()),
                "{completed}"
            );
        }

        let long_claim = format!("- NEW: {}", "claim ".repeat(220));
        assert_eq!(
            parse_sweep_history(&format!(
                "## [2026-10-20] deep | lanes: all\n{long_claim}\n- Lane 3 failed."
            ))["deep"],
            None
        );
        assert_eq!(
            parse_sweep_history(&format!(
                "## [2026-10-20] deep | lanes: all\n{long_claim}\n- Sweep completed: lane 3 failed then retried."
            ))["deep"],
            Some("2026-10-20".to_owned())
        );
        assert_eq!(
            parse_sweep_history(&format!(
                "## [2026-10-20] deep continuation | lanes: all\n{long_claim}\n- Continuation completed: lane 3 failed then retried."
            ))["deep"],
            Some("2026-10-20".to_owned())
        );
        assert_eq!(
            parse_sweep_history(
                "## [2026-10-19] deep | lanes: all\n- CARRY-FORWARD: New partial context: issue #84817.\n"
            )["deep"],
            Some("2026-10-19".to_owned())
        );
        for context in [
            "New partial context: issue #84817; this sweep was incomplete.",
            "New partial context: issue #84817. This sweep was incomplete.",
        ] {
            assert_eq!(
                parse_sweep_history(&format!(
                    "## [2026-10-19] deep | lanes: all\n- CARRY-FORWARD: {context}\n"
                ))["deep"],
                None,
                "{context}"
            );
        }
        let fallback = parse_sweep_history(
            "## [2026-10-19] deep | lanes: all\n- Interrupted: sweep not completed because lane 3 failed.\n## [2026-10-18] deep | lanes: all\n- UNVERIFIED: page fetch failed.\n## [2026-10-04] deep | lanes: all\n- CARRY-FORWARD: New partial context: issue #84817.\n",
        );
        assert_eq!(fallback["deep"].as_deref(), Some("2026-10-18"));

        let impartial = parse_sweep_history(
            "## [2026-10-20] deep | lanes: all\n- An impartial analysis of the results.\n## [2026-10-18] deep | lanes: all\n- Sweep completed.\n",
        );
        assert_eq!(impartial["deep"].as_deref(), Some("2026-10-20"));

        let embedded_context = parse_sweep_history(
            "## [2026-10-20] deep | lanes: all\n- CARRY-FORWARD: xNew partial context: issue #84817; sweep incomplete.\n## [2026-10-18] deep | lanes: all\n- Sweep completed.\n",
        );
        assert_eq!(embedded_context["deep"].as_deref(), Some("2026-10-18"));
    }

    #[test]
    fn sweep_history_keeps_fixed_domains_and_validates_iap_ingest_only() {
        let missing = sweeps(&Value::Null);
        assert_eq!(missing["wikis"][0]["name"], "agentic-coding");
        assert_eq!(missing["wikis"][1]["name"], "dotnet");
        assert_eq!(missing["wikis"][2]["name"], "iap");
        assert!(
            missing["wikis"]
                .as_array()
                .unwrap()
                .iter()
                .all(|wiki| wiki["deep"].is_null())
        );

        let f = Fixture::new();
        f.put(
            "iap/meta/websearch-log.md",
            "## [2026-10-12] shallow | lanes: all\n- NEW: —\n",
        );
        for invalid in [
            "{\"lastIngestedAt\":\"2026-02-30\"}",
            "{\"lastIngestedAt\":\"2026-10-10T08:00:00Z\"}",
            "{\"lastIngestedAt\":20261010}",
            "{}",
            "{not json",
        ] {
            f.put("iap/wiki-sync.json", invalid);
            assert_eq!(
                sweeps(&json!(f.0.to_string_lossy()))["wikis"][2]["deep"],
                Value::Null
            );
        }
    }

    #[test]
    fn guarded_file_read_payload_handles_utf8_lossily_and_missing_files() {
        let f = Fixture::new();
        f.put("wiki/page.md", "hello");
        assert_eq!(
            read_file(&json!(f.0.join("wiki/page.md").to_string_lossy()))["content"],
            "hello"
        );
        assert_eq!(
            read_file(&json!(f.0.join("missing.md").to_string_lossy()))["error"],
            "not found"
        );
    }

    #[test]
    fn snippets_use_javascript_utf16_slice_lengths() {
        assert_eq!(js_slice(&"😀".repeat(101), 200), "😀".repeat(100));
        assert_eq!(
            utf16_prefix_cover(&format!("{}😀tail", "x".repeat(199)), 200),
            format!("{}😀", "x".repeat(199))
        );
    }
}
