//! Daemon-side usage auto-refresh: the idle debounce, the per-window reset
//! timers and the background history samplers.
//!
//! Port of `server/usage.mjs:1086-1254` (`initUsageAutoRefresh`,
//! `scheduleResetRefreshes` and the sampler clock). Every timer here is a
//! daemon timer: it calls the same cached pull the route does, so an automated
//! tick updates the cache and pushes `BusEvent::Usage` exactly like a browser
//! request would, and a browser tab does not have to be open.
//!
//! Timers and what each one calls:
//!   * idle debounce (`usage.mjs:1127-1131`) — `status === 'idle'` arms a 30s
//!     timer; every further idle status restarts it, so a burst of agents
//!     finishing coalesces into one all-source pull.
//!   * reset timers (`usage.mjs:1107-1119`) — rebuilt from every pulled
//!     document, one per provider/`session`|`weekly` pair whose `resetsAt` is
//!     in the future and inside the sane horizon. Each fires 2s after the reset,
//!     clears that provider's network floor and pulls it once.
//!   * Claude and Codex file samplers (`usage.mjs:1167-1201`) — every 5s, one
//!     lane each, `force: false` so the 60s network floor still holds the
//!     network leg; their cheap file tiers answer the rest.
//!   * the Ollama sampler (`usage.mjs:1206-1248`) — every 60s while the lane is
//!     neither paused nor gate-blocked; a failure doubles its backoff up to the
//!     15m cap, `no-config` arms the cap straight away, an expired login pauses
//!     the lane, and a success clears both.
//!
//! The cache itself (network floor, rate gates, history rows, `historyPaused`)
//! belongs to `http_usage`; this module only drives it through `UsageHandle`.

use crate::agent_wire::Status;
use crate::bus::{Bus, BusEvent};
use crate::http_usage::{UsageHandle, UsageOllamaState};
use serde_json::{Value, json};
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::runtime::Handle;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio::time::Instant;

/// `DEBOUNCE_MS` (`usage.mjs:1086`).
const DEBOUNCE_MS: u64 = 30_000;
/// `FILE_POLL_MS` (`usage.mjs:1158`): the Claude and Codex file-tier cadence.
const FILE_POLL_MS: u64 = 5_000;
/// `OLLAMA_POLL_MS` (`usage.mjs:1159`): the ollama lane has no file tier.
const OLLAMA_POLL_MS: u64 = 60_000;
/// `OLLAMA_BACKOFF_CAP_MS` (`usage.mjs:1160`).
const OLLAMA_BACKOFF_CAP_MS: u64 = 15 * 60_000;
/// `resetDelay`'s horizon (`usage.mjs:1093`): 7.75 days, well under the
/// timer limit.
const RESET_CAP_MS: i64 = 669_600_000;
/// The `+ 2000` a reset timer adds so the pull lands just past the reset.
const RESET_SLACK_MS: u64 = 2_000;

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

// VERIFY: usage-auto-refresh-target
/// What the timers may ask the usage cache to do. `UsageHandle` is the daemon
/// implementation; tests inject a recorder so a cadence can be observed without
/// a network seam or a real 60s floor.
pub trait UsageAutoRefreshTarget: Send + Sync + 'static {
    /// `getUsage({sources})` with `force: false`; an empty slice means all three.
    fn refresh<'a>(&'a self, sources: &'a [String]) -> BoxFuture<'a, Result<Value, String>>;
    /// `cache[src].at = 0`: let exactly one refresh past the network floor.
    fn reset_network_floor<'a>(&'a self, provider: &'a str) -> BoxFuture<'a, ()>;
    fn ollama_state<'a>(&'a self) -> BoxFuture<'a, UsageOllamaState>;
    fn pause_history(&self, error: &str);
    fn arm_ollama_gate<'a>(&'a self, delay_ms: i64) -> BoxFuture<'a, ()>;
    fn clear_ollama_gate<'a>(&'a self) -> BoxFuture<'a, ()>;
}

