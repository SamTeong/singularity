//! Native window-anchor host: the shared effect engine plus the daemon-side
//! seams `window_anchor::Service` effects cross into.
//!
//! Ports the non-policy half of `server/window-anchor.mjs`:
//! - [`submit`] replaces the Node effect queue (`enqueueEffect`, :38-57):
//!   dispatch plus `append_telemetry`/`save_state`/`emit_snapshot` happen under
//!   the anchor lock, so an older save can never land after a newer one.
//! - [`apply`] replaces `applyEffects` (:111-140) and is shared by the poke
//!   route and the timer/usage paths.
//! - [`NativeAnchorHost`] owns the timers (`:59-66`), the timer preflight flow
//!   (`timerFired`, :149-178), the `preflighting` set and the real action runner
//!   (`runAction`, :85-109).
//! - [`NativeAnchorHost::subscribe_usage`] is `bus.on('usage', onUsage)`
//!   (:180-188, :216-217).
//!
//! Ordering invariants (see the design, §3.1/D4):
//! - `submit` emits `WindowAnchor` while holding the anchor lock, so **no
//!   WindowAnchor listener may take the anchor lock**.
//! - the usage listener runs on a tokio worker inside the usage refresh: it must
//!   never call `Handle::block_on`, so actions started from it are
//!   fire-and-forget (`spawn_blocking`).
//! - `refresh_usage` uses `Handle::block_on` and is only ever reached from a
//!   blocking thread (poke `spawn_blocking`, the timer `spawn_blocking`).

use std::collections::{BTreeSet, HashMap};
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{Value, json};

use crate::bus::{Bus, BusEvent};
use crate::http_utilities::AnchorHost;
use crate::prompt_run::{PromptRunDeps, PromptRunOpts};
use crate::window_anchor;

/// `POKE_TIMEOUT_MS` (`window-anchor.mjs:11`).
const POKE_TIMEOUT_MS: u64 = 90_000;
/// `CHEAP_MODELS` (`window-anchor.mjs:12`).
const CHEAP_MODELS: [(&str, &str); 2] = [("claude", "haiku"), ("codex", "gpt-6-luna")];

/// The boxed future shape of [`UsageRefresh`]; the crate has no `futures`.
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// `getUsage({force: true, sources: [provider]})` (`window-anchor.mjs:234`)
/// behind an injected seam; `Err` becomes `usage_refresh: "failed"`.
pub type UsageRefresh =
    Arc<dyn Fn(&str) -> BoxFuture<'static, Result<Value, String>> + Send + Sync>;

/// `runAction`'s CLI half (`window-anchor.mjs:85-109`): `(model, usage)` on
/// success, `(model, message)` on failure; `model` is `None` when the cheap
/// model is not in the provider's group.
pub type ActionRunner = Arc<
    dyn Fn(&str) -> Result<(Option<String>, Option<Value>), (Option<String>, String)> + Send + Sync,
>;

/// What the effect engine needs, shared by the HTTP routes and the host.
pub struct AnchorCore {
    /// The exact service the runtime and `/ws` share.
    pub anchor: Arc<Mutex<window_anchor::Service>>,
    /// `bus.emit('window-anchor', snapshot)` (`window-anchor.mjs:52`).
    pub bus: Bus,
    /// `<state>/window-anchor.json`.
    pub state_path: PathBuf,
    /// `<usage_state>/window-anchor-runs.jsonl`.
    pub telemetry_path: PathBuf,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0)
}

fn is_persistence(effect: &Value) -> bool {
    matches!(
        effect["type"].as_str(),
        Some("append_telemetry" | "save_state" | "emit_snapshot")
    )
}

