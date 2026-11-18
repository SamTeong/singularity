//! Report listing, content lookup and per-report flag state for background
//! runs — the `listReports` / `getReport` / `setReportFlag` slice of
//! `server/background.mjs:437-498`.
//!
//! Records come from the task service snapshot (`{"tasks":[...],
//! "history":[...]}`); `reportDir` and `id` are read from those stored records
//! only, so a client-supplied id can never steer a filesystem path. Flags are a
//! JSON array of *unflagged* (dismissed) task ids in `state/report-flags.json`;
//! absence from the array means the report still needs attention.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::{Value, json};

use crate::background::BackgroundError;

/// The report file a background run writes inside its `reportDir`.
pub const REPORT_FILE: &str = "Report.md";
/// The tag every background-created task carries.
pub const BACKGROUND_TAG: &str = "background";
const FLAGS_FILE: &str = "report-flags.json";

/// The injectable `reg.writeAtomic` seam (`background.test.mjs:57` `failWrite`).
pub type WriteAtomic = Arc<dyn Fn(&Path, &[u8]) -> io::Result<()> + Send + Sync>;

/// `loadUnflagged` / `saveUnflagged` (`background.mjs:441-451`).
#[derive(Clone)]
pub struct FlagStore {
    state_dir: PathBuf,
    write: WriteAtomic,
}

impl FlagStore {
    pub fn new(state_dir: PathBuf, write: WriteAtomic) -> Self {
        Self { state_dir, write }
    }

    fn file(&self) -> PathBuf {
        self.state_dir.join(FLAGS_FILE)
    }

    /// The dismissed ids, in file order. A missing or malformed file reads as
    /// empty, matching the Node `catch` arms.
    pub fn load(&self) -> Vec<String> {
        let Ok(text) = fs::read_to_string(self.file()) else {
            return Vec::new();
        };
        match serde_json::from_str::<Value>(&text) {
            Ok(Value::Array(items)) => items
                .into_iter()
                .filter_map(|item| item.as_str().map(str::to_owned))
                .collect(),
            _ => Vec::new(),
        }
    }

    /// `JSON.stringify([...set])` — compact, insertion order.
    pub fn save(&self, ids: &[String]) -> io::Result<()> {
        let body = serde_json::to_string(&Value::Array(
            ids.iter().cloned().map(Value::String).collect(),
        ))
        .expect("a string array serializes");
        (self.write)(&self.file(), body.as_bytes())
    }
}

/// Every task record, live board first then history (`[...tasks, ...history]`).
fn records(snapshot: &Value) -> Vec<&Value> {
    let mut all = Vec::new();
    for key in ["tasks", "history"] {
        if let Some(items) = snapshot.get(key).and_then(Value::as_array) {
            all.extend(items.iter());
        }
    }
    all
}

fn tagged(task: &Value) -> bool {
    task.get("tags")
        .and_then(Value::as_array)
        .is_some_and(|tags| tags.iter().any(|tag| tag.as_str() == Some(BACKGROUND_TAG)))
}

// VERIFY: wave3-fix-background-9
/// `join(t.reportDir, 'Report.md')`. Node throws when `reportDir` is absent or
/// not a string (`background.mjs:481`, `:495`); the two report GET routes have
/// no `try`, so that failure is a 500 rather than a missing report.
fn report_file(task: &Value) -> Result<PathBuf, BackgroundError> {
    let Some(dir) = task.get("reportDir").and_then(Value::as_str) else {
        return Err(BackgroundError::Internal(
            "reportDir is missing from the stored task".to_owned(),
        ));
    };
    Ok(Path::new(dir).join(REPORT_FILE))
}

fn has_report(task: &Value) -> Result<bool, BackgroundError> {
    Ok(report_file(task)?.exists())
}

fn nullish(value: Option<&Value>) -> Option<&Value> {
    value.filter(|value| !value.is_null())
}

/// `t.outcome ?? t.column`.
fn status(task: &Value) -> Value {
    nullish(task.get("outcome"))
        .or_else(|| nullish(task.get("column")))
        .cloned()
        .unwrap_or(Value::Null)
}

fn sort_key(entry: &Value) -> f64 {
    entry
        .get("concludedAt")
        .and_then(Value::as_f64)
        .or_else(|| entry.get("createdAt").and_then(Value::as_f64))
        .unwrap_or(0.0)
}