impl UsageAutoRefreshTarget for UsageHandle {
    fn refresh<'a>(&'a self, sources: &'a [String]) -> BoxFuture<'a, Result<Value, String>> {
        Box::pin(self.refresh_auto(sources))
    }

    fn reset_network_floor<'a>(&'a self, provider: &'a str) -> BoxFuture<'a, ()> {
        Box::pin(UsageHandle::reset_network_floor(self, provider))
    }

    fn ollama_state<'a>(&'a self) -> BoxFuture<'a, UsageOllamaState> {
        Box::pin(UsageHandle::ollama_state(self))
    }

    fn pause_history(&self, error: &str) {
        UsageHandle::pause_history(self, error);
    }

    fn arm_ollama_gate<'a>(&'a self, delay_ms: i64) -> BoxFuture<'a, ()> {
        Box::pin(UsageHandle::arm_ollama_gate(self, delay_ms))
    }

    fn clear_ollama_gate<'a>(&'a self) -> BoxFuture<'a, ()> {
        Box::pin(UsageHandle::clear_ollama_gate(self))
    }
}

// VERIFY: usage-auto-refresh-config
/// Every cadence is injectable so tests run in milliseconds; the defaults are
/// the Node constants.
#[derive(Clone)]
pub struct Config {
    pub debounce: Duration,
    pub file_poll: Duration,
    pub ollama_poll: Duration,
    pub ollama_backoff_cap: Duration,
    /// `resetDelay`'s horizon in milliseconds.
    pub reset_cap_ms: i64,
    /// The slack added to a reset deadline (`+ 2000`).
    pub reset_slack: Duration,
    /// `Date.now()` for `resetDelay`, which reads the document, not the cache.
    pub clock: Arc<dyn Fn() -> i64 + Send + Sync>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            debounce: Duration::from_millis(DEBOUNCE_MS),
            file_poll: Duration::from_millis(FILE_POLL_MS),
            ollama_poll: Duration::from_millis(OLLAMA_POLL_MS),
            ollama_backoff_cap: Duration::from_millis(OLLAMA_BACKOFF_CAP_MS),
            reset_cap_ms: RESET_CAP_MS,
            reset_slack: Duration::from_millis(RESET_SLACK_MS),
            clock: Arc::new(now_ms),
        }
    }
}

// VERIFY: usage-auto-refresh-start
/// Starts the automations against the daemon's cache. Dropping (or `stop()`ing)
/// the returned handle unsubscribes from the bus and aborts every task.
pub fn start(handle: Handle, usage: UsageHandle, bus: Bus) -> UsageAutoRefresh {
    start_with(handle, Arc::new(usage), bus, Config::default())
}

