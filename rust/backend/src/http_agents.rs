//! Agent HTTP routes: `GET /api/agent-stats`, `GET /api/procs`,
//! `POST /api/procs/kill`, `POST /api/session/external`.
//!
//! Ports `server/index.mjs:368` (`agent-stats`), `:495` (`procs`), `:558-562`
//! (`procs/kill`) and `:580` (`session/external`) with the modules they call:
//! `server/procs.mjs` (`scanClaude`, `killClaudePid`), `server/stats.mjs:321-328`
//! (`statsFor`) and `server/detached-launch.mjs`
//! (`createExternalSessionLaunchHandler`, which also needs `agents.mjs:517-539`
//! `externalLaunch` + `:498-509` `resolveWt`).
//!
//! Everything ambient is injected through [`AgentsDeps`]: the live [`Registry`],
//! the spawn-argv inputs ([`Bins`] plus the parent environment), the repo root
//! and host pid `procs.mjs:21-23` classifies against, the platform/environment
//! the external-launch builder branches on, the native process seam
//! ([`ProcBackend`]), the detached-spawn seam and the stats paths.
//!
//! Parity notes:
//! - Node keeps `scan`/`classify`/`kill` behind `rustBackend` calls and the
//!   registry snapshot in JS (`procs.mjs:25-41`); here [`ProcBackend`] is the
//!   seam and the registry snapshot stays in this crate, passed to
//!   [`procs_discovery::classify`] exactly as Node passes it to the bridge.
//! - `externalLaunch` is not a [`Registry`] method: the launch record is built
//!   here from [`Registry::record`].

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use axum::body::Body;
use axum::extract::State;
use axum::http::{Request, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{Value, json};

use crate::agent_registry::{LiveProcesses, Registry};
use crate::agent_spawn::{self, Bins, LaunchInput};
use crate::stats::{StatsAgent, StatsRequest, StatsService};
use crate::transcript_bridge::ResponseBody;

/// `Number.isInteger` rejects a missing/invalid pid with this body
/// (`index.mjs:559-560`).
const BAD_PID: &str = "bad pid";
/// `killClaudePid` when the classification has no row for the pid
/// (`procs.mjs:50-51`).
const NOT_TRACKED: &str = "not a tracked process";
/// `createExternalSessionLaunchHandler` when `req.body.id` is falsy
/// (`detached-launch.mjs:6`).
const ID_REQUIRED: &str = "id required";
/// `externalLaunch` for an id the registry does not hold (`agents.mjs:519`).
const NO_SUCH_SESSION: &str = "no such session";
/// `externalLaunch` on a non-Windows/macOS host (`agents.mjs:538`).
const UNSUPPORTED_PLATFORM: &str = "external terminal open is Windows/macOS only";
/// `externalLaunch` when neither the Store alias nor PATH has `wt.exe`
/// (`agents.mjs:528`).
const WT_MISSING: &str = "wt.exe not found (checked the Store alias path and PATH)";
/// The stats bridge's own `invalid_request` message (`stats.rs:413-415`).
const BAD_STATS_INPUTS: &str = "missing stats request inputs";

// VERIFY: http-agents-platform
/// `process.platform` as `externalLaunch` branches on it (`agents.mjs:522-538`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Platform {
    Win32,
    Darwin,
    Other,
}

impl Platform {
    // VERIFY: http-agents-platform-host
    /// The platform this daemon runs on.
    pub fn host() -> Self {
        if cfg!(windows) {
            Self::Win32
        } else if cfg!(target_os = "macos") {
            Self::Darwin
        } else {
            Self::Other
        }
    }

    fn is_darwin(self) -> bool {
        self == Self::Darwin
    }
}

// VERIFY: http-agents-proc-backend
/// The `rustBackend` process calls `procs.mjs` makes: the raw OS scan, the
/// classification against the registry's live snapshot, and the guarded kill.
/// The daemon uses [`NativeProcs`]; tests inject a fake so no process is ever
/// queried or killed.
pub trait ProcBackend: Send + Sync {
    /// `procsScanRaw()` (`rust-backend.mjs:808-810`).
    fn scan_raw(&self) -> Value;
    /// `procsClassify(snapshot, livePids, liveSessions, repoRoot, hostPid)`
    /// (`rust-backend.mjs:812-821`).
    fn classify(&self, request: &Value) -> Value;
    /// `procsKillGuarded(pid, name, kind, isDarwin)`
    /// (`rust-backend.mjs:823-829`).
    fn kill_guarded(&self, pid: &Value, name: &str, kind: &str, is_darwin: bool) -> Value;
}

// VERIFY: http-agents-native-procs
/// The production [`ProcBackend`]: [`procs_discovery`] plus [`procs_guard`].
pub struct NativeProcs;

impl ProcBackend for NativeProcs {
    fn scan_raw(&self) -> Value {
        crate::procs_discovery::scan_raw()
    }

    fn classify(&self, request: &Value) -> Value {
        crate::procs_discovery::classify(request)
    }

    fn kill_guarded(&self, pid: &Value, name: &str, kind: &str, is_darwin: bool) -> Value {
        crate::procs_guard::kill_guarded(pid, name, kind, is_darwin)
    }
}

// VERIFY: http-agents-spawn-detached
/// `rustBackend.spawnDetached(launcher, args, cwd)` (`detached-launch.mjs:10`).
/// The daemon passes an adapter over [`crate::detached::spawn`] that turns a
/// `{ok:false, error}` envelope into `Err(error)`; tests record the call.
pub type SpawnDetached =
    Arc<dyn Fn(&str, &[String], Option<&str>) -> Result<(), String> + Send + Sync>;

// VERIFY: http-agents-stats-paths
/// The stats inputs `stats.mjs:227-234` fills from the daemon environment.
#[derive(Clone, Debug)]
pub struct StatsPaths {
    /// `os.homedir()` — `~/.claude/projects/<encoded-cwd>/<id>.jsonl`.
    pub claude_home: PathBuf,
    /// `CODEX_HOME` — codex rollout discovery.
    pub codex_home: PathBuf,
    /// `USAGE_SKILL_STATE` — its `cost-state/` files.
    pub usage_state: PathBuf,
    /// `STATE_DIR` (transcript lookup inside the stats service).
    pub state_dir: PathBuf,
}

// VERIFY: http-agents-deps
/// Everything the four routes need from the host. Paths are explicit; nothing
/// is read from the process environment except through `parent_env`.
pub struct AgentsDeps {
    /// The live agent registry: process classification and external launch
    /// both consult it, and a successful launch removes its row.
    pub registry: Arc<Registry>,
    /// `resolveBin` results plus the probed roots the launch argv builder needs
    /// (`agent_spawn::build_launch`).
    pub bins: Bins,
    /// The daemon environment handed to spawned children (`spawnEnv`,
    /// `agents.mjs:402-406`) and read for `LOCALAPPDATA`/`PATH` by
    /// `resolveWt` (`:498-509`).
    pub parent_env: BTreeMap<String, String>,
    /// `REPO_ROOT` in `procs.mjs:21` — dev tooling outside it is never listed.
    pub repo_root: PathBuf,
    /// `process.pid` (`procs.mjs:23`): the daemon's own row is always `daemon`.
    pub host_pid: u32,
    /// `process.platform` for the external-launch branch.
    pub platform: Platform,
    /// The OS process seam ([`NativeProcs`] in the daemon).
    pub procs: Arc<dyn ProcBackend>,
    /// The detached-spawn seam (`detached::spawn` in the daemon).
    pub spawn_detached: SpawnDetached,
    /// Stats inputs for `/api/agent-stats`.
    pub stats: StatsPaths,
}

