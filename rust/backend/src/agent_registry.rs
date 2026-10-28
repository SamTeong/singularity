//! Agent registry: spawn/kill, in-memory PTYs, `agents.json` persistence.
//!
//! Port of the registry state machine in `server/agents.mjs` plus the PTY-event
//! handling of `server/rust-pty-backend.mjs`. Map of the Node behaviour:
//!
//! | Node | Here |
//! |---|---|
//! | `RING_MAX` (`agents.mjs:13`), `IDLE_MS` (`:14`), `RECENT_MAX` (`:15`) | [`RING_MAX`], `IDLE_MS`, `RECENT_MAX` |
//! | `agents` Map + `recentRepos` + `draining` (`:43-49`) | `State` |
//! | `beginDrain` (`:55`) | [`Registry::begin_drain`] |
//! | `persist` (`:87-105`) | [`Registry::persist`] (`fs_atomic::write_atomic`) |
//! | `init` (`:107-123`) | [`Registry::load`] |
//! | `snapshot`/`getBuf`/`getWritten`/`getStatus`/`isLive` (`:126-135`) | [`Registry::snapshot`], [`Registry::get_buf`], [`Registry::get_written`], [`Registry::get_status`], [`Registry::is_live`] |
//! | `findByRunId` (`:136`), `getLaunchConfig` (`:141-145`), `getLaunchConfigForCodexThread` (`:156-165`), `codexThreadFor` (`:173-178`), `rememberCodexThread` (`:184-191`) | [`Registry::find_by_run_id`], [`Registry::get_launch_config`], [`Registry::get_launch_config_for_codex_thread`], [`Registry::codex_thread_for`], `remember_codex_thread` |
//! | `liveProcessSnapshot` (`:193-196`) | [`Registry::live_process_snapshot`] |
//! | `setStatus`/`getActiveMs`/`pushBuf` (`:204-222`) | `set_status`, [`Registry::active_ms`], `push_buf` |
//! | `wire` onData/onExit (`:228-293`) | [`Registry::on_pty_event`] |
//! | `create` (`:417-450`) | [`Registry::create`] |
//! | `reattach` (`:480-493`) | [`Registry::reattach`] |
//! | `fork` (`:545-557`), `input`/`resize` (`:559-565`), `kill` (`:573-580`), `remove` (`:587-594`), `respawn`/`respawnAll` (`:598-614`), `reorder` (`:618-627`) | same-named methods |
//! | `untildify` (`:411-414`), `ensureTrusted` (`:463-471`) | `untildify_cwd`, `ensure_trusted` |
//! | `rust-pty-backend.mjs:63-67` stale-generation drop, `:83`/`:122` streaming decoder, `:143` monotonic generation | `on_output`, `decode_output`/`flush_output`, `next_generation` |
//!
//! Concurrency contract: one `std::sync::Mutex<State>`; it is never held across
//! a PTY call or a listener call. Mutations collect their [`BusEvent`]s under
//! the lock and emit them after unlocking (the `persist` file write also
//! happens outside the lock). Registry methods are synchronous: `models::route`
//! and `codex_thread_identity` are sync in this crate, so nothing awaits.
//!
//! Runtime-only agent state (pid, ring buffer, decoder carry, idle stamp,
//! pending respawn/removal flags) is kept beside the persisted
//! [`AgentRecord`], never inside it — `pid` does not survive a daemon restart
//! (`agents.mjs:89-95`).

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::Value;

use crate::agent_spawn::{self, Bins, LaunchInput, LaunchSpec};
use crate::agent_wire::{AgentRecord, AgentWire, AgentsFile, Status};
use crate::app_paths;
use crate::bus::{Bus, BusEvent};
use crate::codex_thread_identity;
use crate::fs_atomic;
use crate::models;
use crate::pty::{PtyEvent, PtyHost, PtySpawnSpec};

// VERIFY: registry-ring-max
/// Per-agent in-memory scrollback cap (`agents.mjs:13`).
pub const RING_MAX: usize = 256 * 1024;
/// No pty output for this long while running → `idle` (`agents.mjs:14`).
const IDLE_MS: i64 = 2000;
/// `recentRepos` keeps at most this many entries (`agents.mjs:15`).
const RECENT_MAX: usize = 10;

// VERIFY: registry-pty-port
/// The PTY operations the registry needs. Implemented for [`PtyHost`] in the
/// daemon and by a fake in tests, so the state machine never spawns a process.
/// Every method is synchronous and must not be called with the state lock held.
pub trait PtyPort: Send + Sync {
    /// `ptyBackend.spawn({ id, bin, args, cwd, cols, rows, env })`
    /// (`agents.mjs:442`); returns the child pid.
    fn spawn(&self, id: &str, generation: u64, spec: LaunchSpec) -> Result<u32, String>;
    /// `proc.write(data)` (`agents.mjs:561`).
    fn write(&self, id: &str, data: &[u8]) -> Result<(), String>;
    /// `proc.resize(cols, rows)` (`agents.mjs:564`).
    fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), String>;
    /// `proc.kill()` (`agents.mjs:568`).
    fn kill(&self, id: &str) -> Result<(), String>;
}

// VERIFY: registry-pty-host-impl
impl PtyPort for PtyHost {
    fn spawn(&self, id: &str, generation: u64, spec: LaunchSpec) -> Result<u32, String> {
        let mut spawn = PtySpawnSpec::new(id, generation, spec.bin, spec.cwd);
        spawn.args = spec.args;
        spawn.env = spec.env.into_iter().collect::<HashMap<String, String>>();
        spawn.cols = spec.cols;
        spawn.rows = spec.rows;
        PtyHost::spawn(self, &spawn)
    }

    fn write(&self, id: &str, data: &[u8]) -> Result<(), String> {
        PtyHost::write(self, id, data)
    }

    fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        PtyHost::resize(self, id, cols, rows)
    }

    fn kill(&self, id: &str) -> Result<(), String> {
        PtyHost::kill(self, id)
    }
}

// VERIFY: registry-clock
/// Injected wall clock (milliseconds since the epoch) so tests control
/// `activeMs`, idle detection and persisted `createdAt`.
pub type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;

// VERIFY: registry-system-clock
/// [`Clock`] backed by the system time.
pub fn system_clock() -> Clock {
    Arc::new(now_ms)
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0)
}

// VERIFY: registry-launch-config-type
/// `getLaunchConfig` (`agents.mjs:141-145`): the registry-only launch fields
/// the Transcripts view needs to resume a past session.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LaunchConfig {
    pub model: Option<String>,
    pub scopes: Vec<String>,
    /// `a.tool || 'claude'`.
    pub tool: String,
}

// VERIFY: registry-live-processes-type
/// `liveProcessSnapshot` (`agents.mjs:193-196`): pids and session ids this
/// daemon currently owns a live PTY for.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct LiveProcesses {
    pub pids: Vec<u32>,
    pub sessions: Vec<String>,
}

// VERIFY: registry-config
/// Everything ambient the registry needs, injected by the host: the
/// `agents.json` path (`STATE_DIR/agents.json`, `agents.mjs:20`), the
/// [`Bins`]/paths from `agent_spawn`, the parent environment handed to spawned
/// children (`spawnEnv`, `:402-406`) and the clock.
pub struct RegistryConfig {
    pub state_file: PathBuf,
    pub bins: Bins,
    pub parent_env: BTreeMap<String, String>,
    pub clock: Clock,
}

// VERIFY: registry-create-input
/// The `create({...})` payload (`agents.mjs:417`). `cwd` stays optional so the
/// empty case keeps Node's `working directory does not exist: (empty)`.
#[derive(Clone, Debug, Default)]
pub struct CreateAgent {
    pub cwd: Option<String>,
    pub title: Option<String>,
    pub model: Option<String>,
    pub scopes: Option<Vec<String>>,
    pub session_id: Option<String>,
    pub prompt: Option<String>,
    pub permission_mode: Option<String>,
    pub extra_args: Option<Vec<String>>,
    pub mock: bool,
    pub tool: Option<String>,
    pub created_at: Option<i64>,
    pub thread_id: Option<String>,
    pub run_id: Option<String>,
}

/// The `respawnAfterExit` payload captured by `respawn()` (`agents.mjs:604`)
/// and replayed by `create({ sessionId: id, ...cfg })` (`:258`).
#[derive(Clone, Debug, Default)]
struct RespawnConfig {
    title: Option<String>,
    cwd: Option<String>,
    model: Option<String>,
    scopes: Option<Vec<String>>,
    permission_mode: Option<String>,
    extra_args: Option<Vec<String>>,
    tool: Option<String>,
    created_at: Option<i64>,
    thread_id: Option<String>,
}

/// One registry entry: the persisted fields plus runtime-only state.
struct Agent {
    record: AgentRecord,
    pid: Option<u32>,
    /// `a.proc != null` — a pty this daemon owns right now.
    live: bool,
    /// The generation handed to the PTY host; stale events carry an older one.
    generation: u64,
    ring: Vec<String>,
    ring_bytes: usize,
    /// Cumulative pty bytes since this spawn, never trimmed (`agents.mjs:219`).
    written: usize,
    running_since: Option<i64>,
    /// Last output stamp: the idle timer's replacement (host calls `tick`).
    last_output: Option<i64>,
    decoder_carry: Vec<u8>,
    respawn_after_exit: Option<RespawnConfig>,
    remove_on_exit: bool,
}

#[derive(Default)]
struct State {
    /// Insertion-ordered, like the JS `Map`.
    agents: Vec<Agent>,
    recent_repos: Vec<String>,
    /// Per-id generation counter; strictly increasing, never reset
    /// (`rust-pty-backend.mjs:143`).
    generations: HashMap<String, u64>,
    draining: bool,
}

impl State {
    fn find(&self, id: &str) -> Option<&Agent> {
        self.agents.iter().find(|agent| agent.record.id == id)
    }

    fn find_mut(&mut self, id: &str) -> Option<&mut Agent> {
        self.agents.iter_mut().find(|agent| agent.record.id == id)
    }

    fn remove(&mut self, id: &str) -> Option<Agent> {
        let index = self.agents.iter().position(|agent| agent.record.id == id)?;
        Some(self.agents.remove(index))
    }
}

/// What `on_exit` does after the exit has been observed (`agents.mjs:244-291`).
enum ExitAction {
    /// Daemon shutdown killed the pty: keep the entry as-is (`:251`).
    Drained,
    /// Theme-change respawn: delete, then `create()` with the pinned config
    /// (`:255-261`).
    Respawn(CreateAgent),
    /// `removeOnExit`: drop the entry outright (`:265-269`).
    Removed,
    /// Normal exit: status `exited`, resume banner, then delete (`:271-290`).
    Bannered(BannerInput),
}