/// `start` over an injected target and cadence (tests).
pub fn start_with(
    handle: Handle,
    usage: Arc<dyn UsageAutoRefreshTarget>,
    bus: Bus,
    config: Config,
) -> UsageAutoRefresh {
    let mut subscriptions = Vec::new();
    let mut tasks = Vec::new();

    // ---- Reset timers (`scheduleResetRefreshes`) ----------------------------
    // `getUsage` reschedules from every result it returns. Rebuilding from the
    // emitted document is equivalent: `resetDelay` is the distance to an
    // absolute `resetsAt`, so an unchanged document rebuilds the same deadlines.
    let (reset_tx, mut reset_rx) = mpsc::unbounded_channel::<Vec<ResetTimer>>();
    {
        let sender = reset_tx.clone();
        let config = config.clone();
        subscriptions.push(bus.subscribe(Arc::new(move |event| {
            let BusEvent::Usage(document) = event else {
                return;
            };
            let _ = sender.send(reset_deadlines(document, &config, (config.clock)()));
        })));
    }
    {
        let usage = usage.clone();
        tasks.push(handle.spawn(async move {
            let mut timers: Vec<ResetTimer> = Vec::new();
            loop {
                let next = next_deadline(&timers);
                tokio::select! {
                    update = reset_rx.recv() => match update {
                        Some(deadlines) => timers = deadlines,
                        None => return,
                    },
                    () = next, if !timers.is_empty() => {
                        let now = Instant::now();
                        let mut due = Vec::new();
                        timers.retain(|timer| {
                            if timer.at <= now {
                                due.push(timer.clone());
                                false
                            } else {
                                true
                            }
                        });
                        for timer in due {
                            usage.reset_network_floor(&timer.provider).await;
                            let _ = usage.refresh(std::slice::from_ref(&timer.provider)).await;
                        }
                    }
                }
            }
        }));
    }

    // ---- Idle debounce (`bus.on('status')`) --------------------------------
    let (idle_tx, mut idle_rx) = mpsc::unbounded_channel::<()>();
    subscriptions.push(bus.subscribe(Arc::new(move |event| {
        if let BusEvent::Status {
            status: Status::Idle,
            ..
        } = event
        {
            let _ = idle_tx.send(());
        }
    })));
    {
        let usage = usage.clone();
        let config = config.clone();
        tasks.push(handle.spawn(async move {
            loop {
                if idle_rx.recv().await.is_none() {
                    return;
                }
                // Coalesce: every further idle status restarts the countdown.
                loop {
                    tokio::select! {
                        message = idle_rx.recv() => {
                            if message.is_none() {
                                return;
                            }
                        }
                        () = tokio::time::sleep(config.debounce) => break,
                    }
                }
                let _ = usage.refresh(&[]).await;
            }
        }));
    }

    // ---- History samplers (`startHistorySampler`) --------------------------
    for source in ["claude", "codex"] {
        tasks.push(spawn_file_sampler(
            &handle,
            usage.clone(),
            config.file_poll,
            source,
        ));
    }
    {
        let config = config.clone();
        tasks.push(handle.spawn(async move {
            // `historyBackoffMs`: doubles per failed attempt, cleared by success.
            let mut backoff_ms = 0;
            loop {
                tokio::time::sleep(config.ollama_poll).await;
                run_history_sample(&*usage, &config, &mut backoff_ms).await;
            }
        }));
    }

    UsageAutoRefresh {
        bus,
        subscriptions,
        tasks,
        stopped: false,
    }
}

/// The running automations. `stop` (or drop) unsubscribes from the bus first, so
/// no listener can re-arm a task after its abort.
pub struct UsageAutoRefresh {
    bus: Bus,
    subscriptions: Vec<u64>,
    tasks: Vec<JoinHandle<()>>,
    stopped: bool,
}

impl UsageAutoRefresh {
    /// Stops every timer and sampler. Idempotent.
    pub fn stop(&mut self) {
        if self.stopped {
            return;
        }
        self.stopped = true;
        for id in self.subscriptions.drain(..) {
            self.bus.unsubscribe(id);
        }
        for task in self.tasks.drain(..) {
            task.abort();
        }
    }
}

impl Drop for UsageAutoRefresh {
    fn drop(&mut self) {
        self.stop();
    }
}

// ---- Samplers ---------------------------------------------------------------

/// One provider's 5s file-tier tick (`scheduleClaudeSample`,
/// `scheduleCodexSample`): arm, sample, re-arm — the countdown is never reset.
fn spawn_file_sampler(
    handle: &Handle,
    usage: Arc<dyn UsageAutoRefreshTarget>,
    interval: Duration,
    source: &'static str,
) -> JoinHandle<()> {
    handle.spawn(async move {
        loop {
            tokio::time::sleep(interval).await;
            let _ = usage.refresh(&[source.to_owned()]).await;
        }
    })
}

