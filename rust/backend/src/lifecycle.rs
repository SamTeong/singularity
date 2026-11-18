//! Native daemon lifecycle: registry/PTY/WS assembly, bind retry, drain,
//! restart and opt-in `--http` supervision.
//!
//! Port of `server/index.mjs:75-90` (startup), `:169-188` (shutdown) and
//! `:563-575` (`/restart`). Ordering follows `registry-design.md` §4:
//!
//! - Startup: load `agents.json`, start the 250 ms idle ticker, bind with
//!   `20 × 250 ms` retry, then serve HTTP + `/ws`.
//! - Shutdown (signal or `/api/restart`, re-entrancy guarded): `beginDrain`,
//!   kill live PTYs, poll `isLive` every 100 ms for at most 5 s, persist,
//!   `PtyHost::shutdown`, broadcast the 1001 close to every socket, graceful
//!   HTTP with a hard 1 s bound.
//! - `/api/restart` replies `{ok:true}` first; the supervisor waits 100 ms,
//!   drains, persists and only then respawns `current_exe --http` detached.

use std::collections::BTreeMap;
use std::future::Future;
use std::io;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{Value, json};
use tokio::net::TcpListener;
use tokio::sync::{mpsc, oneshot, watch};

use crate::agent_registry::{PtyPort, Registry, RegistryConfig, system_clock};
use crate::agent_spawn::{Bins, SpawnPaths};
use crate::app_paths::AppPaths;
use crate::bus::{Bus, BusEvent};
use crate::chat::ChatDeps;
use crate::http_policy::HttpPolicy;
use crate::http_server::{ConfigServices, HttpServices};
use crate::http_transcripts::TranscriptRegistry;
use crate::pty::{PtyEvent, PtyHost, PtySink};
use crate::transcript_service::{Inputs, TranscriptService};
use crate::window_anchor;

/// `for (let tries = 20; ...)` (`index.mjs:919`) with `250` ms between tries.
pub(crate) const BIND_ATTEMPTS: u32 = 20;
pub(crate) const BIND_RETRY: Duration = Duration::from_millis(250);
/// `Date.now() + 5000` (`index.mjs:181`).
const DRAIN_LIMIT: Duration = Duration::from_secs(5);
const DRAIN_POLL: Duration = Duration::from_millis(100);
/// Hard bound for the graceful HTTP shutdown (`registry-design.md` §4).
const GRACEFUL_LIMIT: Duration = Duration::from_secs(1);
/// `/restart` waits 100 ms after replying (`index.mjs:569-574`).
const RESTART_DELAY: Duration = Duration::from_millis(100);
/// `setInterval(..., 250)` idle ticker (`agents.mjs:233`).
const IDLE_TICK: Duration = Duration::from_millis(250);

/// The live pieces the host builds once and the router borrows. Owned by
/// [`HttpServices`], consumed by [`LifecycleHandles`] before serving.
pub struct RuntimeServices {
    pub(crate) registry: Arc<Registry>,
    pub(crate) tasks: Arc<crate::task_service::TaskService>,
    pub(crate) pty: Arc<PtyHost>,
    pub(crate) clients: Arc<AtomicUsize>,
    pub(crate) shutdown: watch::Sender<bool>,
    pub(crate) restart_tx: mpsc::UnboundedSender<()>,
    restart_rx: Option<mpsc::UnboundedReceiver<()>>,
    pub(crate) anchor: Arc<Mutex<window_anchor::Service>>,
    pub(crate) chat: ChatDeps,
    /// VERIFY: wave4-lifecycle-8
    /// Filled by the router (which builds them from this runtime) and read by
    /// [`shutdown`] through the cloned handles, so the cron tick, the cron
    /// status listener, the scheduler loops and their in-flight attempts are
    /// all stopped before the shutdown broadcast.
    pub(crate) crons: Arc<Mutex<Option<Arc<crate::crons::CronsService>>>>,
    pub(crate) background: Arc<Mutex<Option<crate::background_schedule::BackgroundScheduler>>>,
}

