//! Timers for the background-task service: the minute-resolution tick, the
//! watchdog poll and the `status:Exited` liveness listener
//! (`server/background.mjs:243-340`).
//!
//! Node starts both intervals with `setInterval(...).unref()` and reacts to the
//! same registry exit signal the crons slice uses. Natively the handle keeps
//! the loops alive; stopping (or dropping) it unsubscribes from the bus, closes
//! child admission, aborts the attempts and watchdog polls the loops spawned, and
//! then aborts the loops themselves, so no loop can add work after the stop. Bus
//! listeners run synchronously (`bus.rs:87-92`), so the exit listener only
//! forwards the session id on an unbounded channel — it never locks the service
//! or emits.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::Value;
use tokio::runtime::Handle;
use tokio::sync::mpsc;
use tokio::task::{JoinHandle, JoinSet};

use crate::agent_wire::Status;
use crate::background::{self, Attempt, Service};
use crate::bus::{Bus, BusEvent};

/// Timer cadences and the watchdog's kill grace.
#[derive(Clone, Debug)]
pub struct Config {
    pub tick: Duration,
    pub watchdog: Duration,
    pub kill_grace: Duration,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            tick: Duration::from_millis(background::TICK_MS),
            watchdog: Duration::from_millis(background::WATCHDOG_MS),
            kill_grace: Duration::from_millis(background::KILL_GRACE_MS),
        }
    }
}

// VERIFY: background-scheduler-start
/// Starts the tick, watchdog and exit-listener loops against `service`.
pub fn start(handle: Handle, service: Arc<Service>, bus: &Bus) -> BackgroundScheduler {
    start_with(handle, service, bus, Config::default())
}

/// [`start`] over injected cadences (tests).
pub fn start_with(
    handle: Handle,
    service: Arc<Service>,
    bus: &Bus,
    config: Config,
) -> BackgroundScheduler {
    let mut tasks = Vec::new();
    // VERIFY: wave3-hostreview-3
    // Every attempt/watchdog future the loops fire is tracked here, so `stop`
    // can abort work that is still in flight instead of only the loops.
    let children: Children = Arc::new(Mutex::new(JoinSet::new()));
    // VERIFY: wave6-stop_flags-11
    // Admission gate for `spawn_child`, flipped by `stop` before it aborts
    // anything. A loop can be at its spawn point when `stop` runs; without this
    // flag the child it adds after the drain would survive the stop and still run
    // `attempt_run`/`watchdog_with_grace`.
    let stopped = Arc::new(AtomicBool::new(false));

    // `setInterval(tick, TICK_MS)` — the loop only fires the shared run path
    // when the service's own due gate allows it; the attempt is not awaited.
    {
        let service = service.clone();
        let period = config.tick;
        let children = children.clone();
        let stopped = stopped.clone();
        tasks.push(handle.spawn(async move {
            let mut timer = tokio::time::interval_at(tokio::time::Instant::now() + period, period);
            loop {
                timer.tick().await;
                let now = service.now();
                if !service.take_due(now, background::TICK_MINUTES * 60_000) {
                    continue;
                }
                let service = service.clone();
                spawn_child(&children, &stopped, async move {
                    // VERIFY: wave5-fix-cron-bg-23
                    // Node's tick caller logs a thrown attempt
                    // (`background.mjs:252`); surface it instead of dropping it,
                    // which a gate `TypeError` now reaches after the wave5 fix.
                    if let Err(error) = service.attempt_run(Attempt::default()).await {
                        eprintln!("background tick failed: {}", error.message());
                    }
                });
            }
        }));
    }

    // `setInterval(watchdog, WATCHDOG_MS)` — a fresh call per poll, never awaited.
    {
        let service = service.clone();
        let period = config.watchdog;
        let children = children.clone();
        let stopped = stopped.clone();
        let grace = u64::try_from(config.kill_grace.as_millis()).unwrap_or(u64::MAX);
        tasks.push(handle.spawn(async move {
            let mut timer = tokio::time::interval_at(tokio::time::Instant::now() + period, period);
            loop {
                timer.tick().await;
                let service = service.clone();
                spawn_child(&children, &stopped, async move {
                    service.watchdog_with_grace(grace).await;
                });
            }
        }));
    }

    // `reg.bus.on('status', ...)`: forward exited session ids only.
    let (exits, mut exited) = mpsc::unbounded_channel::<String>();
    let subscription = bus.subscribe(Arc::new(move |event| {
        if let BusEvent::Status { id, status } = event {
            if matches!(status, Status::Exited) {
                let _ = exits.send(id.clone());
            }
        }
    }));
    {
        let service = service.clone();
        tasks.push(handle.spawn(async move {
            while let Some(id) = exited.recv().await {
                let session = service.live_background_task().and_then(|task| {
                    task.get("sessionId")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                });
                if session.as_deref() == Some(id.as_str()) {
                    service.heal_live_bg_task().await;
                }
            }
        }));
    }

    BackgroundScheduler {
        bus: bus.clone(),
        subscription,
        tasks,
        children,
        stopped,
    }
}

