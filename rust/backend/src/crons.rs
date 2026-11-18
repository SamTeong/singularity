//! Native cron service: durable `crons.json`, UTC scheduler, cron-spawned
//! sessions and their idle auto-kill.
//!
//! Port of `server/crons.mjs` (all 276 lines). Behaviour that must survive:
//!
//! - `nextFire` is derived at load and after every fire from *now* and is never
//!   persisted; missed occurrences are structurally ignored (`crons.mjs:6-9`).
//! - Every mutation is staged first: build the new job vector, serialise
//!   `{"crons":[…]}` with 2-space pretty JSON, write atomically, and only on a
//!   successful write swap it into memory. A failed write leaves memory
//!   unchanged and emits nothing (`:26-35`, `:151-157`, `:212-217`).
//! - `fire` recomputes the next boundary **before** spawning so the snapshot the
//!   spawn emits already carries the advanced time (`:159-171`).
//! - Pending run intent is persisted before any spawn and finalised only when
//!   the registry carries the same run id (`:59-80`, `:128-149`).
//! - **Reference defect, preserved deliberately:** when `registry.create`
//!   rejects deterministically (missing cwd, model routing), the pending pair is
//!   never cleared, so the job stays blocked until a restart and startup
//!   recovery leaves it blocked too. `run_pending_intent_survives_a_definite_spawn_failure`
//!   pins this. Do not "fix" it without an explicit parity decision.
//! - The status listener never takes the jobs/next-fire lock: `Registry::create`
//!   emits `Status` synchronously from inside `create`, so a listener that
//!   locked the scheduler state would deadlock the fire path.
//! - CRUD and the run-record path are mutually exclusive: Node's `fire`,
//!   `createCron`, `updateCron` and `deleteCron` are synchronous, so a request
//!   never interleaves with a fire. The native service takes the same
//!   [`CronsService::scheduler`] guard in `create`/`update`/`delete`, so a fire
//!   never spawns from a job a concurrent delete already removed and never
//!   persists a half-applied CRUD change.
//! - The tick handle and the bus subscription id are owned by the service:
//!   [`CronsService::shutdown`] aborts the tick and unsubscribes the listener,
//!   and the listener holds a `Weak` so the bus never keeps the service (nor the
//!   registry) alive. The reference interval is `.unref()` and simply dies with
//!   the process; native ownership is what makes an in-process teardown (tests,
//!   a `serve()` return, a router rebuild) leak-free. Drain still persists
//!   pending intent, so stopping the tick loses no scheduled work.
//! - Aborting the tick handle cancels only the wrapper task: a tick body already
//!   running on a `spawn_blocking` worker is not cancellable. [`CronsService::tick`]
//!   therefore re-checks the stop flag [`CronsService::shutdown`] sets first, so
//!   no fire (nor its persist) can follow a teardown.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::agent_registry::{Clock, CreateAgent, Registry};
use crate::agent_wire::{AgentWire, Status};
use crate::bus::{Bus, BusEvent, BusListener};
use crate::cron_expr;
use crate::fs_atomic::write_atomic;

/// `TICK_MS` (`crons.mjs:17`).
pub const TICK_INTERVAL: Duration = Duration::from_millis(1000);
/// `KILL_CONFIRM_MS` (`crons.mjs:23`).
pub const KILL_CONFIRM: Duration = Duration::from_millis(6000);

/// The exact required-fields message (`crons.mjs:193`, `:233`).
pub const REQUIRED_FIELDS: &str = "title, cronExpr, description, cwd required";
/// `crons.mjs:223`, `:245`, `:258`.
pub const NO_SUCH_CRON: &str = "no such cron";
/// `crons.mjs:259`.
pub const PREVIOUS_RUN_ACTIVE: &str = "previous run still active";
/// `crons.mjs:204`.
pub const IDEMPOTENCY_CONFLICT: &str = "Idempotency-Key was already used with a different payload";

// VERIFY: crons-job-record
/// One persisted `crons.json` entry (`crons.mjs:208-211`), camelCase and in the
/// same field order the Node object literal produces. `lastSessionId` and
/// `lastFiredAt` serialise as explicit `null`; optional fields are omitted like
/// `JSON.stringify` omits `undefined`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CronJob {
    pub id: String,
    pub title: String,
    pub enabled: bool,
    pub cron_expr: String,
    pub description: String,
    pub cwd: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub scopes: Option<Vec<String>>,
    #[serde(default)]
    pub permission_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub idempotency_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub idempotency_payload: Option<String>,
    pub last_session_id: Option<String>,
    pub last_fired_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending_run_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending_run_at: Option<i64>,
}

// VERIFY: crons-state-file
/// `{"crons":[…]}` (`crons.mjs:28`).
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct CronsFile {
    crons: Vec<CronJob>,
}

#[derive(Default)]
struct State {
    /// Insertion-ordered, like the JS `Map`.
    jobs: Vec<CronJob>,
    /// In-memory only; never persisted.
    next_fire: HashMap<String, i64>,
}

/// Everything ambient the service needs.
pub struct CronsConfig {
    /// `STATE_DIR/crons.json`.
    pub state_file: PathBuf,
    pub clock: Clock,
    pub tick: Duration,
    pub idle_kill_after: Duration,
}

// VERIFY: crons-error-classes
/// The four failure classes `errStatus` distinguishes (`index.mjs:292`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CronError {
    /// A validation or "no such cron" failure → 400.
    Validation(String),
    /// Also 400 in the reference (never 404).
    NotFound(String),
    /// Idempotency mismatch → 409.
    Conflict(String),
    /// A genuine disk write failure → 500.
    Persist(String),
}

impl CronError {
    pub fn status_code(&self) -> u16 {
        match self {
            Self::Validation(_) | Self::NotFound(_) => 400,
            Self::Conflict(_) => 409,
            Self::Persist(_) => 500,
        }
    }

    pub fn message(&self) -> &str {
        match self {
            Self::Validation(message)
            | Self::NotFound(message)
            | Self::Conflict(message)
            | Self::Persist(message) => message,
        }
    }
}

impl std::fmt::Display for CronError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.message())
    }
}

impl std::error::Error for CronError {}

// VERIFY: crons-timer-port
/// The idle-kill timer seam. The daemon uses [`NativeTimers`]; tests drive
/// expiry synchronously.
pub trait TimerPort: Send + Sync {
    /// VERIFY: wave5-fix-cron-bg-1
    /// Arms a timer and returns the generation token it was given. The service
    /// stores that token with the armed id, so a timer body that belongs to an
    /// earlier arm can be recognised as stale and must not kill.
    fn arm(&self, key: &str, after: Duration) -> u64;
    fn cancel(&self, key: &str);
    /// Called once by [`CronsService::init`] so a production port can call back
    /// into the service without an ownership cycle.
    fn attach(&self, _service: &Arc<CronsService>) {}
}

// VERIFY: crons-timer-native
/// `tokio`-backed [`TimerPort`]. The callback runs on a blocking worker because
/// `Registry::kill` persists and may sleep in the atomic-rename retry ladder.
pub struct NativeTimers {
    handle: tokio::runtime::Handle,
    /// VERIFY: wave3-fix-crons-4
    /// Generation-tagged so a timer that fires or is cancelled removes its own
    /// entry, and a superseded timer (same key, re-armed) cannot drop or run
    /// the newer one. `crons.mjs:105` deletes the id from `killTimers` inside
    /// the callback, so the map only holds pending timers there too.
    timers: Arc<Mutex<HashMap<String, TimerEntry>>>,
    generation: AtomicU64,
    service: Mutex<Weak<CronsService>>,
}

/// One pending idle-kill timer. The generation ties the entry to the `arm` that
/// created it; the abort handle is attached after the task is spawned.
struct TimerEntry {
    generation: u64,
    abort: Option<tokio::task::AbortHandle>,
}

impl NativeTimers {
    pub fn new(handle: tokio::runtime::Handle) -> Self {
        Self {
            handle,
            timers: Arc::new(Mutex::new(HashMap::new())),
            generation: AtomicU64::new(0),
            service: Mutex::new(Weak::new()),
        }
    }
}

impl TimerPort for NativeTimers {
    fn arm(&self, key: &str, after: Duration) -> u64 {
        self.cancel(key);
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let owned = key.to_owned();
        let service = self.service.lock().unwrap().clone();
        let timers = self.timers.clone();
        // VERIFY: wave5-fix-cron-bg-2
        // Insert the entry **before** spawning: a timer that is already due can
        // otherwise run against a map that does not hold it yet, take the
        // "superseded" early return and never expire the idle. A concurrent
        // `arm` for the same key also sees a stored generation at every point.
        self.timers.lock().unwrap().insert(
            key.to_owned(),
            TimerEntry {
                generation,
                abort: None,
            },
        );
        let join = self.handle.spawn(async move {
            tokio::time::sleep(after).await;
            {
                let mut timers = timers.lock().unwrap();
                let current = timers
                    .get(&owned)
                    .is_some_and(|entry| entry.generation == generation);
                if !current {
                    // Superseded by a newer arm for the same key.
                    return;
                }
                timers.remove(&owned);
            }
            if let Some(service) = service.upgrade() {
                let key = owned.clone();
                let _ = tokio::task::spawn_blocking(move || service.expire_idle(&key, generation))
                    .await;
            }
        });
        if let Some(entry) = self.timers.lock().unwrap().get_mut(key) {
            if entry.generation == generation {
                entry.abort = Some(join.abort_handle());
            }
        }
        generation
    }

    fn cancel(&self, key: &str) {
        if let Some(entry) = self.timers.lock().unwrap().remove(key) {
            if let Some(handle) = entry.abort {
                handle.abort();
            }
        }
    }

    fn attach(&self, service: &Arc<CronsService>) {
        *self.service.lock().unwrap() = Arc::downgrade(service);
    }
}

// VERIFY: crons-timer-noop
/// Off-runtime [`TimerPort`]: lets the host build the service, mount
/// `/api/crons*` and serve the persisted list without a tokio handle. Nothing
/// can fire because `init(None)` skips the tick, and idle-kill timers only
/// exist for agents a fire spawned.
#[derive(Debug, Default)]
pub struct NoopTimers;

impl TimerPort for NoopTimers {
    fn arm(&self, _key: &str, _after: Duration) -> u64 {
        // Nothing ever fires, so the token is never consulted; 0 keeps the
        // trait total without inventing state.
        0
    }
    fn cancel(&self, _key: &str) {}
}