/// What the supervisor needs after the router took the rest.
pub struct LifecycleHandles {
    pub registry: Arc<Registry>,
    pub pty: Arc<PtyHost>,
    pub clients: Arc<AtomicUsize>,
    pub shutdown: watch::Sender<bool>,
    pub restart: mpsc::UnboundedReceiver<()>,
    /// The same slots as [`RuntimeServices`], cloned before the router is built.
    pub crons: Arc<Mutex<Option<Arc<crate::crons::CronsService>>>>,
    pub background: Arc<Mutex<Option<crate::background_schedule::BackgroundScheduler>>>,
    /// `None` in tests that do not build a board.
    pub tasks: Option<Arc<crate::task_service::TaskService>>,
}

// VERIFY: lifecycle-runtime-from-env
impl RuntimeServices {
    /// Builds the PTY host, registry, anchor service, chat deps and the shared
    /// shutdown/restart channels from the injected host config.
    pub fn from_env(paths: &AppPaths, config: &ConfigServices) -> io::Result<Self> {
        std::fs::create_dir_all(&paths.state_dir)?;
        std::fs::create_dir_all(&paths.cache_dir)?;

        let bus = Bus::new();
        // Break the registry ⇄ PTY cycle: the sink resolves the registry once it
        // exists, exactly like Node's `reg.onData` wiring after construction.
        let registry_slot: Arc<OnceLock<Arc<Registry>>> = Arc::new(OnceLock::new());
        let sink_slot = registry_slot.clone();
        let sink: PtySink = Arc::new(move |event: PtyEvent| {
            if let Some(registry) = sink_slot.get() {
                registry.on_pty_event(event);
            }
        });
        let pty = Arc::new(PtyHost::new(sink));

        let claude = std::env::var("CLAUDE_BIN").ok();
        let ollama = std::env::var("OLLAMA_BIN").ok();
        let codex = std::env::var("CODEX_BIN").ok();
        let bins = Bins::resolve(
            claude.as_deref(),
            ollama.as_deref(),
            codex.as_deref(),
            SpawnPaths {
                home: config.home.clone(),
                scope_root: std::env::var_os("SING_SCOPE_ROOT")
                    .filter(|value| !value.is_empty())
                    .map(PathBuf::from),
                cache_dir: paths.cache_dir.clone(),
                codex_home: config.codex_home.clone(),
                models_state: paths.state_dir.join("models.json"),
            },
        );
        let port: Arc<dyn PtyPort> = pty.clone();
        let registry = Arc::new(Registry::new(
            bus.clone(),
            port,
            RegistryConfig {
                state_file: paths.state_dir.join("agents.json"),
                bins,
                parent_env: std::env::vars().collect(),
                clock: system_clock(),
            },
        ));
        let _ = registry_slot.set(registry.clone());
        let tasks = crate::runtime_domains::tasks(paths, config, registry.clone());

        let (shutdown, _) = watch::channel(false);
        let (restart_tx, restart_rx) = mpsc::unbounded_channel();
        let anchor = Arc::new(Mutex::new(init_anchor(paths, &bus)));
        let chat = build_chat(paths, config);
        let crons = Arc::new(Mutex::new(None));
        let background = Arc::new(Mutex::new(None));

        Ok(Self {
            registry,
            tasks,
            pty,
            clients: Arc::new(AtomicUsize::new(0)),
            shutdown,
            restart_tx,
            restart_rx: Some(restart_rx),
            anchor,
            chat,
            crons,
            background,
        })
    }

    // VERIFY: lifecycle-handles
    /// Moves the supervisor side out; the router keeps the clones it needs.
    pub fn handles(&mut self) -> LifecycleHandles {
        LifecycleHandles {
            registry: self.registry.clone(),
            pty: self.pty.clone(),
            clients: self.clients.clone(),
            shutdown: self.shutdown.clone(),
            restart: self
                .restart_rx
                .take()
                .expect("the lifecycle handles are taken once"),
            crons: self.crons.clone(),
            background: self.background.clone(),
            tasks: Some(self.tasks.clone()),
        }
    }
}

// VERIFY: lifecycle-transcript-registry
/// `http_transcripts::TranscriptRegistry` over the live agent registry.
impl TranscriptRegistry for Registry {
    fn is_live(&self, agent_id: &str) -> bool {
        Registry::is_live(self, agent_id)
    }