struct Inner {
    registry: Arc<Registry>,
    bins: Bins,
    parent_env: BTreeMap<String, String>,
    repo_root: PathBuf,
    host_pid: u32,
    platform: Platform,
    procs: Arc<dyn ProcBackend>,
    spawn_detached: SpawnDetached,
    stats: StatsPaths,
    /// One cache for the daemon's lifetime, like Node's module-level cache
    /// (`stats.mjs:222-237`).
    stats_service: Arc<Mutex<StatsService>>,
}

// VERIFY: http-agents-router
/// Mounts the four agent routes. The outer server layer owns auth, origin and
/// token checks.
pub fn router(deps: AgentsDeps) -> Router {
    Router::new()
        .route("/api/agent-stats", get(agent_stats))
        .route("/api/procs", get(procs_list))
        .route("/api/procs/kill", post(procs_kill))
        .route("/api/session/external", post(session_external))
        .with_state(state(deps))
}

fn state(deps: AgentsDeps) -> Arc<Inner> {
    Arc::new(Inner {
        registry: deps.registry,
        bins: deps.bins,
        parent_env: deps.parent_env,
        repo_root: deps.repo_root,
        host_pid: deps.host_pid,
        platform: deps.platform,
        procs: deps.procs,
        spawn_detached: deps.spawn_detached,
        stats: deps.stats,
        stats_service: Arc::new(Mutex::new(StatsService::default())),
    })
}

// VERIFY: http-agents-agent-stats
/// `app.get('/agent-stats', () => ({ stats: await statsFor(reg.snapshot()) }))`
/// (`index.mjs:368`, `stats.mjs:321-328`): per-agent turns/tokens/cost plus the
/// live registry's `busyMs`.
async fn agent_stats(State(inner): State<Arc<Inner>>) -> Response {
    let agents = inner.registry.snapshot();
    let request = StatsRequest {
        stats_claude_home: Some(path_string(&inner.stats.claude_home)),
        stats_codex_home: Some(path_string(&inner.stats.codex_home)),
        stats_usage_state: Some(path_string(&inner.stats.usage_state)),
        stats_state_dir: Some(path_string(&inner.stats.state_dir)),
        stats_agents: Some(
            agents
                .iter()
                .map(|agent| StatsAgent {
                    id: agent.id.clone(),
                    cwd: agent.cwd.clone().unwrap_or_default(),
                    tool: agent.tool.clone(),
                })
                .collect(),
        ),
        ..StatsRequest::default()
    };
    let service = inner.stats_service.clone();
    let dispatched = tokio::task::spawn_blocking(move || {
        let mut service = service.lock().unwrap_or_else(|error| error.into_inner());
        service.dispatch("agent_stats", &request)
    })
    .await;
    let raw = match dispatched {
        Ok(ResponseBody::Raw(raw)) => raw,
        Ok(ResponseBody::Value(error)) => {
            return internal_error(error["error"].as_str().unwrap_or(BAD_STATS_INPUTS));
        }
        Err(_) => return internal_error(BAD_STATS_INPUTS),
    };
    // The entries object is the parser's exact JSON; splice `busyMs` into each
    // entry (JS assignment keeps the key last) instead of re-modelling it.
    let mut stats: Value = match serde_json::from_str(raw.get()) {
        Ok(value) => value,
        Err(error) => return internal_error(&error.to_string()),
    };
    if let Some(entries) = stats.as_object_mut() {
        for agent in &agents {
            if let Some(entry) = entries.get_mut(&agent.id).and_then(Value::as_object_mut) {
                entry.insert(
                    "busyMs".to_owned(),
                    json!(inner.registry.active_ms(&agent.id)),
                );
            }
        }
    }
    Json(json!({ "stats": stats })).into_response()
}

// VERIFY: http-agents-procs-list
/// `app.get('/procs', () => ({ procs: await scanClaude() }))` (`index.mjs:495`).
async fn procs_list(State(inner): State<Arc<Inner>>) -> Response {
    let classified = tokio::task::spawn_blocking(move || scan_claude(&inner))
        .await
        .unwrap_or_else(|_| Value::Array(Vec::new()));
    Json(json!({ "procs": classified })).into_response()
}

// VERIFY: http-agents-procs-kill
/// `app.post('/procs/kill', ...)` (`index.mjs:558-562`) → `killClaudePid`
/// (`procs.mjs:48-55`).
async fn procs_kill(State(inner): State<Arc<Inner>>, request: Request<Body>) -> Response {
    let body = match crate::http_body::parse(request).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    let Some(pid) = js_integer(body.get("pid")) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "ok": false, "error": BAD_PID })),
        )
            .into_response();
    };
    match tokio::task::spawn_blocking(move || kill_claude(&inner, pid)).await {
        Ok(result) => Json(result).into_response(),
        Err(_) => internal_error("kill failed"),
    }
}

// VERIFY: http-agents-session-external
/// `app.post('/session/external', createExternalSessionLaunchHandler(...))`
/// (`index.mjs:580`, `detached-launch.mjs:3-17`).
async fn session_external(State(inner): State<Arc<Inner>>, request: Request<Body>) -> Response {
    let body = match crate::http_body::parse(request).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    let id = body.get("id");
    if !js_truthy(id) {
        return rejected(json!({ "ok": false, "error": ID_REQUIRED }));
    }
    // A truthy non-string id can never match a registry key (`Map.get(5)`).
    let Some(id) = id.and_then(Value::as_str).map(str::to_owned) else {
        return rejected(json!({ "ok": false, "error": NO_SUCH_SESSION }));
    };
    let outcome = tokio::task::spawn_blocking(move || {
        let launch = external_launch(&inner, &id)?;
        (inner.spawn_detached)(&launch.launcher, &launch.args, Some(&launch.cwd))
            .map_err(LaunchError::Internal)?;
        inner.registry.remove(&id).map_err(LaunchError::Internal)?;
        Ok(())
    })
    .await;
    match outcome {
        Ok(Ok(())) => Json(json!({ "ok": true })).into_response(),
        Ok(Err(LaunchError::Rejected(body))) => rejected(body),
        Ok(Err(LaunchError::Internal(message))) => internal_error(&message),
        Err(_) => internal_error("launch failed"),
    }
}

/// `scanClaude()` (`procs.mjs:25-41`): the raw scan, then the registry's live
/// snapshot, then classification. Failures collapse to `[]` like Node's
/// try/catch blocks.
fn scan_claude(inner: &Inner) -> Value {
    let snapshot = inner.procs.scan_raw();
    let live: LiveProcesses = inner.registry.live_process_snapshot();
    let request = json!({
        "snapshot": snapshot,
        "live_pids": live.pids,
        "live_sessions": live.sessions,
        "repo_root": path_string(&inner.repo_root),
        "host_pid": inner.host_pid,
    });
    inner.procs.classify(&request)
}