/// `runHistorySample` (`usage.mjs:1212`): one ollama tick, then re-arm. A pause
/// or a backoff belongs to this lane only and never stalls Claude/Codex.
///
/// Classifying only happens when the tick made its own network attempt:
/// `cache.ollama.at` unchanged means another caller's pull answered from the
/// floor and there is nothing of this tick's to classify.
async fn run_history_sample(
    usage: &dyn UsageAutoRefreshTarget,
    config: &Config,
    backoff_ms: &mut i64,
) {
    let state = usage.ollama_state().await;
    if state.history_paused.is_some() || state.blocked {
        return;
    }
    let attempted_at = state.attempt_at;
    let ollama = match usage.refresh(&["ollama".to_owned()]).await {
        Ok(document) => document.get("ollama").cloned().unwrap_or(Value::Null),
        Err(_) => json!({ "ok": false, "source": "ollama", "error": "unavailable" }),
    };
    if usage.ollama_state().await.attempt_at == attempted_at {
        return;
    }
    if is_true(ollama.get("ok")) && !is_true(ollama.get("stale")) {
        // A success clears an accumulated backoff.
        *backoff_ms = 0;
        usage.clear_ollama_gate().await;
    } else if ollama.get("error").and_then(Value::as_str) == Some("no-config") {
        // Never configured is not a failure worth backing off for; check back
        // rarely instead of dragging an install that skipped Ollama to the cap.
        usage
            .arm_ollama_gate(config.ollama_backoff_cap.as_millis() as i64)
            .await;
    } else if is_true(ollama.get("needsAuth")) {
        // An expired login pauses the lane until a good read clears it.
        let error = ollama
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("unknown error");
        usage.pause_history(error);
    } else {
        let cap = config.ollama_backoff_cap.as_millis() as i64;
        let next = if *backoff_ms == 0 {
            config.ollama_poll.as_millis() as i64
        } else {
            backoff_ms.saturating_mul(2)
        };
        *backoff_ms = next.min(cap);
        usage.arm_ollama_gate(*backoff_ms).await;
    }
}

// ---- Reset timers -----------------------------------------------------------

#[derive(Clone)]
struct ResetTimer {
    provider: String,
    at: Instant,
}

/// `resetDelay` (`usage.mjs:1093`): schedulable if `resetsAt` is in the future
/// and within a sane horizon (absurd and past values are skipped).
fn reset_delay(iso: &str, cap_ms: i64, now_ms: i64) -> Option<i64> {
    let ms = crate::usage_snapshot::parse_date_ms(iso)? - now_ms;
    if ms <= 0 || ms > cap_ms {
        return None;
    }
    Some(ms)
}

fn reset_deadlines(document: &Value, config: &Config, now_ms: i64) -> Vec<ResetTimer> {
    let mut timers = Vec::new();
    for provider in ["ollama", "claude", "codex"] {
        for window in ["session", "weekly"] {
            let Some(resets_at) = document
                .get(provider)
                .and_then(|source| source.get(window))
                .and_then(|window| window.get("resetsAt"))
                .and_then(Value::as_str)
            else {
                continue;
            };
            let Some(delay) = reset_delay(resets_at, config.reset_cap_ms, now_ms) else {
                continue;
            };
            timers.push(ResetTimer {
                provider: provider.to_owned(),
                at: Instant::now() + config.reset_slack + Duration::from_millis(delay as u64),
            });
        }
    }
    timers
}

/// The earliest armed deadline; only polled while at least one timer exists.
fn next_deadline(timers: &[ResetTimer]) -> tokio::time::Sleep {
    let earliest = timers
        .iter()
        .map(|timer| timer.at)
        .min()
        .unwrap_or_else(Instant::now);
    tokio::time::sleep_until(earliest)
}

// ---- Helpers ----------------------------------------------------------------

fn is_true(value: Option<&Value>) -> bool {
    matches!(value, Some(Value::Bool(true)))
}

