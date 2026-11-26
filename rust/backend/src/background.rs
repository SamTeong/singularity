//! Native port of `server/background.mjs`: quota-soak background jobs.
//!
//! A minute-resolution tick fires when due by [`TICK_MINUTES`], picks the
//! oldest off-cooldown enabled job inside its own local-time window whose
//! per-backend usage gate passes (Claude, then Codex, then Ollama), and creates
//! a normal Tasks-board card tagged `background`. A watchdog re-polls usage and
//! token spend while a run is live and injects [`WRAPUP`] (then hard-kills after
//! [`KILL_GRACE_MS`]) when the budget is spent.
//!
//! State is `state/background.json` (`{"jobs":[...]}`), written atomically. The
//! task service, usage cache, model route and session-token reader are ports so
//! the domain never touches the tasks slice, the usage cache or `stats.rs`
//! directly. Pure gate/pick/window/watchdog functions are public for unit
//! tests and have no side effects.

use std::collections::HashMap;
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{Map, Value, json};

use crate::agent_registry::Registry;
use crate::bus::{Bus, BusEvent};

/// Minute-resolution timer; the logic fires only when due by
/// [`TICK_MINUTES`] (`background.mjs:25`).
pub const TICK_MS: u64 = 60_000;
/// Fixed run cadence — no per-install override (`background.mjs:26`).
pub const TICK_MINUTES: i64 = 60;
/// Watchdog poll period (`background.mjs:27`).
pub const WATCHDOG_MS: u64 = 120_000;
/// Delay between the wrap-up injection and the hard kill (`background.mjs:28`).
pub const KILL_GRACE_MS: u64 = 300_000;
/// The wrap-up prompt injected when a run's budget is spent (`background.mjs:29`).
pub const WRAPUP: &str = "Usage budget reached — stop working now, write Report.md with current progress + remaining steps, move the card to inreview, then stop.";
/// Per-job conclusion choices (`background.mjs:348`).
pub const CONCLUDE_VALUES: [&str; 2] = ["inreview", "done"];
/// Gate evaluation order (`background.mjs:88`).
pub const BACKENDS: [&str; 3] = ["claude", "codex", "ollama"];
const BACKGROUND_FILE: &str = "background.json";

/// `{ permissions: { deny: [] } }` — passed through unchanged (`background.mjs:40`).
pub fn deny_settings() -> Value {
    json!({ "permissions": { "deny": [] } })
}

/// Per-job defaults every create merges over (`background.mjs:44-54`).
pub fn default_job() -> Value {
    json!({
        "window": { "startHour": 9, "endHour": 18, "days": [1, 2, 3, 4, 5] },
        "thresholds": {
            "claude": { "start": 50, "stop": 75, "weeklyMax": 50 },
            "codex": { "start": 50, "stop": 75, "weeklyMax": 50 },
            "ollama": { "start": 50, "stop": 75, "weeklyMax": 50 },
        },
        "models": { "claude": "opus", "codex": "gpt-6-luna", "ollama": "glm-5.3:cloud" },
        "tokenCaps": { "claude": 15_000_000, "codex": 15_000_000, "ollama": 15_000_000 },
        "scopes": [],
    })
}

// ---- Boxed futures and ports -------------------------------------------------

/// A boxed, sendable future — the async-trait-free shape this crate uses.
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

// VERIFY: background-task-service-port
/// The task-service seam (`tasks.mjs:424-544`, `:184`). The production adapter
/// is the host's tasks service; tests use a fake.
pub trait BackgroundTasks: Send + Sync + 'static {
    /// `snapshotTasks()` (`tasks.mjs:184`) → `{"tasks":[…],"history":[…]}`.
    fn snapshot(&self) -> Value;
    /// `createTask(options)` (`tasks.mjs:430-487`).
    fn create<'a>(&'a self, spec: NewBackgroundTask) -> BoxFuture<'a, Result<Value, String>>;
    /// `updateTask(id, patch)` (`tasks.mjs:498-544`).
    fn update<'a>(&'a self, id: &'a str, patch: Value) -> BoxFuture<'a, Result<Value, String>>;
}

/// `createTask` options a background run supplies (`background.mjs:224-228`).
#[derive(Clone, Debug, PartialEq)]
pub struct NewBackgroundTask {
    pub repo: String,
    pub title: String,
    pub description: String,
    pub model: String,
    pub scopes: Vec<String>,
    pub tags: Vec<String>,
    pub background: bool,
    pub background_job_id: String,
    pub background_run_id: String,
    pub conclude: String,
    pub permission_settings: Value,
}

// VERIFY: background-usage-port
/// `getUsage()` (`usage.mjs:938-976`) — the full `{ollama,claude,codex}` doc.
pub trait BackgroundUsage: Send + Sync + 'static {
    fn usage<'a>(&'a self) -> BoxFuture<'a, Result<Value, String>>;
}

impl BackgroundUsage for crate::http_usage::UsageHandle {
    fn usage<'a>(&'a self) -> BoxFuture<'a, Result<Value, String>> {
        Box::pin(async move { self.refresh_auto(&[]).await })
    }
}

// VERIFY: background-session-tokens
/// `parseSession(cwd, id, tool).tokens` (`stats.mjs:64-77`).
pub trait SessionTokens: Send + Sync + 'static {
    fn tokens<'a>(
        &'a self,
        cwd: String,
        session_id: String,
        tool: String,
    ) -> BoxFuture<'a, Result<i64, String>>;
}

// VERIFY: background-registry-port
/// The registry operations the background domain needs (`agents.mjs`: `isLive`,
/// `input`, `kill`). Production wiring passes `runtime.registry`.
pub trait BackgroundRegistry: Send + Sync + 'static {
    fn is_live(&self, id: &str) -> bool;
    fn input(&self, id: &str, data: &str);
    fn kill(&self, id: &str) -> Result<(), String>;
}

impl BackgroundRegistry for Registry {
    fn is_live(&self, id: &str) -> bool {
        Registry::is_live(self, id)
    }

    fn input(&self, id: &str, data: &str) {
        self.write_input(id, data);
    }

    fn kill(&self, id: &str) -> Result<(), String> {
        Registry::kill(self, id)
    }
}

/// `getModelRoute(model, tool)` (`models.mjs:3`) as a host-supplied closure.
pub type ModelRoute = Arc<dyn Fn(&Value, &Value) -> Value + Send + Sync>;

/// Everything the background service needs from the host.
pub struct BackgroundDeps {
    pub state_dir: PathBuf,
    pub reports_dir: PathBuf,
    pub bus: Bus,
    pub registry: Arc<dyn BackgroundRegistry>,
    pub tasks: Arc<dyn BackgroundTasks>,
    pub usage: Arc<dyn BackgroundUsage>,
    pub route: ModelRoute,
    pub tokens: Arc<dyn SessionTokens>,
    /// `Date.now()` in milliseconds.
    pub clock: Arc<dyn Fn() -> i64 + Send + Sync>,
    /// Test seam for `reg.writeAtomic` (`background.test.mjs:57` `failWrite`).
    pub write_atomic: crate::background_reports::WriteAtomic,
}

/// The router maps these to 400 / 409 / 500 (`index.mjs:292`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BackgroundError {
    Validation(String),
    Conflict(String),
    Persist(String),
    /// A stored record the port cannot use (a background task with no
    /// `reportDir`, an unreadable `Report.md`). Node throws out of the two
    /// report GET routes, which have no `try`, so Fastify answers 500
    /// (`background.mjs:481`, `:497`).
    Internal(String),
}

impl BackgroundError {
    pub fn message(&self) -> &str {
        match self {
            Self::Validation(message)
            | Self::Conflict(message)
            | Self::Persist(message)
            | Self::Internal(message) => message,
        }
    }

    pub fn status(&self) -> u16 {
        match self {
            Self::Conflict(_) => 409,
            Self::Persist(_) | Self::Internal(_) => 500,
            Self::Validation(_) => 400,
        }
    }
}

impl std::fmt::Display for BackgroundError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.message())
    }
}

impl std::error::Error for BackgroundError {}

// ---- JS coercion helpers ------------------------------------------------------

/// JavaScript truthiness for JSON values.
pub fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number
            .as_f64()
            .is_some_and(|number| number != 0.0 && !number.is_nan()),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

fn present(value: Option<&Value>) -> Option<&Value> {
    value.filter(|value| !value.is_null())
}

/// Numeric coercion for the comparisons Node performs on JSON fields.
fn js_number(value: &Value) -> Option<f64> {
    match value {
        Value::Number(number) => number.as_f64(),
        Value::Bool(flag) => Some(if *flag { 1.0 } else { 0.0 }),
        Value::Null => Some(0.0),
        Value::String(text) => {
            let text = text.trim();
            if text.is_empty() {
                Some(0.0)
            } else {
                text.parse::<f64>().ok()
            }
        }
        _ => None,
    }
}

/// A field's text as a JS template literal would render it.
fn js_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

// ---- Pure functions (exported, unit-tested) ------------------------------------

/// Local `(weekday 0=Sunday, hour)` for a wall-clock instant.
fn local_weekday_hour(at_ms: i64) -> Option<(u8, u8)> {
    let secs = at_ms.div_euclid(1000);
    let offset = local_offset_secs_at(secs);
    let stamp = time::OffsetDateTime::from_unix_timestamp(secs + i64::from(offset)).ok()?;
    Some((stamp.weekday().number_days_from_sunday(), stamp.hour()))
}

// VERIFY: background-pure-in-window
/// `inWindow(job, date)` (`background.mjs:66-70`).
pub fn in_window(job: &Value, at_ms: i64) -> bool {
    let Some(window) = job.get("window") else {
        return false;
    };
    let (weekday, hour) = match local_weekday_hour(at_ms) {
        Some(parts) => parts,
        None => return false,
    };
    let (Some(start), Some(end)) = (
        window.get("startHour").and_then(js_number),
        window.get("endHour").and_then(js_number),
    ) else {
        return false;
    };
    // VERIFY: wave3-fix-background-7
    // `days.includes(date.getDay())` is strict (`background.mjs:69`), so a
    // string entry never matches; only a JSON number can.
    let in_days = window
        .get("days")
        .and_then(Value::as_array)
        .is_some_and(|days| {
            days.iter()
                .any(|day| day.as_f64() == Some(f64::from(weekday)))
        });
    in_days && f64::from(hour) >= start && f64::from(hour) < end
}

/// Why a backend's gate fails, or `None` when it passes (`background.mjs:74-81`).
///
/// `thresholds` is the raw `job.thresholds[backend]` value: `None` when the key
/// is absent, `Some(Value::Null)` when it is explicitly null. Reaching the
/// comparison with either throws inside Node's `th.start`/`th.weeklyMax` read,
/// which is modelled as `Err` here (see [`eval_gate`]).
fn gate_reason(
    usage: Option<&Value>,
    thresholds: Option<&Value>,
    name: &str,
) -> Result<Option<String>, String> {
    let Some(source) = usage else {
        return Ok(Some(format!("{name} usage unavailable")));
    };
    if !js_truthy(source.get("ok").unwrap_or(&Value::Null)) {
        return Ok(Some(format!("{name} usage unavailable")));
    }
    let session = present(source.get("session").and_then(|value| value.get("pctUsed")));
    let weekly = present(source.get("weekly").and_then(|value| value.get("pctUsed")));
    if session.is_none() && weekly.is_none() {
        return Ok(Some(format!("{name} usage incomplete")));
    }
    // VERIFY: wave3-fix-background-4
    // VERIFY: wave5-fix-cron-bg-10
    // With the usage gate reached, Node's `sess >= th.start` (when the session
    // reading is non-null) or `wk >= th.weeklyMax` (when only the weekly one is)
    // reads through an undefined/null `th` and throws out of `gateReason`,
    // `evalGate` and `attemptRun` (`background.mjs:78-79`, `:248`), so the run
    // never starts. Report that as an error rather than a gate reason: a
    // partially populated `thresholds` object must not let a later backend run
    // the job.
    let Some(thresholds) = thresholds.filter(|value| !value.is_null()) else {
        let kind = if thresholds.is_some() {
            "null"
        } else {
            "undefined"
        };
        let field = if session.is_some() {
            "start"
        } else {
            "weeklyMax"
        };
        return Err(format!(
            "Cannot read properties of {kind} (reading '{field}')"
        ));
    };
    if let (Some(session), Some(start)) = (
        session.and_then(js_number),
        thresholds.get("start").and_then(js_number),
    ) {
        if session >= start {
            return Ok(Some(format!(
                "{name} 5h {}% >= {}%",
                js_text(session_value(source)),
                js_text(&thresholds["start"])
            )));
        }
    }
    if let (Some(weekly), Some(weekly_max)) = (
        weekly.and_then(js_number),
        thresholds.get("weeklyMax").and_then(js_number),
    ) {
        if weekly >= weekly_max {
            return Ok(Some(format!(
                "{name} 7d {}% >= {}%",
                js_text(weekly_value(source)),
                js_text(&thresholds["weeklyMax"])
            )));
        }
    }
    Ok(None)
}