/// Dispatch plus ordered persistence under the anchor lock.
///
/// The persistence effects (`append_telemetry`, `save_state`, `emit_snapshot`)
/// are applied here and removed from the returned `effects`, so the caller only
/// has to hand the remainder to [`apply`]. Node's `submit` (:142-147) logs
/// `warnings` and awaits persistence; both happen here too.
pub fn submit(core: &AnchorCore, op: &str, request: &Value) -> Value {
    let mut service = core
        .anchor
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let mut response = service.dispatch(op, request);
    let effects = response["effects"].as_array().cloned().unwrap_or_default();
    for effect in &effects {
        match effect["type"].as_str() {
            Some("append_telemetry") => {
                let result = window_anchor::append_telemetry(
                    core.telemetry_path.to_string_lossy().as_ref(),
                    &effect["record"],
                );
                if let Some(error) = result["error"].as_str() {
                    eprintln!("window-anchor telemetry write failed: {error}");
                }
            }
            Some("save_state") => {
                let result = window_anchor::save(
                    core.state_path.to_string_lossy().as_ref(),
                    &effect["state"],
                );
                if let Some(error) = result["error"].as_str() {
                    eprintln!("window-anchor.json write failed: {error}");
                }
            }
            Some("emit_snapshot") => core
                .bus
                .emit(&BusEvent::WindowAnchor(effect["snapshot"].clone())),
            _ => {}
        }
    }
    for warning in response["warnings"].as_array().into_iter().flatten() {
        if let Some(message) = warning.as_str() {
            eprintln!("window-anchor initialization warning: {message}");
        }
    }
    if response.get("effects").is_some() {
        response["effects"] = Value::Array(
            effects
                .into_iter()
                .filter(|effect| !is_persistence(effect))
                .collect(),
        );
    }
    response
}

/// `applyEffects` (`window-anchor.mjs:111-140`). Persistence is not handled here:
/// [`submit`] already applied it under the anchor lock.
///
/// `await_actions` mirrors Node: the poke path and nested action results wait for
/// the CLI, every timer/usage-driven action is fire-and-forget.
pub fn apply(
    core: &Arc<AnchorCore>,
    host: &Arc<dyn AnchorHost>,
    effects: &Value,
    await_actions: bool,
) {
    for effect in effects.as_array().into_iter().flatten() {
        match effect["type"].as_str() {
            Some("arm_timer" | "clear_timer") => host.schedule(effect),
            Some("run_action") => {
                if await_actions {
                    finish_action(core, host, effect);
                } else {
                    let core = core.clone();
                    let host = host.clone();
                    let effect = effect.clone();
                    let task = move || finish_action(&core, &host, &effect);
                    match tokio::runtime::Handle::try_current() {
                        Ok(handle) => {
                            // Await the join handle so a panicking runner is logged
                            // like Node's `'window-anchor action completion failed'`.
                            handle.spawn(async move {
                                if tokio::task::spawn_blocking(task).await.is_err() {
                                    eprintln!("window-anchor action completion failed");
                                }
                            });
                        }
                        // No runtime (synchronous unit construction): run inline.
                        Err(_) => task(),
                    }
                }
            }
            Some("append_telemetry" | "save_state" | "emit_snapshot") => {}
            other => eprintln!("window-anchor effect ignored: {other:?}"),
        }
    }
}

/// `runAction` + `actionResult` (`window-anchor.mjs:68-109`): run, then dispatch
/// `window_anchor_action_result` and apply its effects with `awaitActions=true`.
fn finish_action(core: &Arc<AnchorCore>, host: &Arc<dyn AnchorHost>, effect: &Value) {
    let fields = match host.run_action(effect) {
        Ok(fields) => fields,
        Err(error) => json!({
            "action_id": effect["action_id"],
            "provider": effect["provider"],
            "outcome": "error",
            "error": error,
            "ended_at_ms": now_ms(),
        }),
    };
    let response = submit(core, "window_anchor_action_result", &fields);
    apply(core, host, &response["effects"], true);
}

/// The daemon-side host: timers, timer preflight, `preflighting` and the real
/// action runner.
pub struct NativeAnchorHost {
    core: Arc<AnchorCore>,
    /// `Arc::new_cyclic`, so a timer task can call back into the host.
    me: Weak<NativeAnchorHost>,
    handle: tokio::runtime::Handle,
    /// `armed` (`window-anchor.mjs:18`): provider -> (generation, abort handle).
    armed: Mutex<HashMap<String, (i64, tokio::task::AbortHandle)>>,
    /// `preflighting` (`window-anchor.mjs:19`).
    preflighting: Mutex<BTreeSet<String>>,
    /// `nextTimerEvent` (`window-anchor.mjs:32`).
    next_timer_event: AtomicU64,
    usage_refresh: UsageRefresh,
    runner: ActionRunner,
    clock: Arc<dyn Fn() -> i64 + Send + Sync>,
}

