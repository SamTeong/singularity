//! Native port of `server/history.mjs`: daily work timeline.
//!
//! Scans the claude + codex transcripts the transcript service already knows,
//! buckets their messages into machine-local calendar days, produces one
//! summarized entry per day and persists it to `<STATE_DIR>/history.jsonl`
//! (append-only, last line per date wins on read). Today is always computed
//! live and never persisted.
//!
//! Every dependency the Node module imported is injected here: the clock, the
//! transcript reader (`transcript_service` + `stats`), the configured
//! summariser (`state/models.json` + `prompt_run`) and the event bus.
//! `HistoryService` is shared as an `Arc`; `get`/`regenerate`/`live_today`
//! are async and the blocking filesystem scan rides `spawn_blocking`.
use crate::bus::{Bus, BusEvent};
use crate::fs_atomic::write_atomic;
use crate::prompt_run::{PromptRunDeps, PromptRunOpts, run_prompt_with_metadata};
use crate::stats::Num;
use crate::transcript_service::{Inputs, ListOptions, ReadOptions, SessionRow, TranscriptService};
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

/// `BACKFILL_DAYS` (`server/history.mjs:19`).
pub const BACKFILL_DAYS: f64 = 7.0;
/// `TRIVIAL_TURNS`: a smaller day skips the LLM for a deterministic one-liner.
const TRIVIAL_TURNS: u64 = 3;
const USER_TRUNC: usize = 400;
const ASSISTANT_TRUNC: usize = 800;
const BULLET_TRUNC: usize = 120;
const DIGEST_CAP: usize = 48_000;
const LIST_CAP: usize = 5000;
const SESSION_CACHE_CAP: usize = 200;

// VERIFY: history.rs: pub const SUMMARY_SYSTEM
/// `SUMMARY_SYSTEM` (`server/history.mjs:29-38`), verbatim.
pub const SUMMARY_SYSTEM: &str = "Summarize one day of coding-agent transcripts into strict JSON {\"projects\":[{\"path\":string,\"bullets\":string[]}],\"topics\":string[]}. One projects entry per distinct \"## <path>\" header in the input, path copied verbatim (several blocks may share a path — merge them). Order each project's bullets by how much work went into them: the input blocks arrive highest-effort first (each header carries its turn and token count), so keep that order. topics: 2-5 short lowercase kebab-case tags for the whole day. Output JSON only — no prose, no markdown fence.\n\
bullets: 1-3 per project, written for a clever reader who has never seen this codebase. Every bullet follows all of these:\n\
1. Under 12 words. One idea. A second idea becomes its own bullet or gets dropped.\n\
2. Plain past tense, active voice, no trailing period.\n\
3. Say what changed and what it now does for the person using it. Leave out how it was built: no file names, class or function names, flags, library names, test counts, error codes.\n\
4. Use the everyday word: \"page\" over \"view component\", \"saves as you type\" over \"implemented autosave handler\", \"loads faster\" over \"reduced latency\".\n\
5. No comma-stacked lists, no semicolons, no \"and also\".\n\
6. No hype: drop \"leveraged\", \"robust\", \"comprehensive\", \"seamless\", \"streamlined\", \"significantly\". No sentence built on a contrast with what it is not.\n\
7. Nothing about the session, the agent, the transcript, or this summary.\n\
Good: \"history page now opens without a wait\". Bad: \"implemented concurrent ensureHistory deduplication via shared in-flight promise\".";

const GUIDANCE_WRAPPER: &str = "Write every bullet in plain, specific human prose. Apply these rules from the declawed skill to the wording only; the output format stays exactly as requested above/below:\n\n";

// ---- Clock -----------------------------------------------------------------

// VERIFY: history.rs: pub trait Clock
/// Injected wall clock and local-time math. Node used `Date#toLocaleDateString`
/// and `Date#setHours(0,0,0,0)`; tests pin a fixed zone through this seam.
pub trait Clock: Send + Sync {
    fn now_ms(&self) -> f64;
    /// `new Date().toISOString()` for `builtAt`.
    fn now_iso(&self) -> String;
    /// `localDay(ts)` — machine-local `YYYY-MM-DD`.
    fn local_day(&self, ts_ms: f64) -> String;
    /// `startOfLocalDay(new Date(ts)).getTime()`.
    fn start_of_local_day_ms(&self, ts_ms: f64) -> f64;
    /// `startOfLocalDay(new Date(\`<date>T00:00:00\`))` — `None` when the
    /// calendar date does not exist.
    fn start_of_local_day_ymd(&self, year: i32, month: u8, day: u8) -> Option<f64>;
}

// VERIFY: history.rs: pub struct SystemClock
/// The daemon clock: `time` for arithmetic, the platform timezone API for the
/// per-instant UTC offset (`time`'s local-offset support is not enabled).
pub struct SystemClock;

impl Clock for SystemClock {
    fn now_ms(&self) -> f64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|elapsed| elapsed.as_secs_f64() * 1000.0)
            .unwrap_or(0.0)
    }

    fn now_iso(&self) -> String {
        iso_from_ms(self.now_ms())
    }

    fn local_day(&self, ts_ms: f64) -> String {
        local_day_at(ts_ms)
    }

    fn start_of_local_day_ms(&self, ts_ms: f64) -> f64 {
        let day = local_day_at(ts_ms);
        parse_ymd(&day)
            .and_then(|(year, month, date)| local_midnight_ymd(year, month, date))
            .unwrap_or_else(|| (ts_ms / 1000.0).floor() * 1000.0)
    }

    fn start_of_local_day_ymd(&self, year: i32, month: u8, day: u8) -> Option<f64> {
        local_midnight_ymd(year, month, day)
    }
}

fn local_day_at(ts_ms: f64) -> String {
    let secs = (ts_ms / 1000.0).floor() as i64;
    let local = secs + i64::from(local_offset_secs_at(secs));
    let Ok(stamp) = time::OffsetDateTime::from_unix_timestamp(local) else {
        return String::new();
    };
    format!(
        "{:04}-{:02}-{:02}",
        stamp.year(),
        u8::from(stamp.month()),
        stamp.day()
    )
}

fn local_midnight_ymd(year: i32, month: u8, day: u8) -> Option<f64> {
    let date =
        time::Date::from_calendar_date(year, time::Month::try_from(month).ok()?, day).ok()?;
    // A two-pass offset fixed point converged to the later midnight when a
    // zone folds at 00:00 east of UTC (Asia/Amman 2018-10-26), while V8's
    // `new Date(y, m - 1, d)` takes the earlier instant. Share the parser's
    // V8-compatible civil conversion instead.
    crate::usage_snapshot::local_to_epoch_ms(date, time::Time::MIDNIGHT).map(|ms| ms as f64)
}

fn iso_from_ms(ts_ms: f64) -> String {
    let secs = (ts_ms / 1000.0).floor() as i64;
    let millis = (ts_ms - secs as f64 * 1000.0).round().clamp(0.0, 999.0) as u32;
    let Ok(stamp) = time::OffsetDateTime::from_unix_timestamp(secs) else {
        return String::new();
    };
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        stamp.year(),
        u8::from(stamp.month()),
        stamp.day(),
        stamp.hour(),
        stamp.minute(),
        stamp.second()
    )
}

/// Local UTC offset in seconds east of UTC at one instant (DST-aware), from the
/// zone the writer and parser share.
fn local_offset_secs_at(utc_secs: i64) -> i32 {
    crate::usage_snapshot::local_offset_secs_at(utc_secs)
}

fn parse_ymd(text: &str) -> Option<(i32, u8, u8)> {
    let bytes = text.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    let year = text[0..4].parse::<i32>().ok()?;
    let month = text[5..7].parse::<u8>().ok()?;
    let day = text[8..10].parse::<u8>().ok()?;
    time::Date::from_calendar_date(year, time::Month::try_from(month).ok()?, day).ok()?;
    Some((year, month, day))
}

// ---- Transcript seam -------------------------------------------------------

// VERIFY: history.rs: pub struct TranscriptSession
/// The `sessions.mjs` list row fields History consumes.
#[derive(Clone, Debug)]
pub struct TranscriptSession {
    pub id: String,
    pub project: String,
    pub cwd: Option<String>,
    pub title: Option<String>,
    pub source: String,
    pub file: Option<String>,
    pub mtime: f64,
    pub size: u64,
}

// VERIFY: history.rs: pub struct TranscriptMessage
/// One parser message (`{ts, role, kind, text, recap}`).
#[derive(Clone, Debug)]
pub struct TranscriptMessage {
    pub ts_ms: Option<f64>,
    pub role: String,
    pub kind: String,
    pub text: String,
    pub recap: bool,
}

// VERIFY: history.rs: pub struct SessionMessages
/// `readSession`'s `{ok, messages}` — `ok: false` means the row is skipped,
/// exactly as `scanDays` does.
#[derive(Clone, Debug, Default)]
pub struct SessionMessages {
    pub ok: bool,
    pub messages: Vec<TranscriptMessage>,
}

// VERIFY: history.rs: pub struct SessionTotals
/// `parseSession`/`parseCodexRollout` reduced to what History prorates.
#[derive(Clone, Copy, Debug, Default)]
pub struct SessionTotals {
    pub exists: bool,
    pub tokens: f64,
    pub est_cost_usd: Option<f64>,
}

// VERIFY: history.rs: pub trait TranscriptSource
/// Injected transcript reader. The production implementation is
/// [`NativeTranscriptSource`]; tests supply fixtures with no filesystem.
pub trait TranscriptSource: Send + Sync {
    fn list(&self, root: Option<&str>, cap: usize) -> Result<Vec<TranscriptSession>, String>;
    fn read_session(&self, row: &TranscriptSession, root: Option<&str>) -> SessionMessages;
    fn totals(&self, row: &TranscriptSession, root: Option<&str>) -> SessionTotals;
}

// VERIFY: history.rs: pub struct NativeTranscriptSource
/// `listSessions` + `readSession` through `transcript_service`, and
/// `parseSession`/`parseCodexRollout` through `stats`.
pub struct NativeTranscriptSource {
    transcripts: TranscriptService,
    stats: Mutex<crate::stats::StatsService>,
}

// VERIFY: history.rs: impl NativeTranscriptSource::new
impl NativeTranscriptSource {
    pub fn new(inputs: Inputs) -> Self {
        Self {
            transcripts: TranscriptService::new(inputs),
            stats: Mutex::new(crate::stats::StatsService::default()),
        }
    }

    /// See [`TranscriptService::with_catalog_source`].
    pub fn with_catalog_source(
        mut self,
        source: Arc<dyn Fn() -> Vec<Value> + Send + Sync>,
    ) -> Self {
        self.transcripts = self.transcripts.with_catalog_source(source);
        self
    }
}

impl TranscriptSource for NativeTranscriptSource {
    fn list(&self, root: Option<&str>, cap: usize) -> Result<Vec<TranscriptSession>, String> {
        let rows = self
            .transcripts
            .list(&ListOptions {
                root: root.map(str::to_owned),
                cap,
                ..ListOptions::default()
            })
            .map_err(|error| error.to_string())?;
        Ok(rows.into_iter().map(row_data).collect())
    }

