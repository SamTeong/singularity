//! Native task board: `tasks.json` persistence, task records, transitions,
//! worktree/session lifecycle, retention and the rate-limit watcher.
//!
//! Port of `server/tasks.mjs` (constants `:12-36`, state `:38-45`, init
//! `:134-174`, prompts `:182-419`, create `:424-483`, mutation gate `:491-500`,
//! update `:502-544`, done cleanup `:546-557`, conclude `:569-596`, history
//! delete `:598-604`, retention `:608-616`) with the HTTP surface in
//! [`crate::http_tasks`] and prompts in [`crate::task_prompts`].
//!
//! Concurrency model (design §6.3):
//! - `mutation` is the `serialized()` promise chain (`tasks.mjs:491-496`): one
//!   `tokio::sync::Mutex` held for a whole create/update/conclude, acquired
//!   **before** the state lock.
//! - `state` is a short-lived `std::sync::Mutex`; it is never held across an
//!   `await`, so the snapshot clone is taken before persisting.
//! - Every git call and the `tasks.json` write run in `spawn_blocking` (both
//!   seams are blocking), matching Node's off-loop `execFile`/`writeAtomic`.
//!
//! Durability ordering is preserved exactly: validate → route → worktree →
//! ticket files → spawn → indexes → persist → emit, and for updates
//! stage → persist → commit → emit → irreversible side effects.
//!
//! Deviations from Node, all deliberate and documented:
//! - `delete_history` and `sweep_retention` take the same mutation gate as the
//!   other mutations (Node only serializes update/conclude). Strictly safer.
//! - `create` also takes that gate; Node's `createTask` is not `serialized()`
//!   (`tasks.mjs:430`). Strictly safer (no interleaved create/persist).
//! - `cleanup_failed_worktree` always attempts `git branch -D`, even when
//!   `git worktree remove` failed; Node's single `try` skips the branch delete
//!   if the remove throws (`tasks.mjs:484`). Safer (no orphan branch).
//! - Records load leniently: a value the typed view cannot hold is kept in
//!   [`Task::residual`] and re-emitted, and a file startup could not fully
//!   read is never overwritten. Node keeps every record too but would rewrite
//!   the file from its incomplete in-memory board.
//! - Startup recovery is awaited (Node queues it on the mutation chain); see
//!   [`TaskService::load`] for the latency consequence.
//! - `model`/`implModel`/`reviewerModel`/`scopes` stored as JSON `null` in
//!   Node load back as `None` (omitted on rewrite); the UI never sends null.
//! - `tags` that is truthy but not an array reproduces Node's HTTP 400 message
//!   (`tags.map is not a function`) instead of the JS TypeError object.
//! - `.slice(0, 120)` counts UTF-16 code units in JS; here it is Unicode scalar
//!   values. All board labels are BMP, so the visible result is identical.
//!
//! Inherited Node behaviour, kept for parity: a `persist` failure during
//! `create` leaves the spawned session live and the just-pushed card visible
//! until restart (Node `tasks.mjs:479-482` cleans only the worktree/branch).
//! `mergeMode` is persisted as an explicit `null` for plain tasks
//! (`tasks.mjs:460`), never omitted.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::watch;

use crate::agent_registry::{Clock, CreateAgent, Registry};
use crate::agent_wire::AgentWire;
use crate::bus::{Bus, BusEvent, BusListener};
use crate::fs_atomic::write_atomic;
use crate::task_git::GitPort;

/// `COLUMNS` (`tasks.mjs:20`).
pub const COLUMNS: [&str; 4] = ["todo", "inprogress", "inreview", "done"];
/// `OVERLAY_STATES` (`tasks.mjs:30`): legal on any column. usage-limited =
/// Claude plan limit; rate-limited = a plain 429.
pub const OVERLAY_STATES: [&str; 2] = ["usage-limited", "rate-limited"];
/// `MAX_REVIEW_REJECTS` (`tasks.mjs:34`).
pub const MAX_REVIEW_REJECTS: i64 = 3;
/// `RETENTION_MS` (`tasks.mjs:35`).
pub const RETENTION_MS: i64 = 7 * 24 * 3600 * 1000;
/// The `.unref()`'d sweep interval (`tasks.mjs:163`).
pub const SWEEP_INTERVAL: Duration = Duration::from_millis(3_600_000);
/// Retry delay when a due limit clear could not persist, so the reset timer
/// backs off instead of spinning on a zero-length wait.
const LIMIT_RETRY_DELAY: Duration = Duration::from_secs(30);
/// The rolling output window the rate-limit regex scans (`tasks.mjs:170`).
pub const RATE_LIMIT_TAIL_CHARS: usize = 400;

/// What the output listener hands the limit loop.
enum LimitEvent {
    Enter {
        id: String,
        kind: &'static str,
        reset_at: Option<i64>,
    },
    Clear {
        id: String,
    },
}

// VERIFY: tasks-column-states
/// Per-column state vocabulary (SSOT, `tasks.mjs:24-29`). The em dashes are
/// byte-for-byte UI-visible and arrive from agent curl calls too.
pub fn states_for(column: &str) -> &'static [&'static str] {
    match column {
        "todo" => &["analyzing", "clarifying", "awaiting plan approval"],
        "inprogress" => &["working", "implementing", "fixing"],
        "inreview" => &[
            "reviewing",
            "parked — needs human",
            "parked — merge conflict",
            "awaiting human merge",
            "awaiting human review",
            "stopped — budget",
        ],
        "done" => &["complete", "report ready"],
        _ => &[],
    }
}

// VERIFY: tasks-rate-limit-regex
/// `RATE_LIMIT_RE` (`tasks.mjs`): Ollama 429s only ever appear in the pty
/// stream, so the watcher scans the rolling tail for this phrase.
pub fn rate_limit_re() -> &'static Regex {
    static RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"Request rejected \(429\)").expect("the rate-limit pattern is a valid regex")
    })
}

/// `USAGE_LIMIT_RE` (`tasks.mjs`): Claude's plan-limit phrase.
pub fn usage_limit_re() -> &'static Regex {
    static RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"reached your session usage limit")
            .expect("the usage-limit pattern is a valid regex")
    })
}

/// `classifyLimit(tail)` (`tasks.mjs`): the plan-limit phrase wins, since
/// Claude's usage-limit error arrives as a 429 carrying it.
pub fn classify_limit(tail: &str) -> Option<&'static str> {
    if usage_limit_re().is_match(tail) {
        Some("usage-limited")
    } else if rate_limit_re().is_match(tail) {
        Some("rate-limited")
    } else {
        None
    }
}

/// `stripAnsi(s)` (`tasks.mjs`): drop escape sequences (CSI, OSC, other ESC
/// forms) and C0 controls except `\t` `\n` `\r`, so limit phrases match the
/// visible text of a TUI repaint.
pub fn strip_ansi(value: &str) -> String {
    static RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[ -/]*[0-~])|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]",
        )
        .expect("the ANSI pattern is a valid regex")
    })
    .replace_all(value, "")
    .into_owned()
}

/// `parseLimitResetAt(tail, now)` (`tasks.mjs`): best-effort epoch ms of the
/// reset named in the tail ("resets 3pm", "reset at 3:30pm (Europe/Zurich)",
/// "resets 15:00"), the next such wall-clock time after `now_ms` in the named
/// zone or the host zone. Unparsable -> `None`.
pub fn parse_limit_reset_at(tail: &str, now_ms: i64) -> Option<i64> {
    static RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    let re = RE.get_or_init(|| {
        Regex::new(r"(?i)\bresets?(?:\s+at)?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*\(([^)]+)\))?")
            .expect("the reset pattern is a valid regex")
    });
    let caps = re.captures(tail)?;
    let minute_raw = caps.get(2);
    let meridiem = caps.get(3).map(|m| m.as_str().to_ascii_lowercase());
    if minute_raw.is_none() && meridiem.is_none() {
        return None;
    }
    let mut hour: i8 = caps[1].parse().ok()?;
    let minute: i8 = minute_raw.map_or(Some(0), |m| m.as_str().parse().ok())?;
    if minute > 59 {
        return None;
    }
    match meridiem.as_deref() {
        Some(meridiem) => {
            if !(1..=12).contains(&hour) {
                return None;
            }
            hour = hour % 12 + if meridiem == "pm" { 12 } else { 0 };
        }
        None if hour > 23 => return None,
        None => {}
    }
    let tz = match caps.get(4).map(|m| m.as_str().trim()) {
        Some(name) if !name.is_empty() => jiff::tz::TimeZone::get(name).ok()?,
        _ => jiff::tz::TimeZone::system(),
    };
    let now = jiff::Timestamp::from_millisecond(now_ms).ok()?;
    let mut date = tz.to_datetime(now).date();
    for _ in 0..2 {
        let at = tz
            .to_ambiguous_timestamp(date.at(hour, minute, 0, 0))
            .compatible()
            .ok()?
            .as_millisecond();
        if at > now_ms {
            return Some(at);
        }
        date = date.tomorrow().ok()?;
    }
    None
}

/// `normalizeTags(tags)` (`tasks.mjs:376-378`): trim, lowercase, drop blanks,
/// dedupe, preserve order. A truthy non-array reproduces Node's thrown
/// `TypeError` message as an HTTP 400 (`tags.map is not a function`).
pub fn normalize_tags(tags: Option<&Value>) -> Result<Vec<String>, TaskError> {
    let Some(tags) = tags else {
        return Ok(Vec::new());
    };
    if !js_truthy(Some(tags)) {
        return Ok(Vec::new());
    }
    let Some(items) = tags.as_array() else {
        return Err(TaskError::bad("tags.map is not a function"));
    };
    let mut out: Vec<String> = Vec::new();
    for item in items {
        let tag = js_string(item).trim().to_lowercase();
        if !tag.is_empty() && !out.contains(&tag) {
            out.push(tag);
        }
    }
    Ok(out)
}

// VERIFY: wave3-tasks-2
/// `posInt(v)` (`tasks.mjs:428`): `Math.trunc(Number(v))` kept only when finite
/// and `> 0`, else `null`. `Number()` accepts hex/binary/octal strings and
/// one-element arrays, so this goes through [`js_number`] rather than
/// `str::parse` (which rejects those and accepts `inf`/`nan`, unlike JS).
pub fn pos_int(value: Option<&Value>) -> Option<i64> {
    let number = js_number(value).trunc();
    (number.is_finite() && number > 0.0).then(|| number as i64)
}

/// JS `Number(v)` (ToNumber). Arrays go through ToPrimitive → `join(',')`, so
/// `[5]` is 5 while `[true]` is NaN; objects are NaN.
fn js_number(value: Option<&Value>) -> f64 {
    match value {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(flag)) => {
            if *flag {
                1.0
            } else {
                0.0
            }
        }
        Some(Value::Number(number)) => number.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(text)) => js_number_from_string(text),
        Some(Value::Array(items)) => js_number_from_string(&js_array_to_string(items)),
        Some(Value::Object(_)) => f64::NAN,
    }
}

/// `Array.prototype.toString` element rendering: null/undefined join as empty,
/// including inside a nested array (`String([[1, null]])` is `"1,"`).
// VERIFY: wave5-task-reg-9
fn js_array_to_string(items: &[Value]) -> String {
    items
        .iter()
        .map(|item| match item {
            Value::Null => String::new(),
            Value::Array(nested) => js_array_to_string(nested),
            other => js_string(other),
        })
        .collect::<Vec<_>>()
        .join(",")
}

/// JS decimal literal grammar (no hex here; no `inf`/`nan`, which Rust's
/// `f64::from_str` would accept but `Number()` rejects).
fn js_decimal_re() -> &'static Regex {
    static RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$")
            .expect("the JS number pattern is a valid regex")
    })
}

fn js_number_from_string(text: &str) -> f64 {
    let text = text.trim();
    if text.is_empty() {
        return 0.0;
    }
    if let Some(digits) = text.strip_prefix("0x").or_else(|| text.strip_prefix("0X")) {
        return js_radix_float(digits, 16);
    }
    if let Some(digits) = text.strip_prefix("0b").or_else(|| text.strip_prefix("0B")) {
        return js_radix_float(digits, 2);
    }
    if let Some(digits) = text.strip_prefix("0o").or_else(|| text.strip_prefix("0O")) {
        return js_radix_float(digits, 8);
    }
    match text {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    if js_decimal_re().is_match(text) {
        text.parse::<f64>().unwrap_or(f64::NAN)
    } else {
        f64::NAN
    }
}

/// `Number("0x..")`-style conversion: every character must be a valid digit.
fn js_radix_float(digits: &str, radix: u32) -> f64 {
    if digits.is_empty() {
        return f64::NAN;
    }
    let mut value = 0.0;
    for character in digits.chars() {
        match character.to_digit(radix) {
            Some(digit) => value = value * f64::from(radix) + f64::from(digit),
            None => return f64::NAN,
        }
    }
    value
}

fn js_truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(value)) => *value,
        Some(Value::Number(value)) => value.as_f64().unwrap_or(0.0) != 0.0,
        Some(Value::String(value)) => !value.is_empty(),
        Some(Value::Array(_)) | Some(Value::Object(_)) => true,
    }
}

/// `String(v)` for the free-text fields a caller may send as any JSON type.
fn js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".to_owned(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => number.to_string(),
        Value::String(text) => text.clone(),
        // `Array.prototype.toString` is `join(',')`: recursive, null joins empty.
        // VERIFY: wave5-task-reg-9
        Value::Array(items) => js_array_to_string(items),
        Value::Object(_) => "[object Object]".to_owned(),
    }
}

fn clipped(value: &str, limit: usize) -> String {
    value.chars().take(limit).collect()
}

fn opt_trimmed(body: &Value, key: &str) -> Option<String> {
    body.get(key)
        .map(|value| clipped(js_string(value).trim(), 120))
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

// VERIFY: wave3-tasks-1
/// The one error type the board raises. `persist_failure` distinguishes a real
/// `tasks.json` write failure (HTTP 500) from a validation/domain error (400),
/// exactly like the `persistFailure` flag (`tasks.mjs:88`). `status_code` is
/// Node's `e.statusCode`, which `errStatus` checks *before* `persistFailure`
/// (`index.mjs:253`); no task-domain error sets it today.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TaskError {
    pub message: String,
    pub persist_failure: bool,
    pub status_code: Option<u16>,
}

impl TaskError {
    pub fn bad(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            persist_failure: false,
            status_code: None,
        }
    }

    pub fn persist(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            persist_failure: true,
            status_code: None,
        }
    }
}

impl std::fmt::Display for TaskError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for TaskError {}

/// Every git/fs seam yields a `String`; a raw seam failure is a domain error.
impl From<String> for TaskError {
    fn from(message: String) -> Self {
        Self::bad(message)
    }
}

/// Injected structured logger. Node logs through the Fastify logger with field
/// objects; the message text is what the daemon's own log line carries here.
pub type Logger = Arc<dyn Fn(&str) + Send + Sync>;

// VERIFY: wave3-tasks-3
/// One board card (`tasks.mjs:452-462`). Field order matches the Node object
/// literal so the persisted JSON and the WS payload stay key-compatible;
/// `model`/`implModel`/`reviewerModel`/`scopes` are omitted when absent while
/// `worktree`/`branch`/`baseBranch`/`sessionId`/`mergeMode` are always present
/// (`mergeMode` is an explicit `null` for a plain task, `tasks.mjs:460`). A loaded
/// record that never carried `sessionId`/`mergeMode` stays without them: Node's
/// spread leaves them `undefined`, which `JSON.stringify` omits.
///
/// Node's records are untyped and every mutation spreads the loaded object, so
/// a value this typed view cannot hold (an older/newer schema, a hand edit like
/// `"tags": "backend"`) must still survive a rewrite. [`Task::residual`] keeps
/// those raw entries and the manual [`Serialize`] re-emits them verbatim.
#[derive(Clone, Debug, PartialEq)]
pub struct Task {
    pub id: String,
    pub title: String,
    pub description: String,
    pub repo: String,
    pub kind: TaskKind,
    pub worktree: Option<String>,
    pub branch: Option<String>,
    pub base_branch: Option<String>,
    pub ticket_dir: String,
    pub report_dir: String,
    pub model: Option<String>,
    pub impl_model: Option<String>,
    pub reviewer_model: Option<String>,
    pub orchestrator_max_turns: Option<i64>,
    pub impl_max_turns: Option<i64>,
    pub reviewer_max_turns: Option<i64>,
    pub scopes: Option<Value>,
    pub tags: Vec<String>,
    pub require_plan_approval: bool,
    pub merge_mode: Option<MergeMode>,
    pub column: String,
    pub state: String,
    pub transitions: Vec<Transition>,
    pub session_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub conclude: Option<String>,
    pub background_job_id: Option<String>,
    pub background_run_id: Option<String>,
    pub tool: Option<String>,
    pub done_at: Option<i64>,
    /// The state a limit overlay covers, restored when it clears.
    pub limit_prev_state: Option<String>,
    /// Parsed usage-limit reset (epoch ms); `None` when unknown.
    pub limit_reset_at: Option<i64>,
    /// Raw values loaded from disk that the typed fields above could not
    /// represent (unknown keys or a value of the wrong shape). Re-emitted on
    /// serialize, after the typed fields, so a rewrite never drops them.
    residual: serde_json::Map<String, Value>,
    /// Keys a loaded record did not carry at all. Node's spread keeps them
    /// `undefined`, so `JSON.stringify` omits them on the next rewrite even though
    /// `createTask` always writes them (`tasks.mjs:456-461`).
    // VERIFY: wave5-task-reg-10
    absent_keys: Vec<String>,
}

