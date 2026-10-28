//! One-shot daemon-startup state migration, ported from `server/migrate-state.mjs`.
//!
//! Flattens the old `~/.singularity` layout into `state/` + `cache/`, relocates
//! `tickets/` to the trusted root, moves background `Report.md` files into
//! `.reports/<short>/` (stamping `reportDir` on the stored records) and renames
//! three legacy field families. Idempotent and best-effort: every step skips
//! entries already at the new path and ignores missing old ones, so re-running it
//! against an already-migrated home is a no-op. Only the two directory creations
//! Node leaves unguarded can fail, and they surface as `Err`.
//!
//! Every path is injected through [`StateMigration`] — nothing here reads the
//! environment or the real home.
use crate::app_paths::AppPaths;
use serde_json::Value;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// Legacy flat entries under `APP_DIR` and the subdir they belong in now.
const STATE_ENTRIES: [&str; 5] = [
    "agents.json",
    "tasks.json",
    "crons.json",
    "ollama.json",
    "tickets",
];
const CACHE_ENTRIES: [&str; 1] = ["pw-ollama-profile"];

#[derive(Debug, Clone)]
pub struct StateMigration {
    pub app_dir: PathBuf,
    pub state_dir: PathBuf,
    pub cache_dir: PathBuf,
    pub tickets_dir: PathBuf,
    pub reports_dir: PathBuf,
    pub backups_dir: PathBuf,
}

// VERIFY: state-migration-run
impl StateMigration {
    pub fn from_app_paths(paths: &AppPaths) -> Self {
        Self {
            app_dir: paths.app_dir.clone(),
            state_dir: paths.state_dir.clone(),
            cache_dir: paths.cache_dir.clone(),
            tickets_dir: paths.tickets_dir.clone(),
            reports_dir: paths.reports_dir.clone(),
            backups_dir: paths.backups_dir.clone(),
        }
    }

    /// Runs the migration in the same order as the Node module's import side
    /// effects. Safe to call against an already-migrated layout.
    pub fn run(&self) -> io::Result<()> {
        fs::create_dir_all(&self.state_dir)?;
        fs::create_dir_all(&self.cache_dir)?;
        self.relocate_legacy_entries();
        self.relocate_tickets();
        self.migrate_reports()?;
        self.rename_fields();
        Ok(())
    }

    fn relocate_legacy_entries(&self) {
        for name in STATE_ENTRIES {
            self.relocate(&self.app_dir.join(name), &self.state_dir.join(name));
        }
        for name in CACHE_ENTRIES {
            self.relocate(&self.app_dir.join(name), &self.cache_dir.join(name));
        }
    }

    // Tickets relocate from the previous `state/tickets` location. Worktrees are
    // git-registered, so they are deliberately not moved (a rename would break the
    // gitdir link); new tasks create them at the new path.
    fn relocate_tickets(&self) {
        self.relocate(&self.state_dir.join("tickets"), &self.tickets_dir);
    }

    /// `existsSync(old) && !existsSync(new)` — never overwrite the new location.
    fn relocate(&self, old: &Path, new: &Path) {
        if old.exists() && !new.exists() {
            let _ = rename_across_volume(old, new);
        }
    }

    fn migrate_reports(&self) -> io::Result<()> {
        fs::create_dir_all(&self.reports_dir)?;
        self.move_report_files();
        self.stamp_report_dirs();
        Ok(())
    }