    fn read_session(&self, row: &TranscriptSession, root: Option<&str>) -> SessionMessages {
        let options = ReadOptions {
            root: root.map(str::to_owned),
            source: Some(row.source.clone()),
            file: row.file.clone(),
        };
        let Ok(Some(text)) = self.transcripts.read(&row.project, &row.id, &options) else {
            return SessionMessages::default();
        };
        let Ok(value) = serde_json::from_str::<Value>(&text) else {
            return SessionMessages::default();
        };
        let ok = value.get("ok").and_then(Value::as_bool).unwrap_or(false);
        if !ok {
            return SessionMessages::default();
        }
        let messages = value
            .get("messages")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .map(|item| TranscriptMessage {
                        ts_ms: item.get("ts").and_then(ts_ms),
                        role: item
                            .get("role")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_owned(),
                        kind: item
                            .get("kind")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_owned(),
                        text: item
                            .get("text")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_owned(),
                        recap: item.get("recap").and_then(Value::as_bool).unwrap_or(false),
                    })
                    .collect()
            })
            .unwrap_or_default();
        SessionMessages { ok: true, messages }
    }

    fn totals(&self, row: &TranscriptSession, root: Option<&str>) -> SessionTotals {
        let mut stats = self.stats.lock().unwrap_or_else(|error| error.into_inner());
        let parsed = if row.source == "codex" {
            row.file
                .as_deref()
                .and_then(|file| self.transcripts.path_for_codex(file))
                .map(|path| stats.parse_codex_rollout(&path))
        } else {
            row.cwd.as_ref().and_then(|_| {
                self.transcripts
                    .path_for(&row.project, &row.id, root)
                    .map(|path| stats.parse_by_path(&path))
            })
        };
        let Some(parsed) = parsed else {
            return SessionTotals::default();
        };
        let value = serde_json::to_value(&parsed).unwrap_or(Value::Null);
        SessionTotals {
            exists: value
                .get("exists")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            tokens: value.get("tokens").and_then(Value::as_f64).unwrap_or(0.0),
            est_cost_usd: value.get("estCostUsd").and_then(Value::as_f64),
        }
    }
}

fn row_data(row: SessionRow) -> TranscriptSession {
    TranscriptSession {
        id: row.id,
        project: row.project,
        cwd: raw_string(row.cwd.as_deref()),
        title: raw_string(row.title.as_deref()),
        source: row.source.unwrap_or_else(|| "claude".to_owned()),
        file: row.file,
        mtime: row.mtime,
        size: row.size,
    }
}

fn raw_string(raw: Option<&serde_json::value::RawValue>) -> Option<String> {
    let token = raw?.get();
    if token == "null" {
        return None;
    }
    serde_json::from_str::<String>(token).ok()
}

fn ts_ms(value: &Value) -> Option<f64> {
    match value {
        Value::Number(number) => number.as_f64(),
        Value::String(text) => {
            time::OffsetDateTime::parse(text, &time::format_description::well_known::Rfc3339)
                .ok()
                .map(|stamp| stamp.unix_timestamp_nanos() as f64 / 1_000_000.0)
        }
        _ => None,
    }
}

// ---- Summariser seam -------------------------------------------------------

// VERIFY: history.rs: pub struct SummaryModel
/// `getSummariser()`'s `{id, group}` (`server/model-store.mjs`).
#[derive(Clone, Debug)]
pub struct SummaryModel {
    pub id: String,
    pub group: String,
}

// VERIFY: history.rs: pub struct SummaryAnswer
/// `defaultCallSummariser`'s answer: text plus claude's usage counts.
#[derive(Clone, Debug)]
pub struct SummaryAnswer {
    pub text: String,
    pub input_tokens: Option<f64>,
    pub output_tokens: Option<f64>,
}

// VERIFY: history.rs: pub trait DaySummariser
/// Injected LLM rung. `Err` is the thrown `e.message` carried as
/// `llm.error`.
pub trait DaySummariser: Send + Sync {
    fn call<'a>(
        &'a self,
        prompt: &'a str,
        model: &'a SummaryModel,
    ) -> Pin<Box<dyn Future<Output = Result<SummaryAnswer, String>> + Send + 'a>>;
}

// VERIFY: history.rs: pub struct PromptRunSummariser
/// The production rung: `runOneShotPrompt` via `prompt_run`.
pub struct PromptRunSummariser(pub PromptRunDeps);

impl DaySummariser for PromptRunSummariser {
    fn call<'a>(
        &'a self,
        prompt: &'a str,
        model: &'a SummaryModel,
    ) -> Pin<Box<dyn Future<Output = Result<SummaryAnswer, String>> + Send + 'a>> {
        Box::pin(async move {
            let answer = run_prompt_with_metadata(
                &self.0,
                &model.group,
                &model.id,
                prompt,
                PromptRunOpts::default(),
            )
            .await?;
            if model.group != "claude" {
                return Ok(SummaryAnswer {
                    text: answer.answer,
                    input_tokens: None,
                    output_tokens: None,
                });
            }
            let envelope: Value =
                serde_json::from_str(&answer.answer).map_err(|error| error.to_string())?;
            let text = envelope
                .get("result")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .ok_or_else(|| "summariser response had no result field".to_owned())?;
            let usage = envelope.get("usage");
            Ok(SummaryAnswer {
                text,
                input_tokens: usage
                    .and_then(|usage| usage.get("input_tokens"))
                    .and_then(Value::as_f64),
                output_tokens: usage
                    .and_then(|usage| usage.get("output_tokens"))
                    .and_then(Value::as_f64),
            })
        })
    }
}

// VERIFY: history.rs: pub trait ModelStore
/// `getSummariser()` — re-read on every call so installing a model takes effect
/// without a restart.
pub trait ModelStore: Send + Sync {
    fn summariser_model(&self) -> Option<SummaryModel>;
}

// VERIFY: history.rs: pub struct NativeModelStore
/// Reads `<STATE_DIR>/models.json` through `models::summariser`.
pub struct NativeModelStore {
    pub models_path: PathBuf,
}

impl ModelStore for NativeModelStore {
    fn summariser_model(&self) -> Option<SummaryModel> {
        let value = crate::models::summariser(&self.models_path.to_string_lossy());
        Some(SummaryModel {
            id: value.get("id")?.as_str()?.to_owned(),
            group: value.get("group")?.as_str()?.to_owned(),
        })
    }
}

// ---- Declawed guidance -----------------------------------------------------

// VERIFY: history.rs: pub fn declawed_guidance
/// `declawedGuidance` (`server/history.mjs:45`): the Phase 2 slice, trimmed, up
/// to (not including) Phase 3. Missing/unreadable file or no Phase 2 heading
/// yields `''`.
pub fn declawed_guidance(skill_file: &Path) -> String {
    let Ok(bytes) = std::fs::read(skill_file) else {
        return String::new();
    };
    let text = String::from_utf8_lossy(&bytes);
    let Some(start) = phase2_re().find(&text) else {
        return String::new();
    };
    let from = start.start();
    let to = phase3_re()
        .find(&text[from..])
        .map_or(text.len(), |phase| from + phase.start());
    text[from..to].trim_matches(is_js_space).to_owned()
}

fn phase2_re() -> &'static regex::Regex {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r"(?m)^## Phase 2.*$").expect("constant regex is valid"))
}

fn phase3_re() -> &'static regex::Regex {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r"(?m)^## Phase 3.*$").expect("constant regex is valid"))
}

fn is_js_space(character: char) -> bool {
    character.is_whitespace() || character == '\u{FEFF}'
}

// ---- Model -----------------------------------------------------------------

#[derive(Clone, Debug, Default)]
struct DayBucket {
    user_texts: Vec<String>,
    last_assistant_text: Option<String>,
    recap_text: Option<String>,
    turns: u64,
}

#[derive(Clone, Debug)]
struct SessionAgg {
    id: String,
    project: String,
    cwd: Option<String>,
    source: String,
    title: Option<String>,
    turns: u64,
    day_turns: u64,
    day_tokens: f64,
    user_texts: Vec<String>,
    last_assistant_text: Option<String>,
    recap_text: Option<String>,
}

#[derive(Clone, Debug, Default)]
struct Metrics {
    sessions: u64,
    turns: u64,
    tokens: f64,
    cost_usd: f64,
    by_harness: Vec<(String, u64, u64)>,
}

impl Metrics {
    fn add_harness(&mut self, harness: &str, turns: u64) {
        match self
            .by_harness
            .iter_mut()
            .find(|(name, _, _)| name == harness)
        {
            Some((_, sessions, tally)) => {
                *sessions += 1;
                *tally += turns;
            }
            None => self.by_harness.push((harness.to_owned(), 1, turns)),
        }
    }
}

#[derive(Clone, Debug, Default)]
struct DayAgg {
    sessions: Vec<SessionAgg>,
    metrics: Metrics,
}

fn empty_day_agg() -> DayAgg {
    DayAgg::default()
}

struct DaySummary {
    projects: Vec<Value>,
    topics: Vec<String>,
    llm: Value,
}

// ---- Paths and persistence -------------------------------------------------

// VERIFY: history.rs: pub struct HistoryBins
/// `agents.mjs`' `resolveBin` results (`None` when unset), the `binFor` gate.
#[derive(Clone, Debug, Default)]
pub struct HistoryBins {
    pub claude: Option<PathBuf>,
    pub ollama: Option<PathBuf>,
    pub codex: Option<PathBuf>,
}

// VERIFY: history.rs: pub struct HistoryDeps
/// Everything the host must supply. `state_dir`/`usage_state` are the Node
/// `STATE_DIR` and `USAGE_SKILL_STATE` (`cost-state/` and `stats.csv` back the
/// cost figures); `home` is `os.homedir()` (declawed skill lookup).
pub struct HistoryDeps {
    pub state_dir: PathBuf,
    pub usage_state: PathBuf,
    pub home: PathBuf,
    pub bins: HistoryBins,
    pub bus: Bus,
    pub clock: Arc<dyn Clock>,
    pub transcripts: Arc<dyn TranscriptSource>,
    pub summariser: Arc<dyn DaySummariser>,
    pub models: Arc<dyn ModelStore>,
}

// VERIFY: history.rs: pub struct HistoryQuery
/// GET `/api/history`'s coerced query. `days` is already
/// `Number(req.query.days) || 7`.
#[derive(Clone, Debug)]
pub struct HistoryQuery {
    pub days: f64,
    pub from: Option<String>,
    pub to: Option<String>,
}

/// `Number(value) || 7` for the GET route.
pub fn normalize_days(days: f64) -> f64 {
    if !days.is_finite() || days == 0.0 {
        BACKFILL_DAYS
    } else {
        days
    }
}