impl Default for Task {
    fn default() -> Self {
        Self {
            id: String::new(),
            title: String::new(),
            description: String::new(),
            repo: String::new(),
            kind: TaskKind::Plain,
            worktree: None,
            branch: None,
            base_branch: None,
            ticket_dir: String::new(),
            report_dir: String::new(),
            model: None,
            impl_model: None,
            reviewer_model: None,
            orchestrator_max_turns: None,
            impl_max_turns: None,
            reviewer_max_turns: None,
            scopes: None,
            tags: Vec::new(),
            require_plan_approval: false,
            merge_mode: None,
            column: "todo".to_owned(),
            state: "analyzing".to_owned(),
            transitions: Vec::new(),
            session_id: None,
            created_at: 0,
            updated_at: 0,
            conclude: None,
            background_job_id: None,
            background_run_id: None,
            tool: None,
            done_at: None,
            limit_prev_state: None,
            limit_reset_at: None,
            residual: serde_json::Map::new(),
            absent_keys: Vec::new(),
        }
    }
}

/// Node's `initTasks` keeps every parseable record; only a non-object element
/// is unreadable (`tasks.mjs:147` spreads whatever it gets). Everything else
/// maps onto the typed view, with unrepresentable values parked in
/// [`Task::residual`].
fn task_from_record(mut record: serde_json::Map<String, Value>) -> Task {
    let mut task = Task::default();
    // A key the file never carried stays `undefined` in Node and is omitted by the
    // next rewrite; `mergeMode`/`sessionId` are the two the typed view would
    // otherwise re-add as an explicit `null`.
    // VERIFY: wave5-task-reg-10
    task.absent_keys = ["mergeMode", "sessionId"]
        .into_iter()
        .filter(|key| !record.contains_key(*key))
        .map(str::to_owned)
        .collect();
    let mut residual = serde_json::Map::new();
    macro_rules! take {
        ($key:literal, $field:ident) => {
            if let Some(raw) = record.remove($key) {
                match serde_json::from_value(raw.clone()) {
                    Ok(value) => task.$field = value,
                    Err(_) => {
                        residual.insert($key.to_owned(), raw);
                    }
                }
            }
        };
    }
    take!("id", id);
    take!("title", title);
    take!("description", description);
    take!("repo", repo);
    take!("kind", kind);
    take!("worktree", worktree);
    take!("branch", branch);
    take!("baseBranch", base_branch);
    take!("ticketDir", ticket_dir);
    take!("reportDir", report_dir);
    take!("model", model);
    take!("implModel", impl_model);
    take!("reviewerModel", reviewer_model);
    take!("orchestratorMaxTurns", orchestrator_max_turns);
    take!("implMaxTurns", impl_max_turns);
    take!("reviewerMaxTurns", reviewer_max_turns);
    take!("scopes", scopes);
    take!("tags", tags);
    take!("requirePlanApproval", require_plan_approval);
    take!("mergeMode", merge_mode);
    take!("column", column);
    take!("state", state);
    take!("transitions", transitions);
    take!("sessionId", session_id);
    take!("createdAt", created_at);
    take!("updatedAt", updated_at);
    take!("conclude", conclude);
    take!("backgroundJobId", background_job_id);
    take!("backgroundRunId", background_run_id);
    take!("tool", tool);
    take!("doneAt", done_at);
    take!("limitPrevState", limit_prev_state);
    take!("limitResetAt", limit_reset_at);
    for (key, value) in record {
        residual.insert(key, value);
    }
    task.residual = residual;
    task
}

impl<'de> Deserialize<'de> for Task {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        match Value::deserialize(deserializer)? {
            Value::Object(record) => Ok(task_from_record(record)),
            other => Err(serde::de::Error::custom(format!(
                "task record is not an object: {other}"
            ))),
        }
    }
}

// VERIFY: wave3-tasks-4
impl Serialize for Task {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        let mut map = serializer.serialize_map(None)?;
        // A residual entry shadows its typed field: the raw value is the one
        // the record actually carries (and the one a rewrite must keep).
        let shadowed = |key: &str| self.residual.contains_key(key);
        macro_rules! entry {
            ($key:literal, $value:expr) => {
                if !shadowed($key) {
                    map.serialize_entry($key, &$value)?;
                }
            };
        }
        macro_rules! optional {
            ($key:literal, $value:expr) => {
                if !shadowed($key) {
                    if let Some(value) = &$value {
                        map.serialize_entry($key, value)?;
                    }
                }
            };
        }
        // `mergeMode`/`sessionId` are written by `createTask` but a legacy record
        // that never carried them keeps them `undefined`, so a rewrite omits them
        // (`tasks.mjs:140,456-461`). A value assigned after the load is emitted.
        // VERIFY: wave5-task-reg-10
        let absent = |key: &str| self.absent_keys.iter().any(|absent| absent == key);
        macro_rules! always {
            ($key:literal, $value:expr) => {
                if !shadowed($key) && ($value.is_some() || !absent($key)) {
                    map.serialize_entry($key, &$value)?;
                }
            };
        }
        entry!("id", self.id);
        entry!("title", self.title);
        entry!("description", self.description);
        entry!("repo", self.repo);
        entry!("kind", self.kind);
        entry!("worktree", self.worktree);
        entry!("branch", self.branch);
        entry!("baseBranch", self.base_branch);
        entry!("ticketDir", self.ticket_dir);
        entry!("reportDir", self.report_dir);
        optional!("model", self.model);
        optional!("implModel", self.impl_model);
        optional!("reviewerModel", self.reviewer_model);
        entry!("orchestratorMaxTurns", self.orchestrator_max_turns);
        entry!("implMaxTurns", self.impl_max_turns);
        entry!("reviewerMaxTurns", self.reviewer_max_turns);
        optional!("scopes", self.scopes);
        entry!("tags", self.tags);
        entry!("requirePlanApproval", self.require_plan_approval);
        always!("mergeMode", self.merge_mode);
        entry!("column", self.column);
        entry!("state", self.state);
        entry!("transitions", self.transitions);
        always!("sessionId", self.session_id);
        entry!("createdAt", self.created_at);
        entry!("updatedAt", self.updated_at);
        optional!("conclude", self.conclude);
        optional!("backgroundJobId", self.background_job_id);
        optional!("backgroundRunId", self.background_run_id);
        optional!("tool", self.tool);
        optional!("doneAt", self.done_at);
        optional!("limitPrevState", self.limit_prev_state);
        optional!("limitResetAt", self.limit_reset_at);
        for (key, value) in &self.residual {
            map.serialize_entry(key, value)?;
        }
        map.end()
    }
}

/// `kind`: `git` when `rev-parse --is-inside-work-tree` is `true`
/// (`tasks.mjs:429`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TaskKind {
    Git,
    #[default]
    Plain,
}

/// `mergeMode` (`tasks.mjs:456`): anything that is not `'auto'` is `'manual'`;
/// plain tasks store `null`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MergeMode {
    Auto,
    Manual,
}

// VERIFY: wave3-tasks-5
/// One durable column move (`tasks.mjs:519-524`). Optional fields are omitted
/// when the request did not carry them; each is trimmed and capped at 120.
/// `extra` keeps unknown keys so a record written by a newer schema round-trips
/// (Node spreads the transition object unchanged).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Transition {
    pub from: String,
    pub to: String,
    pub at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actor: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, Value>,
}

// VERIFY: tasks-spawner-port
/// The registry operations the board performs. Only existing [`Registry`] APIs
/// are wrapped — nothing here reaches into cron or background modules.
pub trait Spawner: Send + Sync {
    fn create(&self, input: CreateAgent) -> Result<AgentWire, String>;
    fn is_live(&self, id: &str) -> bool;
    fn kill(&self, id: &str) -> Result<(), String>;
    fn remove(&self, id: &str) -> Result<(), String>;
    /// `getActiveMs(id)` — the `busyMs` `statsFor` splices into every entry
    /// (`stats.mjs:325-326`).
    fn active_ms(&self, id: &str) -> i64;
}

impl Spawner for Registry {
    fn create(&self, input: CreateAgent) -> Result<AgentWire, String> {
        Registry::create(self, input)
    }

    fn is_live(&self, id: &str) -> bool {
        Registry::is_live(self, id)
    }

    fn kill(&self, id: &str) -> Result<(), String> {
        Registry::kill(self, id)
    }

    fn remove(&self, id: &str) -> Result<(), String> {
        Registry::remove(self, id)
    }

    fn active_ms(&self, id: &str) -> i64 {
        Registry::active_ms(self, id)
    }
}

// VERIFY: tasks-stats-port
/// `statsFor([{id, cwd}])[id]` (`stats.mjs:321-328`) for `concludeTask`'s
/// `finalStats`. The daemon injects [`NativeStats`]; tests inject a fake.
pub trait StatsPort: Send + Sync {
    fn session_stats(&self, session_id: &str, cwd: &str) -> Option<Value>;
}

/// Production [`StatsPort`] over the shared [`crate::stats::StatsService`].
pub struct NativeStats {
    pub claude_home: PathBuf,
    pub codex_home: PathBuf,
    pub usage_state: PathBuf,
    service: Mutex<crate::stats::StatsService>,
}

impl NativeStats {
    pub fn new(claude_home: PathBuf, codex_home: PathBuf, usage_state: PathBuf) -> Self {
        Self {
            claude_home,
            codex_home,
            usage_state,
            service: Mutex::new(crate::stats::StatsService::default()),
        }
    }
}

impl StatsPort for NativeStats {
    fn session_stats(&self, session_id: &str, cwd: &str) -> Option<Value> {
        let request = crate::stats::StatsRequest {
            stats_claude_home: Some(path_string(&self.claude_home)),
            stats_codex_home: Some(path_string(&self.codex_home)),
            stats_usage_state: Some(path_string(&self.usage_state)),
            stats_agents: Some(vec![crate::stats::StatsAgent {
                id: session_id.to_owned(),
                cwd: cwd.to_owned(),
                tool: None,
            }]),
            ..Default::default()
        };
        let mut service = self
            .service
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let crate::transcript_bridge::ResponseBody::Raw(raw) =
            service.dispatch("agent_stats", &request)
        else {
            return None;
        };
        let value: Value = serde_json::from_str(raw.get()).ok()?;
        value.get(session_id).cloned()
    }
}

// VERIFY: tasks-config
/// Everything ambient the board needs, injected instead of read from
/// `process.env` at module load (design D2).
pub struct TasksConfig {
    /// `STATE_DIR/tasks.json`.
    pub tasks_file: PathBuf,
    /// `WORKTREES_DIR`.
    pub worktrees_dir: PathBuf,
    /// `TICKETS_DIR`.
    pub tickets_dir: PathBuf,
    /// `REPORTS_DIR`.
    pub reports_dir: PathBuf,
    /// `STATE_DIR/models.json` for `getModelRoute`.
    pub models_state: PathBuf,
    /// `DAEMON_PORT`; `None` renders `NaN` in prompts like Node.
    pub daemon_port: Option<u16>,
    /// `""` or ` -H "x-sing-token: $SING_TOKEN"`.
    pub token_header: String,
    /// `SING_CAVECREW === '1'`.
    pub cavecrew: bool,
    pub retention_ms: i64,
    pub sweep_interval: Duration,
}

impl TasksConfig {
    /// The `server/app-dir.mjs`-derived defaults; the host fills the three
    /// environment-derived fields.
    pub fn for_paths(paths: &crate::app_paths::AppPaths) -> Self {
        Self {
            tasks_file: paths.state_dir.join("tasks.json"),
            worktrees_dir: paths.worktrees_dir.clone(),
            tickets_dir: paths.tickets_dir.clone(),
            reports_dir: paths.reports_dir.clone(),
            models_state: paths.state_dir.join("models.json"),
            daemon_port: None,
            token_header: String::new(),
            cavecrew: false,
            retention_ms: RETENTION_MS,
            sweep_interval: SWEEP_INTERVAL,
        }
    }

    /// `Number(process.env.DAEMON_PORT)` rendered by a JS template.
    pub fn port_text(&self) -> String {
        self.daemon_port
            .map_or_else(|| "NaN".to_owned(), |port| port.to_string())
    }
}

// VERIFY: tasks-snapshots
/// The `tasks` WS snapshot seam. The WS layer depends on this trait rather
/// than the concrete service so it cannot mutate the board (design D1).
pub trait TaskSnapshots: Send + Sync {
    fn snapshot(&self) -> Value;
}

#[derive(Default)]
struct State {
    /// Insertion-ordered like the Node `Map`.
    tasks: Vec<Task>,
    /// Concluded cards (task fields + `outcome`, `concludedAt`, `finalStats`).
    history: Vec<Value>,
    /// `sessionId -> taskId`, so the output listener is O(1).
    task_by_session: HashMap<String, String>,
    /// Rolling output tail per session for rate-limit detection.
    tails: HashMap<String, String>,
}

impl State {
    fn find(&self, id: &str) -> Option<&Task> {
        self.tasks.iter().find(|task| task.id == id)
    }

    fn replace(&mut self, task: Task) {
        match self.tasks.iter_mut().find(|current| current.id == task.id) {
            Some(slot) => *slot = task,
            None => self.tasks.push(task),
        }
    }

    fn remove(&mut self, id: &str) -> Option<Task> {
        let index = self.tasks.iter().position(|task| task.id == id)?;
        Some(self.tasks.remove(index))
    }
}

#[derive(Serialize)]
struct Document<'a> {
    tasks: &'a [Task],
    history: &'a [Value],
}

/// What [`TaskService::start_background`] spawned, so shutdown can undo it.
#[derive(Default)]
struct BackgroundLoops {
    handles: Vec<tokio::task::JoinHandle<()>>,
    subscription: Option<u64>,
}

// VERIFY: tasks-service
/// The board. One instance per daemon; all mutation is serialized.
pub struct TaskService {
    bus: Bus,
    spawner: Arc<dyn Spawner>,
    git: Arc<dyn GitPort>,
    stats: Arc<dyn StatsPort>,
    config: TasksConfig,
    clock: Clock,
    logger: Logger,
    state: Mutex<State>,
    mutation: tokio::sync::Mutex<()>,
    stop: watch::Sender<bool>,
    /// VERIFY: wave3-hostreview-6
    /// The retention loop, the rate-limit loop and the `output` subscription
    /// they own, so [`TaskService::shutdown`] can abort and unsubscribe
    /// outright instead of relying on the loops noticing the watch.
    background: Mutex<BackgroundLoops>,
    /// Wakes the limit reset timer loop to re-read the earliest
    /// `limitResetAt` after a task record changes.
    limit_timer: tokio::sync::Notify,
    /// Set by [`TaskService::load`] when `tasks.json` held content this build
    /// could not turn into task records. Every later persist refuses to run so
    /// the unreadable data is never overwritten (Node would clobber it).
    load_blocked: Mutex<Option<String>>,
}