    /// `Report.md` left in `.tickets/<short>/` moves to `.reports/<short>/`.
    fn move_report_files(&self) {
        let Ok(entries) = fs::read_dir(&self.tickets_dir) else {
            return;
        };
        for entry in entries.filter_map(Result::ok) {
            let is_dir = entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false);
            if !is_dir {
                continue;
            }
            let source = entry.path().join("Report.md");
            if !source.exists() {
                continue;
            }
            let destination_dir = self.reports_dir.join(entry.file_name());
            let destination = destination_dir.join("Report.md");
            if destination.exists() {
                continue;
            }
            if fs::create_dir_all(&destination_dir).is_ok() {
                let _ = fs::rename(&source, &destination);
            }
        }
    }

    /// Stamp `reportDir` onto background-tagged records that lack it, so the
    /// background scheduler reads `.reports/<short>/` with no fallback path.
    fn stamp_report_dirs(&self) {
        let tasks_file = self.state_dir.join("tasks.json");
        if !tasks_file.exists() {
            return;
        }
        let Some(mut document) = read_json(&tasks_file) else {
            return;
        };
        let mut changed = false;
        if let Some(object) = document.as_object_mut() {
            for key in ["tasks", "history"] {
                let Some(records) = object.get_mut(key).and_then(Value::as_array_mut) else {
                    continue;
                };
                for record in records {
                    changed |= stamp_report_dir(record, &self.reports_dir);
                }
            }
        }
        if changed {
            let _ = write_json_atomic(&tasks_file, &document, &self.backups_dir);
        }
    }

    /// `crons.json name/prompt -> title/description`, `background.json defs ->
    /// jobs`, `agents.json name -> title`. Idempotent: writes only when a key
    /// actually moved.
    fn rename_fields(&self) {
        self.migrate_file("crons.json", |document| {
            rename_records(
                document,
                "crons",
                &[("name", "title"), ("prompt", "description")],
            )
        });
        self.migrate_file("background.json", |document| {
            Some(rename_key(document, "defs", "jobs"))
        });
        self.migrate_file("agents.json", |document| {
            rename_records(document, "agents", &[("name", "title")])
        });
    }

    /// `migrateFile`: missing file and unparseable JSON are silent no-ops, and a
    /// transform that would throw in Node (`None`) skips the write.
    fn migrate_file<F>(&self, name: &str, transform: F)
    where
        F: Fn(&mut Value) -> Option<bool>,
    {
        let file = self.state_dir.join(name);
        if !file.exists() {
            return;
        }
        let Some(mut document) = read_json(&file) else {
            return;
        };
        let Some(changed) = transform(&mut document) else {
            return;
        };
        if changed {
            let _ = write_json_atomic(&file, &document, &self.backups_dir);
        }
    }
}

/// `for (const item of d.<key> || [])`: a falsy non-array iterates zero times, a
/// truthy non-array throws inside Node's `try` (so `None` = leave the file alone).
fn rename_records(document: &mut Value, key: &str, renames: &[(&str, &str)]) -> Option<bool> {
    let mut changed = false;
    match document.get_mut(key) {
        None => {}
        Some(value) if !js_truthy(value) => {}
        Some(Value::Array(records)) => {
            for record in records {
                for (old, new) in renames {
                    changed |= rename_key(record, old, new);
                }
            }
        }
        Some(_) => return None,
    }
    Some(changed)
}

/// `renameKey`: rename only when the old key exists and the new one does not.
/// Renaming appends the new key at the end, matching `obj[neu] = obj[old]; delete`.
fn rename_key(object: &mut Value, old: &str, new: &str) -> bool {
    let Some(map) = object.as_object_mut() else {
        return false;
    };
    if !map.contains_key(old) || map.contains_key(new) {
        return false;
    }
    let value = map.shift_remove(old).expect("checked above");
    map.insert(new.to_owned(), value);
    true
}

/// `t.tags || []` then `.includes('background')` — an array matches by element,
/// a string by substring, and (unlike Node, where `.includes` would throw and
/// abort the boot) any other type matches nothing.
fn tagged_background(tags: Option<&Value>) -> bool {
    match tags {
        Some(Value::Array(items)) => items.iter().any(|item| item.as_str() == Some("background")),
        Some(Value::String(text)) => text.contains("background"),
        _ => false,
    }
}

/// `t.reportDir` truthiness gate plus the `join(REPORTS_DIR, id.slice(0, 8))` stamp.
fn stamp_report_dir(record: &mut Value, reports_dir: &Path) -> bool {
    let Some(object) = record.as_object_mut() else {
        return false;
    };
    if !tagged_background(object.get("tags")) {
        return false;
    }
    if object.get("reportDir").is_some_and(js_truthy) {
        return false;
    }
    let Some(short) = object
        .get("id")
        .and_then(Value::as_str)
        .map(js_slice_8)
        .filter(|short| !short.is_empty())
    else {
        return false;
    };
    let report_dir = crate::app_paths::join(reports_dir, &short);
    object.insert(
        "reportDir".to_owned(),
        Value::String(report_dir.to_string_lossy().into_owned()),
    );
    true
}