    fn is_live_codex_thread(&self, thread_id: &str, cwd: Option<&str>) -> bool {
        // `isLiveSession(id, { source: 'codex', cwd })` -> `codexOwnerForThread`
        // (`agents.mjs:140-156`). VERIFY: wave4-hostedits-2
        self.codex_owner_for_thread_in_cwd(thread_id, cwd).is_some()
    }

    fn codex_thread_for(&self, agent_id: &str) -> Option<String> {
        Registry::codex_thread_for(self, agent_id)
    }

    fn launch_scopes(&self, agent_id: &str) -> Option<Vec<String>> {
        self.get_launch_config(agent_id).map(|config| config.scopes)
    }

    fn codex_thread_scopes(&self, thread_id: &str, cwd: Option<&str>) -> Option<Vec<String>> {
        self.get_launch_config_for_codex_thread(Some(thread_id), cwd)
            .map(|config| config.scopes)
    }
}

// VERIFY: lifecycle-bind-retry
/// `app.listen` with Node's `EADDRINUSE` retry loop (`index.mjs:919-931`): a
/// `/restart` child waits for the old daemon to free the port, then gives up
/// with the Node log line and exit 1.
pub async fn bind_with_retry(port: u16, attempts: u32, delay: Duration) -> io::Result<TcpListener> {
    let attempts = attempts.max(1);
    for attempt in 1..=attempts {
        match crate::http_server::bind(port).await {
            Ok(listener) => return Ok(listener),
            Err(error) if error.kind() == io::ErrorKind::AddrInUse && attempt < attempts => {
                tokio::time::sleep(delay).await;
            }
            Err(error) if error.kind() == io::ErrorKind::AddrInUse => {
                return Err(io::Error::new(
                    io::ErrorKind::AddrInUse,
                    format!("port {port} already in use — is Singularity already running?"),
                ));
            }
            Err(error) => return Err(error),
        }
    }
    unreachable!("the loop returns on the last attempt")
}

/// Spawns the replacement daemon once the restart drain has finished.
///
/// VERIFY: wave9-restart_seam-1
/// Production passes [`respawn_current_exe`], so spawning behaviour is
/// unchanged; tests pass a recorder, so the restart path is covered without
/// starting a real process.
pub type Respawn = fn() -> Result<(), String>;

// VERIFY: lifecycle-shutdown
/// `shutdown()` (`index.mjs:174-186`) plus the native socket broadcast.
pub async fn shutdown(
    handles: &LifecycleHandles,
    restart: bool,
    guard: &AtomicBool,
    respawn: Respawn,
) {
    // `if (shuttingDown) return; shuttingDown = true;`
    if guard.swap(true, Ordering::SeqCst) {
        return;
    }
    handles.registry.begin_drain();
    let live: Vec<String> = handles
        .registry
        .snapshot()
        .into_iter()
        .filter(|agent| handles.registry.is_live(&agent.id))
        .map(|agent| agent.id)
        .collect();
    for id in &live {
        let _ = handles.registry.kill(id);
    }
    let deadline = Instant::now() + DRAIN_LIMIT;
    while live.iter().any(|id| handles.registry.is_live(id)) && Instant::now() < deadline {
        tokio::time::sleep(DRAIN_POLL).await;
    }
    // VERIFY: wave8-shutdown-1
    // A failed write is logged, never a reason to skip the respawn: Node's
    // restart route always respawns (`index.mjs:538-543`), so a write error
    // must not turn Restart into Stop.
    if let Err(error) = handles.registry.persist() {
        eprintln!("agents.json write failed: {error}");
    }
    handles.pty.shutdown();
    // VERIFY: wave4-lifecycle-8
    // Stop the router-installed services before the broadcast so nothing
    // re-arms work after it. They stop only after the drain poll and persist,
    // so a cron tick or idle-kill timer can still run inside that window, as
    // in Node (its intervals are never stopped). Node relies on process exit
    // (`.unref()`); this keeps that outcome without leaving the loops,
    // listeners and in-flight attempts alive in Rust.
    if let Some(crons) = handles.crons.lock().unwrap().take() {
        crons.shutdown();
    }
    if let Some(mut scheduler) = handles.background.lock().unwrap().take() {
        scheduler.stop();
    }
    if let Some(tasks) = &handles.tasks {
        tasks.shutdown();
    }
    if restart {
        // VERIFY: wave9-restart_seam-2
        // `respawn` is the injected seam; production binds it to
        // `respawn_current_exe` in [`run`].
        if let Err(error) = respawn() {
            eprintln!("restart failed: {error}");
        }
    }
    // Every `/ws` session watching this channel closes 1001 and returns.
    let _ = handles.shutdown.send(true);
}