impl TaskService {
    pub fn new(
        bus: Bus,
        spawner: Arc<dyn Spawner>,
        git: Arc<dyn GitPort>,
        stats: Arc<dyn StatsPort>,
        config: TasksConfig,
        clock: Clock,
        logger: Logger,
    ) -> Arc<Self> {
        let (stop, _) = watch::channel(false);
        Arc::new(Self {
            bus,
            spawner,
            git,
            stats,
            config,
            clock,
            logger,
            state: Mutex::new(State::default()),
            mutation: tokio::sync::Mutex::new(()),
            stop,
            background: Mutex::new(BackgroundLoops::default()),
            limit_timer: tokio::sync::Notify::new(),
            load_blocked: Mutex::new(None),
        })
    }

    fn log(&self, message: &str) {
        (self.logger)(message);
    }

    fn tasks(&self) -> Vec<Task> {
        self.state.lock().unwrap().tasks.clone()
    }

    // VERIFY: tasks-snapshot
    /// `snapshotTasks()` (`tasks.mjs:176`): `{ tasks, history }`, both arrays.
    pub fn snapshot(&self) -> Value {
        let state = self.state.lock().unwrap();
        serde_json::to_value(Document {
            tasks: &state.tasks,
            history: &state.history,
        })
        .unwrap_or_else(|_| json!({ "tasks": [], "history": [] }))
    }

    // VERIFY: wave3-tasks-6
    /// `initTasks(log)` (`tasks.mjs:134-174`) minus the timer/listener, which
    /// live in [`TaskService::start_background`].
    ///
    /// Records load leniently: a value the typed view cannot hold is parked in
    /// [`Task::residual`] instead of dropping the card (Node keeps every
    /// record). Only content that is not a task record at all (invalid JSON, a
    /// non-array `tasks`/`history`, or a non-object element) makes the load
    /// incomplete; [`TaskService::persist`] then refuses to overwrite the file.
    ///
    /// Recovery is awaited here instead of fired and forgotten so `load`
    /// resolves once the board is consistent. Deliberate deviation: Node queues
    /// the same work on the mutation chain and keeps serving, while this
    /// serializes it. Each recovered Done card can cost a ≤3 s pty-death wait
    /// plus a git timeout (default 10 s) plus a 1 s worktree-remove retry, so a
    /// crash leaving N Done cards can delay readiness by roughly 14 s × N.
    pub async fn load(self: &Arc<Self>) {
        let mut tasks: Vec<Task> = Vec::new();
        let mut history: Vec<Value> = Vec::new();
        let mut incomplete: Option<String> = None;
        if self.config.tasks_file.exists() {
            match std::fs::read_to_string(&self.config.tasks_file) {
                Ok(text) => match serde_json::from_str::<Value>(&text) {
                    Ok(document) => {
                        match document.get("tasks") {
                            Some(Value::Array(items)) => {
                                for item in items {
                                    match serde_json::from_value::<Task>(item.clone()) {
                                        Ok(task) => tasks.push(task),
                                        Err(error) => {
                                            self.log(&format!("tasks.json load failed: {error}"));
                                            incomplete.get_or_insert_with(|| error.to_string());
                                        }
                                    }
                                }
                            }
                            Some(Value::Null) | None => {}
                            Some(_) => {
                                incomplete = Some("tasks is not an array".to_owned());
                            }
                        }
                        match document.get("history") {
                            Some(Value::Array(items)) => {
                                history =
                                    items.iter().cloned().map(normalize_history_entry).collect();
                            }
                            Some(Value::Null) | None => {}
                            Some(_) => {
                                incomplete = Some("history is not an array".to_owned());
                            }
                        }
                        self.log(&format!(
                            "loaded tasks.json (tasks={}, history={})",
                            tasks.len(),
                            history.len()
                        ));
                    }
                    Err(error) => {
                        self.log(&format!("tasks.json load failed: {error}"));
                        incomplete = Some(error.to_string());
                    }
                },
                Err(error) => {
                    self.log(&format!("tasks.json load failed: {error}"));
                    incomplete = Some(error.to_string());
                }
            }
        }
        if let Some(reason) = &incomplete {
            self.log(&format!(
                "tasks.json not fully readable ({reason}) — refusing to overwrite it"
            ));
        }
        *self.load_blocked.lock().unwrap() = incomplete;
        let task_by_session = tasks
            .iter()
            .filter_map(|task| {
                task.session_id
                    .clone()
                    .map(|session| (session, task.id.clone()))
            })
            .collect();
        {
            let mut state = self.state.lock().unwrap();
            state.tasks = tasks;
            state.history = history;
            state.task_by_session = task_by_session;
        }
        self.limit_timer.notify_one(); // persisted usage limits arm the reset timer
        self.scan_orphan_worktrees();
        for task in self.tasks() {
            if task.column == "done" {
                let _guard = self.mutation.lock().await;
                // Node catches these in the recovery chain (`.catch(log)`).
                if let Err(error) = self.finish_done_task(&task).await {
                    self.log(&format!(
                        "done-task recovery failed for {}: {}",
                        task.id, error.message
                    ));
                }
            } else if task.kind == TaskKind::Git
                && !task
                    .worktree
                    .as_deref()
                    .is_some_and(|worktree| Path::new(worktree).exists())
            {
                let _guard = self.mutation.lock().await;
                if let Err(error) = self.ensure_worktree(&task).await {
                    self.log(&format!(
                        "worktree recovery failed for {}: {}",
                        task.id, error.message
                    ));
                }
            }
        }
        self.sweep_retention().await;
    }

    // VERIFY: tasks-orphan-scan
    /// Log-only orphan scan (`tasks.mjs:147-154`): a worktree directory no task
    /// references is warned about, never deleted.
    fn scan_orphan_worktrees(&self) {
        let Ok(entries) = crate::fs_sorted::read_dir(&self.config.worktrees_dir) else {
            return;
        };
        let referenced: HashSet<PathBuf> = self
            .tasks()
            .iter()
            .filter_map(|task| task.worktree.as_ref().map(PathBuf::from))
            .collect();
        for entry in entries.flatten() {
            let is_directory = entry
                .file_type()
                .map(|file_type| file_type.is_dir())
                .unwrap_or(false);
            if !is_directory {
                continue;
            }
            let full = entry.path();
            if !referenced.contains(&full) {
                self.log(&format!(
                    "orphaned worktree dir — no task references it: {}",
                    full.to_string_lossy()
                ));
            }
        }
    }

    // VERIFY: tasks-start-background
    /// The `.unref()`'d retention interval and the `output` bus listener
    /// (`tasks.mjs:162-173`). Both tasks exit on the host shutdown watch and on
    /// [`TaskService::shutdown`].
    pub fn start_background(
        self: &Arc<Self>,
        handle: &tokio::runtime::Handle,
        shutdown: watch::Receiver<bool>,
    ) {
        if self.background.lock().unwrap().subscription.is_some() {
            // Entered `serve` twice in one process: one loop pair only, so the
            // `output` listener is never subscribed twice.
            return;
        }
        let retention = {
            let service = self.clone();
            let mut host = shutdown.clone();
            let mut own = self.stop.subscribe();
            handle.spawn(async move {
                let mut ticker = tokio::time::interval(service.config.sweep_interval);
                ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
                loop {
                    tokio::select! {
                        _ = ticker.tick() => service.sweep_retention().await,
                        changed = host.changed() => {
                            if changed.is_err() || *host.borrow() { break }
                        }
                        changed = own.changed() => {
                            if changed.is_err() || *own.borrow() { break }
                        }
                    }
                }
            })
        };
        // Clears each usage limit at its `limitResetAt` (persisted ones too):
        // sleeps until the earliest reset, re-reading it whenever a record
        // changes. Re-checks at least daily so a far reset never overflows.
        let timer = {
            let service = self.clone();
            let mut host = shutdown.clone();
            let mut own = self.stop.subscribe();
            handle.spawn(async move {
                let mut retry = false;
                loop {
                    let wait = service.limit_wait(retry);
                    tokio::select! {
                        _ = tokio::time::sleep(wait.unwrap_or_default()), if wait.is_some() => {
                            retry = !service.clear_due_limits().await;
                        }
                        _ = service.limit_timer.notified() => { retry = false; }
                        changed = host.changed() => {
                            if changed.is_err() || *host.borrow() { break }
                        }
                        changed = own.changed() => {
                            if changed.is_err() || *own.borrow() { break }
                        }
                    }
                }
            })
        };
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<LimitEvent>();
        let subscription = self.bus.subscribe(self.output_listener(tx));
        let service = self.clone();
        let mut host = shutdown;
        let mut own = self.stop.subscribe();
        let output = handle.spawn(async move {
            loop {
                tokio::select! {
                    Some(event) = rx.recv() => {
                        let (id, result) = match event {
                            LimitEvent::Enter { id, kind, reset_at } => {
                                let result = service.enter_limit(&id, kind, reset_at).await;
                                (id, result)
                            }
                            LimitEvent::Clear { id } => {
                                let result = service.clear_limit(&id).await;
                                (id, result)
                            }
                        };
                        if let Err(error) = result {
                            service.log(&format!("rate-limit update failed for {id}: {}", error.message));
                        }
                    }
                    changed = host.changed() => {
                        if changed.is_err() || *host.borrow() { break }
                    }
                    changed = own.changed() => {
                        if changed.is_err() || *own.borrow() { break }
                    }
                }
            }
            service.bus.unsubscribe(subscription);
        });
        let mut background = self.background.lock().unwrap();
        background.handles = vec![retention, timer, output];
        background.subscription = Some(subscription);
    }

    // VERIFY: wave6-task_weak-1
    /// The `output` and `input` bus listener (`tasks.mjs` `initTasks`):
    /// records each agent's rolling ANSI-stripped tail and hands the limit
    /// loop an enter event when the tail matches [`classify_limit`]. Output
    /// never clears (a TUI repaint proves nothing); input with visible content
    /// to a limited card drops its tail and hands the loop a clear event, so
    /// a limit that still holds re-flags when Claude reprints the phrase.
    ///
    /// Holds a `Weak`, like the crons status listener: the bus is reachable
    /// from the service (`self.bus`), so a strong capture would close the
    /// reference cycle `Bus → listener → TaskService → Bus` and nothing could
    /// release the board's state without first calling
    /// [`TaskService::shutdown`]. A failed upgrade means the host dropped the
    /// board, and an event with no board behind it has nothing to flag.
    fn output_listener(
        self: &Arc<Self>,
        tx: tokio::sync::mpsc::UnboundedSender<LimitEvent>,
    ) -> BusListener {
        let service = Arc::downgrade(self);
        let listener: BusListener = Arc::new(move |event: &BusEvent| {
            let (id, data, is_input) = match event {
                BusEvent::Output { id, data } => (id, data, false),
                BusEvent::Input { id, data } => (id, data, true),
                _ => return,
            };
            let Some(service) = service.upgrade() else {
                return;
            };
            let tid = {
                let state = service.state.lock().unwrap();
                state.task_by_session.get(id).cloned()
            };
            let Some(tid) = tid else {
                return;
            };
            let data = strip_ansi(data);
            if is_input {
                // Escape-only input (focus/mouse reports, arrow keys) is not
                // a resume.
                if data.is_empty() {
                    return;
                }
                service.state.lock().unwrap().tails.remove(id);
                let _ = tx.send(LimitEvent::Clear { id: tid });
                return;
            }
            let tail = {
                let mut state = service.state.lock().unwrap();
                let Some(task) = state.tasks.iter().find(|task| task.id == tid) else {
                    return;
                };
                if task.column == "done" {
                    return;
                }
                let combined = format!(
                    "{}{}",
                    state.tails.get(id).cloned().unwrap_or_default(),
                    data
                );
                let chars: Vec<char> = combined.chars().collect();
                let start = chars.len().saturating_sub(RATE_LIMIT_TAIL_CHARS);
                let tail: String = chars[start..].iter().collect();
                state.tails.insert(id.clone(), tail.clone());
                tail
            };
            // Every classified chunk goes to the loop: it dedupes a settled
            // overlay, promotes a plain 429 that was really a usage limit, and
            // attaches a reset that arrives after the phrase.
            let Some(kind) = classify_limit(&tail) else {
                return;
            };
            let _ = tx.send(LimitEvent::Enter {
                id: tid,
                kind,
                reset_at: parse_limit_reset_at(&tail, (service.clock)()),
            });
        });
        listener
    }

    // VERIFY: wave3-hostreview-6
    /// Stops the background tasks started by [`TaskService::start_background`]:
    /// signals the watch, then aborts both loops and removes the `output`
    /// listener, so nothing can re-arm after the host shutdown broadcast.
    pub fn shutdown(&self) {
        let _ = self.stop.send(true);
        let mut background = self.background.lock().unwrap();
        if let Some(subscription) = background.subscription.take() {
            self.bus.unsubscribe(subscription);
        }
        for handle in background.handles.drain(..) {
            handle.abort();
        }
    }

    // VERIFY: wave3-tasks-7
    /// `persist()` (`tasks.mjs:82-91`): atomic 2-space JSON write; a failure
    /// logs and raises a [`TaskError`] flagged `persist_failure`.
    ///
    /// Safer deviation: if startup could not read all of `tasks.json`, every
    /// write is refused instead of clobbering the unreadable records (Node's
    /// `persist` would rewrite the file from the incomplete in-memory board).
    async fn persist(&self, tasks: &[Task], history: &[Value]) -> Result<(), TaskError> {
        if let Some(reason) = self.load_blocked.lock().unwrap().clone() {
            self.log(&format!(
                "tasks.json write refused — load was incomplete ({reason})"
            ));
            return Err(TaskError::persist(format!(
                "tasks.json not fully readable at startup ({reason}); refusing to overwrite it"
            )));
        }
        let bytes = serde_json::to_vec_pretty(&Document { tasks, history })
            .map_err(|error| TaskError::persist(format!("tasks.json write failed: {error}")))?;
        let file = self.config.tasks_file.clone();
        match tokio::task::spawn_blocking(move || write_atomic(&file, &bytes)).await {
            Ok(Ok(())) => Ok(()),
            Ok(Err(error)) => {
                self.log(&format!("tasks.json write failed: {error}"));
                Err(TaskError::persist(format!(
                    "tasks.json write failed: {error}"
                )))
            }
            Err(error) => Err(TaskError::persist(format!(
                "tasks.json write failed: {error}"
            ))),
        }
    }

    /// Persists `replacement` in place (or appended) without committing it to
    /// memory yet — the staged write `updateTaskInner` performs.
    async fn persist_staged(&self, replacement: &Task) -> Result<(), TaskError> {
        let (mut tasks, history) = {
            let state = self.state.lock().unwrap();
            (state.tasks.clone(), state.history.clone())
        };
        match tasks.iter_mut().find(|task| task.id == replacement.id) {
            Some(slot) => *slot = replacement.clone(),
            None => tasks.push(replacement.clone()),
        }
        self.persist(&tasks, &history).await
    }

    // VERIFY: tasks-emit
    fn emit(&self) {
        self.bus.emit(&BusEvent::Tasks(self.snapshot()));
    }

