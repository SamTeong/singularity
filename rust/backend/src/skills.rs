use regex::Regex;
use serde_json::{Value, json};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::UNIX_EPOCH;

// Skills read services (see skills.mjs): layout detection + SKILL.md reads +
// the supporting-file tree, single-skill reads, supporting-file reads.
// Differences from rules.rs, all deliberate ports of the old Node behavior:
// the walk FOLLOWS symlinked dirs at every level, so a cycle re-lists the
// reachable files once per level until FILE_DEPTH (duplicates included);
// there is no cache (the UI re-lists on focus, so one would never hit);
// NAME_RE validation stays Node-side (its negative lookahead is unsupported
// by the regex crate) — Rust trusts the checked names. Listing payloads ship
// the per-directory entry trees in readdir order; Node applies the
// per-directory localeCompare sort, FILES_CAP and SKILLS_CAP when flattening,
// which a Rust sort cannot reproduce byte for byte.
const FILE_DEPTH: u32 = 6;
const MD_EXT: &[&str] = &["md", "markdown"];
const IMG_EXT: &[&str] = &["png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "ico"];

// Parse a SKILL.md's leading YAML frontmatter (---\n...\n---) into structured
// meta + body. Mirrors the Node parser exactly: quoted values kept verbatim,
// duplicate keys last-wins, `triggers` only for an empty value collecting the
// following indented `- ` lines (marker stripped, trimmed).
struct ParsedSkill {
    name: String,
    description: String,
    triggers: Vec<String>,
    body: String,
}

fn frontmatter_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?s)^---\r?\n(.*?)\r?\n---\r?\n?").expect("constant regex is valid")
    })
}

fn trigger_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^\s+-\s").expect("constant regex is valid"))
}

fn parse_skill(src: &str) -> ParsedSkill {
    let Some(caps) = frontmatter_regex().captures(src) else {
        return ParsedSkill {
            name: String::new(),
            description: String::new(),
            triggers: Vec::new(),
            body: src.to_owned(),
        };
    };
    let frontmatter = caps.get(1).map(|m| m.as_str()).unwrap_or("");
    let lines: Vec<&str> = frontmatter
        .split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
        .collect();
    let mut out = ParsedSkill {
        name: String::new(),
        description: String::new(),
        triggers: Vec::new(),
        body: String::new(),
    };
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        let Some(colon) = line.find(':') else {
            i += 1;
            continue;
        };
        let key = line[..colon].trim();
        let value = line[colon + 1..].trim();
        if key == "name" {
            out.name = value.to_owned();
        } else if key == "description" {
            out.description = value.to_owned();
        } else if key == "triggers" && value.is_empty() {
            // collect following indented `- ` lines
            while i + 1 < lines.len() {
                let Some(marker) = trigger_regex().find(lines[i + 1]) else {
                    break;
                };
                out.triggers
                    .push(lines[i + 1][marker.end()..].trim().to_owned());
                i += 1;
            }
        }
        i += 1;
    }
    out.body = src[caps.get(0).map(|m| m.end()).unwrap_or(0)..].to_owned();
    out
}

// One directory's entries in readdir order, as the flatten tree Node sorts +
// flattens: {n: name, f: is-a-plain-file, c: child entries}. Dirs and symlinks
// both recurse (a symlink to a file lists no children, so it is dropped — the
// old walk's behavior); recursion is bounded by FILE_DEPTH so symlink cycles
// terminate, re-expanding reachable subtrees at each level.
fn children_of(dir: &Path, depth: u32) -> Value {
    let mut out = Vec::new();
    if depth > FILE_DEPTH {
        return json!(out);
    }
    let Ok(entries) = crate::fs_sorted::read_dir(dir) else {
        return json!(out);
    };
    for entry in entries.flatten() {
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        let name = entry.file_name().to_string_lossy().into_owned();
        let path = entry.path();
        if kind.is_file() {
            out.push(json!({ "n": name, "f": true }));
        } else {
            out.push(json!({ "n": name, "f": false, "c": children_of(&path, depth + 1) }));
        }
    }
    json!(out)
}