/// The fields the resume banner is built from, captured before the entry is
/// deleted (`agents.mjs:272-280`).
struct BannerInput {
    id: String,
    model: Option<String>,
    tool: Option<String>,
    cwd: Option<String>,
    created_at: Option<i64>,
    thread_id: Option<String>,
    exit_code: Option<i32>,
}

// VERIFY: registry-struct
/// The agent registry: state, bus, PTY port and injected configuration.
pub struct Registry {
    state: Mutex<State>,
    /// Serialises persists so a stale snapshot never lands after a newer one
    /// and two writers never share `write_atomic`'s pid-scoped scratch file.
    persist_lock: Mutex<()>,
    bus: Bus,
    port: Arc<dyn PtyPort>,
    config: RegistryConfig,
}

// VERIFY: registry-new
impl Registry {
    pub fn new(bus: Bus, port: Arc<dyn PtyPort>, config: RegistryConfig) -> Self {
        Self {
            state: Mutex::new(State::default()),
            persist_lock: Mutex::new(()),
            bus,
            port,
            config,
        }
    }

    /// The shared bus, so the host can subscribe the WS fan-out.
    pub fn bus(&self) -> &Bus {
        &self.bus
    }

    // VERIFY: registry-load
    /// `init()` (`agents.mjs:107-123`): load `agents.json`, fold the legacy
    /// `name` into `title` and mark every entry `detached` (the ptys are gone
    /// after a restart). A malformed file is reported so the host can log it,
    /// exactly like Node's `init` warning; the registry stays empty.
    pub fn load(&self) -> Result<(), String> {
        let text = match fs::read_to_string(&self.config.state_file) {
            Ok(text) => text,
            Err(_) => return Ok(()),
        };
        let mut file = AgentsFile::parse(&text).map_err(|error| error.to_string())?;
        let mut state = self.state.lock().unwrap();
        state.agents.clear();
        state.recent_repos = std::mem::take(&mut file.recent_repos);
        for mut record in std::mem::take(&mut file.agents) {
            record.normalize_legacy();
            record.status = Status::Detached;
            let agent = Agent {
                record,
                pid: None,
                live: false,
                generation: 0,
                ring: Vec::new(),
                ring_bytes: 0,
                written: 0,
                running_since: None,
                last_output: None,
                decoder_carry: Vec::new(),
                respawn_after_exit: None,
                remove_on_exit: false,
            };
            // A Map keyed by id keeps the last occurrence; mirror that.
            match state
                .agents
                .iter_mut()
                .find(|existing| existing.record.id == agent.record.id)
            {
                Some(existing) => *existing = agent,
                None => state.agents.push(agent),
            }
        }
        Ok(())
    }

    // VERIFY: registry-snapshot
    /// `snapshot()` (`agents.mjs:126-128`).
    pub fn snapshot(&self) -> Vec<AgentWire> {
        let state = self.state.lock().unwrap();
        state.agents.iter().map(wire).collect()
    }

    // VERIFY: registry-is-live
    /// `isLive` (`agents.mjs:135`): a pty is attached right now.
    pub fn is_live(&self, id: &str) -> bool {
        self.state
            .lock()
            .unwrap()
            .find(id)
            .is_some_and(|agent| agent.live)
    }

    // VERIFY: registry-status
    /// `getStatus` (`agents.mjs:134`).
    pub fn get_status(&self, id: &str) -> Option<Status> {
        self.state
            .lock()
            .unwrap()
            .find(id)
            .map(|agent| agent.record.status)
    }

    // VERIFY: registry-buf
    /// `getBuf` (`agents.mjs:130`): the ring, concatenated.
    pub fn get_buf(&self, id: &str) -> String {
        self.state
            .lock()
            .unwrap()
            .find(id)
            .map(|agent| agent.ring.concat())
            .unwrap_or_default()
    }

    // VERIFY: registry-written
    /// `getWritten` (`agents.mjs:133`): cumulative pty bytes since this spawn.
    pub fn get_written(&self, id: &str) -> usize {
        self.state
            .lock()
            .unwrap()
            .find(id)
            .map_or(0, |agent| agent.written)
    }

    // VERIFY: registry-drain
    /// `beginDrain` (`agents.mjs:55`): every live session is snapshotted to
    /// disk as `detached`, and the later pty exits leave the file alone
    /// (`:251`). Best effort: a shutdown persist failure is not fatal.
    pub fn begin_drain(&self) {
        self.state.lock().unwrap().draining = true;
        let _ = self.persist();
    }

    // VERIFY: registry-live-processes
    /// `liveProcessSnapshot` (`agents.mjs:193-196`).
    pub fn live_process_snapshot(&self) -> LiveProcesses {
        let state = self.state.lock().unwrap();
        let live: Vec<&Agent> = state.agents.iter().filter(|agent| agent.live).collect();
        LiveProcesses {
            pids: live.iter().map(|agent| agent.pid.unwrap_or(0)).collect(),
            sessions: live.iter().map(|agent| agent.record.id.clone()).collect(),
        }
    }

    // VERIFY: registry-find-run
    /// `findByRunId` (`agents.mjs:136`), returning the UI snapshot shape.
    pub fn find_by_run_id(&self, run_id: &str) -> Option<AgentWire> {
        let state = self.state.lock().unwrap();
        state
            .agents
            .iter()
            .find(|agent| agent.record.run_id.as_deref() == Some(run_id))
            .map(wire)
    }

    // VERIFY: registry-launch-config
    /// `getLaunchConfig` (`agents.mjs:141-145`).
    pub fn get_launch_config(&self, id: &str) -> Option<LaunchConfig> {
        let record = self.record(id)?;
        Some(LaunchConfig {
            model: record.model.clone().filter(|model| !model.is_empty()),
            scopes: record.scopes.clone().unwrap_or_default(),
            tool: record
                .tool
                .clone()
                .filter(|tool| !tool.is_empty())
                .unwrap_or_else(|| "claude".to_owned()),
        })
    }

    // VERIFY: registry-launch-config-codex
    /// `getLaunchConfigForCodexThread` (`agents.mjs:156-165`): invert the
    /// cwd+createdAt → thread-uuid relation so the Transcripts view can recover
    /// a codex agent's registry-only scopes from the thread uuid alone.
    pub fn get_launch_config_for_codex_thread(
        &self,
        thread_id: Option<&str>,
        cwd: Option<&str>,
    ) -> Option<LaunchConfig> {
        let thread_id = thread_id.filter(|value| !value.is_empty())?;
        let cwd = cwd.filter(|value| !value.is_empty())?;
        let want_cwd = norm_path(cwd);
        let records: Vec<AgentRecord> = {
            let state = self.state.lock().unwrap();
            state
                .agents
                .iter()
                .map(|agent| agent.record.clone())
                .collect()
        };
        for record in records {
            let is_codex = record.tool.as_deref() == Some("codex")
                || route_flag(
                    &self.route(record.model.as_deref(), record.tool.as_deref()),
                    "isCodexModel",
                );
            if !is_codex {
                continue;
            }
            // `normPath` resolve()s, so a cwd-less record must never reach it.
            let Some(agent_cwd) = record.cwd.as_deref().filter(|value| !value.is_empty()) else {
                continue;
            };
            if norm_path(agent_cwd) != want_cwd {
                continue;
            }
            let found =
                self.discover_codex_thread(Some(agent_cwd), record.created_at, record.id.as_str());
            if found.as_deref() == Some(thread_id) {
                return self.get_launch_config(&record.id);
            }
        }
        None
    }

    // VERIFY: registry-codex-thread
    /// `codexThreadFor` (`agents.mjs:173-178`): the codex-minted thread uuid a
    /// registered agent's transcript is filed under.
    pub fn codex_thread_for(&self, id: &str) -> Option<String> {
        self.remember_codex_thread(id)
    }

    // VERIFY: registry-create
    /// `create({...})` (`agents.mjs:417-450`). The entry is registered *before*
    /// the PTY spawn so output emitted during the spawn is not lost (Node's
    /// backend buffers frames until `activate()`; this registry has the entry
    /// in place already, which is the same guarantee `agents.test.mjs:120`
    /// asserts).
    pub fn create(&self, input: CreateAgent) -> Result<AgentWire, String> {
        let home = self.config.bins.paths.home.clone();
        let cwd = input.cwd.as_deref().map(|raw| untildify_cwd(raw, &home));
        let id = input
            .session_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(new_id);
        // Copy the liveness out first: `reattach` takes the state lock itself.
        let existing_live = {
            let state = self.state.lock().unwrap();
            state.find(&id).map(|agent| agent.live)
        };
        match existing_live {
            Some(true) => return Err("session id already in use".to_owned()),
            // A dead/detached entry keeps its model + scopes: resume it.
            Some(false) => {
                let resumed = self.reattach(&id)?;
                return resumed.ok_or_else(|| "session id already in use".to_owned());
            }
            None => {}
        }
        let Some(cwd_path) = cwd else {
            return Err("working directory does not exist: (empty)".to_owned());
        };
        let cwd = cwd_path.to_string_lossy().into_owned();
        if cwd.is_empty() {
            return Err("working directory does not exist: (empty)".to_owned());
        }
        if !cwd_path.exists() {
            return Err(format!("working directory does not exist: {cwd}"));
        }
        let route = self.route(input.model.as_deref(), input.tool.as_deref());
        if let Some(error) = route.get("toolModelError").and_then(Value::as_str) {
            return Err(error.to_owned());
        }
        let display_title = match input.title.as_deref() {
            Some(title) if !title.is_empty() => title.to_owned(),
            _ => id.chars().take(8).collect(),
        };
        // Only respawn() passes `createdAt`; a genuinely fresh create must not,
        // or codex discovery could resume an unrelated session (`:432-438`).
        let spawned_at = input.created_at.unwrap_or_else(|| (self.config.clock)());
        let launch = LaunchInput {
            id: id.clone(),
            title: display_title.clone(),
            cwd: cwd.clone(),
            model: input.model.clone().unwrap_or_default(),
            scopes: input.scopes.clone().unwrap_or_default(),
            permission_mode: input.permission_mode.clone(),
            extra_args: input.extra_args.clone().unwrap_or_default(),
            tool: input.tool.clone(),
            created_at: input.created_at,
            thread_id: input.thread_id.clone(),
            prompt: input.prompt.clone(),
            mock: input.mock,
        };
        let spec = agent_spawn::build_launch(&launch, &self.config.bins, &self.config.parent_env)?;
        self.ensure_trusted(&cwd);
        let generation = self.next_generation(&id);
        {
            let mut state = self.state.lock().unwrap();
            state.agents.push(Agent {
                record: AgentRecord {
                    id: id.clone(),
                    title: Some(display_title),
                    cwd: Some(cwd.clone()),
                    created_at: Some(spawned_at),
                    model: input.model.clone(),
                    scopes: input.scopes.clone(),
                    permission_mode: input.permission_mode.clone(),
                    extra_args: input.extra_args.clone(),
                    mock: Some(input.mock),
                    tool: input.tool.clone(),
                    thread_id: input.thread_id.clone(),
                    run_id: input.run_id.clone(),
                    active_ms: Some(0),
                    status: Status::Starting,
                    name: None,
                },
                pid: None,
                live: true,
                generation,
                ring: Vec::new(),
                ring_bytes: 0,
                written: 0,
                running_since: None,
                last_output: None,
                decoder_carry: Vec::new(),
                respawn_after_exit: None,
                remove_on_exit: false,
            });
        }
        let pid = match self.port.spawn(&id, generation, spec) {
            Ok(pid) => pid,
            Err(error) => {
                self.state.lock().unwrap().remove(&id);
                return Err(error);
            }
        };
        if let Some(agent) = self.state.lock().unwrap().find_mut(&id) {
            agent.pid = Some(pid);
        }
        self.remember_repo(&cwd);
        self.persist()?;
        self.emit_list();
        Ok(self.wire(&id).expect("the entry was inserted above"))
    }