// VERIFY: crons-service
/// The cron service. `state` (jobs + next fire) is separate from `sessions`
/// (cron-spawned ids) and `armed` (id → the generation token of its pending kill
/// timer) so the bus status listener can run without the scheduler lock.
pub struct CronsService {
    registry: Arc<Registry>,
    bus: Bus,
    config: CronsConfig,
    state: Mutex<State>,
    sessions: Mutex<HashSet<String>>,
    /// VERIFY: wave5-fix-cron-bg-20
    /// The token is what `arm` returned, so `expire_idle` can tell its own arm
    /// from a newer one re-armed by `idle` after an intervening `running`.
    armed: Mutex<HashMap<String, u64>>,
    timers: Arc<dyn TimerPort>,
    /// VERIFY: wave3-fix-crons-1
    /// Serializes the whole run-record path (overlap check → `begin_run` →
    /// `spawn_for_job`), matching Node's single-threaded `runCron`/`fire`
    /// atomicity. Never taken by the status listener, so `Registry::create`
    /// emitting `Status` synchronously inside `spawn_for_job` cannot deadlock.
    /// VERIFY: wave8-crons_serialize-1
    /// `create`/`update`/`delete` take it too: Node runs them on the same
    /// single thread as `fire`, so no CRUD step may commit between a fire's
    /// `begin_run` and its `spawn_for_job`. Lock order is always scheduler →
    /// `state`; nothing takes the scheduler while holding `state`.
    scheduler: Mutex<()>,
    /// Counts `persist` calls so recovery's per-job persist (`crons.mjs:62-80`)
    /// is observable in tests. One relaxed atomic add per disk write.
    persist_calls: AtomicU64,
    /// VERIFY: wave3-hostreview-2
    /// The 1 s tick task, owned so [`CronsService::shutdown`] can abort it.
    tick: Mutex<Option<tokio::task::JoinHandle<()>>>,
    /// VERIFY: wave6-stop_flags-1
    /// Set first by [`CronsService::shutdown`] and checked by [`CronsService::tick`]
    /// and [`CronsService::spawn_tick`]. Aborting the tick handle cancels only the
    /// wrapper; a body already executing inside `spawn_blocking` runs to
    /// completion, and the reference has no way to stop it either (its interval
    /// simply dies with the process). This flag is what keeps a torn-down service
    /// from spawning an agent — and persisting a pending run — after the drain.
    stopped: AtomicBool,
    /// The bus subscription id for the status listener, so it can be removed.
    subscription: Mutex<Option<u64>>,
}

impl CronsService {
    pub fn new(
        registry: Arc<Registry>,
        bus: Bus,
        config: CronsConfig,
        timers: Arc<dyn TimerPort>,
    ) -> Self {
        Self {
            registry,
            bus,
            config,
            state: Mutex::new(State::default()),
            sessions: Mutex::new(HashSet::new()),
            armed: Mutex::new(HashMap::new()),
            timers,
            scheduler: Mutex::new(()),
            persist_calls: AtomicU64::new(0),
            tick: Mutex::new(None),
            stopped: AtomicBool::new(false),
            subscription: Mutex::new(None),
        }
    }

    // VERIFY: crons-init
    /// `initCrons` (`crons.mjs:49-115`), after `Registry::load`: read state,
    /// finalise pending intent only when the run id is found, sweep detached
    /// entries, recompute enabled schedules, subscribe the status listener and
    /// (with a runtime handle) start the 1 s tick.
    pub fn init(self: &Arc<Self>, handle: Option<tokio::runtime::Handle>) {
        // VERIFY: wave6-stop_flags-2
        // The reference's `initCrons` has no stop concept: calling it again just
        // starts a second interval. Clearing the flag here keeps a re-init after
        // a teardown on that same footing (and matches `subscribe`/`spawn_tick`,
        // which tolerate a second `init`). So the stop gate covers only the window
        // between `shutdown` and the next `init`: a tick body still queued on a
        // blocking worker across a re-init would fire. Production calls `init`
        // once per `CronsService` (`http_server.rs`), so this is latent.
        self.stopped.store(false, Ordering::SeqCst);
        self.timers.attach(self);
        self.load();
        self.recover_pending();
        self.sweep_dead();
        self.recompute_enabled();
        self.subscribe();
        if let Some(handle) = handle {
            self.spawn_tick(handle);
        }
    }

    fn load(&self) {
        let text = match std::fs::read_to_string(&self.config.state_file) {
            Ok(text) => text,
            Err(_) => return,
        };
        match serde_json::from_str::<CronsFile>(&text) {
            Ok(file) => self.state.lock().unwrap().jobs = file.crons,
            Err(error) => eprintln!("crons.json load failed: {error}"),
        }
    }

    // VERIFY: crons-init-recovery
    fn recover_pending(&self) {
        let now = (self.config.clock)();
        let mut state = self.state.lock().unwrap();
        for index in 0..state.jobs.len() {
            let Some(pending) = state.jobs[index].pending_run_id.clone() else {
                continue;
            };
            let Some(agent) = self.registry.find_by_run_id(&pending) else {
                // Durable unknown outcome: leave the job blocked rather than
                // risking a duplicate scheduled agent.
                continue;
            };
            let pending_at = state.jobs[index].pending_run_at;
            {
                let job = &mut state.jobs[index];
                job.last_session_id = Some(agent.id.clone());
                job.last_fired_at = pending_at;
                job.updated_at = now;
                job.pending_run_id = None;
                job.pending_run_at = None;
            }
            // Node adds to `cronSessions` before persisting and does not roll
            // that back on failure.
            self.sessions.lock().unwrap().insert(agent.id);
            // VERIFY: wave3-fix-crons-6
            // One persist per recovered job (`crons.mjs:62-80`), so a failed
            // write rolls back only the job it belongs to; earlier recoveries
            // stay finalised.
            let jobs = state.jobs.clone();
            if let Err(error) = self.persist(&jobs) {
                let job = &mut state.jobs[index];
                job.pending_run_id = Some(pending);
                job.pending_run_at = pending_at;
                eprintln!("cron run recovery persist failed: {}", error.message());
            }
        }
    }

    // VERIFY: crons-dead-sweep
    fn sweep_dead(&self) {
        let ids: Vec<String> = {
            let state = self.state.lock().unwrap();
            state
                .jobs
                .iter()
                .filter_map(|job| job.last_session_id.clone())
                .collect()
        };
        for id in ids {
            if self.registry.get_status(&id).is_some() && !self.registry.is_live(&id) {
                let _ = self.registry.kill(&id);
            }
        }
    }

    fn recompute_enabled(&self) {
        let ids: Vec<String> = {
            let state = self.state.lock().unwrap();
            state
                .jobs
                .iter()
                .filter(|job| job.enabled)
                .map(|job| job.id.clone())
                .collect()
        };
        for id in ids {
            self.recompute_next(&id);
        }
    }

    /// `recomputeNext` (`crons.mjs:44-47`): next strictly-future match from now;
    /// a parse failure clears the boundary and logs like the reference.
    fn recompute_next(&self, id: &str) {
        let (expression, now) = {
            let state = self.state.lock().unwrap();
            let Some(job) = state.jobs.iter().find(|job| job.id == id) else {
                return;
            };
            (job.cron_expr.clone(), (self.config.clock)())
        };
        match cron_expr::next_fire_after(&expression, now) {
            Ok(next) => {
                self.state
                    .lock()
                    .unwrap()
                    .next_fire
                    .insert(id.to_owned(), next);
            }
            Err(error) => {
                eprintln!(
                    "cron parse failed — no further fires until fixed (id={id}, expr={expression}): {error}"
                );
                self.state.lock().unwrap().next_fire.remove(id);
            }
        }
    }

    fn subscribe(self: &Arc<Self>) {
        let mut subscription = self.subscription.lock().unwrap();
        if subscription.is_some() {
            // A second `init` must not add a duplicate listener.
            return;
        }
        // Weak: the bus must never be the last owner of the service (and so of
        // the registry, PTYs and jobs it holds).
        let service = Arc::downgrade(self);
        let listener: BusListener = Arc::new(move |event: &BusEvent| {
            if let BusEvent::Status { id, status } = event {
                if let Some(service) = service.upgrade() {
                    service.on_status(id, *status);
                }
            }
        });
        *subscription = Some(self.bus.subscribe(listener));
    }

    // VERIFY: wave3-hostreview-2
    /// Stops the tick and the status listener. Idempotent. The host calls this
    /// from `lifecycle::shutdown` before the shutdown broadcast, so no timer or
    /// listener can re-arm work after the drain.
    pub fn shutdown(&self) {
        // VERIFY: wave6-stop_flags-3
        // The flag is set before anything else is torn down: the tick abort below
        // cannot cancel a body that is already inside `spawn_blocking`, and that
        // body checks the flag at the top of `tick`.
        self.stopped.store(true, Ordering::SeqCst);
        if let Some(id) = self.subscription.lock().unwrap().take() {
            self.bus.unsubscribe(id);
        }
        if let Some(join) = self.tick.lock().unwrap().take() {
            join.abort();
        }
    }

    // VERIFY: crons-tick
    fn spawn_tick(self: &Arc<Self>, handle: tokio::runtime::Handle) {
        // VERIFY: wave6-stop_flags-4
        // Hold the handle slot across both the stop check and spawn+store. Storing
        // after spawning let a concurrent `shutdown` find an empty slot, return,
        // and leave a live tick nobody holds; with the lock held, `shutdown` either
        // sets the flag before this check (no tick is spawned) or finds the stored
        // handle and aborts it.
        let mut slot = self.tick.lock().unwrap();
        if self.stopped.load(Ordering::SeqCst) {
            return;
        }
        let service = self.clone();
        let period = self.config.tick;
        let join = handle.spawn(async move {
            let mut interval = tokio::time::interval(period);
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            // The first tick is immediate and is consumed here.
            interval.tick().await;
            loop {
                interval.tick().await;
                // VERIFY: wave6-stop_flags-5
                // A tick interval that outlives its abort (a blocked executor
                // waking it once more) must not hand work to the blocking body.
                if service.stopped.load(Ordering::SeqCst) {
                    return;
                }
                let service = service.clone();
                let _ = tokio::task::spawn_blocking(move || {
                    let now = (service.config.clock)();
                    service.tick(now);
                })
                .await;
            }
        });
        if let Some(previous) = slot.replace(join) {
            previous.abort();
        }
    }

    /// `tick` (`crons.mjs:117-124`): one fire per due job per tick.
    pub fn tick(&self, now_ms: i64) {
        // VERIFY: wave6-stop_flags-6
        // Checked at the top because this runs inside `spawn_blocking`, which no
        // abort reaches: a body that started before `shutdown` must not fire.
        if self.stopped.load(Ordering::SeqCst) {
            return;
        }
        let due: Vec<String> = {
            let state = self.state.lock().unwrap();
            state
                .jobs
                .iter()
                .filter(|job| job.enabled)
                .filter_map(|job| {
                    let next = state.next_fire.get(&job.id)?;
                    (*next <= now_ms).then(|| job.id.clone())
                })
                .collect()
        };
        for id in due {
            self.fire(&id);
        }
    }

    // VERIFY: crons-fire-order
    fn fire(&self, id: &str) {
        // VERIFY: wave3-fix-crons-2
        // One fire at a time, like the reference's synchronous `fire`.
        let _serial = self.scheduler.lock().unwrap();
        let overlap = {
            let state = self.state.lock().unwrap();
            let Some(job) = state.jobs.iter().find(|job| job.id == id) else {
                return;
            };
            job.pending_run_id.is_some()
                || job
                    .last_session_id
                    .as_deref()
                    .is_some_and(|session| self.registry.is_live(session))
        };
        if overlap {
            eprintln!("cron skipped — previous run still active (id={id})");
            self.recompute_next(id);
            self.emit();
            return;
        }
        self.recompute_next(id);
        if let Err(error) = self.begin_run(id) {
            self.record_fire_failure(id, error.message());
            return;
        }
        if let Err(message) = self.spawn_for_job(id) {
            self.record_fire_failure(id, &message);
        }
    }