/// `spawn(process.execPath, [...process.execArgv, process.argv[1]], {detached})`
/// (`index.mjs:569-573`), after the drain has persisted `agents.json`.
fn respawn_current_exe() -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|error| error.to_string())?;
    let exe = exe
        .to_str()
        .ok_or_else(|| "current executable path is not UTF-8".to_owned())?;
    let cwd = std::env::current_dir().ok();
    let cwd = cwd.as_deref().and_then(|path| path.to_str());
    let env = json!(std::env::vars().collect::<BTreeMap<String, String>>());
    let result = crate::detached::spawn(Some(exe), &json!(["--http"]), cwd, &env);
    if result["ok"] == Value::Bool(true) {
        Ok(())
    } else {
        Err(result["error"]
            .as_str()
            .unwrap_or("detached spawn failed")
            .to_owned())
    }
}

enum Stop {
    Signal,
    Restart,
}

// VERIFY: lifecycle-run
/// Serves until a signal or `/api/restart`, then shuts down and exits (0).
/// The process exit is the hard bound; everything before it is awaited.
pub async fn run(
    listener: TcpListener,
    policy: HttpPolicy,
    services: HttpServices,
    handles: LifecycleHandles,
) -> io::Result<()> {
    let ticker = handles.registry.clone();
    tokio::spawn(async move {
        let clock = system_clock();
        let mut interval = tokio::time::interval(IDLE_TICK);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            interval.tick().await;
            ticker.tick(clock());
        }
    });

    let (graceful_tx, graceful_rx) = oneshot::channel::<()>();
    let server = tokio::spawn(async move {
        crate::http_server::serve(listener, policy, services, async move {
            let _ = graceful_rx.await;
        })
        .await
    });

    supervise(
        server,
        graceful_tx,
        handles,
        respawn_current_exe,
        crate::http_server::shutdown_signal(),
    )
    .await
}

// VERIFY: wave9-restart_seam-3
/// The supervisor after the listener, ticker and server task exist. Split out
/// of [`run`] so a test can drive it with a finished server task, a closed
/// restart channel and a recording respawn seam; everything else is identical
/// to the serving daemon.
async fn supervise<F>(
    mut server: tokio::task::JoinHandle<io::Result<()>>,
    graceful_tx: oneshot::Sender<()>,
    mut handles: LifecycleHandles,
    respawn: Respawn,
    signal: F,
) -> io::Result<()>
where
    F: Future<Output = ()>,
{
    let stop = tokio::select! {
        _ = signal => Stop::Signal,
        // VERIFY: wave8-shutdown-3
        // Only a real request restarts; a closed channel (the server future
        // ended) disables this branch so the server result is reported.
        Some(()) = handles.restart.recv() => Stop::Restart,
        result = &mut server => {
            return match result {
                Ok(result) => result,
                Err(error) => Err(io::Error::new(io::ErrorKind::Other, error)),
            };
        }
    };

    let restart = matches!(stop, Stop::Restart);
    if restart {
        tokio::time::sleep(RESTART_DELAY).await;
    }
    let guard = AtomicBool::new(false);
    // PTY waiter joins and filesystem writes are synchronous. An independent
    // watchdog preserves the drain + graceful bound even if either stalls.
    std::thread::spawn(|| {
        std::thread::sleep(DRAIN_LIMIT + GRACEFUL_LIMIT);
        std::process::exit(0);
    });
    shutdown(&handles, restart, &guard, respawn).await;
    let _ = graceful_tx.send(());
    let _ = tokio::time::timeout(GRACEFUL_LIMIT, async {
        while handles.clients.load(Ordering::SeqCst) > 0 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let _ = server.await;
    })
    .await;
    std::process::exit(0);
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0)
}

