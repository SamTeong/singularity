//! Native HTTP routes for provider usage: `GET /api/usage`,
//! `GET /api/usage/history` and `POST /api/usage/ollama/connect`.
//!
//! Port of `server/index.mjs:349-353,378-387` over `server/usage.mjs` (the
//! cached, per-source pull with its network floor and forced refresh),
//! `server/usage-history.mjs` (provider/window validation plus the injected
//! history roots) and `connectOllamaUsage`. The transport adapters live in
//! `claude_usage`, `codex_usage`, `ollama_browser` and `usage_snapshot`; this
//! module only orchestrates them, so no Node bridge and no Playwright are
//! involved.
//!
//! Contracts preserved from Node:
//!   * `?force=1` bypasses the 60s per-source network floor; `force` repeated or
//!     any other value is not forced (`req.query.force === '1'`).
//!   * repeated `?source=` filters which lanes may touch the network; unknown or
//!     absent values mean all three lanes, and the response always carries
//!     `ollama`, `claude`, `codex` in that order.
//!   * a successful reading is cached per source; a failure never replaces a
//!     good reading (it is served as `stale` with the newer error attached).
//!   * `BusEvent::Usage` is emitted on every forced call and on any other call
//!     whose document differs from the last one pushed.
//!   * `/api/usage/history` validates `provider`/`window` first and answers
//!     `400 {"ok":false,"error":"provider must be one of ...; window one of ..."}`,
//!     defaulting `window` to `5h`.
//!   * `POST /api/usage/ollama/connect` runs the interactive browser login, then
//!     a headless verification, and only then persists `{"mode":"browser"}`; a
//!     failed connect changes nothing. It answers `400` with the sanitized
//!     ollama document on failure and `200` with that document plus a fresh
//!     `fetchedAt` on success.
//!
//! Deliberate scope limits (reported to the host, not silently dropped):
//!   * the background samplers, idle debounce and reset timers live in
//!     `usage_auto_refresh` and drive this cache through `UsageHandle`;
//!     `historyPaused` is `null` until that sampler pauses the ollama lane.
//!   * no Claude OAuth grant refresh: an expired token is reported as
//!     `token-expired` / `auth-expired` with `needsAuth`, exactly what Node shows
//!     when its own refresh fails. Credential refresh stays outside a route.
//!   * the Ollama scrape and connect are native (`ollama_browser`); a
//!     host-provided `UsageNetwork` can still replace them, and an install with
//!     no Chromium-family browser reports `unavailable`.
use crate::bus::{Bus, BusEvent};
use crate::claude_credentials::{self, ClaudeCredentialsRead};
use crate::claude_usage::{self, ClaudeUsageResult};
use crate::codex_usage::{self, CodexUsageResult};
use crate::http_agents::Platform;
use crate::http_attempt::BodyReadFailure;
use crate::http_policy::query_values;
use crate::ollama_browser;
use crate::ollama_mode_config::{self, ReadResult};
use crate::provider_usage;
use crate::retry_after::retry_after_ms;
use crate::usage_auth;
use crate::usage_history::{self, Params as HistoryParams};
use crate::usage_snapshot::{
    self, CodexSnapshot, CostStateLimits, SnapshotService, SnapshotWindow,
};
use axum::extract::{RawQuery, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::value::RawValue;
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use tokio::sync::Mutex as AsyncMutex;

/// The per-source floor on network/heavy work (`usage.mjs:67`): at most one
/// attempt every 60s for an automated caller. `force=1` is exempt.
const NETWORK_FLOOR_MS: i64 = 60_000;
/// How old a local Claude/Codex reading may be before it stops answering
/// (`usage.mjs:131`, one missed ~60s statusline tick).
const SNAPSHOT_MAX_AGE_MS: i64 = 2 * NETWORK_FLOOR_MS;
/// How old a local reading may be before it is worse than nothing, capped at
/// the 5h window (`usage.mjs:135`).
const CLAUDE_STALE_MAX_MS: i64 = 5 * 3_600_000;
/// The fallback backoff when a 429 carries no usable `Retry-After`.
const CLAUDE_RATE_LIMIT_BACKOFF_MS: f64 = 5.0 * 60_000.0;
const SOURCES: [&str; 3] = ["ollama", "claude", "codex"];
const HISTORY_PROVIDERS: [&str; 3] = ["claude", "codex", "ollama"];
const HISTORY_WINDOWS: [&str; 2] = ["5h", "7d"];
/// Header timeout handed to the native usage transports (`usage.mjs:68`).
const REQ_TIMEOUT_MS: u64 = 10_000;
/// `CODEX_RESETS_TTL_MS` (`usage.mjs`): the resets lane's own refresh floor.
const CODEX_RESETS_TTL_MS: i64 = 10 * 60_000;
/// Claude resets refresh floor behind a complete local reading.
const CLAUDE_RESETS_TTL_MS: i64 = 10 * 60_000;

type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

// VERIFY: usage-network
/// The live-network seam. `NativeUsageNetwork` performs the real transport through
/// the existing Rust modules; tests inject a stub so no route test reaches a
/// socket or a browser.
pub trait UsageNetwork: Send + Sync {
    fn claude_usage<'a>(&'a self, access_token: &'a str) -> BoxFuture<'a, ClaudeUsageResult>;
    fn codex_usage<'a>(&'a self, auth_path: &'a Path) -> BoxFuture<'a, CodexUsageResult>;
    fn ollama_usage(&self) -> BoxFuture<'_, Value>;

    /// `fetchCodexResets` (`usage.mjs`): `{available, expiresAt[]}` or `None`.
    /// The default answers `None`, so a stub network never reaches the endpoint.
    fn codex_resets<'a>(&'a self, _auth_path: &'a Path) -> BoxFuture<'a, Option<Value>> {
        Box::pin(async { None })
    }

    /// `connectOllamaUsage` (`usage.mjs:431`): interactive login, then headless
    /// verification, serialized on the shared persistent profile. Returns the
    /// raw browser result — the route sanitizes it — and never writes the mode.
    /// The default keeps a transport that has no browser on `unavailable`.
    fn ollama_connect(&self) -> BoxFuture<'_, Value> {
        Box::pin(async { json!({ "ok": false, "source": "ollama", "error": "unavailable" }) })
    }
}

// VERIFY: usage-native-network
/// The production network seam. Claude and Codex use the existing native
/// transports; Ollama drives the shared persistent browser profile.
#[derive(Clone)]
pub struct NativeUsageNetwork {
    profile_dir: PathBuf,
    /// Node imports playwright and serializes every browser leg on one
    /// module-level tail (`ollamaProfileTail`, `usage.mjs:359-363`). The browser
    /// is now built per launch, so its own lock is per instance; this outer lock
    /// keeps a sampler tick and a Connect press from interleaving.
    profile_lock: Arc<AsyncMutex<()>>,
    resolve_browser: Arc<dyn Fn() -> Option<PathBuf> + Send + Sync>,
}

impl NativeUsageNetwork {
    /// `profile_dir` is `CACHE_DIR/pw-ollama-profile` (`usage.mjs:27`). The
    /// executable is resolved per launch, as Node does, so a browser installed
    /// after boot needs no daemon restart. VERIFY: wave4-hostedits-7
    pub fn new(profile_dir: PathBuf) -> Self {
        Self::with_resolver(profile_dir, Arc::new(ollama_browser::installed_browser))
    }

    fn with_resolver(
        profile_dir: PathBuf,
        resolve_browser: Arc<dyn Fn() -> Option<PathBuf> + Send + Sync>,
    ) -> Self {
        Self {
            profile_dir,
            profile_lock: Arc::new(AsyncMutex::new(())),
            resolve_browser,
        }
    }

    fn browser(&self) -> ollama_browser::OllamaBrowser {
        ollama_browser::OllamaBrowser::new(self.profile_dir.clone(), (self.resolve_browser)())
    }
}

impl UsageNetwork for NativeUsageNetwork {
    fn claude_usage<'a>(&'a self, access_token: &'a str) -> BoxFuture<'a, ClaudeUsageResult> {
        Box::pin(
            async move { claude_usage::fetch_claude_usage(access_token, REQ_TIMEOUT_MS).await },
        )
    }

    fn codex_usage<'a>(&'a self, auth_path: &'a Path) -> BoxFuture<'a, CodexUsageResult> {
        Box::pin(async move { codex_usage::fetch_codex_usage(auth_path).await })
    }

    fn codex_resets<'a>(&'a self, auth_path: &'a Path) -> BoxFuture<'a, Option<Value>> {
        Box::pin(async move { codex_usage::fetch_codex_resets(auth_path).await })
    }

    fn ollama_usage(&self) -> BoxFuture<'_, Value> {
        Box::pin(async move {
            if crate::shadow::enabled() {
                return json!({ "ok": false, "error": "shadow mode" });
            }
            let _profile = self.profile_lock.lock().await;
            self.browser().scrape().await
        })
    }

    fn ollama_connect(&self) -> BoxFuture<'_, Value> {
        Box::pin(async move {
            let _profile = self.profile_lock.lock().await;
            self.browser().connect().await
        })
    }
}

/// `sanitizeOllamaUsage` (`usage.mjs:422`) through the shared projection, so the
/// body is the ten-key ollama document with truthiness-coerced booleans rather
/// than whatever shape a transport produced.
fn sanitize_ollama(data: Value) -> Value {
    let payload =
        RawValue::from_string(data.to_string()).expect("a serialized value is valid JSON");
    let request = provider_usage::Request {
        provider: "ollama".into(),
        payload_present: true,
        payload,
        plan: None,
        fetched_at: None,
    };
    let normalized = provider_usage::normalize(&request).expect("ollama normalization cannot fail");
    serde_json::from_str(normalized.get()).expect("the normalized ollama document is valid JSON")
}

// VERIFY: usage-deps
/// Everything the usage routes need from the host. Every root, the clock and the
/// network are explicit; the process environment is only consulted through
/// `parent_env` (for the macOS Keychain helper's environment).
pub struct UsageDeps {
    /// Daemon bus; successful/forced pulls publish `BusEvent::Usage`.
    pub bus: Bus,
    /// `STATE_DIR` — holds `ollama.json`.
    pub state_dir: PathBuf,
    /// `USAGE_SKILL_STATE` — the harness-usage-report skill's state root.
    pub usage_state: PathBuf,
    /// `CLAUDE_CONFIG_DIR` or `~/.claude`.
    pub claude_home: PathBuf,
    /// `CODEX_HOME` or `~/.codex`.
    pub codex_home: PathBuf,
    /// `process.platform`, for the darwin-only Keychain fallback.
    pub platform: Platform,
    /// The daemon environment handed to the Keychain helper.
    pub parent_env: BTreeMap<String, String>,
    /// Absolute `security` binary; `None` disables the Keychain fallback.
    pub security_bin: Option<PathBuf>,
    /// Live-network seam.
    pub network: Arc<dyn UsageNetwork>,
    /// `Date.now()` in milliseconds.
    pub clock: Arc<dyn Fn() -> i64 + Send + Sync>,
}

// VERIFY: usage-handle
/// A cloneable handle onto the cache shared with the routes, so a non-HTTP
/// caller can force a pull without going through the route (`UsageHandle`).
#[derive(Clone)]
pub struct UsageHandle(Arc<UsageState>);

// VERIFY: usage-ollama-state
/// The auto-refresh's view of the ollama lane (`usage.mjs:1215-1219`): the
/// network floor's own clock (`cache.ollama.at`), whether the cross-request gate
/// holds it (`ollamaGate.blocked()`), and the pause state (`historyPaused`).
#[derive(Clone, Debug, Default)]
pub struct UsageOllamaState {
    pub attempt_at: i64,
    pub blocked: bool,
    pub history_paused: Option<Value>,
}

impl UsageHandle {
    /// Forces one lane's pull and returns the full document, exactly like
    /// `GET /api/usage?force=1&source=<provider>`. `BusEvent::Usage` is published
    /// before this returns.
    pub async fn refresh(&self, provider: &str) -> Result<Value, String> {
        self.0.clone().get_usage(true, &[provider.to_owned()]).await
    }

    /// `getUsage({sources})` with `force: false` — the automated trigger every
    /// sampler, idle debounce and reset timer uses, so it keeps the 60s network
    /// floor. An empty `sources` means all three lanes.
    pub async fn refresh_auto(&self, sources: &[String]) -> Result<Value, String> {
        self.0.clone().get_usage(false, sources).await
    }

    /// `cache[src].at = 0` (`usage.mjs:1114`): let exactly one refresh past the
    /// network floor.
    pub async fn reset_network_floor(&self, provider: &str) {
        match provider {
            "ollama" => self.0.ollama.lock().await.at = 0,
            "claude" => self.0.claude.lock().await.at = 0,
            "codex" => self.0.codex.lock().await.at = 0,
            _ => {}
        }
    }

    /// The history sampler's floor, gate and pause together. Manual refreshes
    /// bypass the sampler gate.
    pub async fn ollama_state(&self) -> UsageOllamaState {
        let now = (self.0.clock)();
        let mut slot = self.0.ollama.lock().await;
        UsageOllamaState {
            attempt_at: slot.at,
            blocked: slot.gate.blocked(None, false, now),
            history_paused: self.0.history_paused(),
        }
    }

    /// `historyPaused = {at, error}` (`usage.mjs:1241`).
    pub fn pause_history(&self, error: &str) {
        let paused = json!({ "at": iso_ms((self.0.clock)()), "error": error });
        self.0.set_history_paused(Some(paused));
    }