    // VERIFY: crons-begin-run
    /// `beginRun` (`crons.mjs:151-157`): staged persist of the pending intent
    /// before any spawn; memory changes only on a successful write.
    fn begin_run(&self, id: &str) -> Result<(), CronError> {
        let mut state = self.state.lock().unwrap();
        let Some(index) = state.jobs.iter().position(|job| job.id == id) else {
            return Err(CronError::NotFound(NO_SUCH_CRON.to_owned()));
        };
        let mut staged = state.jobs.clone();
        staged[index].pending_run_id = Some(uuid_v4());
        staged[index].pending_run_at = Some((self.config.clock)());
        self.persist(&staged)?;
        state.jobs = staged;
        Ok(())
    }

    // VERIFY: crons-spawn-map
    /// `spawnForJob` (`crons.mjs:128-149`): create the agent from the job's
    /// stored description, record the run, clear pending, persist, emit once.
    /// On a persist failure the pending pair is restored and the error propagates.
    fn spawn_for_job(&self, id: &str) -> Result<AgentWire, String> {
        let (job, pending) = {
            let state = self.state.lock().unwrap();
            let Some(job) = state.jobs.iter().find(|job| job.id == id) else {
                return Err(NO_SUCH_CRON.to_owned());
            };
            let Some(pending) = job.pending_run_id.clone() else {
                return Err("no pending run".to_owned());
            };
            (job.clone(), pending)
        };
        // `reg.create` is synchronous; it emits Status/List from inside, which
        // the listener handles without touching `state`.
        let wire = self.registry.create(CreateAgent {
            cwd: Some(job.cwd.clone()),
            title: Some(job.title.clone()),
            model: job.model.clone(),
            scopes: job.scopes.clone(),
            prompt: Some(job.description.clone()),
            permission_mode: job.permission_mode.clone(),
            run_id: Some(pending),
            mock: false,
            ..CreateAgent::default()
        })?;
        // VERIFY: wave5-fix-cron-bg-5
        // Node adds the id to `cronSessions` immediately after `reg.create`
        // (`crons.mjs:132-138`), before it touches job state. Recording it here
        // as well means a `delete` that lands between the create and the state
        // re-lock below cannot leave the new agent outside the set (where no
        // idle-kill timer would ever be armed for it).
        self.sessions.lock().unwrap().insert(wire.id.clone());
        let now = (self.config.clock)();
        let mut state = self.state.lock().unwrap();
        let Some(index) = state.jobs.iter().position(|job| job.id == id) else {
            return Err(NO_SUCH_CRON.to_owned());
        };
        let previous_pending = (
            state.jobs[index].pending_run_id.clone(),
            state.jobs[index].pending_run_at,
        );
        {
            let job = &mut state.jobs[index];
            job.last_session_id = Some(wire.id.clone());
            job.last_fired_at = Some(now);
            job.updated_at = now;
            job.last_error = None;
            job.pending_run_id = None;
            job.pending_run_at = None;
        }
        // The session was recorded before the state re-lock, like Node, and is
        // deliberately not rolled back when this persist fails.
        let staged = state.jobs.clone();
        if let Err(error) = self.persist(&staged) {
            let job = &mut state.jobs[index];
            job.pending_run_id = previous_pending.0;
            job.pending_run_at = previous_pending.1;
            return Err(error.message().to_owned());
        }
        drop(state);
        self.emit();
        Ok(wire)
    }

    // VERIFY: crons-fire-error
    /// `fire` catch (`crons.mjs:173-185`): record `lastError`, persist, emit
    /// only when that write succeeds.
    fn record_fire_failure(&self, id: &str, message: &str) {
        let now = (self.config.clock)();
        let mut state = self.state.lock().unwrap();
        let Some(index) = state.jobs.iter().position(|job| job.id == id) else {
            return;
        };
        let mut staged = state.jobs.clone();
        staged[index].last_error = Some(message.to_owned());
        staged[index].updated_at = now;
        match self.persist(&staged) {
            Ok(()) => {
                state.jobs = staged;
                drop(state);
                self.emit();
            }
            Err(error) => {
                eprintln!("cron failed-run persistence failed: {}", error.message());
            }
        }
    }

    // VERIFY: crons-run-recovery
    /// `runCron` (`crons.mjs:256-275`): the scheduler's overlap rule as an error,
    /// `beginRun` outside the spawn `try`, and the adoption asymmetry where the
    /// persist still carries the pending intent but memory drops it.
    pub fn run(&self, id: &str) -> Result<Value, CronError> {
        // VERIFY: wave3-fix-crons-3
        // Held across the overlap check, `begin_run` and `spawn_for_job` so two
        // concurrent manual runs (or a manual run and a fire) cannot both pass
        // the check and spawn an agent each. No `.await` runs under this guard.
        let _serial = self.scheduler.lock().unwrap();
        let overlap = {
            let state = self.state.lock().unwrap();
            let Some(job) = state.jobs.iter().find(|job| job.id == id) else {
                return Err(CronError::NotFound(NO_SUCH_CRON.to_owned()));
            };
            job.pending_run_id.is_some()
                || job
                    .last_session_id
                    .as_deref()
                    .is_some_and(|session| self.registry.is_live(session))
        };
        if overlap {
            return Err(CronError::Validation(PREVIOUS_RUN_ACTIVE.to_owned()));
        }
        self.begin_run(id)?;
        match self.spawn_for_job(id) {
            Ok(wire) => Ok(serde_json::to_value(&wire).expect("an AgentWire always serialises")),
            Err(message) => match self.adopt_pending_agent(id) {
                Ok(()) => Err(CronError::Validation(message)),
                Err(error) => Err(error),
            },
        }
    }

    fn adopt_pending_agent(&self, id: &str) -> Result<(), CronError> {
        let pending = {
            let state = self.state.lock().unwrap();
            state
                .jobs
                .iter()
                .find(|job| job.id == id)
                .and_then(|job| job.pending_run_id.clone())
        };
        let Some(pending) = pending else {
            return Ok(());
        };
        let Some(agent) = self.registry.find_by_run_id(&pending) else {
            return Ok(());
        };
        let now = (self.config.clock)();
        let mut state = self.state.lock().unwrap();
        let Some(index) = state.jobs.iter().position(|job| job.id == id) else {
            return Ok(());
        };
        {
            let job = &mut state.jobs[index];
            job.last_session_id = Some(agent.id);
            job.last_fired_at = Some(now);
            job.updated_at = now;
        }
        // Persist **with pending still on disk**, then clear it in memory only.
        let staged = state.jobs.clone();
        self.persist(&staged)?;
        let job = &mut state.jobs[index];
        job.pending_run_id = None;
        job.pending_run_at = None;
        Ok(())
    }

    // VERIFY: crons-create
    /// `createCron` (`crons.mjs:192-219`).
    pub fn create(&self, body: &Value, key: Option<&str>) -> Result<Value, CronError> {
        // VERIFY: wave8-crons_serialize-2
        // `createCron` is synchronous in the reference, so it can never run
        // between a fire's `beginRun` and `spawnForJob`. Taking the scheduler
        // guard restores that: a fire and a create never interleave.
        let _serial = self.scheduler.lock().unwrap();
        let title = required_string(body, "title").ok_or_else(required_error)?;
        let cron_expression = required_string(body, "cronExpr").ok_or_else(required_error)?;
        let description = required_string(body, "description").ok_or_else(required_error)?;
        let cwd = required_string(body, "cwd").ok_or_else(required_error)?;
        cron_expr::validate(&cron_expression).map_err(CronError::Validation)?;
        let enabled = !matches!(body.get("enabled"), Some(Value::Bool(false)));
        let model = js_truthy_option(body.get("model"))
            .map(js_string)
            .unwrap_or_else(|| "claude".to_owned());
        let scopes = match body.get("scopes") {
            Some(value) if js_truthy(value) => parse_scopes(value)?,
            _ => Vec::new(),
        };
        let permission_mode = js_truthy_option(body.get("permissionMode"))
            .map(js_string)
            .unwrap_or_else(|| "acceptEdits".to_owned());
        let key = key
            .map(str::trim)
            .filter(|key| !key.is_empty())
            .map(str::to_owned);
        let payload = fingerprint(
            &title,
            enabled,
            &cron_expression,
            &description,
            &cwd,
            &Value::String(model.clone()),
            &json!(scopes),
            &Value::String(permission_mode.clone()),
        );

        if let Some(key) = &key {
            let existing = {
                let state = self.state.lock().unwrap();
                state
                    .jobs
                    .iter()
                    .find(|job| job.idempotency_key.as_deref() == Some(key.as_str()))
                    .cloned()
            };
            if let Some(existing) = existing {
                // VERIFY: wave3-fix-crons-7
                // The reference compares `JSON.stringify(payload)` against the
                // stored fingerprint **string**; an unparseable stored payload
                // therefore conflicts rather than falling back.
                let fresh = serde_json::to_string(&payload).expect("a fingerprint serialises");
                let same = match existing.idempotency_payload.as_deref() {
                    Some(stored) => stored == fresh,
                    None => job_fingerprint(&existing) == fresh,
                };
                if !same {
                    return Err(CronError::Conflict(IDEMPOTENCY_CONFLICT.to_owned()));
                }
                return Ok(serde_json::to_value(&existing).expect("a CronJob always serialises"));
            }
        }

        let id = uuid_v4();
        let now = (self.config.clock)();
        let job = CronJob {
            id: id.clone(),
            title,
            enabled,
            cron_expr: cron_expression,
            description,
            cwd,
            model: Some(model),
            scopes: Some(scopes),
            permission_mode: Some(permission_mode),
            idempotency_key: key,
            idempotency_payload: None,
            last_session_id: None,
            last_fired_at: None,
            created_at: now,
            updated_at: now,
            last_error: None,
            pending_run_id: None,
            pending_run_at: None,
        };
        let idempotency_payload = job
            .idempotency_key
            .as_ref()
            .map(|_| serde_json::to_string(&payload).expect("a fingerprint serialises"));
        let job = CronJob {
            idempotency_payload,
            ..job
        };
        let mut state = self.state.lock().unwrap();
        let mut staged = state.jobs.clone();
        staged.push(job.clone());
        self.persist(&staged)?;
        state.jobs = staged;
        if job.enabled {
            self.insert_next_fire(&mut state, &job);
        }
        drop(state);
        self.emit();
        Ok(serde_json::to_value(&job).expect("a CronJob always serialises"))
    }

