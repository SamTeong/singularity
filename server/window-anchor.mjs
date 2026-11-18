// Transitional adapter: Rust owns window-anchor policy and snapshots. Node
// retains only the timer wakeups, usage subscription, and external effects.
import { join } from 'node:path';
import { bus, STATE_DIR } from './agents.mjs';
import { USAGE_SKILL_STATE } from './app-dir.mjs';
import { groupFor } from './model-store.mjs';
import { runOneShotPrompt, oneShotSpawn } from './one-shot.mjs';
import { getUsage } from './usage.mjs';

const PROVIDERS = ['claude', 'codex'];
const POKE_TIMEOUT_MS = 90_000;
const CHEAP_MODELS = { claude: 'haiku', codex: 'gpt-6-luna' };
const EFFORT_ARGS = {
  claude: ['--safe-mode', '--tools', '', '--system-prompt', 'Reply exactly: ok', '--effort', 'low'],
  codex: ['--ignore-user-config', '--ignore-rules', '--json', '-c', 'model_reasoning_effort=none'],
};

const armed = new Map();
const preflighting = new Set();
let logger = null;
let stateFile = join(STATE_DIR, 'window-anchor.json');
let telemetryFile = join(USAGE_SKILL_STATE, 'window-anchor-runs.jsonl');
let now = () => Date.now();
let setTimer = setTimeout;
let clearTimerHandle = clearTimeout;
let spawn = oneShotSpawn;
let refreshUsage = getUsage;
let busRef = bus;
let usageHandler = null;
let storage = null;
let effectQueue = Promise.resolve();
let nextTimerEvent = 0;

function warn(error, message, extra = {}) {
  logger?.warn({ err: error?.message ?? String(error), ...extra }, message);
}

function enqueueEffect(effect) {
  const savedStorage = storage;
  const savedStateFile = stateFile;
  const savedTelemetryFile = telemetryFile;
  const savedBus = busRef;
  const savedLogger = logger;
  effectQueue = effectQueue.then(async () => {
    if (effect.type === 'append_telemetry') {
      try { await savedStorage.windowAnchorTelemetry(savedTelemetryFile, effect.record); }
      catch (error) { savedLogger?.warn({ err: error?.message ?? String(error) }, 'window-anchor telemetry write failed'); }
    } else if (effect.type === 'save_state') {
      try { await savedStorage.windowAnchorSave(savedStateFile, effect.state); }
      catch (error) { savedLogger?.warn({ err: error?.message ?? String(error) }, 'window-anchor.json write failed'); }
    } else if (effect.type === 'emit_snapshot') {
      try { savedBus?.emit('window-anchor', effect.snapshot); }
      catch (error) { savedLogger?.warn({ err: error?.message ?? String(error) }, 'window-anchor event emit failed'); }
    }
  }).catch((error) => savedLogger?.warn({ err: error?.message ?? String(error) }, 'window-anchor effect queue failed'));
  return effectQueue;
}

function timerEffect(effect) {
  const current = armed.get(effect.provider);
  if (current) clearTimerHandle(current.handle);
  armed.delete(effect.provider);
  const delay = Math.max(0, effect.fire_at_ms - now());
  const handle = setTimer(() => timerFired(effect.provider, effect.generation), delay);
  armed.set(effect.provider, { handle, generation: effect.generation });
}

async function actionResult(effect, result) {
  const fields = {
    action_id: effect.action_id,
    provider: effect.provider,
    outcome: result.error ? 'error' : 'ok',
    now_ms: now(),
    started_at_ms: result.startedAt,
    ended_at_ms: now(),
    model: result.model,
    usage: result.usage ?? null,
    ...(result.error ? { error: result.error } : {}),
  };
  const response = await storage.windowAnchorRequest('window_anchor_action_result', fields);
  await applyEffects(response.effects ?? [], true);
  return response.snapshot;
}

async function runAction(effect) {
  const startedAt = now();
  let model = null;
  let usage = null;
  let failure = null;
  try {
    const candidate = CHEAP_MODELS[effect.provider];
    const routedGroup = await groupFor(candidate);
    if (!candidate || (routedGroup !== null && routedGroup !== effect.provider)) {
      model = null;
      throw new Error(`no '${candidate}' model in the ${effect.provider} group`);
    }
    model = candidate;
    const result = await runOneShotPrompt(effect.provider, model, 'ok', {
      timeoutMs: POKE_TIMEOUT_MS,
      extraArgs: EFFORT_ARGS[effect.provider] ?? [],
      spawn,
      includeMetadata: true,
    });
    usage = result.usage;
  } catch (error) {
    failure = String(error?.message || error).slice(0, 200);
  }
  return actionResult(effect, { startedAt, endedAt: now(), model, usage, error: failure });
}