// VERIFY: history.rs: pub fn read_history
/// `readHistory` (`server/history.mjs:97`): parse every line, last line wins
/// per date, ascending by date.
pub fn read_history(file: &Path) -> Vec<Value> {
    let Ok(text) = std::fs::read_to_string(file) else {
        return Vec::new();
    };
    let mut by_date: HashMap<String, Value> = HashMap::new();
    for line in text.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        if line.is_empty() {
            continue;
        }
        let Ok(entry) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let Some(date) = entry.get("date").and_then(Value::as_str) else {
            continue;
        };
        if date.is_empty() {
            continue;
        }
        by_date.insert(date.to_owned(), entry);
    }
    let mut entries: Vec<Value> = by_date.into_values().collect();
    entries.sort_by(|a, b| entry_date(a).cmp(entry_date(b)));
    entries
}

fn entry_date(entry: &Value) -> &str {
    entry.get("date").and_then(Value::as_str).unwrap_or("")
}

fn append_entry(file: &Path, entry: &Value) -> Result<(), String> {
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir).map_err(|error| error.to_string())?;
    }
    let mut line = serde_json::to_string(entry).map_err(|error| error.to_string())?;
    line.push('\n');
    use std::io::Write;
    let mut handle = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(file)
        .map_err(|error| error.to_string())?;
    handle
        .write_all(line.as_bytes())
        .map_err(|error| error.to_string())
}

// ---- stats.csv costs -------------------------------------------------------

#[derive(Default)]
struct StatsCsvCosts {
    mtime: f64,
    size: u64,
    map: HashMap<String, f64>,
}

impl StatsCsvCosts {
    /// `readStatsCsvCosts` (`server/stats.mjs:277`), cached on (mtime, size).
    fn read(&mut self, path: &Path) -> HashMap<String, f64> {
        let Ok(meta) = std::fs::metadata(path) else {
            return HashMap::new();
        };
        let mtime = meta
            .modified()
            .ok()
            .and_then(|stamp| stamp.duration_since(UNIX_EPOCH).ok())
            .map(|elapsed| elapsed.as_secs_f64() * 1000.0)
            .unwrap_or(0.0);
        let size = meta.len();
        if mtime == self.mtime && size == self.size {
            return self.map.clone();
        }
        let Ok(text) = std::fs::read_to_string(path) else {
            return HashMap::new();
        };
        struct Acc {
            est: f64,
            billed: f64,
            corrected: bool,
        }
        let mut acc: HashMap<String, Acc> = HashMap::new();
        for line in text.split('\n') {
            if line.is_empty() {
                continue;
            }
            let mut columns = line.split(',');
            let _stamp = columns.next();
            let Some(id) = columns.next() else { continue };
            let Some(billed_field) = columns.next() else {
                continue;
            };
            if id.is_empty() || id == "session_id" {
                continue;
            }
            let est_start = line.rfind(',').map_or(line.len(), |index| index + 1);
            let est_field = &line[est_start..];
            let est = if est_field.is_empty() {
                f64::NAN
            } else {
                js_number(est_field)
            };
            let billed = js_number(billed_field);
            let has_est = est.is_finite() && est > 0.0;
            let has_billed = billed.is_finite() && billed > 0.0;
            let acc = acc.entry(id.to_owned()).or_insert(Acc {
                est: 0.0,
                billed: 0.0,
                corrected: false,
            });
            if has_est && has_billed {
                acc.corrected = true;
            }
            if has_est && est > acc.est {
                acc.est = est;
            }
            if has_billed && billed > acc.billed {
                acc.billed = billed;
            }
        }
        let map: HashMap<String, f64> = acc
            .into_iter()
            .filter_map(|(id, acc)| {
                let cost = if acc.corrected {
                    acc.est
                } else {
                    acc.est.max(acc.billed)
                };
                (cost > 0.0).then_some((id, cost))
            })
            .collect();
        self.mtime = mtime;
        self.size = size;
        self.map = map.clone();
        map
    }
}

fn read_cost_usd(cost_dir: &Path, id: &str) -> Option<f64> {
    let value = serde_json::to_value(crate::stats::read_cost_file(cost_dir, id)).ok()?;
    value.get("costUsd").and_then(Value::as_f64)
}

// ---- JavaScript helpers ----------------------------------------------------

fn js_number(text: &str) -> f64 {
    let trimmed = text.trim_matches(is_js_space);
    if trimmed.is_empty() {
        return 0.0;
    }
    let (sign, digits) = match trimmed.strip_prefix('-') {
        Some(rest) => (-1.0, rest),
        None => (1.0, trimmed.strip_prefix('+').unwrap_or(trimmed)),
    };
    if digits.eq_ignore_ascii_case("infinity") {
        return sign * f64::INFINITY;
    }
    for (prefix, radix) in [("0x", 16), ("0o", 8), ("0b", 2)] {
        if let Some(rest) = digits
            .strip_prefix(prefix)
            .or_else(|| digits.strip_prefix(&prefix.to_uppercase()))
        {
            return u64::from_str_radix(rest, radix)
                .map(|value| sign * value as f64)
                .unwrap_or(f64::NAN);
        }
    }
    digits
        .parse::<f64>()
        .map(|value| sign * value)
        .unwrap_or(f64::NAN)
}

/// `Math.round` for the non-negative quantities History rounds.
fn js_round(value: f64) -> f64 {
    if value.is_finite() {
        (value + 0.5).floor()
    } else {
        value
    }
}

fn num_text(value: f64) -> String {
    serde_json::to_string(&Num(value)).unwrap_or_else(|_| "0".to_owned())
}

fn opt_num(value: Option<f64>) -> Value {
    match value {
        Some(value) => json!(Num(value)),
        None => Value::Null,
    }
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(number) => number.as_f64().is_some_and(|value| value != 0.0),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

fn js_string(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Number(number) => number.to_string(),
        Value::Bool(value) => value.to_string(),
        Value::Null => "null".to_owned(),
        Value::Array(items) => items.iter().map(js_string).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".to_owned(),
    }
}

/// `String#slice(0, n)` in UTF-16 code units (a split surrogate becomes U+FFFD).
fn slice_units(text: &str, cap: usize) -> String {
    let units: Vec<u16> = text.encode_utf16().collect();
    if units.len() <= cap {
        return text.to_owned();
    }
    String::from_utf16_lossy(&units[..cap])
}

fn units_len(text: &str) -> usize {
    text.encode_utf16().count()
}

fn trunc(text: &str, cap: usize) -> String {
    let units: Vec<u16> = text.encode_utf16().collect();
    if units.len() > cap {
        format!("{}…", String::from_utf16_lossy(&units[..cap]))
    } else {
        text.to_owned()
    }
}

fn flatten(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn bullet(text: &str) -> String {
    trunc(flatten(text).trim(), BULLET_TRUNC)
}

fn blurb_of(texts: &[String]) -> Option<String> {
    let text = texts
        .iter()
        .find(|text| !text.is_empty() && !text.trim().is_empty())?;
    Some(slice_units(flatten(text).trim(), 140))
}

fn repo_name(cwd: &str) -> Option<String> {
    cwd.split(['\\', '/'])
        .filter(|part| !part.is_empty())
        .next_back()
        .map(str::to_owned)
}

fn noise_regexes() -> &'static Vec<regex::Regex> {
    static RE: OnceLock<Vec<regex::Regex>> = OnceLock::new();
    RE.get_or_init(|| {
        [
            r"(?i)^you are an adversarial code reviewer",
            r"(?i)^<local-command-caveat>",
            r"(?i)^the following is the codex agent history",
        ]
        .iter()
        .map(|pattern| regex::Regex::new(pattern).expect("constant regex is valid"))
        .collect()
    })
}

fn is_noise_session(session: &SessionAgg) -> bool {
    let text = session
        .title
        .clone()
        .filter(|title| !title.is_empty())
        .or_else(|| blurb_of(&session.user_texts))
        .unwrap_or_default();
    let text = text.trim();
    noise_regexes().iter().any(|re| re.is_match(text))
}

fn effort(session: &SessionAgg) -> f64 {
    session.day_tokens * 1000.0 + session.day_turns as f64
}

fn json_blob(text: &str) -> Option<&str> {
    let start = text.find('{')?;
    let end = text.rfind('}')?;
    (end >= start).then(|| &text[start..=end])
}

fn parse_json_summary(text: &str) -> Option<DaySummary> {
    let object: Value = serde_json::from_str(json_blob(text)?).ok()?;
    let mut projects = Vec::new();
    let raw_projects = object
        .get("projects")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for project in raw_projects {
        let Some(path) = project.get("path").filter(|path| truthy(path)) else {
            continue;
        };
        let Some(bullets) = project.get("bullets").and_then(Value::as_array) else {
            continue;
        };
        let bullets: Vec<String> = bullets
            .iter()
            .filter(|item| truthy(item) && !js_string(item).trim().is_empty())
            .take(3)
            .map(|item| bullet(&js_string(item)))
            .collect();
        if bullets.is_empty() {
            continue;
        }
        projects.push(json!({ "path": js_string(path), "bullets": bullets }));
    }
    if projects.is_empty() {
        return None;
    }
    let topics = object
        .get("topics")
        .and_then(Value::as_array)
        .map(|items| items.iter().take(5).map(js_string).collect())
        .unwrap_or_default();
    Some(DaySummary {
        projects,
        topics,
        llm: Value::Null,
    })
}

fn deterministic_summary(sessions: &[&SessionAgg]) -> DaySummary {
    let mut by_path: Vec<(String, Vec<&SessionAgg>)> = Vec::new();
    for session in sessions {
        let key = session
            .cwd
            .clone()
            .filter(|cwd| !cwd.is_empty())
            .or_else(|| Some(session.project.clone()).filter(|project| !project.is_empty()))
            .unwrap_or_else(|| "unknown".to_owned());
        match by_path.iter_mut().find(|(path, _)| path == &key) {
            Some((_, list)) => list.push(session),
            None => by_path.push((key, vec![session])),
        }
    }
    let projects = by_path
        .into_iter()
        .map(|(path, mut list)| {
            list.sort_by(|a, b| effort(b).total_cmp(&effort(a)));
            let bullets: Vec<String> = list
                .iter()
                .take(3)
                .map(|session| {
                    bullet(
                        &session
                            .title
                            .clone()
                            .filter(|title| !title.is_empty())
                            .or_else(|| blurb_of(&session.user_texts))
                            .unwrap_or_else(|| session.id.clone()),
                    )
                })
                .collect();
            json!({ "path": path, "bullets": bullets })
        })
        .collect();
    DaySummary {
        projects,
        topics: Vec::new(),
        llm: Value::Null,
    }
}

fn session_digest(session: &SessionAgg) -> String {
    let path = session
        .cwd
        .clone()
        .filter(|cwd| !cwd.is_empty())
        .unwrap_or_else(|| session.project.clone());
    let mut lines = vec![format!(
        "## {path} ({}, {} turns, {} tokens)",
        session.source,
        session.day_turns,
        num_text(session.day_tokens)
    )];
    if let Some(recap) = &session.recap_text {
        lines.push(format!("[recap] {}", trunc(recap, USER_TRUNC)));
    }
    for text in &session.user_texts {
        lines.push(format!("[user] {}", trunc(text, USER_TRUNC)));
    }
    if let Some(text) = &session.last_assistant_text {
        lines.push(format!("[assistant] {}", trunc(text, ASSISTANT_TRUNC)));
    }
    lines.join("\n")
}

