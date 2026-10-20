use regex::Regex;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::fs::{self, File, FileType};
use std::io::Read;
use std::path::Path;
use std::sync::OnceLock;

const DIR_CAP: usize = 300;
const NOTES_CAP: usize = 200;
const FILE_CAP_BYTES: usize = 256 * 1024;
const BUCKETS: [&str; 5] = ["active", "done", "blocked", "superseded", "other"];

fn regex(slot: &'static OnceLock<Regex>, pattern: &str) -> &'static Regex {
    slot.get_or_init(|| Regex::new(pattern).expect("constant regex is valid"))
}

fn sid_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    regex(&RE, r"(?i)^[0-9a-f-]{8,64}$")
}
fn status_line_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    regex(&RE, r"(?im)^\s*Status:\s*(.*)$")
}
fn heading_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    regex(&RE, r"(?m)^#\s+(.*)$")
}
fn current_phase_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    regex(&RE, r"(?im)^\s*Current phase:\s*(.*)$")
}
fn completed_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    regex(&RE, r"(?im)^\s*Completed:\s*(.*)$")
}

fn read_capped(path: &Path) -> Option<String> {
    let file = File::open(path).ok()?;
    let mut bytes = Vec::with_capacity(FILE_CAP_BYTES);
    file.take(FILE_CAP_BYTES as u64)
        .read_to_end(&mut bytes)
        .ok()?;
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

fn file_type(entry: &fs::DirEntry) -> Option<FileType> {
    entry.file_type().ok()
}

fn markdown_names(dir: &Path) -> Option<Vec<String>> {
    let entries = fs::read_dir(dir).ok()?;
    Some(
        entries
            .filter_map(Result::ok)
            .filter_map(|entry| {
                let kind = file_type(&entry)?;
                let name = entry.file_name().to_string_lossy().into_owned();
                (kind.is_file() && name.to_lowercase().ends_with(".md")).then_some(name)
            })
            .collect(),
    )
}

fn strip_emphasis(value: &str) -> String {
    value.replace("**", "").trim().to_owned()
}

fn normalize_status(raw: &str) -> &'static str {
    let s = strip_emphasis(raw);
    let lower = s.to_lowercase();
    let active = Regex::new(r"^(active|in.?progress)").unwrap();
    let blocked = Regex::new(r"^blocked\b").unwrap();
    let incomplete = Regex::new(r"^(incomplete|not\s+completed?)\b").unwrap();
    let done = Regex::new(r"\b(done|complete|completed)\b").unwrap();
    if active.is_match(&lower) {
        "active"
    } else if blocked.is_match(&lower) {
        "blocked"
    } else if lower.contains("superseded") {
        "superseded"
    } else if incomplete.is_match(&lower) {
        "active"
    } else if done.is_match(&lower) {
        "done"
    } else {
        "other"
    }
}

fn status_of(md: &str) -> &'static str {
    normalize_status(
        status_line_re()
            .captures(md)
            .and_then(|m| m.get(1))
            .map(|m| m.as_str())
            .unwrap_or(""),
    )
}

fn is_plan(md: &str) -> bool {
    let first_fifteen = md.split('\n').take(15).collect::<Vec<_>>().join("\n");
    status_line_re().is_match(&first_fifteen)
        || Regex::new(r"(?im)^#\s+Plan\b").unwrap().is_match(md)
        || Regex::new(r"(?im)^##\s+(Objective|Next steps)\b")
            .unwrap()
            .is_match(md)
}