// Read a `.claude/skills`-style dir (subfolder-per-skill, each with SKILL.md).
// None = not a readable dir (the caller treats it as "no skills here"). A
// skill whose SKILL.md exists but cannot be read still ships, with empty
// description/raw, matching the old swallow-and-continue.
fn read_skills_dir(dir: &Path) -> Option<Vec<Value>> {
    let entries = crate::fs_sorted::read_dir(dir).ok()?;
    let mut skills = Vec::new();
    for entry in entries {
        let entry = entry.ok()?;
        let kind = entry.file_type().ok()?;
        if !(kind.is_dir() || kind.is_symlink()) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let skill_dir = dir.join(&name);
        let md = skill_dir.join("SKILL.md");
        if !md.exists() {
            continue;
        }
        let (description, raw) = match fs::read(&md) {
            Ok(bytes) => {
                let src = String::from_utf8_lossy(&bytes).into_owned();
                let description = parse_skill(&src).description;
                (description, src)
            }
            Err(_) => (String::new(), String::new()),
        };
        skills.push(json!({
            "name": name,
            "description": description,
            "raw": raw,
            "tree": children_of(&skill_dir, 0),
        }));
    }
    Some(skills)
}

// List skills under `root`, auto-detecting layout. Grouped (each subdir with a
// .claude/skills holding >= 1 skill) wins if both layouts could apply; else
// flat (the root itself is a skills dir -> one scope named after the root);
// neither -> the no-error empty case. Scopes/skills ship unsorted (readdir
// order); Node sorts and applies SKILLS_CAP.
pub fn list(root: &Value) -> Value {
    let root_str = root.as_str().unwrap_or("");
    let root_path = Path::new(root_str);
    if !root_path.exists() {
        return json!({ "scopes": [], "flat": false, "error": "skills root not found" });
    }
    let mut subdirs: Vec<String> = Vec::new();
    match crate::fs_sorted::read_dir(root_path) {
        Ok(entries) => {
            for entry in entries.flatten() {
                let Ok(kind) = entry.file_type() else {
                    continue;
                };
                if kind.is_dir() || kind.is_symlink() {
                    subdirs.push(entry.file_name().to_string_lossy().into_owned());
                }
            }
        }
        Err(_) => {
            return json!({ "scopes": [], "flat": false, "error": "skills root unreadable" });
        }
    }
    let mut grouped = Vec::new();
    for scope in &subdirs {
        let skills_dir = root_path.join(scope).join(".claude").join("skills");
        if let Some(skills) = read_skills_dir(&skills_dir) {
            if !skills.is_empty() {
                grouped.push(json!({ "name": scope, "skills": skills }));
            }
        }
    }
    if !grouped.is_empty() {
        return json!({ "scopes": grouped, "flat": false });
    }
    if let Some(skills) = read_skills_dir(root_path) {
        if !skills.is_empty() {
            let name = root_path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .filter(|n| !n.is_empty())
                .unwrap_or_else(|| root_str.to_owned());
            return json!({ "scopes": [{ "name": name, "skills": skills }], "flat": true });
        }
    }
    json!({ "scopes": [], "flat": false })
}

// The dir holding a skill's SKILL.md: flat -> <root>/<skill>, else
// grouped -> <root>/<scope>/.claude/skills/<skill>.
fn base_dir(root: &str, scope: Option<&str>, skill: &str, flat: bool) -> PathBuf {
    if flat {
        Path::new(root).join(skill)
    } else {
        Path::new(root)
            .join(scope.unwrap_or(""))
            .join(".claude")
            .join("skills")
            .join(skill)
    }
}

fn signed_time_ms(time: std::time::SystemTime) -> f64 {
    match time.duration_since(UNIX_EPOCH) {
        Ok(since) => since.as_secs_f64() * 1000.0,
        Err(before) => -before.duration().as_secs_f64() * 1000.0,
    }
}

fn mtime_ms(path: &Path) -> Option<f64> {
    fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok()
        .map(signed_time_ms)
}

// Read a skill's SKILL.md. Name/scope validation happened Node-side; `flat`
// selects the layout. `body`/`raw` split and mtime mirror the old Node shape.
pub fn read_skill(root: &Value, scope: &Value, skill: &Value, flat: &Value) -> Value {
    let (Some(root), Some(skill)) = (root.as_str(), skill.as_str()) else {
        return json!({ "ok": false, "error": "bad name" });
    };
    let flat = flat.as_bool().unwrap_or(false);
    let path = base_dir(root, scope.as_str(), skill, flat).join("SKILL.md");
    if !path.exists() {
        return json!({ "ok": false, "error": "not found" });
    }
    let Ok(bytes) = fs::read(&path) else {
        return json!({ "ok": false, "error": "unreadable skill" });
    };
    let raw = String::from_utf8_lossy(&bytes).into_owned();
    let parsed = parse_skill(&raw);
    let Some(mtime) = mtime_ms(&path) else {
        return json!({ "ok": false, "error": "unreadable skill" });
    };
    json!({
        "ok": true,
        "path": path.to_string_lossy(),
        "name": parsed.name,
        "description": parsed.description,
        "triggers": parsed.triggers,
        "body": parsed.body,
        "raw": raw,
        "mtime": mtime,
    })
}