impl NativeAnchorHost {
    pub fn new(
        core: Arc<AnchorCore>,
        handle: tokio::runtime::Handle,
        usage_refresh: UsageRefresh,
        runner: ActionRunner,
        clock: Arc<dyn Fn() -> i64 + Send + Sync>,
    ) -> Arc<Self> {
        Arc::new_cyclic(|me| Self {
            core,
            me: me.clone(),
            handle,
            armed: Mutex::new(HashMap::new()),
            preflighting: Mutex::new(BTreeSet::new()),
            next_timer_event: AtomicU64::new(0),
            usage_refresh,
            runner,
            clock,
        })
    }

    /// `bus.on('usage', onUsage)` (`window-anchor.mjs:180-188, :216-217`).
    ///
    /// Runs on the emitting worker inside the usage refresh, so it never blocks:
    /// `submit` is a short lock plus small file writes and any action it admits
    /// is handed to `spawn_blocking`.
    pub fn subscribe_usage(self: &Arc<Self>) -> u64 {
        let weak = Arc::downgrade(self);
        self.core.bus.subscribe(Arc::new(move |event| {
            let BusEvent::Usage(usage) = event else {
                return;
            };
            let Some(host) = weak.upgrade() else {
                return;
            };
            let request = json!({
                "usage": usage,
                "authoritative": true,
                "preflighting": host.preflighting(),
                "now_ms": (host.clock)(),
            });
            let response = submit(&host.core, "window_anchor_usage", &request);
            apply(&host.core, &host.as_host(), &response["effects"], false);
        }))
    }

    /// Providers the daemon is currently preflighting (`[...preflighting]`).
    pub fn preflighting(&self) -> Vec<String> {
        self.preflighting
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .iter()
            .cloned()
            .collect()
    }

    fn as_host(self: &Arc<Self>) -> Arc<dyn AnchorHost> {
        self.clone()
    }

    /// `timerEffect` (`window-anchor.mjs:59-66`): replace the provider's timer and
    /// store its generation.
    fn arm(&self, effect: &Value) {
        let Some(provider) = effect["provider"].as_str() else {
            return;
        };
        let generation = effect["generation"].as_i64().unwrap_or(-1);
        let fire_at_ms = effect["fire_at_ms"].as_i64().unwrap_or(0);
        let delay = fire_at_ms.saturating_sub((self.clock)()).max(0) as u64;
        if let Some((_, previous)) = self
            .armed
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(provider)
        {
            previous.abort();
        }
        let weak = self.me.clone();
        let owned = provider.to_owned();
        let task = self.handle.spawn(async move {
            tokio::time::sleep(Duration::from_millis(delay)).await;
            if let Some(host) = weak.upgrade() {
                let _ =
                    tokio::task::spawn_blocking(move || host.timer_fired(&owned, generation)).await;
            }
        });
        self.armed
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .insert(provider.to_owned(), (generation, task.abort_handle()));
    }

    /// `clear_timer` (`window-anchor.mjs:118-123`).
    fn clear(&self, effect: &Value) {
        let Some(provider) = effect["provider"].as_str() else {
            return;
        };
        if let Some((_, previous)) = self
            .armed
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(provider)
        {
            previous.abort();
        }
    }