fn section<'a>(lines: &'a [&'a str], heading: &Regex) -> Vec<&'a str> {
    let Some(start) = lines.iter().position(|line| heading.is_match(line)) else {
        return vec![];
    };
    let mut result = Vec::new();
    for line in lines.iter().skip(start + 1) {
        if Regex::new(r"^#{1,6}\s").unwrap().is_match(line) {
            break;
        }
        result.push(*line);
    }
    result
}

fn bullet(line: &str) -> Option<String> {
    Regex::new(r"^\s*[-*]\s+(.*)$")
        .unwrap()
        .captures(line)
        .and_then(|m| m.get(1))
        .map(|m| m.as_str().trim().to_owned())
}

fn first_capture(re: &Regex, text: &str) -> Option<String> {
    re.captures(text)
        .and_then(|m| m.get(1))
        .map(|m| m.as_str().trim().to_owned())
}

fn parse_plan(file: &str, md: &str) -> Value {
    let lines = md.lines().collect::<Vec<_>>();
    let title = first_capture(heading_re(), md)
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| {
            let title = file
                .get(..file.len().saturating_sub(3))
                .filter(|_| file.to_lowercase().ends_with(".md"));
            title.unwrap_or(file).to_owned()
        });
    let status_raw = first_capture(status_line_re(), md).unwrap_or_default();
    let objective = section(
        &lines,
        &Regex::new(r"(?i)^##\s+(Objective|Goal)\b").unwrap(),
    )
    .into_iter()
    .find(|line| !line.trim().is_empty())
    .map(|line| line.trim().to_owned())
    .unwrap_or_default();
    let current_phase = first_capture(current_phase_re(), md).unwrap_or_default();

    let mut phases = Vec::new();
    for line in section(&lines, &Regex::new(r"(?i)^##\s+Phases\b").unwrap()) {
        let Some(text) = bullet(line) else { continue };
        if let Some(captures) = Regex::new(r"^\[( |x|X|-)\]\s*(.*)$")
            .unwrap()
            .captures(&text)
        {
            let mark = captures.get(1).unwrap().as_str().to_lowercase();
            let state = if mark == "x" {
                "done"
            } else if mark == "-" {
                "skipped"
            } else {
                "open"
            };
            phases
                .push(json!({ "text": captures.get(2).unwrap().as_str().trim(), "state": state }));
        } else {
            phases.push(json!({ "text": text, "state": "plain" }));
        }
    }
    let mut next_steps = Vec::new();
    for line in section(&lines, &Regex::new(r"(?i)^##\s+Next steps\b").unwrap()) {
        if let Some(item) = bullet(line) {
            next_steps.push(item);
            if next_steps.len() == 2 {
                break;
            }
        }
    }
    let required_re = Regex::new(r"(?i)^\s*[-*]?\s*Required before acting:\s*(.+)$").unwrap();
    let required = lines
        .iter()
        .filter_map(|line| required_re.captures(line))
        .filter_map(|m| m.get(1))
        .map(|m| {
            Regex::new(r"\s*\(.*$")
                .unwrap()
                .replace(m.as_str(), "")
                .trim()
                .to_owned()
        })
        .collect::<Vec<_>>();
    let completed = first_capture(completed_re(), md).filter(|s| !s.is_empty());
    json!({
        "file": file, "title": title, "status": normalize_status(&status_raw), "statusRaw": status_raw,
        "objective": objective, "currentPhase": current_phase, "phases": phases,
        "nextSteps": next_steps, "required": required, "completed": completed
    })
}