/// `killClaudePid(pid)` (`procs.mjs:48-55`): re-classify, take the first row
/// for the pid (Node's `Array.find`), then run the guarded kill.
fn kill_claude(inner: &Inner, pid: i64) -> Value {
    let procs = scan_claude(inner);
    let Some(target) = procs.as_array().and_then(|rows| {
        rows.iter()
            .find(|row| row.get("pid").and_then(Value::as_i64) == Some(pid))
    }) else {
        return json!({ "ok": false, "error": NOT_TRACKED });
    };
    let name = target
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let kind = target
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let result = inner
        .procs
        .kill_guarded(&json!(pid), name, kind, inner.platform.is_darwin());
    // The bridge throws `oneShotError(...)` for a query failure and
    // `killClaudePid`'s catch turns it into `{ok:false, error: message}`
    // (`rust-backend.mjs:823-829`, `procs.mjs:52-54`).
    if result.get("oneshot_failure").is_some() {
        return json!({ "ok": false, "error": oneshot_message(&result) });
    }
    result
}

/// `{launcher, args, cwd}` — what the route hands `spawnDetached`.
struct Launch {
    launcher: String,
    args: Vec<String>,
    cwd: String,
}

enum LaunchError {
    /// `{ok:false, error}` returned as a 400 (`detached-launch.mjs:7-8`).
    Rejected(Value),
    /// A thrown error: Fastify's 500 envelope (`detached-launch.mjs:11-12`).
    Internal(String),
}

/// `externalLaunch(id, platform, env)` (`agents.mjs:517-539`) as a pure
/// builder over the full persisted record, like `buildSpawn(a)`.
fn external_launch(inner: &Inner, id: &str) -> Result<Launch, LaunchError> {
    let Some(agent) = inner.registry.record(id) else {
        return Err(LaunchError::Rejected(
            json!({ "ok": false, "error": NO_SUCH_SESSION }),
        ));
    };
    let cwd = agent.cwd.unwrap_or_default();
    let record = LaunchInput {
        id: agent.id,
        title: agent.title.unwrap_or_default(),
        cwd: cwd.clone(),
        model: agent.model.unwrap_or_default(),
        scopes: agent.scopes.unwrap_or_default(),
        tool: agent.tool,
        created_at: agent.created_at,
        permission_mode: agent.permission_mode,
        extra_args: agent.extra_args.unwrap_or_default(),
        thread_id: agent.thread_id,
        prompt: None,
        mock: agent.mock.unwrap_or(false),
    };
    let spec = agent_spawn::build_launch(&record, &inner.bins, &inner.parent_env)
        .map_err(LaunchError::Internal)?;
    match inner.platform {
        Platform::Win32 => {
            let Some(wt) = resolve_wt(&inner.parent_env) else {
                return Err(LaunchError::Rejected(
                    json!({ "ok": false, "error": WT_MISSING }),
                ));
            };
            let mut args = vec!["-d".to_owned(), cwd.clone(), spec.bin];
            args.extend(spec.args);
            Ok(Launch {
                launcher: wt,
                args,
                cwd,
            })
        }
        Platform::Darwin => {
            let shell = format!(
                "cd {} && exec {} {}",
                shell_quote(&cwd),
                shell_quote(&spec.bin),
                spec.args
                    .iter()
                    .map(|arg| shell_quote(arg))
                    .collect::<Vec<_>>()
                    .join(" ")
            );
            Ok(Launch {
                launcher: "osascript".to_owned(),
                args: vec![
                    "-e".to_owned(),
                    format!(
                        "tell application \"Terminal\" to do script {}",
                        json_string(&shell)
                    ),
                ],
                cwd,
            })
        }
        Platform::Other => Err(LaunchError::Rejected(
            json!({ "ok": false, "error": UNSUPPORTED_PLATFORM }),
        )),
    }
}

/// `resolveWt` (`agents.mjs:498-509`): the Store App Execution Alias first,
/// then the `;`-separated PATH (Node hardcodes `;`; the branch is Windows-only).
fn resolve_wt(env: &BTreeMap<String, String>) -> Option<String> {
    if let Some(local) = env.get("LOCALAPPDATA") {
        let alias = Path::new(local)
            .join("Microsoft")
            .join("WindowsApps")
            .join("wt.exe");
        if is_executable(&alias) {
            return Some(alias.to_string_lossy().into_owned());
        }
    }
    for dir in env.get("PATH").map(String::as_str).unwrap_or("").split(';') {
        if dir.is_empty() {
            continue;
        }
        let candidate = Path::new(dir).join("wt.exe");
        if is_executable(&candidate) {
            return Some(candidate.to_string_lossy().into_owned());
        }
    }
    None
}

#[cfg(windows)]
fn is_executable(path: &Path) -> bool {
    // `accessSync(path, X_OK)` on Windows is an existence check.
    path.exists()
}

#[cfg(not(windows))]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path)
        .map(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

/// `const sq = (s) => \`'${String(s).replace(/'/g, `'"'"'`)}'\`` (`agents.mjs:532`).
fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

/// `JSON.stringify(shell)` (`agents.mjs:535`).
fn json_string(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_owned())
}

/// `oneShotError(payload, bin, args, timeout)`'s message
/// (`rust-backend.mjs:23-34`).
fn oneshot_message(envelope: &Value) -> String {
    let bin = envelope
        .get("bin")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let args = envelope
        .get("args")
        .and_then(Value::as_array)
        .map(|args| {
            args.iter()
                .map(|arg| arg.as_str().unwrap_or_default())
                .collect::<Vec<_>>()
                .join(" ")
        })
        .unwrap_or_default();
    let argv = if args.is_empty() {
        bin.to_owned()
    } else {
        format!("{bin} {args}")
    };
    let failure = &envelope["oneshot_failure"];
    let stderr = failure
        .get("stderr")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim();
    let tail = stderr
        .rsplit('\n')
        .next()
        .unwrap_or_default()
        .trim_end_matches('\r');
    if js_truthy(failure.get("timed_out")) {
        let timeout = envelope
            .get("timeout_ms")
            .and_then(Value::as_i64)
            .unwrap_or(0);
        return format!("Command timed out after {timeout}ms: {argv}");
    }
    if tail.is_empty() {
        format!("Command failed: {argv}")
    } else {
        format!("Command failed: {argv}\n{tail}")
    }
}

/// `Number(value)` for the scalar JSON shapes a request body can hold
/// (`index.mjs:559`).
fn js_number(value: &Value) -> Option<f64> {
    match value {
        Value::Number(number) => number.as_f64(),
        Value::String(text) => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                return Some(0.0);
            }
            for (prefix, radix) in [
                ("0x", 16),
                ("0X", 16),
                ("0o", 8),
                ("0O", 8),
                ("0b", 2),
                ("0B", 2),
            ] {
                if let Some(digits) = trimmed.strip_prefix(prefix) {
                    return i64::from_str_radix(digits, radix)
                        .ok()
                        .map(|value| value as f64);
                }
            }
            trimmed.parse::<f64>().ok()
        }
        Value::Bool(flag) => Some(if *flag { 1.0 } else { 0.0 }),
        Value::Null => Some(0.0),
        // `Number([])` is 0 and `Number([x])` coerces the single element;
        // longer arrays and objects are NaN.
        Value::Array(items) => match items.as_slice() {
            [] => Some(0.0),
            [single] => js_number(single),
            _ => None,
        },
        Value::Object(_) => None,
    }
}