fn compressed_digest(session: &SessionAgg) -> String {
    let path = session
        .cwd
        .clone()
        .filter(|cwd| !cwd.is_empty())
        .unwrap_or_else(|| session.project.clone());
    let mut lines = vec![format!(
        "## {path} ({}, {} turns, {} tokens — compressed)",
        session.source,
        session.day_turns,
        num_text(session.day_tokens)
    )];
    if let Some(recap) = &session.recap_text {
        lines.push(format!("[recap] {}", trunc(recap, USER_TRUNC)));
    }
    if let Some(text) = &session.last_assistant_text {
        lines.push(format!("[assistant] {}", trunc(text, ASSISTANT_TRUNC)));
    }
    lines.join("\n")
}

/// `buildDigest` (`server/history.mjs:256`): full detail when the day fits the
/// cap; otherwise recap sessions compress first and the lowest-turn tail drops.
fn build_digest(sessions: &[&SessionAgg]) -> (String, Vec<String>) {
    let mut ordered: Vec<&SessionAgg> = sessions.to_vec();
    ordered.sort_by(|a, b| effort(b).total_cmp(&effort(a)));
    let full_blocks: Vec<String> = ordered
        .iter()
        .map(|session| session_digest(session))
        .collect();
    let full_total: usize = full_blocks.iter().map(|block| units_len(block)).sum();
    if full_total <= DIGEST_CAP {
        return (full_blocks.join("\n\n"), Vec::new());
    }
    let mut kept: Vec<String> = Vec::new();
    let mut dropped = Vec::new();
    let mut total = 0usize;
    for (index, session) in ordered.iter().enumerate() {
        let block = if session.recap_text.is_some() {
            compressed_digest(session)
        } else {
            full_blocks[index].clone()
        };
        let length = units_len(&block);
        if total + length <= DIGEST_CAP || kept.is_empty() {
            kept.push(block);
            total += length;
            continue;
        }
        dropped.push(
            session
                .title
                .clone()
                .filter(|title| !title.is_empty())
                .unwrap_or_else(|| session.id.clone()),
        );
    }
    (kept.join("\n\n"), dropped)
}

// ---- Scan ------------------------------------------------------------------

#[derive(Default)]
struct SessionCache {
    map: HashMap<String, (f64, u64, SessionMessages)>,
    order: VecDeque<String>,
}

impl SessionCache {
    fn get(&mut self, key: &str, mtime: f64, size: u64) -> Option<SessionMessages> {
        let hit = self
            .map
            .get(key)
            .and_then(|(m, s, result)| (*m == mtime && *s == size).then(|| result.clone()))?;
        self.order.retain(|cached| cached != key);
        self.order.push_back(key.to_owned());
        Some(hit)
    }

    fn insert(&mut self, key: String, mtime: f64, size: u64, result: SessionMessages) {
        self.map.insert(key.clone(), (mtime, size, result));
        self.order.retain(|cached| cached != &key);
        self.order.push_back(key);
        while self.map.len() > SESSION_CACHE_CAP {
            let Some(oldest) = self.order.pop_front() else {
                break;
            };
            self.map.remove(&oldest);
        }
    }
}

fn session_data(
    source: &dyn TranscriptSource,
    cache: &Mutex<SessionCache>,
    row: &TranscriptSession,
    root: Option<&str>,
) -> SessionMessages {
    let key = format!("{}:{}:{}", root.unwrap_or("undefined"), row.source, row.id);
    {
        let mut guard = cache.lock().unwrap_or_else(|error| error.into_inner());
        if let Some(hit) = guard.get(&key, row.mtime, row.size) {
            return hit;
        }
    }
    let result = source.read_session(row, root);
    let mut guard = cache.lock().unwrap_or_else(|error| error.into_inner());
    guard.insert(key, row.mtime, row.size, result.clone());
    result
}

fn scan_days_sync(
    source: &dyn TranscriptSource,
    clock: &dyn Clock,
    cache: &Mutex<SessionCache>,
    costs: &Mutex<StatsCsvCosts>,
    csv_path: &Path,
    cost_dir: &Path,
    window_start: f64,
    root: Option<&str>,
) -> Result<BTreeMap<String, DayAgg>, String> {
    let rows = source.list(root, LIST_CAP)?;
    let stats_costs = costs
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .read(csv_path);
    let mut days: BTreeMap<String, DayAgg> = BTreeMap::new();

    for row in rows.into_iter().filter(|row| row.mtime >= window_start) {
        let parsed = session_data(source, cache, &row, root);
        if !parsed.ok || parsed.messages.is_empty() {
            continue;
        }
        let mut by_day: Vec<(String, DayBucket)> = Vec::new();
        let mut session_turns: u64 = 0;
        for message in &parsed.messages {
            let date = clock.local_day(message.ts_ms.unwrap_or(row.mtime));
            let index = match by_day.iter().position(|(bucket, _)| bucket == &date) {
                Some(index) => index,
                None => {
                    by_day.push((date, DayBucket::default()));
                    by_day.len() - 1
                }
            };
            let bucket = &mut by_day[index].1;
            if message.role == "user" && message.kind == "text" {
                if message.recap {
                    bucket.recap_text = Some(message.text.clone());
                } else {
                    bucket.user_texts.push(message.text.clone());
                }
            } else if message.role == "assistant" && message.kind == "text" {
                bucket.last_assistant_text = Some(message.text.clone());
                bucket.turns += 1;
                session_turns += 1;
            }
        }

        let totals = source.totals(&row, root);
        let tokens = if totals.exists { totals.tokens } else { 0.0 };
        let cost = stats_costs
            .get(&row.id)
            .copied()
            .or_else(|| read_cost_usd(cost_dir, &row.id))
            .or(totals.est_cost_usd);

        for (date, bucket) in by_day {
            let day = days.entry(date).or_default();
            // Whole-session cost/tokens can't be split per message; prorate by
            // this day's share of the session's assistant turns.
            let share = if session_turns > 0 {
                bucket.turns as f64 / session_turns as f64
            } else {
                0.0
            };
            let day_tokens = js_round(tokens * share);
            day.sessions.push(SessionAgg {
                id: row.id.clone(),
                project: row.project.clone(),
                cwd: row.cwd.clone(),
                source: row.source.clone(),
                title: row.title.clone(),
                turns: session_turns,
                day_turns: bucket.turns,
                day_tokens,
                user_texts: bucket.user_texts,
                last_assistant_text: bucket.last_assistant_text,
                recap_text: bucket.recap_text,
            });
            day.metrics.sessions += 1;
            day.metrics.turns += bucket.turns;
            day.metrics.tokens += day_tokens;
            day.metrics.cost_usd += cost.unwrap_or(0.0) * share;
            day.metrics.add_harness(&row.source, bucket.turns);
        }
    }
    Ok(days)
}

// ---- Entry assembly --------------------------------------------------------

fn metrics_json(metrics: &Metrics) -> Value {
    let mut by_harness = Map::new();
    for (harness, sessions, turns) in &metrics.by_harness {
        by_harness.insert(
            harness.clone(),
            json!({ "sessions": sessions, "turns": turns }),
        );
    }
    json!({
        "sessions": metrics.sessions,
        "turns": metrics.turns,
        "tokens": Num(metrics.tokens),
        "costUsd": Num(js_round(metrics.cost_usd * 100.0) / 100.0),
        "byHarness": Value::Object(by_harness),
    })
}

fn repos_json(sessions: &[&SessionAgg]) -> Value {
    let mut seen = HashSet::new();
    let mut repos = Vec::new();
    for session in sessions {
        let path = session
            .cwd
            .clone()
            .filter(|cwd| !cwd.is_empty())
            .unwrap_or_else(|| session.project.clone());
        if let Some(name) = repo_name(&path) {
            if seen.insert(name.clone()) {
                repos.push(Value::String(name));
            }
        }
    }
    Value::Array(repos)
}

fn sessions_json(sessions: &[&SessionAgg]) -> Value {
    Value::Array(
        sessions
            .iter()
            .map(|session| {
                let mut row = Map::new();
                row.insert("id".to_owned(), json!(session.id));
                row.insert("project".to_owned(), json!(session.project));
                if let Some(cwd) = &session.cwd {
                    row.insert("cwd".to_owned(), json!(cwd));
                }
                row.insert("source".to_owned(), json!(session.source));
                if let Some(title) = &session.title {
                    row.insert("title".to_owned(), json!(title));
                }
                row.insert("turns".to_owned(), json!(session.turns));
                row.insert("dayTurns".to_owned(), json!(session.day_turns));
                row.insert("blurb".to_owned(), json!(blurb_of(&session.user_texts)));
                Value::Object(row)
            })
            .collect(),
    )
}

#[derive(Default)]
struct EnsureGate {
    running: Mutex<bool>,
    ready: Condvar,
}

struct GateGuard(Arc<EnsureGate>);

impl Drop for GateGuard {
    fn drop(&mut self) {
        *self
            .0
            .running
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = false;
        self.0.ready.notify_all();
    }
}

// ---- Service ---------------------------------------------------------------

// VERIFY: history.rs: pub struct HistoryService
/// Shared, `Arc`-held daily History service.
pub struct HistoryService {
    deps: Arc<HistoryDeps>,
    write: Arc<Mutex<()>>,
    gate: Arc<EnsureGate>,
    session_cache: Arc<Mutex<SessionCache>>,
    costs: Arc<Mutex<StatsCsvCosts>>,
}

// VERIFY: history.rs: impl HistoryService::new
impl HistoryService {
    pub fn new(deps: HistoryDeps) -> Arc<Self> {
        Arc::new(Self {
            deps: Arc::new(deps),
            write: Arc::new(Mutex::new(())),
            gate: Arc::new(EnsureGate::default()),
            session_cache: Arc::new(Mutex::new(SessionCache::default())),
            costs: Arc::new(Mutex::new(StatsCsvCosts::default())),
        })
    }

    fn file(&self) -> PathBuf {
        self.deps.state_dir.join("history.jsonl")
    }

    fn csv_path(&self) -> PathBuf {
        self.deps.usage_state.join("stats.csv")
    }

    fn cost_dir(&self) -> PathBuf {
        self.deps.usage_state.join("cost-state")
    }

    fn guidance_path(&self) -> PathBuf {
        self.deps
            .home
            .join(".agents")
            .join("skills")
            .join("declawed")
            .join("SKILL.md")
    }

    fn bin_configured(&self, group: &str) -> bool {
        match group {
            "claude" => self.deps.bins.claude.is_some(),
            "ollama" => self.deps.bins.ollama.is_some(),
            "codex" => self.deps.bins.codex.is_some(),
            _ => false,
        }
    }

    fn with_write<T>(&self, action: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
        let _guard = self.write.lock().unwrap_or_else(|error| error.into_inner());
        action()
    }

    async fn acquire_gate(&self) -> Result<GateGuard, String> {
        let gate = self.gate.clone();
        tokio::task::spawn_blocking(move || {
            let mut running = gate
                .running
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            while *running {
                running = gate
                    .ready
                    .wait(running)
                    .unwrap_or_else(|error| error.into_inner());
            }
            *running = true;
            GateGuard(gate.clone())
        })
        .await
        .map_err(|error| error.to_string())
    }