/// `listReports()`: background-tagged entries, newest first, with whether
/// `Report.md` exists and whether the report is still flagged.
pub fn list_reports(snapshot: &Value, unflagged: &[String]) -> Result<Vec<Value>, BackgroundError> {
    let mut entries: Vec<Value> = Vec::new();
    for task in records(snapshot).into_iter().filter(|task| tagged(task)) {
        let id = task.get("id").cloned().unwrap_or(Value::Null);
        entries.push(json!({
            "taskId": id,
            "title": task.get("title").cloned().unwrap_or(Value::Null),
            "createdAt": task.get("createdAt").cloned().unwrap_or(Value::Null),
            "concludedAt": nullish(task.get("concludedAt")).cloned().unwrap_or(Value::Null),
            "status": status(task),
            "hasReport": has_report(task)?,
            "flagged": !unflagged
                .iter()
                .any(|dismissed| Some(dismissed.as_str()) == task.get("id").and_then(Value::as_str)),
        }));
    }
    entries.sort_by(|left, right| sort_key(right).total_cmp(&sort_key(left)));
    Ok(entries)
}

/// `getReport(taskId)`: `{taskId,title,content}` or `None` when the id is
/// unknown, not background-tagged, or has no `Report.md`.
pub fn get_report(snapshot: &Value, task_id: &str) -> Result<Option<Value>, BackgroundError> {
    let Some(task) = records(snapshot)
        .into_iter()
        .find(|task| task.get("id").and_then(Value::as_str) == Some(task_id) && tagged(task))
    else {
        return Ok(None);
    };
    let file = report_file(task)?;
    if !file.exists() {
        return Ok(None);
    }
    // VERIFY: wave3-fix-background-10
    // An IO/permission failure on an existing Report.md is a 500 in Node
    // (`readFileSync` throws, `background.mjs:497`), not the 404 a missing file
    // gives — a 404 here would tell the UI the report does not exist.
    let bytes = fs::read(&file)
        .map_err(|error| BackgroundError::Internal(format!("Report.md read failed: {error}")))?;
    Ok(Some(json!({
        "taskId": task.get("id").cloned().unwrap_or(Value::Null),
        "title": task.get("title").cloned().unwrap_or(Value::Null),
        "content": String::from_utf8_lossy(&bytes),
    })))
}