/// `Number.isInteger(Number(value))`, then the `i64` the registry rows use.
fn js_integer(value: Option<&Value>) -> Option<i64> {
    let number = js_number(value?)?;
    if !number.is_finite() || number.fract() != 0.0 {
        return None;
    }
    if number < i64::MIN as f64 || number > i64::MAX as f64 {
        return None;
    }
    Some(number as i64)
}

/// JavaScript truthiness for a JSON value (`if (!id)`).
fn js_truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().map(|value| value != 0.0).unwrap_or(true),
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Array(_)) | Some(Value::Object(_)) => true,
    }
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn rejected(body: Value) -> Response {
    (StatusCode::BAD_REQUEST, Json(body)).into_response()
}

fn internal_error(message: &str) -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({
            "statusCode": 500,
            "error": "Internal Server Error",
            "message": message,
        })),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::{
        AgentsDeps, Inner, LaunchError, NativeProcs, Platform, ProcBackend, SpawnDetached,
        StatsPaths, agent_stats, external_launch, js_integer, js_truthy, oneshot_message,
        procs_kill, procs_list, resolve_wt, session_external, state,
    };
    use crate::agent_registry::{CreateAgent, PtyPort, Registry, RegistryConfig};
    use crate::agent_spawn::{Bins, LaunchSpec, SpawnPaths};
    use crate::bus::Bus;
    use crate::pty::PtyEvent;
    use axum::body::{Body, to_bytes};
    use axum::extract::State;
    use axum::http::{Method, Request, header};
    use axum::response::Response;
    use serde_json::{Value, json};
    use std::collections::{BTreeMap, VecDeque};
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicI64, AtomicU32, AtomicU64, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::{SystemTime, UNIX_EPOCH};

    static FIXTURE_ID: AtomicU64 = AtomicU64::new(0);
    const SESSION: &str = "b7025c66-c765-479d-865c-e507a677db55";

    struct Fixture {
        root: PathBuf,
        port: Arc<FakePort>,
        clock: Arc<AtomicI64>,
    }

    impl Fixture {
        fn new() -> Self {
            let stamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let id = FIXTURE_ID.fetch_add(1, Ordering::Relaxed);
            let root = std::env::temp_dir().join(format!(
                "singularity-http-agents-{}-{stamp}-{id}",
                std::process::id()
            ));
            for dir in ["home", "repo", "state", "usage", "codex-home", "cache"] {
                fs::create_dir_all(root.join(dir)).unwrap();
            }
            Self {
                root,
                port: FakePort::new(),
                clock: Arc::new(AtomicI64::new(1_000)),
            }
        }

        fn path(&self, rel: &str) -> PathBuf {
            self.root.join(rel)
        }

        fn repo(&self) -> String {
            self.path("repo").to_string_lossy().into_owned()
        }

        fn touch(&self, rel: &str) -> String {
            let path = self.path(rel);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, b"").unwrap();
            path.to_string_lossy().into_owned()
        }

        /// A file with the execute bit set, so the unix `X_OK` check sees it.
        fn touch_exec(&self, rel: &str) -> String {
            let path = self.path(rel);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, b"").unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
            }
            path.to_string_lossy().into_owned()
        }

        fn spawn_paths(&self) -> SpawnPaths {
            SpawnPaths {
                home: self.path("home"),
                scope_root: None,
                cache_dir: self.path("cache"),
                codex_home: self.path("codex-home"),
                models_state: self.path("state/models.json"),
            }
        }

        fn bins(&self) -> Bins {
            let claude = self.touch("bin/claude.exe");
            let ollama = self.touch("bin/ollama.exe");
            let codex = self.touch("bin/codex.exe");
            Bins::resolve(
                Some(&claude),
                Some(&ollama),
                Some(&codex),
                self.spawn_paths(),
            )
        }

        fn registry(&self) -> Arc<Registry> {
            let clock = self.clock.clone();
            Arc::new(Registry::new(
                Bus::new(),
                self.port.clone(),
                RegistryConfig {
                    state_file: self.path("state/agents.json"),
                    bins: self.bins(),
                    parent_env: BTreeMap::new(),
                    clock: Arc::new(move || clock.load(Ordering::SeqCst)),
                },
            ))
        }

        fn stats_paths(&self) -> StatsPaths {
            StatsPaths {
                claude_home: self.path("home"),
                codex_home: self.path("codex-home"),
                usage_state: self.path("usage"),
                state_dir: self.path("state"),
            }
        }

        fn seed_detached(&self, registry: &Registry) {
            fs::write(
                self.path("state/agents.json"),
                serde_json::to_string_pretty(&json!({
                    "agents": [{
                        "id": SESSION,
                        "title": "demo",
                        "cwd": self.repo(),
                        "model": "claude",
                        "createdAt": 1,
                        "status": "detached"
                    }],
                    "recentRepos": []
                }))
                .unwrap(),
            )
            .unwrap();
            registry.load().unwrap();
        }

        fn create_agent(&self, registry: &Registry) {
            registry
                .create(CreateAgent {
                    cwd: Some(self.repo()),
                    title: Some("snapshot-test".to_owned()),
                    model: Some("claude".to_owned()),
                    session_id: Some(SESSION.to_owned()),
                    ..CreateAgent::default()
                })
                .unwrap();
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[derive(Default)]
    struct FakePort {
        spawns: Mutex<Vec<(String, LaunchSpec)>>,
        #[allow(dead_code)]
        kills: Mutex<Vec<String>>,
        next_pid: AtomicU32,
    }

    impl FakePort {
        fn new() -> Arc<Self> {
            Arc::new(Self {
                next_pid: AtomicU32::new(1000),
                ..Self::default()
            })
        }
    }

    impl PtyPort for FakePort {
        fn spawn(&self, id: &str, _generation: u64, spec: LaunchSpec) -> Result<u32, String> {
            self.spawns.lock().unwrap().push((id.to_owned(), spec));
            Ok(self.next_pid.fetch_add(1, Ordering::SeqCst))
        }

        fn write(&self, _id: &str, _data: &[u8]) -> Result<(), String> {
            Ok(())
        }

        fn resize(&self, _id: &str, _cols: u16, _rows: u16) -> Result<(), String> {
            Ok(())
        }

        fn kill(&self, id: &str) -> Result<(), String> {
            self.kills.lock().unwrap().push(id.to_owned());
            Ok(())
        }
    }

    /// Mirrors `mockBackend` in `procs.test.mjs:62-83`: classification and
    /// re-query answers come from queues; nothing touches a real process.
    #[derive(Default)]
    struct FakeProcs {
        classify: Mutex<VecDeque<Value>>,
        stdout: Mutex<VecDeque<String>>,
        requests: Mutex<Vec<Value>>,
        guards: Mutex<Vec<(i64, String, String, bool)>>,
        kills: Mutex<Vec<i64>>,
        fail_kill: Mutex<Option<Value>>,
        on_scan: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
    }

    impl FakeProcs {
        fn classify(&self, rows: Value) {
            self.classify.lock().unwrap().push_back(rows);
        }

        fn stdout(&self, answer: &str) {
            self.stdout.lock().unwrap().push_back(answer.to_owned());
        }

        fn requests(&self) -> Vec<Value> {
            self.requests.lock().unwrap().clone()
        }

        fn guards(&self) -> Vec<(i64, String, String, bool)> {
            self.guards.lock().unwrap().clone()
        }

        fn kills(&self) -> Vec<i64> {
            self.kills.lock().unwrap().clone()
        }
    }

    impl ProcBackend for FakeProcs {
        fn scan_raw(&self) -> Value {
            let hook = self.on_scan.lock().unwrap().clone();
            if let Some(hook) = hook {
                hook();
            }
            json!({"platform": "windows", "rows": [], "alive": [], "rust_pid": 999})
        }

        fn classify(&self, request: &Value) -> Value {
            self.requests.lock().unwrap().push(request.clone());
            self.classify
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or_else(|| json!([]))
        }

        fn kill_guarded(&self, pid: &Value, name: &str, kind: &str, is_darwin: bool) -> Value {
            let pid = pid.as_i64().unwrap_or_default();
            self.guards
                .lock()
                .unwrap()
                .push((pid, name.to_owned(), kind.to_owned(), is_darwin));
            if let Some(envelope) = self.fail_kill.lock().unwrap().clone() {
                return envelope;
            }
            if kind == "daemon" {
                return json!({"ok": false, "error": "daemon process — cannot stop from here"});
            }
            let answer = self.stdout.lock().unwrap().pop_front();
            if is_darwin || answer.as_deref().map(str::trim) == Some("True") {
                self.kills.lock().unwrap().push(pid);
                return json!({"ok": true});
            }
            json!({"ok": false, "error": "process changed before kill"})
        }
    }

    #[derive(Default)]
    struct SpawnLog {
        calls: Mutex<Vec<(String, Vec<String>, Option<String>)>>,
        fail: Mutex<Option<String>>,
    }

    impl SpawnLog {
        fn calls(&self) -> Vec<(String, Vec<String>, Option<String>)> {
            self.calls.lock().unwrap().clone()
        }
    }

    fn spawn_log() -> (Arc<SpawnLog>, SpawnDetached) {
        let log = Arc::new(SpawnLog::default());
        let record = log.clone();
        let spawn: SpawnDetached = Arc::new(move |launcher, args, cwd| {
            record.calls.lock().unwrap().push((
                launcher.to_owned(),
                args.to_vec(),
                cwd.map(str::to_owned),
            ));
            match record.fail.lock().unwrap().clone() {
                Some(message) => Err(message),
                None => Ok(()),
            }
        });
        (log, spawn)
    }

    fn base_deps(
        fixture: &Fixture,
        registry: Arc<Registry>,
        procs: Arc<dyn ProcBackend>,
    ) -> AgentsDeps {
        AgentsDeps {
            registry,
            bins: fixture.bins(),
            parent_env: BTreeMap::new(),
            repo_root: fixture.path("repo"),
            host_pid: 4242,
            platform: Platform::Win32,
            procs,
            spawn_detached: Arc::new(|_, _, _| Ok(())),
            stats: fixture.stats_paths(),
        }
    }

    fn run<F: std::future::Future>(future: F) -> F::Output {
        tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(future)
    }

    async fn collect(response: Response) -> (u16, String) {
        let status = response.status().as_u16();
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        (status, String::from_utf8(bytes.to_vec()).unwrap())
    }

    async fn post<H, Fut>(handler: H, uri: &str, body: &str) -> (u16, String)
    where
        H: FnOnce(Request<Body>) -> Fut,
        Fut: std::future::Future<Output = Response>,
    {
        let request = Request::builder()
            .method(Method::POST)
            .uri(uri)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body.to_owned()))
            .unwrap();
        collect(handler(request).await).await
    }

    fn row(pid: i64, name: &str, kind: &str) -> Value {
        json!({"pid": pid, "ppid": 1, "name": name, "started": null, "session": null, "kind": kind})
    }

    // VERIFY: http-agents-tests-scan-order
    /// `procs.test.mjs:18-59`: the registry snapshot is taken after the raw scan
    /// completes and the host pid (not the Rust pid) reaches the classifier.
    #[test]
    fn registry_snapshot_follows_completed_scan_and_passes_host_pid() {
        let fixture = Fixture::new();
        let registry = fixture.registry();
        let procs = Arc::new(FakeProcs::default());
        let events = Arc::new(Mutex::new(Vec::<&'static str>::new()));
        {
            let registry = registry.clone();
            let repo = fixture.repo();
            let events = events.clone();
            *procs.on_scan.lock().unwrap() = Some(Arc::new(move || {
                events.lock().unwrap().push("scan-start");
                registry
                    .create(CreateAgent {
                        cwd: Some(repo.clone()),
                        title: Some("snapshot-test".to_owned()),
                        model: Some("claude".to_owned()),
                        session_id: Some(SESSION.to_owned()),
                        ..CreateAgent::default()
                    })
                    .unwrap();
                events.lock().unwrap().push("scan-complete");
            }));
        }
        let inner = state(base_deps(&fixture, registry, procs.clone()));
        run(async {
            let (status, body) = collect(procs_list(State(inner)).await).await;
            assert_eq!(status, 200);
            assert_eq!(
                serde_json::from_str::<Value>(&body).unwrap(),
                json!({"procs": []})
            );
        });
        assert_eq!(fixture.port.spawns.lock().unwrap().len(), 1);
        // `classify` runs after the scan hook returns; the recorded request
        // below is the same call.
        assert_eq!(*events.lock().unwrap(), vec!["scan-start", "scan-complete"]);
        let request = procs.requests().pop().unwrap();
        assert_eq!(request["live_pids"], json!([1000]));
        assert_eq!(request["live_sessions"], json!([SESSION]));
        assert_eq!(request["host_pid"], json!(4242));
        assert_ne!(request["host_pid"], request["snapshot"]["rust_pid"]);
        assert_eq!(request["repo_root"], json!(fixture.repo()));
    }

    // VERIFY: http-agents-tests-kill-unknown
    /// `procs.test.mjs:85-93`: an unknown pid never reaches the kill backend.
    #[test]
    fn kill_guard_unknown_pid_never_reaches_the_backend() {
        let fixture = Fixture::new();
        let procs = Arc::new(FakeProcs::default());
        procs.classify(json!([]));
        let inner = state(base_deps(&fixture, fixture.registry(), procs.clone()));
        run(async {
            let (status, body) = post(
                |request| procs_kill(State(inner.clone()), request),
                "/api/procs/kill",
                r#"{"pid":999}"#,
            )
            .await;
            assert_eq!(status, 200);
            assert_eq!(
                serde_json::from_str::<Value>(&body).unwrap(),
                json!({"ok": false, "error": "not a tracked process"})
            );
        });
        assert!(procs.kills().is_empty());
        assert!(procs.guards().is_empty());
    }

    // VERIFY: http-agents-tests-kill-duplicate
    /// `procs.test.mjs:95-105`: the first classified row authorizes the kill.
    #[test]
    fn kill_guard_duplicate_pid_uses_the_first_classified_row() {
        let fixture = Fixture::new();
        let procs = Arc::new(FakeProcs::default());
        procs.classify(json!([
            row(4323, "first.exe", "tracked"),
            row(4323, "second.exe", "tracked")
        ]));
        procs.stdout("True");
        let inner = state(base_deps(&fixture, fixture.registry(), procs.clone()));
        run(async {
            let (status, body) = post(
                |request| procs_kill(State(inner.clone()), request),
                "/api/procs/kill",
                r#"{"pid":4323}"#,
            )
            .await;
            assert_eq!(status, 200);
            assert_eq!(
                serde_json::from_str::<Value>(&body).unwrap(),
                json!({"ok": true})
            );
        });
        assert_eq!(
            procs.guards(),
            vec![(4323, "first.exe".to_owned(), "tracked".to_owned(), false)]
        );
        assert_eq!(procs.kills(), vec![4323]);
    }

    // VERIFY: http-agents-tests-kill-daemon
    /// `procs.test.mjs:107-116`: daemon-kind rows are refused.
    #[test]
    fn kill_guard_daemon_rows_are_refused() {
        let fixture = Fixture::new();
        let procs = Arc::new(FakeProcs::default());
        procs.classify(json!([row(4322, "node.exe", "daemon")]));
        let inner = state(base_deps(&fixture, fixture.registry(), procs.clone()));
        run(async {
            let (status, body) = post(
                |request| procs_kill(State(inner.clone()), request),
                "/api/procs/kill",
                r#"{"pid":4322}"#,
            )
            .await;
            assert_eq!(status, 200);
            assert_eq!(
                serde_json::from_str::<Value>(&body).unwrap(),
                json!({"ok": false, "error": "daemon process — cannot stop from here"})
            );
        });
        assert!(procs.kills().is_empty());
        assert_eq!(
            procs.guards(),
            vec![(4322, "node.exe".to_owned(), "daemon".to_owned(), false)]
        );
    }

    // VERIFY: http-agents-tests-kill-toctou
    /// `procs.test.mjs:118-132`: the win32 re-query gates the kill.
    #[test]
    fn kill_guard_win32_requery_gates_the_kill() {
        let fixture = Fixture::new();
        let procs = Arc::new(FakeProcs::default());
        let target = row(4321, "claude.exe", "tracked");
        procs.classify(json!([target.clone()]));
        procs.stdout("True");
        procs.classify(json!([target]));
        procs.stdout("False");
        let inner = state(base_deps(&fixture, fixture.registry(), procs.clone()));
        run(async {
            let (status, body) = post(
                |request| procs_kill(State(inner.clone()), request),
                "/api/procs/kill",
                r#"{"pid":4321}"#,
            )
            .await;
            assert_eq!(status, 200);
            assert_eq!(
                serde_json::from_str::<Value>(&body).unwrap(),
                json!({"ok": true})
            );
            let (status, body) = post(
                |request| procs_kill(State(inner.clone()), request),
                "/api/procs/kill",
                r#"{"pid":4321}"#,
            )
            .await;
            assert_eq!(status, 200);
            assert_eq!(
                serde_json::from_str::<Value>(&body).unwrap(),
                json!({"ok": false, "error": "process changed before kill"})
            );
        });
        assert_eq!(procs.kills(), vec![4321]);
    }

    // VERIFY: http-agents-tests-kill-oneshot
    /// `rust-backend.mjs:823-829` + `procs.mjs:52-54`: a query failure surfaces
    /// as `{ok:false, error}` with the one-shot message.
    #[test]
    fn kill_guard_query_failure_maps_to_the_one_shot_message() {
        let fixture = Fixture::new();
        let procs = Arc::new(FakeProcs::default());
        procs.classify(json!([row(4321, "claude.exe", "tracked")]));
        *procs.fail_kill.lock().unwrap() = Some(json!({
            "oneshot_failure": {
                "ok": false,
                "error": "exit 1",
                "stderr": "ignored\nlast error\n",
                "timed_out": false
            },
            "bin": "powershell.exe",
            "args": ["-NoProfile"],
            "timeout_ms": 0
        }));
        let inner = state(base_deps(&fixture, fixture.registry(), procs));
        run(async {
            let (status, body) = post(
                |request| procs_kill(State(inner.clone()), request),
                "/api/procs/kill",
                r#"{"pid":4321}"#,
            )
            .await;
            assert_eq!(status, 200);
            assert_eq!(
                serde_json::from_str::<Value>(&body).unwrap(),
                json!({"ok": false, "error": "Command failed: powershell.exe -NoProfile\nlast error"})
            );
        });
    }

    // VERIFY: http-agents-tests-kill-bad-pid
    /// `index.mjs:559-560`: `Number.isInteger(Number(pid))` rejects before any
    /// scan, while JSON scalars coerce like JavaScript.
    #[test]
    fn kill_rejects_non_integer_pids_before_scanning() {
        let fixture = Fixture::new();
        let procs = Arc::new(FakeProcs::default());
        let inner = state(base_deps(&fixture, fixture.registry(), procs.clone()));
        run(async {
            for body in [
                r#"{"pid":"abc"}"#,
                r#"{"pid":4.5}"#,
                "{}",
                "[]",
                r#"{"pid":{}}"#,
                r#"{"pid":[1,2]}"#,
                r#"{"pid":"Infinity"}"#,
            ] {
                let (status, payload) = post(
                    |request| procs_kill(State(inner.clone()), request),
                    "/api/procs/kill",
                    body,
                )
                .await;
                assert_eq!(status, 400, "{body}");
                assert_eq!(
                    serde_json::from_str::<Value>(&payload).unwrap(),
                    json!({"ok": false, "error": "bad pid"}),
                    "{body}"
                );
            }
        });
        assert!(procs.requests().is_empty());
    }

    // VERIFY: http-agents-tests-kill-coerced-pid
    /// Scalars `Number()` turns into integers reach the scan, as in Node.
    #[test]
    fn kill_accepts_javascript_coercible_pids() {
        let fixture = Fixture::new();
        let procs = Arc::new(FakeProcs::default());
        for _ in 0..4 {
            procs.classify(json!([]));
        }
        let inner = state(base_deps(&fixture, fixture.registry(), procs.clone()));
        run(async {
            for body in [
                r#"{"pid":false}"#,
                r#"{"pid":null}"#,
                r#"{"pid":[]}"#,
                r#"{"pid":"4321"}"#,
            ] {
                let (status, payload) = post(
                    |request| procs_kill(State(inner.clone()), request),
                    "/api/procs/kill",
                    body,
                )
                .await;
                assert_eq!(status, 200, "{body}");
                assert_eq!(
                    serde_json::from_str::<Value>(&payload).unwrap(),
                    json!({"ok": false, "error": "not a tracked process"}),
                    "{body}"
                );
            }
        });
        assert_eq!(procs.requests().len(), 4);
    }

    // VERIFY: http-agents-tests-js-number
    /// The scalar coercions `Number()` applies, including radix strings.
    #[test]
    fn js_number_coercions_match_javascript() {
        assert_eq!(js_integer(Some(&json!("4321"))), Some(4321));
        assert_eq!(js_integer(Some(&json!(" 0x10 "))), Some(16));
        assert_eq!(js_integer(Some(&json!(""))), Some(0));
        assert_eq!(js_integer(Some(&json!(null))), Some(0));
        assert_eq!(js_integer(Some(&json!(true))), Some(1));
        assert_eq!(js_integer(Some(&json!([]))), Some(0));
        assert_eq!(js_integer(Some(&json!([7]))), Some(7));
        assert_eq!(js_integer(Some(&json!([1, 2]))), None);
        assert_eq!(js_integer(Some(&json!({}))), None);
        assert_eq!(js_integer(Some(&json!("Infinity"))), None);
        assert_eq!(js_integer(Some(&json!(2.5))), None);
        assert_eq!(js_integer(None), None);
        assert!(!js_truthy(None));
        assert!(!js_truthy(Some(&json!(""))));
        assert!(js_truthy(Some(&json!(5))));
    }

    // VERIFY: http-agents-tests-oneshot-message
    /// `rust-backend.mjs:23-34`: exact message shapes.
    #[test]
    fn one_shot_timeout_and_stderr_tail_shapes() {
        assert_eq!(
            oneshot_message(&json!({
                "oneshot_failure": {"timed_out": true, "stderr": ""},
                "bin": "powershell.exe",
                "args": ["-Command", "x"],
                "timeout_ms": 0
            })),
            "Command timed out after 0ms: powershell.exe -Command x"
        );
        assert_eq!(
            oneshot_message(&json!({
                "oneshot_failure": {"timed_out": false, "stderr": "  \r\n"},
                "bin": "powershell.exe",
                "args": [],
                "timeout_ms": 0
            })),
            "Command failed: powershell.exe"
        );
    }

    // VERIFY: http-agents-tests-external-success
    /// `detached-launch.test.mjs:7-29`: a successful spawn removes the row.
    #[test]
    fn external_launch_removes_the_row_after_accepted_spawn() {
        let fixture = Fixture::new();
        let registry = fixture.registry();
        fixture.seed_detached(&registry);
        let (log, spawn) = spawn_log();
        let mut deps = base_deps(&fixture, registry.clone(), Arc::new(FakeProcs::default()));
        deps.spawn_detached = spawn;
        fixture.touch_exec("local/Microsoft/WindowsApps/wt.exe");
        deps.parent_env.insert(
            "LOCALAPPDATA".to_owned(),
            fixture.path("local").to_string_lossy().into_owned(),
        );
        let inner = state(deps);
        let body_json = json!({"id": SESSION}).to_string();
        run(async {
            let (status, body) = post(
                |request| session_external(State(inner.clone()), request),
                "/api/session/external",
                &body_json,
            )
            .await;
            assert_eq!(status, 200);
            assert_eq!(
                serde_json::from_str::<Value>(&body).unwrap(),
                json!({"ok": true})
            );
        });
        let calls = log.calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(
            PathBuf::from(&calls[0].0),
            fixture.path("local/Microsoft/WindowsApps/wt.exe")
        );
        let claude = fixture
            .path("bin/claude.exe")
            .to_string_lossy()
            .into_owned();
        assert_eq!(
            calls[0].1,
            vec![
                "-d".to_owned(),
                fixture.repo(),
                claude,
                "--session-id".to_owned(),
                SESSION.to_owned(),
                "--name".to_owned(),
                "demo".to_owned(),
            ]
        );
        assert_eq!(calls[0].2, Some(fixture.repo()));
        assert!(registry.snapshot().is_empty());
    }

    // VERIFY: http-agents-tests-external-failure
    /// `detached-launch.test.mjs:31-45`: spawn failure keeps the row and maps
    /// the message to a 500.
    #[test]
    fn external_launch_keeps_the_row_on_spawn_failure() {
        let fixture = Fixture::new();
        let registry = fixture.registry();
        fixture.seed_detached(&registry);
        let (log, spawn) = spawn_log();
        *log.fail.lock().unwrap() = Some("launch denied".to_owned());
        let mut deps = base_deps(&fixture, registry.clone(), Arc::new(FakeProcs::default()));
        deps.spawn_detached = spawn;
        deps.parent_env.insert(
            "LOCALAPPDATA".to_owned(),
            fixture.path("local").to_string_lossy().into_owned(),
        );
        fixture.touch_exec("local/Microsoft/WindowsApps/wt.exe");
        let inner = state(deps);
        let body_json = json!({"id": SESSION}).to_string();
        run(async {
            let (status, body) = post(
                |request| session_external(State(inner.clone()), request),
                "/api/session/external",
                &body_json,
            )
            .await;
            assert_eq!(status, 500);
            assert_eq!(
                serde_json::from_str::<Value>(&body).unwrap(),
                json!({
                    "statusCode": 500,
                    "error": "Internal Server Error",
                    "message": "launch denied"
                })
            );
        });
        assert_eq!(registry.snapshot().len(), 1);
    }

    // VERIFY: http-agents-tests-external-guards
    /// `detached-launch.mjs:6` / `agents.mjs:519`, `:528`, `:538`: the exact
    /// 400 bodies before any spawn.
    #[test]
    fn external_launch_rejection_bodies_match_node() {
        let fixture = Fixture::new();
        let registry = fixture.registry();
        fixture.seed_detached(&registry);
        let (log, spawn) = spawn_log();
        let mut deps = base_deps(&fixture, registry, Arc::new(FakeProcs::default()));
        deps.spawn_detached = spawn;
        let inner = state(deps);
        run(async {
            for (body, expected) in [
                (
                    "{}".to_owned(),
                    json!({"ok": false, "error": "id required"}),
                ),
                (
                    r#"{"id":""}"#.to_owned(),
                    json!({"ok": false, "error": "id required"}),
                ),
                (
                    r#"{"id":false}"#.to_owned(),
                    json!({"ok": false, "error": "id required"}),
                ),
                (
                    r#"{"id":5}"#.to_owned(),
                    json!({"ok": false, "error": "no such session"}),
                ),
                (
                    r#"{"id":"nope"}"#.to_owned(),
                    json!({"ok": false, "error": "no such session"}),
                ),
                (
                    json!({"id": SESSION}).to_string(),
                    json!({"ok": false, "error": "wt.exe not found (checked the Store alias path and PATH)"}),
                ),
            ] {
                let (status, payload) = post(
                    |request| session_external(State(inner.clone()), request),
                    "/api/session/external",
                    &body,
                )
                .await;
                assert_eq!(status, 400, "{body}");
                assert_eq!(
                    serde_json::from_str::<Value>(&payload).unwrap(),
                    expected,
                    "{body}"
                );
            }
        });
        assert!(log.calls().is_empty());
    }

    // VERIFY: http-agents-tests-external-darwin
    /// `agents.mjs:531-537` (and `agents.test.mjs:557-573`): osascript wrapping.
    #[test]
    fn external_launch_darwin_wraps_osascript_with_cd_and_exec() {
        let fixture = Fixture::new();
        let registry = fixture.registry();
        fixture.seed_detached(&registry);
        let (log, spawn) = spawn_log();
        let mut deps = base_deps(&fixture, registry, Arc::new(FakeProcs::default()));
        deps.spawn_detached = spawn;
        deps.platform = Platform::Darwin;
        let inner = state(deps);
        let body_json = json!({"id": SESSION}).to_string();
        run(async {
            let (status, body) = post(
                |request| session_external(State(inner.clone()), request),
                "/api/session/external",
                &body_json,
            )
            .await;
            assert_eq!(status, 200);
            assert_eq!(
                serde_json::from_str::<Value>(&body).unwrap(),
                json!({"ok": true})
            );
        });
        let calls = log.calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].0, "osascript");
        assert_eq!(calls[0].1[0], "-e");
        let claude = fixture
            .path("bin/claude.exe")
            .to_string_lossy()
            .into_owned();
        let shell = format!(
            "cd '{}' && exec '{}' '--session-id' '{}' '--name' 'demo'",
            fixture.repo(),
            claude,
            SESSION
        );
        assert_eq!(
            calls[0].1[1],
            format!(
                "tell application \"Terminal\" to do script {}",
                serde_json::to_string(&shell).unwrap()
            )
        );
    }

    // VERIFY: http-agents-tests-external-unsupported
    /// `agents.mjs:538`: other platforms are refused with a 400.
    #[test]
    fn external_launch_other_platform_is_refused() {
        let fixture = Fixture::new();
        let registry = fixture.registry();
        fixture.seed_detached(&registry);
        let mut deps = base_deps(&fixture, registry.clone(), Arc::new(FakeProcs::default()));
        deps.platform = Platform::Other;
        let inner = state(deps);
        let body_json = json!({"id": SESSION}).to_string();
        run(async {
            let (status, body) = post(
                |request| session_external(State(inner.clone()), request),
                "/api/session/external",
                &body_json,
            )
            .await;
            assert_eq!(status, 400);
            assert_eq!(
                serde_json::from_str::<Value>(&body).unwrap(),
                json!({"ok": false, "error": "external terminal open is Windows/macOS only"})
            );
        });
        assert_eq!(registry.snapshot().len(), 1);
    }

    // VERIFY: http-agents-tests-external-build-error
    /// `agents.mjs:521`: a failed `buildSpawn` throws, so the route answers 500.
    #[test]
    fn external_launch_build_failure_is_a_500() {
        let fixture = Fixture::new();
        let registry = fixture.registry();
        fixture.seed_detached(&registry);
        let mut deps = base_deps(&fixture, registry.clone(), Arc::new(FakeProcs::default()));
        deps.bins = Bins::resolve(None, None, None, fixture.spawn_paths());
        let inner = state(deps);
        let body_json = json!({"id": SESSION}).to_string();
        run(async {
            let (status, body) = post(
                |request| session_external(State(inner.clone()), request),
                "/api/session/external",
                &body_json,
            )
            .await;
            assert_eq!(status, 500);
            assert_eq!(
                serde_json::from_str::<Value>(&body).unwrap(),
                json!({
                    "statusCode": 500,
                    "error": "Internal Server Error",
                    "message": "claude not found (CLAUDE_BIN not set in .env)"
                })
            );
        });
        assert_eq!(registry.snapshot().len(), 1);
    }

    // VERIFY: http-agents-tests-wt-resolution
    /// `agents.mjs:498-509`: the Store alias wins, then PATH.
    #[test]
    fn resolve_wt_prefers_the_alias_then_path() {
        let fixture = Fixture::new();
        let alias = fixture.touch_exec("local/Microsoft/WindowsApps/wt.exe");
        let on_path = fixture.touch_exec("bin-path/wt.exe");
        let mut env = BTreeMap::new();
        env.insert(
            "LOCALAPPDATA".to_owned(),
            fixture.path("local").to_string_lossy().into_owned(),
        );
        env.insert(
            "PATH".to_owned(),
            format!(
                "{};{}",
                fixture.path("empty").to_string_lossy(),
                fixture.path("bin-path").to_string_lossy()
            ),
        );
        let normalized = |path: String| Some(PathBuf::from(path));
        assert_eq!(resolve_wt(&env).map(PathBuf::from), normalized(alias));
        env.remove("LOCALAPPDATA");
        assert_eq!(resolve_wt(&env).map(PathBuf::from), normalized(on_path));
        env.remove("PATH");
        assert_eq!(resolve_wt(&env), None);
    }

    // VERIFY: http-agents-tests-agent-stats
    /// `index.mjs:368` + `stats.mjs:321-328`: the entries map gains the live
    /// registry's `busyMs`.
    #[test]
    fn agent_stats_adds_busy_ms_from_the_live_registry() {
        let fixture = Fixture::new();
        let registry = fixture.registry();
        fixture.create_agent(&registry);
        registry.on_pty_event(PtyEvent::Output {
            id: SESSION.to_owned(),
            generation: 1,
            bytes: b"working".to_vec(),
        });
        fixture.clock.fetch_add(2_500, Ordering::SeqCst);
        let inner = state(base_deps(
            &fixture,
            registry,
            Arc::new(FakeProcs::default()),
        ));
        run(async {
            let (status, body) = collect(agent_stats(State(inner)).await).await;
            assert_eq!(status, 200);
            let payload: Value = serde_json::from_str(&body).unwrap();
            let entry = &payload["stats"][SESSION];
            assert_eq!(entry["busyMs"], json!(2_500));
            assert_eq!(entry["exists"], json!(false));
            assert_eq!(entry["turns"], json!(0));
            assert_eq!(entry["costUsd"], Value::Null);
            assert!(entry.get("costSource").is_some());
        });
    }

    // VERIFY: wave4-lifecycle-2
    /// H1 regression: the adapter is handed the home directory, and
    /// `stats.rs` appends `.claude/projects` itself. A call site passing
    /// `<home>/.claude` would look in `<home>/.claude/.claude/projects` and
    /// report `exists:false`, `turns:0`, `tokens:0` for every agent.
    #[test]
    fn agent_stats_reads_sessions_under_the_home_dot_claude() {
        let fixture = Fixture::new();
        let cwd = fixture.repo();
        let projects = fixture
            .path("home")
            .join(".claude/projects")
            .join(crate::stats::encode_cwd(&cwd));
        fs::create_dir_all(&projects).unwrap();
        fs::write(
            projects.join(format!("{SESSION}.jsonl")),
            r#"{"type":"assistant","message":{"model":"claude-sonnet-4-5-20250929","usage":{"input_tokens":1000,"output_tokens":500}}}"#,
        )
        .unwrap();
        let registry = fixture.registry();
        fixture.seed_detached(&registry);
        let inner = state(base_deps(
            &fixture,
            registry,
            Arc::new(FakeProcs::default()),
        ));
        run(async {
            let (status, body) = collect(agent_stats(State(inner)).await).await;
            assert_eq!(status, 200);
            let payload: Value = serde_json::from_str(&body).unwrap();
            let entry = &payload["stats"][SESSION];
            assert_eq!(entry["exists"], json!(true), "{body}");
            assert_eq!(entry["turns"], json!(1), "{body}");
            assert_eq!(entry["tokens"], json!(1_500), "{body}");
        });
    }

    // VERIFY: http-agents-tests-external-launch-direct
    /// The builder itself: unknown ids are rejected before the argv builder.
    #[test]
    fn external_launch_builder_rejects_unknown_ids() {
        let fixture = Fixture::new();
        let inner: Arc<Inner> = state(base_deps(
            &fixture,
            fixture.registry(),
            Arc::new(FakeProcs::default()),
        ));
        match external_launch(&inner, "missing") {
            Err(LaunchError::Rejected(body)) => {
                assert_eq!(body, json!({"ok": false, "error": "no such session"}));
            }
            _ => panic!("unknown ids must be rejected"),
        }
        // The native seam exists and delegates to the shared modules.
        let _native: Arc<dyn ProcBackend> = Arc::new(NativeProcs);
    }
}