    // VERIFY: registry-reattach
    /// `reattach` (`agents.mjs:480-493`): resume a detached agent, keeping its
    /// model and skill scopes; `Ok(None)` when no such agent exists.
    pub fn reattach(&self, id: &str) -> Result<Option<AgentWire>, String> {
        let Some(record) = self.record(id) else {
            return Ok(None);
        };
        if self.is_live(id) {
            return Ok(self.wire(id));
        }
        let launch = LaunchInput {
            id: record.id.clone(),
            title: record.title.clone().unwrap_or_default(),
            cwd: record.cwd.clone().unwrap_or_default(),
            model: record.model.clone().unwrap_or_default(),
            scopes: record.scopes.clone().unwrap_or_default(),
            permission_mode: record.permission_mode.clone(),
            extra_args: record.extra_args.clone().unwrap_or_default(),
            tool: record.tool.clone(),
            created_at: record.created_at,
            thread_id: record.thread_id.clone(),
            prompt: None,
            mock: record.mock.unwrap_or(false),
        };
        let spec = agent_spawn::build_launch(&launch, &self.config.bins, &self.config.parent_env)?;
        self.ensure_trusted(&launch.cwd);
        let generation = self.next_generation(id);
        {
            let mut state = self.state.lock().unwrap();
            let agent = state
                .find_mut(id)
                .ok_or_else(|| "no such agent".to_owned())?;
            // Node assigns these fields directly (`:488`), bypassing setStatus,
            // so no status event is emitted here.
            agent.live = true;
            agent.pid = None;
            agent.generation = generation;
            agent.ring.clear();
            agent.ring_bytes = 0;
            agent.written = 0;
            agent.decoder_carry.clear();
            agent.running_since = None;
            agent.last_output = None;
            agent.record.status = Status::Starting;
        }
        match self.port.spawn(id, generation, spec) {
            Ok(pid) => {
                if let Some(agent) = self.state.lock().unwrap().find_mut(id) {
                    agent.pid = Some(pid);
                }
            }
            Err(error) => {
                if let Some(agent) = self.state.lock().unwrap().find_mut(id) {
                    agent.live = false;
                }
                return Err(error);
            }
        }
        self.persist()?;
        self.emit_list();
        Ok(self.wire(id))
    }

    // VERIFY: registry-fork
    /// `fork` (`agents.mjs:545-557`): copy the source transcript with every
    /// occurrence of the source id rewritten to the new id, then `create()` a
    /// fresh agent over it (no log → a config-only copy).
    pub fn fork(&self, src_id: &str, title: &str) -> Result<AgentWire, String> {
        let src = self
            .record(src_id)
            .ok_or_else(|| "source not found".to_owned())?;
        let new_id = new_id();
        let cwd = src.cwd.clone().unwrap_or_default();
        let dir = self
            .config
            .bins
            .paths
            .home
            .join(".claude")
            .join("projects")
            .join(agent_spawn::encode_cwd(&cwd));
        let src_log = dir.join(format!("{src_id}.jsonl"));
        if src_log.exists() {
            let content = fs::read_to_string(&src_log).map_err(|error| error.to_string())?;
            fs::write(
                dir.join(format!("{new_id}.jsonl")),
                content.replace(src_id, &new_id),
            )
            .map_err(|error| error.to_string())?;
        }
        self.create(CreateAgent {
            cwd: Some(cwd),
            title: Some(title.to_owned()),
            model: src.model.clone(),
            scopes: src.scopes.clone(),
            session_id: Some(new_id),
            tool: src.tool.clone(),
            ..CreateAgent::default()
        })
    }

    // VERIFY: registry-kill
    /// `kill` (`agents.mjs:573-580`): a live agent's pty is killed and its
    /// `onExit` does the removal; a dead/detached entry is dropped here.
    pub fn kill(&self, id: &str) -> Result<(), String> {
        let Some(live) = self.state.lock().unwrap().find(id).map(|agent| agent.live) else {
            return Ok(());
        };
        if live {
            let _ = self.port.kill(id);
            return Ok(());
        }
        self.state.lock().unwrap().remove(id);
        self.persist()?;
        self.emit_list();
        Ok(())
    }

    // VERIFY: registry-remove
    /// `remove` (`agents.mjs:587-594`): unlike `kill`, a live agent is dropped
    /// for good when its pty exits (`removeOnExit`).
    pub fn remove(&self, id: &str) -> Result<(), String> {
        let Some(live) = self.state.lock().unwrap().find(id).map(|agent| agent.live) else {
            return Ok(());
        };
        if live {
            if let Some(agent) = self.state.lock().unwrap().find_mut(id) {
                agent.remove_on_exit = true;
            }
            let _ = self.port.kill(id);
            return Ok(());
        }
        self.state.lock().unwrap().remove(id);
        self.persist()?;
        self.emit_list();
        Ok(())
    }

    // VERIFY: registry-respawn
    /// `respawn` (`agents.mjs:598-607`): pin the codex thread while the agent is
    /// still live, arm `respawnAfterExit`, then kill — the exit resumes the same
    /// config. Returns false when the agent is not live.
    pub fn respawn(&self, id: &str) -> bool {
        if !self.is_live(id) {
            return false;
        }
        let thread_id = self.remember_codex_thread(id);
        {
            let mut state = self.state.lock().unwrap();
            let Some(agent) = state.find_mut(id) else {
                return false;
            };
            if !agent.live {
                return false;
            }
            agent.respawn_after_exit = Some(RespawnConfig {
                title: agent.record.title.clone(),
                cwd: agent.record.cwd.clone(),
                model: agent.record.model.clone(),
                scopes: agent.record.scopes.clone(),
                permission_mode: agent.record.permission_mode.clone(),
                extra_args: agent.record.extra_args.clone(),
                tool: agent.record.tool.clone(),
                created_at: agent.record.created_at,
                thread_id: thread_id.filter(|thread| !thread.is_empty()),
            });
        }
        let _ = self.port.kill(id);
        true
    }

    // VERIFY: registry-respawn-all
    /// `respawnAll` (`agents.mjs:610-614`): respawn every live agent, returning
    /// the ids that were live.
    pub fn respawn_all(&self) -> Vec<String> {
        let ids: Vec<String> = {
            let state = self.state.lock().unwrap();
            state
                .agents
                .iter()
                .map(|agent| agent.record.id.clone())
                .collect()
        };
        ids.into_iter().filter(|id| self.respawn(id)).collect()
    }

    // VERIFY: registry-reorder
    /// `reorder` (`agents.mjs:618-627`): accept only a permutation of every
    /// current id; anything else is a no-op.
    pub fn reorder(&self, ids: &[String]) -> Result<(), String> {
        {
            let mut state = self.state.lock().unwrap();
            if ids.len() != state.agents.len() {
                return Ok(());
            }
            let mut order = Vec::with_capacity(ids.len());
            for id in ids {
                let Some(index) = state.agents.iter().position(|agent| &agent.record.id == id)
                else {
                    return Ok(());
                };
                if order.contains(&index) {
                    return Ok(());
                }
                order.push(index);
            }
            let mut slots: Vec<Option<Agent>> = std::mem::take(&mut state.agents)
                .into_iter()
                .map(Some)
                .collect();
            state.agents = order
                .into_iter()
                .map(|index| slots[index].take().expect("indices are unique"))
                .collect();
        }
        self.persist()?;
        self.emit_list();
        Ok(())
    }

    // VERIFY: registry-input
    /// `input` (`agents.mjs:559-562`): write to the live pty; failures are
    /// logged in Node and ignored here.
    pub fn input(&self, id: &str, data: &str) {
        if self.is_live(id) {
            let _ = self.port.write(id, data.as_bytes());
        }
    }

    // VERIFY: registry-resize
    /// `resize` (`agents.mjs:563-565`): swallowed entirely.
    pub fn resize(&self, id: &str, cols: u16, rows: u16) {
        if self.is_live(id) {
            let _ = self.port.resize(id, cols, rows);
        }
    }

    // VERIFY: registry-active-ms
    /// `getActiveMs` (`agents.mjs:211-216`): persisted `activeMs` plus the live
    /// span while running.
    pub fn active_ms(&self, id: &str) -> i64 {
        let now = (self.config.clock)();
        let state = self.state.lock().unwrap();
        let Some(agent) = state.find(id) else {
            return 0;
        };
        let base = agent.record.active_ms.unwrap_or(0);
        if agent.record.status == Status::Running {
            base + agent.running_since.map_or(0, |since| now - since)
        } else {
            base
        }
    }

    // VERIFY: registry-pty-event
    /// Entry point for the PTY host's sink. Wire it as
    /// `PtyHost::new(Arc::new(move |event| registry.on_pty_event(event)))`.
    pub fn on_pty_event(&self, event: PtyEvent) {
        match event {
            PtyEvent::Output {
                id,
                generation,
                bytes,
            } => self.on_output(&id, generation, &bytes),
            PtyEvent::Exit {
                id,
                generation,
                exit_code,
            } => self.on_exit(&id, generation, exit_code),
        }
    }

    // VERIFY: registry-tick
    /// The idle heuristic (`agents.mjs:232-236`): 2s without output while
    /// running → `idle`. Node arms a `setTimeout` per output chunk; the host
    /// calls this every 250ms instead, which is equivalent within one tick.
    pub fn tick(&self, now: i64) {
        let mut events = Vec::new();
        {
            let mut state = self.state.lock().unwrap();
            for agent in &mut state.agents {
                if agent.record.status == Status::Running
                    && agent
                        .last_output
                        .is_some_and(|last_output| now - last_output >= IDLE_MS)
                {
                    set_status(agent, Status::Idle, now, &mut events);
                }
            }
        }
        for event in &events {
            self.bus.emit(event);
        }
    }

