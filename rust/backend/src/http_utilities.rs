//! Utility HTTP routes: `GET /api/skill-scopes`, `POST /api/plans/open`,
//! `GET /api/window-anchor`, `POST /api/window-anchor/poke` and
//! `GET /api/subagents`.
//!
//! Ports `server/index.mjs:541-557` (skill scopes), `:785` with
//! `server/detached-launch.mjs:19-43` (plan folder open), `:707-711` with
//! `server/window-anchor.mjs:221-248` (anchor snapshot + poke) and
//! `server/transcript-routes.mjs:34-42` (live subagent indicators).
//!
//! Everything ambient is injected through [`UtilityDeps`]: the live
//! [`Registry`], the same `Arc<Mutex<window_anchor::Service>>` the runtime and
//! `/ws` share, the transcript service, the scope/plans/projects roots, the
//! anchor state paths, the platform/environment the plan-folder launcher
//! branches on, the detached-spawn seam ([`SpawnDetached`], the same type
//! `http_agents` uses) and the [`AnchorHost`] effect seams.
//!
//! Parity notes:
//! - Skill scopes read the same `skills.rs` listing `readSkillsDir` used, sort
//!   with an ICU collator over the host locale (`localeCompare`), and apply the
//!   200-skill cap only to the projected names.
//! - `POST /plans/open` repeats `plans.mjs:12-24` containment here because that
//!   resolver is private to `http_plans`; the sid grammar and status mapping are
//!   identical.
//! - Window-anchor policy lives in [`window_anchor`]; the effect engine lives in
//!   [`window_anchor_host`] (`submit` applies persistence under the anchor lock,
//!   `apply` drives the host seams), so the poke route and the daemon-side
//!   timers/usage subscription share one code path. `arm_timer`/`clear_timer`
//!   and `run_action` cross into [`AnchorHost`], and an unknown effect is logged
//!   instead of being dropped silently, like `window-anchor.mjs:135-137`.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use axum::body::Body;
use axum::extract::State;
use axum::http::{Request, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use icu_collator::{Collator, options::CollatorOptions};
use icu_locale_core::Locale;
use regex::Regex;
use serde_json::{Value, json};

use crate::agent_registry::Registry;
use crate::agent_wire::{AgentWire, Status};
use crate::http_agents::{Platform, SpawnDetached};
use crate::http_body::parse_raw;
use crate::transcript_service::TranscriptService;
use crate::window_anchor;
use crate::window_anchor_host;

/// `SKILLS_CAP` (`server/skills.mjs:19`): per-scope backstop.
const SKILLS_CAP: usize = 200;
/// `PROVIDERS` (`window-anchor.mjs:10`).
const PROVIDERS: [&str; 2] = ["claude", "codex"];
/// `pokeProvider`'s thrown message (`window-anchor.mjs:227`) → `errStatus` 400.
const PROVIDER_ERROR: &str = "provider must be 'claude' or 'codex'";
/// `createSessionFolderOpenHandler` failure copy (`detached-launch.mjs:40`).
const OPEN_FAILED: &str = "failed to open session folder";
/// Non-Windows hosts (`detached-launch.mjs:31-34`).
const UNSUPPORTED_PLATFORM: &str = "unsupported platform";

// VERIFY: utilities-anchor-host
/// The host seams `window_anchor::Service` effects cross into.
///
/// Everything the module can do itself (state persistence, telemetry, the bus
/// snapshot event) is handled natively; these three need daemon-side ownership.
/// Calls happen off the anchor lock, so an implementation may re-enter
/// [`crate::window_anchor`] freely.
pub trait AnchorHost: Send + Sync {
    /// `arm_timer` / `clear_timer`: the host owns the timer handles and their
    /// generations (`window-anchor.mjs:59-66`).
    fn schedule(&self, effect: &Value);
    /// `run_action` (`window-anchor.mjs:85-109`): run the trivial provider
    /// prompt and return the `window_anchor_action_result` request fields
    /// (`action_id` is copied from the effect, plus `provider`, `outcome`,
    /// `started_at_ms`, `ended_at_ms`, optional `model`/`usage`). `Err` is the
    /// failed-prompt path and becomes `outcome: "error"`.
    fn run_action(&self, effect: &Value) -> Result<Value, String>;
    /// `getUsage({force: true, sources: [provider]})` (`window-anchor.mjs:234`);
    /// `Err` becomes `usage_refresh: "failed"` and the poke proceeds on cached
    /// usage.
    fn refresh_usage(&self, provider: &str) -> Result<Value, String>;
}

// VERIFY: utilities-deps
/// Everything the five routes need from the host. Paths are explicit; nothing
/// is read from the process environment here.
pub struct UtilityDeps {
    /// The live agent registry: subagent rows and the anchor bus come from it.
    pub registry: Arc<Registry>,
    /// The exact service the runtime and `/ws` share; `init` already ran.
    pub anchor: Arc<Mutex<window_anchor::Service>>,
    /// Transcript discovery for `/api/subagents`.
    pub transcript: Arc<TranscriptService>,
    /// `SING_SCOPE_ROOT` (`agents.mjs:24`); `None` disables the picker source.
    pub scope_root: Option<PathBuf>,
    /// `SING_PLANS_ROOT`; `None` makes `/api/plans/open` answer `plans disabled`.
    pub plans_root: Option<PathBuf>,
    /// `~/.claude/projects` — `sessions.mjs:10` `DEFAULT_ROOT`, passed to every
    /// `subagentsFor` call.
    pub claude_projects_root: PathBuf,
    /// The app state dir holding `window-anchor.json`.
    pub state_dir: PathBuf,
    /// `USAGE_SKILL_STATE` holding `window-anchor-runs.jsonl`.
    pub usage_state: PathBuf,
    /// `process.platform` for the plan-folder launcher.
    pub platform: Platform,
    /// `process.env.SystemRoot || 'C:\\Windows'`.
    pub system_root: PathBuf,
    /// `rustBackend.spawnDetached` (`detached-launch.mjs:36`).
    pub spawn_detached: SpawnDetached,
    /// Effect seams for the anchor routes.
    pub anchor_host: Arc<dyn AnchorHost>,
}

struct Inner {
    registry: Arc<Registry>,
    core: Arc<window_anchor_host::AnchorCore>,
    transcript: Arc<TranscriptService>,
    scope_root: Option<PathBuf>,
    plans_root: Option<PathBuf>,
    claude_projects_root: PathBuf,
    platform: Platform,
    system_root: PathBuf,
    spawn_detached: SpawnDetached,
    anchor_host: Arc<dyn AnchorHost>,
}

// VERIFY: utilities-router-injection
/// Mounts the five utility routes. The outer server layer owns auth, origin and
/// token checks.
pub fn router(deps: UtilityDeps) -> Router {
    Router::new()
        .route("/api/skill-scopes", get(skill_scopes))
        .route("/api/plans/open", post(plans_open))
        .route("/api/window-anchor", get(window_anchor_get))
        .route("/api/window-anchor/poke", post(window_anchor_poke))
        .route("/api/subagents", get(subagents))
        .with_state(state(deps))
}

fn state(deps: UtilityDeps) -> Arc<Inner> {
    let core = Arc::new(window_anchor_host::AnchorCore {
        anchor: deps.anchor,
        bus: deps.registry.bus().clone(),
        state_path: deps.state_dir.join("window-anchor.json"),
        telemetry_path: deps.usage_state.join("window-anchor-runs.jsonl"),
    });
    Arc::new(Inner {
        registry: deps.registry,
        core,
        transcript: deps.transcript,
        scope_root: deps.scope_root,
        plans_root: deps.plans_root,
        claude_projects_root: deps.claude_projects_root,
        platform: deps.platform,
        system_root: deps.system_root,
        spawn_detached: deps.spawn_detached,
        anchor_host: deps.anchor_host,
    })
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0)
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

// VERIFY: utilities-skill-scopes
/// `GET /api/skill-scopes` (`server/index.mjs:541-557`).
async fn skill_scopes(State(inner): State<Arc<Inner>>) -> Response {
    match tokio::task::spawn_blocking(move || skill_scopes_payload(&inner)).await {
        Ok(Ok(value)) => Json(value).into_response(),
        Ok(Err(())) => internal_error("Internal Server Error"),
        Err(_) => internal_error("Internal Server Error"),
    }
}

fn skill_scopes_payload(inner: &Inner) -> Result<Value, ()> {
    let Some(root) = inner.scope_root.as_ref() else {
        return Ok(json!({ "scopes": [], "skillsByScope": {} }));
    };
    let collator = collator()?;
    let mut scopes: Vec<String> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(root) {
        for entry in entries.flatten() {
            // `d.isDirectory()` on a `Dirent` is false for a symlink, and a
            // per-entry throw is swallowed (`index.mjs:548`).
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            let name = entry.file_name().to_string_lossy().into_owned();
            if kind.is_dir() && name != "common" {
                scopes.push(name);
            }
        }
    }
    scopes.sort_by(|a, b| collator.compare(a, b));
    let mut skills_by_scope = serde_json::Map::new();
    for scope in &scopes {
        let dir = root.join(scope).join(".claude").join("skills");
        skills_by_scope.insert(scope.clone(), json!(scope_skill_names(&dir, &collator)));
    }
    Ok(json!({ "scopes": scopes, "skillsByScope": skills_by_scope }))
}

/// `readSkillsDir(dir)?.skills.map(k => k.name)` (`skills.mjs:112-116`): the
/// first listed scope's names, sorted and capped like `listSkillsOn`.
fn scope_skill_names(
    dir: &Path,
    collator: &icu_collator::CollatorBorrowed<'static>,
) -> Vec<String> {
    let payload = crate::skills::list(&json!(dir.to_string_lossy().into_owned()));
    let Some(scope) = payload["scopes"]
        .as_array()
        .and_then(|scopes| scopes.first())
    else {
        return Vec::new();
    };
    let mut names: Vec<String> = scope["skills"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|skill| skill["name"].as_str().map(str::to_owned))
        .collect();
    names.sort_by(|a, b| collator.compare(a, b));
    names.truncate(SKILLS_CAP);
    names
}

fn collator() -> Result<icu_collator::CollatorBorrowed<'static>, ()> {
    let locale: Locale = crate::memory_collation::system_locale()
        .parse()
        .map_err(|_| ())?;
    Collator::try_new(locale.into(), CollatorOptions::default()).map_err(|_| ())
}