fn mtime_ms(path: &Path) -> f64 {
    fs::metadata(path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

fn state_value(dir: &Path, summary: bool) -> Value {
    let raw = read_capped(&dir.join("state.json"));
    let parsed = raw.and_then(|text| serde_json::from_str::<Value>(&text).ok());
    match (parsed, summary) {
        (Some(value), true) => json!({
            "branch": value.get("branch").cloned().filter(|v| !v.is_null()).unwrap_or(Value::Null),
            "contextTokens": value.get("context_tokens").cloned().filter(|v| !v.is_null()).unwrap_or(Value::Null)
        }),
        (Some(value), false) => json!({
            "generatedAt": value.get("generated_at").cloned().filter(|v| !v.is_null()).unwrap_or(Value::Null),
            "cwd": value.get("cwd").cloned().filter(|v| !v.is_null()).unwrap_or(Value::Null),
            "branch": value.get("branch").cloned().filter(|v| !v.is_null()).unwrap_or(Value::Null),
            "contextTokens": value.get("context_tokens").cloned().filter(|v| !v.is_null()).unwrap_or(Value::Null)
        }),
        _ => {
            if summary {
                json!({"branch": null, "contextTokens": null})
            } else {
                Value::Null
            }
        }
    }
}

pub fn list_sessions(root: Option<&str>) -> Value {
    let Some(root) = root else { return json!([]) };
    let Ok(entries) = fs::read_dir(root) else {
        return json!([]);
    };
    let mut result = Vec::new();
    let mut scanned = 0;
    for entry in entries.filter_map(Result::ok) {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(kind) = file_type(&entry) else {
            continue;
        };
        if !kind.is_dir() || !sid_re().is_match(&name) {
            continue;
        }
        scanned += 1;
        if scanned > DIR_CAP {
            break;
        }
        let dir = entry.path();
        let Some(names) = markdown_names(&dir) else {
            continue;
        };
        let mut buckets = BTreeMap::new();
        for bucket in BUCKETS {
            buckets.insert(bucket, 0_u32);
        }
        let mut plan_count = 0;
        for name in names {
            if let Some(md) = read_capped(&dir.join(name)) {
                if is_plan(&md) {
                    plan_count += 1;
                    *buckets.get_mut(status_of(&md)).unwrap() += 1;
                }
            }
        }
        if plan_count == 0 {
            continue;
        }
        let state = state_value(&dir, true);
        result.push(json!({
            "sid": name, "mtime": mtime_ms(&dir), "planCount": plan_count,
            "statusBuckets": buckets, "branch": state["branch"], "contextTokens": state["contextTokens"]
        }));
    }
    json!(result)
}

pub fn get_session(dir: &str, sid: &str) -> Value {
    let dir = Path::new(dir);
    let Some(names) = markdown_names(dir) else {
        return json!({"ok":false,"error":"not found"});
    };
    let mut texts = Vec::new();
    for name in names {
        texts.push((name.clone(), read_capped(&dir.join(&name))));
    }
    let mut plans = Vec::new();
    let mut notes = Vec::new();
    for (name, md) in &texts {
        let Some(md) = md.as_deref() else { continue };
        if is_plan(md) {
            plans.push(parse_plan(name, md));
        } else {
            let title = first_capture(heading_re(), md)
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| name.clone());
            notes.push(json!({"file":name,"title":title,"plan":Value::Null}));
        }
    }
    for note in &mut notes {
        let note_file = note["file"].as_str().unwrap_or("");
        let owner = plans
            .iter()
            .find(|plan| {
                let plan_file = plan["file"].as_str().unwrap_or("");
                texts
                    .iter()
                    .find(|(name, _)| name == plan_file)
                    .and_then(|(_, text)| text.as_deref())
                    .is_some_and(|text| text.contains(note_file))
            })
            .and_then(|plan| plan["file"].as_str());
        if let Some(owner) = owner {
            note["plan"] = json!(owner);
        }
    }
    notes.truncate(NOTES_CAP);
    json!({"ok":true,"sid":sid,"mtime":mtime_ms(dir),"plans":plans,"notes":notes,"state":state_value(dir,false)})
}

pub fn dispatch(op: &str, root: &Value, path: &Value, sid: &Value) -> Value {
    match op {
        "plan_sessions" => list_sessions(root.as_str()),
        "plan_session" => match (path.as_str(), sid.as_str()) {
            (Some(path), Some(sid)) => get_session(path, sid),
            _ => json!({"ok":false,"error":"not found"}),
        },
        _ => json!({"error":"unknown operation"}),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::{create_dir_all, remove_dir, write};
    use std::time::{SystemTime, UNIX_EPOCH};

    struct Fixture(std::path::PathBuf);
    impl Fixture {
        fn new() -> Self {
            let id = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir().join(format!("singularity-plans-{id}"));
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
    fn plans_list_and_detail_preserve_fields_and_ordered_notes() {
        let f = Fixture::new();
        let sid = "aaaaaaaa-1111-4111-8111-111111111111";
        f.put(&format!("{sid}/plan.md"), "# Plan A\nStatus: active\n\n## Objective\nShip plans.\n\nCurrent phase: Phase 2\n\n## Phases\n- [x] first\n- [ ] second\n\n## Next steps\n- do it\n- then that\n- ignored\n\n## Evidence\n- notes.md\n\nRequired before acting: file.md (reason)\nCompleted: today\n");
        f.put(&format!("{sid}/notes.md"), "# Evidence\ntext");
        f.put(
            &format!("{sid}/state.json"),
            r#"{"generated_at":"now","cwd":"here","branch":"main","context_tokens":42}"#,
        );
        f.put("bbbbbbbb-2222-4222-8222-222222222222/review.md", "# Review");
        let list = list_sessions(f.0.to_str());
        assert_eq!(list.as_array().unwrap().len(), 1);
        assert_eq!(list[0]["sid"], sid);
        assert_eq!(list[0]["statusBuckets"]["active"], 1);
        assert_eq!(list[0]["contextTokens"], 42);
        let detail = get_session(f.0.join(sid).to_str().unwrap(), sid);
        assert_eq!(detail["plans"][0]["title"], "Plan A");
        assert_eq!(detail["plans"][0]["objective"], "Ship plans.");
        assert_eq!(detail["plans"][0]["phases"][0]["state"], "done");
        assert_eq!(detail["plans"][0]["nextSteps"].as_array().unwrap().len(), 2);
        assert_eq!(detail["plans"][0]["required"][0], "file.md");
        assert_eq!(detail["notes"][0]["plan"], "plan.md");
        assert_eq!(detail["state"]["generatedAt"], "now");
        assert_eq!(list_sessions(None), json!([]));
    }

    #[test]
    fn plans_keep_status_precedence_and_legacy_markdown_detection() {
        for (raw, expected) in [
            ("incomplete", "active"),
            ("not complete", "active"),
            ("not completed", "active"),
            ("active - complete the next phase", "active"),
            ("blocked - completion is pending", "blocked"),
            ("superseded by a completed draft", "superseded"),
            ("phase 1 superseded by a completed draft", "superseded"),
            ("done", "done"),
            ("complete", "done"),
            ("completed", "done"),
            ("undone", "other"),
            ("uncompleted", "other"),
        ] {
            assert_eq!(normalize_status(raw), expected, "{raw}");
        }
        assert!(is_plan("line 1\n## Objective\nhello"));
        assert!(!is_plan("# Notes\nnot a plan"));
    }

    #[test]
    fn mixed_case_markdown_extension_is_removed_from_fallback_title() {
        let plan = parse_plan("foo.Md", "## Objective\nShip it.");
        assert_eq!(plan["title"], "foo");
    }

    #[test]
    fn unreadable_plan_and_state_inputs_are_skipped_or_null_and_list_continues() {
        let f = Fixture::new();
        let unreadable_plan = f.0.join("missing.md");
        assert_eq!(read_capped(&unreadable_plan), None);

        let sid = "dddddddd-4444-4444-8444-444444444444";
        f.put(&format!("{sid}/plan.md"), "# Plan\nStatus: active");
        create_dir_all(f.0.join(sid).join("state.json")).unwrap();
        let list = list_sessions(f.0.to_str());
        assert_eq!(list.as_array().unwrap().len(), 1);
        assert_eq!(list[0]["branch"], Value::Null);
        assert_eq!(list[0]["contextTokens"], Value::Null);
        let detail = get_session(f.0.join(sid).to_str().unwrap(), sid);
        assert_eq!(detail["plans"].as_array().unwrap().len(), 1);
        assert_eq!(detail["state"], Value::Null);

        remove_dir(f.0.join(sid).join("state.json")).unwrap();
        write(f.0.join(sid).join("state.json"), "{ malformed").unwrap();
        assert_eq!(list_sessions(f.0.to_str())[0]["branch"], Value::Null);
        assert_eq!(
            get_session(f.0.join(sid).to_str().unwrap(), sid)["state"],
            Value::Null
        );
    }

    #[test]
    fn detail_reads_only_a_256_kib_prefix_and_caps_notes_after_reading() {
        let f = Fixture::new();
        let sid = "cccccccc-3333-4333-8333-333333333333";
        f.put(
            &format!("{sid}/large.md"),
            &format!("# Plan\n{}tail", "x".repeat(FILE_CAP_BYTES)),
        );
        for index in 0..=NOTES_CAP {
            f.put(&format!("{sid}/note-{index:03}.md"), "note");
        }
        let detail = get_session(f.0.join(sid).to_str().unwrap(), sid);
        assert_eq!(detail["notes"].as_array().unwrap().len(), NOTES_CAP);
        assert_eq!(detail["plans"][0]["title"], "Plan");
    }

    #[test]
    fn list_stops_after_three_hundred_matching_directories() {
        let f = Fixture::new();
        for index in 0..=DIR_CAP {
            let sid = format!("{index:08x}");
            f.put(&format!("{sid}/plan.md"), "# Plan\nStatus: active");
        }
        let result = list_sessions(f.0.to_str());
        assert_eq!(result.as_array().unwrap().len(), DIR_CAP);
    }
}