    // VERIFY: crons-update-service
    /// `updateCron` (`crons.mjs:221-242`).
    pub fn update(&self, id: &str, body: &Value) -> Result<Value, CronError> {
        // VERIFY: wave8-crons_serialize-3
        // See `create`: `updateCron` cannot interleave with a fire in the
        // reference, so an update waits for an in-flight fire and then applies
        // on top of the fire's persisted result (it never clobbers it).
        let _serial = self.scheduler.lock().unwrap();
        let mut state = self.state.lock().unwrap();
        let Some(index) = state.jobs.iter().position(|job| job.id == id) else {
            return Err(CronError::NotFound(NO_SUCH_CRON.to_owned()));
        };
        let mut job = state.jobs[index].clone();
        if let Some(value) = body.get("title") {
            job.title = js_string(value).trim().to_owned();
        }
        if let Some(value) = body.get("cronExpr") {
            let Value::String(raw) = value else {
                return Err(required_error());
            };
            cron_expr::validate(raw).map_err(CronError::Validation)?;
            job.cron_expr = raw.trim().to_owned();
        }
        if let Some(value) = body.get("description") {
            job.description = js_string(value).trim().to_owned();
        }
        if let Some(value) = body.get("cwd") {
            job.cwd = js_string(value).trim().to_owned();
        }
        if let Some(value) = body.get("model") {
            job.model = if value.is_null() {
                None
            } else {
                Some(js_string(value))
            };
        }
        if let Some(value) = body.get("scopes") {
            job.scopes = if value.is_null() {
                None
            } else {
                Some(parse_scopes(value)?)
            };
        }
        if let Some(value) = body.get("permissionMode") {
            job.permission_mode = if value.is_null() {
                None
            } else {
                Some(js_string(value))
            };
        }
        if let Some(value) = body.get("enabled") {
            job.enabled = js_truthy(value);
        }
        if job.title.trim().is_empty()
            || job.cron_expr.trim().is_empty()
            || job.description.trim().is_empty()
            || job.cwd.trim().is_empty()
        {
            return Err(required_error());
        }
        job.updated_at = (self.config.clock)();
        let mut staged = state.jobs.clone();
        staged[index] = job.clone();
        self.persist(&staged)?;
        state.jobs = staged;
        if job.enabled {
            self.insert_next_fire(&mut state, &job);
        } else {
            state.next_fire.remove(id);
        }
        drop(state);
        self.emit();
        Ok(serde_json::to_value(&job).expect("a CronJob always serialises"))
    }

    // VERIFY: crons-delete-service
    /// `deleteCron` (`crons.mjs:244-252`). The cron-spawned session set is
    /// deliberately left alone so a running agent still auto-kills.
    pub fn delete(&self, id: &str) -> Result<(), CronError> {
        // VERIFY: wave8-crons_serialize-4
        // `deleteCron` is synchronous in the reference: a delete that arrives
        // while a fire is spawning waits until the fire has finished, so the
        // fire cannot spawn from (nor persist) an entry the delete already
        // removed, and the delete cannot be undone by the fire's later write.
        let _serial = self.scheduler.lock().unwrap();
        let mut state = self.state.lock().unwrap();
        let Some(index) = state.jobs.iter().position(|job| job.id == id) else {
            return Err(CronError::NotFound(NO_SUCH_CRON.to_owned()));
        };
        let mut staged = state.jobs.clone();
        staged.remove(index);
        self.persist(&staged)?;
        state.jobs = staged;
        state.next_fire.remove(id);
        drop(state);
        self.emit();
        Ok(())
    }

    fn insert_next_fire(&self, state: &mut State, job: &CronJob) {
        match cron_expr::next_fire_after(&job.cron_expr, (self.config.clock)()) {
            Ok(next) => {
                state.next_fire.insert(job.id.clone(), next);
            }
            Err(error) => {
                eprintln!(
                    "cron parse failed — no further fires until fixed (id={}, expr={}): {error}",
                    job.id, job.cron_expr
                );
                state.next_fire.remove(&job.id);
            }
        }
    }

    // VERIFY: crons-wire-next-fire
    /// `snapshotCrons` (`crons.mjs:188-190`): a bare array of jobs plus the
    /// synthetic `nextFire` ISO string (or `null`).
    pub fn snapshot_value(&self) -> Value {
        let state = self.state.lock().unwrap();
        Value::Array(
            state
                .jobs
                .iter()
                .map(|job| wire_value(job, state.next_fire.get(&job.id).copied()))
                .collect(),
        )
    }

    pub fn snapshot_fn(self: &Arc<Self>) -> Arc<dyn Fn() -> Value + Send + Sync> {
        let service = self.clone();
        Arc::new(move || service.snapshot_value())
    }

    // VERIFY: crons-idle-kill
    /// The `status` listener body (`crons.mjs:99-112`). Must never take `state`.
    pub fn on_status(&self, id: &str, status: Status) {
        if !self.sessions.lock().unwrap().contains(id) {
            return;
        }
        match status {
            Status::Running => {
                let removed = self.armed.lock().unwrap().remove(id);
                if removed.is_some() {
                    self.timers.cancel(id);
                }
            }
            Status::Idle => {
                // VERIFY: wave5-fix-cron-bg-3
                // Store the generation the arm returned, so a timer body that
                // belongs to an earlier arm (already elapsed, or superseded by
                // the `running` → `idle` re-arm below) cannot kill. Node's
                // `clearTimeout`-then-`setTimeout` gets this from the runtime.
                let mut armed = self.armed.lock().unwrap();
                if !armed.contains_key(id) {
                    let generation = self.timers.arm(id, self.config.idle_kill_after);
                    armed.insert(id.to_owned(), generation);
                }
            }
            Status::Exited => {
                let removed = self.armed.lock().unwrap().remove(id);
                if removed.is_some() {
                    self.timers.cancel(id);
                }
                self.sessions.lock().unwrap().remove(id);
                // `on_exit` already removed the entry, so this is usually a
                // no-op; kept for the `remove_on_exit` edge and structural parity.
                let _ = self.registry.kill(id);
            }
            Status::Starting | Status::Detached => {}
        }
    }

    /// The confirm-timer body (`crons.mjs:105`): re-check membership, then kill.
    pub fn expire_idle(&self, id: &str, generation: u64) {
        // VERIFY: wave3-fix-crons-5
        // A `running`/`exited` status disarms before the timer task reaches this
        // body; a timer that has already elapsed cannot be aborted, so the
        // disarm result (not the session set) decides. Node's `clearTimeout`
        // wins outright once the status handler has run.
        // VERIFY: wave5-fix-cron-bg-4
        // The generation must match too: `running` → `idle` inside the window
        // between the timer task's map removal and this body re-arms the id, and
        // the older body must not consume that newer arm. Compare-and-remove so
        // a stale body leaves the current entry armed.
        {
            let mut armed = self.armed.lock().unwrap();
            let current = armed.get(id).is_some_and(|token| *token == generation);
            if !current {
                return;
            }
            armed.remove(id);
        }
        if !self.sessions.lock().unwrap().contains(id) {
            return;
        }
        let _ = self.registry.kill(id);
    }

    // VERIFY: crons-persist-before-mutate
    fn persist(&self, jobs: &[CronJob]) -> Result<(), CronError> {
        self.persist_calls.fetch_add(1, Ordering::Relaxed);
        let document = CronsFile {
            crons: jobs.to_vec(),
        };
        let text = serde_json::to_string_pretty(&document).expect("a CronsFile always serialises");
        write_atomic(&self.config.state_file, text.as_bytes()).map_err(|error| {
            eprintln!("crons.json write failed: {error}");
            CronError::Persist(format!("crons.json write failed: {error}"))
        })
    }

    fn emit(&self) {
        self.bus.emit(&BusEvent::Crons(self.snapshot_value()));
    }
}

fn wire_value(job: &CronJob, next_fire: Option<i64>) -> Value {
    let mut value = serde_json::to_value(job).expect("a CronJob always serialises");
    if let Value::Object(map) = &mut value {
        map.insert(
            "nextFire".to_owned(),
            next_fire.map_or(Value::Null, |ms| Value::String(cron_expr::iso_utc(ms))),
        );
    }
    value
}

fn required_error() -> CronError {
    CronError::Validation(REQUIRED_FIELDS.to_owned())
}