/// `initWindowAnchor({stateDir})` (`window-anchor.mjs:190-219`): load the
/// persisted snapshot, apply the env-enabled providers and replay the returned
/// effects (save + emit) once.
fn init_anchor(paths: &AppPaths, bus: &Bus) -> window_anchor::Service {
    let state_path = paths.state_dir.join("window-anchor.json");
    let state_path = state_path.to_string_lossy().into_owned();
    let telemetry_path = paths
        .usage_skill_state
        .join("window-anchor-runs.jsonl")
        .to_string_lossy()
        .into_owned();
    let mut service = window_anchor::Service::default();
    let response = service.dispatch(
        "window_anchor_init",
        &json!({
            "state_path": state_path,
            "telemetry_path": telemetry_path,
            "window_anchor_env": std::env::var("WINDOW_ANCHOR").unwrap_or_default(),
            "now_ms": now_ms(),
        }),
    );
    for effect in response["effects"].as_array().into_iter().flatten() {
        match effect["type"].as_str() {
            Some("save_state") => {
                let _ = window_anchor::save(&state_path, &effect["state"]);
            }
            Some("emit_snapshot") => bus.emit(&BusEvent::WindowAnchor(effect["snapshot"].clone())),
            _ => {}
        }
    }
    service
}

/// Inert `AnchorHost` for routers built outside a tokio runtime (unit-test
/// construction); the serving daemon uses `window_anchor_host::NativeAnchorHost`.
pub(crate) struct DeferredAnchorHost;

impl crate::http_utilities::AnchorHost for DeferredAnchorHost {
    fn schedule(&self, effect: &serde_json::Value) {
        eprintln!(
            "window-anchor: native timers unavailable, skipped {}",
            effect["type"]
        );
    }

    fn run_action(&self, _effect: &serde_json::Value) -> Result<serde_json::Value, String> {
        Err("native window-anchor actions are unavailable".to_owned())
    }

    fn refresh_usage(&self, _provider: &str) -> Result<serde_json::Value, String> {
        Err("native usage refresh is unavailable".to_owned())
    }
}

fn build_chat(paths: &AppPaths, config: &ConfigServices) -> ChatDeps {
    let models_path = paths
        .state_dir
        .join("models.json")
        .to_string_lossy()
        .into_owned();
    let claude_home = config.home.join(".claude");
    let transcripts = Arc::new(
        TranscriptService::new(Inputs {
            state_dir: paths.state_dir.clone(),
            // VERIFY: wave31-transcript-home-6 — `~` expands from the user home.
            claude_home: config.home.clone(),
            codex_home: config.codex_home.clone(),
            model_catalog: Vec::new(),
        })
        .with_catalog_source(Arc::new(move || {
            crate::models::get(&models_path)["models"]
                .as_array()
                .cloned()
                .unwrap_or_default()
        })),
    );
    // `usage.mjs` honours Claude Code's own `CLAUDE_CONFIG_DIR` override for credentials.
    let credentials_home = std::env::var_os("CLAUDE_CONFIG_DIR")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or(claude_home);
    ChatDeps::new(transcripts, credentials_home.join(".credentials.json"))
}

#[cfg(test)]
mod tests {
    use super::{LifecycleHandles, bind_with_retry, shutdown, supervise};
    use crate::agent_registry::{PtyPort, Registry, RegistryConfig};
    use crate::agent_spawn::{Bins, LaunchSpec, SpawnPaths};
    use crate::bus::Bus;
    use crate::http_transcripts::TranscriptRegistry;
    use std::path::PathBuf;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::time::Duration;

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