// VERIFY: utilities-plans-open
/// `POST /api/plans/open` (`server/index.mjs:785` →
/// `createSessionFolderOpenHandler`, `server/detached-launch.mjs:19-43`).
async fn plans_open(State(inner): State<Arc<Inner>>, request: Request<Body>) -> Response {
    let body = match parse_raw(request).await {
        Ok(body) => body,
        Err(response) => return response,
    };
    let sid = body
        .value
        .get("sid")
        .and_then(Value::as_str)
        .map(str::to_owned);
    match tokio::task::spawn_blocking(move || open_payload(&inner, sid.as_deref())).await {
        Ok(response) => response,
        Err(_) => internal_error("Internal Server Error"),
    }
}

fn open_payload(inner: &Inner, sid: Option<&str>) -> Response {
    let dir = match resolve_session_directory(inner.plans_root.as_deref(), sid) {
        Ok(dir) => dir,
        Err(error) => {
            let status = if error == "bad sid" {
                StatusCode::BAD_REQUEST
            } else {
                StatusCode::NOT_FOUND
            };
            return (status, Json(json!({ "ok": false, "error": error }))).into_response();
        }
    };
    if inner.platform != Platform::Win32 {
        return (
            StatusCode::NOT_IMPLEMENTED,
            Json(json!({ "ok": false, "error": UNSUPPORTED_PLATFORM })),
        )
            .into_response();
    }
    let launcher = inner.system_root.join("explorer.exe");
    let launcher = launcher.to_string_lossy().into_owned();
    let args = vec![dir.to_string_lossy().into_owned()];
    match (inner.spawn_detached)(&launcher, &args, None) {
        Ok(()) => Json(json!({ "ok": true })).into_response(),
        Err(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "ok": false, "error": OPEN_FAILED })),
        )
            .into_response(),
    }
}