// Read a supporting file inside a skill dir. `file` is a relative POSIX path
// whose segments were all NAME_RE-validated Node-side. `type` tells the
// client how to render; an image ships metadata with no content (binary is
// not sent over JSON).
pub fn read_skill_file(
    root: &Value,
    scope: &Value,
    skill: &Value,
    file: &Value,
    flat: &Value,
) -> Value {
    let (Some(root), Some(skill), Some(file)) = (root.as_str(), skill.as_str(), file.as_str())
    else {
        return json!({ "ok": false, "error": "bad file" });
    };
    let flat = flat.as_bool().unwrap_or(false);
    let mut path = base_dir(root, scope.as_str(), skill, flat);
    for segment in file.split('/') {
        path = path.join(segment);
    }
    if !path.exists() {
        return json!({ "ok": false, "error": "not found" });
    }
    let path_str = path.to_string_lossy().into_owned();
    // No dot -> the extension is the whole path string (the old slice corner).
    let ext = path_str
        .rfind('.')
        .map(|at| path_str[at + 1..].to_lowercase())
        .unwrap_or_else(|| path_str.to_lowercase());
    let kind = if MD_EXT.contains(&ext.as_str()) {
        "markdown"
    } else if IMG_EXT.contains(&ext.as_str()) {
        "image"
    } else {
        "code"
    };
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path_str.clone());
    let Some(mtime) = mtime_ms(&path) else {
        return json!({ "ok": false, "error": "unreadable file" });
    };
    if kind == "image" {
        return json!({ "ok": true, "type": kind, "name": name, "path": path_str, "mtime": mtime });
    }
    match fs::read(&path) {
        Ok(bytes) => json!({
            "ok": true,
            "type": kind,
            "name": name,
            "path": path_str,
            "content": String::from_utf8_lossy(&bytes),
            "mtime": mtime,
        }),
        Err(_) => json!({ "ok": false, "error": "unreadable file" }),
    }
}