    /// `timerFired` (`window-anchor.mjs:149-178`), on a blocking thread.
    fn timer_fired(self: &Arc<Self>, provider: &str, generation: i64) {
        let event_id = format!(
            "window-anchor-timer-{}",
            self.next_timer_event.fetch_add(1, Ordering::SeqCst) + 1
        );
        {
            let mut armed = self.armed.lock().unwrap_or_else(|error| error.into_inner());
            if armed.get(provider).map(|(current, _)| *current) == Some(generation) {
                armed.remove(provider);
            }
        }
        let request = json!({
            "provider": provider,
            "generation": generation,
            "timer_event_id": event_id,
            "now_ms": (self.clock)(),
        });
        let response = submit(&self.core, "window_anchor_timer_fired", &request);
        if response["result"] != json!("preflight_required") {
            return;
        }
        let (usage_refresh, usage) = match self.preflight_refresh(provider) {
            Ok(usage) => ("ok", Some(usage)),
            Err(error) => {
                eprintln!("window-anchor preflight refresh failed: {error}");
                ("failed", None)
            }
        };
        let mut admit = json!({
            "provider": provider,
            "generation": generation,
            "timer_event_id": event_id,
            "usage_refresh": usage_refresh,
            "now_ms": (self.clock)(),
        });
        if let Some(usage) = usage {
            admit["usage"] = usage;
        }
        let response = submit(&self.core, "window_anchor_timer_admit", &admit);
        apply(&self.core, &self.as_host(), &response["effects"], false);
    }

    /// `refreshUsage({force: true, sources: [provider]})` with the
    /// `preflighting` marker held for the whole refresh (`window-anchor.mjs:166-171`,
    /// `:233-238`). Only ever reached from a blocking thread.
    fn preflight_refresh(&self, provider: &str) -> Result<Value, String> {
        self.preflighting
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .insert(provider.to_owned());
        let result = self.handle.block_on((self.usage_refresh)(provider));
        self.preflighting
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(provider);
        result
    }

    /// `runAction`'s result fields (`actionResult`, `window-anchor.mjs:68-83`).
    /// The native host always answers `Ok`: a failed prompt is
    /// `outcome: "error"` inside the fields, exactly like Node.
    fn action_fields(&self, effect: &Value) -> Value {
        let provider = effect["provider"].as_str().unwrap_or("");
        let started_at_ms = (self.clock)();
        let (model, usage, error) = match (self.runner)(provider) {
            Ok((model, usage)) => (model, usage, None),
            Err((model, error)) => (model, None, Some(error)),
        };
        let mut fields = json!({
            "action_id": effect["action_id"],
            "provider": provider,
            "outcome": if error.is_none() { "ok" } else { "error" },
            "now_ms": (self.clock)(),
            "started_at_ms": started_at_ms,
            "ended_at_ms": (self.clock)(),
            "model": model,
            "usage": usage.unwrap_or(Value::Null),
        });
        if let Some(error) = error {
            fields["error"] = json!(error.chars().take(200).collect::<String>());
        }
        fields
    }
}

// VERIFY: window-anchor-host
impl AnchorHost for NativeAnchorHost {
    fn schedule(&self, effect: &Value) {
        match effect["type"].as_str() {
            Some("arm_timer") => self.arm(effect),
            Some("clear_timer") => self.clear(effect),
            _ => {}
        }
    }

    fn run_action(&self, effect: &Value) -> Result<Value, String> {
        Ok(self.action_fields(effect))
    }

    fn refresh_usage(&self, provider: &str) -> Result<Value, String> {
        self.preflight_refresh(provider)
    }
}

/// `EFFORT_ARGS` (`window-anchor.mjs:13-16`).
fn effort_args(provider: &str) -> Vec<String> {
    let args: &[&str] = match provider {
        "claude" => &[
            "--safe-mode",
            "--tools",
            "",
            "--system-prompt",
            "Reply exactly: ok",
            "--effort",
            "low",
        ],
        "codex" => &[
            "--ignore-user-config",
            "--ignore-rules",
            "--json",
            "-c",
            "model_reasoning_effort=none",
        ],
        _ => &[],
    };
    args.iter().map(|arg| (*arg).to_owned()).collect()
}