type Children = Arc<Mutex<JoinSet<()>>>;

// VERIFY: wave6-stop_flags-12
/// Spawns an attempt/watchdog future onto the tracked child set, reaping any
/// already-finished children first so a long-lived daemon does not accumulate
/// completed entries. Refuses to admit anything once `stopped` is set: the flag
/// is read under the same lock `stop` aborts under, so a loop at its spawn point
/// either admits its child before the flag is set (and the drain aborts it) or is
/// refused here.
fn spawn_child<F>(children: &Children, stopped: &AtomicBool, future: F)
where
    F: std::future::Future<Output = ()> + Send + 'static,
{
    let mut children = children.lock().unwrap();
    if stopped.load(Ordering::SeqCst) {
        return;
    }
    while children.try_join_next().is_some() {}
    let _ = children.spawn(future);
}

/// The running loops. `stop` (or drop) unsubscribes before aborting.
pub struct BackgroundScheduler {
    bus: Bus,
    subscription: u64,
    tasks: Vec<JoinHandle<()>>,
    children: Children,
    stopped: Arc<AtomicBool>,
}

impl BackgroundScheduler {
    /// Stops every loop and every attempt/watchdog poll still in flight.
    /// Idempotent.
    // VERIFY: wave4-lifecycle-17
    pub fn stop(&mut self) {
        if self.tasks.is_empty() {
            return;
        }
        self.bus.unsubscribe(self.subscription);
        // VERIFY: wave6-stop_flags-13
        // Close admission before draining: a loop already at its spawn point
        // holds the children lock across its flag check and `spawn`, so it either
        // gets its child tracked before this abort (and the abort reaches it) or
        // sees the flag and adds nothing. Abort the loops next, then repeat the
        // abort once more — a loop that passed the check just before the flag was
        // set may still be finishing its own spawn, and the second pass is what
        // catches the child it left behind.
        self.stopped.store(true, Ordering::SeqCst);
        self.children.lock().unwrap().abort_all();
        for task in self.tasks.drain(..) {
            task.abort();
        }
        self.children.lock().unwrap().abort_all();
    }
}

impl Drop for BackgroundScheduler {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::background::{
        BackgroundDeps, BackgroundRegistry, BackgroundTasks, BoxFuture, NewBackgroundTask,
        SessionTokens,
    };
    use serde_json::{Value, json};
    use std::fs;
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    #[derive(Default)]
    struct Tasks {
        tasks: Mutex<Vec<Value>>,
        updates: Mutex<Vec<String>>,
    }

    impl BackgroundTasks for Tasks {
        fn snapshot(&self) -> Value {
            json!({ "tasks": self.tasks.lock().unwrap().clone(), "history": [] })
        }