// The request path is derived and validated Node-side; this final mtime check
// runs after the private bridge queue wait and directly before the sync write.
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
    use std::fs::{create_dir_all, write};
    use std::time::{SystemTime, UNIX_EPOCH as EPOCH};

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let id = SystemTime::now().duration_since(EPOCH).unwrap().as_nanos();
            let path = std::env::temp_dir().join(format!("singularity-skills-{id}"));
            create_dir_all(&path).unwrap();
            Self(path)
        }
        fn put(&self, rel: &str, text: &str) {
            let path = self.0.join(rel);
            create_dir_all(path.parent().unwrap()).unwrap();
            write(path, text).unwrap();
        }
        fn dir(&self, rel: &str) -> PathBuf {
            let path = self.0.join(rel);
            create_dir_all(&path).unwrap();
            path
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
        let after = EPOCH + duration;
        let before = EPOCH - duration;
        assert_eq!(signed_time_ms(after), 2750.125);
        assert_eq!(signed_time_ms(before), -2750.125);
    }

    #[test]
    fn parse_skill_ports_frontmatter_rules() {
        let src = "---\nname: first\ndescription: \"kept verbatim\"\nname: last wins\ntriggers: not a list\ntriggers:\n  - one trigger\n  -   spaced  \nother: ignored\n---\n\n# body";
        let parsed = parse_skill(src);
        assert_eq!(parsed.name, "last wins");
        assert_eq!(parsed.description, "\"kept verbatim\"");
        assert_eq!(parsed.triggers, ["one trigger", "spaced"]);
        assert_eq!(parsed.body, "\n# body");
        let bare = parse_skill("# no frontmatter\nbody");
        assert_eq!(bare.name, "");
        assert_eq!(bare.description, "");
        assert_eq!(bare.triggers, Vec::<String>::new());
        assert_eq!(bare.body, "# no frontmatter\nbody");
    }

    fn collect_files(tree: &Value, prefix: &str, out: &mut Vec<String>) {
        for entry in tree.as_array().into_iter().flatten() {
            let name = entry["n"].as_str().unwrap_or("");
            let rel = if prefix.is_empty() {
                name.to_owned()
            } else {
                format!("{prefix}/{name}")
            };
            if entry["f"].as_bool().unwrap_or(false) {
                out.push(rel);
            } else {
                collect_files(&entry["c"], &rel, out);
            }
        }
    }

    #[test]
    fn list_detects_grouped_flat_and_empty_roots() {
        let f = Fixture::new();
        let scopes = f.dir("roots/scopes");
        f.put(
            "roots/scopes/coding/.claude/skills/freeze/SKILL.md",
            "---\nname: freeze\ndescription: Lock edits.\n---\nbody",
        );
        f.put(
            "roots/scopes/common/.claude/skills/x/SKILL.md",
            "no frontmatter",
        );
        f.dir("roots/scopes/empty/.claude");
        let grouped = list(&json!(scopes.to_str().unwrap()));
        assert_eq!(grouped["flat"], false);
        let names: Vec<&str> = grouped["scopes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|scope| scope["name"].as_str().unwrap())
            .collect();
        assert!(names.contains(&"coding") && names.contains(&"common"));
        let coding = grouped["scopes"]
            .as_array()
            .unwrap()
            .iter()
            .find(|scope| scope["name"] == "coding")
            .unwrap()
            .clone();
        let freeze = &coding["skills"][0];
        assert_eq!(freeze["name"], "freeze");
        assert_eq!(freeze["description"], "Lock edits.");
        assert_eq!(
            freeze["raw"],
            "---\nname: freeze\ndescription: Lock edits.\n---\nbody"
        );

        let flat_root = f.dir("roots/flat");
        f.put("roots/flat/declawed/SKILL.md", "---\nname: declawed\n---\n");
        f.dir("roots/flat/not-a-skill");
        let flat = list(&json!(flat_root.to_str().unwrap()));
        assert_eq!(flat["flat"], true);
        assert_eq!(flat["scopes"][0]["name"], "flat");

        // Grouped wins when both layouts could apply.
        let mixed = f.dir("roots/mixed");
        f.put("roots/mixed/direct/SKILL.md", "x");
        f.put("roots/mixed/g/.claude/skills/s/SKILL.md", "x");
        let both = list(&json!(mixed.to_str().unwrap()));
        assert_eq!(both["flat"], false);
        assert_eq!(both["scopes"].as_array().unwrap().len(), 1);
        assert_eq!(both["scopes"][0]["name"], "g");

        let empty = f.dir("roots/empty-root");
        assert_eq!(
            list(&json!(empty.to_str().unwrap())),
            json!({ "scopes": [], "flat": false })
        );
        assert_eq!(
            list(&json!(f.0.join("absent").to_string_lossy()))["error"],
            "skills root not found"
        );
        f.put("roots/as-file", "a file standing in for an unreadable root");
        assert_eq!(
            list(&json!(f.0.join("roots/as-file").to_string_lossy()))["error"],
            "skills root unreadable"
        );
    }

    #[test]
    fn writes_utf8_empty_content_checks_mtime_and_does_not_create_parents() {
        let f = Fixture::new();
        let path = f.0.join("skill/SKILL.md");
        f.put("skill/SKILL.md", "prior");
        let initial = mtime_ms(&path).unwrap();
        let saved = write_file(path.to_str(), Some("技能 🧪"), Some(initial), false);
        assert_eq!(saved["ok"], true);
        assert_eq!(fs::read_to_string(&path).unwrap(), "技能 🧪");

        let empty = write_file(path.to_str(), Some(""), None, false);
        assert_eq!(empty["ok"], true);
        assert_eq!(fs::read(&path).unwrap(), b"");

        let changed = write_file(path.to_str(), Some("external"), None, false);
        assert_eq!(changed["ok"], true);
        let actual = mtime_ms(&path).unwrap();
        let stale = write_file(path.to_str(), Some("rejected"), Some(actual - 10.0), false);
        assert_eq!(stale["error"], "changed on disk");
        assert_eq!(fs::read_to_string(&path).unwrap(), "external");
        let forced = write_file(path.to_str(), Some("forced"), Some(actual - 10.0), true);
        assert_eq!(forced["ok"], true);
        assert_eq!(fs::read_to_string(&path).unwrap(), "forced");

        let missing = f.0.join("missing/child.md");
        let result = write_file(missing.to_str(), Some("x"), None, false);
        assert_eq!(result["ok"], false);
        assert!(!missing.parent().unwrap().exists());
    }

    #[test]
    fn tree_bounds_depth_and_keeps_a_unreadable_skill_md_listed() {
        let f = Fixture::new();
        let root = f.dir("deep");
        f.put("deep/skill/SKILL.md", "body");
        f.put("deep/skill/a/b/c/d/e/f/x.md", "");
        f.put("deep/skill/a/b/c/d/e/f/g/y.md", "");
        let listed = list(&json!(root.to_str().unwrap()));
        let tree = &listed["scopes"][0]["skills"][0]["tree"];
        let mut files = Vec::new();
        collect_files(tree, "", &mut files);
        assert!(files.contains(&"a/b/c/d/e/f/x.md".to_owned()));
        assert!(!files.iter().any(|rel| rel.ends_with("y.md")));

        // SKILL.md that exists but cannot be read still ships, empty.
        let broken = f.dir("broken");
        f.dir("broken/weird/SKILL.md");
        let listed = list(&json!(broken.to_str().unwrap()));
        assert_eq!(
            listed["scopes"][0]["skills"][0],
            json!({ "name": "weird", "description": "", "raw": "", "tree": [{ "n": "SKILL.md", "f": false, "c": [] }] })
        );
    }

    #[test]
    fn tree_follows_symlinked_dirs_and_cycle_duplicates() {
        let f = Fixture::new();
        let root = f.dir("looproot");
        f.put("looproot/spin/SKILL.md", "body");
        f.put("looproot/spin/sub/note.md", "x");
        let spin = f.dir("looproot/spin");
        let linked = {
            #[cfg(unix)]
            {
                std::os::unix::fs::symlink(&spin, spin.join("loop")).is_ok()
            }
            #[cfg(windows)]
            {
                std::os::windows::fs::symlink_dir(&spin, spin.join("loop")).is_ok()
            }
        };
        if linked {
            let listed = list(&json!(root.to_str().unwrap()));
            let tree = &listed["scopes"][0]["skills"][0]["tree"];
            let mut files = Vec::new();
            collect_files(tree, "", &mut files);
            let notes = files.iter().filter(|rel| rel.ends_with("note.md")).count();
            assert!(notes > 1, "cycle re-lists reachable files ({files:?})");
            // The depth bound ends the cycle: duplicates == FILE_DEPTH, not
            // more (cap sits Node-side, so the tree itself must stop).
            assert_eq!(notes as u32, FILE_DEPTH);
            assert!(files.iter().any(|rel| rel == "sub/note.md"));
            assert!(files.iter().any(|rel| rel == "loop/sub/note.md"));
        }
    }

    #[test]
    fn read_skill_and_file_port_the_payload_shapes() {
        let f = Fixture::new();
        let root = f.dir("rw");
        let md = "---\nname: freeze\ndescription: Lock edits.\ntriggers:\n  - freeze edits\n---\n\n# freeze\n\nbody";
        f.put("rw/coding/.claude/skills/freeze/SKILL.md", md);
        f.put(
            "rw/coding/.claude/skills/freeze/scripts/run.mjs",
            "console.log('run')",
        );
        f.put("rw/coding/.claude/skills/freeze/pic.png", "binaryish");
        let root_str = root.to_str().unwrap();
        let read = read_skill(
            &json!(root_str),
            &json!("coding"),
            &json!("freeze"),
            &json!(false),
        );
        assert_eq!(read["ok"], true);
        assert_eq!(read["name"], "freeze");
        assert_eq!(read["description"], "Lock edits.");
        assert_eq!(read["triggers"], json!(["freeze edits"]));
        assert_eq!(read["body"], "\n# freeze\n\nbody");
        assert_eq!(read["raw"], md);
        assert!(read["mtime"].as_f64().unwrap() > 0.0);
        assert_eq!(
            read_skill(
                &json!(root_str),
                &json!("coding"),
                &json!("nope"),
                &json!(false)
            ),
            json!({ "ok": false, "error": "not found" })
        );

        let code = read_skill_file(
            &json!(root_str),
            &json!("coding"),
            &json!("freeze"),
            &json!("scripts/run.mjs"),
            &json!(false),
        );
        assert_eq!(code["ok"], true);
        assert_eq!(code["type"], "code");
        assert_eq!(code["name"], "run.mjs");
        assert_eq!(code["content"], "console.log('run')");
        let image = read_skill_file(
            &json!(root_str),
            &json!("coding"),
            &json!("freeze"),
            &json!("pic.png"),
            &json!(false),
        );
        assert_eq!(image["type"], "image");
        assert_eq!(image["name"], "pic.png");
        assert!(image["content"].is_null());
        assert!(image.get("content").is_none());
        assert_eq!(
            read_skill_file(
                &json!(root_str),
                &json!("coding"),
                &json!("freeze"),
                &json!("missing.md"),
                &json!(false)
            ),
            json!({ "ok": false, "error": "not found" })
        );
        let flat = read_skill_file(
            &json!(root_str),
            &json!(null),
            &json!("freeze"),
            &json!("pic.png"),
            &json!(true),
        );
        assert_eq!(flat["ok"], false); // flat base has no freeze dir here
    }
}