    // VERIFY: registry-persist
    /// `persist` (`agents.mjs:87-105`): write `{ agents, recentRepos }` as
    /// 2-space pretty JSON through the atomic temp+rename writer. Running,
    /// starting and idle agents are stored as `detached` with the live span
    /// folded into `activeMs`; a genuine write failure is returned with Node's
    /// `agents.json write failed: …` message (the HTTP layer maps it to 500).
    pub fn persist(&self) -> Result<(), String> {
        let _persisting = self
            .persist_lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let now = (self.config.clock)();
        let bytes = {
            let state = self.state.lock().unwrap();
            AgentsFile {
                agents: state
                    .agents
                    .iter()
                    .map(|agent| persisted_record(agent, now))
                    .collect(),
                recent_repos: state.recent_repos.clone(),
            }
            .to_json()
            .into_bytes()
        };
        fs_atomic::write_atomic(&self.config.state_file, &bytes)
            .map_err(|error| format!("agents.json write failed: {error}"))
    }

    // --- internals -------------------------------------------------------

    /// Output path of `wire`'s `proc.onData` (`agents.mjs:237-243`).
    fn on_output(&self, id: &str, generation: u64, bytes: &[u8]) {
        let now = (self.config.clock)();
        let mut events = Vec::new();
        {
            let mut state = self.state.lock().unwrap();
            let Some(agent) = state.find_mut(id) else {
                return;
            };
            // Stale generation (`rust-pty-backend.mjs:63-67`): an event from a
            // superseded spawn, or from a pty that already exited, is dropped.
            if !agent.live || agent.generation != generation {
                return;
            }
            let text = decode_output(&mut agent.decoder_carry, bytes);
            push_output(agent, &text, now, &mut events);
        }
        for event in &events {
            self.bus.emit(event);
        }
    }

    /// Exit path of `wire`'s `proc.onExit` (`agents.mjs:244-291`) with the
    /// decoder flush from `rust-pty-backend.mjs:124-131`.
    fn on_exit(&self, id: &str, generation: u64, exit_code: Option<i32>) {
        let now = (self.config.clock)();
        let mut events = Vec::new();
        let action = {
            let mut state = self.state.lock().unwrap();
            let draining = state.draining;
            let mut remove = false;
            let action = {
                let Some(agent) = state.find_mut(id) else {
                    return;
                };
                if !agent.live || agent.generation != generation {
                    return;
                }
                // `decoder.end()` still delivers the buffered tail (`:125-126`).
                let tail = flush_output(&mut agent.decoder_carry);
                push_output(agent, &tail, now, &mut events);
                agent.live = false;
                agent.last_output = None;
                if draining {
                    ExitAction::Drained
                } else if let Some(config) = agent.respawn_after_exit.take() {
                    remove = true;
                    ExitAction::Respawn(CreateAgent {
                        cwd: config.cwd,
                        title: config.title,
                        model: config.model,
                        scopes: config.scopes,
                        session_id: Some(id.to_owned()),
                        prompt: None,
                        permission_mode: config.permission_mode,
                        extra_args: config.extra_args,
                        // `create({ sessionId: id, ...cfg })` has no `mock`.
                        mock: false,
                        tool: config.tool,
                        created_at: config.created_at,
                        thread_id: config.thread_id,
                        run_id: None,
                    })
                } else if agent.remove_on_exit {
                    remove = true;
                    ExitAction::Removed
                } else {
                    let banner = BannerInput {
                        id: id.to_owned(),
                        model: agent.record.model.clone(),
                        tool: agent.record.tool.clone(),
                        cwd: agent.record.cwd.clone(),
                        created_at: agent.record.created_at,
                        thread_id: agent.record.thread_id.clone(),
                        exit_code,
                    };
                    set_status(agent, Status::Exited, now, &mut events);
                    remove = true;
                    ExitAction::Bannered(banner)
                }
            };
            if remove {
                state.remove(id);
            }
            action
        };
        for event in &events {
            self.bus.emit(event);
        }
        match action {
            ExitAction::Drained => {}
            ExitAction::Removed => {
                let _ = self.persist();
                self.emit_list();
            }
            ExitAction::Bannered(banner) => {
                let command = self.resume_command(&banner);
                self.bus.emit(&BusEvent::Output {
                    id: banner.id.clone(),
                    data: format!(
                        "\r\n\x1b[90m[agent exited code={}] resume: {command}\x1b[0m\r\n",
                        code_text(banner.exit_code)
                    ),
                });
                // Node logs a cleanup persist failure instead of failing the
                // exit (`:289-290`).
                let _ = self.persist();
                self.emit_list();
            }
            ExitAction::Respawn(input) => {
                let _ = self.persist();
                self.emit_list();
                let _ = self.create(input);
            }
        }
    }

    /// `rememberCodexThread` (`agents.mjs:184-191`): pin the first discovered
    /// thread uuid onto the record (persisted, best effort).
    fn remember_codex_thread(&self, id: &str) -> Option<String> {
        let record = self.record(id)?;
        let is_codex = record.tool.as_deref() == Some("codex")
            || route_flag(
                &self.route(record.model.as_deref(), record.tool.as_deref()),
                "isCodexModel",
            );
        let cwd = record.cwd.as_deref().filter(|value| !value.is_empty());
        if !is_codex {
            return None;
        }
        let cwd = cwd?;
        if let Some(thread) = record
            .thread_id
            .as_deref()
            .filter(|value| !value.is_empty())
        {
            return Some(thread.to_owned());
        }
        let found = self.discover_codex_thread(Some(cwd), record.created_at, id);
        if let Some(thread) = found.as_deref() {
            if let Some(agent) = self.state.lock().unwrap().find_mut(id) {
                agent.record.thread_id = Some(thread.to_owned());
            }
            // The pin is a cache — a write failure must not fail the caller.
            let _ = self.persist();
        }
        found
    }

    /// `findCodexThread(cwd, createdAt)` else `codexThreadExists(id, cwd)`
    /// (`agents.mjs:187-188`).
    fn discover_codex_thread(
        &self,
        cwd: Option<&str>,
        created_at: Option<i64>,
        id: &str,
    ) -> Option<String> {
        let cwd = cwd.filter(|value| !value.is_empty())?;
        let home = self.codex_home();
        created_at
            .and_then(|at| {
                codex_thread_identity::find(Some(&home), Some(cwd), Some(at))
                    .as_str()
                    .map(str::to_owned)
            })
            .or_else(|| {
                (codex_thread_identity::exists(Some(&home), Some(cwd), Some(id)).as_bool()
                    == Some(true))
                .then(|| id.to_owned())
            })
    }

    /// The `[agent exited code=N] resume: …` command (`agents.mjs:275-279`).
    fn resume_command(&self, banner: &BannerInput) -> String {
        let route = self.route(banner.model.as_deref(), banner.tool.as_deref());
        if banner.tool.as_deref() == Some("codex") || route_flag(&route, "isCodexModel") {
            let thread = banner
                .thread_id
                .clone()
                .filter(|thread| !thread.is_empty())
                .or_else(|| {
                    self.discover_codex_thread(banner.cwd.as_deref(), banner.created_at, &banner.id)
                });
            return thread.map_or_else(
                || "codex".to_owned(),
                |thread| format!("codex resume {thread}"),
            );
        }
        if route_flag(&route, "isClaudeModel") {
            let model = banner
                .model
                .as_deref()
                .filter(|model| !model.is_empty() && *model != "claude");
            return match model {
                Some(model) => format!("claude --resume {} --model {model}", banner.id),
                None => format!("claude --resume {}", banner.id),
            };
        }
        format!(
            "ollama launch claude --model {} -- --resume {}",
            banner.model.as_deref().unwrap_or_default(),
            banner.id
        )
    }

    /// `ensureTrusted` (`agents.mjs:463-471`): pre-seed Claude's workspace-trust
    /// flag so a daemon-spawned claude does not stall on the safety prompt.
    /// Never throws into the spawn path.
    fn ensure_trusted(&self, cwd: &str) {
        let file = self.config.bins.paths.home.join(".claude.json");
        let Ok(text) = fs::read_to_string(&file) else {
            return;
        };
        let Ok(mut json) = serde_json::from_str::<Value>(&text) else {
            return;
        };
        let Some(root) = json.as_object_mut() else {
            return;
        };
        let projects = root
            .entry("projects")
            .or_insert_with(|| Value::Object(Default::default()));
        let Some(projects) = projects.as_object_mut() else {
            return;
        };
        let key = cwd.replace('\\', "/");
        let entry = projects
            .entry(key)
            .or_insert_with(|| Value::Object(Default::default()));
        let Some(entry) = entry.as_object_mut() else {
            return;
        };
        if entry.get("hasTrustDialogAccepted") == Some(&Value::Bool(true)) {
            return;
        }
        entry.insert("hasTrustDialogAccepted".to_owned(), Value::Bool(true));
        // `JSON.stringify(json, null, 2)` (`agents.mjs:469`).
        let rendered = serde_json::to_string_pretty(&json).unwrap_or_default();
        let _ = fs_atomic::write_atomic(&file, rendered.as_bytes());
    }

    /// `rememberRepo` (`agents.mjs:224-226`).
    fn remember_repo(&self, cwd: &str) {
        let mut state = self.state.lock().unwrap();
        state.recent_repos = std::iter::once(cwd.to_owned())
            .chain(
                state
                    .recent_repos
                    .iter()
                    .filter(|repo| repo.as_str() != cwd)
                    .cloned(),
            )
            .take(RECENT_MAX)
            .collect();
    }

    /// Per-id generation, incremented before every spawn and never reset
    /// (`rust-pty-backend.mjs:141-145`).
    fn next_generation(&self, id: &str) -> u64 {
        let mut state = self.state.lock().unwrap();
        let generation = state.generations.entry(id.to_owned()).or_insert(0);
        *generation += 1;
        *generation
    }

    /// `getModelRoute(model, tool)` (`server/models.mjs`, `models.rs:308`).
    fn route(&self, model: Option<&str>, tool: Option<&str>) -> Value {
        let model = model.map_or(Value::Null, |model| Value::String(model.to_owned()));
        let tool = tool.map_or(Value::Null, |tool| Value::String(tool.to_owned()));
        models::route(
            &self.config.bins.paths.models_state.to_string_lossy(),
            &model,
            &tool,
        )
    }

    fn codex_home(&self) -> String {
        self.config
            .bins
            .paths
            .codex_home
            .to_string_lossy()
            .into_owned()
    }

    /// `recentRepos` (`agents.mjs:1163-1166`), as the `/ws` list frame sends it.
    pub fn recent_repos(&self) -> Vec<String> {
        self.state.lock().unwrap().recent_repos.clone()
    }

    /// The full persisted record (`agents.get(id)`), for `externalLaunch`.
    pub fn record(&self, id: &str) -> Option<AgentRecord> {
        self.state
            .lock()
            .unwrap()
            .find(id)
            .map(|agent| agent.record.clone())
    }