/// `resolveSessionDirectory` (`server/plans.mjs:12-24`). The realpath
/// containment check is the security boundary: the sid is only ever a component
/// below the configured root, and a session that canonicalizes elsewhere (for
/// example through a symlink) is `bad sid`.
fn resolve_session_directory(
    root: Option<&Path>,
    sid: Option<&str>,
) -> Result<PathBuf, &'static str> {
    let Some(root) = root else {
        return Err("plans disabled");
    };
    let Some(sid) = sid else {
        return Err("bad sid");
    };
    if !sid_re().is_match(sid) {
        return Err("bad sid");
    }
    let root = std::fs::canonicalize(root).map_err(|_| "not found")?;
    let dir = std::fs::canonicalize(root.join(sid)).map_err(|_| "not found")?;
    // Component-wise starts_with rejects sibling prefixes such as `<root>-evil`
    // and any symlink that canonicalizes outside the root.
    if !dir.starts_with(&root) {
        return Err("bad sid");
    }
    if !dir.is_dir() {
        return Err("not found");
    }
    Ok(dir)
}

fn sid_re() -> &'static Regex {
    static RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    // `SID_RE = /^[0-9a-f-]{8,64}$/i` (`plans.mjs:10`).
    RE.get_or_init(|| Regex::new(r"(?i)^[0-9a-f-]{8,64}$").expect("constant regex is valid"))
}

// VERIFY: utilities-window-anchor
/// `GET /api/window-anchor` (`server/index.mjs:707` → `snapshotWindowAnchor`,
/// `window-anchor.mjs:221-224`): the full state, bare.
async fn window_anchor_get(State(inner): State<Arc<Inner>>) -> Response {
    match tokio::task::spawn_blocking(move || {
        let response = window_anchor_host::submit(
            &inner.core,
            "window_anchor_snapshot",
            &json!({ "now_ms": now_ms() }),
        );
        Json(response["snapshot"].clone()).into_response()
    })
    .await
    {
        Ok(response) => response,
        Err(_) => internal_error("Internal Server Error"),
    }
}