    async fn scan_days(
        &self,
        window_start: f64,
        root: Option<String>,
    ) -> Result<BTreeMap<String, DayAgg>, String> {
        let source = self.deps.transcripts.clone();
        let clock = self.deps.clock.clone();
        let cache = self.session_cache.clone();
        let costs = self.costs.clone();
        let csv_path = self.csv_path();
        let cost_dir = self.cost_dir();
        tokio::task::spawn_blocking(move || {
            scan_days_sync(
                &*source,
                &*clock,
                &cache,
                &costs,
                &csv_path,
                &cost_dir,
                window_start,
                root.as_deref(),
            )
        })
        .await
        .map_err(|error| error.to_string())?
    }

    fn emit_history(&self, pending: &[String]) {
        let entries = read_history(&self.file());
        self.deps.bus.emit(&BusEvent::History(json!({
            "entries": entries,
            "pending": pending,
        })));
    }

    async fn summarize_day(&self, digest: &str, sessions: &[&SessionAgg]) -> DaySummary {
        let Some(model) = self
            .deps
            .models
            .summariser_model()
            .filter(|model| self.bin_configured(&model.group))
        else {
            let mut summary = deterministic_summary(sessions);
            summary.llm = json!({
                "ok": false,
                "provider": null,
                "model": null,
                "reason": "no-summariser",
                "error": null,
            });
            return summary;
        };
        let guidance = declawed_guidance(&self.guidance_path());
        let prompt = if guidance.is_empty() {
            format!("{SUMMARY_SYSTEM}\n\n{digest}")
        } else {
            format!("{SUMMARY_SYSTEM}\n\n{GUIDANCE_WRAPPER}{guidance}\n\n{digest}")
        };
        match self.deps.summariser.call(&prompt, &model).await {
            Ok(answer) => match parse_json_summary(&answer.text) {
                Some(parsed) => DaySummary {
                    projects: parsed.projects,
                    topics: parsed.topics,
                    llm: json!({
                        "ok": true,
                        "provider": model.group,
                        "model": model.id,
                        "inputTokens": opt_num(answer.input_tokens),
                        "outputTokens": opt_num(answer.output_tokens),
                    }),
                },
                None => {
                    let mut summary = deterministic_summary(sessions);
                    summary.llm = json!({
                        "ok": false,
                        "provider": null,
                        "model": null,
                        "reason": "unavailable",
                        "error": null,
                    });
                    summary
                }
            },
            Err(error) => {
                let mut summary = deterministic_summary(sessions);
                summary.llm = json!({
                    "ok": false,
                    "provider": null,
                    "model": null,
                    "reason": "unavailable",
                    "error": error,
                });
                summary
            }
        }
    }

    async fn build_day_entry(&self, date: &str, day: &DayAgg) -> Result<Value, String> {
        let sessions: Vec<&SessionAgg> = day
            .sessions
            .iter()
            .filter(|session| !is_noise_session(session))
            .collect();
        let metrics = metrics_json(&day.metrics);
        let repos = repos_json(&sessions);
        let summary = if day.sessions.is_empty() {
            DaySummary {
                projects: Vec::new(),
                topics: Vec::new(),
                llm: json!({
                    "ok": false,
                    "provider": null,
                    "model": null,
                    "reason": "empty",
                }),
            }
        } else if day.metrics.turns < TRIVIAL_TURNS || sessions.is_empty() {
            let mut summary = deterministic_summary(&sessions);
            summary.llm = json!({
                "ok": false,
                "provider": null,
                "model": null,
                "reason": "trivial",
            });
            summary
        } else {
            let (digest, dropped) = build_digest(&sessions);
            let mut summary = self.summarize_day(&digest, &sessions).await;
            if !dropped.is_empty() {
                if let Some(map) = summary.llm.as_object_mut() {
                    map.insert("dropped".to_owned(), json!(dropped));
                }
            }
            summary
        };
        let mut entry = Map::new();
        entry.insert("date".to_owned(), json!(date));
        entry.insert("projects".to_owned(), Value::Array(summary.projects));
        entry.insert("topics".to_owned(), json!(summary.topics));
        entry.insert("repos".to_owned(), repos);
        entry.insert("sessions".to_owned(), sessions_json(&sessions));
        entry.insert("metrics".to_owned(), metrics);
        entry.insert("llm".to_owned(), summary.llm);
        entry.insert("builtAt".to_owned(), json!(self.deps.clock.now_iso()));
        Ok(Value::Object(entry))
    }

    // VERIFY: history.rs: impl HistoryService::ensure
    /// `ensureHistory` — deduplicated: a concurrent caller waits for the running
    /// pass, then re-diffs (which then finds nothing missing).
    pub async fn ensure(
        self: &Arc<Self>,
        days: f64,
        root: Option<String>,
    ) -> Result<Vec<Value>, String> {
        let guard = self.acquire_gate().await?;
        let result = self.ensure_inner(days, root).await;
        drop(guard);
        result
    }

    async fn ensure_inner(&self, days: f64, root: Option<String>) -> Result<Vec<Value>, String> {
        if crate::shadow::enabled() {
            return Ok(Vec::new()); // read-only: no appends, no summariser spawn
        }
        let now = self.deps.clock.now_ms();
        let today = self.deps.clock.local_day(now);
        let mut wanted = Vec::new();
        let mut index = 1.0;
        while index <= days {
            wanted.push(self.deps.clock.local_day(now - index * 86_400_000.0));
            index += 1.0;
        }
        wanted.sort();

        let prior: HashMap<String, Value> = read_history(&self.file())
            .into_iter()
            .filter_map(|entry| {
                let date = entry.get("date").and_then(Value::as_str)?.to_owned();
                Some((date, entry))
            })
            .collect();
        let missing: Vec<String> = wanted
            .into_iter()
            .filter(|date| {
                if date == &today {
                    return false;
                }
                match prior.get(date) {
                    None => true,
                    Some(entry) => {
                        entry
                            .get("llm")
                            .and_then(|llm| llm.get("reason"))
                            .and_then(Value::as_str)
                            == Some("empty")
                            || !entry.get("projects").is_some_and(Value::is_array)
                    }
                }
            })
            .collect();
        if missing.is_empty() {
            return Ok(Vec::new());
        }

        let window_start = self
            .deps
            .clock
            .start_of_local_day_ms(now - days * 86_400_000.0);
        let scanned = self.scan_days(window_start, root).await?;
        let mut built = Vec::new();
        let mut pending: Vec<String> = missing
            .iter()
            .filter(|date| !prior.contains_key(*date))
            .cloned()
            .collect();
        for date in &missing {
            let aggregate = scanned.get(date);
            if aggregate.is_none() && prior.contains_key(date) {
                continue;
            }
            let aggregate = aggregate.cloned().unwrap_or_else(empty_day_agg);
            let entry = self.build_day_entry(date, &aggregate).await?;
            let file = self.file();
            self.with_write(|| append_entry(&file, &entry))?;
            built.push(entry);
            pending.retain(|pending_date| pending_date != date);
            self.emit_history(&pending);
        }
        Ok(built)
    }

    // VERIFY: history.rs: impl HistoryService::regenerate
    /// `regenerateDay` — atomic rewrite of the whole file with one entry
    /// replaced/appended.
    pub async fn regenerate(&self, date: &str, root: Option<String>) -> Result<Value, String> {
        // VERIFY: wave6-history_parity-1
        // Node never rejects a date here. The window comes from
        // `startOfLocalDay(new Date(\`${date}T00:00:00\`)).getTime()`
        // (`server/history.mjs:458`) but the day is looked up by the *raw* body
        // string (`scanned.get(date)`, `:460`), whose key only a canonical
        // calendar date can produce. An impossible one (`2026-02-30`) therefore
        // misses, and `buildDayEntry(date, emptyDayAgg())` writes an empty entry
        // under the literal key (`:460-466`); the route answers
        // `200 {ok:true, entry}` (`server/index.mjs:992`). No usable calendar
        // date therefore means no window and an empty aggregate, not an error.
        // (Verified in V8: some out-of-range ISO days are normalised instead of
        // yielding NaN — `2026-02-30` becomes Mar 2 — but the raw-key lookup
        // still misses, so the entry Node writes is empty either way. Rust
        // skips the scan rather than scanning a day it will never read; the one
        // difference is that a failing session list on such a day surfaces as a
        // 400 in Node (`errStatus`, `index.mjs:253`) and cannot in Rust.)
        let scanned = match parse_ymd(date)
            .and_then(|(year, month, day)| self.deps.clock.start_of_local_day_ymd(year, month, day))
        {
            Some(window_start) => self.scan_days(window_start, root).await?,
            None => BTreeMap::new(),
        };
        let aggregate = scanned.get(date).cloned().unwrap_or_else(empty_day_agg);
        let entry = self.build_day_entry(date, &aggregate).await?;
        let file = self.file();
        self.with_write(|| {
            let mut all: Vec<Value> = read_history(&file)
                .into_iter()
                .filter(|existing| entry_date(existing) != date)
                .collect();
            all.push(entry.clone());
            all.sort_by(|a, b| entry_date(a).cmp(entry_date(b)));
            let text = all
                .iter()
                .map(|entry| serde_json::to_string(entry).unwrap_or_default())
                .collect::<Vec<_>>()
                .join("\n");
            write_atomic(&file, format!("{text}\n").as_bytes())
                .map_err(|error| error.to_string())?;
            self.emit_history(&[]);
            Ok(entry.clone())
        })
    }

    // VERIFY: history.rs: impl HistoryService::live_today
    /// `liveToday` — computed live, never persisted.
    pub async fn live_today(&self, root: Option<String>) -> Result<Value, String> {
        let now = self.deps.clock.now_ms();
        let date = self.deps.clock.local_day(now);
        let window_start = self.deps.clock.start_of_local_day_ms(now);
        let scanned = self.scan_days(window_start, root).await?;
        let aggregate = scanned.get(&date).cloned().unwrap_or_else(empty_day_agg);
        let sessions: Vec<&SessionAgg> = aggregate
            .sessions
            .iter()
            .filter(|session| !is_noise_session(session))
            .collect();
        Ok(json!({
            "date": date,
            "live": true,
            "repos": repos_json(&sessions),
            "sessions": sessions_json(&sessions),
            "metrics": metrics_json(&aggregate.metrics),
        }))
    }

    // VERIFY: history.rs: impl HistoryService::get
    /// `GET /api/history` (`server/index.mjs:875`): kick off backfill, answer
    /// immediately with the persisted window, the live today and pending days.
    pub async fn get(self: &Arc<Self>, query: &HistoryQuery) -> Result<Value, String> {
        let days = normalize_days(query.days);
        let service = self.clone();
        tokio::spawn(async move {
            let _ = service.ensure(days, None).await;
        });
        let today = self.live_today(None).await?;
        let now = self.deps.clock.now_ms();
        Ok(list_payload(
            read_history(&self.file()),
            days,
            query,
            &*self.deps.clock,
            now,
            today,
        ))
    }
}