fn session_value(source: &Value) -> &Value {
    source
        .get("session")
        .and_then(|value| value.get("pctUsed"))
        .unwrap_or(&Value::Null)
}

fn weekly_value(source: &Value) -> &Value {
    source
        .get("weekly")
        .and_then(|value| value.get("pctUsed"))
        .unwrap_or(&Value::Null)
}

// VERIFY: background-gate-eval
/// `evalGate(usage, job)` (`background.mjs:86-94`). `Err` carries Node's thrown
/// `TypeError` text: the whole attempt aborts, the job is not merely skipped.
pub fn eval_gate(usage: &Value, job: &Value) -> Result<(Option<&'static str>, String), String> {
    let container = job.get("thresholds");
    let mut reasons = Vec::new();
    for backend in BACKENDS {
        // VERIFY: wave5-fix-cron-bg-11
        // Node evaluates `job.thresholds[backend]` before calling `gateReason`,
        // so an absent or null container throws for the first backend whatever
        // the usage says.
        let entry = match container {
            Some(value) if !value.is_null() => value.get(backend),
            Some(_) => {
                return Err(format!(
                    "Cannot read properties of null (reading '{backend}')"
                ));
            }
            None => {
                return Err(format!(
                    "Cannot read properties of undefined (reading '{backend}')"
                ));
            }
        };
        match gate_reason(usage.get(backend), entry, backend)? {
            None => return Ok((Some(backend), format!("{backend} within budget"))),
            Some(reason) => reasons.push(reason),
        }
    }
    Ok((None, reasons.join("; ")))
}

fn has_pending(job: &Value) -> bool {
    job.get("pendingRunId").is_some_and(js_truthy)
}

fn ready(job: &Value, now: i64) -> bool {
    if !job.get("enabled").is_some_and(js_truthy) || has_pending(job) {
        return false;
    }
    match job.get("lastRunAt") {
        None => true,
        Some(Value::Null) => true,
        Some(last) => {
            let Some(last) = js_number(last) else {
                return false;
            };
            let Some(cooldown) = job.get("cooldownHours").and_then(js_number) else {
                return false;
            };
            now as f64 - last > cooldown * 3_600_000.0
        }
    }
}

fn last_run_key(job: &Value) -> f64 {
    // VERIFY: wave3-fix-background-8
    // `a.lastRunAt ?? -Infinity` (`background.mjs:101`, `:116`): a missing or
    // null timestamp sorts as the oldest, not at epoch 0.
    match job.get("lastRunAt") {
        None | Some(Value::Null) => f64::NEG_INFINITY,
        Some(value) => js_number(value).unwrap_or(f64::NEG_INFINITY),
    }
}

fn by_last_run(jobs: &mut [Value]) {
    jobs.sort_by(|left, right| last_run_key(left).total_cmp(&last_run_key(right)));
}

// VERIFY: background-pick-job
/// `pickJob(jobs, now)` (`background.mjs:98-103`) — forced runs only.
pub fn pick_job(jobs: &[Value], now: i64) -> Option<Value> {
    let mut ready: Vec<Value> = jobs.iter().filter(|job| ready(job, now)).cloned().collect();
    by_last_run(&mut ready);
    ready.into_iter().next()
}

/// The `pickRunnableJob` result (`background.mjs:111-125`).
#[derive(Clone, Debug, PartialEq)]
pub struct Picked {
    pub job: Option<Value>,
    pub backend: Option<&'static str>,
    pub reason: String,
}

// VERIFY: background-pick-runnable
/// `pickRunnableJob(jobs, usage, now, {bypassWindow})` (`background.mjs:111-125`).
/// An `Err` from a candidate's gate aborts the whole pick, like Node's throw.
pub fn pick_runnable_job(
    jobs: &[Value],
    usage: &Value,
    now: i64,
    bypass_window: bool,
) -> Result<Picked, String> {
    let mut candidates: Vec<Value> = jobs
        .iter()
        .filter(|job| ready(job, now) && (bypass_window || in_window(job, now)))
        .cloned()
        .collect();
    by_last_run(&mut candidates);
    if candidates.is_empty() {
        return Ok(Picked {
            job: None,
            backend: None,
            reason: "did not find eligible task to run".to_owned(),
        });
    }
    let mut reasons = Vec::new();
    for job in candidates {
        let (backend, reason) = eval_gate(usage, &job)?;
        if backend.is_some() {
            return Ok(Picked {
                job: Some(job),
                backend,
                reason: String::new(),
            });
        }
        reasons.push(format!(
            "{}: {reason}",
            job.get("title").map(js_text).unwrap_or_default()
        ));
    }
    Ok(Picked {
        job: None,
        backend: None,
        reason: reasons.join("; "),
    })
}

/// `watchdogDecision`'s two outcomes (`background.mjs:128-136`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Decision {
    Continue,
    Stop,
}

// VERIFY: background-watchdog-decision
/// `watchdogDecision(usage, backend, job, tokens)` — fail closed on any
/// unavailable or unreadable source (`background.mjs:128-136`).
pub fn watchdog_decision(usage: &Value, backend: &str, job: &Value, tokens: i64) -> Decision {
    let Some(source) = usage.get(backend) else {
        return Decision::Stop;
    };
    if !js_truthy(source.get("ok").unwrap_or(&Value::Null)) {
        return Decision::Stop;
    }
    // VERIFY: wave3-fix-background-5
    // `job.thresholds[backend]` on a missing or null container throws inside
    // Node's watchdog try, which leaves the fail-closed `stop` in place
    // (`background.mjs:130`, `:263-269`). A missing or null *per-backend* entry
    // throws at `th.stop` for the same reason, so it also stops; a primitive
    // entry, and a missing `tokenCaps[backend]` entry, compare against
    // `undefined` and stay permissive (`background.mjs:134`).
    // VERIFY: wave5-fix-cron-bg-16
    let Some(thresholds) = job
        .get("thresholds")
        .and_then(|value| value.get(backend))
        .filter(|value| !value.is_null())
    else {
        return Decision::Stop;
    };
    if let Some(stop) = thresholds.get("stop").and_then(js_number) {
        let session = source
            .get("session")
            .and_then(|value| value.get("pctUsed"))
            .and_then(js_number)
            .unwrap_or(0.0);
        if session >= stop {
            return Decision::Stop;
        }
    }
    if let Some(weekly_max) = thresholds.get("weeklyMax").and_then(js_number) {
        let weekly = source
            .get("weekly")
            .and_then(|value| value.get("pctUsed"))
            .and_then(js_number)
            .unwrap_or(0.0);
        if weekly >= weekly_max {
            return Decision::Stop;
        }
    }
    let Some(caps) = job.get("tokenCaps").filter(|value| !value.is_null()) else {
        return Decision::Stop;
    };
    if let Some(cap) = caps.get(backend).and_then(js_number) {
        if tokens as f64 >= cap {
            return Decision::Stop;
        }
    }
    Decision::Continue
}