/// `String.prototype.slice(0, 8)`: UTF-16 code units, so an astral character
/// costs two. A split surrogate pair cannot name a Rust path, so it is replaced.
fn js_slice_8(value: &str) -> String {
    let units: Vec<u16> = value.encode_utf16().take(8).collect();
    String::from_utf16_lossy(&units)
}

/// JavaScript truthiness of a parsed JSON value (`NaN` is not expressible).
fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(value) => value.as_f64() != Some(0.0),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

fn read_json(file: &Path) -> Option<Value> {
    serde_json::from_str(&fs::read_to_string(file).ok()?).ok()
}

/// `writeJsonAtomic`: back up, write `<file>.<pid>.tmp`, then rename over the
/// original, so a kill or full disk mid-write never truncates the file. A failed
/// write leaves the temp file behind, exactly as in Node; callers are best-effort.
fn write_json_atomic(file: &Path, value: &Value, backups_dir: &Path) -> Option<()> {
    back_up(file, backups_dir);
    let text = serde_json::to_string_pretty(value).ok()?;
    let temp = temp_sibling(file)?;
    fs::write(&temp, text).ok()?;
    fs::rename(&temp, file).ok()?;
    Some(())
}

/// `backupFileSync(file)`, best-effort: keyed by the path's own spelling.
fn back_up(file: &Path, backups_dir: &Path) {
    if let Some(raw) = file.to_str() {
        let _ = crate::memory_backup::backup_file(raw, file, backups_dir);
    }
}

/// `${file}.${process.pid}.tmp`
fn temp_sibling(file: &Path) -> Option<PathBuf> {
    let mut name = file.file_name()?.to_os_string();
    name.push(format!(".{}.tmp", std::process::id()));
    Some(file.with_file_name(name))
}

/// `renameSync` with the module's EXDEV fallback: a cross-volume rename copies
/// recursively and then deletes the source. Non-EXDEV errors propagate (the move
/// sites swallow them).
fn rename_across_volume(old: &Path, new: &Path) -> io::Result<()> {
    match fs::rename(old, new) {
        Ok(()) => Ok(()),
        Err(error) if crosses_devices(&error) => {
            copy_tree(old, new)?;
            remove_tree(old)
        }
        Err(error) => Err(error),
    }
}

fn crosses_devices(error: &io::Error) -> bool {
    // EXDEV (unix) / ERROR_NOT_SAME_DEVICE (windows).
    let code = if cfg!(windows) { 17 } else { 18 };
    error.raw_os_error() == Some(code)
}

/// `cpSync(from, to, {recursive: true})` for files and directories.
fn copy_tree(from: &Path, to: &Path) -> io::Result<()> {
    let metadata = fs::symlink_metadata(from)?;
    if metadata.is_dir() {
        fs::create_dir_all(to)?;
        for entry in fs::read_dir(from)? {
            let entry = entry?;
            copy_tree(&entry.path(), &to.join(entry.file_name()))?;
        }
        Ok(())
    } else {
        if let Some(parent) = to.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(from, to).map(|_| ())
    }
}