/// `POST /api/window-anchor/poke` (`server/index.mjs:708-711` →
/// `pokeProvider`, `window-anchor.mjs:226-248`).
async fn window_anchor_poke(State(inner): State<Arc<Inner>>, request: Request<Body>) -> Response {
    let body = match parse_raw(request).await {
        Ok(body) => body,
        Err(response) => return response,
    };
    let provider = body.value.get("provider").and_then(Value::as_str);
    let force = body.value.get("force") == Some(&Value::Bool(true));
    // `pokeProvider` validates before it refreshes usage; the throw maps to 400
    // through `errStatus` (`index.mjs:292`, `:710`).
    let Some(provider) = provider.filter(|provider| PROVIDERS.contains(provider)) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "ok": false, "error": PROVIDER_ERROR })),
        )
            .into_response();
    };
    let provider = provider.to_owned();
    match tokio::task::spawn_blocking(move || poke_payload(&inner, &provider, force)).await {
        Ok(value) => Json(value).into_response(),
        Err(_) => internal_error("Internal Server Error"),
    }
}

fn poke_payload(inner: &Inner, provider: &str, force: bool) -> Value {
    let started_at_ms = now_ms();
    let mut usage_refresh = "not_requested";
    let mut usage = None;
    if !force {
        usage_refresh = "ok";
        match inner.anchor_host.refresh_usage(provider) {
            Ok(value) => usage = Some(value),
            Err(_) => usage_refresh = "failed",
        }
    }
    let mut request = json!({
        "provider": provider,
        "force": force,
        "usage_refresh": usage_refresh,
        "started_at_ms": started_at_ms,
        "now_ms": now_ms(),
    });
    if let Some(usage) = usage {
        request["usage"] = usage;
    }
    let response = window_anchor_host::submit(&inner.core, "window_anchor_poke", &request);
    window_anchor_host::apply(&inner.core, &inner.anchor_host, &response["effects"], true);
    let snapshot = window_anchor_host::submit(
        &inner.core,
        "window_anchor_snapshot",
        &json!({ "now_ms": now_ms() }),
    );
    // `finalSnapshot[provider]?.lastResult ?? response.result?.result`
    let last = snapshot["snapshot"][provider]["lastResult"].clone();
    let result = if last.is_null() {
        response["result"]["result"].clone()
    } else {
        last
    };
    json!({ "ok": true, "provider": provider, "result": result })
}

// VERIFY: utilities-subagents
/// `GET /api/subagents` (`server/transcript-routes.mjs:34-42`).
async fn subagents(State(inner): State<Arc<Inner>>) -> Response {
    match tokio::task::spawn_blocking(move || {
        let agents = inner.registry.snapshot();
        let registry = inner.registry.clone();
        subagents_payload(&inner, &agents, |id| registry.is_live(id), now_ms() as u64)
    })
    .await
    {
        Ok(Ok(value)) => Json(value).into_response(),
        Ok(Err(message)) => internal_error(&message),
        Err(_) => internal_error("Internal Server Error"),
    }
}

/// The route body as a pure function over a registry snapshot: only
/// `running`/`idle`/`starting` rows are considered, `is_live` is applied to each
/// child's `agentId` exactly like `updateRunning`, and empty lists are omitted.
fn subagents_payload(
    inner: &Inner,
    agents: &[AgentWire],
    is_live: impl Fn(&str) -> bool,
    now: u64,
) -> Result<Value, String> {
    let root = inner.claude_projects_root.to_string_lossy().into_owned();
    let mut out = serde_json::Map::new();
    for agent in agents {
        if !matches!(
            agent.status,
            Status::Running | Status::Idle | Status::Starting
        ) {
            continue;
        }
        let Some(cwd) = agent.cwd.as_deref().filter(|cwd| !cwd.is_empty()) else {
            continue;
        };
        let mut rows = inner
            .transcript
            .subagents(cwd, &agent.id, Some(root.as_str()), now, &[])
            .map_err(|error| error.to_string())?;
        for row in &mut rows {
            row.running = is_live(&row.agent_id) || row.running;
        }
        if rows.is_empty() {
            continue;
        }
        out.insert(
            agent.id.clone(),
            serde_json::to_value(rows).map_err(|error| error.to_string())?,
        );
    }
    Ok(json!({ "subagents": out }))
}

#[cfg(test)]
mod tests {
    use super::{
        AnchorHost, OPEN_FAILED, PROVIDER_ERROR, UNSUPPORTED_PLATFORM, UtilityDeps, router, state,
    };
    use crate::agent_registry::{PtyPort, Registry, RegistryConfig, system_clock};
    use crate::agent_spawn::{Bins, LaunchSpec, SpawnPaths};
    use crate::agent_wire::{AgentWire, Status};
    use crate::bus::{Bus, BusEvent};
    use crate::http_agents::Platform;
    use crate::transcript_service::{Inputs, TranscriptService};
    use crate::window_anchor;
    use axum::Router;
    use serde_json::{Value, json};
    use std::net::{Ipv4Addr, SocketAddr};
    use std::path::PathBuf;
    use std::sync::{Arc, Mutex};
    use std::time::{SystemTime, UNIX_EPOCH};
    use tokio::sync::oneshot;
    use tokio::task::JoinHandle;