    fn runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
    }

    // VERIFY: wave9-restart_seam-4
    // The injected respawn seam: records the call instead of spawning
    // `current_exe --http`. Thread-local so concurrently running tests keep
    // their own count (the current-thread runtime runs the future on the
    // calling thread).
    thread_local! {
        static RESPAWNS: std::cell::Cell<usize> = std::cell::Cell::new(0);
    }

    fn record_respawn() -> Result<(), String> {
        RESPAWNS.with(|count| count.set(count.get() + 1));
        Ok(())
    }

    fn respawns() -> usize {
        RESPAWNS.with(|count| count.get())
    }

    struct Fixture(PathBuf);

    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "singularity-lifecycle-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            std::fs::create_dir_all(path.join("state")).unwrap();
            std::fs::create_dir_all(path.join("home")).unwrap();
            std::fs::create_dir_all(path.join("cache")).unwrap();
            std::fs::create_dir_all(path.join("codex-home")).unwrap();
            Self(path)
        }

        fn registry(&self) -> Arc<Registry> {
            let bins = Bins::resolve(
                None,
                None,
                None,
                SpawnPaths {
                    home: self.0.join("home"),
                    scope_root: None,
                    cache_dir: self.0.join("cache"),
                    codex_home: self.0.join("codex-home"),
                    models_state: self.0.join("state/models.json"),
                },
            );
            Arc::new(Registry::new(
                Bus::new(),
                Arc::new(FakePort),
                RegistryConfig {
                    state_file: self.0.join("state/agents.json"),
                    bins,
                    parent_env: Default::default(),
                    clock: crate::agent_registry::system_clock(),
                },
            ))
        }

        fn write_agents(&self, text: &str) {
            std::fs::write(self.0.join("state/agents.json"), text).unwrap();
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn bind_retry_reports_the_node_port_message_after_the_last_attempt() {
        runtime().block_on(async {
            let held = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = held.local_addr().unwrap().port();
            let error = bind_with_retry(port, 2, Duration::from_millis(10))
                .await
                .unwrap_err();
            assert_eq!(error.kind(), std::io::ErrorKind::AddrInUse);
            assert_eq!(
                error.to_string(),
                format!("port {port} already in use — is Singularity already running?")
            );
            drop(held);

            let listener = bind_with_retry(0, 1, Duration::from_millis(1))
                .await
                .unwrap();
            assert!(listener.local_addr().unwrap().ip().is_loopback());
        });
    }

    #[test]
    fn shutdown_drains_persists_and_broadcasts_once() {
        runtime().block_on(async {
            let fixture = Fixture::new();
            fixture.write_agents(
                r#"{"agents":[{"id":"a1","cwd":"/work","scopes":["s1"],"tool":"claude","status":"detached"}],"recentRepos":[]}"#,
            );
            let registry = fixture.registry();
            registry.load().unwrap();
            let pty = Arc::new(crate::pty::PtyHost::new(Arc::new(|_event| {})));
            let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);
            let clients = Arc::new(AtomicUsize::new(0));
            let (_restart_tx, restart_rx) = tokio::sync::mpsc::unbounded_channel();
            // VERIFY: wave4-lifecycle-15
            // A router-installed cron service in the slot is stopped by the
            // lifecycle before the broadcast (the slot is drained), which is
            // what makes its tick and status listener die with the daemon.
            let crons = Arc::new(crate::crons::CronsService::new(
                registry.clone(),
                registry.bus().clone(),
                crate::crons::CronsConfig {
                    state_file: fixture.0.join("state/crons.json"),
                    clock: crate::agent_registry::system_clock(),
                    tick: crate::crons::TICK_INTERVAL,
                    idle_kill_after: crate::crons::KILL_CONFIRM,
                },
                Arc::new(crate::crons::NoopTimers),
            ));
            crons.init(None);
            let handles = LifecycleHandles {
                registry: registry.clone(),
                pty,
                clients,
                shutdown: shutdown_tx,
                restart: restart_rx,
                crons: Arc::new(std::sync::Mutex::new(Some(crons.clone()))),
                background: Arc::new(std::sync::Mutex::new(None)),
                tasks: None,
            };
            let guard = AtomicBool::new(false);
            shutdown(&handles, false, &guard, record_respawn).await;
            assert!(*shutdown_rx.borrow());
            // VERIFY: wave9-restart_seam-5
            // A plain shutdown signal never respawns.
            assert_eq!(respawns(), 0, "a plain shutdown never respawns");
            assert!(
                handles.crons.lock().unwrap().is_none(),
                "the lifecycle took and stopped the cron service"
            );
            assert_eq!(Arc::strong_count(&crons), 1, "no listener owns the service");
            let persisted = std::fs::read_to_string(fixture.0.join("state/agents.json")).unwrap();
            assert!(persisted.contains("\"id\": \"a1\""), "{persisted}");

            // Re-entrant call returns immediately and still reports 0 clients.
            shutdown(&handles, false, &guard, record_respawn).await;
            assert_eq!(handles.clients.load(Ordering::SeqCst), 0);
            assert_eq!(respawns(), 0, "the re-entrant call respawns nothing");
        });
    }

    // VERIFY: wave9-restart_seam-6
    #[test]
    fn restart_respawns_once_when_the_final_persist_fails() {
        runtime().block_on(async {
            let fixture = Fixture::new();
            fixture.write_agents(
                r#"{"agents":[{"id":"a1","cwd":"/work","scopes":["s1"],"tool":"claude","status":"detached"}],"recentRepos":[]}"#,
            );
            let registry = fixture.registry();
            registry.load().unwrap();
            // Deterministic persist failure: `state` becomes a regular file, so
            // the agents.json write (and its staged tmp file) cannot be created.
            std::fs::remove_dir_all(fixture.0.join("state")).unwrap();
            std::fs::write(fixture.0.join("state"), b"not a directory").unwrap();
            let pty = Arc::new(crate::pty::PtyHost::new(Arc::new(|_event| {})));
            let (shutdown_tx, _shutdown_rx) = tokio::sync::watch::channel(false);
            let (_restart_tx, restart_rx) = tokio::sync::mpsc::unbounded_channel();
            let handles = LifecycleHandles {
                registry,
                pty,
                clients: Arc::new(AtomicUsize::new(0)),
                shutdown: shutdown_tx,
                restart: restart_rx,
                crons: Arc::new(std::sync::Mutex::new(None)),
                background: Arc::new(std::sync::Mutex::new(None)),
                tasks: None,
            };
            let guard = AtomicBool::new(false);
            shutdown(&handles, true, &guard, record_respawn).await;
            assert!(!fixture.0.join("state/agents.json").exists());
            // VERIFY: wave8-shutdown-1
            // The failed write is logged, never a reason to skip the respawn
            // (`index.mjs:538-543`): exactly one respawn, not zero.
            assert_eq!(respawns(), 1, "a restart respawns exactly once");
        });
    }

    // VERIFY: wave9-restart_seam-7
    #[test]
    fn a_closed_restart_channel_reports_the_server_result_without_respawning() {
        runtime().block_on(async {
            let fixture = Fixture::new();
            let registry = fixture.registry();
            let pty = Arc::new(crate::pty::PtyHost::new(Arc::new(|_event| {})));
            let (shutdown_tx, _shutdown_rx) = tokio::sync::watch::channel(false);
            let (restart_tx, restart_rx) = tokio::sync::mpsc::unbounded_channel();
            // The router is gone: nothing can ever send a restart request.
            drop(restart_tx);
            let handles = LifecycleHandles {
                registry,
                pty,
                clients: Arc::new(AtomicUsize::new(0)),
                shutdown: shutdown_tx,
                restart: restart_rx,
                crons: Arc::new(std::sync::Mutex::new(None)),
                background: Arc::new(std::sync::Mutex::new(None)),
                tasks: None,
            };
            let server = tokio::spawn(async {
                Err(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    "server ended",
                ))
            });
            let (graceful_tx, graceful_rx) = tokio::sync::oneshot::channel::<()>();
            let result = supervise(
                server,
                graceful_tx,
                handles,
                record_respawn,
                std::future::pending::<()>(),
            )
            .await;
            drop(graceful_rx);
            assert_eq!(result.unwrap_err().to_string(), "server ended");
            assert_eq!(
                respawns(),
                0,
                "an ended server is reported, not treated as a restart"
            );
        });
    }

    #[test]
    fn transcript_registry_reads_launch_scopes_from_the_loaded_file() {
        let fixture = Fixture::new();
        fixture.write_agents(
            r#"{"agents":[{"id":"a1","cwd":"/work","scopes":["s1","s2"],"tool":"claude","status":"detached"}],"recentRepos":[]}"#,
        );
        let registry = fixture.registry();
        registry.load().unwrap();
        assert!(!TranscriptRegistry::is_live(&*registry, "a1"));
        assert_eq!(
            TranscriptRegistry::launch_scopes(&*registry, "a1"),
            Some(vec!["s1".to_owned(), "s2".to_owned()])
        );
        assert_eq!(TranscriptRegistry::codex_thread_for(&*registry, "a1"), None);
        assert_eq!(
            TranscriptRegistry::codex_thread_scopes(&*registry, "thread", Some("/work")),
            None
        );
    }
}