/// `runAction`'s CLI half (`window-anchor.mjs:85-109`): the provider's cheap
/// model after the `groupFor` check, then one one-shot prompt.
///
/// The runner is invoked from a blocking thread, so [`prompt_run::run_blocking`]
/// is called directly instead of driving `run_prompt_with_metadata`.
pub fn native_runner(
    deps: PromptRunDeps,
    models_path: PathBuf,
    _handle: tokio::runtime::Handle,
) -> ActionRunner {
    Arc::new(move |provider: &str| {
        let Some((_, candidate)) = CHEAP_MODELS.iter().find(|(group, _)| *group == provider) else {
            return Err((
                None,
                format!("no 'undefined' model in the {provider} group"),
            ));
        };
        let route = crate::models::route(
            models_path.to_string_lossy().as_ref(),
            &json!(candidate),
            &Value::Null,
        );
        let group = route["group"].clone();
        if !group.is_null() && group.as_str() != Some(provider) {
            return Err((
                None,
                format!("no '{candidate}' model in the {provider} group"),
            ));
        }
        let opts = PromptRunOpts {
            timeout_ms: Some(POKE_TIMEOUT_MS),
            extra_args: effort_args(provider),
        };
        match crate::prompt_run::run_blocking(&deps, provider, candidate, "ok", &opts) {
            Ok(answer) => Ok((Some((*candidate).to_owned()), answer.usage)),
            Err(error) => Err((Some((*candidate).to_owned()), error)),
        }
    })
}

#[cfg(test)]
mod tests {
    use super::{ActionRunner, AnchorCore, NativeAnchorHost, UsageRefresh, apply, submit};
    use crate::bus::{Bus, BusEvent};
    use crate::http_utilities::AnchorHost;
    use crate::window_anchor;
    use serde_json::{Value, json};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
    use std::sync::{Arc, Mutex, Weak};
    use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

    const NOW: i64 = 1_900_000_000_000;

    struct Fixture(PathBuf);

    impl Fixture {
        fn new(name: &str) -> Self {
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let dir = std::env::temp_dir().join(format!(
                "singularity-window-anchor-host-{name}-{}-{nanos}",
                std::process::id()
            ));
            std::fs::create_dir_all(dir.join("state")).unwrap();
            std::fs::create_dir_all(dir.join("usage")).unwrap();
            Self(dir)
        }