    struct Fixture(PathBuf);

    impl Fixture {
        fn new(name: &str) -> Self {
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let dir = std::env::temp_dir().join(format!(
                "singularity-http-utilities-{name}-{}-{nanos}",
                std::process::id()
            ));
            for rel in [
                "state",
                "usage",
                "home",
                "cache",
                "codex-home",
                "projects",
                "windows",
            ] {
                std::fs::create_dir_all(dir.join(rel)).unwrap();
            }
            Self(dir)
        }

        fn path(&self, rel: &str) -> PathBuf {
            self.0.join(rel)
        }

        fn write(&self, rel: &str, contents: &str) -> PathBuf {
            let path = self.path(rel);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, contents).unwrap();
            path
        }

        fn mkdir(&self, rel: &str) -> PathBuf {
            let path = self.path(rel);
            std::fs::create_dir_all(&path).unwrap();
            path
        }

        fn registry(&self) -> Arc<Registry> {
            Arc::new(Registry::new(
                Bus::new(),
                Arc::new(FakePort),
                RegistryConfig {
                    state_file: self.path("state/agents.json"),
                    bins: Bins::resolve(
                        None,
                        None,
                        None,
                        SpawnPaths {
                            home: self.path("home"),
                            scope_root: None,
                            cache_dir: self.path("cache"),
                            codex_home: self.path("codex-home"),
                            models_state: self.path("state/models.json"),
                        },
                    ),
                    parent_env: Default::default(),
                    clock: system_clock(),
                },
            ))
        }