// VERIFY: background-migrate-legacy
/// `migrateLegacyConfig(loaded)` (`background.mjs:287-296`). Pure: seeds the old
/// flat top-level `window`/`thresholds`/`models`/`tokenCaps` onto any job that
/// does not carry its own copy.
pub fn migrate_legacy_config(loaded: &Value) -> (Value, bool) {
    let legacy: Vec<&str> = ["window", "thresholds", "models", "tokenCaps"]
        .into_iter()
        .filter(|key| loaded.get(*key).is_some_and(|value| !value.is_null()))
        .collect();
    let jobs: Vec<Value> = loaded
        .get("jobs")
        .or_else(|| loaded.get("defs"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let jobs: Vec<Value> = jobs
        .into_iter()
        .map(|job| {
            if legacy.is_empty() {
                return job;
            }
            let Value::Object(mut seeded) = job.clone() else {
                return job;
            };
            for key in &legacy {
                if !seeded.contains_key(*key) {
                    seeded.insert((*key).to_owned(), loaded[*key].clone());
                }
            }
            Value::Object(seeded)
        })
        .collect();
    (json!({ "jobs": jobs }), !legacy.is_empty())
}

// ---- Local time ---------------------------------------------------------------

/// Local UTC offset in seconds east of UTC at one instant (DST-aware), from the
/// zone the writer and parser share.
fn local_offset_secs_at(utc_secs: i64) -> i32 {
    crate::usage_snapshot::local_offset_secs_at(utc_secs)
}

// ---- UUID ---------------------------------------------------------------------

static UUID_FALLBACK: AtomicU64 = AtomicU64::new(0);

/// A random UUID v4 (`randomUUID()`); falls back to a time/pid/counter mix only
/// if the system CSPRNG is unavailable.
fn uuid_v4() -> String {
    let mut bytes = [0u8; 16];
    let random = ring::rand::SystemRandom::new();
    if ring::rand::SecureRandom::fill(&random, &mut bytes).is_err() {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|elapsed| elapsed.as_nanos() as u64)
            .unwrap_or(0);
        let mut state = nanos
            ^ (u64::from(std::process::id()) << 32)
            ^ UUID_FALLBACK.fetch_add(0x9E37_79B9_7F4A_7C15, Ordering::SeqCst);
        for chunk in bytes.chunks_mut(8) {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            for (index, byte) in chunk.iter_mut().enumerate() {
                *byte = (state >> (index * 8)) as u8;
            }
        }
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: Vec<String> = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        hex[0..4].concat(),
        hex[4..6].concat(),
        hex[6..8].concat(),
        hex[8..10].concat(),
        hex[10..16].concat()
    )
}

// ---- Service -----------------------------------------------------------------

/// `attemptRun` options (`background.mjs:190`).
#[derive(Clone, Copy, Debug, Default)]
pub struct Attempt {
    pub bypass_window: bool,
    pub bypass_gate: bool,
    pub manual: bool,
}

struct Inner {
    config: Value,
    last_tick: Value,
    last_due_at: i64,
    injected_task_id: Option<String>,
}

/// The background-task service. Every critical section is short and
/// synchronous; the file write happens under the mutex so the in-memory config
/// only ever advances past a successful write. No `await` or bus emit runs
/// while the lock is held.
pub struct Service {
    deps: BackgroundDeps,
    inner: Mutex<Inner>,
    attempting: AtomicBool,
    flags: crate::background_reports::FlagStore,
    flag_lock: Mutex<()>,
}

impl Service {
    // VERIFY: background-deps
    // VERIFY: background-init-recover
    /// Port of `initBackground` (`background.mjs:298-340`): load, migrate,
    /// recover pending intents. Missing or malformed state never throws.
    pub fn new(deps: BackgroundDeps) -> Arc<Self> {
        let now = (deps.clock)();
        let flags = crate::background_reports::FlagStore::new(
            deps.state_dir.clone(),
            deps.write_atomic.clone(),
        );
        let service = Arc::new(Self {
            deps,
            inner: Mutex::new(Inner {
                config: json!({ "jobs": [] }),
                last_tick: Value::Null,
                last_due_at: now,
                injected_task_id: None,
            }),
            attempting: AtomicBool::new(false),
            flags,
            flag_lock: Mutex::new(()),
        });
        service.load();
        service.recover();
        service
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|error| error.into_inner())
    }

    fn config(&self) -> Value {
        self.lock().config.clone()
    }

    fn jobs(&self) -> Vec<Value> {
        self.config()
            .get("jobs")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
    }

    fn set_config(&self, config: Value) {
        self.lock().config = config;
    }

    pub(crate) fn now(&self) -> i64 {
        (self.deps.clock)()
    }

    fn persist(&self, config: &Value) -> Result<(), BackgroundError> {
        let path = self.deps.state_dir.join(BACKGROUND_FILE);
        let body = serde_json::to_string_pretty(config).expect("the config serializes");
        (self.deps.write_atomic)(&path, body.as_bytes()).map_err(|error| {
            BackgroundError::Persist(format!("background.json write failed: {error}"))
        })
    }

    // VERIFY: wave3-fix-background-1
    /// Persist `next` and advance the in-memory config in the same critical
    /// section; the caller holds `inner`. Node's `persist(next); config = next;`
    /// is atomic because the runtime is single-threaded (`background.mjs:140-149`,
    /// `:380-381`); here the guard, not the interpreter, has to supply that.
    fn commit(&self, inner: &mut Inner, next: Value) -> Result<(), BackgroundError> {
        self.persist(&next)?;
        inner.config = next;
        Ok(())
    }

    // VERIFY: wave3-fix-background-3
    // VERIFY: wave5-fix-cron-bg-13
    /// Replace one job of the *current* config with `entry` and commit it, the
    /// way Node's attempt writes map over the latest `config.jobs`
    /// (`background.mjs:221-234`): other jobs keep a concurrent edit, but the
    /// picked job's entry is the snapshot taken before the `getUsage()` await,
    /// so a PATCH to that same job landing during the await is reverted — in
    /// Node by both the pending and the completion write. That is the reference
    /// behaviour; do not rebase it onto the current entry without a parity
    /// decision.
    fn replace_job_entry(&self, id: &str, entry: Value) -> Result<(), BackgroundError> {
        let mut inner = self.lock();
        let mut next = inner.config.clone();
        if let Some(jobs) = next.get_mut("jobs").and_then(Value::as_array_mut) {
            for job in jobs.iter_mut() {
                if job.get("id").and_then(Value::as_str) == Some(id) {
                    *job = entry.clone();
                    break;
                }
            }
        }
        self.commit(&mut inner, next)
    }

    fn load(&self) {
        let path = self.deps.state_dir.join(BACKGROUND_FILE);
        if path.exists() {
            let Ok(text) = std::fs::read_to_string(&path) else {
                return;
            };
            let Ok(loaded) = serde_json::from_str::<Value>(&text) else {
                return;
            };
            let (config, migrated) = migrate_legacy_config(&loaded);
            self.set_config(config);
            if migrated {
                let _ = self.persist(&self.config());
            }
        } else {
            let _ = self.persist(&json!({ "jobs": [] }));
        }
    }

    /// Joins each pending intent to its durable task; an unknown outcome keeps
    /// the intent so it is never retried blindly (`background.mjs:311-327`).
    fn recover(&self) {
        let snapshot = self.deps.tasks.snapshot();
        let tasks = snapshot
            .get("tasks")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let mut config = self.config();
        let Some(jobs) = config.get_mut("jobs").and_then(Value::as_array_mut) else {
            return;
        };
        let mut recovered = false;
        for job in jobs.iter_mut() {
            let Some(pending) = job
                .get("pendingRunId")
                .and_then(Value::as_str)
                .map(str::to_owned)
            else {
                continue;
            };
            let id = job.get("id").and_then(Value::as_str).map(str::to_owned);
            let Some(id) = id else {
                continue;
            };
            let matched = tasks.iter().find(|task| {
                task.get("backgroundJobId").and_then(Value::as_str) == Some(id.as_str())
                    && task.get("backgroundRunId").and_then(Value::as_str) == Some(pending.as_str())
            });
            let Some(task) = matched else {
                continue;
            };
            recovered = true;
            let pending_at = job.get("pendingRunAt").cloned().unwrap_or(Value::Null);
            let task_id = task.get("id").cloned().unwrap_or(Value::Null);
            if let Value::Object(fields) = job {
                fields.insert("lastRunAt".to_owned(), pending_at);
                fields.insert("lastTaskId".to_owned(), task_id);
                fields.shift_remove("pendingRunId");
                fields.shift_remove("pendingRunAt");
            }
        }
        if recovered {
            // Persist first: a failed write leaves the intent in effect.
            if self.persist(&config).is_ok() {
                self.set_config(config);
            }
        }
    }

    /// The one actively-running background card, or `None` (`background.mjs:156-159`).
    pub fn live_background_task(&self) -> Option<Value> {
        self.deps
            .tasks
            .snapshot()
            .get("tasks")
            .and_then(Value::as_array)
            .and_then(|tasks| tasks.iter().find(|task| is_live_card(task)).cloned())
    }

    // VERIFY: background-snapshot
    // VERIFY: background-live-task
    /// `snapshotBackground()` (`background.mjs:161-164`).
    pub fn snapshot(&self) -> Value {
        let (config, last_tick, last_due_at) = {
            let inner = self.lock();
            (
                inner.config.clone(),
                inner.last_tick.clone(),
                inner.last_due_at,
            )
        };
        let live = self.live_background_task();
        json!({
            "config": config,
            "lastTick": last_tick,
            "liveTaskId": live
                .as_ref()
                .and_then(|task| task.get("id"))
                .cloned()
                .unwrap_or(Value::Null),
            "nextDueAt": last_due_at + TICK_MINUTES * 60_000,
        })
    }

    fn emit(&self) {
        let snapshot = self.snapshot();
        self.deps.bus.emit(&BusEvent::Background(snapshot));
    }

    /// Atomically claims the minute-resolution due gate (`background.mjs:243-246`).
    pub fn take_due(&self, now: i64, interval_ms: i64) -> bool {
        let mut inner = self.lock();
        if now - inner.last_due_at < interval_ms {
            return false;
        }
        inner.last_due_at = now;
        true
    }

    fn record_tick(&self, at: i64, action: &str, reason: String) {
        self.lock().last_tick = json!({ "at": at, "action": action, "reason": reason });
    }

    fn refuse(
        &self,
        reason: String,
        manual: bool,
        now: i64,
    ) -> Result<Option<Value>, BackgroundError> {
        if manual {
            return Err(BackgroundError::Validation(reason));
        }
        self.record_tick(now, "skipped", reason);
        self.emit();
        Ok(None)
    }

    // VERIFY: background-attempt-run
    /// `attemptRun` (`background.mjs:190-241`): single-flight, pending-intent
    /// block, heal, pick, reserve, create, complete.
    pub async fn attempt_run(&self, attempt: Attempt) -> Result<Option<Value>, BackgroundError> {
        let now = self.now();
        if self
            .attempting
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return self.refuse(
                "a background run is already live".to_owned(),
                attempt.manual,
                now,
            );
        }
        let _guard = AttemptGuard(&self.attempting);

        if self.jobs().iter().any(has_pending) {
            return self.refuse(
                "a background run has an unresolved pending intent; resolve it manually".to_owned(),
                attempt.manual,
                now,
            );
        }
        if self.heal_live_bg_task().await.is_some() {
            return self.refuse(
                "a background run is already live".to_owned(),
                attempt.manual,
                now,
            );
        }

        let (job, backend) = if attempt.bypass_gate {
            match pick_job(&self.jobs(), now) {
                Some(job) => (job, "claude"),
                None => {
                    return self.refuse(
                        "did not find eligible task to run".to_owned(),
                        attempt.manual,
                        now,
                    );
                }
            }
        } else {
            // VERIFY: wave5-fix-cron-bg-21
            // `pickRunnableJob(config.jobs, await getUsage(), …)`
            // (`background.mjs:211`): arguments evaluate left to right, so the
            // job snapshot predates the usage fetch. A PATCH to the picked job
            // landing during that fetch is therefore reverted by the two attempt
            // writes, exactly as in Node — do not read the jobs after the await.
            let jobs = self.jobs();
            let usage = match self.deps.usage.usage().await {
                Ok(usage) => usage,
                // Node lets a usage throw escape `attemptRun`; the tick's caller
                // logs it and no skip is recorded.
                Err(error) => return Err(BackgroundError::Validation(error)),
            };
            let picked = pick_runnable_job(&jobs, &usage, now, attempt.bypass_window);
            let picked = match picked {
                Ok(picked) => picked,
                // Node lets `evalGate`'s throw escape `attemptRun`
                // (`background.mjs:248`): the tick's caller only logs it and the
                // manual route answers 400. No skip is recorded.
                Err(message) => return Err(BackgroundError::Validation(message)),
            };
            match picked.job {
                Some(job) => (job, picked.backend.unwrap_or("claude")),
                None => return self.refuse(picked.reason, attempt.manual, now),
            }
        };

        // VERIFY: wave3-fix-background-6
        // `job.models[backend]` throws in Node when the job has no `models`
        // object (`background.mjs:215`), so nothing runs and no intent is
        // written. A missing/null per-backend entry only yields null/undefined
        // there, which createTask passes through as "no model" — the String seam
        // carries that as "".
        // VERIFY: wave5-fix-cron-bg-12
        // The container throw mirrors Node's `TypeError` text: the manual route
        // puts it in the 400 body, and only the body shape differs (disclosed).
        let job_id = job.get("id").map(js_text).unwrap_or_default();
        let Some(models) = job.get("models").filter(|value| !value.is_null()) else {
            let kind = if job.get("models").is_some() {
                "null"
            } else {
                "undefined"
            };
            return Err(BackgroundError::Validation(format!(
                "Cannot read properties of {kind} (reading '{backend}')"
            )));
        };
        let model = match models.get(backend) {
            Some(Value::String(text)) => text.clone(),
            Some(value) if !value.is_null() => js_text(value),
            _ => String::new(),
        };
        let run_id = uuid_v4();
        // VERIFY: wave5-fix-cron-bg-14
        // `pendingJob = { ...job, pendingRunId, pendingRunAt }` from the stale
        // snapshot (`background.mjs:221-223`), not a field-wise patch of the
        // current entry.
        let mut pending_job = job.clone();
        if let Value::Object(fields) = &mut pending_job {
            fields.insert("pendingRunId".to_owned(), json!(run_id.clone()));
            fields.insert("pendingRunAt".to_owned(), json!(now));
        }
        self.replace_job_entry(&job_id, pending_job.clone())?;

        let spec = NewBackgroundTask {
            repo: job.get("cwd").map(js_text).unwrap_or_default(),
            title: job.get("title").map(js_text).unwrap_or_default(),
            description: job.get("description").map(js_text).unwrap_or_default(),
            model: model.clone(),
            scopes: job
                .get("scopes")
                .and_then(Value::as_array)
                .map(|scopes| {
                    scopes
                        .iter()
                        .filter_map(|scope| scope.as_str().map(str::to_owned))
                        .collect()
                })
                .unwrap_or_default(),
            tags: vec!["background".to_owned()],
            background: true,
            background_job_id: job_id.clone(),
            background_run_id: run_id,
            conclude: match job.get("conclude").and_then(Value::as_str) {
                Some("done") => "done".to_owned(),
                _ => "inreview".to_owned(),
            },
            permission_settings: deny_settings(),
        };
        let task = match self.deps.tasks.create(spec).await {
            Ok(task) => task,
            Err(error) => {
                // Unknown create outcome: keep the intent so nothing is retried.
                return Err(BackgroundError::Validation(error));
            }
        };

        let task_id = task.get("id").cloned().unwrap_or(Value::Null);
        // VERIFY: wave5-fix-cron-bg-15
        // `completedJob = { ...pendingJob, lastRunAt, lastTaskId }` minus the
        // pending pair (`background.mjs:228-231`) — derived from the stale
        // snapshot again, so the same PATCH is reverted a second time.
        let mut completed_job = pending_job;
        if let Value::Object(fields) = &mut completed_job {
            fields.insert("lastRunAt".to_owned(), json!(now));
            fields.insert("lastTaskId".to_owned(), task_id.clone());
            fields.shift_remove("pendingRunId");
            fields.shift_remove("pendingRunAt");
        }
        self.replace_job_entry(&job_id, completed_job)?;

        self.record_tick(
            self.now(),
            "ran",
            format!(
                "{} → {backend}/{model}",
                job.get("title").map(js_text).unwrap_or_default()
            ),
        );
        self.emit();
        Ok(Some(task))
    }

    // VERIFY: background-heal
    /// `healLiveBgTask` (`background.mjs:177-184`): release a dead session so
    /// the single-flight guard cannot latch forever.
    pub async fn heal_live_bg_task(&self) -> Option<Value> {
        let task = self.live_background_task()?;
        let session_id = task
            .get("sessionId")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .map(str::to_owned);
        let Some(session_id) = session_id else {
            return Some(task);
        };
        if self.deps.registry.is_live(&session_id) {
            return Some(task);
        }
        self.lock().injected_task_id = None;
        let id = task
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        match self
            .deps
            .tasks
            .update(
                &id,
                json!({ "column": "inreview", "state": "parked — needs human" }),
            )
            .await
        {
            Ok(_) => {
                self.emit();
                None
            }
            Err(_) => Some(task),
        }
    }

    // VERIFY: background-watchdog
    /// `watchdog` (`background.mjs:253-281`) with the shipped grace.
    pub async fn watchdog(self: &Arc<Self>) {
        self.watchdog_with_grace(KILL_GRACE_MS).await;
    }

    /// [`Self::watchdog`] with an injected grace so tests need not wait 5 min.
    pub async fn watchdog_with_grace(self: &Arc<Self>, grace_ms: u64) {
        let Some(task) = self.heal_live_bg_task().await else {
            self.lock().injected_task_id = None;
            return;
        };
        let id = task
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        if self.lock().injected_task_id.as_deref() == Some(id.as_str()) {
            return;
        }
        let mut decision = Decision::Stop;
        if let Some(job) = self
            .jobs()
            .into_iter()
            .find(|job| job.get("lastTaskId").and_then(Value::as_str) == Some(id.as_str()))
        {
            let backend = backend_for(&self.deps.route, &task);
            let session_id = task.get("sessionId").map(js_text).unwrap_or_default();
            let cwd = task
                .get("worktree")
                .filter(|value| js_truthy(value))
                .map(js_text)
                .or_else(|| task.get("repo").map(js_text))
                .unwrap_or_default();
            if let Ok(usage) = self.deps.usage.usage().await {
                if let Ok(tokens) = self
                    .deps
                    .tokens
                    .tokens(cwd, session_id, backend.to_owned())
                    .await
                {
                    decision = watchdog_decision(&usage, backend, &job, tokens);
                }
            }
        }
        if decision == Decision::Continue {
            return;
        }
        self.lock().injected_task_id = Some(id);
        let session_id = task.get("sessionId").map(js_text).unwrap_or_default();
        self.deps
            .registry
            .input(&session_id, &format!("\r{WRAPUP}\r"));
        let service = self.clone();
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(async move {
                if grace_ms > 0 {
                    tokio::time::sleep(Duration::from_millis(grace_ms)).await;
                }
                service.enforce_grace(&task).await;
            });
        }
    }

    /// The `setTimeout` body of the watchdog: kill a still-live session and park
    /// the card at `stopped — budget` (`background.mjs:274-280`).
    pub async fn enforce_grace(&self, task: &Value) {
        let session_id = task.get("sessionId").map(js_text).unwrap_or_default();
        if !self.deps.registry.is_live(&session_id) {
            return;
        }
        let _ = self.deps.registry.kill(&session_id);
        let id = task
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let _ = self
            .deps
            .tasks
            .update(
                &id,
                json!({ "column": "inreview", "state": "stopped — budget" }),
            )
            .await;
    }

    // ---- CRUD -----------------------------------------------------------------

    // VERIFY: background-create-job
    // VERIFY: background-persist-atomic
    /// `createJob` (`background.mjs:350-384`).
    pub fn create_job(
        &self,
        body: &Value,
        idempotency_key: Option<&str>,
    ) -> Result<Value, BackgroundError> {
        let text = |key: &str| {
            body.get(key)
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_owned()
        };
        let title = text("title");
        let description = text("description");
        let cwd = text("cwd");
        if title.is_empty() || description.is_empty() || cwd.is_empty() {
            return Err(BackgroundError::Validation(
                "title, description, cwd required".to_owned(),
            ));
        }
        validate_conclude(body)?;

        let defaults = default_job();
        let mut payload = Map::new();
        payload.insert("title".to_owned(), json!(title));
        payload.insert("description".to_owned(), json!(description));
        payload.insert("cwd".to_owned(), json!(cwd));
        payload.insert(
            "cooldownHours".to_owned(),
            present(body.get("cooldownHours"))
                .cloned()
                .unwrap_or(json!(24)),
        );
        payload.insert(
            "enabled".to_owned(),
            json!(body.get("enabled") != Some(&Value::Bool(false))),
        );
        payload.insert(
            "window".to_owned(),
            merge_object(&defaults["window"], body.get("window")),
        );
        let mut thresholds = Map::new();
        for backend in BACKENDS {
            thresholds.insert(
                backend.to_owned(),
                merge_object(
                    &defaults["thresholds"][backend],
                    body.get("thresholds").and_then(|value| value.get(backend)),
                ),
            );
        }
        payload.insert("thresholds".to_owned(), Value::Object(thresholds));
        payload.insert(
            "models".to_owned(),
            merge_object(&defaults["models"], body.get("models")),
        );
        payload.insert(
            "tokenCaps".to_owned(),
            merge_object(&defaults["tokenCaps"], body.get("tokenCaps")),
        );
        payload.insert(
            "scopes".to_owned(),
            body.get("scopes")
                .filter(|value| value.is_array())
                .cloned()
                .unwrap_or(json!([])),
        );
        payload.insert(
            "conclude".to_owned(),
            body.get("conclude").cloned().unwrap_or(json!("inreview")),
        );
        let payload = Value::Object(payload);

        let key = idempotency_key
            .map(str::trim)
            .filter(|key| !key.is_empty())
            .map(str::to_owned);
        let mut job = Map::new();
        job.insert("id".to_owned(), json!(uuid_v4()));
        if let Value::Object(fields) = &payload {
            for (field, value) in fields {
                job.insert(field.clone(), value.clone());
            }
        }
        if let Some(key) = &key {
            job.insert("idempotencyKey".to_owned(), json!(key));
            job.insert(
                "idempotencyPayload".to_owned(),
                json!(serde_json::to_string(&payload).expect("the payload serializes")),
            );
        }
        job.insert("lastRunAt".to_owned(), Value::Null);
        job.insert("lastTaskId".to_owned(), Value::Null);
        let job = Value::Object(job);

        // VERIFY: wave3-fix-background-2
        // The idempotency lookup, the append and the write share one critical
        // section, so a retry that races the first request always sees it
        // (`background.mjs:367-374`).
        {
            let mut inner = self.lock();
            if let Some(key) = key.as_deref() {
                let existing =
                    inner
                        .config
                        .get("jobs")
                        .and_then(Value::as_array)
                        .and_then(|jobs| {
                            jobs.iter().find(|job| {
                                job.get("idempotencyKey").and_then(Value::as_str) == Some(key)
                            })
                        });
                if let Some(existing) = existing {
                    let fingerprint = existing
                        .get("idempotencyPayload")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                        .unwrap_or_else(|| {
                            serde_json::to_string(&fingerprint(existing))
                                .expect("a job fingerprint serializes")
                        });
                    if !fingerprint_matches(&fingerprint, &payload) {
                        return Err(BackgroundError::Conflict(
                            "Idempotency-Key was already used with a different payload".to_owned(),
                        ));
                    }
                    // Node returns the original without persisting or emitting.
                    return Ok(existing.clone());
                }
            }
            let mut next = inner.config.clone();
            if let Some(jobs) = next.get_mut("jobs").and_then(Value::as_array_mut) {
                jobs.push(job.clone());
            }
            self.commit(&mut inner, next)?;
        }
        self.emit();
        Ok(job)
    }

    // VERIFY: background-update-job
    /// `updateJob` (`background.mjs:390-412`): per-backend threshold merge so
    /// editing one field never wipes its siblings.
    pub fn update_job(&self, id: &str, partial: &Value) -> Result<Value, BackgroundError> {
        let mut inner = self.lock();
        let mut next = inner.config.clone();
        let Some(current) = next
            .get("jobs")
            .and_then(Value::as_array)
            .and_then(|jobs| {
                jobs.iter()
                    .find(|job| job.get("id").and_then(Value::as_str) == Some(id))
            })
            .cloned()
        else {
            return Err(BackgroundError::Validation("no such job".to_owned()));
        };
        validate_conclude(partial)?;
        let Value::Object(mut job) = current else {
            return Err(BackgroundError::Validation("no such job".to_owned()));
        };
        for key in [
            "title",
            "description",
            "cwd",
            "cooldownHours",
            "enabled",
            "lastRunAt",
            "lastTaskId",
            "conclude",
        ] {
            if let Some(value) = partial.get(key) {
                job.insert(key.to_owned(), value.clone());
            }
        }
        if partial.get("window").is_some_and(js_truthy) {
            job.insert(
                "window".to_owned(),
                merge_object(
                    job.get("window").unwrap_or(&Value::Null),
                    partial.get("window"),
                ),
            );
        }
        if let Some(thresholds) = partial.get("thresholds").filter(|value| js_truthy(value)) {
            let mut next = job
                .get("thresholds")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            if let Value::Object(patches) = thresholds {
                for (backend, patch) in patches {
                    if js_truthy(patch) {
                        let merged =
                            merge_object(next.get(backend).unwrap_or(&Value::Null), Some(patch));
                        next.insert(backend.clone(), merged);
                    }
                }
            }
            job.insert("thresholds".to_owned(), Value::Object(next));
        }
        for key in ["models", "tokenCaps"] {
            if partial.get(key).is_some_and(js_truthy) {
                job.insert(
                    key.to_owned(),
                    merge_object(job.get(key).unwrap_or(&Value::Null), partial.get(key)),
                );
            }
        }
        if partial.get("scopes").is_some_and(Value::is_array) {
            job.insert("scopes".to_owned(), partial["scopes"].clone());
        }
        let job = Value::Object(job);
        if let Some(jobs) = next.get_mut("jobs").and_then(Value::as_array_mut) {
            for entry in jobs.iter_mut() {
                if entry.get("id").and_then(Value::as_str) == Some(id) {
                    *entry = job.clone();
                }
            }
        }
        self.commit(&mut inner, next)?;
        drop(inner);
        self.emit();
        Ok(job)
    }

    // VERIFY: background-delete-job
    /// `deleteJob` (`background.mjs:414-421`).
    pub fn delete_job(&self, id: &str) -> Result<(), BackgroundError> {
        let mut inner = self.lock();
        let mut next = inner.config.clone();
        let Some(jobs) = next.get_mut("jobs").and_then(Value::as_array_mut) else {
            return Err(BackgroundError::Validation("no such job".to_owned()));
        };
        if !jobs
            .iter()
            .any(|job| job.get("id").and_then(Value::as_str) == Some(id))
        {
            return Err(BackgroundError::Validation("no such job".to_owned()));
        }
        jobs.retain(|job| job.get("id").and_then(Value::as_str) != Some(id));
        self.commit(&mut inner, next)?;
        drop(inner);
        self.emit();
        Ok(())
    }

    // VERIFY: background-reorder
    /// `reorderJobs` (`background.mjs:426-433`): cosmetic row order only.
    pub fn reorder_jobs(&self, ids: &Value) -> Result<(), BackgroundError> {
        let Some(ids) = ids.as_array() else {
            return Err(BackgroundError::Validation("ids array required".to_owned()));
        };
        let mut rank: HashMap<String, i64> = HashMap::new();
        for (index, id) in ids.iter().enumerate() {
            if let Some(id) = id.as_str() {
                rank.insert(id.to_owned(), index as i64);
            }
        }
        let mut inner = self.lock();
        let mut next = inner.config.clone();
        if let Some(jobs) = next.get_mut("jobs").and_then(Value::as_array_mut) {
            jobs.sort_by_key(|job| {
                job.get("id")
                    .and_then(Value::as_str)
                    .and_then(|id| rank.get(id).copied())
                    .unwrap_or(i64::MAX)
            });
        }
        self.commit(&mut inner, next)?;
        drop(inner);
        self.emit();
        Ok(())
    }

    // VERIFY: background-reports
    /// `listReports()` (`background.mjs:470-486`).
    pub fn list_reports(&self) -> Result<Vec<Value>, BackgroundError> {
        let _guard = self.lock_flags();
        self.reports_unlocked()
    }

    fn reports_unlocked(&self) -> Result<Vec<Value>, BackgroundError> {
        let snapshot = self.deps.tasks.snapshot();
        crate::background_reports::list_reports(&snapshot, &self.flags.load())
    }

    /// `getReport(taskId)` (`background.mjs:491-498`).
    pub fn get_report(&self, task_id: &str) -> Result<Option<Value>, BackgroundError> {
        let snapshot = self.deps.tasks.snapshot();
        crate::background_reports::get_report(&snapshot, task_id)
    }

    /// `setReportFlag(taskId, flagged)` (`background.mjs:456-465`).
    pub fn set_report_flag(&self, task_id: &str, flagged: bool) -> Result<Value, BackgroundError> {
        let _guard = self.lock_flags();
        let snapshot = self.deps.tasks.snapshot();
        let result =
            crate::background_reports::set_report_flag(&snapshot, &self.flags, task_id, flagged)?;
        self.emit();
        Ok(result)
    }

    fn lock_flags(&self) -> std::sync::MutexGuard<'_, ()> {
        self.flag_lock
            .lock()
            .unwrap_or_else(|error| error.into_inner())
    }

    /// `runBackgroundNow` (`background.mjs:502-505`).
    pub async fn run_now(&self, force: bool) -> Result<Value, BackgroundError> {
        let task = self
            .attempt_run(Attempt {
                bypass_window: true,
                bypass_gate: force,
                manual: true,
            })
            .await?
            .ok_or_else(|| {
                BackgroundError::Validation("did not find eligible task to run".to_owned())
            })?;
        Ok(task.get("id").cloned().unwrap_or(Value::Null))
    }
}