    fn wire(&self, id: &str) -> Option<AgentWire> {
        self.state.lock().unwrap().find(id).map(wire)
    }

    fn emit_list(&self) {
        self.bus.emit(&BusEvent::List(self.snapshot()));
    }
}

/// `snapshot()`'s projection (`agents.mjs:126-128`).
fn wire(agent: &Agent) -> AgentWire {
    AgentWire {
        id: agent.record.id.clone(),
        title: agent.record.title.clone(),
        cwd: agent.record.cwd.clone(),
        status: agent.record.status,
        pid: agent.pid,
        created_at: agent.record.created_at,
        model: agent.record.model.clone(),
        scopes: agent.record.scopes.clone(),
        tool: agent.record.tool.clone(),
    }
}

/// One `agents.json` entry (`agents.mjs:89-94`): running/starting/idle are
/// stored as `detached`, and the live running span is folded into `activeMs`.
fn persisted_record(agent: &Agent, now: i64) -> AgentRecord {
    let mut record = agent.record.clone();
    record.status = match record.status {
        Status::Running | Status::Starting | Status::Idle => Status::Detached,
        other => other,
    };
    record.active_ms = if agent.record.status == Status::Running {
        let span = agent.running_since.map_or(0, |since| now - since);
        Some(agent.record.active_ms.unwrap_or(0) + span)
    } else {
        agent.record.active_ms
    };
    record
}

/// `setStatus` (`agents.mjs:204-209`): the single status transition point,
/// tracking `activeMs` across the running ↔ idle/exited/detached edges and
/// emitting the `status` event.
fn set_status(agent: &mut Agent, status: Status, now: i64, events: &mut Vec<BusEvent>) {
    if status == Status::Running && agent.record.status != Status::Running {
        agent.running_since = Some(now);
    } else if agent.record.status == Status::Running && status != Status::Running {
        let span = agent.running_since.map_or(0, |since| now - since);
        agent.record.active_ms = Some(agent.record.active_ms.unwrap_or(0) + span);
        agent.running_since = None;
    }
    agent.record.status = status;
    events.push(BusEvent::Status {
        id: agent.record.id.clone(),
        status,
    });
}

/// `pushBuf` (`agents.mjs:217-222`): append, count, then trim the oldest chunks
/// until the ring fits — always keeping at least one chunk.
///
/// Divergence (accepted, design Q4): Node counts `String.length`, i.e. UTF-16
/// code units, while this ring counts UTF-8 bytes, so non-ASCII scrollback is
/// trimmed somewhat earlier than in Node. `written` counts the same unit as the
/// ring so the two stay consistent with each other.
fn push_buf(agent: &mut Agent, data: &str) {
    agent.ring.push(data.to_owned());
    agent.ring_bytes += data.len();
    agent.written += data.len();
    while agent.ring_bytes > RING_MAX && agent.ring.len() > 1 {
        let removed = agent.ring.remove(0);
        agent.ring_bytes -= removed.len();
    }
}

/// One decoded output chunk (`agents.mjs:237-243`): buffer it, flip
/// starting/idle → running, emit `output`, stamp the idle timer.
fn push_output(agent: &mut Agent, data: &str, now: i64, events: &mut Vec<BusEvent>) {
    if data.is_empty() {
        return;
    }
    push_buf(agent, data);
    if matches!(agent.record.status, Status::Starting | Status::Idle) {
        set_status(agent, Status::Running, now, events);
    }
    events.push(BusEvent::Output {
        id: agent.record.id.clone(),
        data: data.to_owned(),
    });
    agent.last_output = Some(now);
}

/// Streaming UTF-8 decode matching Node's `StringDecoder` (`rust-pty-backend.mjs:83`):
/// bytes are carried across chunks, an incomplete trailing sequence waits for
/// the next chunk, and each maximal invalid subpart becomes one `U+FFFD`.
fn decode_output(carry: &mut Vec<u8>, bytes: &[u8]) -> String {
    carry.extend_from_slice(bytes);
    let mut text = String::with_capacity(carry.len());
    let mut start = 0;
    while start < carry.len() {
        match std::str::from_utf8(&carry[start..]) {
            Ok(decoded) => {
                text.push_str(decoded);
                start = carry.len();
            }
            Err(error) => {
                let valid = error.valid_up_to();
                if let Ok(prefix) = std::str::from_utf8(&carry[start..start + valid]) {
                    text.push_str(prefix);
                }
                start += valid;
                match error.error_len() {
                    Some(len) => {
                        text.push('\u{FFFD}');
                        start += len;
                    }
                    // Incomplete trailing sequence: keep it for the next chunk.
                    None => break,
                }
            }
        }
    }
    carry.drain(..start);
    text
}

/// `decoder.end()` (`rust-pty-backend.mjs:125`): flush whatever is left,
/// replacing an incomplete trailing sequence with `U+FFFD`.
fn flush_output(carry: &mut Vec<u8>) -> String {
    if carry.is_empty() {
        return String::new();
    }
    let text = String::from_utf8_lossy(carry).into_owned();
    carry.clear();
    text
}

/// `untildify` (`agents.mjs:411-414`): `~`, `~/x` and `~\x` expand against the
/// injected home; anything else is untouched.
fn untildify_cwd(raw: &str, home: &Path) -> PathBuf {
    if raw == "~" {
        return home.to_path_buf();
    }
    app_paths::untildify(raw, home)
}

/// `normPath` (`server/codex-thread.mjs:10-13`): resolve, `\` → `/`, and
/// lowercase on Windows so cwd comparisons survive case/separator differences.
/// (`codex_thread_identity::normalized_path` is private to that module; this is
/// the same comparison, exposed for the registry's prefilter.)
fn norm_path(raw: &str) -> String {
    let cwd = std::env::current_dir().unwrap_or_default();
    let resolved = app_paths::resolve_from(Path::new(raw), &cwd);
    let slashed = resolved.to_string_lossy().replace('\\', "/");
    if cfg!(windows) {
        slashed.to_lowercase()
    } else {
        slashed
    }
}

fn route_flag(route: &Value, key: &str) -> bool {
    route.get(key).and_then(Value::as_bool) == Some(true)
}

fn code_text(code: Option<i32>) -> String {
    code.map_or_else(|| "null".to_owned(), |code| code.to_string())
}

/// `randomUUID()` (`agents.mjs:419`, `:547`): a v4-shaped id from a
/// time/pid/counter-seeded splitmix64 stream. Not cryptographically random —
/// the daemon only needs collision-free ids within one process.
fn new_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};

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
mod tests {
    use super::*;
    use crate::agent_spawn::SpawnPaths;
    use serde_json::json;
    use std::sync::atomic::{AtomicI64, AtomicU32, AtomicUsize, Ordering};

    static NEXT_FIXTURE: AtomicUsize = AtomicUsize::new(0);

    /// A temp-dir fixture: home, an existing repo dir, a state dir and fake
    /// binaries. Nothing ever touches the real home, state or a real process.
    struct Fixture {
        root: PathBuf,
        clock: Arc<AtomicI64>,
    }