/// `rmSync(path, {recursive: true, force: true})`.
fn remove_tree(path: &Path) -> io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_dir() => fs::remove_dir_all(path),
        Ok(_) => fs::remove_file(path),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use super::{StateMigration, copy_tree, js_slice_8, remove_tree, rename_across_volume};
    use ring::digest;
    use serde_json::{Value, json};
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static FIXTURE_ID: AtomicU64 = AtomicU64::new(0);

    struct Fixture {
        root: PathBuf,
        migration: StateMigration,
    }

    impl Fixture {
        fn new() -> Self {
            let unique = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let id = FIXTURE_ID.fetch_add(1, Ordering::Relaxed);
            let root = std::env::temp_dir().join(format!(
                "state-migration-{}-{unique}-{id}",
                std::process::id()
            ));
            fs::create_dir_all(&root).unwrap();
            let home = root.join("home");
            let trusted = root.join("trusted");
            // Like the real clone root (Node's default TRUSTED_ROOT), the trusted
            // root itself exists; `.tickets`/`.reports` are what get created.
            fs::create_dir_all(&trusted).unwrap();
            let migration = StateMigration {
                app_dir: home.clone(),
                state_dir: home.join("state"),
                cache_dir: home.join("cache"),
                tickets_dir: trusted.join(".tickets"),
                reports_dir: trusted.join(".reports"),
                backups_dir: home.join("cache").join("backups"),
            };
            Self { root, migration }
        }

        fn put(&self, path: &Path, content: &str) {
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, content).unwrap();
        }

        fn json(&self, path: &Path) -> Value {
            serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap()
        }

        fn run(&self) {
            self.migration.run().unwrap();
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    // The three cases `server/migrate-state.test.mjs` pins.
    // VERIFY: state-migration-field-renames
    #[test]
    fn rewrite_is_valid_json_with_the_field_renamed() {
        let fixture = Fixture::new();
        let crons = fixture.migration.state_dir.join("crons.json");
        fixture.put(
            &crons,
            r#"{"crons":[{"id":"1","name":"old-name","prompt":"old-prompt"}]}"#,
        );

        fixture.run();

        let raw = fixture.json(&crons);
        assert_eq!(raw["crons"][0]["title"], json!("old-name"));
        assert_eq!(raw["crons"][0]["description"], json!("old-prompt"));
        assert!(raw["crons"][0].get("name").is_none());
        assert!(raw["crons"][0].get("prompt").is_none());
        assert_eq!(raw["crons"][0]["id"], json!("1"));
    }

    // VERIFY: state-migration-backup
    #[test]
    fn a_backup_of_the_pre_rewrite_content_exists() {
        let fixture = Fixture::new();
        let crons = fixture.migration.state_dir.join("crons.json");
        fixture.put(
            &crons,
            r#"{"crons":[{"id":"1","name":"old-name","prompt":"old-prompt"}]}"#,
        );

        fixture.run();

        let key = sha256_prefix(crons.to_str().unwrap());
        let backup_dir = fixture.migration.backups_dir.join(&key);
        assert!(backup_dir.exists(), "backup dir was created");
        let bak = fs::read_dir(&backup_dir)
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .find(|path| path.extension().and_then(|ext| ext.to_str()) == Some("bak"))
            .expect("at least one .bak file written");
        let original = fixture.json(&bak);
        assert_eq!(original["crons"][0]["name"], json!("old-name"));
        assert_eq!(original["crons"][0]["prompt"], json!("old-prompt"));
    }

    // VERIFY: state-migration-atomic-write
    #[test]
    fn rewrite_uses_a_temp_and_rename_leaving_no_tmp_file() {
        let fixture = Fixture::new();
        let crons = fixture.migration.state_dir.join("crons.json");
        fixture.put(&crons, r#"{"crons":[{"name":"old-name"}]}"#);

        fixture.run();

        let leftovers: Vec<String> = fs::read_dir(&fixture.migration.state_dir)
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.ends_with(".tmp"))
            .collect();
        assert_eq!(leftovers, Vec::<String>::new());
        assert_eq!(
            fs::read_to_string(&crons).unwrap(),
            "{\n  \"crons\": [\n    {\n      \"title\": \"old-name\"\n    }\n  ]\n}"
        );
    }

    // VERIFY: state-migration-legacy-moves
    #[test]
    fn legacy_flat_entries_move_and_existing_destinations_win() {
        let fixture = Fixture::new();
        let state = &fixture.migration.state_dir;
        let cache = &fixture.migration.cache_dir;
        fixture.put(
            &fixture.migration.app_dir.join("agents.json"),
            r#"{"agents":[]}"#,
        );
        fixture.put(&fixture.migration.app_dir.join("ollama.json"), "{}");
        fixture.put(
            &fixture.migration.app_dir.join("pw-ollama-profile/x.txt"),
            "profile",
        );
        // Already migrated destination: the legacy file must be left in place.
        fixture.put(&fixture.migration.app_dir.join("crons.json"), "{}");
        fixture.put(&state.join("crons.json"), r#"{"crons":[]}"#);
        // A legacy directory entry moves whole.
        fixture.put(
            &fixture
                .migration
                .app_dir
                .join("tickets/abc/Requirements.md"),
            "r",
        );

        fixture.run();

        assert_eq!(
            fs::read_to_string(state.join("agents.json")).unwrap(),
            r#"{"agents":[]}"#
        );
        assert_eq!(fs::read_to_string(state.join("ollama.json")).unwrap(), "{}");
        assert_eq!(
            fs::read_to_string(cache.join("pw-ollama-profile/x.txt")).unwrap(),
            "profile"
        );
        // A legacy root `tickets/` lands in `state/` and is then relocated to the
        // trusted root by the very next step.
        assert_eq!(
            fs::read_to_string(fixture.migration.tickets_dir.join("abc/Requirements.md")).unwrap(),
            "r"
        );
        assert!(!fixture.migration.app_dir.join("agents.json").exists());
        assert_eq!(
            fs::read_to_string(fixture.migration.app_dir.join("crons.json")).unwrap(),
            "{}"
        );
        assert_eq!(
            fs::read_to_string(state.join("crons.json")).unwrap(),
            r#"{"crons":[]}"#
        );
    }

    // VERIFY: state-migration-tickets-relocation
    #[test]
    fn tickets_relocate_from_state_to_the_trusted_root_once() {
        let fixture = Fixture::new();
        fixture.put(
            &fixture.migration.state_dir.join("tickets/abc/Plan.md"),
            "plan",
        );

        fixture.run();

        let tickets = fixture.migration.tickets_dir.join("abc/Plan.md");
        assert_eq!(fs::read_to_string(&tickets).unwrap(), "plan");
        assert!(!fixture.migration.state_dir.join("tickets").exists());

        // Second run is a no-op, and a pre-existing trusted tickets dir is kept.
        fixture.run();
        assert_eq!(fs::read_to_string(&tickets).unwrap(), "plan");
    }

    // VERIFY: state-migration-tickets-best-effort
    #[test]
    fn tickets_stay_put_when_the_trusted_root_does_not_exist() {
        let fixture = Fixture::new();
        let plan = fixture.migration.state_dir.join("tickets/abc/Plan.md");
        fixture.put(&plan, "plan");
        // Node's renameSync throws ENOENT here and the `catch {}` leaves the old
        // location alone; the Rust port is equally best-effort.
        fs::remove_dir_all(fixture.migration.tickets_dir.parent().unwrap()).unwrap();

        fixture.run();

        assert_eq!(fs::read_to_string(&plan).unwrap(), "plan");
        assert!(!fixture.migration.tickets_dir.exists());
    }

    // VERIFY: state-migration-report-files
    #[test]
    fn report_files_move_to_reports_and_migrated_ones_are_kept() {
        let fixture = Fixture::new();
        let tickets = &fixture.migration.tickets_dir;
        fixture.put(&tickets.join("abc12345/Report.md"), "fresh");
        fixture.put(&tickets.join("abc12345/Plan.md"), "plan stays");
        fixture.put(&tickets.join("def67890/Report.md"), "stale");
        fixture.put(
            &fixture.migration.reports_dir.join("def67890/Report.md"),
            "already",
        );
        fixture.put(&tickets.join("loose.txt"), "not a directory");

        fixture.run();

        assert_eq!(
            fs::read_to_string(fixture.migration.reports_dir.join("abc12345/Report.md")).unwrap(),
            "fresh"
        );
        assert!(!tickets.join("abc12345/Report.md").exists());
        assert_eq!(
            fs::read_to_string(tickets.join("abc12345/Plan.md")).unwrap(),
            "plan stays"
        );
        assert_eq!(
            fs::read_to_string(fixture.migration.reports_dir.join("def67890/Report.md")).unwrap(),
            "already"
        );
        assert_eq!(
            fs::read_to_string(tickets.join("def67890/Report.md")).unwrap(),
            "stale"
        );
    }

    // VERIFY: state-migration-report-dir-stamp
    #[test]
    fn background_records_get_a_report_dir_stamp_once() {
        let fixture = Fixture::new();
        let tasks = fixture.migration.state_dir.join("tasks.json");
        fixture.put(
            &tasks,
            r#"{
  "tasks": [
    {"id": "abcdef123456", "tags": ["background"], "title": "t"},
    {"id": "0123456789ab", "tags": ["ui", "background"]},
    {"id": "fedcba987654", "tags": ["ui"]},
    {"id": "999999999999", "tags": ["background"], "reportDir": "/already/there"},
    {"id": "short", "tags": ["background"]},
    {"tags": ["background"]},
    null,
    "not a record"
  ],
  "history": [
    {"id": "hist00001111", "tags": ["background"]}
  ]
}"#,
        );

        fixture.run();

        let raw = fixture.json(&tasks);
        let reports = |short: &str| {
            fixture
                .migration
                .reports_dir
                .join(short)
                .to_string_lossy()
                .into_owned()
        };
        assert_eq!(raw["tasks"][0]["reportDir"], json!(reports("abcdef12")));
        assert_eq!(
            raw["tasks"][0]["title"],
            json!("t"),
            "key order is preserved"
        );
        assert_eq!(raw["tasks"][1]["reportDir"], json!(reports("01234567")));
        assert!(raw["tasks"][2].get("reportDir").is_none());
        assert_eq!(raw["tasks"][3]["reportDir"], json!("/already/there"));
        assert_eq!(raw["tasks"][4]["reportDir"], json!(reports("short")));
        assert!(raw["tasks"][5].get("reportDir").is_none());
        assert_eq!(raw["history"][0]["reportDir"], json!(reports("hist0000")));

        // Idempotent: the second run neither restamps nor rewrites (no new backup).
        let backups = fixture
            .migration
            .backups_dir
            .join(sha256_prefix(tasks.to_str().unwrap()));
        let count_before = bak_count(&backups);
        fixture.run();
        assert_eq!(bak_count(&backups), count_before);
        assert_eq!(fixture.json(&tasks), raw);
    }

    // VERIFY: state-migration-idempotent
    #[test]
    fn a_second_run_changes_nothing_and_malformed_files_are_skipped() {
        let fixture = Fixture::new();
        let broken = fixture.migration.state_dir.join("agents.json");
        fixture.put(&broken, "{not json");
        let background = fixture.migration.state_dir.join("background.json");
        fixture.put(&background, r#"{"defs":[]}"#);
        let odd = fixture.migration.state_dir.join("crons.json");
        fixture.put(&odd, r#"{"crons":"nope"}"#);

        fixture.run();
        assert_eq!(fs::read_to_string(&broken).unwrap(), "{not json");
        assert_eq!(fixture.json(&background), json!({"jobs": []}));
        assert_eq!(fixture.json(&odd), json!({"crons": "nope"}));
        let backups_after_first = bak_count(&fixture.migration.backups_dir);

        fixture.run();
        assert_eq!(
            bak_count(&fixture.migration.backups_dir),
            backups_after_first
        );
        assert_eq!(fixture.json(&background), json!({"jobs": []}));
    }

    // VERIFY: state-migration-cross-volume
    #[test]
    fn cross_volume_fallback_copies_then_deletes() {
        let fixture = Fixture::new();
        let source = fixture.root.join("source");
        fixture.put(&source.join("nested/file.txt"), "payload");
        let destination = fixture.root.join("destination");

        copy_tree(&source, &destination).unwrap();
        remove_tree(&source).unwrap();

        assert_eq!(
            fs::read_to_string(destination.join("nested/file.txt")).unwrap(),
            "payload"
        );
        assert!(!source.exists());

        // A plain file also moves, and removing a missing path is a no-op.
        let file = fixture.root.join("single.txt");
        fixture.put(&file, "one");
        rename_across_volume(&file, &fixture.root.join("moved.txt")).unwrap();
        assert_eq!(
            fs::read_to_string(fixture.root.join("moved.txt")).unwrap(),
            "one"
        );
        assert!(remove_tree(&fixture.root.join("absent")).is_ok());
    }

    #[test]
    fn js_slice_8_counts_utf16_units() {
        assert_eq!(js_slice_8("abcdefghij"), "abcdefgh");
        assert_eq!(js_slice_8("short"), "short");
        assert_eq!(js_slice_8("😀😀😀😀😀"), "😀😀😀😀");
        assert_eq!(js_slice_8("😀abcdefg"), "😀abcdef");
        assert_eq!(js_slice_8(""), "");
    }

    fn sha256_prefix(raw: &str) -> String {
        let hash = digest::digest(&digest::SHA256, raw.as_bytes());
        hash.as_ref()[..8]
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    }

    fn bak_count(dir: &Path) -> usize {
        let Ok(entries) = fs::read_dir(dir) else {
            return 0;
        };
        entries
            .filter_map(Result::ok)
            .map(|entry| {
                let path = entry.path();
                if path.is_dir() {
                    bak_count(&path)
                } else {
                    usize::from(path.extension().and_then(|ext| ext.to_str()) == Some("bak"))
                }
            })
            .sum()
    }
}