    /// `historyPaused = null` (`usage.mjs:1023`): a successful ollama read from
    /// any path re-enables the lane.
    pub fn clear_history_paused(&self) {
        self.0.set_history_paused(None);
    }

    /// `ollamaGate.arm(ms)` (`usage.mjs:1237`): ollama has no gate key.
    pub async fn arm_ollama_gate(&self, delay_ms: i64) {
        let now = (self.0.clock)();
        self.0.ollama.lock().await.gate.arm(delay_ms, None, now);
    }

    /// `ollamaGate.clear()` (`usage.mjs:1232`).
    pub async fn clear_ollama_gate(&self) {
        self.0.ollama.lock().await.gate.clear();
    }

    /// `historyBackoffMs` (`usage.mjs:1165`): the ladder the ollama sampler is on.
    pub fn ollama_backoff_ms(&self) -> i64 {
        self.0.ollama_backoff_ms()
    }

    /// `historyBackoffMs = 0` (`usage.mjs:465`): a successful connect restarts
    /// the ladder while the sampler keeps running.
    pub fn set_ollama_backoff_ms(&self, backoff_ms: i64) {
        self.0.set_ollama_backoff_ms(backoff_ms);
    }
}

// VERIFY: usage-router
/// Mounts `/api/usage`, `/api/usage/history` and `/api/usage/ollama/connect`.
/// The outer server layer owns auth, origin and token checks.
pub fn router(deps: UsageDeps) -> Router {
    router_with_handle(deps).0
}

/// `router` plus the handle sharing its cache, for callers that also force pulls.
pub fn router_with_handle(deps: UsageDeps) -> (Router, UsageHandle) {
    let state = Arc::new(UsageState {
        bus: deps.bus,
        state_dir: deps.state_dir,
        usage_state: deps.usage_state,
        claude_home: deps.claude_home.clone(),
        codex_home: deps.codex_home,
        credentials: CredentialSource::new(
            deps.claude_home,
            deps.platform,
            deps.security_bin,
            &deps.parent_env,
        ),
        network: deps.network,
        clock: deps.clock,
        snapshots: Arc::new(Mutex::new(SnapshotService::default())),
        ollama: AsyncMutex::new(OllamaSlot::default()),
        claude: AsyncMutex::new(ClaudeSlot::default()),
        codex: AsyncMutex::new(CodexSlot::default()),
        codex_resets: AsyncMutex::new((0, None)),
        last_emitted: Mutex::new(None),
        history_paused: Mutex::new(None),
        ollama_backoff: Mutex::new(0),
    });
    let router = Router::new()
        .route("/api/usage", get(usage))
        .route("/api/usage/history", get(usage_history))
        .route("/api/usage/ollama/connect", post(ollama_connect))
        .with_state(state.clone());
    (router, UsageHandle(state))
}

struct UsageState {
    bus: Bus,
    state_dir: PathBuf,
    usage_state: PathBuf,
    claude_home: PathBuf,
    codex_home: PathBuf,
    credentials: CredentialSource,
    network: Arc<dyn UsageNetwork>,
    clock: Arc<dyn Fn() -> i64 + Send + Sync>,
    /// One cache for the daemon's lifetime, like Node's module-level cache
    /// (`usage.mjs:718`).
    snapshots: Arc<Mutex<SnapshotService>>,
    /// Per-source async locks serialise concurrent pulls of the same lane while
    /// still letting the three lanes run in parallel (`Promise.all`).
    ollama: AsyncMutex<OllamaSlot>,
    claude: AsyncMutex<ClaudeSlot>,
    codex: AsyncMutex<CodexSlot>,
    /// `cache.codexResets` (`usage.mjs`): last attempt time and last good
    /// `{available, expiresAt}`, refreshed on its own 10-minute lane.
    codex_resets: AsyncMutex<(i64, Option<Value>)>,
    /// Last document pushed over the bus, as JSON text (`usage.mjs:936`).
    last_emitted: Mutex<Option<String>>,
    /// `historyPaused` (`usage.mjs:1164`): `{at, error}` while the ollama
    /// sampler is stopped, else `None`.
    history_paused: Mutex<Option<Value>>,
    /// `historyBackoffMs` (`usage.mjs:1165`): module state in Node, so a
    /// successful connect can zero it while the sampler is running.
    ollama_backoff: Mutex<i64>,
}

impl UsageState {
    /// `historyPaused`, as the document carries it (`null` when running).
    fn history_paused(&self) -> Option<Value> {
        self.history_paused
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
    }

    fn set_history_paused(&self, paused: Option<Value>) {
        *self
            .history_paused
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = paused;
    }

    /// `{...ollama, historyPaused}` (`usage.mjs:1063`).
    fn attach_history_paused(&self, data: Value) -> Value {
        match data {
            Value::Object(mut fields) => {
                fields.insert(
                    "historyPaused".into(),
                    self.history_paused().unwrap_or(Value::Null),
                );
                Value::Object(fields)
            }
            other => other,
        }
    }

    fn ollama_backoff_ms(&self) -> i64 {
        *self
            .ollama_backoff
            .lock()
            .unwrap_or_else(|error| error.into_inner())
    }

    fn set_ollama_backoff_ms(&self, backoff_ms: i64) {
        *self
            .ollama_backoff
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = backoff_ms;
    }

    /// `cache.ollama = {data:null, at:0}` (`usage.mjs:464`): drop the reading
    /// *and* the floor stamp, so the next read attempts the network instead of
    /// serving the pre-connect reading, and `preserve_stale` has no last-good
    /// value to fall back to.
    async fn clear_ollama_cache(&self) {
        let mut slot = self.ollama.lock().await;
        slot.data = None;
        slot.at = 0;
    }
}

#[derive(Default)]
struct OllamaSlot {
    data: Option<Value>,
    at: i64,
    gate: RateGate,
}

#[derive(Default)]
struct ClaudeSlot {
    data: Option<Value>,
    at: i64,
    fingerprint: Option<String>,
    /// When `resets` was last fetched (0 = never).
    resets_at_ms: i64,
    gate: RateGate,
}

#[derive(Default)]
struct CodexSlot {
    data: Option<Value>,
    at: i64,
    fingerprint: Option<String>,
    ignore_snapshot: bool,
    gate: RateGate,
}

/// The cross-request backoff gate (`usage.mjs:733`). `blocked` forgets an armed
/// deadline when the key it was armed for moves; `arm` records one.
#[derive(Default)]
struct RateGate {
    until: i64,
    key: Option<String>,
}

impl RateGate {
    fn blocked(&mut self, key: Option<&str>, preserve_unknown: bool, now: i64) -> bool {
        if !(preserve_unknown && key.is_none()) && key != self.key.as_deref() {
            self.until = 0;
        }
        now < self.until
    }

    fn arm(&mut self, delay_ms: i64, key: Option<String>, now: i64) {
        self.until = now.saturating_add(delay_ms);
        self.key = key;
    }

    fn clear(&mut self) {
        self.until = 0;
        self.key = None;
    }
}

// ---- Route handlers ---------------------------------------------------------

async fn usage(State(state): State<Arc<UsageState>>, RawQuery(query): RawQuery) -> Response {
    let query = query.unwrap_or_default();
    // `req.query.force === '1'`: a repeated `force` arrives as an array in
    // Fastify and is therefore never equal to the string.
    let force = match query_values(&query, "force").as_slice() {
        [value] => value == "1",
        _ => false,
    };
    let sources = query_values(&query, "source");
    match state.get_usage(force, &sources).await {
        Ok(document) => Json(document).into_response(),
        Err(message) => fastify_internal(&message),
    }
}

async fn usage_history(
    State(state): State<Arc<UsageState>>,
    RawQuery(query): RawQuery,
) -> Response {
    let query = query.unwrap_or_default();
    let Some(provider) = single_value(&query, "provider") else {
        return invalid_history_query();
    };
    let window = match query_values(&query, "window").as_slice() {
        [] => "5h".to_owned(),
        [value] => value.clone(),
        _ => return invalid_history_query(),
    };
    if !HISTORY_PROVIDERS.contains(&provider.as_str())
        || !HISTORY_WINDOWS.contains(&window.as_str())
    {
        return invalid_history_query();
    }

    let now = (state.clock)() as f64;
    let state_dir = state.usage_state.to_string_lossy().into_owned();
    let pricing_path = state
        .usage_state
        .join("pricing.json")
        .to_string_lossy()
        .into_owned();
    let claude_projects = state
        .claude_home
        .join("projects")
        .to_string_lossy()
        .into_owned();
    let codex_sessions = state
        .codex_home
        .join("sessions")
        .to_string_lossy()
        .into_owned();
    let document = tokio::task::spawn_blocking(move || {
        usage_history::get(&HistoryParams {
            provider: &provider,
            window: &window,
            now_ms: now,
            state_dir: &state_dir,
            pricing_path: &pricing_path,
            claude_projects: &claude_projects,
            codex_sessions: &codex_sessions,
        })
    })
    .await;
    match document {
        Ok(Ok(text)) => match serde_json::from_str::<Value>(&text) {
            Ok(value) => Json(value).into_response(),
            Err(_) => fastify_internal("usage history produced invalid JSON"),
        },
        Ok(Err(message)) => fastify_internal(&message),
        Err(_) => fastify_internal("usage history task failed"),
    }
}

// ---- Ollama connect ---------------------------------------------------------