    impl Fixture {
        fn new() -> Self {
            let stamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let root = std::env::temp_dir().join(format!(
                "singularity-agent-registry-{}-{stamp}-{}",
                std::process::id(),
                NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(root.join("home")).unwrap();
            fs::create_dir_all(root.join("repo")).unwrap();
            fs::create_dir_all(root.join("state")).unwrap();
            Self {
                root,
                clock: Arc::new(AtomicI64::new(now_ms())),
            }
        }

        fn path(&self, rel: &str) -> PathBuf {
            self.root.join(rel)
        }

        fn repo(&self) -> String {
            self.path("repo").to_string_lossy().into_owned()
        }

        fn state_file(&self) -> PathBuf {
            self.path("state/agents.json")
        }

        fn models_state(&self) -> String {
            self.path("state/models.json")
                .to_string_lossy()
                .into_owned()
        }

        fn touch(&self, rel: &str) -> String {
            let path = self.path(rel);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, b"").unwrap();
            path.to_string_lossy().into_owned()
        }

        fn bins(&self) -> Bins {
            let claude = self.touch("bin/claude.exe");
            let ollama = self.touch("bin/ollama.exe");
            let codex = self.touch("bin/codex.exe");
            Bins::resolve(
                Some(&claude),
                Some(&ollama),
                Some(&codex),
                SpawnPaths {
                    home: self.path("home"),
                    scope_root: None,
                    cache_dir: self.path("cache"),
                    codex_home: self.path("codex-home"),
                    models_state: self.path("state/models.json"),
                },
            )
        }

        fn clock(&self) -> Clock {
            let value = self.clock.clone();
            Arc::new(move || value.load(Ordering::SeqCst))
        }

        fn now(&self) -> i64 {
            self.clock.load(Ordering::SeqCst)
        }

        fn advance(&self, ms: i64) {
            self.clock.fetch_add(ms, Ordering::SeqCst);
        }

        fn config(&self) -> RegistryConfig {
            RegistryConfig {
                state_file: self.state_file(),
                bins: self.bins(),
                parent_env: BTreeMap::new(),
                clock: self.clock(),
            }
        }

        fn registry(&self, port: Arc<FakePort>) -> Arc<Registry> {
            Arc::new(Registry::new(Bus::new(), port, self.config()))
        }

        fn write_agents(&self, agents: Vec<Value>) {
            let doc = json!({ "agents": agents, "recentRepos": [] });
            fs::write(
                self.state_file(),
                serde_json::to_string_pretty(&doc).unwrap(),
            )
            .unwrap();
        }

        fn read_agents(&self) -> AgentsFile {
            AgentsFile::parse(&fs::read_to_string(self.state_file()).unwrap()).unwrap()
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    struct SpawnRecord {
        #[allow(dead_code)]
        id: String,
        #[allow(dead_code)]
        generation: u64,
        spec: LaunchSpec,
    }

    #[derive(Default)]
    struct FakePort {
        spawns: Mutex<Vec<SpawnRecord>>,
        writes: Mutex<Vec<(String, Vec<u8>)>>,
        resizes: Mutex<Vec<(String, u16, u16)>>,
        kills: Mutex<Vec<String>>,
        fail_spawn: Mutex<Option<String>>,
        next_pid: AtomicU32,
        on_spawn: Mutex<Option<Arc<dyn Fn(&str, u64) + Send + Sync>>>,
    }

    impl FakePort {
        fn new() -> Arc<Self> {
            Arc::new(Self {
                next_pid: AtomicU32::new(1000),
                ..Self::default()
            })
        }

        fn set_fail_spawn(&self, message: &str) {
            *self.fail_spawn.lock().unwrap() = Some(message.to_owned());
        }

        fn on_spawn(&self, hook: Arc<dyn Fn(&str, u64) + Send + Sync>) {
            *self.on_spawn.lock().unwrap() = Some(hook);
        }

        fn spawn_count(&self) -> usize {
            self.spawns.lock().unwrap().len()
        }

        fn last_spec(&self) -> LaunchSpec {
            self.spawns
                .lock()
                .unwrap()
                .last()
                .expect("a spawn was recorded")
                .spec
                .clone()
        }

        fn write_count(&self) -> usize {
            self.writes.lock().unwrap().len()
        }

        fn resize_count(&self) -> usize {
            self.resizes.lock().unwrap().len()
        }

        fn kills(&self) -> Vec<String> {
            self.kills.lock().unwrap().clone()
        }
    }

    impl PtyPort for FakePort {
        fn spawn(&self, id: &str, generation: u64, spec: LaunchSpec) -> Result<u32, String> {
            if let Some(message) = self.fail_spawn.lock().unwrap().clone() {
                return Err(message);
            }
            self.spawns.lock().unwrap().push(SpawnRecord {
                id: id.to_owned(),
                generation,
                spec: spec.clone(),
            });
            if let Some(hook) = self.on_spawn.lock().unwrap().clone() {
                hook(id, generation);
            }
            Ok(self.next_pid.fetch_add(1, Ordering::SeqCst))
        }

        fn write(&self, id: &str, data: &[u8]) -> Result<(), String> {
            self.writes
                .lock()
                .unwrap()
                .push((id.to_owned(), data.to_vec()));
            Err("write rejected".to_owned())
        }

        fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
            self.resizes
                .lock()
                .unwrap()
                .push((id.to_owned(), cols, rows));
            Err("resize rejected".to_owned())
        }

        fn kill(&self, id: &str) -> Result<(), String> {
            self.kills.lock().unwrap().push(id.to_owned());
            Err("kill rejected".to_owned())
        }
    }

    type Recorder<T> = Arc<Mutex<Vec<T>>>;

    fn record_outputs(registry: &Registry) -> Recorder<(String, String)> {
        let seen: Recorder<(String, String)> = Arc::new(Mutex::new(Vec::new()));
        let sink = seen.clone();
        registry.bus().subscribe(Arc::new(move |event| {
            if let BusEvent::Output { id, data } = event {
                sink.lock().unwrap().push((id.clone(), data.clone()));
            }
        }));
        seen
    }

    fn record_statuses(registry: &Registry) -> Recorder<(String, Status)> {
        let seen: Recorder<(String, Status)> = Arc::new(Mutex::new(Vec::new()));
        let sink = seen.clone();
        registry.bus().subscribe(Arc::new(move |event| {
            if let BusEvent::Status { id, status } = event {
                sink.lock().unwrap().push((id.clone(), *status));
            }
        }));
        seen
    }

    fn record_lists(registry: &Registry) -> Recorder<Vec<String>> {
        let seen: Recorder<Vec<String>> = Arc::new(Mutex::new(Vec::new()));
        let sink = seen.clone();
        registry.bus().subscribe(Arc::new(move |event| {
            if let BusEvent::List(agents) = event {
                sink.lock()
                    .unwrap()
                    .push(agents.iter().map(|agent| agent.id.clone()).collect());
            }
        }));
        seen
    }

    fn create_input(fixture: &Fixture, id: &str, model: &str) -> CreateAgent {
        CreateAgent {
            cwd: Some(fixture.repo()),
            title: Some("demo".to_owned()),
            model: Some(model.to_owned()),
            session_id: Some(id.to_owned()),
            ..CreateAgent::default()
        }
    }

    fn output(registry: &Registry, id: &str, generation: u64, bytes: &[u8]) {
        registry.on_pty_event(PtyEvent::Output {
            id: id.to_owned(),
            generation,
            bytes: bytes.to_vec(),
        });
    }

    fn exit(registry: &Registry, id: &str, generation: u64, code: Option<i32>) {
        registry.on_pty_event(PtyEvent::Exit {
            id: id.to_owned(),
            generation,
            exit_code: code,
        });
    }

    fn write_codex_rollout(fixture: &Fixture, cwd: &str, timestamp_ms: i64, thread_id: &str) {
        let dir = fixture.path("codex-home/sessions/2026/08/03");
        fs::create_dir_all(&dir).unwrap();
        let timestamp =
            time::OffsetDateTime::from_unix_timestamp_nanos(i128::from(timestamp_ms) * 1_000_000)
                .unwrap()
                .format(&time::format_description::well_known::Rfc3339)
                .unwrap();
        let meta = json!({
            "timestamp": timestamp,
            "type": "session_meta",
            "payload": {
                "session_id": thread_id,
                "id": thread_id,
                "timestamp": timestamp,
                "cwd": cwd,
                "originator": "codex-tui",
                "source": "cli",
                "thread_source": "user",
                "model_provider": "openai",
            },
        });
        fs::write(
            dir.join(format!("rollout-{thread_id}.jsonl")),
            format!("{meta}\n"),
        )
        .unwrap();
    }

    /// `customModelGroup` (`agents.test.mjs:169-175`): rewrite the catalogue
    /// entry for `gpt-custom` so a route change is observable.
    fn custom_model_group(fixture: &Fixture, group: &str) {
        let path = fixture.models_state();
        let mut doc = models::get(&path);
        let models = doc["models"].as_array_mut().unwrap();
        models.retain(|model| model["id"] != json!("gpt-custom"));
        models.push(json!({
            "id": "gpt-custom",
            "group": group,
            "label": "Custom",
            "enabled": true,
        }));
        let result = models::set(&path, &doc);
        assert_eq!(result["ok"], json!(true));
    }

    // agents.test.mjs:120-167 — the entry exists before the pty spawn returns.
    #[test]
    fn registers_the_entry_before_the_pty_spawn_and_applies_early_output() {
        let fixture = Fixture::new();
        let port = FakePort::new();
        let registry = fixture.registry(port.clone());
        let outputs = record_outputs(&registry);
        let registered: Arc<Mutex<Vec<bool>>> = Arc::new(Mutex::new(Vec::new()));
        let registered_in_hook = registered.clone();
        let weak = Arc::downgrade(&registry);
        port.on_spawn(Arc::new(move |id, generation| {
            let registry = weak.upgrade().expect("registry outlives the spawn");
            registered_in_hook
                .lock()
                .unwrap()
                .push(registry.snapshot().iter().any(|agent| agent.id == id));
            registry.on_pty_event(PtyEvent::Output {
                id: id.to_owned(),
                generation,
                bytes: b"EARLY".to_vec(),
            });
        }));

        let agent = registry
            .create(create_input(&fixture, "adapter-id", "claude"))
            .unwrap();
        assert_eq!(*registered.lock().unwrap(), [true]);
        assert_eq!(agent.id, "adapter-id");
        assert_eq!(agent.pid, Some(1000));
        assert_eq!(registry.get_buf("adapter-id"), "EARLY");
        assert_eq!(registry.get_written("adapter-id"), 5);
        assert_eq!(registry.get_status("adapter-id"), Some(Status::Running));

        let spec = port.last_spec();
        assert_eq!(spec.bin, fixture.path("bin/claude.exe").to_string_lossy());
        assert_eq!(spec.cwd, fixture.repo());
        assert_eq!((spec.cols, spec.rows), (80, 24));
        assert_eq!(
            spec.env.get("HARNESS_LAUNCH_SOURCE").map(String::as_str),
            Some("singularity")
        );
        assert!(spec.args.iter().any(|arg| arg == "--session-id"));
        assert_eq!(
            *outputs.lock().unwrap(),
            [("adapter-id".to_owned(), "EARLY".to_owned())]
        );

        // Rejected adapter calls stay contained, like Node's handled rejections.
        registry.input("adapter-id", "later");
        registry.resize("adapter-id", 100, 40);
        registry.kill("adapter-id").unwrap();
        assert_eq!(port.write_count(), 1);
        assert_eq!(port.resize_count(), 1);
        assert_eq!(port.kills(), ["adapter-id"]);

        exit(&registry, "adapter-id", 1, Some(0));
        assert!(registry.snapshot().is_empty());
    }

    #[test]
    fn a_failed_spawn_leaves_no_registry_entry() {
        let fixture = Fixture::new();
        let port = FakePort::new();
        let registry = fixture.registry(port.clone());
        port.set_fail_spawn("spawn exploded");
        assert_eq!(
            registry
                .create(create_input(&fixture, "boom", "claude"))
                .unwrap_err(),
            "spawn exploded"
        );
        assert!(registry.snapshot().is_empty());
        assert!(!registry.is_live("boom"));
    }

    #[test]
    fn create_rejects_a_live_session_id() {
        let fixture = Fixture::new();
        let port = FakePort::new();
        let registry = fixture.registry(port.clone());
        registry
            .create(create_input(&fixture, "dup", "claude"))
            .unwrap();
        assert_eq!(
            registry
                .create(create_input(&fixture, "dup", "claude"))
                .unwrap_err(),
            "session id already in use"
        );
        assert_eq!(port.spawn_count(), 1);
    }

    // agents.test.mjs:309-320 — a mismatched tool/model pairing never spawns.
    #[test]
    fn create_rejects_a_codex_tool_paired_with_a_claude_model() {
        let fixture = Fixture::new();
        let port = FakePort::new();
        let registry = fixture.registry(port.clone());
        let mut input = create_input(&fixture, "mismatch", "sonnet");
        input.tool = Some("codex".to_owned());
        let error = registry.create(input).unwrap_err();
        assert!(
            error.contains("sonnet") && error.contains("codex"),
            "{error}"
        );
        assert!(registry.snapshot().is_empty());
        assert_eq!(port.spawn_count(), 0);
    }

    // agents.test.mjs:285-307 — re-entering a dead id resumes it.
    #[test]
    fn create_resumes_a_dead_duplicate_id_instead_of_refusing() {
        let fixture = Fixture::new();
        let port = FakePort::new();
        let dead = "20000000-bbbb-cccc-dddd-200000000002";
        fixture.write_agents(vec![json!({
            "id": dead,
            "title": "deadname",
            "cwd": fixture.repo(),
            "createdAt": fixture.now(),
            "model": "claude",
            "scopes": [],
        })]);
        let registry = fixture.registry(port.clone());
        registry.load().unwrap();
        assert_eq!(registry.get_status(dead), Some(Status::Detached));
        let agent = registry
            .create(CreateAgent {
                cwd: Some(fixture.repo()),
                model: Some("claude".to_owned()),
                session_id: Some(dead.to_owned()),
                ..CreateAgent::default()
            })
            .unwrap();
        assert_eq!(agent.id, dead);
        assert!(agent.pid.is_some());
        assert!(registry.is_live(dead));
        assert_eq!(port.spawn_count(), 1);
    }

    // agents.test.mjs:322-338.
    #[test]
    fn remove_drops_a_detached_agent() {
        let fixture = Fixture::new();
        let port = FakePort::new();
        let gone = "30000000-cccc-dddd-eeee-300000000003";
        fixture.write_agents(vec![json!({
            "id": gone,
            "title": "gonename",
            "cwd": fixture.repo(),
            "createdAt": fixture.now(),
            "model": "claude",
            "scopes": [],
        })]);
        let registry = fixture.registry(port);
        registry.load().unwrap();
        assert!(registry.snapshot().iter().any(|agent| agent.id == gone));
        registry.remove(gone).unwrap();
        assert!(registry.snapshot().is_empty());
        assert!(fixture.read_agents().agents.is_empty());
    }

    #[test]
    fn remove_of_a_live_agent_defers_the_drop_to_its_exit() {
        let fixture = Fixture::new();
        let port = FakePort::new();
        let registry = fixture.registry(port.clone());
        registry
            .create(create_input(&fixture, "task", "claude"))
            .unwrap();
        registry.remove("task").unwrap();
        assert_eq!(port.kills(), ["task"]);
        assert!(registry.is_live("task"));
        exit(&registry, "task", 1, Some(0));
        assert!(registry.snapshot().is_empty());
    }

    // agents.test.mjs:346-378 — the codex thread is pinned before the kill.
    #[test]
    fn respawn_pins_the_codex_thread_before_killing_the_live_pty() {
        let fixture = Fixture::new();
        let port = FakePort::new();
        let registry = fixture.registry(port.clone());
        let id = "codex-respawn";
        let thread = "pinned-thread-id";
        let mut input = create_input(&fixture, id, "gpt-5.3-codex-spark");
        input.tool = Some("codex".to_owned());
        let agent = registry.create(input).unwrap();
        write_codex_rollout(&fixture, &fixture.repo(), fixture.now() + 1000, thread);

        assert!(registry.respawn(id));
        assert!(
            registry.is_live(id),
            "the original pty is still live when respawn returns"
        );
        assert_eq!(port.kills(), [id]);
        assert_eq!(registry.codex_thread_for(id).as_deref(), Some(thread));

        exit(&registry, id, 1, Some(0));
        let resumed = registry
            .snapshot()
            .into_iter()
            .find(|entry| entry.id == id)
            .expect("onExit respawned the same agent");
        assert!(resumed.pid.is_some());
        assert_ne!(resumed.pid, agent.pid);
        assert!(registry.is_live(id));
        assert_eq!(port.spawn_count(), 2);
        assert_eq!(port.last_spec().args[..2], ["resume", thread]);
        assert_eq!(registry.codex_thread_for(id).as_deref(), Some(thread));
    }

    // agents.test.mjs:380-417.
    #[test]
    fn respawn_all_resumes_with_the_same_id_and_a_new_pid() {
        let fixture = Fixture::new();
        let port = FakePort::new();
        let registry = fixture.registry(port.clone());
        let id = "resp";
        let agent = registry
            .create(create_input(&fixture, id, "glm-5.2:cloud"))
            .unwrap();
        assert!(agent.pid.is_some());
        assert_eq!(registry.respawn_all(), [id]);
        exit(&registry, id, 1, Some(0));
        let resumed = registry
            .snapshot()
            .into_iter()
            .find(|entry| entry.id == id)
            .expect("agent still present after respawn");
        assert_ne!(resumed.pid, agent.pid);
        assert!(registry.is_live(id));
        assert_eq!(port.spawn_count(), 2);
    }

    // agents.test.mjs:477-492.
    #[test]
    fn begin_drain_persists_live_sessions_as_detached_and_survives_their_exit() {
        let fixture = Fixture::new();
        let port = FakePort::new();
        let registry = fixture.registry(port);
        let id = "drain";
        registry
            .create(create_input(&fixture, id, "glm-5.2:cloud"))
            .unwrap();
        registry.begin_drain();
        let on_disk = fixture
            .read_agents()
            .agents
            .into_iter()
            .find(|agent| agent.id == id)
            .expect("live session written at drain");
        assert_eq!(on_disk.status, Status::Detached);

        let lists = record_lists(&registry);
        exit(&registry, id, 1, Some(0));
        assert!(
            registry.snapshot().iter().any(|agent| agent.id == id),
            "entry retained in the registry after the pty exit"
        );
        assert!(
            fixture
                .read_agents()
                .agents
                .iter()
                .any(|agent| agent.id == id),
            "entry retained in agents.json after the pty exit"
        );
        assert!(lists.lock().unwrap().is_empty());
    }

    // agents.test.mjs:441-457 — the exit banner re-reads the model catalogue.
    #[test]
    fn exit_uses_a_fresh_codex_route_and_removes_the_entry() {
        let fixture = Fixture::new();
        let port = FakePort::new();
        let registry = fixture.registry(port);
        let id = "route-change";
        custom_model_group(&fixture, "claude");
        let mut input = create_input(&fixture, id, "gpt-custom");
        input.tool = Some("claude".to_owned());
        registry.create(input).unwrap();
        custom_model_group(&fixture, "codex");

        let outputs = record_outputs(&registry);
        let lists = record_lists(&registry);
        exit(&registry, id, 1, Some(0));
        let banner = outputs
            .lock()
            .unwrap()
            .iter()
            .find(|(agent, _)| agent == id)
            .map(|(_, data)| data.clone())
            .expect("resume banner");
        assert!(
            banner.contains("[agent exited code=0] resume: codex"),
            "{banner}"
        );
        assert!(!registry.snapshot().iter().any(|agent| agent.id == id));
        assert_eq!(lists.lock().unwrap().last().map(Vec::len), Some(0));
    }

    #[test]
    fn exit_reports_code_null_when_the_pty_reports_no_code() {
        let fixture = Fixture::new();
        let port = FakePort::new();
        let registry = fixture.registry(port);
        registry
            .create(create_input(&fixture, "nocode", "claude"))
            .unwrap();
        let outputs = record_outputs(&registry);
        exit(&registry, "nocode", 1, None);
        let banner = outputs
            .lock()
            .unwrap()
            .iter()
            .find(|(agent, data)| agent == "nocode" && data.contains("resume:"))
            .map(|(_, data)| data.clone())
            .expect("resume banner");
        assert!(banner.contains("[agent exited code=null]"), "{banner}");
        assert!(
            banner.contains("resume: claude --resume nocode"),
            "{banner}"
        );
    }

    #[test]
    fn output_from_a_superseded_generation_is_dropped() {
        let fixture = Fixture::new();
        let port = FakePort::new();
        let registry = fixture.registry(port);
        registry
            .create(create_input(&fixture, "gen", "claude"))
            .unwrap();
        output(&registry, "gen", 0, b"stale");
        assert_eq!(registry.get_buf("gen"), "");
        output(&registry, "gen", 1, b"live");
        assert_eq!(registry.get_buf("gen"), "live");
        let outputs = record_outputs(&registry);
        exit(&registry, "gen", 1, Some(0));
        output(&registry, "gen", 1, b"after-exit");
        assert!(registry.snapshot().is_empty());
        assert!(
            !outputs
                .lock()
                .unwrap()
                .iter()
                .any(|(_, data)| data == "after-exit")
        );
        // An event for an id the registry never knew is ignored, not a panic.
        output(&registry, "unknown", 1, b"nothing");
    }

    #[test]
    fn output_decodes_utf8_across_chunks_and_replaces_invalid_bytes() {
        let fixture = Fixture::new();
        let port = FakePort::new();
        let registry = fixture.registry(port);
        registry
            .create(create_input(&fixture, "utf8", "claude"))
            .unwrap();
        let outputs = record_outputs(&registry);
        output(&registry, "utf8", 1, &[0xC3]);
        assert_eq!(registry.get_buf("utf8"), "", "the incomplete tail waits");
        output(&registry, "utf8", 1, &[0xA9]);
        assert_eq!(registry.get_buf("utf8"), "é");
        output(&registry, "utf8", 1, &[0xFF]);
        assert_eq!(registry.get_buf("utf8"), "é\u{FFFD}");
        // UTF-8 bytes: "é" is 2, U+FFFD is 3 (Node would count 2 UTF-16 units).
        assert_eq!(registry.get_written("utf8"), 5);

        // The carry is flushed on exit and delivered as output first.
        output(&registry, "utf8", 1, &[0xE2, 0x82]);
        exit(&registry, "utf8", 1, Some(0));
        let chunks: Vec<String> = outputs
            .lock()
            .unwrap()
            .iter()
            .filter(|(agent, _)| agent == "utf8")
            .map(|(_, data)| data.clone())
            .collect();
        assert!(chunks.iter().any(|chunk| chunk == "\u{FFFD}"), "{chunks:?}");
    }

    #[test]
    fn ring_keeps_the_newest_chunks_and_written_counts_every_byte() {
        let fixture = Fixture::new();
        let port = FakePort::new();
        let registry = fixture.registry(port);
        registry
            .create(create_input(&fixture, "ring", "claude"))
            .unwrap();
        let first = "a".repeat(200_000);
        let second = "b".repeat(100_000);
        output(&registry, "ring", 1, first.as_bytes());
        output(&registry, "ring", 1, second.as_bytes());
        assert_eq!(registry.get_buf("ring"), second);
        assert_eq!(registry.get_written("ring"), 300_000);
        // The last chunk is never trimmed, however large it is.
        let big = "c".repeat(RING_MAX + 10);
        output(&registry, "ring", 1, big.as_bytes());
        assert_eq!(registry.get_buf("ring").len(), RING_MAX + 10);
    }

    #[test]
    fn idle_tick_marks_a_quiet_running_agent_idle() {
        let fixture = Fixture::new();
        let port = FakePort::new();
        let registry = fixture.registry(port);
        registry
            .create(create_input(&fixture, "idle", "claude"))
            .unwrap();
        let statuses = record_statuses(&registry);
        let start = fixture.now();
        output(&registry, "idle", 1, b"working");
        assert_eq!(registry.get_status("idle"), Some(Status::Running));
        registry.tick(start + 1999);
        assert_eq!(registry.get_status("idle"), Some(Status::Running));
        registry.tick(start + 2000);
        assert_eq!(registry.get_status("idle"), Some(Status::Idle));
        assert!(
            statuses
                .lock()
                .unwrap()
                .iter()
                .any(|(agent, status)| agent == "idle" && *status == Status::Idle)
        );
        output(&registry, "idle", 1, b"more");
        assert_eq!(registry.get_status("idle"), Some(Status::Running));
    }

    #[test]
    fn persist_folds_the_live_span_and_detaches_running_agents() {
        let fixture = Fixture::new();
        let port = FakePort::new();
        let registry = fixture.registry(port);
        registry
            .create(create_input(&fixture, "fold", "claude"))
            .unwrap();
        let start = fixture.now();
        output(&registry, "fold", 1, b"go");
        fixture.advance(1500);
        registry.persist().unwrap();
        let record = fixture
            .read_agents()
            .agents
            .into_iter()
            .find(|agent| agent.id == "fold")
            .unwrap();
        assert_eq!(record.status, Status::Detached);
        assert_eq!(record.active_ms, Some(1500));
        assert_eq!(registry.active_ms("fold"), 1500);
        assert_eq!(record.created_at, Some(start));
        assert_eq!(registry.active_ms("missing"), 0);
    }

    #[test]
    fn persist_failure_is_reported_with_the_node_message() {
        let fixture = Fixture::new();
        let port = FakePort::new();
        let registry = Registry::new(
            Bus::new(),
            port,
            RegistryConfig {
                state_file: fixture.path("missing/agents.json"),
                ..fixture.config()
            },
        );
        let error = registry
            .create(create_input(&fixture, "disk", "claude"))
            .unwrap_err();
        assert!(error.starts_with("agents.json write failed:"), "{error}");
        // Node keeps the live agent even when the save fails.
        assert_eq!(registry.snapshot().len(), 1);
    }

    // agents.test.mjs:778-833.
    #[test]
    fn launch_config_for_a_codex_thread_inverts_the_rollout_lookup() {
        let fixture = Fixture::new();
        let port = FakePort::new();
        let thread = "dddddddd-eeee-ffff-0000-111111111111";
        write_codex_rollout(&fixture, &fixture.repo(), fixture.now() + 1000, thread);
        fixture.write_agents(vec![
            json!({
                "id": "codex-agent",
                "title": "codex-agent",
                "cwd": fixture.repo(),
                "createdAt": fixture.now(),
                "model": "gpt-5.3-codex-spark",
                "scopes": ["coding", "harness"],
                "tool": "codex",
            }),
            json!({
                "id": "claude-agent",
                "title": "claude-agent",
                "cwd": fixture.repo(),
                "createdAt": fixture.now(),
                "model": "claude",
                "scopes": ["coding"],
                "tool": "claude",
            }),
        ]);
        let registry = fixture.registry(port);
        registry.load().unwrap();
        let config = registry
            .get_launch_config_for_codex_thread(Some(thread), Some(&fixture.repo()))
            .expect("config");
        assert_eq!(config.scopes, ["coding", "harness"]);
        assert_eq!(config.tool, "codex");
        assert_eq!(config.model.as_deref(), Some("gpt-5.3-codex-spark"));

        assert!(
            registry
                .get_launch_config_for_codex_thread(Some(thread), Some("C:\\other"))
                .is_none()
        );
        assert!(
            registry
                .get_launch_config_for_codex_thread(
                    Some("99999999-9999-9999-9999-999999999999"),
                    Some(&fixture.repo())
                )
                .is_none()
        );
        // A claude agent in the same cwd never satisfies the codex filter.
        assert!(
            registry
                .get_launch_config_for_codex_thread(Some("claude-agent"), Some(&fixture.repo()))
                .is_none()
        );
        assert!(
            registry
                .get_launch_config_for_codex_thread(None, Some(&fixture.repo()))
                .is_none()
        );
        assert!(
            registry
                .get_launch_config_for_codex_thread(Some(thread), None)
                .is_none()
        );
        assert!(
            registry
                .get_launch_config_for_codex_thread(Some(""), Some(""))
                .is_none()
        );
    }

    // agents.test.mjs:840-853.
    #[test]
    fn codex_thread_for_resolves_and_pins_the_rollout_thread() {
        let fixture = Fixture::new();
        let port = FakePort::new();
        let thread = "dddddddd-eeee-ffff-0000-333333333333";
        write_codex_rollout(&fixture, &fixture.repo(), fixture.now() + 1000, thread);
        fixture.write_agents(vec![json!({
            "id": "codex-agent",
            "title": "codex-agent",
            "cwd": fixture.repo(),
            "createdAt": fixture.now(),
            "model": "gpt-5.3-codex-spark",
            "scopes": [],
            "tool": "codex",
        })]);
        let registry = fixture.registry(port);
        registry.load().unwrap();
        assert_eq!(
            registry.codex_thread_for("codex-agent").as_deref(),
            Some(thread)
        );
        assert_eq!(registry.codex_thread_for("missing"), None);
        let record = fixture
            .read_agents()
            .agents
            .into_iter()
            .find(|agent| agent.id == "codex-agent")
            .unwrap();
        assert_eq!(record.thread_id.as_deref(), Some(thread));
    }

    #[test]
    fn launch_config_defaults_match_get_launch_config() {
        let fixture = Fixture::new();
        let port = FakePort::new();
        fixture.write_agents(vec![json!({
            "id": "plain",
            "title": "p",
            "cwd": fixture.repo(),
            "model": "claude",
            "scopes": ["coding"],
        })]);
        let registry = fixture.registry(port);
        registry.load().unwrap();
        let config = registry.get_launch_config("plain").unwrap();
        assert_eq!(config.model.as_deref(), Some("claude"));
        assert_eq!(config.scopes, ["coding"]);
        assert_eq!(config.tool, "claude");
        assert!(registry.get_launch_config("missing").is_none());
    }

    #[test]
    fn load_maps_the_legacy_name_and_marks_every_entry_detached() {
        let fixture = Fixture::new();
        let port = FakePort::new();
        fixture.write_agents(vec![json!({
            "id": "legacy",
            "name": "oldname",
            "cwd": fixture.repo(),
            "status": "running",
        })]);
        let registry = fixture.registry(port);
        registry.load().unwrap();
        let agent = registry
            .snapshot()
            .into_iter()
            .find(|agent| agent.id == "legacy")
            .unwrap();
        assert_eq!(agent.title.as_deref(), Some("oldname"));
        assert_eq!(agent.status, Status::Detached);
        assert!(!registry.is_live("legacy"));
        assert_eq!(registry.get_buf("legacy"), "");
        assert_eq!(registry.get_written("legacy"), 0);
    }

    #[test]
    fn snapshots_expose_live_pids_and_run_ids() {
        let fixture = Fixture::new();
        let port = FakePort::new();
        let registry = fixture.registry(port);
        let mut input = create_input(&fixture, "live-id", "claude");
        input.run_id = Some("run-1".to_owned());
        let agent = registry.create(input).unwrap();
        assert_eq!(agent.pid, Some(1000));
        assert_eq!(
            registry.live_process_snapshot(),
            LiveProcesses {
                pids: vec![1000],
                sessions: vec!["live-id".to_owned()],
            }
        );
        assert_eq!(
            registry.find_by_run_id("run-1").map(|agent| agent.id),
            Some("live-id".to_owned())
        );
        assert!(registry.find_by_run_id("nope").is_none());
    }

    #[test]
    fn reorder_permutes_the_registry_and_ignores_non_permutations() {
        let fixture = Fixture::new();
        let port = FakePort::new();
        let registry = fixture.registry(port);
        for id in ["a", "b", "c"] {
            registry
                .create(create_input(&fixture, id, "claude"))
                .unwrap();
        }
        let ids = |registry: &Registry| -> Vec<String> {
            registry
                .snapshot()
                .into_iter()
                .map(|agent| agent.id)
                .collect()
        };
        assert_eq!(ids(&registry), ["a", "b", "c"]);
        registry
            .reorder(&["c".to_owned(), "a".to_owned(), "b".to_owned()])
            .unwrap();
        assert_eq!(ids(&registry), ["c", "a", "b"]);
        registry.reorder(&["a".to_owned()]).unwrap();
        registry
            .reorder(&["a".to_owned(), "a".to_owned(), "b".to_owned()])
            .unwrap();
        assert_eq!(ids(&registry), ["c", "a", "b"]);
        let persisted: Vec<String> = fixture
            .read_agents()
            .agents
            .into_iter()
            .map(|agent| agent.id)
            .collect();
        assert_eq!(persisted, ["c", "a", "b"]);
    }

    #[test]
    fn create_validates_the_working_directory_and_expands_a_bare_tilde() {
        let fixture = Fixture::new();
        let port = FakePort::new();
        let registry = fixture.registry(port);
        let mut absent = create_input(&fixture, "absent", "claude");
        absent.cwd = Some(fixture.path("nope").to_string_lossy().into_owned());
        assert_eq!(
            registry.create(absent).unwrap_err(),
            format!(
                "working directory does not exist: {}",
                fixture.path("nope").to_string_lossy()
            )
        );
        let mut empty = create_input(&fixture, "empty", "claude");
        empty.cwd = None;
        assert_eq!(
            registry.create(empty).unwrap_err(),
            "working directory does not exist: (empty)"
        );
        let mut tilde = create_input(&fixture, "tilde", "claude");
        tilde.cwd = Some("~".to_owned());
        let agent = registry.create(tilde).unwrap();
        assert_eq!(
            agent.cwd,
            Some(fixture.path("home").to_string_lossy().into_owned())
        );
    }

    // agents.test.mjs:494-499.
    #[test]
    fn create_pre_trusts_the_workspace_in_claude_json() {
        let fixture = Fixture::new();
        let port = FakePort::new();
        fs::write(
            fixture.path("home/.claude.json"),
            json!({ "projects": {} }).to_string(),
        )
        .unwrap();
        let registry = fixture.registry(port);
        registry
            .create(create_input(&fixture, "trust", "claude"))
            .unwrap();
        let json: Value =
            serde_json::from_str(&fs::read_to_string(fixture.path("home/.claude.json")).unwrap())
                .unwrap();
        let key = fixture.repo().replace('\\', "/");
        assert_eq!(
            json["projects"][key.as_str()]["hasTrustDialogAccepted"],
            json!(true)
        );
    }

    // agents.test.mjs:251-283.
    #[test]
    fn fork_copies_and_rewrites_the_source_transcript() {
        let fixture = Fixture::new();
        let port = FakePort::new();
        let src = "10000000-aaaa-bbbb-cccc-100000000001";
        fixture.write_agents(vec![json!({
            "id": src,
            "title": "srcname",
            "cwd": fixture.repo(),
            "createdAt": fixture.now(),
            "model": "claude",
            "scopes": ["x"],
        })]);
        let dir = fixture
            .path("home/.claude/projects")
            .join(agent_spawn::encode_cwd(&fixture.repo()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join(format!("{src}.jsonl")),
            format!("{{\"sessionId\":\"{src}\",\"type\":\"user\"}}\n"),
        )
        .unwrap();
        let registry = fixture.registry(port.clone());
        registry.load().unwrap();
        let forked = registry.fork(src, "copyname").unwrap();
        let content = fs::read_to_string(dir.join(format!("{}.jsonl", forked.id))).unwrap();
        assert!(content.contains(&format!("\"sessionId\":\"{}\"", forked.id)));
        assert!(!content.contains(src));
        assert_eq!(forked.title.as_deref(), Some("copyname"));
        assert_eq!(port.spawn_count(), 1);
        assert_eq!(
            registry.fork("missing", "x").unwrap_err(),
            "source not found"
        );
    }
}