async function applyEffects(effects, awaitActions = false) {
  const pending = [];
  for (const effect of effects) {
    switch (effect.type) {
      case 'arm_timer':
        timerEffect(effect);
        break;
      case 'clear_timer': {
        const current = armed.get(effect.provider);
        if (current) clearTimerHandle(current.handle);
        armed.delete(effect.provider);
        break;
      }
      case 'append_telemetry':
      case 'save_state':
      case 'emit_snapshot':
        pending.push(enqueueEffect(effect));
        break;
      case 'run_action': {
        const action = runAction(effect);
        if (awaitActions) pending.push(action);
        else void action.catch((error) => warn(error, 'window-anchor action completion failed', { provider: effect.provider }));
        break;
      }
      default:
        warn(new Error(`unknown window-anchor effect '${effect.type}'`), 'window-anchor effect ignored');
    }
  }
  if (pending.length) await Promise.all(pending);
}

async function submit(op, fields, awaitEffects = false) {
  const response = await storage.windowAnchorRequest(op, fields);
  for (const message of response.warnings ?? []) warn(new Error(message), 'window-anchor initialization warning');
  await applyEffects(response.effects ?? [], awaitEffects);
  return response;
}

async function timerFired(provider, generation) {
  const eventId = `window-anchor-timer-${++nextTimerEvent}`;
  const timer = armed.get(provider);
  if (timer?.generation === generation) armed.delete(provider);
  let response;
  try {
    response = await submit('window_anchor_timer_fired', {
      provider, generation, timer_event_id: eventId, now_ms: now(),
    });
  } catch (error) {
    warn(error, 'window-anchor timer firing failed', { provider });
    return;
  }
  if (response.result !== 'preflight_required') return;

  let usageRefresh = 'ok';
  let usage;
  preflighting.add(provider);
  try { usage = await refreshUsage({ force: true, sources: [provider] }); }
  catch (error) {
    usageRefresh = 'failed';
    warn(error, 'window-anchor preflight refresh failed', { provider });
  } finally { preflighting.delete(provider); }
  try {
    await submit('window_anchor_timer_admit', {
      provider, generation, timer_event_id: eventId, usage_refresh: usageRefresh,
      ...(usageRefresh === 'ok' ? { usage } : {}), now_ms: now(),
    });
  } catch (error) { warn(error, 'window-anchor timer admission failed', { provider }); }
}

function onUsage(usage) {
  const fields = {
    usage,
    authoritative: true,
    preflighting: [...preflighting],
    now_ms: now(),
  };
  void submit('window_anchor_usage', fields).catch((error) => warn(error, 'window-anchor usage update failed'));
}

export async function initWindowAnchor({
  bus: b = bus, log, stateDir = STATE_DIR, usageStateDir = USAGE_SKILL_STATE,
  storage: storageApi, spawn: spawnFn = oneShotSpawn, usageRefresh = getUsage, now: nowFn,
  setTimeout: setTimeoutFn = setTimeout, clearTimeout: clearTimeoutFn = clearTimeout,
  enabled = process.env.WINDOW_ANCHOR,
} = {}) {
  if (usageHandler) busRef.off('usage', usageHandler);
  for (const { handle } of armed.values()) clearTimerHandle(handle);
  armed.clear();
  logger = log;
  busRef = b;
  stateFile = join(stateDir, 'window-anchor.json');
  telemetryFile = join(usageStateDir, 'window-anchor-runs.jsonl');
  storage = storageApi;
  spawn = spawnFn;
  refreshUsage = usageRefresh;
  now = nowFn ?? (() => Date.now());
  setTimer = setTimeoutFn;
  clearTimerHandle = clearTimeoutFn;
  preflighting.clear();
  const response = await submit('window_anchor_init', {
    state_path: stateFile,
    telemetry_path: telemetryFile,
    window_anchor_env: String(enabled ?? ''),
    now_ms: now(),
  }, true);
  usageHandler = onUsage;
  b.on('usage', usageHandler);
  return response.snapshot;
}

export async function snapshotWindowAnchor() {
  const response = await storage.windowAnchorRequest('window_anchor_snapshot', { now_ms: now() });
  return response.snapshot;
}

export async function pokeProvider(provider, { force = false } = {}) {
  if (!PROVIDERS.includes(provider)) throw new Error(`provider must be 'claude' or 'codex'`);
  const startedAt = now();
  let usageRefresh = 'not_requested';
  let usage;
  if (!force) {
    usageRefresh = 'ok';
    preflighting.add(provider);
    try { usage = await refreshUsage({ force: true, sources: [provider] }); }
    catch (error) {
      usageRefresh = 'failed';
      warn(error, 'window-anchor preflight refresh failed', { provider });
    } finally { preflighting.delete(provider); }
  }
  const response = await submit('window_anchor_poke', {
    provider, force, usage_refresh: usageRefresh,
    ...(usageRefresh === 'ok' ? { usage } : {}),
    started_at_ms: startedAt,
    now_ms: now(),
  }, true);
  const finalSnapshot = await snapshotWindowAnchor();
  return { provider, result: finalSnapshot[provider]?.lastResult ?? response.result?.result };
}