    // VERIFY: tasks-create
    /// `createTask({...})` (`tasks.mjs:424-483`).
    pub async fn create(self: &Arc<Self>, body: &Value) -> Result<Value, TaskError> {
        let _guard = self.mutation.lock().await;
        let repo = body
            .get("repo")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        let title = body
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_owned();
        let description = body
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_owned();
        if repo.is_empty() || title.is_empty() || description.is_empty() {
            return Err(TaskError::bad("repo, title and description required"));
        }
        let route = crate::models::route(
            self.config.models_state.to_string_lossy().as_ref(),
            body.get("model").unwrap_or(&Value::Null),
            body.get("tool").unwrap_or(&Value::Null),
        );
        if let Some(message) = route.get("toolModelError").and_then(Value::as_str) {
            return Err(TaskError::bad(message));
        }
        if !Path::new(&repo).exists() {
            return Err(TaskError::bad("working directory does not exist"));
        }
        let kind = {
            let git = self.git.clone();
            let repo = repo.clone();
            match tokio::task::spawn_blocking(move || {
                crate::task_git::is_git_work_tree(git.as_ref(), &repo)
            })
            .await
            {
                Ok(true) => TaskKind::Git,
                _ => TaskKind::Plain,
            }
        };
        let id = new_id();
        let short: String = id.chars().take(8).collect();
        let mut base_branch: Option<String> = None;
        let mut branch: Option<String> = None;
        let mut worktree: Option<String> = None;
        let mut cwd = repo.clone();
        if kind == TaskKind::Git {
            let git = self.git.clone();
            let repo_for_base = repo.clone();
            let base = tokio::task::spawn_blocking(move || {
                git.git(&repo_for_base, &["rev-parse", "--abbrev-ref", "HEAD"])
            })
            .await
            .map_err(join_error)??;
            let branch_name = format!("task/{short}");
            let worktree_text = path_string(&self.config.worktrees_dir.join(&short));
            std::fs::create_dir_all(&self.config.worktrees_dir)
                .map_err(|error| TaskError::bad(error.to_string()))?;
            let git = self.git.clone();
            let repo_for_add = repo.clone();
            let added_worktree = worktree_text.clone();
            let added_branch = branch_name.clone();
            tokio::task::spawn_blocking(move || {
                git.git(
                    &repo_for_add,
                    &["worktree", "add", &added_worktree, "-b", &added_branch],
                )
            })
            .await
            .map_err(join_error)??;
            base_branch = Some(base);
            branch = Some(branch_name);
            worktree = Some(worktree_text.clone());
            cwd = worktree_text;
        }
        let ticket_dir = self.config.tickets_dir.join(&short);
        let background = js_truthy(body.get("background"));
        let created: Result<Task, TaskError> = async {
            let ticket_text = path_string(&ticket_dir);
            let tickets = ticket_dir.clone();
            let title_write = title.clone();
            let description_write = description.clone();
            tokio::task::spawn_blocking(move || -> Result<(), String> {
                std::fs::create_dir_all(&tickets).map_err(|error| error.to_string())?;
                std::fs::write(
                    tickets.join("Requirements.md"),
                    format!("# {title_write}\n\n{description_write}\n"),
                )
                .map_err(|error| error.to_string())
            })
            .await
            .map_err(join_error)??;
            let mut report_dir = ticket_text.clone();
            if background {
                let reports = self.config.reports_dir.join(&short);
                std::fs::create_dir_all(&reports)
                    .map_err(|error| TaskError::bad(error.to_string()))?;
                report_dir = path_string(&reports);
            }
            let tool = body
                .get("tool")
                .filter(|value| js_truthy(Some(value)))
                .and_then(Value::as_str)
                .map(str::to_owned);
            let mut task = Task {
                id: id.clone(),
                title: title.clone(),
                description: description.clone(),
                repo: repo.clone(),
                kind,
                worktree: worktree.clone(),
                branch: branch.clone(),
                base_branch: base_branch.clone(),
                ticket_dir: ticket_text,
                report_dir,
                model: body.get("model").and_then(Value::as_str).map(str::to_owned),
                impl_model: body
                    .get("implModel")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                reviewer_model: body
                    .get("reviewerModel")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                orchestrator_max_turns: pos_int(body.get("orchestratorMaxTurns")),
                impl_max_turns: pos_int(body.get("implMaxTurns")),
                reviewer_max_turns: pos_int(body.get("reviewerMaxTurns")),
                scopes: body.get("scopes").cloned(),
                tags: normalize_tags(body.get("tags"))?,
                require_plan_approval: js_truthy(body.get("requirePlanApproval")),
                merge_mode: (kind == TaskKind::Git).then(|| {
                    if body.get("mergeMode").and_then(Value::as_str) == Some("auto") {
                        MergeMode::Auto
                    } else {
                        MergeMode::Manual
                    }
                }),
                column: "todo".to_owned(),
                state: "analyzing".to_owned(),
                transitions: Vec::new(),
                session_id: None,
                created_at: (self.clock)(),
                updated_at: (self.clock)(),
                conclude: background.then(|| {
                    if body.get("conclude").and_then(Value::as_str) == Some("done") {
                        "done".to_owned()
                    } else {
                        "inreview".to_owned()
                    }
                }),
                background_job_id: body
                    .get("backgroundJobId")
                    .filter(|value| js_truthy(Some(value)))
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                background_run_id: body
                    .get("backgroundRunId")
                    .filter(|value| js_truthy(Some(value)))
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                tool,
                done_at: None,
                limit_prev_state: None,
                limit_reset_at: None,
                residual: serde_json::Map::new(),
                absent_keys: Vec::new(),
            };
            let settings = body
                .get("permissionSettings")
                .filter(|value| js_truthy(Some(value)))
                .cloned()
                .unwrap_or_else(|| json!({}));
            let extra_args = vec![
                "--settings".to_owned(),
                serde_json::to_string(&settings).unwrap_or_else(|_| "{}".to_owned()),
            ];
            let mock = js_truthy(body.get("mock"));
            let prompt_override = body
                .get("promptOverride")
                .filter(|value| !value.is_null())
                .and_then(Value::as_str)
                .map(str::to_owned);
            let has_def = |role: &str| {
                Path::new(&cwd)
                    .join(".claude")
                    .join("agents")
                    .join(format!("{role}.md"))
                    .exists()
            };
            let port_text = self.config.port_text();
            let prompt = {
                let context = crate::task_prompts::PromptContext {
                    task: &task,
                    port: &port_text,
                    token_header: &self.config.token_header,
                    cavecrew: self.config.cavecrew,
                    cwd: &cwd,
                    has_def: &has_def,
                };
                if mock {
                    None
                } else if let Some(prompt) = prompt_override {
                    Some(prompt)
                } else if background {
                    Some(crate::task_prompts::build_background_prompt(
                        &context, &route,
                    ))
                } else {
                    Some(crate::task_prompts::build_task_prompt(&context, &route))
                }
            };
            let input = CreateAgent {
                cwd: Some(cwd.clone()),
                title: Some(task.title.clone()),
                model: task.model.clone(),
                scopes: task
                    .scopes
                    .as_ref()
                    .and_then(|scopes| serde_json::from_value::<Vec<String>>(scopes.clone()).ok()),
                prompt,
                permission_mode: Some("acceptEdits".to_owned()),
                extra_args: Some(extra_args),
                mock,
                tool: task.tool.clone(),
                ..CreateAgent::default()
            };
            let spawner = self.spawner.clone();
            let agent = tokio::task::spawn_blocking(move || spawner.create(input))
                .await
                .map_err(join_error)??;
            task.session_id = Some(agent.id.clone());
            {
                let mut state = self.state.lock().unwrap();
                state.task_by_session.insert(agent.id, task.id.clone());
                state.tasks.push(task.clone());
            }
            self.persist_staged(&task).await?;
            self.emit();
            Ok(task)
        }
        .await;
        match created {
            Ok(task) => Ok(serde_json::to_value(&task).unwrap_or(Value::Null)),
            Err(error) => {
                if kind == TaskKind::Git {
                    self.cleanup_failed_worktree(&repo, worktree.as_deref(), branch.as_deref())
                        .await;
                }
                Err(error)
            }
        }
    }

    /// The `createTask` catch block (`tasks.mjs:479-482`): best-effort worktree
    /// and branch removal after a failure past `worktree add`.
    async fn cleanup_failed_worktree(
        &self,
        repo: &str,
        worktree: Option<&str>,
        branch: Option<&str>,
    ) {
        let (Some(worktree), Some(branch)) = (worktree, branch) else {
            return;
        };
        let git = self.git.clone();
        let repo = repo.to_owned();
        let worktree = worktree.to_owned();
        let branch = branch.to_owned();
        let _ = tokio::task::spawn_blocking(move || {
            let _ = git.git(&repo, &["worktree", "remove", "--force", &worktree]);
            let _ = git.git(&repo, &["branch", "-D", &branch]);
        })
        .await;
    }

    // VERIFY: wave3-tasks-8
    /// `updateTask(id, body)` (`tasks.mjs:498-544`), including the durable
    /// transition record and the persist-before-side-effects ordering. The
    /// cleanup step after the committed transition propagates its failure, so
    /// the route answers `400 {ok:false,error}` exactly like Node's unguarded
    /// `await finishDoneTask`/`ensureWorktree` after the persist (`tasks.mjs:542`).
    pub async fn update(&self, id: &str, body: &Value) -> Result<Value, TaskError> {
        let _guard = self.mutation.lock().await;
        self.update_locked(id, body, None).await
    }

    /// The output watcher entering a limit overlay (`updateTaskInner(id,
    /// { state: kind }, { limitResetAt })`). A card already in the same
    /// overlay is left alone so the covered state is never overwritten, but a
    /// plain 429 promotes to usage-limited and a usage limit that gains its
    /// reset text later attaches it.
    async fn enter_limit(
        &self,
        id: &str,
        kind: &str,
        reset_at: Option<i64>,
    ) -> Result<(), TaskError> {
        let _guard = self.mutation.lock().await;
        let (current, has_reset) = {
            let state = self.state.lock().unwrap();
            let Some(task) = state.find(id) else {
                return Ok(());
            };
            if task.column == "done" {
                return Ok(());
            }
            (
                OVERLAY_STATES
                    .contains(&task.state.as_str())
                    .then(|| task.state.clone()),
                task.limit_reset_at.is_some(),
            )
        };
        let update = match current.as_deref() {
            None => true,
            Some("rate-limited") => kind == "usage-limited",
            Some("usage-limited") => kind == "usage-limited" && reset_at.is_some() && !has_reset,
            Some(_) => false,
        };
        if update {
            self.update_locked(id, &json!({ "state": kind }), reset_at)
                .await?;
        }
        Ok(())
    }

    /// `clearLimitInner(id)` (`tasks.mjs`): restore the state the overlay
    /// covered (the column's first state when a column move made it invalid)
    /// and drop the limit fields. State-only, so no transition record.
    async fn clear_limit(&self, id: &str) -> Result<(), TaskError> {
        let _guard = self.mutation.lock().await;
        let Some(current) = self.state.lock().unwrap().find(id).cloned() else {
            return Ok(());
        };
        if !OVERLAY_STATES.contains(&current.state.as_str()) {
            return Ok(());
        }
        let mut next = current;
        let allowed = states_for(&next.column);
        let prev = next.limit_prev_state.take();
        next.limit_reset_at = None;
        next.residual.remove("limitPrevState");
        next.residual.remove("limitResetAt");
        next.state = match prev {
            Some(prev) if allowed.contains(&prev.as_str()) => prev,
            prev => allowed
                .first()
                .map(|first| (*first).to_owned())
                .or(prev)
                .unwrap_or(next.state),
        };
        next.residual.remove("state");
        next.updated_at = (self.clock)();
        next.residual.remove("updatedAt");
        self.persist_staged(&next).await?;
        self.state.lock().unwrap().replace(next);
        self.limit_timer.notify_one();
        self.emit();
        Ok(())
    }

    async fn update_locked(
        &self,
        id: &str,
        body: &Value,
        limit_reset_at: Option<i64>,
    ) -> Result<Value, TaskError> {
        let Some(current) = self.state.lock().unwrap().find(id).cloned() else {
            return Err(TaskError::bad("no such task"));
        };
        let mut next = current.clone();
        let was_done = current.column == "done";
        let mut column: Option<String> = None;
        if let Some(value) = body.get("column") {
            let name = value.as_str().unwrap_or("");
            if !COLUMNS.contains(&name) {
                return Err(TaskError::bad(format!(
                    "bad column (expected {})",
                    COLUMNS.join("|")
                )));
            }
            column = Some(name.to_owned());
            next.column = name.to_owned();
            next.residual.remove("column");
            if name == "done" && !was_done {
                next.done_at = Some((self.clock)());
                next.residual.remove("doneAt");
                next.state = "complete".to_owned();
                next.residual.remove("state");
            } else if name != "done" && was_done {
                next.done_at = None;
                next.residual.remove("doneAt");
            }
            if current.column != name {
                let transition = Transition {
                    from: current.column.clone(),
                    to: name.to_owned(),
                    at: (self.clock)(),
                    actor: opt_trimmed(body, "actor"),
                    source: opt_trimmed(body, "source"),
                    reason: opt_trimmed(body, "reason"),
                    extra: serde_json::Map::new(),
                };
                // `next.transitions = [...(t.transitions ?? []), {...}]`
                // (`tasks.mjs:531-536`): an array the typed view could not hold
                // element-wise was parked in `residual` by the lenient load, and
                // Node appends to the array it loaded. Replacing it with the typed
                // (empty) vector would drop the history the load preserved.
                // VERIFY: wave5-task-reg-8
                match next.residual.get_mut("transitions") {
                    Some(Value::Array(raw)) => {
                        raw.push(serde_json::to_value(&transition).unwrap_or(Value::Null));
                        // The residual array stays the serialized value; the typed
                        // vector is shadowed for as long as the raw entry exists.
                    }
                    _ => {
                        next.transitions.push(transition);
                        next.residual.remove("transitions");
                    }
                }
            }
        }
        if let Some(value) = body.get("state") {
            let state_column = column.clone().unwrap_or_else(|| next.column.clone());
            let state = clipped(&js_string(value), 120);
            let allowed: Vec<&str> = states_for(&state_column)
                .iter()
                .chain(OVERLAY_STATES.iter())
                .copied()
                .collect();
            if !allowed.contains(&state.as_str()) {
                return Err(TaskError::bad(format!(
                    "bad state for {state_column} (expected {})",
                    allowed.join("|")
                )));
            }
            // Entering a limit overlay remembers the state it covers; any real
            // state ends the overlay and its limit fields.
            if !OVERLAY_STATES.contains(&state.as_str()) {
                next.limit_prev_state = None;
                next.limit_reset_at = None;
                next.residual.remove("limitPrevState");
                next.residual.remove("limitResetAt");
            } else {
                if !OVERLAY_STATES.contains(&current.state.as_str()) {
                    next.limit_prev_state = Some(current.state.clone());
                    next.residual.remove("limitPrevState");
                }
                // A usage limit arrives in pieces: a plain 429 may have flagged
                // the card first, or the reset text may follow the phrase.
                // Attach the reset without touching the covered state.
                if state == "usage-limited" && limit_reset_at.is_some() {
                    next.limit_reset_at = limit_reset_at;
                    next.residual.remove("limitResetAt");
                }
            }
            next.state = state;
            next.residual.remove("state");
        }
        let left_overlay = OVERLAY_STATES.contains(&current.state.as_str())
            && !OVERLAY_STATES.contains(&next.state.as_str());
        // A column-only move to Done ends the overlay without a `state` in the
        // body, so clear the limit fields the state branch above would have.
        if body.get("state").is_none() && left_overlay {
            next.limit_prev_state = None;
            next.limit_reset_at = None;
            next.residual.remove("limitPrevState");
            next.residual.remove("limitResetAt");
        }
        next.updated_at = (self.clock)();
        next.residual.remove("updatedAt");
        self.persist_staged(&next).await?;
        {
            let mut state = self.state.lock().unwrap();
            state.replace(next.clone());
            // The overlay's stale phrase would re-flag the card on its next
            // output chunk.
            if left_overlay && let Some(session) = next.session_id.as_deref() {
                state.tails.remove(session);
            }
        }
        self.limit_timer.notify_one();
        self.emit();
        if column.as_deref() == Some("done") && !was_done {
            self.finish_done_task(&next).await?;
        } else if column.is_some() && column.as_deref() != Some("done") && was_done {
            self.ensure_worktree(&next).await?;
        }
        Ok(serde_json::to_value(&next).unwrap_or(Value::Null))
    }

    // VERIFY: tasks-finish-done
    /// `finishDoneTask(t)` (`tasks.mjs:546-557`): idempotent Done cleanup.
    /// Never reverses the durable Done — a later failure only leaves the
    /// session or worktree for the next boot's recovery.
    ///
    /// `reg.remove` is the only step Node can reject here (`cleanupGitTask`
    /// catches its own git errors), so its failure is returned to the caller;
    /// the `update` route turns that into `400 {ok:false,error}` after the
    /// already-committed transition, like Node (`tasks.mjs:542`).
    async fn finish_done_task(&self, task: &Task) -> Result<(), TaskError> {
        if let Some(session) = task.session_id.as_deref() {
            {
                let mut state = self.state.lock().unwrap();
                state.task_by_session.remove(session);
                state.tails.remove(session);
            }
            let was_live = self.spawner.is_live(session);
            if let Err(error) = self.spawner.remove(session) {
                return Err(TaskError::bad(error));
            }
            let mut waited = 0;
            while was_live && self.spawner.is_live(session) && waited < 3000 {
                tokio::time::sleep(Duration::from_millis(200)).await;
                waited += 200;
            }
        }
        self.cleanup_git(task).await;
        Ok(())
    }