/// `POST /api/usage/ollama/connect` (`index.mjs:349-353`): the interactive
/// browser login, the headless verification, then the mode write and the five
/// cache resets. No body, no query, no `force`.
async fn ollama_connect(State(state): State<Arc<UsageState>>) -> Response {
    let result = sanitize_ollama(state.network.ollama_connect().await);
    if !json_is_ok(&result) {
        return (StatusCode::BAD_REQUEST, Json(result)).into_response();
    }

    // `writeOllamaBrowserMode` (`usage.mjs:415`): temp file at 0600, rename onto
    // `ollama.json`. Node throws on failure and Fastify answers 500.
    let path = state.state_dir.join("ollama.json");
    let temp = format!(
        "{}.{}.{}.tmp",
        path.to_string_lossy(),
        std::process::id(),
        (state.clock)()
    );
    let configured = path.to_string_lossy().into_owned();
    let written =
        blocking(move || ollama_mode_config::write(&configured, &temp, r#"{"mode":"browser"}"#))
            .await;
    match written {
        Some(Ok(())) => {}
        // Node throws the `fs` error and Fastify copies its message verbatim.
        // VERIFY: wave4-hostedits-6
        Some(Err(failure)) => return fastify_internal(&failure.message),
        None => return fastify_internal("ollama mode write failed"),
    }

    // `cache.ollama = {data:null, at:0}`, `historyPaused = null`,
    // `historyBackoffMs = 0`, `ollamaGate.clear()`. `startHistorySampler()` has
    // no native equivalent: the samplers are armed at boot and never disarmed.
    state.clear_ollama_cache().await;
    state.set_history_paused(None);
    state.ollama.lock().await.gate.clear();
    state.set_ollama_backoff_ms(0);

    let mut fields = object_fields(result);
    fields.insert("fetchedAt".into(), Value::String(iso_ms((state.clock)())));
    Json(Value::Object(fields)).into_response()
}

// ---- Document assembly ------------------------------------------------------

impl UsageState {
    async fn get_usage(self: Arc<Self>, force: bool, sources: &[String]) -> Result<Value, String> {
        let allow = normalize_sources(sources);
        let now = (self.clock)();
        let ollama = {
            let state = self.clone();
            tokio::spawn(async move { state.pick_ollama(force, allow[0], now).await })
        };
        let claude = {
            let state = self.clone();
            tokio::spawn(async move { state.pick_claude(force, allow[1], now).await })
        };
        let codex = {
            let state = self.clone();
            tokio::spawn(async move { state.pick_codex(force, allow[2], now).await })
        };
        // Node's `Promise.all` rejects on the first failing lane; the other pulls
        // still finish and update their cache.
        let claude = claude.await.map_err(|_| "usage task failed".to_owned())??;
        let codex = codex.await.map_err(|_| "usage task failed".to_owned())??;
        let ollama = ollama.await.map_err(|_| "usage task failed".to_owned())??;
        let ollama = ollama.map(|data| self.attach_history_paused(data));
        let codex = self.attach_codex_resets(codex, force, allow[2], now).await;
        // A full document even for a filtered pull: the client merges it and the
        // excluded lanes answer from cache.
        let result = json!({ "ollama": ollama, "claude": claude, "codex": codex });
        self.publish(&result, force);
        Ok(result)
    }

    /// The resets lane (`usage.mjs` getUsage): its own endpoint, because a
    /// complete Stop-hook snapshot keeps the codex lane off the network.
    /// `SING_CODEX_RESETS=0` switches it off; a failed read keeps the last count.
    async fn attach_codex_resets(
        &self,
        codex: Option<Value>,
        force: bool,
        allowed: bool,
        now: i64,
    ) -> Option<Value> {
        let mut slot = self.codex_resets.lock().await;
        let enabled = std::env::var("SING_CODEX_RESETS").as_deref() != Ok("0");
        if enabled && allowed && (force || now - slot.0 >= CODEX_RESETS_TTL_MS) {
            slot.0 = now;
            let auth_path = self.codex_home.join("auth.json");
            if let Some(resets) = self.network.codex_resets(&auth_path).await {
                slot.1 = Some(resets);
            }
        }
        match (codex, &slot.1) {
            (Some(Value::Object(mut fields)), Some(resets)) => {
                fields.insert("resets".into(), resets.clone());
                Some(Value::Object(fields))
            }
            (codex, _) => codex,
        }
    }

    fn publish(&self, result: &Value, force: bool) {
        let serialized = result.to_string();
        let emit = {
            let mut last = self
                .last_emitted
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            let changed = last.as_deref() != Some(serialized.as_str());
            if force || changed {
                *last = Some(serialized);
                true
            } else {
                false
            }
        };
        if emit {
            self.bus.emit(&BusEvent::Usage(result.clone()));
        }
    }

    async fn pick_ollama(
        &self,
        force: bool,
        allowed: bool,
        now: i64,
    ) -> Result<Option<Value>, String> {
        let mut slot = self.ollama.lock().await;
        if !allowed {
            return Ok(slot.data.clone());
        }
        self.pull_ollama(&mut *slot, force, now).await
    }

    async fn pick_claude(
        &self,
        force: bool,
        allowed: bool,
        now: i64,
    ) -> Result<Option<Value>, String> {
        let mut slot = self.claude.lock().await;
        if !allowed {
            return Ok(slot.data.clone());
        }
        self.pull_claude(&mut *slot, force, now).await
    }

    async fn pick_codex(
        &self,
        force: bool,
        allowed: bool,
        now: i64,
    ) -> Result<Option<Value>, String> {
        let mut slot = self.codex.lock().await;
        if !allowed {
            return Ok(slot.data.clone());
        }
        self.pull_codex(&mut *slot, force, now).await
    }

    // ---- Ollama ------------------------------------------------------------

    async fn pull_ollama(
        &self,
        slot: &mut OllamaSlot,
        force: bool,
        now: i64,
    ) -> Result<Option<Value>, String> {
        if !force && slot.at != 0 && now - slot.at < NETWORK_FLOOR_MS {
            return Ok(slot.data.clone());
        }
        slot.at = now;

        let fetched = self.fetch_ollama().await;
        let data = with_fetched_at(fetched, now);
        let last_good = slot.data.as_ref().filter(|data| json_is_ok(data)).cloned();
        if json_is_ok(&data) || last_good.is_none() {
            slot.data = Some(data.clone());
        }
        if !json_is_ok(&data) {
            if let Some(last_good) = last_good {
                // A failure surfaces the current error but never replaces the
                // timestamped successful measurement.
                return Ok(Some(preserve_stale(&last_good, &data)));
            }
        }
        if json_is_ok(&data) {
            self.append_ollama_history(&data, now).await;
            // A successful read from ANY path (manual Refresh, idle debounce,
            // reset timer, or the sampler itself) re-enables a paused lane.
            self.set_history_paused(None);
        }
        Ok(slot.data.clone())
    }

    async fn fetch_ollama(&self) -> Value {
        let path = self.state_dir.join("ollama.json");
        let configured = path.to_string_lossy().into_owned();
        let read = {
            let configured = configured.clone();
            blocking(move || ollama_mode_config::read(&configured)).await
        };
        match read {
            Some(Ok(ReadResult::Missing)) => ollama_no_config(),
            Some(Ok(ReadResult::File { text })) => match serde_json::from_str::<Value>(&text) {
                Ok(config) if config.get("mode").and_then(Value::as_str) == Some("browser") => {
                    self.network.ollama_usage().await
                }
                Ok(_) => ollama_no_config(),
                Err(error) => json!({
                    "ok": false,
                    "source": "ollama",
                    "error": format!("bad {configured}: {error}"),
                }),
            },
            Some(Err(failure)) => json!({
                "ok": false,
                "source": "ollama",
                // Node catches the `readFileSync` failure and answers
                // `bad ${OLLAMA_CFG}: ${e.message}` with libuv's text, not the
                // error kind (`usage.mjs:405-412`). `message` is the same
                // reconstruction the write path puts in its 500 body.
                // VERIFY: wave6-small_parity-1
                "error": format!("bad {configured}: {}", failure.message),
            }),
            None => json!({
                "ok": false,
                "source": "ollama",
                "error": format!("bad {configured}: read failed"),
            }),
        }
    }

    async fn append_ollama_history(&self, data: &Value, now: i64) {
        let path = self.usage_state.join("ollama-usage.jsonl");
        let reading = to_raw(data);
        let snapshots = self.snapshots.clone();
        let _ = blocking(move || {
            with_snapshots(&snapshots, |service| {
                service.append_ollama(&path, &reading, now)
            })
        })
        .await;
    }

    // ---- Claude ------------------------------------------------------------

    async fn pull_claude(
        &self,
        slot: &mut ClaudeSlot,
        force: bool,
        now: i64,
    ) -> Result<Option<Value>, String> {
        let fingerprint = self.credential_fingerprint().await;
        // A still-null fingerprint means "never established this process", not
        // "switched accounts"; only a fingerprint that actually moved counts.
        let account_changed =
            slot.fingerprint.is_some() && fingerprint.is_some() && slot.fingerprint != fingerprint;
        if account_changed {
            slot.data = None;
            slot.at = 0;
        }
        let oauth = self.oauth_token().await;
        let plan = oauth
            .as_ref()
            .and_then(|oauth| oauth.subscription_type.clone());
        // Local file tiers run ahead of every gate, force included: a fresh
        // statusline write always wins over the network leg.
        let local = if account_changed {
            None
        } else {
            self.read_claude_local(
                slot.data.as_ref(),
                plan.as_deref(),
                SNAPSHOT_MAX_AGE_MS,
                now,
            )
            .await?
        };
        if let Some(local) = local {
            if slot.fingerprint.is_none() && fingerprint.is_some() {
                slot.fingerprint = fingerprint.clone();
            }
            let unchanged = slot.data.as_ref().is_some_and(|data| {
                json_is_ok(data)
                    && !truthy(data.get("stale").unwrap_or(&Value::Null))
                    && data.get("fetchedAt") == local.get("fetchedAt")
            });
            if !unchanged {
                let mut next = local.clone();
                // A local reading has no resets of its own: keep the last ones.
                if let (Some(resets), Some(fields)) = (
                    slot.data.as_ref().and_then(|data| data.get("resets")),
                    next.as_object_mut(),
                ) {
                    fields
                        .entry("resets")
                        .or_insert_with(|| resets.clone());
                }
                slot.data = Some(next);
            }
            // Complete local windows answer the card without spending the
            // endpoint's account quota.
            if has_complete_window(local.get("session")) && has_complete_window(local.get("weekly"))
            {
                // One usage call per TTL keeps resets fresh; never on `force`
                // alone and never past a blocked gate.
                if now - slot.resets_at_ms >= CLAUDE_RESETS_TTL_MS
                    && !slot.gate.blocked(fingerprint.as_deref(), false, now)
                {
                    slot.resets_at_ms = now;
                    self.refresh_claude_resets(slot, oauth.as_ref(), fingerprint, now)
                        .await;
                }
                return Ok(slot.data.clone());
            }
        }
        if slot.gate.blocked(fingerprint.as_deref(), false, now) {
            if let Some(data) = slot.data.clone() {
                if json_is_ok(&data) {
                    return Ok(Some(data));
                }
                let floor = self.claude_stale_floor(Some(&data), &data, now).await?;
                if let Some(floor) = floor {
                    slot.data = Some(floor);
                }
                return Ok(slot.data.clone());
            }
        }
        if !force && slot.at != 0 && now - slot.at < NETWORK_FLOOR_MS {
            return Ok(slot.data.clone());
        }
        slot.at = now;

        // Past every gate: this pull asks for the fullest answer regardless of
        // the caller's `force`, because the gates decided whether to get here.
        let fetched = self.fetch_claude(slot.data.as_ref(), true, now).await?;
        let data = with_fetched_at(fetched, now);
        if json_is_ok(&data) {
            slot.fingerprint = self.credential_fingerprint().await;
            slot.gate.clear();
            // The network body just answered resets, present or not.
            slot.resets_at_ms = now;
        }
        let last_good = slot.data.as_ref().filter(|data| json_is_ok(data)).cloned();
        if json_is_ok(&data) || last_good.is_none() {
            slot.data = Some(data.clone());
        }
        if data.get("error").and_then(Value::as_str) == Some("rate-limited") {
            let delay = data
                .get("retryAfterMs")
                .and_then(Value::as_f64)
                .filter(|value| value.is_finite())
                .unwrap_or(CLAUDE_RATE_LIMIT_BACKOFF_MS)
                .max(0.0) as i64;
            slot.gate.arm(delay, fingerprint, now);
        }
        if !json_is_ok(&data) {
            let floor = self
                .claude_stale_floor(slot.data.as_ref(), &data, now)
                .await?;
            if let Some(floor) = floor {
                slot.data = Some(floor);
            }
        }
        Ok(slot.data.clone())
    }

    /// The single resets-only usage call behind a complete local reading. Any
    /// failure keeps the old resets; a 429 arms the gate like the network leg.
    async fn refresh_claude_resets(
        &self,
        slot: &mut ClaudeSlot,
        oauth: Option<&ClaudeOauth>,
        fingerprint: Option<String>,
        now: i64,
    ) {
        let Some(token) = oauth
            .and_then(|oauth| oauth.access_token.clone())
            .filter(|token| !token.is_empty())
        else {
            return;
        };
        match self.network.claude_usage(&token).await {
            ClaudeUsageResult::Response {
                status: 200,
                body: Ok(Some(text)),
                ..
            } => {
                let resets = serde_json::from_str::<Value>(&text)
                    .ok()
                    .and_then(|raw| claude_usage::parse_resets(&raw));
                if let (Some(resets), Some(fields)) = (
                    resets,
                    slot.data.as_mut().and_then(Value::as_object_mut),
                ) {
                    fields.insert("resets".into(), resets);
                }
            }
            ClaudeUsageResult::Response {
                status: 429,
                retry_after,
                ..
            } => {
                let delay = retry_after_ms(retry_after.as_deref(), now)
                    .filter(|v| v.is_finite())
                    .unwrap_or(CLAUDE_RATE_LIMIT_BACKOFF_MS)
                    .max(0.0) as i64;
                slot.gate.arm(delay, fingerprint, now);
            }
            _ => {}
        }
    }

    /// `readClaudeLocal` (`usage.mjs:512`): the snapshot log first, then the
    /// statusline's cost-state files. Both are plain file reads.
    async fn read_claude_local(
        &self,
        prev: Option<&Value>,
        plan: Option<&str>,
        max_age_ms: i64,
        now: i64,
    ) -> Result<Option<Value>, String> {
        let live = self.usage_state.join("usage-snapshots.jsonl");
        let archive = self.newest_snapshot_archive().await;
        let snapshots = self.snapshots.clone();
        let snapshot = blocking(move || {
            with_snapshots(&snapshots, |service| {
                service.read_claude_snapshot(&live, archive.as_deref(), max_age_ms, now)
            })
        })
        .await
        .flatten();
        if let Some(snapshot) = snapshot {
            let data = normalize_claude(&snapshot.raw, plan)?;
            let session = prefer_current_window(
                data.get("session"),
                prev.and_then(|prev| prev.get("session")),
                now,
            );
            let weekly = prefer_current_window(
                data.get("weekly"),
                prev.and_then(|prev| prev.get("weekly")),
                now,
            );
            let mut out = object_fields(data);
            out.insert("session".into(), session);
            out.insert("weekly".into(), weekly);
            out.insert("fetchedAt".into(), Value::String(snapshot.fetched_at));
            return Ok(Some(Value::Object(out)));
        }

        let directory = self.usage_state.join("cost-state");
        let snapshots = self.snapshots.clone();
        let limits = blocking(move || {
            with_snapshots(&snapshots, |service| {
                service.read_cost_state(&directory, max_age_ms, now)
            })
        })
        .await
        .flatten();
        let Some(limits) = limits else {
            return Ok(None);
        };
        self.append_claude_cost_state(&limits, now).await;
        let session_limit = cost_window(limits.session.as_ref());
        let weekly_limit_value = cost_window(limits.weekly.as_ref());
        let session = prefer_current_window(
            Some(&session_limit),
            prev.and_then(|p| p.get("session")),
            now,
        );
        let weekly_limit = prefer_current_window(
            Some(&weekly_limit_value),
            prev.and_then(|p| p.get("weekly")),
            now,
        );
        let weekly = if truthy(&weekly_limit) {
            let mut fields = object_fields(weekly_limit);
            let models = prev
                .and_then(|prev| prev.get("weekly"))
                .and_then(|weekly| weekly.get("models"))
                .filter(|models| !models.is_null())
                .cloned()
                .unwrap_or_else(|| Value::Array(Vec::new()));
            fields.insert("models".into(), models);
            Value::Object(fields)
        } else {
            weekly_limit
        };
        let plan = plan.map_or(Value::Null, |plan| Value::String(plan.to_owned()));
        let extra = prev
            .and_then(|prev| prev.get("extra"))
            .cloned()
            .unwrap_or(Value::Null);
        Ok(Some(json!({
            "ok": true,
            "source": "claude",
            "plan": plan,
            "session": session,
            "weekly": weekly,
            "extra": extra,
            "fetchedAt": limits.fetched_at,
        })))
    }

    async fn append_claude_cost_state(&self, limits: &CostStateLimits, now: i64) {
        let Some(session) = limits.session.as_ref() else {
            return;
        };
        // NOTE: the native cost-state branch of `append_claude` reads
        // `pctUsed`/`resetsAt` (and writes `utilization`/`resets_at`), so the
        // reading pair is passed in that shape; the written row matches the
        // Node file contract.
        let session_reading = cost_reading(Some(session));
        let weekly_reading = cost_reading(limits.weekly.as_ref());
        let session_raw = to_raw(&session_reading);
        let weekly_raw = to_raw(&weekly_reading);
        let live = self.usage_state.join("usage-snapshots.jsonl");
        let archive = self.usage_state.clone();
        let fetched_at_ms = usage_snapshot::parse_date_ms(&limits.fetched_at);
        let snapshots = self.snapshots.clone();
        let _ = blocking(move || {
            with_snapshots(&snapshots, |service| {
                service.append_claude(
                    &live,
                    &archive,
                    true,
                    &session_raw,
                    now,
                    Some((&*session_raw, &*weekly_raw)),
                    fetched_at_ms,
                )
            })
        })
        .await;
    }

    /// `fetchClaude` (`usage.mjs:537`) without the OAuth grant refresh.
    async fn fetch_claude(
        &self,
        prev: Option<&Value>,
        force: bool,
        now: i64,
    ) -> Result<Value, String> {
        let resolved = self.credentials.resolve();
        let oauth = resolved
            .oauth
            .clone()
            .filter(|oauth| oauth.valid(now as f64));
        let Some(oauth) = oauth else {
            return Ok(claude_credential_error(&resolved));
        };
        if !force {
            // Belt and braces for a direct caller: `pull` already looked.
            if let Some(local) = self
                .read_claude_local(
                    prev,
                    oauth.subscription_type.as_deref(),
                    SNAPSHOT_MAX_AGE_MS,
                    now,
                )
                .await?
            {
                return Ok(local);
            }
        }
        let Some(access_token) = oauth.access_token.clone().filter(|token| !token.is_empty())
        else {
            return Ok(claude_credential_error(&resolved));
        };

        let result = self.network.claude_usage(&access_token).await;
        let (status, retry_after, body) = match result {
            ClaudeUsageResult::TransportFailure => {
                return Ok(claude_failure("request failed: fetch failed"));
            }
            ClaudeUsageResult::TimeoutFailure => {
                return Ok(claude_failure("request failed: This operation was aborted"));
            }
            ClaudeUsageResult::Response {
                status,
                retry_after,
                body,
            } => (status, retry_after, body),
        };
        match status {
            200 => match body {
                Ok(Some(text)) => match serde_json::from_str::<Value>(&text) {
                    Ok(raw) => {
                        // Feed a fresh network reading back into the statusline's
                        // own log.
                        self.append_claude_network(&raw, now).await;
                        match normalize_claude(&to_raw(&raw), oauth.subscription_type.as_deref()) {
                            Ok(mut data) => {
                                // The same body carries the cedar_ember grants.
                                if let (Some(resets), Some(fields)) =
                                    (claude_usage::parse_resets(&raw), data.as_object_mut())
                                {
                                    fields.insert("resets".into(), resets);
                                }
                                Ok(data)
                            }
                            Err(message) => Ok(claude_failure(&format!("parse error: {message}"))),
                        }
                    }
                    Err(error) => Ok(claude_failure(&format!("parse error: {error}"))),
                },
                Ok(None) | Err(BodyReadFailure::Terminated) => {
                    Ok(claude_failure("parse error: terminated"))
                }
            },
            401 => Ok(claude_needs_auth("auth-expired")),
            429 => {
                let delay = retry_after_ms(retry_after.as_deref(), now).filter(|v| v.is_finite());
                Ok(json!({
                    "ok": false,
                    "source": "claude",
                    "error": "rate-limited",
                    "retryAfterMs": delay.map_or(Value::Null, |delay| json!(delay)),
                }))
            }
            status => Ok(claude_failure(&format!("HTTP {status}"))),
        }
    }

    async fn append_claude_network(&self, raw: &Value, now: i64) {
        let live = self.usage_state.join("usage-snapshots.jsonl");
        let archive = self.usage_state.clone();
        let raw = to_raw(raw);
        let snapshots = self.snapshots.clone();
        let _ = blocking(move || {
            with_snapshots(&snapshots, |service| {
                service.append_claude(&live, &archive, false, &raw, now, None, None)
            })
        })
        .await;
    }

    /// `claudeStaleFloor` (`usage.mjs:764`): the best reading reachable without
    /// the network, marked stale with the current failure attached.
    async fn claude_stale_floor(
        &self,
        prev: Option<&Value>,
        failure: &Value,
        now: i64,
    ) -> Result<Option<Value>, String> {
        let oauth = self.oauth_token().await;
        let plan = oauth
            .as_ref()
            .and_then(|oauth| oauth.subscription_type.clone());
        let widened = self
            .read_claude_local(prev, plan.as_deref(), CLAUDE_STALE_MAX_MS, now)
            .await?;
        let last_good = prev.filter(|data| json_is_ok(data));
        Ok(pick_newer(widened, last_good).map(|best| preserve_stale(&best, failure)))
    }

    async fn oauth_token(&self) -> Option<ClaudeOauth> {
        let source = self.credentials.clone();
        let now = (self.clock)() as f64;
        blocking(move || source.resolve().oauth.filter(|oauth| oauth.valid(now)))
            .await
            .flatten()
    }

    async fn credential_fingerprint(&self) -> Option<String> {
        let source = self.credentials.clone();
        blocking(move || source.fingerprint()).await.flatten()
    }

    async fn newest_snapshot_archive(&self) -> Option<PathBuf> {
        let directory = self.usage_state.clone();
        blocking(move || newest_snapshot_archive(&directory))
            .await
            .flatten()
    }

    // ---- Codex -------------------------------------------------------------

    async fn pull_codex(
        &self,
        slot: &mut CodexSlot,
        force: bool,
        now: i64,
    ) -> Result<Option<Value>, String> {
        let fingerprint = self.codex_fingerprint().await;
        let account_changed =
            slot.fingerprint.is_some() && fingerprint.is_some() && slot.fingerprint != fingerprint;
        if account_changed {
            slot.data = None;
            slot.at = 0;
            slot.fingerprint = fingerprint.clone();
            slot.ignore_snapshot = true;
        }
        let snapshot = if slot.ignore_snapshot {
            None
        } else {
            self.read_codex_snapshot(SNAPSHOT_MAX_AGE_MS, now).await
        };
        if let Some(snapshot) = snapshot {
            let previous = slot.data.as_ref().filter(|data| json_is_ok(data));
            let mut reading = merge_codex_snapshot(&snapshot, previous, now);
            let complete = has_complete_window(reading.get("session"))
                && has_complete_window(reading.get("weekly"));
            if previous.is_some_and(|prev| truthy(prev.get("stale").unwrap_or(&Value::Null)))
                && !complete
            {
                // A stale reading keeps its error until it completes again.
                if let Value::Object(fields) = &mut reading {
                    fields.insert("stale".into(), Value::Bool(true));
                    if let Some(error) = previous.and_then(|prev| prev.get("error")).cloned() {
                        fields.insert("error".into(), error);
                    }
                    if let Some(needs_auth) =
                        previous.and_then(|prev| prev.get("needsAuth")).cloned()
                    {
                        fields.insert("needsAuth".into(), needs_auth);
                    }
                }
            }
            let changed = slot.data.as_ref().map(Value::to_string) != Some(reading.to_string());
            if changed {
                slot.data = Some(reading);
            }
            if slot.fingerprint.is_none() && fingerprint.is_some() {
                slot.fingerprint = fingerprint.clone();
            }
            if complete {
                return Ok(slot.data.clone());
            }
        }
        if slot.gate.blocked(fingerprint.as_deref(), true, now) {
            if let Some(data) = slot.data.clone() {
                let floor = self
                    .codex_stale_floor(slot.ignore_snapshot, Some(&data), &data, now)
                    .await;
                slot.data = Some(floor.unwrap_or(data));
                return Ok(slot.data.clone());
            }
        }
        if !force && slot.at != 0 && now - slot.at < NETWORK_FLOOR_MS {
            return Ok(slot.data.clone());
        }
        slot.at = now;

        let fetched = self.fetch_codex(now).await;
        let data = with_fetched_at(fetched, now);
        if json_is_ok(&data) {
            slot.fingerprint = fingerprint;
            slot.ignore_snapshot = false;
            slot.gate.clear();
        }
        let last_good = slot.data.as_ref().filter(|data| json_is_ok(data)).cloned();
        if json_is_ok(&data) || last_good.is_none() {
            slot.data = Some(data.clone());
        }
        if data.get("error").and_then(Value::as_str) == Some("rate-limited") {
            let delay = data
                .get("retryAfterMs")
                .and_then(Value::as_f64)
                .filter(|value| value.is_finite())
                .unwrap_or(CLAUDE_RATE_LIMIT_BACKOFF_MS)
                .max(0.0) as i64;
            let key = slot.fingerprint.clone();
            slot.gate.arm(delay, key, now);
        }
        if !json_is_ok(&data) {
            let floor = self
                .codex_stale_floor(slot.ignore_snapshot, slot.data.as_ref(), &data, now)
                .await;
            if let Some(floor) = floor {
                slot.data = Some(floor);
            }
        }
        if json_is_ok(&data) {
            self.append_codex_history(&data, now).await;
        }
        Ok(slot.data.clone())
    }

    async fn read_codex_snapshot(&self, max_age_ms: i64, now: i64) -> Option<CodexSnapshot> {
        let path = self.usage_state.join("codex-usage.jsonl");
        let snapshots = self.snapshots.clone();
        blocking(move || {
            with_snapshots(&snapshots, |service| {
                service.read_codex_snapshot(&path, max_age_ms, now)
            })
        })
        .await
        .flatten()
    }

    /// `fetchCodex` (`usage.mjs:652`): the live wham/usage API, mapped through the
    /// existing Codex DTO so status/error/`retryAfterMs` stay identical.
    async fn fetch_codex(&self, now: i64) -> Value {
        let auth_path = self.codex_home.join("auth.json");
        let result = self.network.codex_usage(&auth_path).await;
        let (status, retry_after, body) = match result {
            CodexUsageResult::NoSessions => return no_codex_data(now),
            CodexUsageResult::TransportFailure => {
                return no_codex_data_with(now, "request failed: fetch failed");
            }
            CodexUsageResult::TimeoutFailure => {
                return no_codex_data_with(now, "request failed: This operation was aborted");
            }
            CodexUsageResult::Response {
                status,
                retry_after,
                body,
            } => (status, retry_after, body),
        };
        let mut error = None;
        let payload = if status == 200 {
            match body {
                Ok(Some(text)) => match serde_json::from_str::<Value>(&text) {
                    Ok(payload) => payload,
                    Err(parse) => {
                        error = Some(format!("parse error: {parse}"));
                        Value::Null
                    }
                },
                Ok(None) | Err(BodyReadFailure::Terminated) => {
                    error = Some("parse error: terminated".to_owned());
                    Value::Null
                }
            }
        } else {
            Value::Null
        };
        let request = codex_usage::CompletedResponseRequest {
            status,
            retry_after,
            now_ms: if status == 429 { now } else { 0 },
            payload_present: status == 200 && error.is_none(),
            payload: to_raw(&payload),
            fetched_at: Some(iso_ms(now)),
            error,
        };
        match codex_usage::map_completed_response(&request) {
            Ok(raw) => serde_json::from_str(raw.get()).unwrap_or_else(|_| no_codex_data(now)),
            Err(_) => no_codex_data(now),
        }
    }

    async fn append_codex_history(&self, data: &Value, now: i64) {
        let path = self.usage_state.join("codex-usage.jsonl");
        let reading = to_raw(data);
        let snapshots = self.snapshots.clone();
        let _ = blocking(move || {
            with_snapshots(&snapshots, |service| {
                service.append_codex(&path, &reading, now)
            })
        })
        .await;
    }

    async fn codex_stale_floor(
        &self,
        ignore_snapshot: bool,
        prev: Option<&Value>,
        failure: &Value,
        now: i64,
    ) -> Option<Value> {
        let last_good = prev.filter(|data| json_is_ok(data));
        let widened = if ignore_snapshot {
            None
        } else {
            self.read_codex_snapshot(CLAUDE_STALE_MAX_MS, now).await
        };
        let merged = widened.map(|snapshot| merge_codex_snapshot(&snapshot, last_good, now));
        pick_newer(merged, last_good).map(|best| preserve_stale(&best, failure))
    }

    async fn codex_fingerprint(&self) -> Option<String> {
        let path = self.codex_home.join("auth.json");
        let path = path.to_string_lossy().into_owned();
        blocking(move || crate::codex_account_fingerprint::fingerprint(&path))
            .await
            .flatten()
            .filter(|value| is_sha256_hex(value))
    }
}

// ---- Credentials ------------------------------------------------------------

#[derive(Clone)]
struct CredentialSource {
    path: PathBuf,
    /// `security` binary plus the environment, set only on darwin.
    keychain: Option<(PathBuf, Value)>,
}

impl CredentialSource {
    fn new(
        claude_home: PathBuf,
        platform: Platform,
        security_bin: Option<PathBuf>,
        parent_env: &BTreeMap<String, String>,
    ) -> Self {
        let env = Value::Object(
            parent_env
                .iter()
                .map(|(key, value)| (key.clone(), Value::String(value.clone())))
                .collect(),
        );
        let keychain = if platform == Platform::Darwin {
            security_bin.map(|bin| (bin, env))
        } else {
            None
        };
        Self {
            path: claude_home.join(".credentials.json"),
            keychain,
        }
    }

    /// `resolveClaudeCredential` (`usage.mjs:396`).
    fn resolve(&self) -> ResolvedCredential {
        match claude_credentials::read(&self.path) {
            ClaudeCredentialsRead::File(text) => match serde_json::from_str::<Value>(&text) {
                Ok(value) => ResolvedCredential {
                    oauth: oauth_from(&value),
                    file_kind: FileKind::File,
                },
                Err(_) => ResolvedCredential {
                    oauth: self.keychain(),
                    file_kind: FileKind::ParseFailure,
                },
            },
            ClaudeCredentialsRead::Missing => ResolvedCredential {
                oauth: self.keychain(),
                file_kind: FileKind::Missing,
            },
            ClaudeCredentialsRead::ReadFailure => ResolvedCredential {
                oauth: self.keychain(),
                file_kind: FileKind::ReadFailure,
            },
        }
    }

    /// `readKeychainOnDarwin` (`usage.mjs:421`): never throws.
    fn keychain(&self) -> Option<ClaudeOauth> {
        let (bin, env) = self.keychain.as_ref()?;
        let bin = bin.to_string_lossy();
        let result = usage_auth::keychain(Some("darwin"), Some(bin.as_ref()), env);
        if result.get("ok") != Some(&Value::Bool(true)) {
            return None;
        }
        oauth_from(&json!({
            "claudeAiOauth": result.get("oauth").cloned().unwrap_or(Value::Null),
        }))
    }

    /// `claudeCredentialFingerprint` (`usage.mjs:390`): SHA-256 of the longer-lived
    /// refresh token, falling back to the access token.
    fn fingerprint(&self) -> Option<String> {
        let oauth = self.resolve().oauth?;
        let secret = oauth
            .refresh_token
            .filter(|token| !token.is_empty())
            .or(oauth.access_token.filter(|token| !token.is_empty()))?;
        Some(sha256_hex(secret.as_bytes()))
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum FileKind {
    File,
    Missing,
    ReadFailure,
    ParseFailure,
}

struct ResolvedCredential {
    oauth: Option<ClaudeOauth>,
    file_kind: FileKind,
}

#[derive(Clone)]
struct ClaudeOauth {
    access_token: Option<String>,
    refresh_token: Option<String>,
    expires_at: Option<Value>,
    subscription_type: Option<String>,
}

impl ClaudeOauth {
    /// `claudeOauthToken` (`usage.mjs:379`): a present, unexpired access token.
    fn valid(&self, now: f64) -> bool {
        if self.access_token.as_deref().map_or(true, str::is_empty) {
            return false;
        }
        // `if (oauth.expiresAt && Number(oauth.expiresAt) < Date.now())`.
        let Some(expires_at) = self.expires_at.as_ref().filter(|value| truthy(value)) else {
            return true;
        };
        !(js_number(expires_at) < now)
    }
}

fn oauth_from(value: &Value) -> Option<ClaudeOauth> {
    let oauth = value.get("claudeAiOauth").filter(|value| truthy(value))?;
    Some(ClaudeOauth {
        access_token: oauth
            .get("accessToken")
            .and_then(Value::as_str)
            .map(str::to_owned),
        refresh_token: oauth
            .get("refreshToken")
            .and_then(Value::as_str)
            .map(str::to_owned),
        expires_at: oauth.get("expiresAt").cloned(),
        subscription_type: oauth
            .get("subscriptionType")
            .and_then(Value::as_str)
            .map(str::to_owned),
    })
}

/// `fetchClaude`'s no-credential error selection (`usage.mjs:547`).
fn claude_credential_error(resolved: &ResolvedCredential) -> Value {
    let error = match resolved.file_kind {
        FileKind::Missing => "no-credentials",
        FileKind::ReadFailure | FileKind::ParseFailure => "bad credentials",
        FileKind::File => {
            if resolved
                .oauth
                .as_ref()
                .and_then(|oauth| oauth.access_token.as_deref())
                .is_some_and(|token| !token.is_empty())
            {
                "token-expired"
            } else {
                "no-token"
            }
        }
    };
    claude_needs_auth(error)
}

fn claude_needs_auth(error: &str) -> Value {
    json!({ "ok": false, "source": "claude", "needsAuth": true, "error": error })
}

fn claude_failure(error: &str) -> Value {
    json!({ "ok": false, "source": "claude", "error": error })
}

fn ollama_no_config() -> Value {
    json!({ "ok": false, "source": "ollama", "needsAuth": true, "error": "no-config" })
}

fn no_codex_data(now: i64) -> Value {
    no_codex_data_with(now, "no Codex sessions found")
}

fn no_codex_data_with(now: i64, error: &str) -> Value {
    json!({
        "ok": false,
        "source": "codex",
        "error": error,
        "fetchedAt": iso_ms(now),
    })
}

// ---- Value helpers ----------------------------------------------------------

fn normalize_sources(sources: &[String]) -> [bool; 3] {
    let listed: Vec<&str> = sources
        .iter()
        .map(String::as_str)
        .filter(|source| SOURCES.contains(source))
        .collect();
    if listed.is_empty() {
        return [true, true, true];
    }
    [
        listed.contains(&"ollama"),
        listed.contains(&"claude"),
        listed.contains(&"codex"),
    ]
}

fn json_is_ok(data: &Value) -> bool {
    data.get("ok") == Some(&Value::Bool(true))
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(number) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Value::String(value) => !value.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

fn js_number(value: &Value) -> f64 {
    match value {
        Value::Number(number) => number.as_f64().unwrap_or(f64::NAN),
        Value::String(text) => {
            let text = text.trim();
            if text.is_empty() {
                0.0
            } else {
                text.parse().unwrap_or(f64::NAN)
            }
        }
        Value::Bool(value) => u8::from(*value) as f64,
        Value::Null => 0.0,
        Value::Array(_) | Value::Object(_) => f64::NAN,
    }
}

fn object_fields(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(fields) => fields,
        _ => Map::new(),
    }
}

fn to_raw(value: &Value) -> Box<RawValue> {
    RawValue::from_string(value.to_string()).expect("a serialized value is valid JSON")
}

fn raw_value(raw: Option<&RawValue>) -> Value {
    raw.and_then(|raw| serde_json::from_str(raw.get()).ok())
        .unwrap_or(Value::Null)
}

fn with_fetched_at(fetched: Value, now: i64) -> Value {
    let mut fields = Map::new();
    fields.insert("fetchedAt".into(), Value::String(iso_ms(now)));
    for (key, value) in object_fields(fetched) {
        fields.insert(key, value);
    }
    Value::Object(fields)
}

/// `{...lastGood, stale: true, error, needsAuth}` when the previous reading is
/// still the best answer; otherwise the failure itself (`usage.mjs:348`).
fn preserve_stale(best: &Value, failure: &Value) -> Value {
    if json_is_ok(best) && !json_is_ok(failure) {
        let mut fields = object_fields(best.clone());
        fields.insert("stale".into(), Value::Bool(true));
        if let Some(error) = failure.get("error") {
            fields.insert("error".into(), error.clone());
        }
        fields.insert(
            "needsAuth".into(),
            Value::Bool(failure.get("needsAuth").is_some_and(truthy)),
        );
        Value::Object(fields)
    } else {
        failure.clone()
    }
}

/// `best = widened && !(lastGood?.fetchedAt > widened.fetchedAt) ? widened : lastGood`
/// (`usage.mjs:768`), with JS's `undefined > x === false`.
fn pick_newer(candidate: Option<Value>, last_good: Option<&Value>) -> Option<Value> {
    match (candidate, last_good) {
        (Some(candidate), Some(last)) => {
            let last_newer = match (
                last.get("fetchedAt").and_then(Value::as_str),
                candidate.get("fetchedAt").and_then(Value::as_str),
            ) {
                (Some(last), Some(candidate)) => last > candidate,
                _ => false,
            };
            if last_newer {
                Some(last.clone())
            } else {
                Some(candidate)
            }
        }
        (Some(candidate), None) => Some(candidate),
        (None, last) => last.cloned(),
    }
}

fn has_complete_window(window: Option<&Value>) -> bool {
    let Some(window) = window.filter(|value| !value.is_null()) else {
        return false;
    };
    window.get("started") == Some(&Value::Bool(false))
        || window
            .get("resetsAt")
            .and_then(Value::as_str)
            .and_then(usage_snapshot::parse_date_ms)
            .is_some()
}

fn has_active_window(window: Option<&Value>, now: i64) -> bool {
    window
        .filter(|value| !value.is_null())
        .and_then(|window| window.get("resetsAt"))
        .and_then(Value::as_str)
        .and_then(usage_snapshot::parse_date_ms)
        .is_some_and(|resets_at| resets_at > now)
}

fn prefer_current_window(current: Option<&Value>, previous: Option<&Value>, now: i64) -> Value {
    if has_complete_window(current) || !has_active_window(previous, now) {
        current.cloned().unwrap_or(Value::Null)
    } else {
        previous.cloned().unwrap_or(Value::Null)
    }
}

/// `win(w) = { pctUsed: w.utilization, resetsAt: w.resets_at ?? null, models: [] }`
/// (`usage.mjs:200`).
fn cost_window(window: Option<&SnapshotWindow>) -> Value {
    let Some(window) = window else {
        return Value::Null;
    };
    json!({
        "pctUsed": window.utilization,
        "resetsAt": raw_value(window.resets_at.as_deref()),
        "models": [],
    })
}

/// `{ pctUsed, resetsAt }` as `append_claude`'s cost-state branch reads it.
fn cost_reading(window: Option<&SnapshotWindow>) -> Value {
    let mut fields = Map::new();
    if let Some(window) = window {
        fields.insert("pctUsed".into(), json!(window.utilization));
        fields.insert("resetsAt".into(), raw_value(window.resets_at.as_deref()));
    }
    Value::Object(fields)
}

/// `readCodexSnapshot`'s projection (`usage.mjs:173`).
fn codex_window(window: Option<&SnapshotWindow>) -> Value {
    let Some(window) = window else {
        return Value::Null;
    };
    let mut fields = Map::new();
    fields.insert("pctUsed".into(), json!(window.utilization));
    fields.insert("resetsAt".into(), raw_value(window.resets_at.as_deref()));
    fields.insert("models".into(), Value::Array(Vec::new()));
    if window.started == Some(false) {
        fields.insert("started".into(), Value::Bool(false));
    }
    Value::Object(fields)
}

fn merge_codex_snapshot(snapshot: &CodexSnapshot, previous: Option<&Value>, now: i64) -> Value {
    let session = prefer_current_window(
        Some(&codex_window(snapshot.session.as_ref())),
        previous.and_then(|previous| previous.get("session")),
        now,
    );
    let weekly = prefer_current_window(
        Some(&codex_window(snapshot.weekly.as_ref())),
        previous.and_then(|previous| previous.get("weekly")),
        now,
    );
    json!({
        "ok": true,
        "source": "codex",
        "plan": raw_value(snapshot.plan.as_deref()),
        "fetchedAt": snapshot.fetched_at.clone(),
        "session": session,
        "weekly": weekly,
    })
}

fn normalize_claude(raw: &RawValue, plan: Option<&str>) -> Result<Value, String> {
    let request = provider_usage::Request {
        provider: "claude".to_owned(),
        payload_present: true,
        payload: RawValue::from_string(raw.get().to_owned()).map_err(|error| error.to_string())?,
        plan: plan
            .map(|plan| RawValue::from_string(Value::String(plan.to_owned()).to_string()))
            .transpose()
            .map_err(|error| error.to_string())?,
        fetched_at: None,
    };
    let output = provider_usage::normalize(&request)?;
    serde_json::from_str(output.get()).map_err(|error| error.to_string())
}

fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn sha256_hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let digest = ring::digest::digest(&ring::digest::SHA256, bytes);
    let mut hex = String::with_capacity(64);
    for byte in digest.as_ref() {
        let _ = write!(&mut hex, "{byte:02x}");
    }
    hex
}

/// `new Date(ms).toISOString()`.
pub(crate) fn iso_ms(ms: i64) -> String {
    let Ok(date) = time::OffsetDateTime::from_unix_timestamp_nanos(i128::from(ms) * 1_000_000)
    else {
        return String::new();
    };
    let date = date.to_offset(time::UtcOffset::UTC);
    let year = date.year();
    let year = if (0..=9999).contains(&year) {
        format!("{year:04}")
    } else {
        format!("{year:+07}")
    };
    format!(
        "{year}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        u8::from(date.month()),
        date.day(),
        date.hour(),
        date.minute(),
        date.second(),
        date.millisecond()
    )
}

/// `newestSnapshotArchive()` (`usage-history.mjs:17`): newest monthly archive in
/// the usage-report state root.
fn newest_snapshot_archive(directory: &Path) -> Option<PathBuf> {
    let entries = std::fs::read_dir(directory).ok()?;
    let mut names: Vec<String> = entries
        .flatten()
        .filter_map(|entry| entry.file_name().to_str().map(str::to_owned))
        .filter(|name| is_snapshot_archive(name))
        .collect();
    names.sort();
    names.pop().map(|name| directory.join(name))
}

fn is_snapshot_archive(name: &str) -> bool {
    let Some(stem) = name
        .strip_prefix("usage-snapshots-")
        .and_then(|rest| rest.strip_suffix(".jsonl"))
    else {
        return false;
    };
    let bytes = stem.as_bytes();
    bytes.len() == 7
        && bytes[4] == b'-'
        && bytes[..4].iter().all(u8::is_ascii_digit)
        && bytes[5..].iter().all(u8::is_ascii_digit)
}

fn single_value(query: &str, name: &str) -> Option<String> {
    match query_values(query, name).as_slice() {
        [value] => Some(value.clone()),
        _ => None,
    }
}

fn invalid_history_query() -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({
            "ok": false,
            "error": format!(
                "provider must be one of {}; window one of {}",
                HISTORY_PROVIDERS.join(", "),
                HISTORY_WINDOWS.join(", ")
            ),
        })),
    )
        .into_response()
}