/// The reference's `!value?.trim()` test: a missing, non-string or blank value
/// all fall into the generic required-fields error (a documented narrowing from
/// Node's `TypeError` for non-strings).
fn required_string(body: &Value, field: &str) -> Option<String> {
    body.get(field)
        .and_then(Value::as_str)
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

/// JavaScript truthiness for the `||` defaults and `!!enabled`.
fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(value) => value.as_f64().is_some_and(|number| number != 0.0),
        Value::String(value) => !value.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

fn js_truthy_option(value: Option<&Value>) -> Option<&Value> {
    value.filter(|value| js_truthy(value))
}

/// `String(value)` for the update coercions.
fn js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".to_owned(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        Value::String(value) => value.clone(),
        Value::Array(items) => items
            .iter()
            .map(|item| {
                if item.is_null() {
                    String::new()
                } else {
                    js_string(item)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_owned(),
    }
}

fn parse_scopes(value: &Value) -> Result<Vec<String>, CronError> {
    let Value::Array(items) = value else {
        return Err(CronError::Validation(
            "scopes must be an array of strings".to_owned(),
        ));
    };
    items
        .iter()
        .map(|item| {
            item.as_str().map(str::to_owned).ok_or_else(|| {
                CronError::Validation("scopes must be an array of strings".to_owned())
            })
        })
        .collect()
}

/// The idempotency fingerprint, in the reference's key order (`crons.mjs:196-198`).
fn fingerprint(
    title: &str,
    enabled: bool,
    cron_expression: &str,
    description: &str,
    cwd: &str,
    model: &Value,
    scopes: &Value,
    permission_mode: &Value,
) -> Value {
    let mut map = Map::new();
    map.insert("title".to_owned(), Value::String(title.to_owned()));
    map.insert("enabled".to_owned(), Value::Bool(enabled));
    map.insert(
        "cronExpr".to_owned(),
        Value::String(cron_expression.to_owned()),
    );
    map.insert(
        "description".to_owned(),
        Value::String(description.to_owned()),
    );
    map.insert("cwd".to_owned(), Value::String(cwd.to_owned()));
    map.insert("model".to_owned(), model.clone());
    map.insert("scopes".to_owned(), scopes.clone());
    map.insert("permissionMode".to_owned(), permission_mode.clone());
    Value::Object(map)
}

/// VERIFY: wave3-fix-crons-8
/// Rebuild a legacy job's fingerprint from its current fields (`crons.mjs:202`).
/// `JSON.stringify` drops `undefined` members, so absent optional fields are
/// omitted rather than emitted as `null`.
/// shortcut: serde collapses absent and explicit `null` to `None`, so a stored
/// explicit null is omitted here where Node would emit it; upgrade if
/// crons.json ever needs a null round-trip on an idempotency-keyed job.
fn job_fingerprint(job: &CronJob) -> String {
    let mut map = Map::new();
    map.insert("title".to_owned(), Value::String(job.title.clone()));
    map.insert("enabled".to_owned(), Value::Bool(job.enabled));
    map.insert("cronExpr".to_owned(), Value::String(job.cron_expr.clone()));
    map.insert(
        "description".to_owned(),
        Value::String(job.description.clone()),
    );
    map.insert("cwd".to_owned(), Value::String(job.cwd.clone()));
    if let Some(model) = &job.model {
        map.insert("model".to_owned(), Value::String(model.clone()));
    }
    if let Some(scopes) = &job.scopes {
        map.insert("scopes".to_owned(), json!(scopes));
    }
    if let Some(permission_mode) = &job.permission_mode {
        map.insert(
            "permissionMode".to_owned(),
            Value::String(permission_mode.clone()),
        );
    }
    serde_json::to_string(&Value::Object(map)).expect("a fingerprint serialises")
}

/// A v4 UUID from `ring` (already a dependency) — no new crate.
fn uuid_v4() -> String {
    use ring::rand::{SecureRandom, SystemRandom};
    let mut bytes = [0u8; 16];
    SystemRandom::new()
        .fill(&mut bytes)
        .expect("the system random source is available");
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex = |slice: &[u8]| {
        slice
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    };
    format!(
        "{}-{}-{}-{}-{}",
        hex(&bytes[0..4]),
        hex(&bytes[4..6]),
        hex(&bytes[6..8]),
        hex(&bytes[8..10]),
        hex(&bytes[10..16])
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_registry::{PtyPort, RegistryConfig};
    use crate::agent_spawn::{Bins, LaunchSpec, SpawnPaths};
    use std::collections::BTreeMap;
    use std::fs;
    use std::sync::atomic::{AtomicI64, AtomicU32, AtomicU64, AtomicUsize, Ordering};

    static NEXT_FIXTURE: AtomicUsize = AtomicUsize::new(0);
    const START_MS: i64 = 1_700_000_000_000;

    struct FakePort {
        spawns: Mutex<Vec<String>>,
        kills: Mutex<Vec<String>>,
        next_pid: AtomicU32,
        /// VERIFY: wave5-fix-cron-bg-8
        /// Test seam that runs inside `PtyPort::spawn`, i.e. between
        /// `registry.create` returning and `spawn_for_job` re-reading job state.
        on_spawn: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
    }

    impl PtyPort for FakePort {
        fn spawn(&self, id: &str, _generation: u64, _spec: LaunchSpec) -> Result<u32, String> {
            self.spawns.lock().unwrap().push(id.to_owned());
            let hook = self.on_spawn.lock().unwrap().clone();
            if let Some(hook) = hook {
                hook();
            }
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

    #[derive(Default)]
    struct ManualTimers {
        armed: Mutex<Vec<(String, u64, Duration)>>,
        cancelled: Mutex<Vec<String>>,
        generations: AtomicU64,
    }

    impl TimerPort for ManualTimers {
        fn arm(&self, key: &str, after: Duration) -> u64 {
            let generation = self.generations.fetch_add(1, Ordering::SeqCst) + 1;
            self.armed
                .lock()
                .unwrap()
                .push((key.to_owned(), generation, after));
            generation
        }

        fn cancel(&self, key: &str) {
            self.cancelled.lock().unwrap().push(key.to_owned());
        }
    }

    struct Fixture {
        root: PathBuf,
        clock: Arc<AtomicI64>,
        port: Arc<FakePort>,
    }

    impl Fixture {
        fn new() -> Self {
            let index = NEXT_FIXTURE.fetch_add(1, Ordering::SeqCst);
            let root = std::env::temp_dir()
                .join(format!("singularity-crons-{}-{index}", std::process::id()));
            fs::create_dir_all(root.join("state")).unwrap();
            fs::create_dir_all(root.join("repo")).unwrap();
            Self {
                root,
                clock: Arc::new(AtomicI64::new(START_MS)),
                port: Arc::new(FakePort {
                    spawns: Mutex::new(Vec::new()),
                    kills: Mutex::new(Vec::new()),
                    next_pid: AtomicU32::new(1000),
                    on_spawn: Mutex::new(None),
                }),
            }
        }

        fn path(&self, rel: &str) -> PathBuf {
            self.root.join(rel)
        }

        fn repo(&self) -> String {
            self.path("repo").to_string_lossy().into_owned()
        }

        fn state_file(&self) -> PathBuf {
            self.path("state/crons.json")
        }

        fn advance(&self, delta: i64) -> i64 {
            self.clock.fetch_add(delta, Ordering::SeqCst) + delta
        }

        fn now(&self) -> i64 {
            self.clock.load(Ordering::SeqCst)
        }

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

        fn bins(&self) -> Bins {
            let claude = self.touch_exec("bin/claude.exe");
            let ollama = self.touch_exec("bin/ollama.exe");
            let codex = self.touch_exec("bin/codex.exe");
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

        fn setup(&self) -> (Arc<CronsService>, Arc<ManualTimers>, Arc<Registry>, Bus) {
            self.setup_tick(TICK_INTERVAL)
        }

        fn setup_tick(
            &self,
            tick: Duration,
        ) -> (Arc<CronsService>, Arc<ManualTimers>, Arc<Registry>, Bus) {
            let bus = Bus::new();
            let clock = self.clock.clone();
            let registry = Arc::new(Registry::new(
                bus.clone(),
                self.port.clone(),
                RegistryConfig {
                    state_file: self.path("state/agents.json"),
                    bins: self.bins(),
                    parent_env: BTreeMap::new(),
                    clock: Arc::new(move || clock.load(Ordering::SeqCst)),
                },
            ));
            let timers = Arc::new(ManualTimers::default());
            let service = Arc::new(CronsService::new(
                registry.clone(),
                bus.clone(),
                CronsConfig {
                    state_file: self.state_file(),
                    clock: Arc::new({
                        let clock = self.clock.clone();
                        move || clock.load(Ordering::SeqCst)
                    }),
                    tick,
                    idle_kill_after: KILL_CONFIRM,
                },
                timers.clone(),
            ));
            (service, timers, registry, bus)
        }

        fn create_agent(&self, registry: &Registry, id: &str, run_id: Option<&str>) {
            registry
                .create(CreateAgent {
                    cwd: Some(self.repo()),
                    title: Some(id.to_owned()),
                    model: Some("claude".to_owned()),
                    session_id: Some(id.to_owned()),
                    run_id: run_id.map(str::to_owned),
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

    fn body(fixture: &Fixture, title: &str) -> Value {
        json!({
            "title": title,
            "cronExpr": "* * * * *",
            "description": "p",
            "cwd": fixture.repo(),
        })
    }

    fn jobs(snapshot: &Value) -> &Vec<Value> {
        snapshot.as_array().unwrap()
    }

    fn job<'a>(snapshot: &'a Value, id: &str) -> &'a Value {
        jobs(snapshot)
            .iter()
            .find(|job| job["id"] == id)
            .expect("the job exists in the snapshot")
    }

    fn subscribe_events(bus: &Bus) -> Arc<Mutex<Vec<Value>>> {
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink = events.clone();
        bus.subscribe(Arc::new(move |event: &BusEvent| {
            if let BusEvent::Crons(snapshot) = event {
                sink.lock().unwrap().push(snapshot.clone());
            }
        }));
        events
    }

    // VERIFY: crons-create-defaults
    #[test]
    fn create_applies_defaults_returns_the_job_and_snapshot_carries_next_fire() {
        let fixture = Fixture::new();
        let (service, _, _, _) = fixture.setup();
        let created = service.create(&body(&fixture, "t"), None).unwrap();
        assert_eq!(created["enabled"], json!(true));
        assert_eq!(created["model"], json!("claude"));
        assert_eq!(created["scopes"], json!([]));
        assert_eq!(created["permissionMode"], json!("acceptEdits"));
        assert_eq!(created["lastSessionId"], Value::Null);
        assert_eq!(created["lastFiredAt"], Value::Null);
        assert!(
            created.get("nextFire").is_none(),
            "create returns the job, not the wire"
        );

        let snapshot = service.snapshot_value();
        let next = job(&snapshot, created["id"].as_str().unwrap())["nextFire"]
            .as_str()
            .unwrap();
        assert_eq!(created["updatedAt"], json!(START_MS));
        assert_eq!(next, "2023-11-14T22:14:00.000Z");

        let disabled = service
            .create(
                &{
                    let mut value = body(&fixture, "off");
                    value["enabled"] = json!(false);
                    value
                },
                None,
            )
            .unwrap();
        assert_eq!(disabled["enabled"], json!(false));
        assert_eq!(
            job(&service.snapshot_value(), disabled["id"].as_str().unwrap())["nextFire"],
            Value::Null
        );

        let before = service.snapshot_value();
        assert!(matches!(
            service.create(
                &json!({"cronExpr": "* * * * *", "description": "p", "cwd": "x"}),
                None
            ),
            Err(CronError::Validation(_))
        ));
        assert!(matches!(
            service.create(
                &json!({"title": "t", "cronExpr": "nonsense", "description": "p", "cwd": "x"}),
                None
            ),
            Err(CronError::Validation(_))
        ));
        assert_eq!(service.snapshot_value(), before);
    }

    // VERIFY: crons-idempotency
    #[test]
    fn idempotency_returns_the_original_job_and_compares_the_original_payload() {
        let fixture = Fixture::new();
        let (service, _, _, _) = fixture.setup();
        let original = body(&fixture, "original");
        let first = service.create(&original, Some("cron-key")).unwrap();
        let retry = service.create(&original, Some("cron-key")).unwrap();
        assert_eq!(retry["id"], first["id"]);
        assert_eq!(jobs(&service.snapshot_value()).len(), 1);

        let changed = body(&fixture, "changed");
        assert!(matches!(
            service.create(&changed, Some("cron-key")),
            Err(CronError::Conflict(_))
        ));

        let id = first["id"].as_str().unwrap();
        service.update(id, &json!({ "title": "edited" })).unwrap();
        assert_eq!(
            service.create(&original, Some("cron-key")).unwrap()["id"],
            first["id"]
        );
        assert!(matches!(
            service.create(&changed, Some("cron-key")),
            Err(CronError::Conflict(_))
        ));
    }

    // VERIFY: crons-update
    #[test]
    fn update_leaves_the_snapshot_unchanged_on_errors_and_toggles_next_fire() {
        let fixture = Fixture::new();
        let (service, _, _, _) = fixture.setup();
        let created = service.create(&body(&fixture, "update-me"), None).unwrap();
        let id = created["id"].as_str().unwrap();

        let before = service.snapshot_value();
        assert!(matches!(
            service.update(id, &json!({ "title": "changed", "cronExpr": "nonsense" })),
            Err(CronError::Validation(_))
        ));
        assert_eq!(service.snapshot_value(), before);
        for field in ["title", "description", "cwd"] {
            for value in ["", "   "] {
                assert!(matches!(
                    service.update(id, &json!({ "enabled": false, field: value })),
                    Err(CronError::Validation(_))
                ));
                assert_eq!(service.snapshot_value(), before);
            }
        }

        service.update(id, &json!({ "enabled": false })).unwrap();
        assert_eq!(job(&service.snapshot_value(), id)["nextFire"], Value::Null);
        service.update(id, &json!({ "enabled": true })).unwrap();
        assert!(job(&service.snapshot_value(), id)["nextFire"].is_string());
        assert!(matches!(
            service.update("missing", &json!({ "title": "x" })),
            Err(CronError::NotFound(_))
        ));
    }

    // VERIFY: crons-persist-failure
    #[test]
    fn failed_persistence_preserves_the_snapshot_and_emits_nothing() {
        let fixture = Fixture::new();
        let (service, _, _, bus) = fixture.setup();
        let events = subscribe_events(&bus);
        let created = service.create(&body(&fixture, "failure"), None).unwrap();
        let id = created["id"].as_str().unwrap().to_owned();
        let before = service.snapshot_value();

        let file = fixture.state_file();
        fs::remove_file(&file).unwrap();
        fs::create_dir(&file).unwrap(); // atomic rename cannot replace a directory
        events.lock().unwrap().clear();

        assert!(matches!(
            service.create(&body(&fixture, "new"), None),
            Err(CronError::Persist(_))
        ));
        assert!(matches!(
            service.update(&id, &json!({ "title": "x", "enabled": false })),
            Err(CronError::Persist(_))
        ));
        assert!(matches!(service.delete(&id), Err(CronError::Persist(_))));
        assert_eq!(service.snapshot_value(), before);
        assert!(events.lock().unwrap().is_empty());
    }

    // VERIFY: crons-fire-recompute
    #[test]
    fn a_scheduled_fire_advances_next_fire_before_it_emits() {
        let fixture = Fixture::new();
        let (service, _, _, bus) = fixture.setup();
        let events = subscribe_events(&bus);
        let created = service.create(&body(&fixture, "scheduled"), None).unwrap();
        let id = created["id"].as_str().unwrap().to_owned();
        events.lock().unwrap().clear();

        let now = fixture.advance(61_000);
        service.tick(now);
        let emitted = events.lock().unwrap().clone();
        assert_eq!(emitted.len(), 1, "every fire path emits exactly once");
        let snapshot = service.snapshot_value();
        let fired = job(&snapshot, &id);
        assert!(fired["lastSessionId"].is_string());
        assert_eq!(fired["pendingRunId"], Value::Null);
        assert_eq!(fired["lastError"], Value::Null);
        assert!(
            fired["nextFire"].as_str().unwrap().as_bytes() > cron_expr::iso_utc(now).as_bytes()
        );
        assert_eq!(fixture.port.spawns.lock().unwrap().len(), 1);

        // The agent is live, so the next due tick takes the skip path: recompute
        // and emit once, without spawning again.
        let later = fixture.advance(61_000);
        service.tick(later);
        assert_eq!(events.lock().unwrap().len(), 2);
        assert_eq!(fixture.port.spawns.lock().unwrap().len(), 1);
        assert_eq!(
            job(&service.snapshot_value(), &id)["lastSessionId"],
            fired["lastSessionId"]
        );
    }

    // VERIFY: crons-fire-error-test
    #[test]
    fn a_spawn_failure_records_last_error_and_keeps_the_pending_intent() {
        let fixture = Fixture::new();
        let (service, _, _, bus) = fixture.setup();
        let events = subscribe_events(&bus);
        let created = service
            .create(
                &json!({
                    "title": "broken",
                    "cronExpr": "* * * * *",
                    "description": "p",
                    "cwd": fixture.path("missing").to_string_lossy().into_owned(),
                }),
                None,
            )
            .unwrap();
        let id = created["id"].as_str().unwrap().to_owned();
        events.lock().unwrap().clear();

        service.tick(fixture.advance(61_000));
        let snapshot = service.snapshot_value();
        let failed = job(&snapshot, &id);
        assert!(
            failed["lastError"]
                .as_str()
                .unwrap()
                .contains("working directory does not exist")
        );
        // Reference defect: the pending pair survives a definite spawn failure.
        assert!(failed["pendingRunId"].is_string());
        assert_eq!(events.lock().unwrap().len(), 1);
        assert_eq!(fixture.port.spawns.lock().unwrap().len(), 0);
    }

    // VERIFY: crons-begin-run-persist-failure
    #[test]
    fn a_begin_run_disk_failure_spawns_nothing_publishes_nothing_and_sets_no_error() {
        let fixture = Fixture::new();
        let (service, _, _, bus) = fixture.setup();
        let events = subscribe_events(&bus);
        let created = service.create(&body(&fixture, "disk"), None).unwrap();
        let id = created["id"].as_str().unwrap().to_owned();
        events.lock().unwrap().clear();

        let file = fixture.state_file();
        fs::remove_file(&file).unwrap();
        fs::create_dir(&file).unwrap();

        service.tick(fixture.advance(61_000));
        let snapshot = service.snapshot_value();
        let entry = job(&snapshot, &id);
        assert_eq!(entry["lastError"], Value::Null);
        assert_eq!(entry["pendingRunId"], Value::Null);
        assert_eq!(fixture.port.spawns.lock().unwrap().len(), 0);
        assert!(events.lock().unwrap().is_empty());
    }

    // VERIFY: crons-run-defect-pin
    #[test]
    fn manual_run_rejects_unknown_and_overlap_and_pins_the_pending_defect() {
        let fixture = Fixture::new();
        let (service, _, _, _) = fixture.setup();
        assert!(matches!(
            service.run("missing"),
            Err(CronError::NotFound(_))
        ));

        let created = service
            .create(
                &json!({
                    "title": "pending",
                    "cronExpr": "0 0 * * *",
                    "description": "p",
                    "cwd": fixture.path("missing").to_string_lossy().into_owned(),
                    "enabled": false,
                }),
                None,
            )
            .unwrap();
        let id = created["id"].as_str().unwrap().to_owned();
        let error = service.run(&id).unwrap_err();
        assert!(error.message().contains("working directory does not exist"));
        assert!(job(&service.snapshot_value(), &id)["pendingRunId"].is_string());
        assert!(matches!(
            service.run(&id),
            Err(CronError::Validation(message)) if message == PREVIOUS_RUN_ACTIVE
        ));
    }

    // VERIFY: crons-run-adoption
    #[test]
    fn manual_run_adopts_a_partially_created_agent_and_persists_the_pending_intent() {
        let fixture = Fixture::new();
        let (service, _, registry, _) = fixture.setup();
        let created = service
            .create(
                &json!({
                    "title": "adopt",
                    "cronExpr": "0 0 * * *",
                    "description": "p",
                    "cwd": fixture.repo(),
                    "enabled": false,
                }),
                None,
            )
            .unwrap();
        let id = created["id"].as_str().unwrap().to_owned();

        // Make the registry's own persist fail *after* it has registered the
        // agent: a real, non-injected partially-successful create.
        let agents_file = fixture.path("state/agents.json");
        let _ = fs::remove_file(&agents_file);
        fs::create_dir(&agents_file).unwrap();

        let error = service.run(&id).unwrap_err();
        assert!(matches!(error, CronError::Validation(_)));
        let snapshot = service.snapshot_value();
        let adopted = job(&snapshot, &id);
        assert!(adopted["lastSessionId"].is_string());
        assert_eq!(
            adopted["pendingRunId"],
            Value::Null,
            "memory clears pending"
        );

        let on_disk: Value =
            serde_json::from_str(&fs::read_to_string(fixture.state_file()).unwrap()).unwrap();
        // VERIFY: wave3-fix-crons-9
        // `crons.json` is `{"crons":[…]}` (Node's `persist`), so the document is
        // unwrapped before the array-only `job` helper.
        let persisted = job(&on_disk["crons"], &id);
        assert!(
            persisted["pendingRunId"].is_string(),
            "disk keeps the intent because the adoption persist happened before the clear"
        );
        assert_eq!(
            registry
                .find_by_run_id(persisted["pendingRunId"].as_str().unwrap())
                .unwrap()
                .id,
            adopted["lastSessionId"].as_str().unwrap()
        );
    }

    // VERIFY: crons-init-recovery-test
    #[test]
    fn init_finalises_a_matching_pending_run_and_leaves_an_unmatched_one_blocked() {
        let fixture = Fixture::new();
        let (service, _, registry, _) = fixture.setup();
        fixture.create_agent(&registry, "agent-a", Some("run-y"));
        fs::write(
            fixture.state_file(),
            serde_json::to_string_pretty(&json!({"crons": [
                {
                    "id": "a", "title": "a", "enabled": false, "cronExpr": "0 0 * * *",
                    "description": "p", "cwd": fixture.repo(),
                    "lastSessionId": null, "lastFiredAt": null,
                    "createdAt": 1, "updatedAt": 1,
                    "pendingRunId": "run-y", "pendingRunAt": 123
                },
                {
                    "id": "b", "title": "b", "enabled": true, "cronExpr": "0 0 * * *",
                    "description": "p", "cwd": fixture.repo(),
                    "lastSessionId": null, "lastFiredAt": null,
                    "createdAt": 1, "updatedAt": 1,
                    "pendingRunId": "missing", "pendingRunAt": 9
                }
            ]}))
            .unwrap(),
        )
        .unwrap();

        service.init(None);
        let snapshot = service.snapshot_value();
        let recovered = job(&snapshot, "a");
        assert_eq!(recovered["lastSessionId"], json!("agent-a"));
        assert_eq!(recovered["lastFiredAt"], json!(123));
        assert_eq!(recovered["pendingRunId"], Value::Null);
        assert_eq!(
            recovered["nextFire"],
            Value::Null,
            "disabled jobs are not scheduled"
        );
        let blocked = job(&snapshot, "b");
        assert_eq!(blocked["pendingRunId"], json!("missing"));
        assert!(blocked["nextFire"].is_string());

        let on_disk: Value =
            serde_json::from_str(&fs::read_to_string(fixture.state_file()).unwrap()).unwrap();
        // The persisted document is `{"crons":[…]}`; unwrap it like the helper.
        assert!(job(&on_disk["crons"], "a").get("pendingRunId").is_none());
        assert_eq!(
            job(&on_disk["crons"], "b")["pendingRunId"],
            json!("missing")
        );
    }

    // VERIFY: crons-dead-sweep-test
    #[test]
    fn init_sweeps_a_detached_session_record_and_tolerates_a_malformed_file() {
        let fixture = Fixture::new();
        fs::write(
            fixture.path("state/agents.json"),
            serde_json::to_string_pretty(&json!({
                "agents": [{"id": "dead", "title": "d", "cwd": fixture.repo(), "createdAt": 1, "status": "detached"}],
                "recentRepos": [],
            }))
            .unwrap(),
        )
        .unwrap();
        fs::write(
            fixture.state_file(),
            serde_json::to_string_pretty(&json!({"crons": [{
                "id": "a", "title": "a", "enabled": false, "cronExpr": "0 0 * * *",
                "description": "p", "cwd": fixture.repo(), "lastSessionId": "dead",
                "lastFiredAt": null, "createdAt": 1, "updatedAt": 1
            }]}))
            .unwrap(),
        )
        .unwrap();

        let (service, _, registry, _) = fixture.setup();
        registry.load().unwrap();
        service.init(None);
        assert_eq!(
            registry.get_status("dead"),
            None,
            "the detached record was swept"
        );
        assert_eq!(
            job(&service.snapshot_value(), "a")["lastSessionId"],
            json!("dead")
        );

        fs::write(fixture.state_file(), b"not json").unwrap();
        let (broken, _, _, _) = fixture.setup();
        broken.init(None);
        assert!(jobs(&broken.snapshot_value()).is_empty());
    }

    // VERIFY: crons-idle-kill-lifecycle
    #[test]
    fn idle_arms_once_running_cancels_and_expiry_kills() {
        let fixture = Fixture::new();
        let (service, timers, registry, _) = fixture.setup();
        fixture.create_agent(&registry, "s1", None);
        service.sessions.lock().unwrap().insert("s1".to_owned());

        service.on_status("s1", Status::Idle);
        let first_generation = {
            let armed = timers.armed.lock().unwrap();
            assert_eq!(armed.len(), 1);
            assert_eq!(armed[0], ("s1".to_owned(), 1, KILL_CONFIRM));
            armed[0].1
        };
        service.on_status("s1", Status::Idle);
        assert_eq!(
            timers.armed.lock().unwrap().len(),
            1,
            "second idle does not re-arm"
        );

        service.on_status("s1", Status::Running);
        assert!(timers.cancelled.lock().unwrap().contains(&"s1".to_owned()));
        assert!(service.armed.lock().unwrap().is_empty());

        // VERIFY: wave3-fix-crons-10
        // A timer that has already elapsed cannot be aborted; the disarm by
        // `running` must still stop the kill (Node's clearTimeout wins).
        service.expire_idle("s1", first_generation);
        assert!(
            fixture.port.kills.lock().unwrap().is_empty(),
            "a stale timer must not kill a resumed agent"
        );

        service.on_status("s1", Status::Idle);
        let second_generation = timers.armed.lock().unwrap().last().unwrap().1;
        assert_ne!(
            second_generation, first_generation,
            "the re-arm is a new generation"
        );
        // VERIFY: wave5-fix-cron-bg-6
        // `running` → `idle` re-arms while the older timer body may already be
        // past its map check; that body must neither kill nor consume the newer
        // arm (the F3 re-arm window).
        service.expire_idle("s1", first_generation);
        assert!(
            fixture.port.kills.lock().unwrap().is_empty(),
            "a superseded timer must not kill the re-armed idle"
        );
        assert_eq!(
            service.armed.lock().unwrap().get("s1"),
            Some(&second_generation),
            "the stale body leaves the current arm in place"
        );
        service.expire_idle("s1", second_generation);
        assert!(
            fixture
                .port
                .kills
                .lock()
                .unwrap()
                .contains(&"s1".to_owned())
        );
        assert!(service.armed.lock().unwrap().is_empty());

        service.on_status("s1", Status::Idle);
        service.on_status("s1", Status::Exited);
        assert!(!service.sessions.lock().unwrap().contains("s1"));
        assert!(service.armed.lock().unwrap().is_empty());

        // Non-cron ids are ignored entirely.
        let armed_before = timers.armed.lock().unwrap().len();
        service.on_status("other", Status::Idle);
        assert_eq!(timers.armed.lock().unwrap().len(), armed_before);
    }

    // VERIFY: wave3-fix-crons-11
    #[test]
    fn concurrent_manual_runs_for_one_job_spawn_exactly_one_agent() {
        let fixture = Fixture::new();
        let (service, _, _, _) = fixture.setup();
        let created = service
            .create(
                &json!({
                    "title": "race", "cronExpr": "0 0 * * *", "description": "p",
                    "cwd": fixture.repo(), "enabled": false,
                }),
                None,
            )
            .unwrap();
        let id = created["id"].as_str().unwrap().to_owned();

        let barrier = std::sync::Barrier::new(2);
        let results = std::thread::scope(|scope| {
            let handles: Vec<_> = (0..2)
                .map(|_| {
                    let service = service.clone();
                    let id = id.clone();
                    let barrier = &barrier;
                    scope.spawn(move || {
                        let _ = barrier.wait();
                        service.run(&id)
                    })
                })
                .collect();
            handles
                .into_iter()
                .map(|handle| handle.join().unwrap())
                .collect::<Vec<_>>()
        });

        assert_eq!(
            fixture.port.spawns.lock().unwrap().len(),
            1,
            "one job must never spawn two agents"
        );
        assert_eq!(
            results.iter().filter(|result| result.is_ok()).count(),
            1,
            "exactly one manual run wins"
        );
        assert!(results.iter().any(|result| matches!(
            result,
            Err(CronError::Validation(message)) if message.as_str() == PREVIOUS_RUN_ACTIVE
        )));
    }

    // VERIFY: wave5-fix-cron-bg-9
    // VERIFY: wave8-crons_serialize-5
    // Node adds the created id to `cronSessions` immediately after `reg.create`
    // (`crons.mjs:132-138`), before it looks at job state again, so deleting the
    // job cannot orphan the agent: it stays in the cron session set and its idle
    // status arms the kill timer. Serialized CRUD now makes the delete wait for
    // the run instead of landing inside `spawn_for_job`; the guarantee is
    // unchanged and still pinned.
    #[test]
    fn a_delete_during_create_keeps_the_new_agent_in_the_session_set() {
        let fixture = Fixture::new();
        let (service, _, _, _) = fixture.setup();
        let created = service.create(&body(&fixture, "race"), None).unwrap();
        let id = created["id"].as_str().unwrap().to_owned();
        let barrier = Arc::new(std::sync::Barrier::new(2));
        {
            let barrier = barrier.clone();
            *fixture.port.on_spawn.lock().unwrap() = Some(Arc::new(move || {
                barrier.wait();
            }));
        }
        let (run_result, delete_result) = std::thread::scope(|scope| {
            let delete_service = service.clone();
            let delete_id = id.clone();
            let delete_barrier = barrier.clone();
            let handle = scope.spawn(move || {
                delete_barrier.wait();
                delete_service.delete(&delete_id)
            });
            let run_result = service.run(&id);
            (run_result, handle.join().unwrap())
        });
        *fixture.port.on_spawn.lock().unwrap() = None;
        assert!(
            run_result.is_ok(),
            "the delete waits for the run, so the run no longer sees a vanished job"
        );
        assert!(delete_result.is_ok(), "the delete commits after the run");
        let session = fixture.port.spawns.lock().unwrap()[0].clone();
        assert!(
            service.sessions.lock().unwrap().contains(&session),
            "the created agent is still a cron session, so its idle kill is armed"
        );
        assert!(jobs(&service.snapshot_value()).is_empty());
    }

    // VERIFY: wave8-crons_serialize-6
    // Node's `fire` and `deleteCron` share one thread, so a delete can only land
    // before or after a fire. Here the delete is issued from another thread while
    // the fire is between `begin_run` and `spawn_for_job` (the `on_spawn` hook):
    // it must wait, the fire must complete and emit the spawned entry, and only
    // then may the delete commit. The fire's later write therefore cannot
    // resurrect the entry.
    #[test]
    fn delete_during_fire_waits_for_the_fire_and_never_resurrects_the_entry() {
        let fixture = Fixture::new();
        let (service, _, _, bus) = fixture.setup();
        let events = subscribe_events(&bus);
        let created = service
            .create(&body(&fixture, "delete-race"), None)
            .unwrap();
        let id = created["id"].as_str().unwrap().to_owned();
        events.lock().unwrap().clear();

        let barrier = Arc::new(std::sync::Barrier::new(2));
        {
            let barrier = barrier.clone();
            *fixture.port.on_spawn.lock().unwrap() = Some(Arc::new(move || {
                // Runs inside `registry.create`, i.e. inside the fire.
                barrier.wait();
            }));
        }
        let delete_result = std::thread::scope(|scope| {
            let delete_service = service.clone();
            let delete_id = id.clone();
            let delete_barrier = barrier.clone();
            let handle = scope.spawn(move || {
                delete_barrier.wait();
                delete_service.delete(&delete_id)
            });
            service.tick(fixture.advance(61_000));
            handle.join().unwrap()
        });
        *fixture.port.on_spawn.lock().unwrap() = None;
        assert!(delete_result.is_ok(), "the delete commits after the fire");

        let emitted = events.lock().unwrap().clone();
        assert_eq!(
            emitted.len(),
            2,
            "the fire emits its spawned entry, then the delete emits the empty list"
        );
        assert_eq!(
            jobs(&emitted[0]).len(),
            1,
            "the fire ran to completion first"
        );
        assert!(emitted[0][0]["lastSessionId"].is_string());
        assert_eq!(emitted[0][0]["pendingRunId"], Value::Null);
        assert!(jobs(&emitted[1]).is_empty(), "the delete is not undone");

        assert!(jobs(&service.snapshot_value()).is_empty());
        let stored: Value =
            serde_json::from_str(&fs::read_to_string(fixture.state_file()).unwrap()).unwrap();
        assert_eq!(
            stored["crons"],
            json!([]),
            "no entry is resurrected on disk"
        );
    }

    // VERIFY: wave8-crons_serialize-7
    // Same window, with an update instead of a delete: Node serializes
    // `updateCron` against `fire`, so the update applies on top of the fire's
    // persisted run record and its change survives.
    #[test]
    fn update_during_fire_waits_for_the_fire_and_persists_the_update() {
        let fixture = Fixture::new();
        let (service, _, _, bus) = fixture.setup();
        let events = subscribe_events(&bus);
        let created = service
            .create(&body(&fixture, "update-race"), None)
            .unwrap();
        let id = created["id"].as_str().unwrap().to_owned();
        events.lock().unwrap().clear();

        let barrier = Arc::new(std::sync::Barrier::new(2));
        {
            let barrier = barrier.clone();
            *fixture.port.on_spawn.lock().unwrap() = Some(Arc::new(move || {
                barrier.wait();
            }));
        }
        let updated = std::thread::scope(|scope| {
            let update_service = service.clone();
            let update_id = id.clone();
            let update_barrier = barrier.clone();
            let handle = scope.spawn(move || {
                update_barrier.wait();
                update_service.update(&update_id, &json!({ "title": "renamed" }))
            });
            service.tick(fixture.advance(61_000));
            handle.join().unwrap()
        })
        .unwrap();
        *fixture.port.on_spawn.lock().unwrap() = None;

        let emitted = events.lock().unwrap().clone();
        assert_eq!(
            emitted.len(),
            2,
            "the fire emits first, then the update emits its own snapshot"
        );
        assert_eq!(
            emitted[0][0]["title"], "update-race",
            "the update had not committed while the fire was spawning"
        );
        assert_eq!(emitted[1][0]["title"], "renamed");
        assert!(emitted[1][0]["lastSessionId"].is_string());
        assert_eq!(emitted[1][0]["pendingRunId"], Value::Null);

        let session = fixture.port.spawns.lock().unwrap()[0].clone();
        assert_eq!(updated["title"], "renamed");
        assert_eq!(updated["lastSessionId"].as_str(), Some(session.as_str()));
        let stored: Value =
            serde_json::from_str(&fs::read_to_string(fixture.state_file()).unwrap()).unwrap();
        assert_eq!(stored["crons"][0]["title"], "renamed");
        assert_eq!(
            stored["crons"][0]["lastSessionId"].as_str(),
            Some(session.as_str())
        );
        assert!(stored["crons"][0].get("pendingRunId").is_none());
    }

    // VERIFY: wave3-fix-crons-12
    #[test]
    fn native_timers_drops_entries_when_a_timer_fires_or_is_cancelled() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let timers = NativeTimers::new(runtime.handle().clone());
        runtime.block_on(async {
            timers.arm("fired", Duration::from_millis(1));
            timers.arm("cancelled", Duration::from_secs(3600));
            timers.cancel("cancelled");
            // "fired" cannot have run yet: this current-thread runtime has not yielded.
            assert!(
                !timers.timers.lock().unwrap().contains_key("cancelled"),
                "cancel drops its entry"
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        });
        assert!(
            timers.timers.lock().unwrap().is_empty(),
            "a fired timer drops its entry"
        );
    }

    // VERIFY: wave3-fix-crons-13
    #[test]
    fn recovery_persists_once_per_recovered_job() {
        let fixture = Fixture::new();
        let (service, _, registry, _) = fixture.setup();
        fixture.create_agent(&registry, "agent-a", Some("run-a"));
        fixture.create_agent(&registry, "agent-b", Some("run-b"));
        fs::write(
            fixture.state_file(),
            serde_json::to_string_pretty(&json!({"crons": [
                {
                    "id": "a", "title": "a", "enabled": false, "cronExpr": "0 0 * * *",
                    "description": "p", "cwd": fixture.repo(),
                    "lastSessionId": null, "lastFiredAt": null,
                    "createdAt": 1, "updatedAt": 1,
                    "pendingRunId": "run-a", "pendingRunAt": 11
                },
                {
                    "id": "b", "title": "b", "enabled": false, "cronExpr": "0 0 * * *",
                    "description": "p", "cwd": fixture.repo(),
                    "lastSessionId": null, "lastFiredAt": null,
                    "createdAt": 1, "updatedAt": 1,
                    "pendingRunId": "run-b", "pendingRunAt": 22
                }
            ]}))
            .unwrap(),
        )
        .unwrap();

        service.init(None);
        assert_eq!(
            service.persist_calls.load(Ordering::SeqCst),
            2,
            "the reference persists once per recovered job"
        );
        let snapshot = service.snapshot_value();
        assert_eq!(job(&snapshot, "a")["lastSessionId"], json!("agent-a"));
        assert_eq!(job(&snapshot, "b")["lastSessionId"], json!("agent-b"));
    }

    // VERIFY: wave3-fix-crons-14
    #[test]
    fn an_unparseable_stored_fingerprint_conflicts_like_the_reference() {
        let fixture = Fixture::new();
        fs::write(
            fixture.state_file(),
            serde_json::to_string_pretty(&json!({"crons": [{
                "id": "legacy", "title": "t", "enabled": true, "cronExpr": "* * * * *",
                "description": "p", "cwd": fixture.repo(), "model": "claude",
                "scopes": [], "permissionMode": "acceptEdits",
                "idempotencyKey": "cron-key", "idempotencyPayload": "not json",
                "lastSessionId": null, "lastFiredAt": null,
                "createdAt": 1, "updatedAt": 1
            }]}))
            .unwrap(),
        )
        .unwrap();
        let (service, _, _, _) = fixture.setup();
        service.init(None);

        // `existing.idempotencyPayload ?? …` compares the raw string in the
        // reference, so an unparseable value can never match a fresh payload.
        assert!(matches!(
            service.create(&body(&fixture, "t"), Some("cron-key")),
            Err(CronError::Conflict(_))
        ));
    }

    // VERIFY: wave4-lifecycle-10
    /// The tick handle and the subscription id are owned, so `shutdown` really
    /// stops both: no fire after the stop and no delivery to the listener.
    #[test]
    fn shutdown_stops_the_tick_and_unsubscribes_the_status_listener() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let fixture = Fixture::new();
            let (service, _, registry, bus) = fixture.setup_tick(Duration::from_millis(10));
            let created = service.create(&body(&fixture, "tick"), None).unwrap();
            let id = created["id"].as_str().unwrap().to_owned();
            // VERIFY: wave6-stop_flags-7
            // Signal the fire through a bus channel instead of sleeping: the
            // tick's own emit resolves the wait (bounded at 2 s) as soon as the
            // fire path has finished, so the assertions below see final state.
            // Valid because `spawn_for_job` emits only after store + persist.
            let (fired, mut emissions) = tokio::sync::mpsc::unbounded_channel::<()>();
            bus.subscribe(Arc::new(move |event: &BusEvent| {
                if matches!(event, BusEvent::Crons(_)) {
                    let _ = fired.send(());
                }
            }));
            service.init(Some(tokio::runtime::Handle::current()));

            fixture.advance(61_000);
            tokio::time::timeout(Duration::from_secs(2), emissions.recv())
                .await
                .expect("the owned tick fires a due job")
                .expect("the fire path emits");
            let fired = fixture.port.spawns.lock().unwrap().len();
            assert_eq!(fired, 1, "the owned tick fires a due job");
            assert!(
                job(&service.snapshot_value(), &id)["lastSessionId"].is_string(),
                "the fire path completed before the emit"
            );

            // Re-arm the job so a surviving tick would spawn a second agent.
            let session = job(&service.snapshot_value(), &id)["lastSessionId"]
                .as_str()
                .unwrap()
                .to_owned();
            let _ = registry.kill(&session);
            service.shutdown();
            assert!(service.tick.lock().unwrap().is_none());
            assert!(service.subscription.lock().unwrap().is_none());

            // VERIFY: wave6-stop_flags-8
            // No second wait: the stop flag is what refuses a tick body that an
            // abort cannot reach, so the same path the blocking body takes is
            // driven directly and must spawn and persist nothing.
            let persists = service.persist_calls.load(Ordering::SeqCst);
            fixture.advance(61_000);
            service.tick(fixture.now());
            assert_eq!(
                fixture.port.spawns.lock().unwrap().len(),
                fired,
                "no tick runs after shutdown"
            );
            assert_eq!(
                service.persist_calls.load(Ordering::SeqCst),
                persists,
                "a stopped tick persists nothing"
            );

            // The listener is unsubscribed: `Exited` no longer reaches
            // `on_status`, which would drop the tracked session.
            service.sessions.lock().unwrap().insert("kept".to_owned());
            bus.emit(&BusEvent::Status {
                id: "kept".to_owned(),
                status: Status::Exited,
            });
            assert!(service.sessions.lock().unwrap().contains("kept"));
        });
    }

    // VERIFY: wave6-stop_flags-9
    /// A1 regression: `shutdown` cannot abort a tick body already running on a
    /// blocking worker, so `tick` itself must refuse after the stop — no spawn, no
    /// pending intent, no persist, no emit.
    #[test]
    fn a_due_tick_after_shutdown_spawns_and_persists_nothing() {
        let fixture = Fixture::new();
        let (service, _, _, bus) = fixture.setup();
        let events = subscribe_events(&bus);
        let created = service.create(&body(&fixture, "stopped"), None).unwrap();
        let id = created["id"].as_str().unwrap().to_owned();
        service.init(None);
        service.shutdown();
        events.lock().unwrap().clear();
        let persists = service.persist_calls.load(Ordering::SeqCst);

        service.tick(fixture.advance(61_000));
        assert!(fixture.port.spawns.lock().unwrap().is_empty());
        assert_eq!(service.persist_calls.load(Ordering::SeqCst), persists);
        assert_eq!(
            job(&service.snapshot_value(), &id)["pendingRunId"],
            Value::Null
        );
        assert!(events.lock().unwrap().is_empty());
    }

    // VERIFY: wave6-stop_flags-10
    /// A4 regression: `spawn_tick` refuses to start on a stopped service, so a
    /// `shutdown` that won the handle slot cannot be followed by a tick it never
    /// saw (the slot is filled under the same lock `shutdown` takes).
    #[test]
    fn spawn_tick_does_not_start_after_shutdown() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let fixture = Fixture::new();
            let (service, _, _, _) = fixture.setup_tick(Duration::from_millis(10));
            let created = service.create(&body(&fixture, "tick"), None).unwrap();
            let id = created["id"].as_str().unwrap().to_owned();
            service.init(None);
            service.shutdown();
            let persists = service.persist_calls.load(Ordering::SeqCst);

            service.spawn_tick(tokio::runtime::Handle::current());
            assert!(
                service.tick.lock().unwrap().is_none(),
                "a stopped service stores no tick handle"
            );
            // If a tick had been spawned it would be due now; assert the state it
            // would have touched is untouched rather than waiting for it.
            fixture.advance(61_000);
            assert!(fixture.port.spawns.lock().unwrap().is_empty());
            assert_eq!(service.persist_calls.load(Ordering::SeqCst), persists);
            assert_eq!(
                job(&service.snapshot_value(), &id)["pendingRunId"],
                Value::Null
            );
        });
    }

    // VERIFY: wave4-lifecycle-11
    /// The bus holds a `Weak`, so it cannot keep the service (and the registry
    /// and PTYs it owns) alive after the host drops it.
    #[test]
    fn the_status_listener_holds_a_weak_reference_to_the_service() {
        let fixture = Fixture::new();
        let (service, _, _, bus) = fixture.setup();
        service.init(None);
        let weak = Arc::downgrade(&service);
        drop(service);
        assert!(
            weak.upgrade().is_none(),
            "the bus listener must not own the service"
        );
        // Emitting to the remaining listener is a harmless no-op.
        bus.emit(&BusEvent::Status {
            id: "gone".to_owned(),
            status: Status::Exited,
        });
    }

    // VERIFY: wave4-lifecycle-12
    /// H4's off-runtime construction: `NoopTimers` plus `init(None)` still
    /// loads the persisted list, so the routes and the WS snapshot are served
    /// without a tokio handle.
    #[test]
    fn noop_timers_serve_the_persisted_list_without_a_runtime() {
        let fixture = Fixture::new();
        let (_, _, registry, bus) = fixture.setup();
        fs::write(
            fixture.state_file(),
            serde_json::to_string_pretty(&json!({"crons": [{
                "id": "persisted", "title": "t", "enabled": false, "cronExpr": "0 0 * * *",
                "description": "p", "cwd": fixture.repo(),
                "lastSessionId": null, "lastFiredAt": null,
                "createdAt": 1, "updatedAt": 1
            }]}))
            .unwrap(),
        )
        .unwrap();
        // No `Handle::try_current()` here: this test runs on the plain harness
        // thread, exactly like a router built outside a runtime.
        let service = Arc::new(CronsService::new(
            registry,
            bus,
            CronsConfig {
                state_file: fixture.state_file(),
                clock: Arc::new({
                    let clock = fixture.clock.clone();
                    move || clock.load(Ordering::SeqCst)
                }),
                tick: TICK_INTERVAL,
                idle_kill_after: KILL_CONFIRM,
            },
            Arc::new(NoopTimers),
        ));
        service.init(None);
        assert_eq!(
            job(&service.snapshot_value(), "persisted")["id"],
            json!("persisted")
        );
        assert!(service.tick.lock().unwrap().is_none());
        service.shutdown();
    }
}