        fn path(&self, rel: &str) -> PathBuf {
            self.0.join(rel)
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// Injected seams: records every call and can hold a refresh or an action
    /// open, so a test can observe the daemon mid-flight.
    #[derive(Default)]
    struct Probe {
        refreshes: Mutex<Vec<String>>,
        preflighting_seen: Mutex<Vec<Vec<String>>>,
        actions: Mutex<Vec<String>>,
        refresh_fails: AtomicBool,
        action_started: AtomicBool,
        refresh_gate: Mutex<Option<tokio::sync::oneshot::Receiver<()>>>,
        action_gate: Mutex<Option<tokio::sync::oneshot::Receiver<()>>>,
        host: Mutex<Option<Weak<NativeAnchorHost>>>,
    }

    fn iso(epoch_ms: i64) -> String {
        crate::usage_snapshot::window_anchor_timestamp_iso(epoch_ms).unwrap()
    }

    /// A full usage document whose one lane carries `session`.
    fn usage(provider: &str, started: bool, resets_at: i64, pct_used: f64) -> Value {
        let mut document = json!({ "ollama": null });
        document[provider] = json!({
            "ok": true,
            "source": provider,
            "session": {
                "started": started,
                "resetsAt": iso(resets_at),
                "pctUsed": pct_used,
            },
        });
        document
    }

    fn refresh_seam(probe: &Arc<Probe>) -> UsageRefresh {
        let probe = probe.clone();
        Arc::new(move |provider: &str| {
            probe.refreshes.lock().unwrap().push(provider.to_owned());
            let observed = probe
                .host
                .lock()
                .unwrap()
                .as_ref()
                .and_then(Weak::upgrade)
                .map(|host| host.preflighting())
                .unwrap_or_default();
            probe.preflighting_seen.lock().unwrap().push(observed);
            let fails = probe.refresh_fails.load(Ordering::SeqCst);
            let gate = probe.refresh_gate.lock().unwrap().take();
            let provider = provider.to_owned();
            Box::pin(async move {
                if let Some(gate) = gate {
                    let _ = tokio::time::timeout(Duration::from_secs(2), gate).await;
                }
                if fails {
                    return Err("synthetic refresh failure".to_owned());
                }
                // An expired idle window, so admission runs the action.
                Ok(usage(&provider, true, NOW - 60_000, 0.0))
            })
        })
    }

    fn runner_seam(probe: &Arc<Probe>) -> ActionRunner {
        let probe = probe.clone();
        Arc::new(move |provider: &str| {
            probe.actions.lock().unwrap().push(provider.to_owned());
            probe.action_started.store(true, Ordering::SeqCst);
            if let Some(gate) = probe.action_gate.lock().unwrap().take() {
                let _ = gate.blocking_recv();
            }
            Ok((Some("haiku".to_owned()), Some(json!({ "input_tokens": 3 }))))
        })
    }

    struct Harness {
        // Held for its `Drop`: the state and telemetry files live here.
        _fixture: Fixture,
        core: Arc<AnchorCore>,
        host: Arc<NativeAnchorHost>,
        bus: Bus,
        probe: Arc<Probe>,
        clock: Arc<AtomicI64>,
        runtime: tokio::runtime::Runtime,
    }

    impl Harness {
        fn new() -> Self {
            let fixture = Fixture::new("host");
            let bus = Bus::new();
            let core = Arc::new(AnchorCore {
                anchor: Arc::new(Mutex::new(window_anchor::Service::default())),
                bus: bus.clone(),
                state_path: fixture.path("state/window-anchor.json"),
                telemetry_path: fixture.path("usage/window-anchor-runs.jsonl"),
            });
            let runtime = tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()
                .unwrap();
            let clock = Arc::new(AtomicI64::new(NOW));
            let probe = Arc::new(Probe::default());
            let clock_seam: Arc<dyn Fn() -> i64 + Send + Sync> = {
                let clock = clock.clone();
                Arc::new(move || clock.load(Ordering::SeqCst))
            };
            let host = NativeAnchorHost::new(
                core.clone(),
                runtime.handle().clone(),
                refresh_seam(&probe),
                runner_seam(&probe),
                clock_seam,
            );
            *probe.host.lock().unwrap() = Some(Arc::downgrade(&host));
            host.subscribe_usage();
            let init = submit(
                &core,
                "window_anchor_init",
                &json!({
                    "state_path": core.state_path.to_string_lossy(),
                    "telemetry_path": core.telemetry_path.to_string_lossy(),
                    "window_anchor_env": "claude,codex",
                    "now_ms": NOW,
                }),
            );
            let host_seam: Arc<dyn AnchorHost> = host.clone();
            apply(&core, &host_seam, &init["effects"], true);
            Self {
                _fixture: fixture,
                core,
                host,
                bus,
                probe,
                clock,
                runtime,
            }
        }

        fn set_now(&self, value: i64) {
            self.clock.store(value, Ordering::SeqCst);
        }

        fn now(&self) -> i64 {
            self.clock.load(Ordering::SeqCst)
        }

        fn snapshot(&self) -> Value {
            submit(
                &self.core,
                "window_anchor_snapshot",
                &json!({ "now_ms": self.now() }),
            )["snapshot"]
                .clone()
        }

        fn generation(&self, provider: &str) -> Option<i64> {
            self.host
                .armed
                .lock()
                .unwrap()
                .get(provider)
                .map(|(generation, _)| *generation)
        }

        /// `arm_timer`'s host half for the deadline the policy just armed, moved
        /// a few milliseconds out. Node's fake `setTimeout` does the same: the
        /// policy's fixed 5s anchor delay would otherwise make every firing test
        /// wait five real seconds.
        fn fire_soon(&self, provider: &str, in_ms: i64) {
            let generation = self.generation(provider).expect("an armed timer");
            let effect = json!({
                "type": "arm_timer",
                "provider": provider,
                "generation": generation,
                "fire_at_ms": self.now() + in_ms,
            });
            self.host.schedule(&effect);
        }

        /// Emits inside the runtime, so fire-and-forget work has a blocking pool.
        fn emit_usage(&self, document: Value) {
            let bus = self.bus.clone();
            self.runtime.block_on(async move {
                bus.emit(&BusEvent::Usage(document));
            });
        }

        fn blocked<T: Send + 'static>(
            &self,
            task: impl FnOnce(Arc<NativeAnchorHost>) -> T + Send + 'static,
        ) -> T {
            let host = self.host.clone();
            self.runtime.block_on(async move {
                tokio::task::spawn_blocking(move || task(host))
                    .await
                    .unwrap()
            })
        }

        fn telemetry(&self) -> String {
            std::fs::read_to_string(&self.core.telemetry_path).unwrap_or_default()
        }

        fn state(&self) -> String {
            std::fs::read_to_string(&self.core.state_path).unwrap_or_default()
        }
    }