/// The GET body assembly, extracted so its window/pending semantics are
/// testable without racing the fire-and-forget backfill.
fn list_payload(
    mut entries: Vec<Value>,
    days: f64,
    query: &HistoryQuery,
    clock: &dyn Clock,
    now: f64,
    today: Value,
) -> Value {
    if let Some(from) = &query.from {
        entries.retain(|entry| entry_date(entry) >= from.as_str());
    }
    if let Some(to) = &query.to {
        entries.retain(|entry| entry_date(entry) <= to.as_str());
    }
    if query.from.is_none() && query.to.is_none() {
        entries = slice_tail(entries, days);
    }
    let have: HashSet<String> = entries
        .iter()
        .map(|entry| entry_date(entry).to_owned())
        .collect();
    let mut pending = Vec::new();
    let mut index = 1.0;
    while index <= days {
        let date = clock.local_day(now - index * 86_400_000.0);
        let in_window = query.from.as_ref().is_none_or(|from| &date >= from)
            && query.to.as_ref().is_none_or(|to| &date <= to);
        if !have.contains(&date) && in_window {
            pending.push(date);
        }
        index += 1.0;
    }
    entries.reverse();
    json!({
        "ok": true,
        "entries": entries,
        "pending": pending,
        "today": today,
    })
}