// VERIFY: background-report-flags
/// `setReportFlag(taskId, flagged)`. Only known report ids are accepted; the
/// stored set is pruned to the current report ids on every write.
pub fn set_report_flag(
    snapshot: &Value,
    store: &FlagStore,
    task_id: &str,
    flagged: bool,
) -> Result<Value, BackgroundError> {
    // The flag route is wrapped in `try` + `errStatus`, so a record the listing
    // chokes on answers 400 there, not the bare routes' 500 (`index.mjs:292`).
    let reports = list_reports(snapshot, &store.load())
        .map_err(|error| BackgroundError::Validation(error.message().to_owned()))?;
    let known: Vec<String> = reports
        .iter()
        .filter_map(|report| {
            report
                .get("taskId")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .collect();
    if !known.iter().any(|id| id == task_id) {
        return Err(BackgroundError::Validation("no such report".to_owned()));
    }
    let mut dismissed = store.load();
    if flagged {
        dismissed.retain(|id| id != task_id);
    } else if !dismissed.iter().any(|id| id == task_id) {
        dismissed.push(task_id.to_owned());
    }
    dismissed.retain(|id| known.iter().any(|known| known == id));
    store
        .save(&dismissed)
        .map_err(|error| BackgroundError::Validation(error.to_string()))?;
    Ok(json!({ "taskId": task_id, "flagged": flagged }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct Fixture(PathBuf);

    impl Fixture {
        fn new(name: &str) -> Self {
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let dir = std::env::temp_dir().join(format!(
                "singularity-background-reports-{name}-{}-{nanos}",
                std::process::id()
            ));
            fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }

        fn dir(&self, name: &str) -> PathBuf {
            let path = self.0.join(name);
            fs::create_dir_all(&path).unwrap();
            path
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn store(fixture: &Fixture) -> FlagStore {
        FlagStore::new(
            fixture.0.clone(),
            Arc::new(|path: &Path, bytes: &[u8]| fs::write(path, bytes)),
        )
    }

    fn text(path: &Path) -> String {
        path.to_string_lossy().into_owned()
    }

    // background.test.mjs:375-421 — background-tagged entries, hasReport from
    // reportDir (not ticketDir), non-background excluded, newest first.
    #[test]
    fn list_reports_filters_tags_reads_report_dir_and_sorts_newest_first() {
        let fixture = Fixture::new("list");
        let ticket_a = fixture.dir("ticket-a");
        let ticket_b = fixture.dir("ticket-b");
        let report_c = fixture.dir("report-c");
        fs::write(ticket_a.join("Report.md"), "# report a\n").unwrap();
        fs::write(report_c.join("Report.md"), "# report c\n").unwrap();
        let snapshot = json!({
            "tasks": [
                { "id": "live1", "title": "Live BG", "tags": ["background"], "ticketDir": text(&ticket_a), "reportDir": text(&ticket_a), "column": "inprogress", "createdAt": 1000 },
                { "id": "live2", "title": "Not BG", "tags": [], "ticketDir": text(&ticket_b), "column": "todo", "createdAt": 2000 },
                { "id": "live3", "title": "Live BG w/ reportDir", "tags": ["background"], "ticketDir": text(&ticket_b), "reportDir": text(&report_c), "column": "inprogress", "createdAt": 1500 },
            ],
            "history": [
                { "id": "hist1", "title": "Hist BG", "tags": ["background"], "ticketDir": text(&ticket_b), "reportDir": text(&ticket_b), "outcome": "completed", "concludedAt": 3000, "createdAt": 500 },
            ],
        });

        let reports = list_reports(&snapshot, &[]).unwrap();
        let ids: Vec<&str> = reports
            .iter()
            .filter_map(|report| report["taskId"].as_str())
            .collect();
        assert_eq!(
            ids,
            ["hist1", "live3", "live1"],
            "concludedAt 3000 first, then createdAt desc"
        );
        assert!(!ids.contains(&"live2"), "non-background task excluded");
        assert_eq!(reports[0]["taskId"], json!("hist1"));
        let live1 = reports
            .iter()
            .find(|r| r["taskId"] == json!("live1"))
            .unwrap();
        assert_eq!(live1["hasReport"], json!(true));
        assert_eq!(live1["status"], json!("inprogress"));
        assert_eq!(live1["flagged"], json!(true));
        let hist1 = reports
            .iter()
            .find(|r| r["taskId"] == json!("hist1"))
            .unwrap();
        assert_eq!(hist1["hasReport"], json!(false));
        assert_eq!(hist1["status"], json!("completed"));
        assert_eq!(hist1["concludedAt"], json!(3000));
        let live3 = reports
            .iter()
            .find(|r| r["taskId"] == json!("live3"))
            .unwrap();
        assert_eq!(
            live3["hasReport"],
            json!(true),
            "reportDir is read, not ticketDir"
        );
    }

    // background.test.mjs:416-420 — content from reportDir; unknown or
    // untagged ids are None.
    #[test]
    fn get_report_reads_report_dir_and_rejects_unknown_or_untagged_ids() {
        let fixture = Fixture::new("get");
        let ticket_a = fixture.dir("ticket-a");
        let ticket_b = fixture.dir("ticket-b");
        let report_c = fixture.dir("report-c");
        fs::write(ticket_a.join("Report.md"), "# report a\n").unwrap();
        fs::write(report_c.join("Report.md"), "# report c\n").unwrap();
        let snapshot = json!({
            "tasks": [
                { "id": "live1", "title": "Live BG", "tags": ["background"], "reportDir": text(&ticket_a) },
                { "id": "live2", "title": "Not BG", "tags": [], "reportDir": text(&ticket_b) },
                { "id": "live3", "title": "Live BG w/ reportDir", "tags": ["background"], "reportDir": text(&report_c) },
            ],
            "history": [
                { "id": "hist1", "title": "Hist BG", "tags": ["background"], "reportDir": text(&ticket_b) },
            ],
        });
        assert_eq!(
            get_report(&snapshot, "live1").unwrap().unwrap()["content"],
            json!("# report a\n")
        );
        assert_eq!(
            get_report(&snapshot, "live3").unwrap().unwrap()["content"],
            json!("# report c\n")
        );
        assert_eq!(
            get_report(&snapshot, "hist1").unwrap(),
            None,
            "no Report.md"
        );
        assert_eq!(
            get_report(&snapshot, "live2").unwrap(),
            None,
            "not background-tagged"
        );
        assert_eq!(get_report(&snapshot, "nope").unwrap(), None, "unknown id");
    }

    // background.test.mjs:424-433 — flagged by default, toggle persists, stale
    // ids are pruned, unknown ids are rejected.
    #[test]
    fn set_report_flag_persists_toggles_prunes_and_rejects_unknown_ids() {
        let fixture = Fixture::new("flag");
        let report = fixture.dir("report");
        fs::write(report.join("Report.md"), "# r\n").unwrap();
        let snapshot = json!({
            "tasks": [
                { "id": "live1", "title": "BG", "tags": ["background"], "reportDir": text(&report), "createdAt": 1 },
            ],
            "history": [],
        });
        let store = store(&fixture);

        assert_eq!(
            list_reports(&snapshot, &store.load()).unwrap()[0]["flagged"],
            json!(true)
        );
        set_report_flag(&snapshot, &store, "live1", false).unwrap();
        assert_eq!(
            list_reports(&snapshot, &store.load()).unwrap()[0]["flagged"],
            json!(false)
        );
        set_report_flag(&snapshot, &store, "live1", true).unwrap();
        assert_eq!(
            list_reports(&snapshot, &store.load()).unwrap()[0]["flagged"],
            json!(true)
        );
        assert!(matches!(
            set_report_flag(&snapshot, &store, "nope", true),
            Err(BackgroundError::Validation(message)) if message == "no such report"
        ));
    }

    // F4: a background record with no usable reportDir makes Node's whole
    // listing throw (`join(undefined, 'Report.md')`), which the bare GET routes
    // answer as 500 — not a row silently reported as having no report.
    #[test]
    fn list_reports_surfaces_an_unusable_report_dir() {
        let snapshot = json!({
            "tasks": [{ "id": "bg1", "title": "BG", "tags": ["background"], "column": "inprogress" }],
        });
        assert!(matches!(
            list_reports(&snapshot, &[]),
            Err(BackgroundError::Internal(message)) if message.contains("reportDir")
        ));
        assert!(matches!(
            get_report(&snapshot, "bg1"),
            Err(BackgroundError::Internal(_))
        ));
        // An unknown id stays a plain 404, before reportDir is touched
        // (`background.mjs:494-495`).
        assert_eq!(get_report(&snapshot, "nope").unwrap(), None);
        // The flag route is wrapped in `try` + `errStatus`: same failure, 400.
        let fixture = Fixture::new("flag-unusable-dir");
        assert!(matches!(
            set_report_flag(&snapshot, &store(&fixture), "bg1", true),
            Err(BackgroundError::Validation(_))
        ));
    }

    // F4: an existing Report.md that cannot be read is a 500, not a 404.
    #[test]
    fn get_report_surfaces_read_failures() {
        let fixture = Fixture::new("read-failure");
        let report = fixture.dir("report");
        // A directory named Report.md exists, so `exists()`
        // (`existsSync`) is true but the read fails.
        fs::create_dir_all(report.join(REPORT_FILE)).unwrap();
        let snapshot = json!({
            "tasks": [{ "id": "bg1", "title": "BG", "tags": ["background"], "reportDir": text(&report) }],
        });
        assert!(matches!(
            get_report(&snapshot, "bg1"),
            Err(BackgroundError::Internal(message)) if message.contains("read failed")
        ));
        assert_eq!(
            list_reports(&snapshot, &[]).unwrap()[0]["hasReport"],
            json!(true)
        );
    }

    // The flag write seam failing surfaces the raw write error (Node rethrows),
    // and nothing is pruned in memory because the file write never landed.
    #[test]
    fn set_report_flag_surfaces_write_failures() {
        let fixture = Fixture::new("flag-write");
        let report = fixture.dir("report");
        fs::write(report.join("Report.md"), "# r\n").unwrap();
        let snapshot = json!({
            "tasks": [
                { "id": "live1", "title": "BG", "tags": ["background"], "reportDir": text(&report), "createdAt": 1 },
            ],
        });
        let store = FlagStore::new(
            fixture.0.clone(),
            Arc::new(|_: &Path, _: &[u8]| Err(io::Error::from(io::ErrorKind::PermissionDenied))),
        );
        let result = set_report_flag(&snapshot, &store, "live1", false);
        assert!(matches!(result, Err(BackgroundError::Validation(_))));
        assert!(store.load().is_empty());
    }
}