        fn transcript(&self) -> Arc<TranscriptService> {
            Arc::new(TranscriptService::new(Inputs {
                state_dir: self.path("state"),
                claude_home: self.path("home"),
                codex_home: self.path("codex-home"),
                model_catalog: Vec::new(),
            }))
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    struct FakePort;

    impl PtyPort for FakePort {
        fn spawn(&self, _id: &str, _generation: u64, _spec: LaunchSpec) -> Result<u32, String> {
            Ok(4242)
        }
        fn write(&self, _id: &str, _data: &[u8]) -> Result<(), String> {
            Ok(())
        }
        fn resize(&self, _id: &str, _cols: u16, _rows: u16) -> Result<(), String> {
            Ok(())
        }
        fn kill(&self, _id: &str) -> Result<(), String> {
            Ok(())
        }
    }

    type Opener = Arc<Mutex<Vec<(String, Vec<String>, Option<String>)>>>;

    fn opener(fail: bool) -> (Opener, super::SpawnDetached) {
        let calls: Opener = Arc::new(Mutex::new(Vec::new()));
        let recorded = calls.clone();
        let spawn: super::SpawnDetached = Arc::new(move |launcher, args, cwd| {
            recorded.lock().unwrap().push((
                launcher.to_owned(),
                args.to_vec(),
                cwd.map(str::to_owned),
            ));
            if fail {
                Err("explorer failed".to_owned())
            } else {
                Ok(())
            }
        });
        (calls, spawn)
    }

    #[derive(Default)]
    struct FakeAnchor {
        refreshed: Mutex<Vec<String>>,
        refresh_fails: bool,
        scheduled: Mutex<Vec<Value>>,
        actions: Mutex<Vec<Value>>,
    }

    impl AnchorHost for FakeAnchor {
        fn schedule(&self, effect: &Value) {
            self.scheduled.lock().unwrap().push(effect.clone());
        }
        fn run_action(&self, effect: &Value) -> Result<Value, String> {
            self.actions.lock().unwrap().push(effect.clone());
            Ok(json!({
                "action_id": effect["action_id"],
                "provider": effect["provider"],
                "outcome": "ok",
                "started_at_ms": 1_000,
                "ended_at_ms": 1_001,
                "model": "haiku",
                "usage": { "input_tokens": 3 },
            }))
        }
        fn refresh_usage(&self, provider: &str) -> Result<Value, String> {
            self.refreshed.lock().unwrap().push(provider.to_owned());
            if self.refresh_fails {
                Err("refresh failed".to_owned())
            } else {
                Ok(json!({ "claude": { "ok": false }, "codex": { "ok": false } }))
            }
        }
    }

    fn base_deps(
        fixture: &Fixture,
        anchor: Arc<Mutex<window_anchor::Service>>,
        host: Arc<FakeAnchor>,
        spawn_detached: super::SpawnDetached,
    ) -> UtilityDeps {
        UtilityDeps {
            registry: fixture.registry(),
            anchor,
            transcript: fixture.transcript(),
            scope_root: None,
            plans_root: None,
            claude_projects_root: fixture.path("projects"),
            state_dir: fixture.path("state"),
            usage_state: fixture.path("usage"),
            platform: Platform::Win32,
            system_root: fixture.path("windows"),
            spawn_detached,
            anchor_host: host,
        }
    }

    fn run<F: std::future::Future>(future: F) -> F::Output {
        tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(future)
    }

    async fn start(
        routes: Router,
    ) -> (
        SocketAddr,
        oneshot::Sender<()>,
        JoinHandle<std::io::Result<()>>,
    ) {
        let listener = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let address = listener.local_addr().unwrap();
        assert!(address.ip().is_loopback());
        let (stop, stopped) = oneshot::channel::<()>();
        let server = tokio::spawn(async move {
            axum::serve(listener, routes)
                .with_graceful_shutdown(async move {
                    let _ = stopped.await;
                })
                .await
        });
        (address, stop, server)
    }

    async fn get_json(address: SocketAddr, path: &str) -> (u16, Value) {
        let response = reqwest::get(format!("http://{address}{path}"))
            .await
            .unwrap();
        let status = response.status().as_u16();
        let body = response.text().await.unwrap();
        (status, serde_json::from_str(&body).unwrap())
    }

    async fn post_json(address: SocketAddr, path: &str, body: Value) -> (u16, Value) {
        let response = reqwest::Client::new()
            .post(format!("http://{address}{path}"))
            .json(&body)
            .send()
            .await
            .unwrap();
        let status = response.status().as_u16();
        let text = response.text().await.unwrap();
        (status, serde_json::from_str(&text).unwrap())
    }

    #[test]
    fn skill_scopes_lists_sorted_scopes_with_skill_names_and_excludes_common() {
        let fixture = Fixture::new("skill-scopes");
        fixture.write(
            "scopes/beta/.claude/skills/keep/SKILL.md",
            "---\nname: keep\n---\n",
        );
        fixture.write(
            "scopes/alpha/.claude/skills/skill-b/SKILL.md",
            "---\nname: skill-b\n---\n",
        );
        fixture.write(
            "scopes/alpha/.claude/skills/skill-a/SKILL.md",
            "---\nname: skill-a\n---\n",
        );
        fixture.mkdir("scopes/common/.claude/skills/hidden");
        fixture.write("scopes/common/.claude/skills/hidden/SKILL.md", "hidden");
        let (_, spawn) = opener(false);
        let mut deps = base_deps(
            &fixture,
            Arc::new(Mutex::new(window_anchor::Service::default())),
            Arc::new(FakeAnchor::default()),
            spawn,
        );
        deps.scope_root = Some(fixture.path("scopes"));
        run(async {
            let (address, stop, server) = start(router(deps)).await;
            let (status, body) = get_json(address, "/api/skill-scopes").await;
            assert_eq!(status, 200);
            assert_eq!(body["scopes"], json!(["alpha", "beta"]));
            assert_eq!(
                body["skillsByScope"]["alpha"],
                json!(["skill-a", "skill-b"])
            );
            assert_eq!(body["skillsByScope"]["beta"], json!(["keep"]));
            assert_eq!(body["skillsByScope"].get("common"), None);
            stop.send(()).unwrap();
            server.await.unwrap().unwrap();
        });
    }

    #[test]
    fn skill_scopes_without_a_root_answers_the_empty_document() {
        let fixture = Fixture::new("skill-scopes-unset");
        let (_, spawn) = opener(false);
        let deps = base_deps(
            &fixture,
            Arc::new(Mutex::new(window_anchor::Service::default())),
            Arc::new(FakeAnchor::default()),
            spawn,
        );
        run(async {
            let (address, stop, server) = start(router(deps)).await;
            assert_eq!(
                get_json(address, "/api/skill-scopes").await,
                (200, json!({ "scopes": [], "skillsByScope": {} }))
            );
            stop.send(()).unwrap();
            server.await.unwrap().unwrap();
        });
    }

    const SID: &str = "aaaaaaaa-1111-4111-8111-111111111111";

    #[test]
    fn plans_open_uses_the_injected_opener_for_a_contained_session() {
        let fixture = Fixture::new("plans-open");
        fixture.mkdir(&format!("plans/{SID}"));
        let (calls, spawn) = opener(false);
        let mut deps = base_deps(
            &fixture,
            Arc::new(Mutex::new(window_anchor::Service::default())),
            Arc::new(FakeAnchor::default()),
            spawn,
        );
        deps.plans_root = Some(fixture.path("plans"));
        run(async {
            let (address, stop, server) = start(router(deps)).await;
            let (status, body) = post_json(address, "/api/plans/open", json!({ "sid": SID })).await;
            assert_eq!((status, body), (200, json!({ "ok": true })));
            let calls = calls.lock().unwrap();
            assert_eq!(calls.len(), 1);
            assert!(calls[0].0.ends_with("explorer.exe"), "{}", calls[0].0);
            let expected = std::fs::canonicalize(fixture.path(&format!("plans/{SID}"))).unwrap();
            assert_eq!(calls[0].1, vec![expected.to_string_lossy().into_owned()]);
            assert_eq!(calls[0].2, None);
            stop.send(()).unwrap();
            server.await.unwrap().unwrap();
        });
    }

    #[test]
    fn plans_open_reports_exact_failures_without_launching() {
        let fixture = Fixture::new("plans-open-errors");
        fixture.mkdir(&format!("plans/{SID}"));
        let (calls, spawn) = opener(false);
        let mut deps = base_deps(
            &fixture,
            Arc::new(Mutex::new(window_anchor::Service::default())),
            Arc::new(FakeAnchor::default()),
            spawn,
        );
        deps.plans_root = Some(fixture.path("plans"));
        let (_, failing_spawn) = opener(true);
        let mut failing = base_deps(
            &fixture,
            Arc::new(Mutex::new(window_anchor::Service::default())),
            Arc::new(FakeAnchor::default()),
            failing_spawn,
        );
        failing.plans_root = Some(fixture.path("plans"));
        failing.platform = Platform::Other;
        run(async {
            let (address, stop, server) = start(router(deps)).await;
            for body in [json!({ "sid": "abc" }), json!({}), json!({ "sid": 7 })] {
                assert_eq!(
                    post_json(address, "/api/plans/open", body.clone()).await,
                    (400, json!({ "ok": false, "error": "bad sid" })),
                    "{body}"
                );
            }
            assert_eq!(
                post_json(
                    address,
                    "/api/plans/open",
                    json!({ "sid": "bbbbbbbb-2222-4222-8222-222222222222" })
                )
                .await,
                (404, json!({ "ok": false, "error": "not found" }))
            );
            assert!(calls.lock().unwrap().is_empty());
            stop.send(()).unwrap();
            server.await.unwrap().unwrap();

            let (unsupported_address, unsupported_stop, unsupported) = start(router(failing)).await;
            assert_eq!(
                post_json(
                    unsupported_address,
                    "/api/plans/open",
                    json!({ "sid": SID })
                )
                .await,
                (501, json!({ "ok": false, "error": UNSUPPORTED_PLATFORM }))
            );
            unsupported_stop.send(()).unwrap();
            unsupported.await.unwrap().unwrap();
        });
    }

    #[test]
    fn plans_open_reports_a_failed_launch_and_a_disabled_root() {
        let fixture = Fixture::new("plans-open-failures");
        fixture.mkdir(&format!("plans/{SID}"));
        let (_, failing_spawn) = opener(true);
        let mut failing = base_deps(
            &fixture,
            Arc::new(Mutex::new(window_anchor::Service::default())),
            Arc::new(FakeAnchor::default()),
            failing_spawn,
        );
        failing.plans_root = Some(fixture.path("plans"));
        let (_, spawn) = opener(false);
        let disabled = base_deps(
            &fixture,
            Arc::new(Mutex::new(window_anchor::Service::default())),
            Arc::new(FakeAnchor::default()),
            spawn,
        );
        run(async {
            let (address, stop, server) = start(router(failing)).await;
            assert_eq!(
                post_json(address, "/api/plans/open", json!({ "sid": SID })).await,
                (500, json!({ "ok": false, "error": OPEN_FAILED }))
            );
            stop.send(()).unwrap();
            server.await.unwrap().unwrap();

            let (disabled_address, disabled_stop, disabled_server) = start(router(disabled)).await;
            assert_eq!(
                post_json(disabled_address, "/api/plans/open", json!({ "sid": SID })).await,
                (404, json!({ "ok": false, "error": "plans disabled" }))
            );
            disabled_stop.send(()).unwrap();
            disabled_server.await.unwrap().unwrap();
        });
    }

    fn anchor_deps(
        fixture: &Fixture,
        host: Arc<FakeAnchor>,
        anchor: Arc<Mutex<window_anchor::Service>>,
    ) -> (UtilityDeps, Arc<Registry>) {
        let (_, spawn) = opener(false);
        let registry = fixture.registry();
        let mut deps = base_deps(fixture, anchor, host, spawn);
        deps.registry = registry.clone();
        (deps, registry)
    }

    #[test]
    fn window_anchor_snapshot_is_bare_and_poke_applies_native_effects() {
        let fixture = Fixture::new("window-anchor");
        let host = Arc::new(FakeAnchor::default());
        let (deps, registry) = anchor_deps(
            &fixture,
            host.clone(),
            Arc::new(Mutex::new(window_anchor::Service::default())),
        );
        let seen = Arc::new(Mutex::new(Vec::new()));
        let recorder = seen.clone();
        registry.bus().subscribe(Arc::new(move |event| {
            if let BusEvent::WindowAnchor(snapshot) = event {
                recorder.lock().unwrap().push(snapshot.clone());
            }
        }));
        run(async {
            let (address, stop, server) = start(router(deps)).await;
            let (status, body) = get_json(address, "/api/window-anchor").await;
            assert_eq!(status, 200);
            assert_eq!(body["claude"]["enabled"], false);
            assert_eq!(body["codex"]["nextAnchorAt"], Value::Null);

            let (status, body) = post_json(
                address,
                "/api/window-anchor/poke",
                json!({ "provider": "claude" }),
            )
            .await;
            assert_eq!(status, 200);
            assert_eq!(
                body,
                json!({ "ok": true, "provider": "claude", "result": "Ok" })
            );
            assert_eq!(host.refreshed.lock().unwrap().as_slice(), ["claude"]);
            assert_eq!(host.actions.lock().unwrap().len(), 1);

            let state = std::fs::read_to_string(fixture.path("state/window-anchor.json")).unwrap();
            assert!(state.contains("\"lastResult\": \"Ok\""), "{state}");
            let telemetry =
                std::fs::read_to_string(fixture.path("usage/window-anchor-runs.jsonl")).unwrap();
            assert!(telemetry.contains("\"result\":\"Ok\""), "{telemetry}");
            let emitted = seen.lock().unwrap();
            assert_eq!(emitted.len(), 1);
            assert_eq!(emitted[0]["claude"]["lastResult"], "Ok");
            stop.send(()).unwrap();
            server.await.unwrap().unwrap();
        });
    }

    #[test]
    fn window_anchor_poke_rejects_an_unknown_provider_and_tolerates_a_failed_refresh() {
        let fixture = Fixture::new("window-anchor-poke");
        let failing = Arc::new(FakeAnchor {
            refresh_fails: true,
            ..FakeAnchor::default()
        });
        let (deps, _) = anchor_deps(
            &fixture,
            failing.clone(),
            Arc::new(Mutex::new(window_anchor::Service::default())),
        );
        run(async {
            let (address, stop, server) = start(router(deps)).await;
            for body in [json!({ "provider": "haiku" }), json!({})] {
                assert_eq!(
                    post_json(address, "/api/window-anchor/poke", body.clone()).await,
                    (400, json!({ "ok": false, "error": PROVIDER_ERROR })),
                    "{body}"
                );
            }
            assert_eq!(
                post_json(
                    address,
                    "/api/window-anchor/poke",
                    json!({ "provider": "codex", "force": "yes" })
                )
                .await,
                (
                    200,
                    json!({ "ok": true, "provider": "codex", "result": "Ok" })
                )
            );
            assert_eq!(failing.refreshed.lock().unwrap().as_slice(), ["codex"]);
            stop.send(()).unwrap();
            server.await.unwrap().unwrap();
        });
    }

    #[test]
    fn subagents_route_answers_an_empty_map_without_live_agents() {
        let fixture = Fixture::new("subagents-empty");
        let (_, spawn) = opener(false);
        let deps = base_deps(
            &fixture,
            Arc::new(Mutex::new(window_anchor::Service::default())),
            Arc::new(FakeAnchor::default()),
            spawn,
        );
        run(async {
            let (address, stop, server) = start(router(deps)).await;
            assert_eq!(
                get_json(address, "/api/subagents").await,
                (200, json!({ "subagents": {} }))
            );
            stop.send(()).unwrap();
            server.await.unwrap().unwrap();
        });
    }

    fn agent(id: &str, cwd: Option<&str>, status: Status) -> AgentWire {
        AgentWire {
            id: id.to_owned(),
            cwd: cwd.map(str::to_owned),
            status,
            ..AgentWire::default()
        }
    }

    #[test]
    fn subagents_payload_keeps_only_active_rows_with_non_empty_lists() {
        let fixture = Fixture::new("subagents-payload");
        // `subagentsFor` resolves `<root>/<encode_cwd(cwd)>/<id>/subagents`.
        fixture.write(
            "projects/C--work/agent-running/subagents/child-1.jsonl",
            "{\"type\":\"user\",\"message\":{\"content\":\"child\"}}\n",
        );
        fixture.write(
            "projects/C--work/agent-running/subagents/child-1.meta.json",
            "{\"agentType\":\"worker\",\"description\":\"child\"}",
        );
        fixture.mkdir("projects/C--work/agent-idle");
        let (_, spawn) = opener(false);
        let deps = base_deps(
            &fixture,
            Arc::new(Mutex::new(window_anchor::Service::default())),
            Arc::new(FakeAnchor::default()),
            spawn,
        );
        let inner = state(deps);
        let agents = vec![
            agent("agent-running", Some("C:\\work"), Status::Running),
            agent("agent-idle", Some("C:\\work"), Status::Idle),
            agent("agent-detached", Some("C:\\work"), Status::Detached),
            agent("agent-starting", None, Status::Starting),
        ];
        let payload = super::subagents_payload(&inner, &agents, |id| id == "child-1", u64::MAX)
            .expect("subagents payload");
        let map = payload["subagents"].as_object().unwrap();
        assert_eq!(map.keys().collect::<Vec<_>>(), vec!["agent-running"]);
        let rows = map["agent-running"].as_array().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["id"], "agent-running/subagents/child-1");
        assert_eq!(rows[0]["agentId"], "child-1");
        assert_eq!(rows[0]["running"], true);
        assert_eq!(rows[0]["title"], "worker: child");
    }
}