/// `entries.slice(-days)` with JavaScript relative-index semantics.
fn slice_tail<T>(items: Vec<T>, days: f64) -> Vec<T> {
    let len = items.len() as i64;
    let relative = (-days).trunc() as i64;
    let start = if relative < 0 {
        (len + relative).max(0)
    } else {
        relative.min(len)
    };
    items.into_iter().skip(start as usize).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct Scratch(PathBuf);

    impl Scratch {
        fn new(tag: &str) -> Self {
            static NEXT: AtomicUsize = AtomicUsize::new(0);
            let dir = std::env::temp_dir().join(format!(
                "singularity-history-{tag}-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }

        fn path(&self, name: &str) -> PathBuf {
            self.0.join(name)
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    struct FixedClock {
        now: f64,
    }

    impl Clock for FixedClock {
        fn now_ms(&self) -> f64 {
            self.now
        }
        fn now_iso(&self) -> String {
            "2026-10-28T00:00:00.000Z".to_owned()
        }
        fn local_day(&self, ts_ms: f64) -> String {
            utc_day(ts_ms)
        }
        fn start_of_local_day_ms(&self, ts_ms: f64) -> f64 {
            utc_midnight(ts_ms)
        }
        fn start_of_local_day_ymd(&self, year: i32, month: u8, day: u8) -> Option<f64> {
            let date =
                time::Date::from_calendar_date(year, time::Month::try_from(month).ok()?, day)
                    .ok()?;
            Some(
                date.with_time(time::Time::MIDNIGHT)
                    .assume_utc()
                    .unix_timestamp() as f64
                    * 1000.0,
            )
        }
    }

    fn utc_day(ts_ms: f64) -> String {
        let stamp =
            time::OffsetDateTime::from_unix_timestamp((ts_ms / 1000.0).floor() as i64).unwrap();
        format!(
            "{:04}-{:02}-{:02}",
            stamp.year(),
            u8::from(stamp.month()),
            stamp.day()
        )
    }

    fn utc_midnight(ts_ms: f64) -> f64 {
        let stamp =
            time::OffsetDateTime::from_unix_timestamp((ts_ms / 1000.0).floor() as i64).unwrap();
        stamp
            .date()
            .with_time(time::Time::MIDNIGHT)
            .assume_utc()
            .unix_timestamp() as f64
            * 1000.0
    }

    fn at(year: i32, month: u8, day: u8, hour: u8) -> f64 {
        time::Date::from_calendar_date(year, time::Month::try_from(month).unwrap(), day)
            .unwrap()
            .with_hms(hour, 0, 0)
            .unwrap()
            .assume_utc()
            .unix_timestamp() as f64
            * 1000.0
    }

    #[derive(Default)]
    struct FakeSource {
        rows: Mutex<Vec<TranscriptSession>>,
        messages: Mutex<HashMap<String, Vec<TranscriptMessage>>>,
        totals: Mutex<HashMap<String, SessionTotals>>,
        reads: AtomicUsize,
    }

    impl FakeSource {
        fn add(&self, row: TranscriptSession, messages: Vec<TranscriptMessage>) {
            self.messages
                .lock()
                .unwrap()
                .insert(row.id.clone(), messages);
            self.rows.lock().unwrap().push(row);
        }
        fn set_messages(&self, id: &str, messages: Vec<TranscriptMessage>) {
            self.messages
                .lock()
                .unwrap()
                .insert(id.to_owned(), messages);
        }
        fn set_totals(&self, id: &str, totals: SessionTotals) {
            self.totals.lock().unwrap().insert(id.to_owned(), totals);
        }
    }

    impl TranscriptSource for FakeSource {
        fn list(&self, _root: Option<&str>, _cap: usize) -> Result<Vec<TranscriptSession>, String> {
            Ok(self.rows.lock().unwrap().clone())
        }
        fn read_session(&self, row: &TranscriptSession, _root: Option<&str>) -> SessionMessages {
            self.reads.fetch_add(1, Ordering::SeqCst);
            SessionMessages {
                ok: true,
                messages: self
                    .messages
                    .lock()
                    .unwrap()
                    .get(&row.id)
                    .cloned()
                    .unwrap_or_default(),
            }
        }
        fn totals(&self, row: &TranscriptSession, _root: Option<&str>) -> SessionTotals {
            self.totals
                .lock()
                .unwrap()
                .get(&row.id)
                .copied()
                .unwrap_or_default()
        }
    }

    struct FakeSummariser {
        calls: AtomicUsize,
        answer: Mutex<Result<SummaryAnswer, String>>,
    }

    impl DaySummariser for FakeSummariser {
        fn call<'a>(
            &'a self,
            _prompt: &'a str,
            _model: &'a SummaryModel,
        ) -> Pin<Box<dyn Future<Output = Result<SummaryAnswer, String>> + Send + 'a>> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            let answer = self.answer.lock().unwrap().clone();
            Box::pin(async move { answer })
        }
    }

    #[derive(Default)]
    struct FakeModels {
        model: Mutex<Option<SummaryModel>>,
    }

    impl ModelStore for FakeModels {
        fn summariser_model(&self) -> Option<SummaryModel> {
            self.model.lock().unwrap().clone()
        }
    }

    struct Harness {
        service: Arc<HistoryService>,
        source: Arc<FakeSource>,
        summariser: Arc<FakeSummariser>,
        models: Arc<FakeModels>,
        bus: Bus,
        dir: Scratch,
    }

    fn harness(tag: &str, now: f64) -> Harness {
        let dir = Scratch::new(tag);
        let source = Arc::new(FakeSource::default());
        let summariser = Arc::new(FakeSummariser {
            calls: AtomicUsize::new(0),
            answer: Mutex::new(Ok(SummaryAnswer {
                text: "{}".to_owned(),
                input_tokens: None,
                output_tokens: None,
            })),
        });
        let models = Arc::new(FakeModels::default());
        let bus = Bus::new();
        let clock = Arc::new(FixedClock { now });
        let service = HistoryService::new(HistoryDeps {
            state_dir: dir.path("state"),
            usage_state: dir.path("usage"),
            home: dir.path("home"),
            bins: HistoryBins {
                claude: Some(dir.path("claude")),
                ollama: Some(dir.path("ollama")),
                codex: None,
            },
            bus: bus.clone(),
            clock: clock.clone(),
            transcripts: source.clone(),
            summariser: summariser.clone(),
            models: models.clone(),
        });
        Harness {
            service,
            source,
            summariser,
            models,
            bus,
            dir,
        }
    }

    fn message(role: &str, text: &str, ts_ms: f64) -> TranscriptMessage {
        TranscriptMessage {
            ts_ms: Some(ts_ms),
            role: role.to_owned(),
            kind: "text".to_owned(),
            text: text.to_owned(),
            recap: false,
        }
    }

    fn row(id: &str, cwd: &str, mtime: f64) -> TranscriptSession {
        TranscriptSession {
            id: id.to_owned(),
            project: format!("p-{id}"),
            cwd: Some(cwd.to_owned()),
            title: Some(format!("work {id}")),
            source: "claude".to_owned(),
            file: None,
            mtime,
            size: 10,
        }
    }

    fn block_on<F: Future>(future: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(future)
    }

    fn entry_dates(entries: &[Value]) -> Vec<String> {
        entries
            .iter()
            .map(|entry| entry_date(entry).to_owned())
            .collect()
    }

    fn raw_entries(file: &Path) -> Vec<Value> {
        std::fs::read_to_string(file)
            .unwrap_or_default()
            .lines()
            .filter(|line| !line.is_empty())
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    fn file_of(harness: &Harness) -> PathBuf {
        harness.dir.path("state").join("history.jsonl")
    }

    fn set_model(harness: &Harness, id: &str, group: &str) {
        *harness.models.model.lock().unwrap() = Some(SummaryModel {
            id: id.to_owned(),
            group: group.to_owned(),
        });
    }

    #[test]
    fn scan_buckets_a_midnight_session_into_both_days_and_prorates_cost() {
        let day_a = at(2026, 10, 20, 23);
        let day_b = day_a + 2.0 * 3_600_000.0;
        let h = harness("scan", day_b + 3_600_000.0);
        h.source.add(
            row("s1", "C:\\fake\\midnight", day_a),
            vec![
                message("user", "start work", day_a),
                message("assistant", "a1", day_a + 60_000.0),
                message("assistant", "a2", day_a + 120_000.0),
                message("assistant", "a3", day_a + 180_000.0),
                message("assistant", "a4", day_a + 240_000.0),
                message("user", "continue after midnight", day_b),
                message("assistant", "b1", day_b + 60_000.0),
                message("assistant", "b2", day_b + 120_000.0),
            ],
        );
        h.source.set_totals(
            "s1",
            SessionTotals {
                exists: true,
                tokens: 6_000.0,
                est_cost_usd: None,
            },
        );
        std::fs::create_dir_all(h.dir.path("usage")).unwrap();
        std::fs::write(h.dir.path("usage/stats.csv"), "t,s1,6.0,x,\n").unwrap();

        let days = block_on(h.service.scan_days(utc_midnight(day_a), None)).unwrap();
        let a = &days[&utc_day(day_a)];
        let b = &days[&utc_day(day_b)];
        assert_eq!((a.metrics.turns, b.metrics.turns), (4, 2));
        assert_eq!((a.metrics.tokens, b.metrics.tokens), (4_000.0, 2_000.0));
        assert!(
            (a.metrics.cost_usd - 4.0).abs() < 0.001,
            "{}",
            a.metrics.cost_usd
        );
        assert!(
            (b.metrics.cost_usd - 2.0).abs() < 0.001,
            "{}",
            b.metrics.cost_usd
        );
        assert_eq!(a.sessions[0].day_turns, 4);
        assert_eq!(b.sessions[0].day_turns, 2);
    }

    #[test]
    fn read_history_keeps_the_last_line_per_date_and_sorts() {
        let h = harness("read", at(2026, 10, 20, 12));
        std::fs::create_dir_all(h.dir.path("state")).unwrap();
        std::fs::write(
            file_of(&h),
            "{\"date\":\"2026-01-02\",\"n\":1}\n{\"date\":\"2026-01-01\",\"n\":2}\n{\"date\":\"2026-01-02\",\"n\":3}\nnot json\n",
        )
        .unwrap();
        let entries = read_history(&file_of(&h));
        assert_eq!(entry_dates(&entries), ["2026-01-01", "2026-01-02"]);
        assert_eq!(entries[1]["n"], json!(3));
    }

    #[test]
    fn ensure_appends_missing_dates_ascending_and_is_idempotent() {
        let now = at(2026, 10, 20, 12);
        let h = harness("ensure", now);
        let day1 = now - 86_400_000.0;
        let day2 = now - 2.0 * 86_400_000.0;
        h.source.add(
            row("s1", "C:\\fake\\a", day1),
            vec![
                message("user", "hi", day1),
                message("assistant", "hello", day1 + 1000.0),
            ],
        );
        h.source.add(
            row("s2", "C:\\fake\\b", day2),
            vec![
                message("user", "hi2", day2),
                message("assistant", "hello2", day2 + 1000.0),
            ],
        );
        block_on(h.service.ensure(3.0, None)).unwrap();
        let dates = entry_dates(&read_history(&file_of(&h)));
        let expected = {
            let mut wanted = vec![utc_day(day2), utc_day(day1)];
            wanted.sort();
            wanted
        };
        let filtered: Vec<String> = dates
            .into_iter()
            .filter(|date| expected.contains(date))
            .collect();
        assert_eq!(filtered, expected);

        let before = raw_entries(&file_of(&h)).len();
        block_on(h.service.ensure(3.0, None)).unwrap();
        assert_eq!(raw_entries(&file_of(&h)).len(), before);
    }

    #[test]
    fn a_trivial_day_writes_a_deterministic_entry_without_calling_the_summariser() {
        let now = at(2026, 10, 20, 12);
        let h = harness("trivial", now);
        let date = now - 86_400_000.0;
        set_model(&h, "opus", "claude");
        h.source.add(
            row("s1", "C:\\fake\\a", date),
            vec![
                message("user", "quick question", date),
                message("assistant", "quick answer", date + 1000.0),
            ],
        );
        block_on(h.service.ensure(2.0, None)).unwrap();
        let entry = read_history(&file_of(&h))
            .into_iter()
            .find(|entry| entry_date(entry) == utc_day(date))
            .unwrap();
        assert_eq!(entry["llm"]["ok"], json!(false));
        assert_eq!(entry["llm"]["reason"], json!("trivial"));
        assert_eq!(h.summariser.calls.load(Ordering::SeqCst), 0);
        assert_eq!(entry["projects"][0]["bullets"][0], json!("work s1"));
    }

    #[test]
    fn a_configured_summariser_with_valid_json_sets_ok_provider_and_model() {
        let now = at(2026, 10, 20, 12);
        let h = harness("summary-ok", now);
        let date = now - 86_400_000.0;
        set_model(&h, "opus", "claude");
        *h.summariser.answer.lock().unwrap() = Ok(SummaryAnswer {
            text: "{\"projects\":[{\"path\":\"C:\\\\fake\\\\a\",\"bullets\":[\"did X\"]}],\"topics\":[\"x\"]}"
                .to_owned(),
            input_tokens: Some(10.0),
            output_tokens: Some(20.0),
        });
        h.source.add(
            row("s1", "C:\\fake\\a", date),
            vec![
                message("user", "do it", date),
                message("assistant", "a1", date + 1000.0),
                message("assistant", "a2", date + 2000.0),
                message("assistant", "a3", date + 3000.0),
            ],
        );
        block_on(h.service.ensure(2.0, None)).unwrap();
        let entry = read_history(&file_of(&h))
            .into_iter()
            .find(|entry| entry_date(entry) == utc_day(date))
            .unwrap();
        assert_eq!(
            entry["llm"],
            json!({
                "ok": true,
                "provider": "claude",
                "model": "opus",
                "inputTokens": 10,
                "outputTokens": 20,
            })
        );
        assert_eq!(entry["projects"][0]["bullets"][0], json!("did X"));
        assert_eq!(h.summariser.calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn a_throwing_summariser_falls_back_to_deterministic_with_unavailable() {
        let now = at(2026, 10, 20, 12);
        let h = harness("summary-err", now);
        let date = now - 86_400_000.0;
        set_model(&h, "deepseek", "ollama");
        *h.summariser.answer.lock().unwrap() = Err("ollama down".to_owned());
        h.source.add(
            row("s1", "C:\\fake\\a", date),
            vec![
                message("user", "do it", date),
                message("assistant", "a1", date + 1000.0),
                message("assistant", "a2", date + 2000.0),
                message("assistant", "a3", date + 3000.0),
            ],
        );
        block_on(h.service.ensure(2.0, None)).unwrap();
        let entry = read_history(&file_of(&h))
            .into_iter()
            .find(|entry| entry_date(entry) == utc_day(date))
            .unwrap();
        assert_eq!(entry["llm"]["reason"], json!("unavailable"));
        assert_eq!(entry["llm"]["error"], json!("ollama down"));
        assert_eq!(entry["projects"][0]["bullets"][0], json!("work s1"));
    }

    #[test]
    fn no_model_or_a_missing_group_binary_behaves_like_no_summariser() {
        let now = at(2026, 10, 20, 12);
        let date = now - 86_400_000.0;
        for (tag, model) in [("none", None), ("bin", Some(("gpt-6", "codex")))] {
            let h = harness(tag, now);
            if let Some((id, group)) = model {
                set_model(&h, id, group);
            }
            h.source.add(
                row("s1", "C:\\fake\\a", date),
                vec![
                    message("user", "do it", date),
                    message("assistant", "a1", date + 1000.0),
                    message("assistant", "a2", date + 2000.0),
                    message("assistant", "a3", date + 3000.0),
                ],
            );
            block_on(h.service.ensure(2.0, None)).unwrap();
            let entry = read_history(&file_of(&h))
                .into_iter()
                .find(|entry| entry_date(entry) == utc_day(date))
                .unwrap();
            assert_eq!(entry["llm"]["reason"], json!("no-summariser"), "{tag}");
            assert_eq!(h.summariser.calls.load(Ordering::SeqCst), 0, "{tag}");
        }
    }

    #[test]
    fn noise_rows_stay_out_of_digest_and_list_but_count_in_metrics() {
        let now = at(2026, 10, 20, 12);
        let h = harness("noise", now);
        std::fs::create_dir_all(h.dir.path("state")).unwrap();
        let date = now - 86_400_000.0;
        set_model(&h, "opus", "claude");
        *h.summariser.answer.lock().unwrap() = Ok(SummaryAnswer {
            text: "{\"projects\":[{\"path\":\"C:\\\\fake\\\\a\",\"bullets\":[\"added the retry cap\"]}]}"
                .to_owned(),
            input_tokens: None,
            output_tokens: None,
        });
        h.source.add(
            row("real", "C:\\fake\\a", date),
            vec![
                message("user", "add the retry cap", date),
                message("assistant", "a1", date + 1000.0),
                message("assistant", "a2", date + 2000.0),
                message("assistant", "a3", date + 3000.0),
            ],
        );
        let mut reviewer = row("reviewer", "C:\\fake\\b", date + 4000.0);
        reviewer.title = None;
        h.source.add(
            reviewer,
            vec![
                message(
                    "user",
                    "You are an adversarial code reviewer. Review ONLY the unified diff below.",
                    date + 4000.0,
                ),
                message("assistant", "r1", date + 5000.0),
            ],
        );
        block_on(h.service.regenerate(&utc_day(date), None)).unwrap();
        let entry = read_history(&file_of(&h))
            .into_iter()
            .find(|entry| entry_date(entry) == utc_day(date))
            .unwrap();
        assert_eq!(entry["sessions"][0]["id"], json!("real"));
        assert_eq!(entry["sessions"].as_array().unwrap().len(), 1);
        assert_eq!(entry["metrics"]["sessions"], json!(2));
    }

    #[test]
    fn digest_caps_the_day_and_recap_sessions_compress_instead_of_dropping() {
        fn session(index: usize, recap: bool) -> SessionAgg {
            SessionAgg {
                id: format!("s{index}"),
                project: "p".to_owned(),
                cwd: Some(format!("C:\\fake\\digest-{index}")),
                source: "claude".to_owned(),
                title: Some(format!("session {index}")),
                turns: 40,
                day_turns: (40 - index) as u64,
                day_tokens: 0.0,
                user_texts: vec!["x".repeat(400); 12],
                last_assistant_text: Some("x".repeat(400)),
                recap_text: recap.then(|| "recap of earlier work".to_owned()),
            }
        }
        let plain: Vec<SessionAgg> = (0..40).map(|index| session(index, false)).collect();
        let recaps: Vec<SessionAgg> = (0..40).map(|index| session(index, true)).collect();
        let plain_refs: Vec<&SessionAgg> = plain.iter().collect();
        let recap_refs: Vec<&SessionAgg> = recaps.iter().collect();
        let (plain_text, plain_dropped) = build_digest(&plain_refs);
        let (recap_text, recap_dropped) = build_digest(&recap_refs);
        assert!(units_len(&plain_text) <= DIGEST_CAP);
        assert!(!plain_dropped.is_empty());
        assert!(plain_text.contains("digest-0"));
        assert!(!plain_text.contains("digest-39"));
        assert!(recap_text.contains("[recap]"));
        assert!(recap_dropped.len() < plain_dropped.len());
        assert!(units_len(&recap_text) <= DIGEST_CAP);
    }

    #[test]
    fn today_is_never_persisted_and_live_today_reflects_the_same_day() {
        let now = at(2026, 10, 20, 12);
        let h = harness("today", now);
        h.source.add(
            row("s1", "C:\\fake\\today", now),
            vec![
                message("user", "today work", now),
                message("assistant", "done 1", now + 1000.0),
                message("assistant", "done 2", now + 2000.0),
                message("assistant", "done 3", now + 3000.0),
            ],
        );
        block_on(h.service.ensure(2.0, None)).unwrap();
        assert!(
            read_history(&file_of(&h))
                .iter()
                .all(|entry| entry_date(entry) != utc_day(now))
        );
        let live = block_on(h.service.live_today(None)).unwrap();
        assert_eq!(live["date"], json!(utc_day(now)));
        assert_eq!(live["live"], json!(true));
        assert_eq!(live["metrics"]["turns"], json!(3));
    }

    #[test]
    fn regenerate_replaces_exactly_one_date_and_persists_a_bad_date_as_empty() {
        let now = at(2026, 10, 20, 12);
        let h = harness("regen", now);
        std::fs::create_dir_all(h.dir.path("state")).unwrap();
        let date = utc_day(now - 5.0 * 86_400_000.0);
        let day = now - 5.0 * 86_400_000.0;
        h.source.add(
            row("s1", "C:\\fake\\a", day),
            vec![
                message("user", "q", day),
                message("assistant", "a", day + 1000.0),
            ],
        );
        let entry = block_on(h.service.regenerate(&date, None)).unwrap();
        assert_eq!(entry_date(&entry), date);
        assert_eq!(raw_entries(&file_of(&h)).len(), 1);
        block_on(h.service.regenerate(&date, None)).unwrap();
        assert_eq!(raw_entries(&file_of(&h)).len(), 1);
        // VERIFY: wave6-history_parity-3
        // Node rewrites an entry under whatever raw string it was given
        // (`server/history.mjs:460-466`), so an unusable date is persisted as an
        // empty entry rather than rejected.
        let bad = block_on(h.service.regenerate("not-a-date", None)).unwrap();
        assert_eq!(entry_date(&bad), "not-a-date");
        assert_eq!(bad["llm"]["reason"], json!("empty"));
        assert_eq!(bad["sessions"], json!([]));
        let dates = raw_entries(&file_of(&h))
            .iter()
            .map(|entry| entry_date(entry).to_owned())
            .collect::<Vec<_>>();
        assert_eq!(dates.len(), 2);
        assert_eq!(
            dates
                .iter()
                .filter(|date| date.as_str() == "not-a-date")
                .count(),
            1
        );
    }

    #[test]
    fn a_gap_day_is_written_once_and_upgrades_when_work_appears() {
        let now = at(2026, 10, 20, 12);
        let h = harness("gap", now);
        let day = now - 7.0 * 86_400_000.0;
        let date = utc_day(day);
        block_on(h.service.ensure(7.0, None)).unwrap();
        let lines = |file: &Path| {
            raw_entries(file)
                .into_iter()
                .filter(|entry| entry_date(entry) == date)
                .count()
        };
        assert_eq!(lines(&file_of(&h)), 1);
        assert_eq!(
            read_history(&file_of(&h))
                .into_iter()
                .find(|entry| entry_date(entry) == date)
                .unwrap()["llm"]["reason"],
            json!("empty")
        );
        block_on(h.service.ensure(7.0, None)).unwrap();
        assert_eq!(lines(&file_of(&h)), 1);

        h.source.add(
            row("s1", "C:\\fake\\a", day),
            vec![
                message("user", "late arrival", day),
                message("assistant", "done", day + 1000.0),
            ],
        );
        block_on(h.service.ensure(7.0, None)).unwrap();
        assert_eq!(
            read_history(&file_of(&h))
                .into_iter()
                .find(|entry| entry_date(entry) == date)
                .unwrap()["llm"]["reason"],
            json!("trivial")
        );
    }

    #[test]
    fn two_concurrent_ensures_share_one_pass_and_one_line_per_date() {
        let now = at(2026, 10, 20, 12);
        let h = harness("concurrent", now);
        let day = now - 9.0 * 86_400_000.0;
        let date = utc_day(day);
        set_model(&h, "opus", "claude");
        *h.summariser.answer.lock().unwrap() = Ok(SummaryAnswer {
            text:
                "{\"projects\":[{\"path\":\"C:\\\\fake\\\\a\",\"bullets\":[\"concurrent day\"]}]}"
                    .to_owned(),
            input_tokens: None,
            output_tokens: None,
        });
        h.source.add(
            row("s1", "C:\\fake\\a", day),
            vec![
                message("user", "concurrent work", day),
                message("assistant", "c1", day + 1000.0),
                message("assistant", "c2", day + 2000.0),
                message("assistant", "c3", day + 3000.0),
            ],
        );
        let first = h.service.clone();
        let second = h.service.clone();
        block_on(async {
            let (a, b) = tokio::join!(first.ensure(9.0, None), second.ensure(9.0, None));
            a.unwrap();
            b.unwrap();
        });
        assert_eq!(h.summariser.calls.load(Ordering::SeqCst), 1);
        let lines = raw_entries(&file_of(&h))
            .into_iter()
            .filter(|entry| entry_date(entry) == date)
            .count();
        assert_eq!(lines, 1);
        assert_eq!(
            read_history(&file_of(&h))
                .into_iter()
                .find(|entry| entry_date(entry) == date)
                .unwrap()["projects"][0]["bullets"][0],
            json!("concurrent day")
        );
    }

    #[test]
    fn the_transcript_cache_reuses_an_unchanged_row_and_reparses_a_grown_one() {
        let now = at(2026, 10, 20, 12);
        let h = harness("cache", now);
        let day = now - 13.0 * 86_400_000.0;
        h.source.add(
            row("s1", "C:\\fake\\a", day),
            vec![
                message("user", "q", day),
                message("assistant", "a2", day + 2000.0),
            ],
        );
        let window = utc_midnight(day);
        let last_text = |days: &BTreeMap<String, DayAgg>| {
            days[&utc_day(day)].sessions[0]
                .last_assistant_text
                .clone()
                .unwrap()
        };
        assert_eq!(
            last_text(&block_on(h.service.scan_days(window, None)).unwrap()),
            "a2"
        );
        // Same (mtime,size): the cached parse wins over the tampered content.
        h.source.set_messages(
            "s1",
            vec![
                message("user", "q", day),
                message("assistant", "zz", day + 2000.0),
            ],
        );
        assert_eq!(
            last_text(&block_on(h.service.scan_days(window, None)).unwrap()),
            "a2"
        );
        // A grown file invalidates the key.
        h.source.rows.lock().unwrap()[0].size += 1;
        assert_eq!(
            last_text(&block_on(h.service.scan_days(window, None)).unwrap()),
            "zz"
        );
    }

    #[test]
    fn guidance_slices_phase_two_up_to_phase_three() {
        let h = harness("guidance", at(2026, 10, 20, 12));
        let skill = h.dir.path("declawed.md");
        std::fs::write(
            &skill,
            "# X\n## Phase 1\nscan\n## Phase 2\nrewrite rules\n## Phase 3\nverify",
        )
        .unwrap();
        let guidance = declawed_guidance(&skill);
        assert!(guidance.starts_with("## Phase 2"));
        assert!(guidance.contains("rewrite rules"));
        assert!(!guidance.contains("Phase 3"));
        assert!(!guidance.contains("scan"));
        assert_eq!(declawed_guidance(&h.dir.path("missing.md")), String::new());
    }

    #[test]
    fn the_get_payload_slices_pending_and_reverses_entries() {
        let now = at(2026, 10, 20, 12);
        let clock = FixedClock { now };
        // `readHistory` hands `list_payload` ascending dates (`history.mjs:107`).
        let entries: Vec<Value> = (1..=5)
            .rev()
            .map(|index| json!({ "date": utc_day(now - f64::from(index) * 86_400_000.0) }))
            .collect();
        let query = HistoryQuery {
            days: 2.0,
            from: None,
            to: None,
        };
        let payload = list_payload(entries.clone(), 2.0, &query, &clock, now, json!({}));
        let listed = payload["entries"].as_array().unwrap();
        assert_eq!(listed.len(), 2);
        assert_eq!(entry_date(&listed[0]), utc_day(now - 86_400_000.0));
        assert_eq!(entry_date(&listed[1]), utc_day(now - 2.0 * 86_400_000.0));
        assert!(payload["pending"].as_array().unwrap().is_empty());

        let from_query = HistoryQuery {
            days: 7.0,
            from: Some(utc_day(now - 5.0 * 86_400_000.0)),
            to: None,
        };
        // Only the three oldest days are on disk, so the two newest in-window
        // days report as pending (`server/index.mjs:885-889`).
        let filtered = list_payload(
            entries[..3].to_vec(),
            7.0,
            &from_query,
            &clock,
            now,
            json!({}),
        );
        assert_eq!(filtered["entries"].as_array().unwrap().len(), 3);
        assert_eq!(
            filtered["pending"],
            json!([
                utc_day(now - 86_400_000.0),
                utc_day(now - 2.0 * 86_400_000.0)
            ])
        );
    }

    #[test]
    fn ensure_emits_a_history_bus_event_per_appended_day() {
        let now = at(2026, 10, 20, 12);
        let h = harness("bus", now);
        let events = Arc::new(Mutex::new(Vec::new()));
        let seen = events.clone();
        h.bus.subscribe(Arc::new(move |event| {
            if let BusEvent::History(value) = event {
                seen.lock().unwrap().push(value.clone());
            }
        }));
        block_on(h.service.ensure(2.0, None)).unwrap();
        let events = events.lock().unwrap();
        assert_eq!(events.len(), 2);
        // `_ensureHistory` appends, then emits `readHistory()`
        // (`history.mjs:435-438`) — the event already carries the new entry.
        assert_eq!(events[0]["entries"].as_array().unwrap().len(), 1);
        assert_eq!(
            entry_date(&events[0]["entries"][0]).to_owned(),
            utc_day(now - 2.0 * 86_400_000.0)
        );
        assert_eq!(events[0]["pending"].as_array().unwrap().len(), 1);
        assert!(events[1]["pending"].as_array().unwrap().is_empty());
    }

    const MIDNIGHT_CHILD_ENV: &str = "SINGULARITY_HISTORY_MIDNIGHT_ZONE_CHILD";

    /// `start_of_local_day_ymd` must match V8's `new Date(y, m - 1, d)` under
    /// the pinned zone, including a midnight fold. Asia/Amman fell back from
    /// 01:00 to 00:00 on 2018-10-26, so local midnight occurs twice; V8's
    /// compatible rule takes the earlier instant. `TZ` is process-wide, so each
    /// zone runs in its own child and the parent only spawns.
    // VERIFY: wave26-calendar-1
    #[test]
    fn local_midnight_matches_v8_fold_choice() {
        if let Ok(zone) = std::env::var(MIDNIGHT_CHILD_ENV) {
            let midnight = match zone.as_str() {
                // 2018-10-25T21:00:00Z (pre-fold), not 22:00:00Z.
                "Asia/Amman" => (2018, 10, 26, 1_540_501_200_000.0),
                "UTC" => (2026, 10, 27, 1_793_059_200_000.0),
                other => panic!("unknown pinned zone {other}"),
            };
            assert_eq!(
                SystemClock.start_of_local_day_ymd(midnight.0, midnight.1, midnight.2),
                Some(midnight.3),
                "TZ={zone} local midnight"
            );
            return;
        }
        for zone in ["UTC", "Asia/Amman"] {
            let exe = std::env::current_exe().expect("current test executable");
            let output = std::process::Command::new(exe)
                .arg("history::tests::local_midnight_matches_v8_fold_choice")
                .arg("--exact")
                .arg("--nocapture")
                .env("TZ", zone)
                .env(MIDNIGHT_CHILD_ENV, zone)
                .output()
                .expect("spawn the pinned-zone midnight child");
            assert!(
                output.status.success(),
                "TZ={zone} midnight proof failed:\n--- stdout ---\n{}\n--- stderr ---\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            // A renamed test would run zero tests and exit 0 silently.
            assert!(
                String::from_utf8_lossy(&output.stdout).contains("1 passed"),
                "TZ={zone} child did not run the proof:\n{}",
                String::from_utf8_lossy(&output.stdout)
            );
        }
    }
}