    async fn cleanup_git(&self, task: &Task) {
        let git = self.git.clone();
        let task = task.clone();
        let logger = self.logger.clone();
        let _ = tokio::task::spawn_blocking(move || {
            let log = |message: &str| logger(message);
            crate::task_git::cleanup_git_task(git.as_ref(), &task, &log);
        })
        .await;
    }

    async fn ensure_worktree(&self, task: &Task) -> Result<(), TaskError> {
        let git = self.git.clone();
        let task = task.clone();
        let worktrees_dir = self.config.worktrees_dir.clone();
        match tokio::task::spawn_blocking(move || {
            crate::task_git::ensure_worktree(git.as_ref(), &task, &worktrees_dir)
        })
        .await
        {
            Ok(Ok(())) => Ok(()),
            Ok(Err(error)) => Err(TaskError::bad(error)),
            Err(error) => Err(TaskError::bad(error.to_string())),
        }
    }

    // VERIFY: wave3-tasks-9
    /// `concludeTask(id, outcome)` (`tasks.mjs:569-596`): full cleanup, history
    /// append with `finalStats`, then persist. A repeated conclusion of an id
    /// already in history is a no-op success. The stats lookup parses transcripts
    /// synchronously, so it runs on the blocking pool while the mutation gate is
    /// held instead of stalling a runtime worker (and every other mutation).
    pub async fn conclude(&self, id: &str, outcome: &str) -> Result<(), TaskError> {
        let _guard = self.mutation.lock().await;
        if outcome != "completed" && outcome != "abandoned" {
            return Err(TaskError::bad("bad outcome (expected completed|abandoned)"));
        }
        let Some(task) = self.state.lock().unwrap().find(id).cloned() else {
            let concluded = self
                .state
                .lock()
                .unwrap()
                .history
                .iter()
                .any(|entry| entry.get("id").and_then(Value::as_str) == Some(id));
            if concluded {
                return Ok(());
            }
            return Err(TaskError::bad("no such task"));
        };
        let session = task.session_id.clone();
        let mut final_stats = match session.clone() {
            Some(session) => {
                let stats = self.stats.clone();
                let cwd = task.worktree.clone().unwrap_or_else(|| task.repo.clone());
                tokio::task::spawn_blocking(move || stats.session_stats(&session, &cwd))
                    .await
                    .ok()
                    .flatten()
            }
            None => None,
        };
        if let (Some(session), Some(Value::Object(entry))) =
            (session.as_deref(), final_stats.as_mut())
        {
            entry.insert("busyMs".to_owned(), json!(self.spawner.active_ms(session)));
        }
        let was_live = session
            .as_deref()
            .is_some_and(|session| self.spawner.is_live(session));
        if was_live {
            if let Some(session) = session.as_deref() {
                if let Err(error) = self.spawner.kill(session) {
                    self.log(&format!("session kill failed for {session}: {error}"));
                }
            }
        }
        if let Some(session) = session.as_deref() {
            self.state.lock().unwrap().tails.remove(session);
        }
        let mut waited = 0;
        while was_live
            && session
                .as_deref()
                .is_some_and(|session| self.spawner.is_live(session))
            && waited < 3000
        {
            tokio::time::sleep(Duration::from_millis(200)).await;
            waited += 200;
        }
        self.cleanup_git(&task).await;
        let mut entry = serde_json::to_value(&task).unwrap_or_else(|_| json!({}));
        if let Value::Object(map) = &mut entry {
            map.insert("outcome".to_owned(), json!(outcome));
            map.insert("concludedAt".to_owned(), json!((self.clock)()));
            map.insert("finalStats".to_owned(), final_stats.unwrap_or(Value::Null));
        }
        let (tasks, history) = {
            let mut state = self.state.lock().unwrap();
            if let Some(session) = session.as_deref() {
                state.task_by_session.remove(session);
            }
            state.remove(id);
            state.history.push(entry);
            (state.tasks.clone(), state.history.clone())
        };
        self.limit_timer.notify_one();
        self.persist(&tasks, &history).await?;
        self.emit();
        Ok(())
    }

    // VERIFY: tasks-delete-history
    /// `deleteHistory(id)` (`tasks.mjs:598-604`).
    pub async fn delete_history(&self, id: &str) -> Result<(), TaskError> {
        let _guard = self.mutation.lock().await;
        let (tasks, history) = {
            let mut state = self.state.lock().unwrap();
            let before = state.history.len();
            state
                .history
                .retain(|entry| entry.get("id").and_then(Value::as_str) != Some(id));
            if state.history.len() == before {
                return Err(TaskError::bad("no such history entry"));
            }
            (state.tasks.clone(), state.history.clone())
        };
        self.persist(&tasks, &history).await?;
        self.emit();
        Ok(())
    }

    // VERIFY: tasks-retention
    /// `sweepRetention()` (`tasks.mjs:608-616`): Done cards older than
    /// `retention_ms` auto-conclude as `completed`; per-task failures log.
    pub async fn sweep_retention(&self) {
        let now = (self.clock)();
        // Backstop for the reset timer loop.
        self.clear_due_limits().await;
        let cutoff = now - self.config.retention_ms;
        let due: Vec<String> = self
            .state
            .lock()
            .unwrap()
            .tasks
            .iter()
            .filter(|task| {
                task.column == "done" && task.done_at.is_some_and(|done_at| done_at < cutoff)
            })
            .map(|task| task.id.clone())
            .collect();
        for id in due {
            if let Err(error) = self.conclude(&id, "completed").await {
                self.log(&format!(
                    "retention sweep: conclude failed for {id}: {}",
                    error.message
                ));
            }
        }
    }

    /// The reset timer's next wait. A due reset whose clear could not persist
    /// is still due, so retrying it immediately would spin: it waits the
    /// bounded retry delay, but never past a nearer future reset.
    fn limit_wait(&self, retry: bool) -> Option<Duration> {
        let now = (self.clock)();
        let state = self.state.lock().unwrap();
        state
            .tasks
            .iter()
            .filter(|task| task.state == "usage-limited")
            .filter_map(|task| task.limit_reset_at)
            .map(|at| {
                let wait = at - now;
                if retry && wait <= 0 {
                    LIMIT_RETRY_DELAY.as_millis() as i64
                } else {
                    wait
                }
            })
            .min()
            .map(|wait| Duration::from_millis(wait.clamp(0, 86_400_000) as u64))
    }

    /// Clear every usage limit past its parsed reset; its stale tail goes too,
    /// so the old phrase can't re-flag the card on the next chunk. Returns
    /// `false` when a clear failed to persist and a due overlay remains.
    async fn clear_due_limits(&self) -> bool {
        let now = (self.clock)();
        let reset: Vec<(String, Option<String>)> = self
            .state
            .lock()
            .unwrap()
            .tasks
            .iter()
            .filter(|task| {
                task.state == "usage-limited" && task.limit_reset_at.is_some_and(|at| now >= at)
            })
            .map(|task| (task.id.clone(), task.session_id.clone()))
            .collect();
        let mut cleared = true;
        for (id, session) in reset {
            if let Some(session) = session {
                self.state.lock().unwrap().tails.remove(&session);
            }
            if let Err(error) = self.clear_limit(&id).await {
                cleared = false;
                self.log(&format!("limit clear failed for {id}: {}", error.message));
            }
        }
        cleared
    }
}

impl TaskSnapshots for TaskService {
    fn snapshot(&self) -> Value {
        TaskService::snapshot(self)
    }
}

fn join_error(error: tokio::task::JoinError) -> TaskError {
    TaskError::bad(error.to_string())
}

/// Node prepends `transitions: []` while loading (`tasks.mjs:139-141`), so a
/// record saved before transition history existed still serializes the key
/// first.
fn normalize_history_entry(entry: Value) -> Value {
    match entry {
        Value::Object(mut map) if !map.contains_key("transitions") => {
            let mut rebuilt = serde_json::Map::new();
            rebuilt.insert("transitions".to_owned(), json!([]));
            for (key, value) in std::mem::take(&mut map) {
                rebuilt.insert(key, value);
            }
            Value::Object(rebuilt)
        }
        other => other,
    }
}