/// Fastify's default error handler body for a thrown handler error.
fn fastify_internal(message: &str) -> Response {
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

async fn blocking<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> Option<T> {
    tokio::task::spawn_blocking(work).await.ok()
}

fn with_snapshots<T>(
    snapshots: &Arc<Mutex<SnapshotService>>,
    work: impl FnOnce(&mut SnapshotService) -> T,
) -> T {
    let mut service = snapshots.lock().unwrap_or_else(|error| error.into_inner());
    work(&mut service)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicI64, AtomicUsize, Ordering};
    use tokio::sync::oneshot;

    /// 2027-01-15T08:00:00.000Z.
    const NOW: i64 = 1_800_000_000_000;

    struct Fixture(PathBuf);

    impl Fixture {
        fn new(label: &str) -> Self {
            let nonce = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let root = std::env::temp_dir().join(format!(
                "singularity-http-usage-{label}-{}-{nonce}",
                std::process::id()
            ));
            for dir in ["state", "usage", "claude", "codex"] {
                std::fs::create_dir_all(root.join(dir)).unwrap();
            }
            Self(root)
        }

        fn state_dir(&self) -> PathBuf {
            self.0.join("state")
        }

        fn usage_dir(&self) -> PathBuf {
            self.0.join("usage")
        }

        fn claude_home(&self) -> PathBuf {
            self.0.join("claude")
        }

        fn codex_home(&self) -> PathBuf {
            self.0.join("codex")
        }

        fn write(&self, path: PathBuf, text: &str) {
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).unwrap();
            }
            std::fs::write(path, text).unwrap();
        }

        /// `clearClaudeLocal` (`usage.test.mjs`): a successful network pull feeds
        /// its reading back into the snapshot log, and complete local windows
        /// answer every later call — force included. Drop the free tiers so the
        /// next pull has only the gates left to stop it.
        fn clear_claude_local(&self) {
            let usage = self.usage_dir();
            let _ = std::fs::remove_file(usage.join("usage-snapshots.jsonl"));
            let _ = std::fs::remove_dir_all(usage.join("cost-state"));
        }

        fn write_credentials(&self) {
            self.write(
                self.claude_home().join(".credentials.json"),
                &json!({
                    "claudeAiOauth": {
                        "accessToken": "synthetic-access-token",
                        "refreshToken": "synthetic-refresh-token",
                        "expiresAt": NOW + 3_600_000,
                        "subscriptionType": "pro",
                    }
                })
                .to_string(),
            );
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    struct ClaudeReply {
        status: u16,
        retry_after: Option<String>,
        body: Value,
    }

    struct StubNetwork {
        claude_calls: AtomicUsize,
        codex_calls: AtomicUsize,
        ollama_calls: AtomicUsize,
        connect_calls: AtomicUsize,
        claude: Mutex<ClaudeReply>,
        codex_ok: AtomicBool,
        resets: Mutex<Option<Value>>,
        ollama: Mutex<Value>,
        connect: Mutex<Value>,
    }

    impl Default for StubNetwork {
        fn default() -> Self {
            Self {
                claude_calls: AtomicUsize::new(0),
                codex_calls: AtomicUsize::new(0),
                ollama_calls: AtomicUsize::new(0),
                connect_calls: AtomicUsize::new(0),
                claude: Mutex::new(ClaudeReply {
                    status: 200,
                    retry_after: None,
                    body: json!({
                        "five_hour": {
                            "utilization": 42,
                            "resets_at": iso_ms(NOW + 3_600_000),
                        },
                        "seven_day": {
                            "utilization": 7,
                            "resets_at": iso_ms(NOW + 3 * 86_400_000),
                        },
                    }),
                }),
                codex_ok: AtomicBool::new(false),
                resets: Mutex::new(None),
                ollama: Mutex::new(json!({
                    "ok": false,
                    "source": "ollama",
                    "error": "unavailable",
                })),
                connect: Mutex::new(json!({
                    "ok": false,
                    "source": "ollama",
                    "error": "unavailable",
                })),
            }
        }
    }

    impl UsageNetwork for StubNetwork {
        fn claude_usage<'a>(&'a self, _access_token: &'a str) -> BoxFuture<'a, ClaudeUsageResult> {
            self.claude_calls.fetch_add(1, Ordering::SeqCst);
            let (status, retry_after, body) = {
                let reply = self.claude.lock().unwrap();
                (
                    reply.status,
                    reply.retry_after.clone(),
                    reply.body.to_string(),
                )
            };
            Box::pin(async move {
                ClaudeUsageResult::Response {
                    status,
                    retry_after,
                    body: Ok(Some(body)),
                }
            })
        }

        fn codex_usage<'a>(&'a self, _auth_path: &'a Path) -> BoxFuture<'a, CodexUsageResult> {
            self.codex_calls.fetch_add(1, Ordering::SeqCst);
            if !self.codex_ok.load(Ordering::SeqCst) {
                return Box::pin(async { CodexUsageResult::NoSessions });
            }
            let payload = json!({
                "plan_type": "pro",
                "rate_limit": {
                    "primary_window": {
                        "used_percent": 17,
                        "limit_window_seconds": 18_000,
                        "reset_at": (NOW + 3_600_000) / 1_000,
                    },
                    "secondary_window": {
                        "used_percent": 3,
                        "limit_window_seconds": 604_800,
                        "reset_at": (NOW + 5 * 86_400_000) / 1_000,
                    },
                },
            })
            .to_string();
            Box::pin(async move {
                CodexUsageResult::Response {
                    status: 200,
                    retry_after: None,
                    body: Ok(Some(payload)),
                }
            })
        }

        fn codex_resets<'a>(&'a self, _auth_path: &'a Path) -> BoxFuture<'a, Option<Value>> {
            let value = self.resets.lock().unwrap().clone();
            Box::pin(async move { value })
        }

        fn ollama_usage(&self) -> BoxFuture<'_, Value> {
            self.ollama_calls.fetch_add(1, Ordering::SeqCst);
            let value = self.ollama.lock().unwrap().clone();
            Box::pin(async move { value })
        }

        fn ollama_connect(&self) -> BoxFuture<'_, Value> {
            self.connect_calls.fetch_add(1, Ordering::SeqCst);
            let value = self.connect.lock().unwrap().clone();
            Box::pin(async move { value })
        }
    }

    fn clock() -> Arc<dyn Fn() -> i64 + Send + Sync> {
        Arc::new(|| NOW)
    }

    fn deps(fixture: &Fixture, network: Arc<dyn UsageNetwork>, bus: Bus) -> UsageDeps {
        UsageDeps {
            bus,
            state_dir: fixture.state_dir(),
            usage_state: fixture.usage_dir(),
            claude_home: fixture.claude_home(),
            codex_home: fixture.codex_home(),
            platform: Platform::host(),
            parent_env: BTreeMap::new(),
            security_bin: None,
            network,
            clock: clock(),
        }
    }

    type Server = (
        String,
        oneshot::Sender<()>,
        tokio::task::JoinHandle<std::io::Result<()>>,
    );

    fn runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap()
    }

    async fn start(deps: UsageDeps) -> Server {
        start_router(router(deps)).await
    }

    async fn start_router(router: Router) -> Server {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (stop, stopped) = oneshot::channel::<()>();
        let server = tokio::spawn(async move {
            axum::serve(listener, router)
                .with_graceful_shutdown(async move {
                    let _ = stopped.await;
                })
                .await
        });
        (format!("http://{address}"), stop, server)
    }

    async fn shutdown(server: Server) {
        let (_, stop, handle) = server;
        stop.send(()).unwrap();
        handle.await.unwrap().unwrap();
    }

    async fn get_json(url: &str) -> (u16, Value) {
        let response = reqwest::Client::new().get(url).send().await.unwrap();
        let status = response.status().as_u16();
        let text = response.text().await.unwrap();
        (status, serde_json::from_str(&text).unwrap_or(Value::Null))
    }

    /// `POST` with no body, like the Connect button.
    async fn post_json(url: &str) -> (u16, Value) {
        let response = reqwest::Client::new().post(url).send().await.unwrap();
        let status = response.status().as_u16();
        let text = response.text().await.unwrap();
        (status, serde_json::from_str(&text).unwrap_or(Value::Null))
    }

    /// A successful `connectOllamaUsage` result before sanitization.
    fn connect_ok() -> Value {
        json!({
            "ok": true,
            "source": "ollama",
            "plan": "pro",
            "session": {
                "pctUsed": 40,
                "resetsAt": "2026-10-29T05:00:00.000Z",
                "models": [{ "model": "llama3.3:70b", "requests": 7 }],
            },
            "weekly": {
                "pctUsed": 5,
                "resetsAt": "2026-11-04T00:00:00.000Z",
                "models": [],
            },
            "extra": null,
        })
    }

    fn ollama_json(fixture: &Fixture) -> PathBuf {
        fixture.state_dir().join("ollama.json")
    }

    fn snapshot_row() -> String {
        json!({
            "fetched_at": iso_ms(NOW - 1_000),
            "raw": {
                "five_hour": {
                    "utilization": 42,
                    "resets_at": iso_ms(NOW + 3_600_000),
                },
                "seven_day": {
                    "utilization": 7,
                    "resets_at": iso_ms(NOW + 3 * 86_400_000),
                },
            },
        })
        .to_string()
    }

    #[test]
    fn cold_usage_returns_all_three_sources_and_never_calls_claude_without_credentials() {
        let fixture = Fixture::new("cold");
        let network = Arc::new(StubNetwork::default());
        runtime().block_on(async {
            let server = start(deps(&fixture, network.clone(), Bus::new())).await;

            let (status, body) = get_json(&format!("{}/api/usage", server.0)).await;
            assert_eq!(status, 200);
            let keys: Vec<&str> = body
                .as_object()
                .unwrap()
                .keys()
                .map(String::as_str)
                .collect();
            assert_eq!(keys, ["ollama", "claude", "codex"], "{body}");
            assert_eq!(body["claude"]["ok"], false);
            assert_eq!(body["claude"]["error"].as_str(), Some("no-credentials"));
            assert_eq!(body["claude"]["needsAuth"], true);
            assert_eq!(body["ollama"]["error"].as_str(), Some("no-config"));
            assert_eq!(body["ollama"]["needsAuth"], true);
            assert_eq!(
                body["codex"]["error"].as_str(),
                Some("no Codex sessions found")
            );
            assert_eq!(
                body["claude"]["fetchedAt"], body["codex"]["fetchedAt"],
                "both failures carry the injected clock"
            );
            assert_eq!(network.claude_calls.load(Ordering::SeqCst), 0);
            assert_eq!(network.ollama_calls.load(Ordering::SeqCst), 0);
            assert_eq!(
                network.codex_calls.load(Ordering::SeqCst),
                1,
                "the codex lane asks the seam, which reports no sessions"
            );

            shutdown(server).await;
        });
    }

    #[test]
    fn claude_body_cedar_ember_becomes_resets_in_one_request_per_forced_refresh() {
        let fixture = Fixture::new("claude-resets");
        fixture.write_credentials();
        let network = Arc::new(StubNetwork::default());
        network.claude.lock().unwrap().body = json!({
            "five_hour": { "utilization": 42, "resets_at": iso_ms(NOW + 3_600_000) },
            "seven_day": { "utilization": 7, "resets_at": iso_ms(NOW + 3 * 86_400_000) },
            "cedar_ember": { "eligible": true, "grants": [
                { "resets_left": 2, "ends_at": "2026-12-10T22:00:00+00:00" },
            ] },
        });
        runtime().block_on(async {
            let server = start(deps(&fixture, network.clone(), Bus::new())).await;
            let (status, body) =
                get_json(&format!("{}/api/usage?force=1&source=claude", server.0)).await;
            assert_eq!(status, 200);
            assert_eq!(
                body["claude"]["resets"],
                json!({ "available": 2, "expiresAt": ["2026-12-10T22:00:00.000Z"] }),
                "{body}"
            );
            assert_eq!(network.claude_calls.load(Ordering::SeqCst), 1);
            shutdown(server).await;
        });
    }

    #[test]
    fn local_claude_reading_keeps_resets_and_refetches_them_once_per_ttl() {
        let fixture = Fixture::new("claude-local-resets");
        fixture.write_credentials();
        let network = Arc::new(StubNetwork::default());
        let grants = |left: u64| {
            json!({
                "five_hour": { "utilization": 42, "resets_at": iso_ms(NOW + 3_600_000) },
                "seven_day": { "utilization": 7, "resets_at": iso_ms(NOW + 3 * 86_400_000) },
                "cedar_ember": { "eligible": true, "grants": [
                    { "resets_left": left, "ends_at": "2026-12-10T22:00:00+00:00" },
                ] },
            })
        };
        network.claude.lock().unwrap().body = grants(2);
        let clock_ms = Arc::new(AtomicI64::new(NOW));
        let write_local = |at: i64| {
            let mut row: Value = serde_json::from_str(&snapshot_row()).unwrap();
            row["fetched_at"] = json!(iso_ms(at - 1_000));
            fixture.write(
                fixture.usage_dir().join("usage-snapshots.jsonl"),
                &format!("{row}\n"),
            );
        };
        write_local(NOW);
        runtime().block_on(async {
            let mut deps = deps(&fixture, network.clone(), Bus::new());
            let handle = clock_ms.clone();
            deps.clock = Arc::new(move || handle.load(Ordering::SeqCst));
            let server = start(deps).await;
            let url = format!("{}/api/usage?force=1&source=claude", server.0);
            let want = |left: u64| {
                json!({ "available": left, "expiresAt": ["2026-12-10T22:00:00.000Z"] })
            };

            let (_, body) = get_json(&url).await;
            assert_eq!(body["claude"]["resets"], want(2), "{body}");
            assert_eq!(network.claude_calls.load(Ordering::SeqCst), 1);

            // Fresh local reading inside the TTL: resets carried, no call.
            clock_ms.store(NOW + 5 * 60_000, Ordering::SeqCst);
            write_local(NOW + 5 * 60_000);
            network.claude.lock().unwrap().body = grants(5);
            let (_, body) = get_json(&url).await;
            assert_eq!(body["claude"]["resets"], want(2), "{body}");
            assert_eq!(network.claude_calls.load(Ordering::SeqCst), 1);

            // Past the TTL: exactly one call, resets updated.
            clock_ms.store(NOW + 11 * 60_000, Ordering::SeqCst);
            write_local(NOW + 11 * 60_000);
            let (_, body) = get_json(&url).await;
            assert_eq!(body["claude"]["resets"], want(5), "{body}");
            assert_eq!(network.claude_calls.load(Ordering::SeqCst), 2);
            shutdown(server).await;
        });
    }

    #[test]
    fn codex_resets_attach_and_a_failed_read_keeps_the_last_count() {
        let fixture = Fixture::new("resets");
        let network = Arc::new(StubNetwork::default());
        network.codex_ok.store(true, Ordering::SeqCst);
        *network.resets.lock().unwrap() = Some(json!({ "available": 1, "expiresAt": [] }));
        runtime().block_on(async {
            let server = start(deps(&fixture, network.clone(), Bus::new())).await;
            let url = format!("{}/api/usage?force=1&source=codex", server.0);
            let (status, body) = get_json(&url).await;
            assert_eq!(status, 200);
            assert_eq!(
                body["codex"]["resets"],
                json!({ "available": 1, "expiresAt": [] }),
                "{body}"
            );

            *network.resets.lock().unwrap() = None;
            let (_, body) = get_json(&url).await;
            assert_eq!(
                body["codex"]["resets"],
                json!({ "available": 1, "expiresAt": [] }),
                "{body}"
            );
            shutdown(server).await;
        });
    }

    #[test]
    fn repeated_source_filter_limits_the_network_and_force_repeats_the_attempt() {
        let fixture = Fixture::new("sources");
        fixture.write_credentials();
        let network = Arc::new(StubNetwork::default());
        network.codex_ok.store(true, Ordering::SeqCst);
        runtime().block_on(async {
            let server = start(deps(&fixture, network.clone(), Bus::new())).await;

            let (status, body) = get_json(&format!(
                "{}/api/usage?force=1&source=claude&source=claude",
                server.0
            ))
            .await;
            assert_eq!(status, 200);
            assert_eq!(body["claude"]["ok"], true, "{body}");
            assert_eq!(body["claude"]["session"]["pctUsed"].as_f64(), Some(42.0));
            assert!(body["codex"].is_null(), "{body}");
            assert!(body["ollama"].is_null(), "{body}");
            assert_eq!(network.claude_calls.load(Ordering::SeqCst), 1);
            assert_eq!(network.codex_calls.load(Ordering::SeqCst), 0);
            assert_eq!(network.ollama_calls.load(Ordering::SeqCst), 0);

            // force=1 always retries, even with a warm cache.
            fixture.clear_claude_local();
            let (_, _) = get_json(&format!("{}/api/usage?force=1&source=claude", server.0)).await;
            assert_eq!(network.claude_calls.load(Ordering::SeqCst), 2);

            // An unknown source value is filtered out, leaving all three lanes.
            fixture.clear_claude_local();
            let (_, _) = get_json(&format!("{}/api/usage?force=1&source=bogus", server.0)).await;
            assert_eq!(network.claude_calls.load(Ordering::SeqCst), 3);
            assert_eq!(network.codex_calls.load(Ordering::SeqCst), 1);
            assert_eq!(network.ollama_calls.load(Ordering::SeqCst), 0);

            shutdown(server).await;
        });
    }

    #[test]
    fn the_network_floor_holds_automated_pulls_and_force_bypasses_it() {
        let fixture = Fixture::new("floor");
        fixture.write_credentials();
        let network = Arc::new(StubNetwork::default());
        runtime().block_on(async {
            let server = start(deps(&fixture, network.clone(), Bus::new())).await;

            let (_, first) = get_json(&format!("{}/api/usage?source=claude", server.0)).await;
            assert_eq!(first["claude"]["ok"], true, "{first}");
            assert_eq!(network.claude_calls.load(Ordering::SeqCst), 1);

            // Same frozen clock: the 60s floor answers from cache.
            let (_, second) = get_json(&format!("{}/api/usage?source=claude", server.0)).await;
            assert_eq!(second, first);
            assert_eq!(network.claude_calls.load(Ordering::SeqCst), 1);

            fixture.clear_claude_local();
            let (_, _) = get_json(&format!("{}/api/usage?force=1&source=claude", server.0)).await;
            assert_eq!(network.claude_calls.load(Ordering::SeqCst), 2);

            shutdown(server).await;
        });
    }

    #[test]
    fn a_fresh_local_snapshot_answers_claude_without_the_network() {
        let fixture = Fixture::new("snapshot");
        fixture.write_credentials();
        fixture.write(
            fixture.usage_dir().join("usage-snapshots.jsonl"),
            &format!("{}\n", snapshot_row()),
        );
        let network = Arc::new(StubNetwork::default());
        runtime().block_on(async {
            let server = start(deps(&fixture, network.clone(), Bus::new())).await;

            let (status, body) = get_json(&format!("{}/api/usage?source=claude", server.0)).await;
            assert_eq!(status, 200);
            let claude = &body["claude"];
            assert_eq!(claude["ok"], true, "{body}");
            assert_eq!(claude["plan"].as_str(), Some("pro"));
            assert_eq!(claude["session"]["pctUsed"].as_f64(), Some(42.0));
            assert_eq!(claude["weekly"]["pctUsed"].as_f64(), Some(7.0));
            let fetched_at = iso_ms(NOW - 1_000);
            assert_eq!(claude["fetchedAt"].as_str(), Some(fetched_at.as_str()));
            // The card comes from the local file; the only call is the
            // resets-only one (the stub body has no grants).
            assert_eq!(network.claude_calls.load(Ordering::SeqCst), 1);
            assert!(claude.get("resets").is_none(), "{body}");

            shutdown(server).await;
        });
    }

    #[test]
    fn usage_events_are_pushed_on_force_and_only_on_change_otherwise() {
        let fixture = Fixture::new("bus");
        let network = Arc::new(StubNetwork::default());
        let bus = Bus::new();
        runtime().block_on(async {
            let seen = Arc::new(Mutex::new(Vec::new()));
            {
                let seen = Arc::clone(&seen);
                bus.subscribe(Arc::new(move |event| {
                    if let BusEvent::Usage(document) = event {
                        seen.lock().unwrap().push(document.clone());
                    }
                }));
            }
            let server = start(deps(&fixture, network.clone(), bus.clone())).await;

            let (_, first) = get_json(&format!("{}/api/usage?source=ollama", server.0)).await;
            assert_eq!(
                seen.lock().unwrap().len(),
                1,
                "the first document is a change"
            );

            let (_, second) = get_json(&format!("{}/api/usage?source=ollama", server.0)).await;
            assert_eq!(second, first);
            assert_eq!(seen.lock().unwrap().len(), 1, "an identical tick is silent");

            let (_, forced) =
                get_json(&format!("{}/api/usage?force=1&source=ollama", server.0)).await;
            assert_eq!(forced, first);
            assert_eq!(seen.lock().unwrap().len(), 2, "force always pushes");

            // Browser mode turns the ollama lane into a real reading.
            fixture.write(
                fixture.state_dir().join("ollama.json"),
                r#"{"mode":"browser"}"#,
            );
            *network.ollama.lock().unwrap() = json!({
                "ok": true,
                "source": "ollama",
                "plan": "pro",
                "session": {
                    "pctUsed": 5,
                    "resetsAt": iso_ms(NOW + 3_600_000),
                    "models": [],
                },
                "weekly": {
                    "pctUsed": 9,
                    "resetsAt": iso_ms(NOW + 3 * 86_400_000),
                    "models": [],
                },
                "extra": null,
            });
            let (_, changed) =
                get_json(&format!("{}/api/usage?force=1&source=ollama", server.0)).await;
            assert_eq!(changed["ollama"]["ok"], true, "{changed}");
            assert_eq!(changed["ollama"]["historyPaused"], Value::Null);
            assert_eq!(network.ollama_calls.load(Ordering::SeqCst), 1);
            let seen = seen.lock().unwrap();
            assert_eq!(seen.len(), 3);
            assert_eq!(seen[2], changed);
            drop(seen);

            let history = std::fs::read_to_string(fixture.usage_dir().join("ollama-usage.jsonl"))
                .expect("a successful ollama read appends history");
            let row: Value = serde_json::from_str(history.lines().next().unwrap()).unwrap();
            assert_eq!(row["session"]["utilization"].as_f64(), Some(5.0));

            shutdown(server).await;
        });
    }

    #[test]
    fn the_usage_handle_forces_a_pull_filters_the_lanes_and_emits() {
        let fixture = Fixture::new("handle");
        fixture.write_credentials();
        let network = Arc::new(StubNetwork::default());
        let bus = Bus::new();
        runtime().block_on(async {
            let seen = Arc::new(Mutex::new(Vec::new()));
            {
                let seen = Arc::clone(&seen);
                bus.subscribe(Arc::new(move |event| {
                    if let BusEvent::Usage(document) = event {
                        seen.lock().unwrap().push(document.clone());
                    }
                }));
            }
            let (_router, handle) =
                router_with_handle(deps(&fixture, network.clone(), bus.clone()));

            let document = handle.refresh("claude").await.unwrap();
            assert_eq!(document["claude"]["ok"], true, "{document}");
            assert_eq!(
                document["claude"]["session"]["pctUsed"].as_f64(),
                Some(42.0)
            );
            assert!(document["codex"].is_null(), "{document}");
            assert!(document["ollama"].is_null(), "{document}");
            assert_eq!(network.claude_calls.load(Ordering::SeqCst), 1);
            assert_eq!(network.codex_calls.load(Ordering::SeqCst), 0);
            assert_eq!(network.ollama_calls.load(Ordering::SeqCst), 0);

            // `refresh` is forced: the 60s floor never answers it from cache.
            fixture.clear_claude_local();
            let _ = handle.refresh("claude").await.unwrap();
            assert_eq!(network.claude_calls.load(Ordering::SeqCst), 2);

            let seen = seen.lock().unwrap();
            assert_eq!(seen.len(), 2, "every forced refresh pushes");
            assert_eq!(seen[0], document);
        });
    }

    #[test]
    fn history_validates_provider_and_window_before_reading_anything() {
        let fixture = Fixture::new("history-invalid");
        let network = Arc::new(StubNetwork::default());
        runtime().block_on(async {
            let server = start(deps(&fixture, network.clone(), Bus::new())).await;
            let expected = json!({
                "ok": false,
                "error": "provider must be one of claude, codex, ollama; window one of 5h, 7d",
            });
            for query in [
                "",
                "?provider=bogus",
                "?provider=claude&window=1h",
                "?provider=claude&provider=codex",
                "?window=5h",
                "?provider=claude&window=",
            ] {
                let (status, body) =
                    get_json(&format!("{}/api/usage/history{query}", server.0)).await;
                assert_eq!(status, 400, "{query}");
                assert_eq!(body, expected, "{query}");
            }

            let (status, body) =
                get_json(&format!("{}/api/usage/history?provider=ollama", server.0)).await;
            assert_eq!(status, 200);
            assert_eq!(body["provider"].as_str(), Some("ollama"));
            assert_eq!(body["window"].as_str(), Some("5h"));
            assert_eq!(body["estimated"], false);
            assert_eq!(body["points"], json!([]));

            let (status, body) = get_json(&format!(
                "{}/api/usage/history?provider=claude&window=7d",
                server.0
            ))
            .await;
            assert_eq!(status, 200);
            assert_eq!(body["window"].as_str(), Some("7d"));
            assert_eq!(body["estimated"], false);

            shutdown(server).await;
        });
    }

    #[test]
    fn history_reads_the_injected_roots_and_keeps_the_document_shape() {
        let fixture = Fixture::new("history-doc");
        fixture.write(
            fixture.usage_dir().join("usage-snapshots.jsonl"),
            &format!("{}\n", snapshot_row()),
        );
        let network = Arc::new(StubNetwork::default());
        runtime().block_on(async {
            let server = start(deps(&fixture, network.clone(), Bus::new())).await;

            let (status, body) = get_json(&format!(
                "{}/api/usage/history?provider=claude&window=5h",
                server.0
            ))
            .await;
            assert_eq!(status, 200);
            assert_eq!(body["provider"].as_str(), Some("claude"));
            assert_eq!(body["window"].as_str(), Some("5h"));
            assert_eq!(body["estimated"], true);
            let points = body["points"].as_array().unwrap();
            assert_eq!(points.len(), 1, "{body}");
            assert_eq!(points[0]["pct"].as_f64(), Some(42.0));
            assert!(body["resetsAt"].as_str().is_some(), "{body}");
            assert!(body["windowStart"].as_str().is_some(), "{body}");
            assert_eq!(
                body["sessions"].as_array().unwrap().last().unwrap()["id"].as_str(),
                Some("_unattributed")
            );

            shutdown(server).await;
        });
    }

    // VERIFY: ollama-sanitize-shape
    #[test]
    fn the_sanitized_ollama_document_is_the_ten_key_projection() {
        let sanitized = sanitize_ollama(json!({
            "ok": 1,
            "source": "ignored",
            "plan": "pro",
            "session": { "pctUsed": 40, "resetsAt": null, "models": [] },
            "weekly": null,
            "extra": { "dropped": true },
            "needsAuth": "yes",
        }));
        assert_eq!(
            sanitized
                .as_object()
                .unwrap()
                .keys()
                .cloned()
                .collect::<Vec<String>>(),
            vec![
                "ok",
                "source",
                "plan",
                "session",
                "weekly",
                "extra",
                "fetchedAt",
                "stale",
                "needsAuth",
                "error",
            ],
            "{sanitized}"
        );
        assert_eq!(sanitized["source"], json!("ollama"), "the source is forced");
        assert_eq!(sanitized["ok"], json!(true), "`!!data.ok`");
        assert_eq!(sanitized["needsAuth"], json!(true), "`!!data.needsAuth`");
        assert_eq!(sanitized["extra"], Value::Null);
        assert_eq!(sanitized["fetchedAt"], Value::Null);
        assert_eq!(sanitized["stale"], json!(false));
        assert_eq!(sanitized["error"], Value::Null);
        assert_eq!(sanitized["session"]["pctUsed"].as_f64(), Some(40.0));
    }

    // VERIFY: ollama-connect-400
    #[test]
    fn a_failed_connect_answers_400_and_writes_no_mode() {
        let fixture = Fixture::new("connect-fail");
        let network = Arc::new(StubNetwork::default());
        runtime().block_on(async {
            let server = start(deps(&fixture, network.clone(), Bus::new())).await;

            let (status, body) = post_json(&format!("{}/api/usage/ollama/connect", server.0)).await;
            assert_eq!(status, 400);
            assert_eq!(body["ok"], json!(false));
            assert_eq!(body["source"], json!("ollama"));
            assert_eq!(body["error"], json!("unavailable"));
            assert_eq!(body["needsAuth"], json!(false));
            assert_eq!(body["extra"], Value::Null);
            assert_eq!(network.connect_calls.load(Ordering::SeqCst), 1);
            assert!(
                !ollama_json(&fixture).exists(),
                "a failed connect never persists the mode"
            );

            shutdown(server).await;
        });
    }

    #[test]
    fn an_expired_login_answers_400_with_needs_auth() {
        let fixture = Fixture::new("connect-auth");
        let network = Arc::new(StubNetwork::default());
        *network.connect.lock().unwrap() = json!({
            "ok": false,
            "source": "ollama",
            "needsAuth": true,
            "error": "auth-expired",
        });
        runtime().block_on(async {
            let server = start(deps(&fixture, network.clone(), Bus::new())).await;

            let (status, body) = post_json(&format!("{}/api/usage/ollama/connect", server.0)).await;
            assert_eq!(status, 400);
            assert_eq!(body["error"], json!("auth-expired"));
            assert_eq!(body["needsAuth"], json!(true));
            assert!(!ollama_json(&fixture).exists());

            shutdown(server).await;
        });
    }

    // VERIFY: ollama-connect-200
    // VERIFY: ollama-mode-atomic
    #[test]
    fn a_successful_connect_writes_the_mode_atomically_and_returns_the_reading() {
        let fixture = Fixture::new("connect-ok");
        let network = Arc::new(StubNetwork::default());
        *network.connect.lock().unwrap() = connect_ok();
        runtime().block_on(async {
            let server = start(deps(&fixture, network.clone(), Bus::new())).await;

            let (status, body) = post_json(&format!("{}/api/usage/ollama/connect", server.0)).await;
            assert_eq!(status, 200, "{body}");
            assert_eq!(body["ok"], json!(true));
            assert_eq!(body["source"], json!("ollama"));
            assert_eq!(body["plan"], json!("pro"));
            assert_eq!(body["session"]["pctUsed"].as_f64(), Some(40.0));
            assert_eq!(
                body["fetchedAt"],
                json!(iso_ms(NOW)),
                "connect stamps the moment it verified"
            );
            assert_eq!(network.connect_calls.load(Ordering::SeqCst), 1);

            assert_eq!(
                std::fs::read_to_string(ollama_json(&fixture)).unwrap(),
                r#"{"mode":"browser"}"#
            );
            let leftovers: Vec<String> = std::fs::read_dir(fixture.state_dir())
                .unwrap()
                .flatten()
                .map(|entry| entry.file_name().to_string_lossy().into_owned())
                .filter(|name| name.ends_with(".tmp"))
                .collect();
            assert!(leftovers.is_empty(), "no temp file survives: {leftovers:?}");

            shutdown(server).await;
        });
    }

    // VERIFY: ollama-cache-clear
    #[test]
    fn a_successful_connect_clears_the_cache_so_a_later_failure_is_not_served_stale() {
        let fixture = Fixture::new("connect-cache");
        fixture.write(ollama_json(&fixture), r#"{"mode":"browser"}"#);
        let network = Arc::new(StubNetwork::default());
        *network.ollama.lock().unwrap() = json!({
            "ok": true,
            "source": "ollama",
            "plan": "pro",
            "session": { "pctUsed": 1, "resetsAt": null, "models": [] },
            "weekly": { "pctUsed": 2, "resetsAt": null, "models": [] },
            "extra": null,
        });
        *network.connect.lock().unwrap() = connect_ok();
        runtime().block_on(async {
            let server = start(deps(&fixture, network.clone(), Bus::new())).await;

            let (status, body) = get_json(&format!("{}/api/usage?source=ollama", server.0)).await;
            assert_eq!(status, 200);
            assert_eq!(body["ollama"]["ok"], json!(true));
            assert_eq!(network.ollama_calls.load(Ordering::SeqCst), 1);

            let (status, _) = post_json(&format!("{}/api/usage/ollama/connect", server.0)).await;
            assert_eq!(status, 200);

            // The next read must reach the seam (floor reset) and must not fall
            // back to the pre-connect reading as `stale` (data cleared).
            *network.ollama.lock().unwrap() = json!({
                "ok": false,
                "source": "ollama",
                "error": "boom",
            });
            let (status, body) = get_json(&format!("{}/api/usage?source=ollama", server.0)).await;
            assert_eq!(status, 200);
            assert_eq!(network.ollama_calls.load(Ordering::SeqCst), 2);
            assert_eq!(body["ollama"]["ok"], json!(false), "{body}");
            assert_eq!(body["ollama"]["error"], json!("boom"));
            assert_ne!(body["ollama"]["stale"], json!(true), "{body}");

            shutdown(server).await;
        });
    }

    // VERIFY: ollama-gate-clear
    // VERIFY: ollama-pause-clear
    #[test]
    fn a_successful_connect_clears_the_gate_and_a_paused_lane() {
        let fixture = Fixture::new("connect-gate");
        fixture.write(ollama_json(&fixture), r#"{"mode":"browser"}"#);
        let network = Arc::new(StubNetwork::default());
        *network.ollama.lock().unwrap() = json!({
            "ok": true,
            "source": "ollama",
            "plan": "pro",
            "session": { "pctUsed": 1, "resetsAt": null, "models": [] },
            "weekly": { "pctUsed": 2, "resetsAt": null, "models": [] },
            "extra": null,
        });
        *network.connect.lock().unwrap() = connect_ok();
        runtime().block_on(async {
            let (router, handle) = router_with_handle(deps(&fixture, network.clone(), Bus::new()));
            let server = start_router(router).await;

            // The history sampler gate must not suppress an explicit refresh.
            let (_, body) =
                get_json(&format!("{}/api/usage?force=1&source=ollama", server.0)).await;
            assert_eq!(body["ollama"]["ok"], json!(true));
            assert_eq!(network.ollama_calls.load(Ordering::SeqCst), 1);

            handle.arm_ollama_gate(60_000).await;
            let (_, body) =
                get_json(&format!("{}/api/usage?force=1&source=ollama", server.0)).await;
            assert_eq!(
                network.ollama_calls.load(Ordering::SeqCst),
                2,
                "manual refresh bypasses the history sampler gate"
            );
            assert_eq!(body["ollama"]["ok"], json!(true));

            handle.pause_history("auth-expired");
            assert_eq!(
                handle.ollama_state().await.history_paused.unwrap()["error"],
                json!("auth-expired")
            );

            let (status, _) = post_json(&format!("{}/api/usage/ollama/connect", server.0)).await;
            assert_eq!(status, 200);

            let (_, body) =
                get_json(&format!("{}/api/usage?force=1&source=ollama", server.0)).await;
            assert_eq!(
                network.ollama_calls.load(Ordering::SeqCst),
                3,
                "manual refresh remains available before and after connect"
            );
            assert_eq!(
                body["ollama"]["historyPaused"],
                Value::Null,
                "a successful connect re-enables the paused lane"
            );

            shutdown(server).await;
        });
    }

    #[test]
    fn a_mode_write_failure_answers_the_fastify_internal_error() {
        let fixture = Fixture::new("connect-write-fail");
        // A directory where `ollama.json` belongs makes the rename step fail.
        std::fs::create_dir_all(ollama_json(&fixture)).unwrap();
        let network = Arc::new(StubNetwork::default());
        *network.connect.lock().unwrap() = connect_ok();
        runtime().block_on(async {
            let server = start(deps(&fixture, network.clone(), Bus::new())).await;

            let (status, body) = post_json(&format!("{}/api/usage/ollama/connect", server.0)).await;
            assert_eq!(status, 500, "{body}");
            assert_eq!(body["statusCode"], json!(500));
            assert_eq!(body["error"], json!("Internal Server Error"));
            // Node throws the `fs` error, so Fastify's body carries the libuv
            // message; the fixed native string is gone. VERIFY: wave4-hostedits-11
            let message = body["message"].as_str().unwrap_or_default();
            assert!(
                message.contains(", rename '") && message.contains("ollama.json"),
                "{message}"
            );
            assert_ne!(body["message"], json!("ollama mode write failed"));

            shutdown(server).await;
        });
    }

    // VERIFY: wave6-small_parity-2
    /// Node's `fetchOllama` catches the `readFileSync` error and answers
    /// `bad ${OLLAMA_CFG}: ${e.message}` with libuv's text (`usage.mjs:405-412`).
    /// A directory where `ollama.json` belongs makes the read fail.
    #[test]
    fn an_ollama_read_failure_answers_the_libuv_message() {
        let fixture = Fixture::new("usage-read-fail");
        std::fs::create_dir_all(ollama_json(&fixture)).unwrap();
        let path = ollama_json(&fixture).to_string_lossy().into_owned();
        let network = Arc::new(StubNetwork::default());
        runtime().block_on(async {
            let server = start(deps(&fixture, network.clone(), Bus::new())).await;

            let (status, body) =
                get_json(&format!("{}/api/usage?force=1&source=ollama", server.0)).await;
            assert_eq!(status, 200, "{body}");
            assert_eq!(body["ollama"]["ok"], false);
            let error = body["ollama"]["error"].as_str().unwrap_or_default();
            // Node: `readFileSync(<dir>)` opens, then `read` fails with EISDIR.
            assert_eq!(
                error,
                format!("bad {path}: EISDIR: illegal operation on a directory, read")
            );
            assert_eq!(
                network.ollama_calls.load(Ordering::SeqCst),
                0,
                "an unreadable config never scrapes"
            );

            shutdown(server).await;
        });
    }

    // VERIFY: wave4-hostedits-12
    /// Node resolves the browser executable inside every launch
    /// (`usage.mjs:394-399`), so installing Edge after boot needs no restart.
    #[test]
    fn the_ollama_browser_is_resolved_on_every_launch() {
        let calls = Arc::new(AtomicUsize::new(0));
        let counter = calls.clone();
        let network = NativeUsageNetwork::with_resolver(
            PathBuf::from("profile"),
            Arc::new(move || {
                counter.fetch_add(1, Ordering::SeqCst);
                None
            }),
        );
        let _ = network.browser();
        let _ = network.browser();
        assert_eq!(
            calls.load(Ordering::SeqCst),
            2,
            "each launch re-resolves the executable, like playwright import"
        );
        assert_eq!(network.profile_dir, PathBuf::from("profile"));
    }
}