/// Releases the single-flight reservation on every exit path (`finally`).
struct AttemptGuard<'a>(&'a AtomicBool);

impl Drop for AttemptGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

fn is_live_card(task: &Value) -> bool {
    let tagged = task
        .get("tags")
        .and_then(Value::as_array)
        .is_some_and(|tags| tags.iter().any(|tag| tag.as_str() == Some("background")));
    let column = task.get("column").and_then(Value::as_str);
    tagged && matches!(column, Some("todo") | Some("inprogress"))
}

fn backend_for(route: &ModelRoute, task: &Value) -> &'static str {
    let model = task.get("model").cloned().unwrap_or(Value::Null);
    let tool = task.get("tool").cloned().unwrap_or(Value::Null);
    let routed = route(&model, &tool);
    if js_truthy(routed.get("isClaudeModel").unwrap_or(&Value::Null)) {
        "claude"
    } else if js_truthy(routed.get("isCodexModel").unwrap_or(&Value::Null)) {
        "codex"
    } else {
        "ollama"
    }
}

fn validate_conclude(body: &Value) -> Result<(), BackgroundError> {
    if let Some(conclude) = body.get("conclude") {
        if !conclude
            .as_str()
            .is_some_and(|value| CONCLUDE_VALUES.contains(&value))
        {
            return Err(BackgroundError::Validation(
                "conclude must be one of inreview|done".to_owned(),
            ));
        }
    }
    Ok(())
}

