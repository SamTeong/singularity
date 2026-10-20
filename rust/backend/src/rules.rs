use serde_json::{Value, json};
use std::fs;
use std::path::Path;

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
}