    /// `tokio` has no `test-util` here, so waits are real but bounded.
    fn wait_until(label: &str, condition: impl Fn() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(2);
        while !condition() {
            assert!(Instant::now() < deadline, "timed out waiting for {label}");
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    #[test]
    fn timer_fired_preflights_with_the_provider_marked_and_records_the_admitted_action() {
        let harness = Harness::new();
        let reset = NOW + 600_000;
        harness.emit_usage(usage("claude", true, reset, 0.0));
        assert_eq!(
            harness.snapshot()["claude"]["nextAnchorAt"],
            json!(reset + 5_000)
        );

        // Fire the armed deadline a few milliseconds out.
        harness.fire_soon("claude", 20);
        // preflighting_seen is pushed after refreshes, so wait on it.
        wait_until("the forced preflight", || {
            !harness.probe.preflighting_seen.lock().unwrap().is_empty()
        });
        assert_eq!(
            harness.probe.refreshes.lock().unwrap().as_slice(),
            ["claude"]
        );
        assert_eq!(
            harness.probe.preflighting_seen.lock().unwrap()[0],
            vec!["claude".to_owned()],
            "the refresh runs with the provider marked as preflighting"
        );

        wait_until("the admitted action", || {
            !harness.probe.actions.lock().unwrap().is_empty()
        });
        wait_until("the action telemetry", || {
            harness.telemetry().contains("\"result\":\"Ok\"")
        });
        assert_eq!(harness.probe.actions.lock().unwrap().as_slice(), ["claude"]);
        assert_eq!(harness.snapshot()["claude"]["lastResult"], "Ok");
        assert!(harness.state().contains("\"lastResult\": \"Ok\""));
    }

    #[test]
    fn re_arming_aborts_the_earlier_timer_and_a_stale_generation_never_refreshes() {
        let harness = Harness::new();
        harness.emit_usage(usage("claude", true, NOW + 60_000, 0.0));
        let stale = harness.generation("claude").unwrap();
        harness.fire_soon("claude", 200);

        // Replace the deadline before the first timer can fire.
        harness.emit_usage(usage("claude", true, NOW + 600_000, 0.0));
        let current = harness.generation("claude").unwrap();
        assert_eq!(current, stale + 1);
        std::thread::sleep(Duration::from_millis(500));
        assert!(
            harness.probe.refreshes.lock().unwrap().is_empty(),
            "the replaced timer never fires"
        );

        harness.blocked(move |host| host.timer_fired("claude", stale));
        assert!(
            harness.probe.refreshes.lock().unwrap().is_empty(),
            "a stale generation ends before the preflight"
        );
        assert_eq!(
            harness.snapshot()["claude"]["nextAnchorAt"],
            json!(NOW + 605_000),
            "the stale firing leaves the current deadline alone"
        );
    }

    #[test]
    fn failed_preflight_refresh_admits_from_the_cached_expired_window() {
        let harness = Harness::new();
        harness.emit_usage(usage("claude", true, NOW + 100, 0.0));
        harness.probe.refresh_fails.store(true, Ordering::SeqCst);

        // Past the cached reset, so the cached window is an expired idle one.
        harness.set_now(NOW + 5_100);
        harness.fire_soon("claude", 20);
        wait_until("the failed preflight", || {
            !harness.probe.refreshes.lock().unwrap().is_empty()
        });
        wait_until("the action from the cached window", || {
            !harness.probe.actions.lock().unwrap().is_empty()
        });
        wait_until("the action telemetry", || {
            harness.telemetry().contains("\"result\":\"Ok\"")
        });
        assert_eq!(
            harness.probe.refreshes.lock().unwrap().as_slice(),
            ["claude"]
        );
    }

    #[test]
    fn usage_subscriber_arms_a_future_reset_and_auto_admits_an_expired_idle_window() {
        let harness = Harness::new();
        let reset = NOW + 600_000;
        harness.emit_usage(usage("claude", true, reset, 0.0));
        assert_eq!(
            harness.snapshot()["claude"]["nextAnchorAt"],
            json!(reset + 5_000)
        );
        assert_eq!(harness.generation("claude"), Some(1));

        harness.emit_usage(usage("claude", true, NOW - 60_000, 0.0));
        wait_until("the automatic action", || {
            !harness.probe.actions.lock().unwrap().is_empty()
        });
        assert!(
            harness.probe.refreshes.lock().unwrap().is_empty(),
            "an idle window admits without a preflight"
        );
        assert_eq!(harness.snapshot()["claude"]["nextAnchorAt"], Value::Null);
    }

    #[test]
    fn usage_during_a_preflight_does_not_double_admit() {
        let harness = Harness::new();
        let reset = NOW + 60_000;
        harness.emit_usage(usage("claude", true, reset, 0.0));
        let (release, gate) = tokio::sync::oneshot::channel();
        *harness.probe.refresh_gate.lock().unwrap() = Some(gate);

        harness.set_now(reset + 5_000 - 10);
        harness.fire_soon("claude", 20);
        wait_until("the gated preflight", || {
            !harness.probe.refreshes.lock().unwrap().is_empty()
        });
        wait_until("the preflighting marker", || {
            harness.host.preflighting() == vec!["claude".to_owned()]
        });

        harness.emit_usage(usage("claude", true, NOW - 60_000, 0.0));
        assert!(
            harness.probe.actions.lock().unwrap().is_empty(),
            "a usage event during the preflight does not admit"
        );

        release.send(()).unwrap();
        wait_until("the admitted action", || {
            !harness.probe.actions.lock().unwrap().is_empty()
        });
        assert_eq!(harness.probe.actions.lock().unwrap().len(), 1);
    }

    #[test]
    fn snapshot_submits_progress_while_the_action_runner_blocks() {
        let harness = Harness::new();
        let (release, gate) = tokio::sync::oneshot::channel();
        *harness.probe.action_gate.lock().unwrap() = Some(gate);

        harness.emit_usage(usage("claude", true, NOW - 60_000, 0.0));
        wait_until("the blocked runner", || {
            harness.probe.action_started.load(Ordering::SeqCst)
        });

        let core = harness.core.clone();
        let clock = harness.clock.clone();
        let response = harness.runtime.block_on(async move {
            tokio::time::timeout(
                Duration::from_secs(1),
                tokio::task::spawn_blocking(move || {
                    submit(
                        &core,
                        "window_anchor_snapshot",
                        &json!({ "now_ms": clock.load(Ordering::SeqCst) }),
                    )
                }),
            )
            .await
            .expect("the snapshot submit returns while the runner blocks")
            .unwrap()
        });
        assert_eq!(response["snapshot"]["claude"]["lastResult"], Value::Null);

        release.send(()).unwrap();
        wait_until("the action telemetry", || {
            harness.telemetry().contains("\"result\":\"Ok\"")
        });
    }

    #[test]
    fn fire_and_forget_actions_do_not_block_the_usage_listener() {
        let harness = Harness::new();
        let (release, gate) = tokio::sync::oneshot::channel();
        *harness.probe.action_gate.lock().unwrap() = Some(gate);

        let started = Instant::now();
        harness.emit_usage(usage("claude", true, NOW - 60_000, 0.0));
        assert!(
            started.elapsed() < Duration::from_secs(1),
            "the usage listener returns before the action completes"
        );
        wait_until("the blocked runner", || {
            harness.probe.action_started.load(Ordering::SeqCst)
        });
        assert!(
            harness.telemetry().is_empty(),
            "no action result lands while the runner is blocked"
        );

        release.send(()).unwrap();
        wait_until("the action telemetry", || {
            harness.telemetry().contains("\"result\":\"Ok\"")
        });
    }
}