/// `Date.now()`.
fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::http_usage::iso_ms;
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicBool, AtomicI64, AtomicUsize, Ordering};

    /// A `UsageAutoRefreshTarget` that records what each timer asked for and
    /// models the two pieces of ollama state the sampler classifies on: the
    /// network floor's clock (`attempt_at`) and the gate deadline.
    #[derive(Default)]
    struct Recorder {
        refreshes: Mutex<Vec<Vec<String>>>,
        floors: Mutex<Vec<String>>,
        armed: Mutex<Vec<i64>>,
        clears: AtomicUsize,
        paused: Mutex<Option<String>>,
        blocked_until: AtomicI64,
        attempt_at: AtomicI64,
        /// The document a pull answers with; the ollama entry drives the sample.
        response: Mutex<Value>,
        /// When false, an ollama pull is answered from the floor without an
        /// attempt (`cache.ollama.at` does not move).
        attempts: AtomicBool,
    }

    impl Recorder {
        fn new(response: Value) -> Arc<Self> {
            let recorder = Self {
                response: Mutex::new(response),
                attempts: AtomicBool::new(true),
                ..Self::default()
            };
            Arc::new(recorder)
        }

        fn response(&self) -> Value {
            self.response.lock().unwrap().clone()
        }

        fn set_response(&self, response: Value) {
            *self.response.lock().unwrap() = response;
        }

        fn refreshes(&self) -> Vec<Vec<String>> {
            self.refreshes.lock().unwrap().clone()
        }

        fn count(&self, source: &str) -> usize {
            self.refreshes()
                .iter()
                .filter(|sources| sources.len() == 1 && sources[0] == source)
                .count()
        }

        fn armed(&self) -> Vec<i64> {
            self.armed.lock().unwrap().clone()
        }
    }

    impl UsageAutoRefreshTarget for Recorder {
        fn refresh<'a>(&'a self, sources: &'a [String]) -> BoxFuture<'a, Result<Value, String>> {
            self.refreshes.lock().unwrap().push(sources.to_vec());
            let attempts = sources.len() == 1
                && sources[0] == "ollama"
                && self.attempts.load(Ordering::SeqCst)
                && now_ms() >= self.blocked_until.load(Ordering::SeqCst);
            if attempts {
                self.attempt_at.fetch_add(1, Ordering::SeqCst);
            }
            let response = self.response();
            Box::pin(async move { Ok(response) })
        }

        fn reset_network_floor<'a>(&'a self, provider: &'a str) -> BoxFuture<'a, ()> {
            self.floors.lock().unwrap().push(provider.to_owned());
            Box::pin(async {})
        }

        fn ollama_state<'a>(&'a self) -> BoxFuture<'a, UsageOllamaState> {
            let state = UsageOllamaState {
                attempt_at: self.attempt_at.load(Ordering::SeqCst),
                blocked: now_ms() < self.blocked_until.load(Ordering::SeqCst),
                history_paused: self
                    .paused
                    .lock()
                    .unwrap()
                    .as_ref()
                    .map(|error| json!({ "error": error })),
            };
            Box::pin(async move { state })
        }

        fn pause_history(&self, error: &str) {
            *self.paused.lock().unwrap() = Some(error.to_owned());
        }

        fn arm_ollama_gate<'a>(&'a self, delay_ms: i64) -> BoxFuture<'a, ()> {
            self.armed.lock().unwrap().push(delay_ms);
            self.blocked_until
                .store(now_ms() + delay_ms, Ordering::SeqCst);
            Box::pin(async {})
        }

        fn clear_ollama_gate<'a>(&'a self) -> BoxFuture<'a, ()> {
            self.clears.fetch_add(1, Ordering::SeqCst);
            self.blocked_until.store(0, Ordering::SeqCst);
            Box::pin(async {})
        }
    }

    fn runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap()
    }

    /// Every cadence pushed out of reach, then the ones a test cares about.
    fn quiet_config() -> Config {
        Config {
            debounce: Duration::from_secs(3_600),
            file_poll: Duration::from_secs(3_600),
            ollama_poll: Duration::from_secs(3_600),
            ..Config::default()
        }
    }

    fn idle() -> BusEvent {
        BusEvent::Status {
            id: "agent-1".to_owned(),
            status: Status::Idle,
        }
    }

    fn ollama_ok() -> Value {
        json!({ "ollama": { "ok": true, "source": "ollama" } })
    }

    #[test]
    fn the_idle_debounce_coalesces_a_burst_into_one_all_source_refresh() {
        let runtime = runtime();
        let bus = Bus::new();
        let recorder = Recorder::new(ollama_ok());
        let config = Config {
            debounce: Duration::from_millis(40),
            ..quiet_config()
        };
        let _automation = start_with(
            runtime.handle().clone(),
            recorder.clone(),
            bus.clone(),
            config,
        );

        for _ in 0..5 {
            bus.emit(&idle());
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(
            recorder.refreshes().is_empty(),
            "nothing before the debounce expires: {:?}",
            recorder.refreshes()
        );

        std::thread::sleep(Duration::from_millis(220));
        assert_eq!(
            recorder.refreshes(),
            vec![Vec::<String>::new()],
            "the burst is one all-source pull"
        );

        // A non-idle status never arms it.
        bus.emit(&BusEvent::Status {
            id: "agent-1".to_owned(),
            status: Status::Running,
        });
        std::thread::sleep(Duration::from_millis(120));
        assert_eq!(recorder.refreshes().len(), 1);
    }

    #[test]
    fn a_reset_timer_clears_the_floor_and_pulls_that_provider() {
        let runtime = runtime();
        let bus = Bus::new();
        let recorder = Recorder::new(ollama_ok());
        let config = Config {
            reset_slack: Duration::from_millis(0),
            ..quiet_config()
        };
        let _automation = start_with(
            runtime.handle().clone(),
            recorder.clone(),
            bus.clone(),
            config.clone(),
        );

        // Only the claude 5h window is schedulable: the others are past or
        // beyond the horizon, so they arm nothing.
        let document = json!({
            "ollama": null,
            "claude": {
                "session": { "resetsAt": iso_ms((config.clock)() + 60) },
                "weekly": { "resetsAt": iso_ms((config.clock)() - 1_000) },
            },
            "codex": {
                "session": null,
                "weekly": { "resetsAt": iso_ms((config.clock)() + 90 * 86_400_000) },
            },
        });
        bus.emit(&BusEvent::Usage(document));

        std::thread::sleep(Duration::from_millis(250));
        assert_eq!(
            recorder.refreshes(),
            vec![vec!["claude".to_owned()]],
            "one pull, for the window that reset"
        );
        assert_eq!(*recorder.floors.lock().unwrap(), vec!["claude".to_owned()]);

        // A fired timer is spent: without a new document nothing re-arms it.
        std::thread::sleep(Duration::from_millis(150));
        assert_eq!(recorder.refreshes().len(), 1);
    }

    #[test]
    fn each_sampler_pulls_only_its_own_lane_on_its_own_cadence() {
        let runtime = runtime();
        let bus = Bus::new();
        let recorder = Recorder::new(ollama_ok());
        let config = Config {
            file_poll: Duration::from_millis(20),
            ollama_poll: Duration::from_millis(30),
            ..quiet_config()
        };
        let _automation = start_with(
            runtime.handle().clone(),
            recorder.clone(),
            bus.clone(),
            config,
        );

        std::thread::sleep(Duration::from_millis(200));
        let refreshes = recorder.refreshes();
        assert!(
            recorder.count("claude") >= 3,
            "the Claude file tier ticks every 20ms: {refreshes:?}"
        );
        assert!(
            recorder.count("codex") >= 3,
            "the Codex file tier ticks every 20ms: {refreshes:?}"
        );
        assert!(
            recorder.count("ollama") >= 2,
            "the Ollama lane keeps its slower cadence: {refreshes:?}"
        );
        assert!(
            refreshes
                .iter()
                .all(|sources| sources.len() == 1 && !sources[0].is_empty()),
            "no sampler drags another lane along: {refreshes:?}"
        );
    }

    #[test]
    fn the_ollama_lane_backs_off_to_the_cap_and_a_success_resets_it() {
        let runtime = runtime();
        let bus = Bus::new();
        let recorder = Recorder::new(json!({
            "ollama": { "ok": false, "source": "ollama", "error": "boom" },
        }));
        let config = Config {
            ollama_poll: Duration::from_millis(10),
            ollama_backoff_cap: Duration::from_millis(40),
            ..quiet_config()
        };
        let _automation = start_with(
            runtime.handle().clone(),
            recorder.clone(),
            bus.clone(),
            config,
        );

        std::thread::sleep(Duration::from_millis(320));
        let armed = recorder.armed();
        assert!(
            armed.len() >= 4,
            "four failed attempts arm four backoffs: {armed:?}"
        );
        assert_eq!(&armed[..4], &[10, 20, 40, 40], "doubling, then the cap");
        assert!(armed.iter().all(|delay| *delay <= 40), "{armed:?}");
        assert_eq!(
            recorder.clears.load(Ordering::SeqCst),
            0,
            "failures never clear the gate"
        );

        // A success clears the gate and the accumulated backoff.
        recorder.set_response(ollama_ok());
        std::thread::sleep(Duration::from_millis(200));
        assert!(
            recorder.clears.load(Ordering::SeqCst) > 0,
            "a good read re-enables the lane"
        );
        let after_success = recorder.armed().len();

        // The next failure starts the ladder over from the poll interval.
        recorder.set_response(json!({
            "ollama": { "ok": false, "source": "ollama", "error": "boom" },
        }));
        std::thread::sleep(Duration::from_millis(80));
        let armed = recorder.armed();
        assert!(
            armed.len() > after_success,
            "a failure after success arms again: {armed:?}"
        );
        assert_eq!(
            armed[after_success], 10,
            "a success reset the backoff to the poll interval: {armed:?}"
        );
    }

    #[test]
    fn an_expired_login_pauses_the_lane_and_no_config_arms_the_cap() {
        let runtime = runtime();
        let bus = Bus::new();
        let recorder = Recorder::new(json!({
            "ollama": {
                "ok": false,
                "source": "ollama",
                "needsAuth": true,
                "error": "auth-expired",
            },
        }));
        let config = Config {
            ollama_poll: Duration::from_millis(10),
            ollama_backoff_cap: Duration::from_millis(40),
            ..quiet_config()
        };
        let _automation = start_with(
            runtime.handle().clone(),
            recorder.clone(),
            bus.clone(),
            config,
        );

        std::thread::sleep(Duration::from_millis(120));
        assert_eq!(
            recorder.paused.lock().unwrap().as_deref(),
            Some("auth-expired")
        );
        assert!(recorder.armed().is_empty(), "a pause is not a backoff");
        // Paused: the lane stops sampling entirely.
        let paused_at = recorder.count("ollama");
        std::thread::sleep(Duration::from_millis(120));
        assert_eq!(recorder.count("ollama"), paused_at, "the lane is stopped");

        // `no-config` is not a failure: arm the cap and keep sampling.
        recorder.set_response(json!({
            "ollama": { "ok": false, "source": "ollama", "needsAuth": true, "error": "no-config" },
        }));
        *recorder.paused.lock().unwrap() = None;
        recorder.blocked_until.store(0, Ordering::SeqCst);
        std::thread::sleep(Duration::from_millis(120));
        assert_eq!(
            recorder.armed().first(),
            Some(&40),
            "no-config arms the cap directly: {:?}",
            recorder.armed()
        );
    }

    #[test]
    fn stop_halts_every_timer_and_unsubscribes() {
        let runtime = runtime();
        let bus = Bus::new();
        let recorder = Recorder::new(ollama_ok());
        let config = Config {
            debounce: Duration::from_millis(20),
            file_poll: Duration::from_millis(20),
            ollama_poll: Duration::from_millis(20),
            ..quiet_config()
        };
        let mut automation = start_with(
            runtime.handle().clone(),
            recorder.clone(),
            bus.clone(),
            config,
        );

        std::thread::sleep(Duration::from_millis(80));
        assert!(
            !recorder.refreshes().is_empty(),
            "the timers ran before the stop"
        );

        automation.stop();
        let stopped = recorder.refreshes();
        bus.emit(&idle());
        bus.emit(&BusEvent::Usage(json!({
            "claude": { "session": { "resetsAt": iso_ms(now_ms() + 20) } },
        })));
        std::thread::sleep(Duration::from_millis(150));
        assert_eq!(
            recorder.refreshes(),
            stopped,
            "no timer and no listener survives the stop"
        );

        // Stopping twice, and dropping afterwards, is harmless.
        automation.stop();
        drop(automation);
    }
}