/// `{...base, ...patch}` for JSON objects; non-objects contribute nothing.
fn merge_object(base: &Value, patch: Option<&Value>) -> Value {
    let mut merged = base.as_object().cloned().unwrap_or_default();
    if let Some(Value::Object(fields)) = patch {
        for (key, value) in fields {
            merged.insert(key.clone(), value.clone());
        }
    }
    Value::Object(merged)
}

/// The stored-job view the idempotency fingerprint hashes (`background.mjs:370`).
fn fingerprint(job: &Value) -> Value {
    let mut output = Map::new();
    for key in [
        "title",
        "description",
        "cwd",
        "cooldownHours",
        "enabled",
        "window",
        "thresholds",
        "models",
        "tokenCaps",
        "scopes",
        "conclude",
    ] {
        if let Some(value) = job.get(key) {
            output.insert(key.to_owned(), value.clone());
        }
    }
    Value::Object(output)
}

/// Compare the stored fingerprint with a fresh payload. Parsed values compare
/// order-insensitively, so a Node-written `idempotencyPayload` cannot false-409.
fn fingerprint_matches(stored: &str, payload: &Value) -> bool {
    match serde_json::from_str::<Value>(stored) {
        Ok(stored) => stored == *payload,
        Err(_) => stored == serde_json::to_string(payload).unwrap_or_default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;
    use std::path::Path;
    use std::sync::atomic::AtomicUsize;

    // ---- Fixtures (no process, no network, no live user data) -----------------

    struct Fixture(PathBuf);

    impl Fixture {
        fn new(name: &str) -> Self {
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let dir = std::env::temp_dir().join(format!(
                "singularity-background-{name}-{}-{nanos}",
                std::process::id()
            ));
            fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }

        fn state_dir(&self) -> PathBuf {
            self.0.join("state")
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[derive(Default)]
    struct FakeTasks {
        tasks: Mutex<Vec<Value>>,
        fail_create: AtomicBool,
        updates: Mutex<Vec<(String, Value)>>,
        /// Lets a test hold `create` open so a concurrent edit can land between
        /// the attempt's pending and completion writes.
        entered: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
        release: Mutex<Option<tokio::sync::oneshot::Receiver<()>>>,
    }

    impl FakeTasks {
        fn new() -> Arc<Self> {
            Arc::new(Self::default())
        }

        fn push(&self, task: Value) {
            self.tasks.lock().unwrap().push(task);
        }

        fn snapshot_value(&self) -> Value {
            json!({ "tasks": self.tasks.lock().unwrap().clone(), "history": [] })
        }
    }

    impl BackgroundTasks for FakeTasks {
        fn snapshot(&self) -> Value {
            self.snapshot_value()
        }

        fn create<'a>(&'a self, spec: NewBackgroundTask) -> BoxFuture<'a, Result<Value, String>> {
            Box::pin(async move {
                if self.fail_create.load(Ordering::SeqCst) {
                    return Err("unknown create outcome".to_owned());
                }
                let entered = self.entered.lock().unwrap().take();
                let release = self.release.lock().unwrap().take();
                if let Some(entered) = entered {
                    let _ = entered.send(());
                }
                if let Some(release) = release {
                    let _ = release.await;
                }
                let id = format!("task-{}", self.tasks.lock().unwrap().len());
                let task = json!({
                    "id": id,
                    "title": spec.title,
                    "tags": spec.tags,
                    "column": "todo",
                    "repo": spec.repo,
                    "model": spec.model,
                    "backgroundJobId": spec.background_job_id,
                    "backgroundRunId": spec.background_run_id,
                });
                self.tasks.lock().unwrap().push(task.clone());
                Ok(task)
            })
        }

        fn update<'a>(&'a self, id: &'a str, patch: Value) -> BoxFuture<'a, Result<Value, String>> {
            Box::pin(async move {
                self.updates
                    .lock()
                    .unwrap()
                    .push((id.to_owned(), patch.clone()));
                let mut tasks = self.tasks.lock().unwrap();
                let task = tasks
                    .iter_mut()
                    .find(|task| task.get("id").and_then(Value::as_str) == Some(id))
                    .ok_or_else(|| "no such task".to_owned())?;
                if let (Value::Object(fields), Value::Object(patch)) = (task, patch) {
                    for (key, value) in patch {
                        fields.insert(key, value);
                    }
                }
                Ok(tasks
                    .iter()
                    .find(|task| task.get("id").and_then(Value::as_str) == Some(id))
                    .cloned()
                    .unwrap())
            })
        }
    }

    struct FakeUsage {
        reply: Mutex<Result<Value, String>>,
    }

    impl FakeUsage {
        fn ready(usage: Value) -> Arc<Self> {
            Arc::new(Self {
                reply: Mutex::new(Ok(usage)),
            })
        }

        fn set(&self, reply: Result<Value, String>) {
            *self.reply.lock().unwrap() = reply;
        }
    }

    impl BackgroundUsage for FakeUsage {
        fn usage<'a>(&'a self) -> BoxFuture<'a, Result<Value, String>> {
            let reply = self.reply.lock().unwrap().clone();
            Box::pin(async move { reply })
        }
    }

    /// Usage that signals entry then waits for release — proves the reservation
    /// is held across the await (`background.test.mjs:104-124`).
    #[derive(Default)]
    struct GateUsage {
        entered: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
        release: Mutex<Option<tokio::sync::oneshot::Receiver<()>>>,
    }

    impl BackgroundUsage for GateUsage {
        fn usage<'a>(&'a self) -> BoxFuture<'a, Result<Value, String>> {
            let entered = self.entered.lock().unwrap().take();
            let release = self.release.lock().unwrap().take();
            Box::pin(async move {
                if let Some(entered) = entered {
                    let _ = entered.send(());
                }
                if let Some(release) = release {
                    let _ = release.await;
                }
                Ok(json!({ "claude": source(None) }))
            })
        }
    }

    #[derive(Default)]
    struct FakeTokens {
        tokens: Mutex<i64>,
        calls: AtomicUsize,
    }

    impl SessionTokens for FakeTokens {
        fn tokens<'a>(
            &'a self,
            _cwd: String,
            _session_id: String,
            _tool: String,
        ) -> BoxFuture<'a, Result<i64, String>> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            let tokens = *self.tokens.lock().unwrap();
            Box::pin(async move { Ok(tokens) })
        }
    }

    #[derive(Default)]
    struct FakeRegistry {
        live: Mutex<Vec<String>>,
        inputs: Mutex<Vec<(String, String)>>,
        kills: Mutex<Vec<String>>,
    }

    impl BackgroundRegistry for FakeRegistry {
        fn is_live(&self, id: &str) -> bool {
            self.live.lock().unwrap().iter().any(|live| live == id)
        }

        fn input(&self, id: &str, data: &str) {
            self.inputs
                .lock()
                .unwrap()
                .push((id.to_owned(), data.to_owned()));
        }

        fn kill(&self, id: &str) -> Result<(), String> {
            self.kills.lock().unwrap().push(id.to_owned());
            Ok(())
        }
    }

    fn source(overrides: Option<Value>) -> Value {
        let mut base =
            json!({ "ok": true, "session": { "pctUsed": 10 }, "weekly": { "pctUsed": 10 } });
        if let Some(Value::Object(fields)) = overrides {
            for (key, value) in fields {
                base[key] = value;
            }
        }
        base
    }

    fn job(overrides: Value) -> Value {
        let mut base = json!({
            "id": "a", "title": "a", "enabled": true, "cooldownHours": 24,
            "lastRunAt": Value::Null,
            "window": { "startHour": 9, "endHour": 18, "days": [1, 2, 3, 4, 5] },
            "thresholds": {
                "claude": { "start": 50, "stop": 75, "weeklyMax": 75 },
                "codex": { "start": 50, "stop": 75, "weeklyMax": 75 },
                "ollama": { "start": 50, "stop": 75, "weeklyMax": 75 },
            },
            "models": { "claude": "opus", "codex": "gpt-6-luna", "ollama": "glm-5.3:cloud" },
            "tokenCaps": { "claude": 15_000_000, "codex": 2_000_000, "ollama": 2_000_000 },
            "conclude": "inreview",
        });
        if let Value::Object(fields) = overrides {
            for (key, value) in fields {
                base[key] = value;
            }
        }
        base
    }

    struct Harness {
        fixture: Fixture,
        tasks: Arc<FakeTasks>,
        usage: Arc<FakeUsage>,
        registry: Arc<FakeRegistry>,
        tokens: Arc<FakeTokens>,
        bus: Bus,
        events: Arc<AtomicUsize>,
        clock: Arc<Mutex<i64>>,
        fail_write: Arc<AtomicBool>,
    }

    impl Harness {
        fn new(name: &str) -> Self {
            let fixture = Fixture::new(name);
            fs::create_dir_all(fixture.state_dir()).unwrap();
            let bus = Bus::new();
            let events = Arc::new(AtomicUsize::new(0));
            let counter = events.clone();
            bus.subscribe(Arc::new(move |event| {
                if matches!(event, BusEvent::Background(_)) {
                    counter.fetch_add(1, Ordering::SeqCst);
                }
            }));
            let harness = Self {
                fixture,
                tasks: FakeTasks::new(),
                usage: FakeUsage::ready(json!({ "claude": source(None), "ollama": source(None) })),
                registry: Arc::new(FakeRegistry::default()),
                tokens: Arc::new(FakeTokens::default()),
                bus,
                events,
                clock: Arc::new(Mutex::new(1_000_000_000_000)),
                fail_write: Arc::new(AtomicBool::new(false)),
            };
            harness.write_state(&json!({ "jobs": [] }));
            harness
        }

        fn write_state(&self, config: &Value) {
            fs::write(
                self.fixture.state_dir().join(BACKGROUND_FILE),
                serde_json::to_string_pretty(config).unwrap(),
            )
            .unwrap();
        }

        fn events(&self) -> usize {
            self.events.load(Ordering::SeqCst)
        }

        fn service(&self) -> Arc<Service> {
            self.service_with_usage(self.usage.clone())
        }

        fn service_with_usage(&self, usage: Arc<dyn BackgroundUsage>) -> Arc<Service> {
            let clock = self.clock.clone();
            let fail = self.fail_write.clone();
            Service::new(BackgroundDeps {
                state_dir: self.fixture.state_dir(),
                reports_dir: self.fixture.0.join(".reports"),
                bus: self.bus.clone(),
                registry: self.registry.clone(),
                tasks: self.tasks.clone(),
                usage,
                route: Arc::new(|_, _| json!({ "isClaudeModel": true, "isCodexModel": false })),
                tokens: self.tokens.clone(),
                clock: Arc::new(move || *clock.lock().unwrap()),
                write_atomic: Arc::new(move |path: &Path, bytes: &[u8]| {
                    if fail.load(Ordering::SeqCst) {
                        return Err(std::io::Error::from(std::io::ErrorKind::Other));
                    }
                    fs::write(path, bytes)
                }),
            })
        }
    }

    fn run<F: Future>(future: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(future)
    }

    const NOW: i64 = 1_000_000_000_000;
    const HR: i64 = 3_600_000;

    // 2026-07-15 = Wednesday (getDay 3), 2026-07-18 = Saturday (getDay 6).
    fn at(year: i32, month: u32, day: u32, hour: u32) -> i64 {
        let date = time::Date::from_calendar_date(
            year,
            time::Month::try_from(month as u8).unwrap(),
            day as u8,
        )
        .unwrap();
        let clock = time::Time::from_hms(hour as u8, 0, 0).unwrap();
        // Interpret as local wall clock, then convert back to an epoch instant.
        let civil = date.with_time(clock).assume_utc().unix_timestamp();
        let offset = i64::from(local_offset_secs_at(civil));
        (civil - offset) * 1000
    }

    // ---- inWindow -------------------------------------------------------------

    #[test]
    fn in_window_is_weekday_start_inclusive_and_end_exclusive() {
        let job = job(json!({}));
        assert!(in_window(&job, at(2026, 7, 15, 10)), "Wednesday 10:00");
        assert!(!in_window(&job, at(2026, 7, 18, 10)), "Saturday");
        assert!(in_window(&job, at(2026, 7, 15, 9)), "startHour inclusive");
        assert!(!in_window(&job, at(2026, 7, 15, 18)), "endHour exclusive");
        assert!(!in_window(&job, at(2026, 7, 15, 8)));
    }

    // ---- evalGate -------------------------------------------------------------

    #[test]
    fn eval_gate_prefers_claude_then_falls_through_each_backend() {
        let job = job(json!({}));
        let (backend, reason) = eval_gate(
            &json!({ "claude": source(None), "ollama": source(None) }),
            &job,
        )
        .unwrap();
        assert_eq!(backend, Some("claude"));
        assert_eq!(reason, "claude within budget");

        let (backend, _) = eval_gate(
            &json!({ "claude": source(Some(json!({ "session": { "pctUsed": 60 } }))), "ollama": source(None) }),
            &job,
        )
        .unwrap();
        assert_eq!(backend, Some("ollama"));

        let (backend, reason) = eval_gate(
            &json!({ "claude": json!({ "ok": false, "error": "auth" }), "ollama": source(None) }),
            &job,
        )
        .unwrap();
        assert_eq!(backend, Some("ollama"), "ok:false fails closed");
        assert_eq!(reason, "ollama within budget");

        let (backend, _) = eval_gate(
            &json!({
                "claude": source(Some(json!({ "session": { "pctUsed": 60 } }))),
                "codex": json!({ "ok": true, "session": null, "weekly": { "pctUsed": 10 } }),
                "ollama": source(None),
            }),
            &job,
        )
        .unwrap();
        assert_eq!(
            backend,
            Some("codex"),
            "codex session:null with weekly under max passes"
        );

        let (backend, _) = eval_gate(
            &json!({
                "claude": source(Some(json!({ "session": { "pctUsed": 60 } }))),
                "codex": json!({ "ok": true, "session": null, "weekly": { "pctUsed": 90 } }),
                "ollama": source(None),
            }),
            &job,
        )
        .unwrap();
        assert_eq!(backend, Some("ollama"));

        let (backend, reason) = eval_gate(
            &json!({
                "claude": json!({ "ok": true, "session": null, "weekly": null }),
                "codex": json!({ "ok": false, "error": "no Codex sessions found" }),
                "ollama": source(Some(json!({ "session": { "pctUsed": 90 } }))),
            }),
            &job,
        )
        .unwrap();
        assert_eq!(backend, None);
        assert!(reason.contains("claude usage incomplete"), "{reason}");
        assert!(reason.contains("ollama 5h 90% >= 50%"), "{reason}");
    }

    // ---- pickJob --------------------------------------------------------------

    #[test]
    fn pick_job_honours_cooldown_oldest_null_disabled_and_pending() {
        assert_eq!(
            pick_job(&[job(json!({ "lastRunAt": NOW - HR }))], NOW),
            None
        );
        let jobs = [
            job(json!({ "id": "new", "cooldownHours": 1, "lastRunAt": NOW - 2 * HR })),
            job(json!({ "id": "old", "cooldownHours": 1, "lastRunAt": NOW - 10 * HR })),
        ];
        assert_eq!(pick_job(&jobs, NOW).unwrap()["id"], json!("old"));
        let jobs = [
            job(json!({ "id": "ran", "cooldownHours": 1, "lastRunAt": NOW - 10 * HR })),
            job(json!({ "id": "fresh", "cooldownHours": 1, "lastRunAt": Value::Null })),
        ];
        assert_eq!(pick_job(&jobs, NOW).unwrap()["id"], json!("fresh"));
        assert_eq!(
            pick_job(&[job(json!({ "enabled": false, "cooldownHours": 1 }))], NOW),
            None
        );
        assert_eq!(
            pick_job(&[job(json!({ "pendingRunId": "unknown" }))], NOW),
            None
        );
    }

    // F7: `a.lastRunAt ?? -Infinity` — a null timestamp is the oldest job, not
    // an epoch-0 tie with a real `lastRunAt: 0` (`background.mjs:101`, `:116`).
    #[test]
    fn pick_job_treats_a_null_last_run_at_as_oldest() {
        let jobs = [
            job(json!({ "id": "epoch", "cooldownHours": 1, "lastRunAt": 0 })),
            job(json!({ "id": "never", "cooldownHours": 1, "lastRunAt": Value::Null })),
        ];
        assert_eq!(pick_job(&jobs, NOW).unwrap()["id"], json!("never"));
    }

    // F6: `days.includes(date.getDay())` is strict (`background.mjs:69`), so a
    // string day entry never matches and the job never runs.
    #[test]
    fn in_window_ignores_non_numeric_day_entries() {
        let job = job(json!({ "window": { "startHour": 9, "endHour": 18, "days": ["3"] } }));
        assert!(
            !in_window(&job, at(2026, 7, 15, 10)),
            "Wednesday 10:00 as \"3\""
        );
    }

    // ---- pickRunnableJob ------------------------------------------------------

    #[test]
    fn pick_runnable_job_folds_window_gate_and_oldest_first() {
        let in_window = at(2026, 7, 15, 10);
        let out_window = at(2026, 7, 18, 10);
        let jobs = [job(json!({ "lastRunAt": Value::Null }))];
        let usage = json!({ "claude": source(None), "ollama": source(None) });

        let picked = pick_runnable_job(&jobs, &usage, out_window, false).unwrap();
        assert_eq!(picked.job, None);
        assert_eq!(picked.reason, "did not find eligible task to run");

        let picked = pick_runnable_job(&jobs, &usage, out_window, true).unwrap();
        assert_eq!(picked.job.unwrap()["id"], json!("a"));
        assert_eq!(picked.backend, Some("claude"));

        let pending = [job(json!({ "pendingRunId": "unknown" }))];
        assert_eq!(
            pick_runnable_job(&pending, &usage, in_window, false)
                .unwrap()
                .job,
            None
        );

        let over = [job(json!({ "id": "x", "title": "x" }))];
        let usage = json!({
            "claude": source(Some(json!({ "session": { "pctUsed": 90 } }))),
            "ollama": source(Some(json!({ "session": { "pctUsed": 90 } }))),
        });
        let picked = pick_runnable_job(&over, &usage, in_window, false).unwrap();
        assert_eq!(picked.job, None);
        assert!(picked.reason.contains("x:"), "{}", picked.reason);

        let jobs = [
            job(json!({ "id": "new", "cooldownHours": 1, "lastRunAt": in_window - 2 * HR })),
            job(json!({ "id": "old", "cooldownHours": 1, "lastRunAt": in_window - 10 * HR })),
        ];
        let picked = pick_runnable_job(&jobs, &usage_source(), in_window, false).unwrap();
        assert_eq!(picked.job.unwrap()["id"], json!("old"));
        assert_eq!(picked.backend, Some("claude"));
    }

    fn usage_source() -> Value {
        json!({ "claude": source(None), "ollama": source(None) })
    }

    // ---- watchdogDecision -----------------------------------------------------

    #[test]
    fn watchdog_decision_stops_on_every_budget_and_fails_closed() {
        let job = job(json!({}));
        assert_eq!(
            watchdog_decision(
                &json!({ "claude": source(Some(json!({ "session": { "pctUsed": 75 } }))) }),
                "claude",
                &job,
                0
            ),
            Decision::Stop
        );
        assert_eq!(
            watchdog_decision(
                &json!({ "claude": source(Some(json!({ "weekly": { "pctUsed": 90 } }))) }),
                "claude",
                &job,
                0
            ),
            Decision::Stop
        );
        assert_eq!(
            watchdog_decision(
                &json!({ "claude": source(None) }),
                "claude",
                &job,
                15_000_000
            ),
            Decision::Stop
        );
        assert_eq!(
            watchdog_decision(
                &json!({ "claude": json!({ "ok": false }) }),
                "claude",
                &job,
                0
            ),
            Decision::Stop
        );
        assert_eq!(
            watchdog_decision(&json!({ "claude": source(None) }), "claude", &job, 100),
            Decision::Continue
        );
    }

    // F2: `th.start`/`th.weeklyMax` on an absent or null thresholds entry throw
    // inside Node's `gateReason` (`background.mjs:78-79`), so the run never
    // starts; the watchdog's catch keeps its fail-closed `stop`
    // (`background.mjs:130`, `:263-269`). A job with no tokenCaps throws on the
    // same line of `watchdogDecision` (`:134`).
    #[test]
    fn a_job_without_thresholds_or_token_caps_fails_closed() {
        let bare = job(json!({ "thresholds": Value::Null }));
        assert_eq!(
            eval_gate(&usage_source(), &bare).unwrap_err(),
            "Cannot read properties of null (reading 'claude')"
        );
        assert_eq!(
            pick_runnable_job(&[bare.clone()], &usage_source(), at(2026, 7, 15, 10), true)
                .unwrap_err(),
            "Cannot read properties of null (reading 'claude')"
        );

        // VERIFY: wave5-fix-cron-bg-17
        // An absent container throws for the first backend, and an empty or
        // partially populated one throws per backend once its usage gate is
        // reached — the run aborts instead of falling through to a backend that
        // happens to have an entry.
        let mut absent = job(json!({}));
        absent.as_object_mut().unwrap().shift_remove("thresholds");
        assert_eq!(
            eval_gate(&usage_source(), &absent).unwrap_err(),
            "Cannot read properties of undefined (reading 'claude')"
        );
        let empty = job(json!({ "thresholds": {} }));
        assert_eq!(
            eval_gate(&usage_source(), &empty).unwrap_err(),
            "Cannot read properties of undefined (reading 'start')"
        );
        let partial = job(json!({ "thresholds": {
            "ollama": { "start": 50, "stop": 75, "weeklyMax": 75 }
        } }));
        assert_eq!(
            eval_gate(&usage_source(), &partial).unwrap_err(),
            "Cannot read properties of undefined (reading 'start')",
            "healthy claude usage reaches th.start with no claude entry"
        );
        // The same job runs on ollama when claude and codex read as unavailable:
        // Node returns before it ever touches their `th`.
        let unavailable = json!({
            "claude": json!({ "ok": false, "error": "auth" }),
            "ollama": source(None),
        });
        assert_eq!(
            eval_gate(&unavailable, &partial).unwrap().0,
            Some("ollama"),
            "an unavailable backend never reads its missing thresholds entry"
        );

        let usage = json!({ "claude": source(None) });
        assert_eq!(
            watchdog_decision(&usage, "claude", &bare, 0),
            Decision::Stop
        );
        assert_eq!(
            watchdog_decision(&usage, "claude", &empty, 0),
            Decision::Stop,
            "a missing per-backend entry throws at th.stop and stops"
        );

        let mut caps_less = job(json!({}));
        caps_less.as_object_mut().unwrap().shift_remove("tokenCaps");
        assert_eq!(
            watchdog_decision(&usage, "claude", &caps_less, 0),
            Decision::Stop
        );
        let caps_empty = job(json!({ "tokenCaps": {} }));
        assert_eq!(
            watchdog_decision(&usage, "claude", &caps_empty, 9_999_999),
            Decision::Continue,
            "tokens >= undefined is false, so a missing cap stays permissive"
        );

        // A per-backend entry that is present but primitive is not a throw in
        // Node (`({}).start` is undefined, and `5 >= undefined` is false).
        let primitive = job(json!({ "thresholds": { "claude": 5 } }));
        assert_eq!(
            eval_gate(&usage_source(), &primitive).unwrap().0,
            Some("claude"),
            "Node's undefined comparison passes this gate"
        );
        assert_eq!(
            watchdog_decision(&usage, "claude", &primitive, 0),
            Decision::Continue
        );
    }

    // ---- migrateLegacyConfig --------------------------------------------------

    #[test]
    fn migrate_legacy_config_seeds_only_jobs_missing_their_own_copy() {
        let legacy_window = json!({ "startHour": 8, "endHour": 17, "days": [1, 2, 3, 4, 5] });
        let legacy_thresholds = json!({ "claude": { "start": 40, "stop": 70, "weeklyMax": 70 } });
        let loaded = json!({
            "enabled": true, "tickMinutes": 60,
            "window": legacy_window,
            "thresholds": legacy_thresholds,
            "models": { "claude": "opus" },
            "tokenCaps": { "claude": 10_000_000 },
            "jobs": [{ "id": "a", "title": "A", "enabled": true, "cooldownHours": 24, "lastRunAt": Value::Null }],
        });
        let (config, migrated) = migrate_legacy_config(&loaded);
        assert!(migrated);
        assert_eq!(config["jobs"][0]["window"], legacy_window);
        assert_eq!(config["jobs"][0]["thresholds"], legacy_thresholds);

        let own_window = json!({ "startHour": 7, "endHour": 12, "days": [6, 0] });
        let loaded = json!({
            "window": { "startHour": 8, "endHour": 17, "days": [1] },
            "jobs": [{ "id": "a", "window": own_window }],
        });
        let (config, migrated) = migrate_legacy_config(&loaded);
        assert!(migrated);
        assert_eq!(config["jobs"][0]["window"], own_window);

        let loaded = json!({ "jobs": [{ "id": "a", "window": { "startHour": 9 } }] });
        let (config, migrated) = migrate_legacy_config(&loaded);
        assert!(!migrated);
        assert_eq!(config["jobs"], loaded["jobs"]);
    }

    // ---- createJob / updateJob / reorder --------------------------------------

    #[test]
    fn create_job_defaults_and_rejects_bad_conclude() {
        let harness = Harness::new("create-defaults");
        let service = harness.service();
        let created = service
            .create_job(
                &json!({ "title": " t ", "description": " d ", "cwd": " C:\\x " }),
                None,
            )
            .unwrap();
        assert_eq!(created["title"], json!("t"));
        assert_eq!(created["cooldownHours"], json!(24));
        assert_eq!(
            created["thresholds"]["codex"],
            json!({ "start": 50, "stop": 75, "weeklyMax": 50 })
        );
        assert_eq!(created["models"]["codex"], json!("gpt-6-luna"));
        assert_eq!(created["tokenCaps"]["codex"], json!(15_000_000));
        assert_eq!(created["conclude"], json!("inreview"));
        assert_eq!(created["lastRunAt"], Value::Null);
        assert!(created["id"].as_str().unwrap().contains('-'));
        assert!(matches!(
            service.create_job(&json!({ "title": "x", "description": "d", "cwd": "c", "conclude": "garbage" }), None),
            Err(BackgroundError::Validation(message)) if message == "conclude must be one of inreview|done"
        ));
        assert!(matches!(
            service.create_job(&json!({ "title": " ", "description": "d", "cwd": "c" }), None),
            Err(BackgroundError::Validation(message)) if message == "title, description, cwd required"
        ));
    }

    #[test]
    fn create_job_idempotency_returns_the_original_and_conflicts_on_change() {
        let harness = Harness::new("create-idempotent");
        let service = harness.service();
        let body = json!({ "title": "idempotent background", "description": "d", "cwd": "C:\\x" });
        let first = service
            .create_job(&body, Some("background-lost-response"))
            .unwrap();
        let retry = service
            .create_job(&body, Some("background-lost-response"))
            .unwrap();
        assert_eq!(retry["id"], first["id"]);
        assert_eq!(service.jobs().len(), 1);

        // The fingerprint is the original payload, even after an update.
        service
            .update_job(first["id"].as_str().unwrap(), &json!({ "title": "edited" }))
            .unwrap();
        assert_eq!(
            service
                .create_job(&body, Some("background-lost-response"))
                .unwrap()["id"],
            first["id"]
        );
        assert!(matches!(
            service.create_job(&json!({ "title": "edited", "description": "d", "cwd": "C:\\x" }), Some("background-lost-response")),
            Err(BackgroundError::Conflict(message)) if message == "Idempotency-Key was already used with a different payload"
        ));
    }

    #[test]
    fn update_job_merges_siblings_and_reorders_omit_to_the_tail() {
        let harness = Harness::new("update");
        let service = harness.service();
        let first = service
            .create_job(
                &json!({ "title": "a", "description": "d", "cwd": "x" }),
                None,
            )
            .unwrap();
        let second = service
            .create_job(
                &json!({ "title": "b", "description": "d", "cwd": "x" }),
                None,
            )
            .unwrap();
        let updated = service
            .update_job(
                first["id"].as_str().unwrap(),
                &json!({ "title": "changed", "thresholds": { "claude": { "start": 1 } }, "window": { "startHour": 0 } }),
            )
            .unwrap();
        assert_eq!(updated["thresholds"]["claude"]["start"], json!(1));
        assert_eq!(
            updated["thresholds"]["claude"]["stop"],
            json!(75),
            "sibling preserved"
        );
        assert_eq!(
            updated["thresholds"]["claude"]["weeklyMax"],
            json!(50),
            "default sibling preserved"
        );
        assert_eq!(updated["window"]["startHour"], json!(0));
        assert_eq!(
            updated["window"]["endHour"],
            json!(18),
            "window sibling preserved"
        );
        assert!(matches!(
            service.update_job("nope", &json!({})),
            Err(BackgroundError::Validation(message)) if message == "no such job"
        ));

        service
            .reorder_jobs(&json!([second["id"], first["id"]]))
            .unwrap();
        assert_eq!(service.jobs()[0]["id"], second["id"]);
        service.reorder_jobs(&json!([first["id"]])).unwrap();
        let jobs = service.jobs();
        let ids: Vec<&str> = jobs.iter().filter_map(|job| job["id"].as_str()).collect();
        assert_eq!(
            ids,
            [
                first["id"].as_str().unwrap(),
                second["id"].as_str().unwrap()
            ]
        );
        assert!(matches!(
            service.reorder_jobs(&json!("nope")),
            Err(BackgroundError::Validation(message)) if message == "ids array required"
        ));
    }

    // background.test.mjs:64-83 — failed persist leaves snapshots and events
    // unchanged for create/update/delete/reorder.
    #[test]
    fn failed_persist_leaves_snapshot_config_and_events_unchanged() {
        let harness = Harness::new("persist-failure");
        let service = harness.service();
        let first = service
            .create_job(
                &json!({ "title": "a", "description": "d", "cwd": "x" }),
                None,
            )
            .unwrap();
        let second = service
            .create_job(
                &json!({ "title": "b", "description": "d", "cwd": "x" }),
                None,
            )
            .unwrap();
        let before = service.snapshot();
        harness.events.store(0, Ordering::SeqCst);
        harness.fail_write.store(true, Ordering::SeqCst);

        let mutations: [Result<Value, BackgroundError>; 4] = [
            service.create_job(
                &json!({ "title": "c", "description": "d", "cwd": "x" }),
                None,
            ),
            service.update_job(
                first["id"].as_str().unwrap(),
                &json!({ "title": "changed" }),
            ),
            service
                .delete_job(first["id"].as_str().unwrap())
                .map(|()| json!(null)),
            service
                .reorder_jobs(&json!([second["id"], first["id"]]))
                .map(|()| json!(null)),
        ];
        for mutation in mutations {
            assert!(matches!(mutation, Err(BackgroundError::Persist(_))));
            assert_eq!(service.snapshot(), before);
            assert_eq!(harness.events(), 0);
        }
    }

    // ---- attempts -------------------------------------------------------------

    #[test]
    fn attempt_reservation_is_held_across_the_usage_await_and_released() {
        let harness = Harness::new("reservation");
        let gate = Arc::new(GateUsage::default());
        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        *gate.entered.lock().unwrap() = Some(entered_tx);
        *gate.release.lock().unwrap() = Some(release_rx);

        let clock = harness.clock.clone();
        let fail = harness.fail_write.clone();
        let service = Arc::new(Service::new(BackgroundDeps {
            state_dir: harness.fixture.state_dir(),
            reports_dir: harness.fixture.0.join(".reports"),
            bus: harness.bus.clone(),
            registry: harness.registry.clone(),
            tasks: harness.tasks.clone(),
            usage: gate,
            route: Arc::new(|_, _| json!({ "isClaudeModel": true, "isCodexModel": false })),
            tokens: harness.tokens.clone(),
            clock: Arc::new(move || *clock.lock().unwrap()),
            write_atomic: Arc::new(move |path: &Path, bytes: &[u8]| {
                if fail.load(Ordering::SeqCst) {
                    return Err(std::io::Error::other("disk full"));
                }
                fs::write(path, bytes)
            }),
        }));
        service
            .create_job(
                &json!({ "title": "a", "description": "d", "cwd": "x" }),
                None,
            )
            .unwrap();

        run(async {
            let first = tokio::spawn({
                let service = service.clone();
                async move { service.run_now(false).await }
            });
            tokio::time::timeout(Duration::from_secs(2), entered_rx)
                .await
                .expect("usage poll did not start")
                .unwrap();
            assert!(matches!(
                service.run_now(true).await,
                Err(BackgroundError::Validation(message)) if message == "a background run is already live"
            ));
            release_tx.send(()).unwrap();
            assert!(first.await.unwrap().unwrap().is_string());
        });
        assert_eq!(harness.tasks.tasks.lock().unwrap().len(), 1);
    }

    #[test]
    fn a_failed_usage_poll_releases_the_reservation_for_the_next_attempt() {
        let harness = Harness::new("reservation-release");
        harness.usage.set(Err("usage failed".to_owned()));
        let service = harness.service();
        service
            .create_job(
                &json!({ "title": "a", "description": "d", "cwd": "x" }),
                None,
            )
            .unwrap();
        assert!(matches!(
            run(service.run_now(false)),
            Err(BackgroundError::Validation(message)) if message == "usage failed"
        ));
        run(service.run_now(true)).unwrap();
        assert_eq!(harness.tasks.tasks.lock().unwrap().len(), 1);
    }

    // background.test.mjs:126-138 — an unknown create outcome retains the intent
    // and blocks every later job.
    #[test]
    fn unknown_create_outcome_retains_the_intent_and_blocks_every_job() {
        let harness = Harness::new("pending");
        let service = harness.service();
        let first = service
            .create_job(
                &json!({ "title": "a", "description": "d", "cwd": "x" }),
                None,
            )
            .unwrap();
        service
            .create_job(
                &json!({ "title": "b", "description": "d", "cwd": "x" }),
                None,
            )
            .unwrap();
        harness.tasks.fail_create.store(true, Ordering::SeqCst);
        assert!(matches!(
            run(service.run_now(true)),
            Err(BackgroundError::Validation(message)) if message == "unknown create outcome"
        ));
        let pending = service.jobs()[0]["pendingRunId"]
            .as_str()
            .unwrap()
            .to_owned();
        for forced in [true, false] {
            assert!(matches!(
                run(service.run_now(forced)),
                Err(BackgroundError::Validation(message)) if message.contains("unresolved pending intent")
            ));
        }
        assert_eq!(service.jobs()[0]["pendingRunId"], json!(pending));
        assert_eq!(
            harness.tasks.tasks.lock().unwrap().len(),
            0,
            "no other job may bypass the intent"
        );
        assert_eq!(first["id"], service.jobs()[0]["id"]);
    }

    // F1: every mutation is a read-modify-persist-commit under the config
    // mutex, so concurrent creates cannot drop each other from memory or disk
    // (`background.mjs:380-381` is atomic only because Node is single-threaded).
    #[test]
    fn concurrent_job_creates_all_persist() {
        let harness = Harness::new("concurrent-create");
        let service = harness.service();
        let threads: Vec<std::thread::JoinHandle<Value>> = (0..8)
            .map(|index| {
                let service = service.clone();
                std::thread::spawn(move || {
                    service
                        .create_job(
                            &json!({ "title": format!("job-{index}"), "description": "d", "cwd": "x" }),
                            None,
                        )
                        .unwrap()
                })
            })
            .collect();
        let created: Vec<Value> = threads
            .into_iter()
            .map(|thread| thread.join().unwrap())
            .collect();

        let jobs = service.jobs();
        assert_eq!(jobs.len(), created.len(), "no create is lost in memory");
        let stored: Value = serde_json::from_str(
            &fs::read_to_string(harness.fixture.state_dir().join(BACKGROUND_FILE)).unwrap(),
        )
        .unwrap();
        let stored = stored["jobs"].as_array().unwrap();
        assert_eq!(stored.len(), created.len(), "no create is lost on disk");
        for job in &created {
            assert!(jobs.contains(job), "{} is in memory", job["id"]);
            assert!(stored.contains(job), "{} is persisted", job["id"]);
        }
    }

    // F1: Node builds both attempt writes from the snapshot picked before the
    // `getUsage()` await (`background.mjs:221-234`), so a PATCH to that same job
    // landing during the await is reverted by the pending write and again by the
    // completion write. Other jobs in the latest array keep their edits.
    // VERIFY: wave5-fix-cron-bg-18
    #[test]
    fn attempt_writes_replace_the_job_from_the_picked_snapshot_like_node() {
        let harness = Harness::new("attempt-snapshot");
        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        *harness.tasks.entered.lock().unwrap() = Some(entered_tx);
        *harness.tasks.release.lock().unwrap() = Some(release_rx);
        let service = harness.service();
        let job = service
            .create_job(
                &json!({ "title": "a", "description": "d", "cwd": "C:\\x" }),
                None,
            )
            .unwrap();
        let id = job["id"].as_str().unwrap().to_owned();

        run(async {
            let attempt = tokio::spawn({
                let service = service.clone();
                async move { service.run_now(true).await }
            });
            tokio::time::timeout(Duration::from_secs(2), entered_rx)
                .await
                .expect("create did not start")
                .unwrap();
            service
                .update_job(&id, &json!({ "title": "edited" }))
                .unwrap();
            release_tx.send(()).unwrap();
            attempt.await.unwrap().unwrap();
        });

        let stored = service
            .jobs()
            .into_iter()
            .find(|job| job["id"] == json!(id))
            .unwrap();
        assert_eq!(
            stored["title"],
            json!("a"),
            "the completion write restores the pre-pick snapshot, like Node"
        );
        assert!(
            stored["lastTaskId"].is_string(),
            "the completion is recorded"
        );
        assert!(stored.get("pendingRunId").is_none());
    }

    // VERIFY: wave5-fix-cron-bg-22
    // Node evaluates `pickRunnableJob(config.jobs, await getUsage(), …)`
    // (`background.mjs:211`) left to right, so the picked snapshot predates the
    // usage fetch. A PATCH landing during that fetch is in neither attempt
    // write's snapshot and is therefore reverted — in both writes.
    #[test]
    fn a_patch_during_the_usage_fetch_is_reverted_like_node() {
        let harness = Harness::new("usage-snapshot");
        harness.write_state(&json!({ "jobs": [{
            "id": "a", "title": "a", "description": "d", "cwd": "C:\\x", "enabled": true,
            "cooldownHours": 24, "lastRunAt": Value::Null,
            "window": { "startHour": 0, "endHour": 24, "days": [0, 1, 2, 3, 4, 5, 6] },
            "thresholds": { "claude": { "start": 50, "stop": 75, "weeklyMax": 50 } },
            "tokenCaps": { "claude": 15_000_000 },
            "models": { "claude": "opus" },
            "scopes": [], "conclude": "inreview",
        }] }));
        let gate = Arc::new(GateUsage::default());
        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        *gate.entered.lock().unwrap() = Some(entered_tx);
        *gate.release.lock().unwrap() = Some(release_rx);
        let service = harness.service_with_usage(gate);

        run(async {
            let attempt = tokio::spawn({
                let service = service.clone();
                async move { service.run_now(false).await }
            });
            tokio::time::timeout(Duration::from_secs(2), entered_rx)
                .await
                .expect("the usage fetch did not start")
                .unwrap();
            service
                .update_job("a", &json!({ "title": "edited" }))
                .unwrap();
            release_tx.send(()).unwrap();
            attempt.await.unwrap().unwrap();
        });

        let stored = service
            .jobs()
            .into_iter()
            .find(|job| job["id"] == json!("a"))
            .unwrap();
        assert_eq!(
            stored["title"],
            json!("a"),
            "the pre-fetch snapshot is restored, like Node"
        );
        assert!(
            stored["lastTaskId"].is_string(),
            "the completion is recorded"
        );
    }

    // F3: `job.models[backend]` throws in Node when the job carries no `models`
    // object (`background.mjs:215`), so nothing runs and no intent is written.
    // VERIFY: wave5-fix-cron-bg-19
    // The 400 message mirrors the reference's `TypeError` text.
    #[test]
    fn a_job_without_models_refuses_before_writing_the_intent() {
        let harness = Harness::new("no-models");
        harness.write_state(&json!({ "jobs": [{
            "id": "a", "title": "a", "description": "d", "cwd": "C:\\x", "enabled": true,
            "cooldownHours": 24, "lastRunAt": Value::Null,
            "thresholds": { "claude": { "start": 50, "stop": 75, "weeklyMax": 50 } },
            "tokenCaps": { "claude": 15_000_000 },
        }] }));
        let service = harness.service();
        assert!(matches!(
            run(service.run_now(true)),
            Err(BackgroundError::Validation(message))
                if message == "Cannot read properties of undefined (reading 'claude')"
        ));
        assert!(
            service.jobs()[0].get("pendingRunId").is_none(),
            "no intent is written"
        );
        assert!(
            harness.tasks.tasks.lock().unwrap().is_empty(),
            "no card is created"
        );

        // The explicit null container throws with "null" in Node's message.
        let null_harness = Harness::new("null-models");
        null_harness.write_state(&json!({ "jobs": [{
            "id": "a", "title": "a", "description": "d", "cwd": "C:\\x", "enabled": true,
            "cooldownHours": 24, "lastRunAt": Value::Null,
            "thresholds": { "claude": { "start": 50, "stop": 75, "weeklyMax": 50 } },
            "tokenCaps": { "claude": 15_000_000 },
            "models": Value::Null,
        }] }));
        let null_service = null_harness.service();
        assert!(matches!(
            run(null_service.run_now(true)),
            Err(BackgroundError::Validation(message))
                if message == "Cannot read properties of null (reading 'claude')"
        ));
    }

    // F3: `models: {claude: null}` reaches createTask as null in Node, which
    // spawns with the CLI default model; the String seam renders that "".
    #[test]
    fn a_null_model_runs_with_the_default_model_like_node() {
        let harness = Harness::new("null-model");
        harness.write_state(&json!({ "jobs": [{
            "id": "a", "title": "a", "description": "d", "cwd": "C:\\x", "enabled": true,
            "cooldownHours": 24, "lastRunAt": Value::Null,
            "thresholds": { "claude": { "start": 50, "stop": 75, "weeklyMax": 50 } },
            "tokenCaps": { "claude": 15_000_000 },
            "models": { "claude": Value::Null },
        }] }));
        let service = harness.service();
        run(service.run_now(true)).unwrap();
        assert_eq!(harness.tasks.tasks.lock().unwrap()[0]["model"], json!(""));
    }

    // ---- startup recovery -----------------------------------------------------

    #[test]
    fn startup_recovery_joins_a_pending_intent_and_keeps_unknown_ones() {
        let harness = Harness::new("recovery");
        harness.tasks.push(json!({
            "id": "durable", "tags": ["background"], "column": "done",
            "backgroundJobId": "job-a", "backgroundRunId": "run-a",
        }));
        harness.write_state(&json!({ "jobs": [
            { "id": "job-a", "title": "a", "enabled": true, "cooldownHours": 24, "lastRunAt": Value::Null,
              "pendingRunId": "run-a", "pendingRunAt": 1234 },
            { "id": "job-b", "title": "b", "enabled": true, "cooldownHours": 24, "lastRunAt": Value::Null,
              "pendingRunId": "run-unknown", "pendingRunAt": 5678 },
        ]}));
        let service = harness.service();
        let jobs = service.jobs();
        assert_eq!(jobs[0]["lastTaskId"], json!("durable"));
        assert_eq!(jobs[0]["lastRunAt"], json!(1234));
        assert!(jobs[0].get("pendingRunId").is_none());
        assert_eq!(
            jobs[1]["pendingRunId"],
            json!("run-unknown"),
            "unknown outcomes are kept"
        );
    }

    // ---- heal / watchdog ------------------------------------------------------

    #[test]
    fn heal_releases_a_dead_session_and_unblocks_the_next_run() {
        let harness = Harness::new("heal");
        harness.tasks.push(json!({
            "id": "bg-dead", "title": "Bg Job Run", "tags": ["background"],
            "column": "inprogress", "state": "working", "sessionId": "dead-session",
        }));
        let service = harness.service();
        assert_eq!(service.snapshot()["liveTaskId"], json!("bg-dead"));

        run(service.heal_live_bg_task());
        assert_eq!(service.snapshot()["liveTaskId"], Value::Null);
        let updates = harness.tasks.updates.lock().unwrap();
        assert_eq!(
            updates[0],
            (
                "bg-dead".to_owned(),
                json!({ "column": "inreview", "state": "parked — needs human" })
            )
        );
    }

    #[test]
    fn watchdog_injects_the_wrapup_once_then_kills_after_the_grace() {
        let harness = Harness::new("watchdog");
        harness.usage.set(Ok(
            json!({ "claude": source(Some(json!({ "session": { "pctUsed": 80 } }))) }),
        ));
        harness.tasks.push(json!({
            "id": "bg-live", "title": "Bg", "tags": ["background"], "column": "inprogress",
            "sessionId": "live", "model": "claude-opus", "repo": "C:\\x",
        }));
        harness
            .registry
            .live
            .lock()
            .unwrap()
            .push("live".to_owned());
        let service = harness.service();
        let job = service
            .create_job(
                &json!({ "title": "a", "description": "d", "cwd": "C:\\x" }),
                None,
            )
            .unwrap();
        service
            .update_job(
                job["id"].as_str().unwrap(),
                &json!({ "lastTaskId": "bg-live" }),
            )
            .unwrap();

        run(service.watchdog_with_grace(0));
        assert_eq!(
            harness.registry.inputs.lock().unwrap()[0],
            ("live".to_owned(), format!("\r{WRAPUP}\r"))
        );
        // The second poll for the same task is a no-op.
        run(service.watchdog_with_grace(0));
        assert_eq!(harness.registry.inputs.lock().unwrap().len(), 1);

        let live_task = harness.tasks.tasks.lock().unwrap()[0].clone();
        run(service.enforce_grace(&live_task));
        assert_eq!(harness.registry.kills.lock().unwrap().as_slice(), ["live"]);
        let parked = harness
            .tasks
            .updates
            .lock()
            .unwrap()
            .iter()
            .any(|(id, patch)| id == "bg-live" && patch["state"] == json!("stopped — budget"));
        assert!(parked);
    }

    #[test]
    fn watchdog_continues_without_injecting_when_within_budget() {
        let harness = Harness::new("watchdog-continue");
        harness.tasks.push(json!({
            "id": "bg-live", "title": "Bg", "tags": ["background"], "column": "inprogress",
            "sessionId": "live", "model": "claude-opus", "repo": "C:\\x",
        }));
        harness
            .registry
            .live
            .lock()
            .unwrap()
            .push("live".to_owned());
        let service = harness.service();
        let job = service
            .create_job(
                &json!({ "title": "a", "description": "d", "cwd": "x" }),
                None,
            )
            .unwrap();
        service
            .update_job(
                job["id"].as_str().unwrap(),
                &json!({ "lastTaskId": "bg-live" }),
            )
            .unwrap();
        run(service.watchdog_with_grace(0));
        assert!(harness.registry.inputs.lock().unwrap().is_empty());
        assert!(harness.registry.kills.lock().unwrap().is_empty());
    }

    // ---- service-level reports surface ----------------------------------------

    #[test]
    fn service_reports_emit_on_flag_and_exclude_non_background_tasks() {
        let harness = Harness::new("reports");
        let report = harness.fixture.0.join("report");
        fs::create_dir_all(&report).unwrap();
        fs::write(report.join("Report.md"), "# r\n").unwrap();
        harness.tasks.push(json!({
            "id": "live1", "title": "BG", "tags": ["background"],
            "reportDir": report.to_string_lossy(), "column": "inprogress", "createdAt": 1,
        }));
        harness.tasks.push(json!({ "id": "plain", "title": "Plain", "tags": [], "column": "todo", "createdAt": 2 }));
        let service = harness.service();
        let reports = service.list_reports().unwrap();
        assert_eq!(reports.len(), 1);
        assert_eq!(reports[0]["taskId"], json!("live1"));
        assert_eq!(reports[0]["flagged"], json!(true));

        harness.events.store(0, Ordering::SeqCst);
        let result = service.set_report_flag("live1", false).unwrap();
        assert_eq!(result, json!({ "taskId": "live1", "flagged": false }));
        assert_eq!(harness.events(), 1);
        assert_eq!(service.list_reports().unwrap()[0]["flagged"], json!(false));
        assert_eq!(
            service.get_report("live1").unwrap().unwrap()["content"],
            json!("# r\n")
        );
        assert!(matches!(
            service.set_report_flag("nope", true),
            Err(BackgroundError::Validation(message)) if message == "no such report"
        ));
    }
}