// VERIFY: tasks-new-id
/// `randomUUID()` (`tasks.mjs:430`): a v4-shaped id from a time/pid/counter
/// seeded splitmix64 stream. A private copy of `agent_registry::new_id` (not
/// exported by the registry module) — collision-free within one process, which
/// is all the board needs.
fn new_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let mut state = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos() as u64)
        .unwrap_or(0)
        ^ (u64::from(std::process::id()) << 32)
        ^ COUNTER.fetch_add(1, Ordering::Relaxed);
    let mut next = move || {
        state = state.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut mixed = state;
        mixed = (mixed ^ (mixed >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        mixed = (mixed ^ (mixed >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        mixed ^ (mixed >> 31)
    };
    let high = next();
    let low = next();
    format!(
        "{:08x}-{:04x}-4{:03x}-{:04x}-{:012x}",
        (high >> 32) as u32,
        (high >> 16) as u16,
        high & 0x0fff,
        (((low >> 48) as u16) & 0x3fff) | 0x8000,
        low & 0x0000_ffff_ffff_ffff
    )
}

#[cfg(test)]
impl TaskService {
    /// Test-only: put a record on the board without a spawn or a ticket write.
    pub(crate) fn seed(&self, task: Task) {
        let mut state = self.state.lock().unwrap();
        if let Some(session) = task.session_id.clone() {
            state.task_by_session.insert(session, task.id.clone());
        }
        state.tasks.push(task);
    }

    pub(crate) fn history_len(&self) -> usize {
        self.state.lock().unwrap().history.len()
    }
}

#[cfg(test)]
pub(crate) mod test_support {
    use super::*;
    use crate::agent_wire::Status;
    use std::sync::atomic::{AtomicBool, AtomicI64, AtomicUsize, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    pub struct Fixture {
        pub root: PathBuf,
    }

    impl Fixture {
        pub fn new(tag: &str) -> Self {
            let stamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let root = std::env::temp_dir().join(format!(
                "singularity-task-service-{tag}-{}-{stamp}",
                std::process::id()
            ));
            std::fs::create_dir_all(root.join("state")).unwrap();
            Self { root }
        }

        pub fn config(&self) -> TasksConfig {
            TasksConfig {
                tasks_file: self.root.join("state").join("tasks.json"),
                worktrees_dir: self.root.join(".worktrees"),
                tickets_dir: self.root.join(".tickets"),
                reports_dir: self.root.join(".reports"),
                models_state: self.root.join("state").join("models.json"),
                daemon_port: Some(4317),
                token_header: String::new(),
                cavecrew: false,
                retention_ms: RETENTION_MS,
                sweep_interval: Duration::from_secs(3600),
            }
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    pub fn task(id: &str) -> Task {
        let short: String = id.chars().take(8).collect();
        Task {
            id: id.to_owned(),
            title: "Task".to_owned(),
            description: "Do it".to_owned(),
            repo: "/repo".to_owned(),
            kind: TaskKind::Plain,
            worktree: None,
            branch: None,
            base_branch: None,
            ticket_dir: format!("/tickets/{short}"),
            report_dir: format!("/tickets/{short}"),
            ..Task::default()
        }
    }

    pub struct FakeSpawner {
        pub created: Mutex<Vec<CreateAgent>>,
        pub live: Mutex<HashSet<String>>,
        counter: AtomicUsize,
        fail: AtomicBool,
        fail_remove: AtomicBool,
    }

    impl FakeSpawner {
        pub fn new() -> Arc<Self> {
            Arc::new(Self {
                created: Mutex::new(Vec::new()),
                live: Mutex::new(HashSet::new()),
                counter: AtomicUsize::new(0),
                fail: AtomicBool::new(false),
                fail_remove: AtomicBool::new(false),
            })
        }

        pub fn fail_spawn(&self) {
            self.fail.store(true, Ordering::SeqCst);
        }

        pub fn fail_remove(&self) {
            self.fail_remove.store(true, Ordering::SeqCst);
        }

        pub fn created(&self) -> Vec<CreateAgent> {
            self.created.lock().unwrap().clone()
        }
    }

    impl Spawner for FakeSpawner {
        fn create(&self, input: CreateAgent) -> Result<AgentWire, String> {
            self.created.lock().unwrap().push(input.clone());
            if self.fail.load(Ordering::SeqCst) {
                return Err("spawn failed".to_owned());
            }
            let number = self.counter.fetch_add(1, Ordering::SeqCst);
            let id = format!("session-{number}");
            self.live.lock().unwrap().insert(id.clone());
            Ok(AgentWire {
                id,
                title: input.title,
                cwd: input.cwd,
                status: Status::Running,
                pid: None,
                created_at: None,
                model: input.model,
                scopes: input.scopes,
                tool: input.tool,
            })
        }

        fn is_live(&self, id: &str) -> bool {
            self.live.lock().unwrap().contains(id)
        }

        fn kill(&self, id: &str) -> Result<(), String> {
            self.live.lock().unwrap().remove(id);
            Ok(())
        }

        fn remove(&self, id: &str) -> Result<(), String> {
            if self.fail_remove.load(Ordering::SeqCst) {
                return Err("registry remove failed".to_owned());
            }
            self.live.lock().unwrap().remove(id);
            Ok(())
        }

        fn active_ms(&self, _id: &str) -> i64 {
            0
        }
    }

    pub struct FakeGit {
        pub calls: Mutex<Vec<Vec<String>>>,
        pub inside_work_tree: AtomicBool,
        pub branch_exists: AtomicBool,
        pub fail_worktree_add: AtomicBool,
    }

    impl FakeGit {
        pub fn new() -> Arc<Self> {
            Arc::new(Self {
                calls: Mutex::new(Vec::new()),
                inside_work_tree: AtomicBool::new(true),
                branch_exists: AtomicBool::new(true),
                fail_worktree_add: AtomicBool::new(false),
            })
        }

        pub fn calls(&self) -> Vec<Vec<String>> {
            self.calls.lock().unwrap().clone()
        }
    }

    impl GitPort for FakeGit {
        fn git(&self, _repo: &str, args: &[&str]) -> Result<String, String> {
            self.calls
                .lock()
                .unwrap()
                .push(args.iter().map(|arg| (*arg).to_owned()).collect());
            match args {
                ["rev-parse", "--is-inside-work-tree"] => {
                    Ok(if self.inside_work_tree.load(Ordering::SeqCst) {
                        "true"
                    } else {
                        "false"
                    }
                    .to_owned())
                }
                ["rev-parse", "--abbrev-ref", "HEAD"] => Ok("main".to_owned()),
                ["rev-parse", "--verify", _] => {
                    if self.branch_exists.load(Ordering::SeqCst) {
                        Ok("abc123".to_owned())
                    } else {
                        Err("no such branch".to_owned())
                    }
                }
                ["worktree", "add", ..] if self.fail_worktree_add.load(Ordering::SeqCst) => {
                    Err("worktree add failed".to_owned())
                }
                _ => Ok(String::new()),
            }
        }
    }

    pub struct FakeStats {
        pub entry: Value,
    }

    impl StatsPort for FakeStats {
        fn session_stats(&self, _session_id: &str, _cwd: &str) -> Option<Value> {
            Some(self.entry.clone())
        }
    }

    pub fn fixed_clock(now: i64) -> Clock {
        Arc::new(move || now)
    }

    pub fn mutable_clock(value: Arc<AtomicI64>) -> Clock {
        Arc::new(move || value.load(Ordering::SeqCst))
    }

    pub fn service(
        fixture: &Fixture,
        spawner: Arc<FakeSpawner>,
        git: Arc<FakeGit>,
        clock: Clock,
    ) -> (Arc<TaskService>, Bus) {
        let bus = Bus::new();
        let service = TaskService::new(
            bus.clone(),
            spawner,
            git,
            Arc::new(FakeStats {
                entry: json!({ "turns": 1, "tokens": 2 }),
            }),
            fixture.config(),
            clock,
            Arc::new(|_| {}),
        );
        (service, bus)
    }

    /// A throwaway git repo with one commit, for the real-git lifecycle tests.
    pub fn fixture_git_repo(tag: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "singularity-task-repo-{tag}-{}-{stamp}",
            std::process::id()
        ));
        std::fs::create_dir_all(&root).unwrap();
        // Deterministic minimal setup: init, config, one file, one commit.
        let status = std::process::Command::new("git")
            .arg("-C")
            .arg(&root)
            .args(["init", "-q"])
            .status()
            .unwrap();
        assert!(status.success());
        for args in [
            ["config", "user.email", "t@example.com"].as_slice(),
            ["config", "user.name", "T"].as_slice(),
        ] {
            let status = std::process::Command::new("git")
                .arg("-C")
                .arg(&root)
                .args(args)
                .status()
                .unwrap();
            assert!(status.success());
        }
        std::fs::write(root.join("README.md"), "base\n").unwrap();
        for args in [
            ["add", "README.md"].as_slice(),
            ["commit", "-q", "-m", "base"].as_slice(),
        ] {
            let status = std::process::Command::new("git")
                .arg("-C")
                .arg(&root)
                .args(args)
                .status()
                .unwrap();
            assert!(status.success());
        }
        root
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::*;
    use super::*;
    use std::sync::atomic::{AtomicI64, Ordering};

    fn run<F: std::future::Future>(future: F) -> F::Output {
        tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(future)
    }

    async fn wait_for_state(service: &TaskService, id: &str, state: &str) {
        for _ in 0..200 {
            let snapshot = service.snapshot();
            let reached = snapshot["tasks"]
                .as_array()
                .unwrap()
                .iter()
                .any(|task| task["id"] == id && task["state"] == state);
            if reached {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("task {id} never reached state {state}");
    }

    async fn wait_for_field(service: &TaskService, id: &str, key: &str, expected: Value) {
        for _ in 0..200 {
            if task_field(service, id, key) == expected {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!(
            "task {id} field {key} never became {expected}, is {}",
            task_field(service, id, key)
        );
    }

    // VERIFY: tasks-tests-state-vocabulary
    #[test]
    fn update_rejects_a_state_outside_the_column_and_accepts_the_overlay() {
        run(async {
            let fixture = Fixture::new("states");
            let (service, _bus) = service(
                &fixture,
                FakeSpawner::new(),
                FakeGit::new(),
                fixed_clock(1000),
            );
            service.seed(task("t1"));
            let error = service
                .update("t1", &json!({ "state": "working" }))
                .await
                .unwrap_err();
            assert_eq!(
                error.message,
                "bad state for todo (expected analyzing|clarifying|awaiting plan approval|usage-limited|rate-limited)"
            );
            assert!(!error.persist_failure);
            let updated = service
                .update("t1", &json!({ "state": "rate-limited" }))
                .await
                .unwrap();
            assert_eq!(updated["state"], "rate-limited");
            assert!(updated["transitions"].as_array().unwrap().is_empty());

            let error = service
                .update("t1", &json!({ "column": "nope" }))
                .await
                .unwrap_err();
            assert_eq!(
                error.message,
                "bad column (expected todo|inprogress|inreview|done)"
            );
            let error = service.update("missing", &json!({})).await.unwrap_err();
            assert_eq!(error.message, "no such task");
        });
    }

    // VERIFY: tasks-tests-transitions
    #[test]
    fn column_changes_append_one_transition_and_state_only_appends_none() {
        run(async {
            let fixture = Fixture::new("transitions");
            let (service, _bus) = service(
                &fixture,
                FakeSpawner::new(),
                FakeGit::new(),
                fixed_clock(1000),
            );
            service.seed(task("t1"));
            let updated = service
                .update(
                    "t1",
                    &json!({ "column": "inprogress", "state": "working", "actor": "  Ada  ", "reason": "go" }),
                )
                .await
                .unwrap();
            let transitions = updated["transitions"].as_array().unwrap();
            assert_eq!(transitions.len(), 1);
            assert_eq!(transitions[0]["from"], "todo");
            assert_eq!(transitions[0]["to"], "inprogress");
            assert_eq!(transitions[0]["at"], 1000);
            assert_eq!(transitions[0]["actor"], "Ada");
            assert_eq!(transitions[0]["reason"], "go");
            assert!(transitions[0].get("source").is_none());
            assert_eq!(updated["updatedAt"], 1000);

            let updated = service
                .update("t1", &json!({ "state": "fixing" }))
                .await
                .unwrap();
            assert_eq!(updated["transitions"].as_array().unwrap().len(), 1);

            let long = "x".repeat(200);
            let updated = service
                .update("t1", &json!({ "column": "inreview", "actor": long }))
                .await
                .unwrap();
            let transitions = updated["transitions"].as_array().unwrap();
            assert_eq!(transitions.len(), 2);
            assert_eq!(transitions[1]["actor"].as_str().unwrap().len(), 120);
        });
    }

    // VERIFY: tasks-tests-done-round-trip
    #[test]
    fn done_round_trip_sets_and_clears_done_at() {
        run(async {
            let fixture = Fixture::new("done");
            let (service, _bus) = service(
                &fixture,
                FakeSpawner::new(),
                FakeGit::new(),
                fixed_clock(1000),
            );
            service.seed(task("t1"));
            let done = service
                .update("t1", &json!({ "column": "done" }))
                .await
                .unwrap();
            assert_eq!(done["state"], "complete");
            assert_eq!(done["doneAt"], 1000);
            assert_eq!(done["transitions"].as_array().unwrap().len(), 1);

            let reopened = service
                .update("t1", &json!({ "column": "inreview" }))
                .await
                .unwrap();
            assert!(reopened.get("doneAt").is_none());
            assert_eq!(reopened["transitions"].as_array().unwrap().len(), 2);
            assert_eq!(reopened["transitions"][1]["from"], "done");
            assert_eq!(reopened["transitions"][1]["to"], "inreview");
        });
    }

    // VERIFY: tasks-tests-persist-before-commit
    #[test]
    fn failed_persist_leaves_the_board_untouched() {
        run(async {
            let fixture = Fixture::new("persist");
            let (service, _bus) = service(
                &fixture,
                FakeSpawner::new(),
                FakeGit::new(),
                fixed_clock(1000),
            );
            service.seed(task("t1"));
            // A directory at the target path makes the atomic rename fail.
            std::fs::create_dir_all(&fixture.config().tasks_file).unwrap();
            let error = service
                .update("t1", &json!({ "column": "inprogress" }))
                .await
                .unwrap_err();
            assert!(error.persist_failure, "{error}");
            assert!(error.message.starts_with("tasks.json write failed: "));
            let snapshot = service.snapshot();
            assert_eq!(snapshot["tasks"][0]["column"], "todo");
            assert_eq!(snapshot["tasks"][0]["transitions"], json!([]));
        });
    }

    // VERIFY: tasks-tests-conclude-once
    #[test]
    fn concurrent_conclude_concludes_exactly_once() {
        run(async {
            let fixture = Fixture::new("conclude-once");
            let (service, _bus) = service(
                &fixture,
                FakeSpawner::new(),
                FakeGit::new(),
                fixed_clock(1000),
            );
            let mut t = task("t1");
            t.session_id = Some("session-0".to_owned());
            service.seed(t);
            let first = service.clone();
            let second = service.clone();
            let (a, b) = tokio::join!(
                tokio::spawn(async move { first.conclude("t1", "completed").await }),
                tokio::spawn(async move { second.conclude("t1", "completed").await })
            );
            assert!(a.unwrap().is_ok());
            assert!(b.unwrap().is_ok());
            assert_eq!(service.history_len(), 1);
            let snapshot = service.snapshot();
            assert!(snapshot["tasks"].as_array().unwrap().is_empty());
            let entry = &snapshot["history"][0];
            assert_eq!(entry["id"], "t1");
            assert_eq!(entry["outcome"], "completed");
            assert_eq!(entry["concludedAt"], 1000);
            assert_eq!(entry["finalStats"]["turns"], 1);
            assert_eq!(entry["finalStats"]["busyMs"], 0);
        });
    }

    // VERIFY: tasks-tests-conclude-errors
    #[test]
    fn conclude_validates_outcome_and_delete_history_reports_missing_entries() {
        run(async {
            let fixture = Fixture::new("conclude-errors");
            let (service, _bus) = service(
                &fixture,
                FakeSpawner::new(),
                FakeGit::new(),
                fixed_clock(1000),
            );
            assert_eq!(
                service.conclude("x", "nope").await.unwrap_err().message,
                "bad outcome (expected completed|abandoned)"
            );
            assert_eq!(
                service
                    .conclude("x", "completed")
                    .await
                    .unwrap_err()
                    .message,
                "no such task"
            );
            service.seed(task("t1"));
            service.conclude("t1", "abandoned").await.unwrap();
            assert_eq!(service.history_len(), 1);
            assert_eq!(service.snapshot()["history"][0]["finalStats"], Value::Null);
            service.conclude("t1", "abandoned").await.unwrap();
            assert_eq!(service.history_len(), 1);
            service.delete_history("t1").await.unwrap();
            assert_eq!(service.history_len(), 0);
            assert_eq!(
                service.delete_history("t1").await.unwrap_err().message,
                "no such history entry"
            );
        });
    }

    // VERIFY: tasks-tests-old-shape-load
    #[test]
    fn old_shape_records_load_with_empty_transitions() {
        run(async {
            let fixture = Fixture::new("load-shape");
            std::fs::write(
                fixture.config().tasks_file,
                r#"{"tasks":[{"id":"old","title":"T","description":"D","repo":"/r","kind":"plain","ticketDir":"/t","reportDir":"/t"}],"history":[{"id":"h1","outcome":"completed"}]}"#,
            )
            .unwrap();
            let (service, _bus) = service(
                &fixture,
                FakeSpawner::new(),
                FakeGit::new(),
                fixed_clock(1000),
            );
            service.load().await;
            let snapshot = service.snapshot();
            assert_eq!(snapshot["tasks"][0]["transitions"], json!([]));
            assert_eq!(snapshot["tasks"][0]["column"], "todo");
            assert_eq!(snapshot["tasks"][0]["state"], "analyzing");
            assert_eq!(snapshot["history"][0]["transitions"], json!([]));
            assert_eq!(snapshot["history"][0]["outcome"], "completed");
        });
    }

    // VERIFY: tasks-tests-rate-limit-watcher
    #[test]
    fn load_rebuilds_the_session_index_and_the_watcher_flags_split_chunks() {
        run(async {
            let fixture = Fixture::new("watcher");
            std::fs::write(
                fixture.config().tasks_file,
                r#"{"tasks":[{"id":"t1","title":"T","description":"D","repo":"/r","kind":"plain","ticketDir":"/t","reportDir":"/t","sessionId":"session-0"}],"history":[]}"#,
            )
            .unwrap();
            let (service, bus) = service(
                &fixture,
                FakeSpawner::new(),
                FakeGit::new(),
                fixed_clock(1000),
            );
            service.load().await;
            let (tx, rx) = watch::channel(false);
            service.start_background(&tokio::runtime::Handle::current(), rx);

            // A chunk split across two output events, behind a long prefix that
            // still fits the 400-char rolling window.
            bus.emit(&BusEvent::Output {
                id: "session-0".to_owned(),
                data: format!("{}Request rej", "x".repeat(300)),
            });
            tokio::time::sleep(Duration::from_millis(10)).await;
            bus.emit(&BusEvent::Output {
                id: "session-0".to_owned(),
                data: "ected (429)".to_owned(),
            });
            wait_for_state(&service, "t1", "rate-limited").await;
            let _ = tx.send(true);
        });
    }

    #[test]
    fn classify_limit_splits_the_usage_limit_from_a_plain_429() {
        assert_eq!(
            classify_limit(
                "API Error: Request rejected (429) · you (x) have reached your session usage limit"
            ),
            Some("usage-limited")
        );
        assert_eq!(
            classify_limit("reached your session usage limit"),
            Some("usage-limited")
        );
        assert_eq!(
            classify_limit("Request rejected (429)"),
            Some("rate-limited")
        );
        assert_eq!(classify_limit("session usage limit"), None);
        assert_eq!(classify_limit("HTTP 429"), None);
    }

    #[test]
    fn parse_limit_reset_at_reads_the_reset_wall_clock() {
        // 2026-01-10T10:00Z
        let now = 1_768_039_200_000;
        let hour = 3_600_000;
        assert_eq!(
            parse_limit_reset_at("limit · resets 3pm (UTC)", now),
            Some(now + 5 * hour)
        );
        assert_eq!(
            parse_limit_reset_at("resets 15:00 (UTC)", now),
            Some(now + 5 * hour)
        );
        // 17:00 in Zurich (UTC+1 in January): 3:30pm has passed -> tomorrow,
        // 2026-01-11T14:30Z.
        assert_eq!(
            parse_limit_reset_at("reset at 3:30pm (Europe/Zurich)", now + 6 * hour),
            Some(now + 24 * hour + 4 * hour + hour / 2)
        );
        let local = parse_limit_reset_at("resets 3pm", now).unwrap();
        assert!(local > now && local <= now + 24 * hour);
        for tail in [
            "resets soon",
            "resets 3 times",
            "resets 13pm",
            "resets 3pm (Not/AZone)",
            "no reset here",
        ] {
            assert_eq!(parse_limit_reset_at(tail, now), None, "{tail}");
        }
    }

    fn task_field(service: &TaskService, id: &str, key: &str) -> Value {
        service.snapshot()["tasks"]
            .as_array()
            .unwrap()
            .iter()
            .find(|task| task["id"] == id)
            .map_or(Value::Null, |task| task.get(key).cloned().unwrap_or(Value::Null))
    }

    #[test]
    fn limit_overlay_never_clears_on_output_clears_on_input_and_re_flags_on_the_phrase() {
        run(async {
            let fixture = Fixture::new("limit-overlay");
            std::fs::write(
                fixture.config().tasks_file,
                r#"{"tasks":[{"id":"t1","title":"T","description":"D","repo":"/r","kind":"plain","ticketDir":"/t","reportDir":"/t","column":"inprogress","state":"implementing","transitions":[],"sessionId":"session-0"},{"id":"t2","title":"T","description":"D","repo":"/r","kind":"plain","ticketDir":"/t","reportDir":"/t","column":"inprogress","state":"working","transitions":[],"sessionId":"session-1"}],"history":[]}"#,
            )
            .unwrap();
            let (service, bus) = service(
                &fixture,
                FakeSpawner::new(),
                FakeGit::new(),
                fixed_clock(1_768_039_200_000),
            );
            service.load().await;
            let (tx, rx) = watch::channel(false);
            service.start_background(&tokio::runtime::Handle::current(), rx);

            let output = |data: &str| {
                bus.emit(&BusEvent::Output {
                    id: "session-0".to_owned(),
                    data: data.to_owned(),
                })
            };
            let input = |data: &str| {
                bus.emit(&BusEvent::Input {
                    id: "session-0".to_owned(),
                    data: data.to_owned(),
                })
            };
            output(
                "\x1b[31mreached your \x1b[1msession usage limit\x1b[0m · resets 3pm (UTC)",
            );
            wait_for_state(&service, "t1", "usage-limited").await;
            assert_eq!(task_field(&service, "t1", "limitPrevState"), "implementing");
            assert_eq!(
                task_field(&service, "t1", "limitResetAt"),
                json!(1_768_039_200_000_i64 + 5 * 3_600_000)
            );

            // A TUI repaint: well over 400 bytes (and 400 visible chars), none
            // of it the phrase.
            let repaint = format!("\x1b[2K\x1b[1G\x1b[38;5;246m{}\x1b[0m\r\n", "─".repeat(20))
                .repeat(30);
            assert!(repaint.chars().count() > RATE_LIMIT_TAIL_CHARS);
            output(&repaint);
            tokio::time::sleep(Duration::from_millis(100)).await;
            assert_eq!(
                task_field(&service, "t1", "state"),
                "usage-limited",
                "repaint output does not clear"
            );

            output("reached your session usage limit"); // back in the tail

            input("\x1b[I");
            tokio::time::sleep(Duration::from_millis(100)).await;
            assert_eq!(
                task_field(&service, "t1", "state"),
                "usage-limited",
                "a focus report is not a resume"
            );

            input("\r");
            wait_for_state(&service, "t1", "implementing").await;
            assert_eq!(task_field(&service, "t1", "limitPrevState"), Value::Null);
            assert_eq!(task_field(&service, "t1", "limitResetAt"), Value::Null);
            assert_eq!(task_field(&service, "t1", "transitions"), json!([]));

            output(" ");
            tokio::time::sleep(Duration::from_millis(100)).await;
            assert_eq!(
                task_field(&service, "t1", "state"),
                "implementing",
                "the stale phrase was dropped with the tail"
            );

            output("reached your session usage limit");
            wait_for_state(&service, "t1", "usage-limited").await;

            bus.emit(&BusEvent::Output {
                id: "session-1".to_owned(),
                data: "API Error: Request rejected (429)".to_owned(),
            });
            wait_for_state(&service, "t2", "rate-limited").await;
            assert_eq!(task_field(&service, "t2", "limitPrevState"), "working");
            assert_eq!(task_field(&service, "t2", "limitResetAt"), Value::Null);
            let _ = tx.send(true);
        });
    }

    #[test]
    fn retention_sweep_clears_a_usage_limit_past_its_reset() {
        run(async {
            let fixture = Fixture::new("limit-reset");
            std::fs::write(
                fixture.config().tasks_file,
                r#"{"tasks":[{"id":"due","title":"T","description":"D","repo":"/r","kind":"plain","ticketDir":"/t","reportDir":"/t","column":"inprogress","state":"usage-limited","limitPrevState":"fixing","limitResetAt":900,"transitions":[]},{"id":"later","title":"T","description":"D","repo":"/r","kind":"plain","ticketDir":"/t","reportDir":"/t","column":"inprogress","state":"usage-limited","limitPrevState":"fixing","limitResetAt":5000,"transitions":[]}],"history":[]}"#,
            )
            .unwrap();
            let (service, _bus) = service(
                &fixture,
                FakeSpawner::new(),
                FakeGit::new(),
                fixed_clock(1000),
            );
            service.load().await;
            service.sweep_retention().await;
            assert_eq!(task_field(&service, "due", "state"), "fixing");
            assert_eq!(task_field(&service, "due", "limitResetAt"), Value::Null);
            assert_eq!(task_field(&service, "due", "transitions"), json!([]));
            assert_eq!(task_field(&service, "later", "state"), "usage-limited");
        });
    }

    #[test]
    fn a_persisted_usage_limit_clears_at_its_reset_time_not_before() {
        run(async {
            let fixture = Fixture::new("limit-timer");
            std::fs::write(
                fixture.config().tasks_file,
                r#"{"tasks":[{"id":"t1","title":"T","description":"D","repo":"/r","kind":"plain","ticketDir":"/t","reportDir":"/t","column":"inprogress","state":"usage-limited","limitPrevState":"fixing","limitResetAt":1100,"transitions":[]}],"history":[]}"#,
            )
            .unwrap();
            let now = Arc::new(AtomicI64::new(1000));
            let (service, _bus) = service(
                &fixture,
                FakeSpawner::new(),
                FakeGit::new(),
                mutable_clock(now.clone()),
            );
            service.load().await;
            let (tx, rx) = watch::channel(false);
            service.start_background(&tokio::runtime::Handle::current(), rx);
            // The timer wakes after ~100 ms of real time, but the clock still
            // says 1000: not before the reset.
            tokio::time::sleep(Duration::from_millis(250)).await;
            assert_eq!(task_field(&service, "t1", "state"), "usage-limited");
            now.store(1100, Ordering::SeqCst);
            wait_for_state(&service, "t1", "fixing").await;
            assert_eq!(task_field(&service, "t1", "limitResetAt"), Value::Null);
            assert_eq!(task_field(&service, "t1", "transitions"), json!([]));
            let _ = tx.send(true);
        });
    }

    // VERIFY: tasks-tests-limit-split-promotion
    /// Claude's usage limit can span chunks: a plain 429 flags first, then the
    /// usage phrase promotes the card, then the reset text attaches.
    #[test]
    fn a_split_usage_limit_promotes_a_429_and_attaches_a_late_reset() {
        run(async {
            let fixture = Fixture::new("limit-split");
            std::fs::write(
                fixture.config().tasks_file,
                r#"{"tasks":[{"id":"t1","title":"T","description":"D","repo":"/r","kind":"plain","ticketDir":"/t","reportDir":"/t","column":"inprogress","state":"implementing","transitions":[],"sessionId":"session-0"}],"history":[]}"#,
            )
            .unwrap();
            // 2026-01-10T10:00Z: "resets 3pm (UTC)" is five hours out.
            let now = 1_768_039_200_000;
            let (service, bus) = service(
                &fixture,
                FakeSpawner::new(),
                FakeGit::new(),
                fixed_clock(now),
            );
            service.load().await;
            let (tx, rx) = watch::channel(false);
            service.start_background(&tokio::runtime::Handle::current(), rx);
            let output = |data: &str| {
                bus.emit(&BusEvent::Output {
                    id: "session-0".to_owned(),
                    data: data.to_owned(),
                })
            };

            output("API Error: Request rejected (429)");
            wait_for_state(&service, "t1", "rate-limited").await;
            assert_eq!(task_field(&service, "t1", "limitPrevState"), "implementing");

            // The usage phrase arrives in the next chunk: promote, keep the
            // covered state, and leave the reset open until its text arrives.
            output(" · you (x) have reached your session usage limit");
            wait_for_state(&service, "t1", "usage-limited").await;
            assert_eq!(task_field(&service, "t1", "limitPrevState"), "implementing");
            assert_eq!(task_field(&service, "t1", "limitResetAt"), Value::Null);

            output(" · resets 3pm (UTC)");
            wait_for_field(&service, "t1", "limitResetAt", json!(now + 5 * 3_600_000)).await;
            assert_eq!(task_field(&service, "t1", "state"), "usage-limited");
            assert_eq!(task_field(&service, "t1", "limitPrevState"), "implementing");
            assert_eq!(task_field(&service, "t1", "transitions"), json!([]));
            let _ = tx.send(true);
        });
    }

    // VERIFY: tasks-tests-limit-exit-clears
    /// An explicit update that ends an overlay drops its limit metadata and
    /// PTY tail; a normal column move keeps the overlay.
    #[test]
    fn an_explicit_update_that_ends_an_overlay_drops_its_metadata_and_tail() {
        run(async {
            let fixture = Fixture::new("limit-exit");
            let (service, _bus) = service(
                &fixture,
                FakeSpawner::new(),
                FakeGit::new(),
                fixed_clock(1000),
            );
            let limited = |id: &str, column: &str, session: &str| Task {
                column: column.to_owned(),
                state: "usage-limited".to_owned(),
                limit_prev_state: Some("implementing".to_owned()),
                limit_reset_at: Some(5000),
                session_id: Some(session.to_owned()),
                ..task(id)
            };
            service.seed(limited("done", "inprogress", "session-done"));
            service.seed(limited("state", "inprogress", "session-state"));
            service.seed(limited("keep", "inprogress", "session-keep"));
            {
                let mut state = service.state.lock().unwrap();
                for session in ["session-done", "session-state", "session-keep"] {
                    state.tails.insert(
                        session.to_owned(),
                        "reached your session usage limit".to_owned(),
                    );
                }
            }

            let done = service
                .update("done", &json!({ "column": "done" }))
                .await
                .unwrap();
            assert_eq!(done["state"], "complete");
            assert_eq!(done.get("limitPrevState"), None);
            assert_eq!(done.get("limitResetAt"), None);
            service
                .enter_limit("done", "usage-limited", Some(5000))
                .await
                .unwrap();
            assert_eq!(task_field(&service, "done", "state"), "complete");

            service
                .update("state", &json!({ "state": "implementing" }))
                .await
                .unwrap();
            assert_eq!(task_field(&service, "state", "limitPrevState"), Value::Null);
            assert_eq!(task_field(&service, "state", "limitResetAt"), Value::Null);

            service
                .update("keep", &json!({ "column": "inreview" }))
                .await
                .unwrap();
            assert_eq!(task_field(&service, "keep", "state"), "usage-limited");
            assert_eq!(
                task_field(&service, "keep", "limitPrevState"),
                "implementing"
            );
            assert_eq!(task_field(&service, "keep", "limitResetAt"), json!(5000));

            let state = service.state.lock().unwrap();
            assert!(!state.tails.contains_key("session-done"));
            assert!(!state.tails.contains_key("session-state"));
            assert!(state.tails.contains_key("session-keep"));
        });
    }

    // VERIFY: tasks-tests-limit-retry-backoff
    /// A due overlay whose clear cannot persist stays due; the reset timer
    /// waits the bounded retry delay instead of a zero-length spin, while a
    /// future reset still wakes exactly at its reset time.
    #[test]
    fn a_due_limit_that_cannot_persist_backs_off_instead_of_spinning() {
        run(async {
            let fixture = Fixture::new("limit-retry");
            // An unreadable tasks.json blocks every write (persist refuses to
            // clobber it), like a corrupt file at startup.
            std::fs::write(fixture.config().tasks_file, "not json").unwrap();
            let (service, _bus) = service(
                &fixture,
                FakeSpawner::new(),
                FakeGit::new(),
                fixed_clock(1000),
            );
            service.load().await;
            service.seed(Task {
                column: "inprogress".to_owned(),
                state: "usage-limited".to_owned(),
                limit_prev_state: Some("fixing".to_owned()),
                limit_reset_at: Some(900),
                session_id: Some("session-0".to_owned()),
                ..task("t1")
            });
            assert!(!service.clear_due_limits().await);
            assert_eq!(task_field(&service, "t1", "state"), "usage-limited");
            // Only the stuck overlay: the timer waits the bounded retry delay
            // instead of re-sleeping for zero.
            assert_eq!(service.limit_wait(true), Some(LIMIT_RETRY_DELAY));

            service.seed(Task {
                state: "usage-limited".to_owned(),
                limit_prev_state: Some("fixing".to_owned()),
                limit_reset_at: Some(1600),
                ..task("later")
            });
            // A nearer future reset still wakes on time, so the retry delay
            // never holds up another card's normal expiry.
            assert_eq!(service.limit_wait(true), Some(Duration::from_millis(600)));
            assert_eq!(
                service.limit_wait(false),
                Some(Duration::from_millis(0)),
                "an unretried due reset still fires immediately"
            );
        });
    }

    // VERIFY: wave4-lifecycle-14
    /// `shutdown` aborts both loops and removes the `output` listener: a
    /// rate-limit phrase emitted after teardown no longer reaches the board.
    #[test]
    fn shutdown_aborts_the_retention_and_output_loops() {
        run(async {
            let fixture = Fixture::new("shutdown");
            std::fs::write(
                fixture.config().tasks_file,
                r#"{"tasks":[{"id":"t1","title":"T","description":"D","repo":"/r","kind":"plain","ticketDir":"/t","reportDir":"/t","sessionId":"session-0"}],"history":[]}"#,
            )
            .unwrap();
            let (service, bus) = service(
                &fixture,
                FakeSpawner::new(),
                FakeGit::new(),
                fixed_clock(1000),
            );
            service.load().await;
            let (tx, rx) = watch::channel(false);
            service.start_background(&tokio::runtime::Handle::current(), rx);

            // VERIFY: wave6-task_weak-3
            // `Bus::emit` runs listeners inline (`bus.rs:87`), so a recorded
            // tail is a synchronous proof the listener is subscribed — no timed
            // wait is needed on either side of the shutdown.
            bus.emit(&BusEvent::Output {
                id: "session-0".to_owned(),
                data: "before".to_owned(),
            });
            assert_eq!(
                service
                    .state
                    .lock()
                    .unwrap()
                    .tails
                    .get("session-0")
                    .cloned()
                    .as_deref(),
                Some("before")
            );

            service.shutdown();
            assert!(service.background.lock().unwrap().handles.is_empty());
            assert!(service.background.lock().unwrap().subscription.is_none());

            bus.emit(&BusEvent::Output {
                id: "session-0".to_owned(),
                data: "Request rejected (429)".to_owned(),
            });
            // Nothing was in flight (the pre-shutdown chunk does not match the
            // pattern), so both effects are observable with no wait: the
            // listener never ran again and no loop remains to flag the card.
            assert_eq!(
                service
                    .state
                    .lock()
                    .unwrap()
                    .tails
                    .get("session-0")
                    .cloned()
                    .as_deref(),
                Some("before"),
                "the output listener is gone after shutdown"
            );
            assert_ne!(
                service.snapshot()["tasks"][0]["state"],
                json!("rate-limited")
            );
            let _ = tx.send(true);
        });
    }

    // VERIFY: wave6-task_weak-2
    /// The bus holds a `Weak`, so it cannot keep the board (and the state
    /// behind it) alive after the host drops it — the crons invariant, pinned
    /// the same way (`crons.rs` `the_status_listener_holds_a_weak_reference_*`).
    #[test]
    fn the_output_listener_holds_a_weak_reference_to_the_service() {
        let fixture = Fixture::new("weak-listener");
        let (service, bus) = service(&fixture, FakeSpawner::new(), FakeGit::new(), fixed_clock(1));
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel::<LimitEvent>();
        bus.subscribe(service.output_listener(tx));
        let weak = Arc::downgrade(&service);
        drop(service);
        assert!(
            weak.upgrade().is_none(),
            "the bus listener must not own the service"
        );
        // Emitting to the remaining listener is a harmless no-op.
        bus.emit(&BusEvent::Output {
            id: "gone".to_owned(),
            data: "Request rejected (429)".to_owned(),
        });
    }

    // VERIFY: tasks-tests-spawn-failure-cleanup
    #[test]
    fn failed_spawn_cleans_up_the_worktree_it_just_created() {
        run(async {
            let fixture = Fixture::new("spawn-fail");
            let spawner = FakeSpawner::new();
            spawner.fail_spawn();
            let git = FakeGit::new();
            let (service, _bus) = service(&fixture, spawner.clone(), git.clone(), fixed_clock(1));
            let repo = fixture.root.to_string_lossy().into_owned();
            let error = service
                .create(&json!({ "repo": repo, "title": "T", "description": "D" }))
                .await
                .unwrap_err();
            assert_eq!(error.message, "spawn failed");
            assert!(spawner.created().len() == 1);
            let calls = git.calls();
            assert!(
                calls
                    .iter()
                    .any(|call| call[..2] == ["worktree".to_owned(), "remove".to_owned()]),
                "{calls:?}"
            );
            assert!(
                calls
                    .iter()
                    .any(|call| call[..2] == ["branch".to_owned(), "-D".to_owned()]),
                "{calls:?}"
            );
            assert!(service.snapshot()["tasks"].as_array().unwrap().is_empty());
        });
    }

    // VERIFY: tasks-tests-tags-validation
    #[test]
    fn create_validates_required_fields_working_directory_and_tags() {
        run(async {
            let fixture = Fixture::new("create-validation");
            let spawner = FakeSpawner::new();
            let git = FakeGit::new();
            let (service, _bus) = service(&fixture, spawner.clone(), git.clone(), fixed_clock(1));
            assert_eq!(
                service
                    .create(&json!({ "repo": "", "title": " ", "description": "D" }))
                    .await
                    .unwrap_err()
                    .message,
                "repo, title and description required"
            );
            let missing = fixture.root.join("missing").to_string_lossy().into_owned();
            assert_eq!(
                service
                    .create(&json!({ "repo": missing, "title": "T", "description": "D" }))
                    .await
                    .unwrap_err()
                    .message,
                "working directory does not exist"
            );
            let repo = fixture.root.to_string_lossy().into_owned();
            let error = service
                .create(
                    &json!({ "repo": repo, "title": "T", "description": "D", "tags": "backend" }),
                )
                .await
                .unwrap_err();
            assert_eq!(error.message, "tags.map is not a function");
            assert!(!error.persist_failure);
            assert!(
                spawner.created().is_empty(),
                "validation precedes the spawn"
            );
            assert!(service.snapshot()["tasks"].as_array().unwrap().is_empty());
        });
    }

    // VERIFY: tasks-tests-create-success
    #[test]
    fn create_persists_the_card_spawns_with_a_prompt_and_emits_once() {
        run(async {
            let fixture = Fixture::new("create");
            let spawner = FakeSpawner::new();
            let git = FakeGit::new();
            let (service, bus) = service(&fixture, spawner.clone(), git, fixed_clock(1000));
            let emissions = Arc::new(Mutex::new(0));
            let counter = emissions.clone();
            bus.subscribe(Arc::new(move |event| {
                if matches!(event, BusEvent::Tasks(_)) {
                    *counter.lock().unwrap() += 1;
                }
            }));
            let repo = fixture.root.to_string_lossy().into_owned();
            let created = service
                .create(&json!({
                    "repo": repo,
                    "title": "  Fix  ",
                    "description": " Do it ",
                    "tags": [" Backend ", "backend", "", "Bug"],
                    "requirePlanApproval": true,
                    "mergeMode": "auto",
                    "model": "claude-sonnet-5-5",
                    "permissionSettings": { "deny": ["Read(.env)"] }
                }))
                .await
                .unwrap();
            let id = created["id"].as_str().unwrap().to_owned();
            let short: String = id.chars().take(8).collect();
            assert_eq!(created["title"], "Fix");
            assert_eq!(created["description"], "Do it");
            assert_eq!(created["kind"], "git");
            assert_eq!(created["tags"], json!(["backend", "bug"]));
            assert_eq!(created["requirePlanApproval"], true);
            assert_eq!(created["mergeMode"], "auto");
            assert_eq!(created["column"], "todo");
            assert_eq!(created["state"], "analyzing");
            assert_eq!(created["model"], "claude-sonnet-5-5");
            assert_eq!(
                created["worktree"].as_str().unwrap(),
                fixture
                    .root
                    .join(".worktrees")
                    .join(&short)
                    .to_string_lossy()
                    .as_ref()
            );
            assert_eq!(created["branch"], json!(format!("task/{short}")));
            assert_eq!(created["baseBranch"], "main");
            assert!(created["sessionId"].is_string());
            assert_eq!(*emissions.lock().unwrap(), 1);

            let created_inputs = spawner.created();
            assert_eq!(created_inputs.len(), 1);
            assert_eq!(
                created_inputs[0].permission_mode.as_deref(),
                Some("acceptEdits")
            );
            assert_eq!(
                created_inputs[0].extra_args.as_deref(),
                Some(
                    [
                        "--settings".to_owned(),
                        "{\"deny\":[\"Read(.env)\"]}".to_owned()
                    ]
                    .as_slice()
                )
            );
            let prompt = created_inputs[0].prompt.as_deref().unwrap();
            assert!(
                prompt.contains("You are the orchestrator for the task \"Fix\" on a kanban board."),
                "{prompt}"
            );
            assert!(
                prompt.contains("http://127.0.0.1:4317/api/tasks/"),
                "{prompt}"
            );
            assert!(prompt.contains("git worktree"), "{prompt}");

            let saved: Value = serde_json::from_str(
                &std::fs::read_to_string(fixture.config().tasks_file).unwrap(),
            )
            .unwrap();
            assert_eq!(saved["tasks"].as_array().unwrap().len(), 1);
            assert_eq!(saved["history"], json!([]));
            assert_eq!(
                std::fs::read_to_string(
                    fixture
                        .root
                        .join(".tickets")
                        .join(&short)
                        .join("Requirements.md")
                )
                .unwrap(),
                "# Fix\n\nDo it\n"
            );
        });
    }

    // VERIFY: tasks-tests-state-only-no-recreate
    #[test]
    fn state_only_done_update_does_not_recreate_a_cleaned_worktree() {
        run(async {
            let fixture = Fixture::new("no-recreate");
            let git = FakeGit::new();
            let (service, _bus) =
                service(&fixture, FakeSpawner::new(), git.clone(), fixed_clock(1));
            let mut t = task("t1");
            t.kind = TaskKind::Git;
            t.repo = "/repo".to_owned();
            t.worktree = Some("/worktrees/t1".to_owned());
            t.branch = Some("task/t1".to_owned());
            t.base_branch = Some("main".to_owned());
            t.column = "done".to_owned();
            t.state = "complete".to_owned();
            t.done_at = Some(0);
            service.seed(t);
            let before = git.calls().len();
            let updated = service
                .update("t1", &json!({ "state": "complete" }))
                .await
                .unwrap();
            assert_eq!(updated["column"], "done");
            assert_eq!(git.calls().len(), before);
            assert!(!fixture.config().worktrees_dir.exists());
        });
    }

    // VERIFY: tasks-tests-retention
    #[test]
    fn retention_sweep_concludes_only_cards_past_the_window() {
        run(async {
            let fixture = Fixture::new("retention");
            let clock = Arc::new(AtomicI64::new(RETENTION_MS + 10));
            let (service, _bus) = service(
                &fixture,
                FakeSpawner::new(),
                FakeGit::new(),
                mutable_clock(clock),
            );
            let mut stale = task("old");
            stale.column = "done".to_owned();
            stale.state = "complete".to_owned();
            stale.done_at = Some(0);
            service.seed(stale);
            let mut fresh = task("fresh");
            fresh.column = "done".to_owned();
            fresh.state = "complete".to_owned();
            fresh.done_at = Some(RETENTION_MS + 5);
            service.seed(fresh);
            service.sweep_retention().await;
            assert_eq!(service.history_len(), 1);
            let snapshot = service.snapshot();
            assert_eq!(snapshot["history"][0]["id"], "old");
            assert_eq!(snapshot["tasks"].as_array().unwrap().len(), 1);
            assert_eq!(snapshot["tasks"][0]["id"], "fresh");
        });
    }

    // VERIFY: tasks-tests-snapshot-empty
    #[test]
    fn empty_snapshot_is_an_object_with_both_arrays() {
        let fixture = Fixture::new("snapshot");
        let (service, _bus) = service(&fixture, FakeSpawner::new(), FakeGit::new(), fixed_clock(1));
        assert_eq!(service.snapshot(), json!({ "tasks": [], "history": [] }));
    }

    // VERIFY: wave3-tasks-tests-lenient-load
    #[test]
    fn lenient_load_preserves_unrepresentable_values_and_unknown_fields() {
        run(async {
            let fixture = Fixture::new("lenient");
            std::fs::write(
                fixture.config().tasks_file,
                r#"{"tasks":[{"id":"t1","title":"T","description":"D","repo":"/r","kind":"git","ticketDir":"/t","reportDir":"/t","mergeMode":"squash","orchestratorMaxTurns":"6","tags":"backend","customField":{"x":1}}],"history":[]}"#,
            )
            .unwrap();
            let (service, _bus) = service(
                &fixture,
                FakeSpawner::new(),
                FakeGit::new(),
                fixed_clock(1000),
            );
            service.load().await;
            let snapshot = service.snapshot();
            assert_eq!(snapshot["tasks"].as_array().unwrap().len(), 1);
            assert_eq!(snapshot["tasks"][0]["mergeMode"], "squash");
            assert_eq!(snapshot["tasks"][0]["orchestratorMaxTurns"], "6");
            assert_eq!(snapshot["tasks"][0]["tags"], "backend");
            assert_eq!(snapshot["tasks"][0]["customField"], json!({ "x": 1 }));

            // A successful rewrite keeps every unrepresentable value verbatim.
            service
                .update("t1", &json!({ "column": "inprogress" }))
                .await
                .unwrap();
            let saved: Value = serde_json::from_str(
                &std::fs::read_to_string(fixture.config().tasks_file).unwrap(),
            )
            .unwrap();
            let record = &saved["tasks"][0];
            assert_eq!(record["mergeMode"], "squash");
            assert_eq!(record["orchestratorMaxTurns"], "6");
            assert_eq!(record["tags"], "backend");
            assert_eq!(record["customField"], json!({ "x": 1 }));
            assert_eq!(record["column"], "inprogress");
        });
    }

    // VERIFY: wave5-task-reg-8
    #[test]
    fn a_column_move_appends_to_a_raw_transitions_array() {
        run(async {
            let fixture = Fixture::new("raw-transitions");
            std::fs::write(
                fixture.config().tasks_file,
                r#"{"tasks":[{"id":"t1","title":"T","description":"D","repo":"/r","kind":"plain","ticketDir":"/t","reportDir":"/t","column":"todo","state":"analyzing","transitions":[{"from":"todo","to":"inprogress","at":1},{"from":"inprogress","to":"review"}],"createdAt":1,"updatedAt":1}],"history":[]}"#,
            )
            .unwrap();
            let (service, _bus) = service(
                &fixture,
                FakeSpawner::new(),
                FakeGit::new(),
                fixed_clock(1000),
            );
            service.load().await;
            service
                .update("t1", &json!({ "column": "inprogress" }))
                .await
                .unwrap();
            let saved: Value = serde_json::from_str(
                &std::fs::read_to_string(fixture.config().tasks_file).unwrap(),
            )
            .unwrap();
            let transitions = saved["tasks"][0]["transitions"].as_array().unwrap();
            // None of the loaded history is dropped, and the move is appended in
            // Node's shape (`tasks.mjs:531-536`).
            assert_eq!(transitions.len(), 3, "{transitions:?}");
            assert_eq!(
                transitions[0],
                json!({"from": "todo", "to": "inprogress", "at": 1})
            );
            assert_eq!(
                transitions[1],
                json!({"from": "inprogress", "to": "review"})
            );
            assert_eq!(
                transitions[2],
                json!({"from": "todo", "to": "inprogress", "at": 1000})
            );
        });
    }

    // VERIFY: wave5-task-reg-10
    #[test]
    fn legacy_records_keep_omitted_merge_mode_and_session_id() {
        run(async {
            let fixture = Fixture::new("legacy-keys");
            std::fs::write(
                fixture.config().tasks_file,
                r#"{"tasks":[{"id":"t1","title":"T","description":"D","repo":"/r","kind":"plain","ticketDir":"/t","reportDir":"/t","column":"todo","state":"analyzing","transitions":[],"createdAt":1,"updatedAt":1}],"history":[]}"#,
            )
            .unwrap();
            let (service, _bus) = service(
                &fixture,
                FakeSpawner::new(),
                FakeGit::new(),
                fixed_clock(1000),
            );
            service.load().await;
            service
                .update("t1", &json!({ "state": "clarifying" }))
                .await
                .unwrap();
            let saved: Value = serde_json::from_str(
                &std::fs::read_to_string(fixture.config().tasks_file).unwrap(),
            )
            .unwrap();
            let record = saved["tasks"][0].as_object().unwrap();
            // Node spreads the loaded record, so keys it never carried stay
            // `undefined` and `JSON.stringify` omits them.
            assert!(!record.contains_key("mergeMode"), "{record:?}");
            assert!(!record.contains_key("sessionId"), "{record:?}");
        });
    }

    // VERIFY: wave3-tasks-tests-load-blocked
    #[test]
    fn an_unreadable_tasks_file_is_never_overwritten() {
        run(async {
            let fixture = Fixture::new("blocked");
            std::fs::write(
                fixture.config().tasks_file,
                r#"{"tasks":["oops"],"history":[]}"#,
            )
            .unwrap();
            let (service, _bus) = service(
                &fixture,
                FakeSpawner::new(),
                FakeGit::new(),
                fixed_clock(1000),
            );
            service.load().await;
            service.seed(task("t1"));
            let error = service
                .update("t1", &json!({ "column": "inprogress" }))
                .await
                .unwrap_err();
            assert!(error.persist_failure, "{error}");
            assert!(error.message.contains("refusing to overwrite"), "{error}");
            assert!(
                std::fs::read_to_string(fixture.config().tasks_file)
                    .unwrap()
                    .contains("\"oops\""),
                "the unreadable record must still be on disk"
            );
        });
    }

    // VERIFY: wave3-tasks-tests-pos-int
    #[test]
    fn pos_int_matches_js_number_coercion() {
        assert_eq!(pos_int(Some(&json!("0x10"))), Some(16));
        assert_eq!(pos_int(Some(&json!("0b11"))), Some(3));
        assert_eq!(pos_int(Some(&json!("0o17"))), Some(15));
        assert_eq!(pos_int(Some(&json!([5]))), Some(5));
        assert_eq!(pos_int(Some(&json!([1, 2]))), None);
        assert_eq!(pos_int(Some(&json!([true]))), None);
        assert_eq!(pos_int(Some(&json!([]))), None);
        assert_eq!(pos_int(Some(&json!(" 12 "))), Some(12));
        assert_eq!(pos_int(Some(&json!(true))), Some(1));
        assert_eq!(pos_int(Some(&json!("1e3"))), Some(1000));
        assert_eq!(pos_int(Some(&json!("12px"))), None);
        assert_eq!(pos_int(Some(&json!("inf"))), None);
        assert_eq!(pos_int(Some(&json!("Infinity"))), None);
        assert_eq!(pos_int(Some(&json!(-3))), None);
        // `String([[1, null]])` is "1,": a nested null joins as empty.
        // VERIFY: wave5-task-reg-9
        assert_eq!(js_array_to_string(&[json!([1, null])]), "1,");
        assert_eq!(js_string(&json!([[1, null]])), "1,");
        assert_eq!(js_array_to_string(&[json!(1), json!("a")]), "1,a");
    }

    // VERIFY: wave3-tasks-tests-merge-mode-null
    #[test]
    fn plain_tasks_persist_an_explicit_null_merge_mode() {
        run(async {
            let fixture = Fixture::new("merge-null");
            let (service, _bus) = service(
                &fixture,
                FakeSpawner::new(),
                FakeGit::new(),
                fixed_clock(1000),
            );
            service.seed(task("t1"));
            service
                .update("t1", &json!({ "state": "clarifying" }))
                .await
                .unwrap();
            let saved: Value = serde_json::from_str(
                &std::fs::read_to_string(fixture.config().tasks_file).unwrap(),
            )
            .unwrap();
            let record = saved["tasks"][0].as_object().unwrap();
            assert!(record.contains_key("mergeMode"));
            assert_eq!(record["mergeMode"], Value::Null);
        });
    }

    // VERIFY: wave3-tasks-tests-reopen-failure
    #[test]
    fn reopened_done_git_task_propagates_a_worktree_failure() {
        run(async {
            let fixture = Fixture::new("reopen-fail");
            let git = FakeGit::new();
            git.fail_worktree_add.store(true, Ordering::SeqCst);
            let (service, _bus) = service(&fixture, FakeSpawner::new(), git, fixed_clock(1000));
            let mut t = task("t1");
            t.kind = TaskKind::Git;
            t.worktree = Some("/missing/t1".to_owned());
            t.branch = Some("task/t1".to_owned());
            t.base_branch = Some("main".to_owned());
            t.column = "done".to_owned();
            t.state = "complete".to_owned();
            t.done_at = Some(0);
            service.seed(t);
            let error = service
                .update("t1", &json!({ "column": "inreview" }))
                .await
                .unwrap_err();
            assert!(!error.persist_failure, "{error}");
            assert!(error.message.contains("worktree add"), "{error}");
            // The committed transition survived the reported error.
            assert_eq!(service.snapshot()["tasks"][0]["column"], "inreview");
        });
    }

    // VERIFY: wave3-tasks-tests-done-remove-failure
    #[test]
    fn done_transition_propagates_a_registry_remove_failure() {
        run(async {
            let fixture = Fixture::new("done-remove-fail");
            let spawner = FakeSpawner::new();
            spawner.fail_remove();
            let (service, _bus) = service(&fixture, spawner, FakeGit::new(), fixed_clock(1000));
            let mut t = task("t1");
            t.session_id = Some("session-0".to_owned());
            service.seed(t);
            let error = service
                .update("t1", &json!({ "column": "done" }))
                .await
                .unwrap_err();
            assert!(!error.persist_failure, "{error}");
            assert!(error.message.contains("registry remove failed"), "{error}");
            assert_eq!(service.snapshot()["tasks"][0]["column"], "done");
        });
    }

    // VERIFY: wave3-tasks-tests-create-persist-parity
    #[test]
    fn create_persist_failure_keeps_the_spawned_session_and_card() {
        run(async {
            let fixture = Fixture::new("create-persist-fail");
            let spawner = FakeSpawner::new();
            let (service, _bus) =
                service(&fixture, spawner.clone(), FakeGit::new(), fixed_clock(1000));
            // A directory at the target path makes the atomic write fail.
            std::fs::create_dir_all(fixture.config().tasks_file).unwrap();
            let repo = fixture.root.to_string_lossy().into_owned();
            let error = service
                .create(&json!({ "repo": repo, "title": "T", "description": "D" }))
                .await
                .unwrap_err();
            assert!(error.persist_failure, "{error}");
            // Node parity (tasks.mjs:479-482): only the worktree/branch is
            // cleaned up; the session stays live and the card stays visible.
            assert_eq!(spawner.created().len(), 1);
            assert!(spawner.is_live("session-0"));
            let snapshot = service.snapshot();
            assert_eq!(snapshot["tasks"].as_array().unwrap().len(), 1);
            assert_eq!(snapshot["tasks"][0]["sessionId"], "session-0");
        });
    }
}