        fn create<'a>(&'a self, _spec: NewBackgroundTask) -> BoxFuture<'a, Result<Value, String>> {
            Box::pin(async { Err("not used".to_owned()) })
        }

        fn update<'a>(
            &'a self,
            id: &'a str,
            _patch: Value,
        ) -> BoxFuture<'a, Result<Value, String>> {
            let id = id.to_owned();
            Box::pin(async move {
                self.updates.lock().unwrap().push(id);
                Ok(Value::Null)
            })
        }
    }

    #[derive(Default)]
    struct Usage {
        calls: AtomicUsize,
    }

    impl crate::background::BackgroundUsage for Usage {
        fn usage<'a>(&'a self) -> BoxFuture<'a, Result<Value, String>> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Box::pin(async {
                Ok(json!({
                    "claude": { "ok": true, "session": { "pctUsed": 99 }, "weekly": { "pctUsed": 99 } }
                }))
            })
        }
    }

    struct Registry {
        live: Mutex<Vec<String>>,
        inputs: Mutex<Vec<String>>,
        kills: Mutex<Vec<String>>,
    }

    impl BackgroundRegistry for Registry {
        fn is_live(&self, id: &str) -> bool {
            self.live.lock().unwrap().iter().any(|live| live == id)
        }

        fn input(&self, id: &str, _data: &str) {
            self.inputs.lock().unwrap().push(id.to_owned());
        }

        fn kill(&self, id: &str) -> Result<(), String> {
            self.kills.lock().unwrap().push(id.to_owned());
            Ok(())
        }
    }

    struct Tokens;

    impl SessionTokens for Tokens {
        fn tokens<'a>(
            &'a self,
            _cwd: String,
            _session_id: String,
            _tool: String,
        ) -> BoxFuture<'a, Result<i64, String>> {
            Box::pin(async { Ok(0) })
        }
    }

    struct Fixture {
        dir: std::path::PathBuf,
        tasks: Arc<Tasks>,
        usage: Arc<Usage>,
        registry: Arc<Registry>,
        bus: Bus,
        service: Arc<Service>,
    }

    impl Fixture {
        fn new() -> Self {
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let dir = std::env::temp_dir().join(format!(
                "singularity-background-schedule-{}-{nanos}",
                std::process::id()
            ));
            fs::create_dir_all(dir.join("state")).unwrap();
            let bus = Bus::new();
            let tasks = Arc::new(Tasks::default());
            tasks.tasks.lock().unwrap().push(json!({
                "id": "bg-live", "tags": ["background"], "column": "inprogress",
                "sessionId": "live", "model": "m", "repo": "r",
            }));
            let usage = Arc::new(Usage::default());
            let registry = Arc::new(Registry {
                live: Mutex::new(vec!["live".to_owned()]),
                inputs: Mutex::new(Vec::new()),
                kills: Mutex::new(Vec::new()),
            });
            let tokens = Arc::new(Tokens);
            let service = Service::new(BackgroundDeps {
                state_dir: dir.join("state"),
                reports_dir: dir.join(".reports"),
                bus: bus.clone(),
                registry: registry.clone(),
                tasks: tasks.clone(),
                usage: usage.clone(),
                route: Arc::new(|_, _| json!({ "isClaudeModel": true })),
                tokens: tokens.clone(),
                clock: Arc::new(|| 0),
                write_atomic: Arc::new(|path, bytes| fs::write(path, bytes)),
            });
            Self {
                dir,
                tasks,
                usage,
                registry,
                bus,
                service,
            }
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.dir);
        }
    }

    fn run<F: std::future::Future>(future: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(future)
    }

    // `verifies the watchdog loop polls on its cadence and that dropping the
    // handle stops every loop.
    #[test]
    fn watchdog_polls_on_cadence_and_drop_stops_the_loops() {
        let fixture = Fixture::new();
        let job = fixture
            .service
            .create_job(
                &json!({ "title": "a", "description": "d", "cwd": "r" }),
                None,
            )
            .unwrap();
        fixture
            .service
            .update_job(
                job["id"].as_str().unwrap(),
                &json!({ "lastTaskId": "bg-live" }),
            )
            .unwrap();
        run(async {
            let service = fixture.service.clone();
            let mut scheduler = start_with(
                Handle::current(),
                service.clone(),
                &fixture.bus,
                Config {
                    tick: Duration::from_millis(10),
                    watchdog: Duration::from_millis(20),
                    kill_grace: Duration::ZERO,
                },
            );
            tokio::time::sleep(Duration::from_millis(90)).await;
            let polls = fixture.usage.calls.load(Ordering::SeqCst);
            assert!(polls > 0, "the watchdog polled usage at least once");
            scheduler.stop();
            let after_stop = fixture.usage.calls.load(Ordering::SeqCst);
            tokio::time::sleep(Duration::from_millis(80)).await;
            assert_eq!(
                fixture.usage.calls.load(Ordering::SeqCst),
                after_stop,
                "no loop runs after stop/drop"
            );
        });
    }

    // The exit listener releases a dead-session card without waiting for the
    // watchdog's own backstop (`background.mjs:335-339`).
    #[test]
    fn exited_status_releases_the_matching_background_card() {
        let fixture = Fixture::new();
        run(async {
            let scheduler = start(Handle::current(), fixture.service.clone(), &fixture.bus);
            // VERIFY: wave3-fix-background-12
            // Node clears `proc` before emitting the exited status
            // (`agents.mjs:257-284`), so `isLive` is already false when the
            // listener runs; the fake must model that or the heal is a no-op.
            fixture.registry.live.lock().unwrap().clear();
            fixture.bus.emit(&BusEvent::Status {
                id: "other".to_owned(),
                status: Status::Exited,
            });
            fixture.bus.emit(&BusEvent::Status {
                id: "live".to_owned(),
                status: Status::Exited,
            });
            tokio::time::sleep(Duration::from_millis(30)).await;
            assert_eq!(
                fixture.tasks.updates.lock().unwrap().as_slice(),
                ["bg-live"]
            );
            drop(scheduler);
        });
    }

    // VERIFY: wave4-lifecycle-13
    /// `stop` aborts the attempts/watchdog polls the loops already fired, so no
    /// in-flight run can mutate state after the scheduler is stopped.
    #[test]
    fn stop_aborts_attempts_the_loops_already_spawned() {
        let fixture = Fixture::new();
        run(async {
            let mut scheduler = start_with(
                Handle::current(),
                fixture.service.clone(),
                &fixture.bus,
                Config {
                    tick: Duration::from_millis(10),
                    watchdog: Duration::from_millis(10),
                    kill_grace: Duration::ZERO,
                },
            );
            // Stand-in for `attempt_run`: it would write an update once released.
            let released = Arc::new(AtomicUsize::new(0));
            let (gate, wait) = tokio::sync::oneshot::channel::<()>();
            {
                let released = released.clone();
                scheduler.children.lock().unwrap().spawn(async move {
                    let _ = wait.await;
                    released.fetch_add(1, Ordering::SeqCst);
                });
            }
            scheduler.stop();
            let _ = gate.send(());
            // VERIFY: wave6-stop_flags-14
            // Drain the tracked set instead of sleeping: an aborted child resolves
            // on `join_next` at once, so waiting for the set to empty is
            // deterministic and no wall-clock window is needed to prove the child
            // never resumed.
            let mut drained = {
                let mut children = scheduler.children.lock().unwrap();
                std::mem::replace(&mut *children, JoinSet::new())
            };
            while drained.join_next().await.is_some() {}
            assert_eq!(
                released.load(Ordering::SeqCst),
                0,
                "an in-flight child must not resume after stop"
            );
        });
    }

    // VERIFY: wave6-stop_flags-15
    /// A3 regression: a loop that reaches `spawn_child` after `stop` cannot admit
    /// a new attempt/watchdog poll, so nothing runs after the scheduler is stopped.
    #[test]
    fn a_child_offered_after_stop_is_refused() {
        let fixture = Fixture::new();
        run(async {
            let mut scheduler = start_with(
                Handle::current(),
                fixture.service.clone(),
                &fixture.bus,
                Config {
                    // Long cadences: neither loop reaches its spawn point, so the
                    // set is empty and the refused child is the only candidate.
                    tick: Duration::from_secs(3600),
                    watchdog: Duration::from_secs(3600),
                    kill_grace: Duration::ZERO,
                },
            );
            scheduler.stop();

            let ran = Arc::new(AtomicUsize::new(0));
            {
                let ran = ran.clone();
                spawn_child(&scheduler.children, &scheduler.stopped, async move {
                    ran.fetch_add(1, Ordering::SeqCst);
                });
            }
            assert_eq!(
                scheduler.children.lock().unwrap().len(),
                0,
                "no child is admitted after stop"
            );
            assert_eq!(ran.load(Ordering::SeqCst), 0);
        });
    }
}
