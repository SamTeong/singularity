// Window anchor: keeps Claude/Codex 5h plan windows pinned to their reset time.
// A subscription window starts on the FIRST prompt after the previous one
// expires, so an idle user wastes wall-clock — the new window only begins when
// real work does. When a window's resetsAt passes and no real work has anchored
// the next one (pctUsed === 0), fire ONE trivial headless prompt on the
// cheapest model, pinning the new window to reset time (~negligible cost: one
// tiny turn per 5h per provider).
//
// Driven by 'usage' broadcasts from usage.mjs on the shared agents bus (same
// bus pty-ws fans out). State persists to STATE_DIR/window-anchor.json and is
// emitted on the bus as 'window-anchor' after every mutation (crons.mjs
// pattern). Never pokes twice for the same window.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { bus, writeAtomic, STATE_DIR } from './agents.mjs';
import { USAGE_SKILL_STATE } from './app-dir.mjs';
import { groupFor } from './model-store.mjs';
import { runOneShotPrompt } from './one-shot.mjs';
import { getUsage } from './usage.mjs';

const execFileP = promisify(execFile);

const WINDOW_MS = 5 * 3.6e6;       // the plan window an anchor pins
const ANCHOR_DELAY_MS = 5000;      // fire just after the reset, like usage.mjs's reset refresh (+2000)
const POKE_TIMEOUT_MS = 90_000;
const MIN_POKE_GAP_MS = 60_000;    // an errored poke may be retried, but no faster than this
const TELEMETRY_MAX_RECORDS = 1000;

// Cheapest route per provider (model-store SEED aliases). The ids go through
// the model store, never hardcoded routing: an alias that moved to another
// group disables that provider's poke rather than misrouting it.
const CHEAP_MODELS = { claude: 'haiku', codex: 'gpt-5.6-luna' };
// Anchor runs need no repository context or tools. Keep the authenticated CLI
// plumbing while stripping customizations/configuration and reasoning tokens.
const EFFORT_ARGS = {
  claude: ['--safe-mode', '--tools', '', '--system-prompt', 'Reply exactly: ok', '--effort', 'low'],
  codex: ['--ignore-user-config', '--ignore-rules', '--json', '-c', 'model_reasoning_effort=none'],
};
const PROVIDERS = ['claude', 'codex'];

// lastResult is display copy as well as a predicate — the UI prints it verbatim
// rather than case-mapping it, so it is capitalised at the source. A file written
// by an older build carries the lowercase spelling; normalise it on load or the
// first shouldPoke after an upgrade reads a successful anchor as a failed one.
const capitalize = (v) => (v ? v[0].toUpperCase() + v.slice(1) : v);

const defaultProviderState = () => ({
  enabled: false, nextAnchorAt: null, lastAnchorAt: null, lastResult: null, lastError: null,
});

const state = { claude: defaultProviderState(), codex: defaultProviderState() };
const armed = new Map();       // provider -> { timer, resetsAt } (in-memory only)
const lastAttempt = new Map(); // provider -> { window: resetsAtMs, at: epochMs }
const preflighting = new Set();
let logger = null;
let stateFile = join(STATE_DIR, 'window-anchor.json');
let telemetryFile = join(USAGE_SKILL_STATE, 'window-anchor-runs.jsonl');
let now = () => Date.now();
let spawn = execFileP;
let refreshUsage = getUsage;
let busRef = bus;
let usageHandler = null;
let latestUsage = null;

function snapshot() {
  return { claude: { ...state.claude }, codex: { ...state.codex } };
}

function persist() {
  try {
    writeAtomic(stateFile, JSON.stringify(state, null, 2));
  } catch (e) {
    logger?.warn({ err: e.message }, 'window-anchor.json write failed');
  }
}

function persistEmit() { persist(); busRef?.emit('window-anchor', snapshot()); }

function appendTelemetry(record) {
  try {
    mkdirSync(dirname(telemetryFile), { recursive: true });
    appendFileSync(telemetryFile, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    const lines = readFileSync(telemetryFile, 'utf8').trimEnd().split(/\r?\n/);
    if (lines.length > TELEMETRY_MAX_RECORDS) {
      writeAtomic(telemetryFile, `${lines.slice(-TELEMETRY_MAX_RECORDS).join('\n')}\n`);
    }
  } catch (e) {
    logger?.warn({ err: e.message }, 'window-anchor telemetry write failed');
  }
}

function clearTimer(group) {
  const cur = armed.get(group);
  const changed = !!cur || state[group].nextAnchorAt != null;
  if (cur) clearTimeout(cur.timer);
  armed.delete(group);
  state[group].nextAnchorAt = null;
  return changed;
}

// (Re)arm the anchor timer for a window ending at resetsAt. Dedupe: a timer
// already targeting the same resetsAt is left alone. Returns true when a timer
// was (re)armed — callers emit/persist only on change.
function arm(group, resetsAt) {
  const cur = armed.get(group);
  if (cur && cur.resetsAt === resetsAt) return false;
  if (cur) clearTimeout(cur.timer);
  const timer = setTimeout(() => {
    armed.delete(group);
    state[group].nextAnchorAt = null;
    void poke(group, resetsAt);
  }, resetsAt + ANCHOR_DELAY_MS - now());
  state[group].nextAnchorAt = resetsAt + ANCHOR_DELAY_MS;
  armed.set(group, { timer, resetsAt });
  return true;
}

// A successful poke for window X anchors it for good; an errored one may be
// retried on a later usage update, but no faster than MIN_POKE_GAP_MS.
function shouldPoke(group, windowEnd) {
  const last = lastAttempt.get(group);
  if (!last || last.window !== windowEnd) return true;
  const gap = state[group].lastResult === 'Ok' ? WINDOW_MS : MIN_POKE_GAP_MS;
  return now() - last.at >= gap;
}

// Resolve the anchor model through the model store: null when the SEED alias
// moved to another group (repurposed id) — never poke a wrong-group model.
function anchorModel(group) {
  const id = CHEAP_MODELS[group];
  const g = groupFor(id);
  return g === null || g === group ? id : null;
}

function hasActiveWindow(group) {
  const src = latestUsage?.[group];
  const session = src?.session;
  if (!src?.ok || !session || session.started === false || !session.resetsAt) return false;
  const resetsAt = new Date(session.resetsAt).getTime();
  return Number.isFinite(resetsAt) && resetsAt > now();
}

async function poke(group, windowEnd, { trigger = 'automatic', force = false, preflight = true } = {}) {
  const s = state[group];
  const startedAt = now();
  if (!force && preflight) {
    preflighting.add(group);
    try { await refreshUsage({ force: true, sources: [group] }); }
    catch (e) { logger?.warn({ err: e.message, provider: group }, 'window-anchor preflight refresh failed'); }
    finally { preflighting.delete(group); }
  }
  if (!force && hasActiveWindow(group)) {
    s.lastResult = 'Skipped';
    s.lastError = null;
    appendTelemetry({
      started_at: new Date(startedAt).toISOString(), finished_at: new Date(now()).toISOString(),
      provider: group, trigger, window_end: new Date(windowEnd).toISOString(),
      result: 'Skipped', reason: 'window-already-started', model: null, usage: null,
    });
    persistEmit();
    return s.lastResult;
  }
  if (!shouldPoke(group, windowEnd)) return 'Skipped';
  lastAttempt.set(group, { window: windowEnd, at: now() });
  let modelId = null;
  let usage = null;
  try {
    modelId = anchorModel(group);
    if (!modelId) throw new Error(`no '${CHEAP_MODELS[group]}' model in the ${group} group`);
    const result = await runOneShotPrompt(group, modelId, 'ok', {
      timeoutMs: POKE_TIMEOUT_MS, extraArgs: EFFORT_ARGS[group] ?? [], spawn, includeMetadata: true,
    });
    usage = result.usage;
    s.lastAnchorAt = now();
    s.lastResult = 'Ok';
    s.lastError = null;
  } catch (e) {
    s.lastResult = 'Error';
    s.lastError = String(e.message || e).slice(0, 200);
  }
  appendTelemetry({
    started_at: new Date(startedAt).toISOString(), finished_at: new Date(now()).toISOString(),
    provider: group, trigger, window_end: new Date(windowEnd).toISOString(),
    result: s.lastResult, reason: null, model: modelId, usage,
    ...(s.lastError ? { error: s.lastError } : {}),
  });
  persistEmit();
  return s.lastResult;
}

function onUsage(result, forceUnstarted = null) {
  latestUsage = result;
  for (const group of PROVIDERS) {
    const s = state[group];
    if (!s.enabled) { clearTimer(group); continue; }
    const src = result?.[group];
    const session = src?.session;
    if (!src?.ok) continue; // no authoritative window info yet
    if (!session) {
      // A successful usage read with no 5h window means this account has
      // nothing to anchor (for example Claude API billing). Keep the user's
      // preference, but retire any schedule learned from an older plan/window.
      if (clearTimer(group)) persistEmit();
      continue;
    }
    // Codex reports a window that has not begun (usage.mjs strips its sliding
    // reset projection). There is no reset to arm against and none will appear
    // until a turn starts the window — which is the anchor's whole job, so
    // poke now. One poke per window span: lastAnchorAt is the previous poke and
    // expires with the window it started; passing it as the window identity
    // lets shouldPoke space out retries after an error without blocking the
    // next lapse. A fresh false->true enable is an explicit retry even when a
    // prior command exited successfully without opening the provider window.
    if (session.started === false) {
      clearTimer(group);
      if (preflighting.has(group)) continue;
      const forced = forceUnstarted?.has(group);
      if (forced || !s.lastAnchorAt || now() - s.lastAnchorAt >= WINDOW_MS) {
        void poke(group, forced ? now() : (s.lastAnchorAt ?? 0), { preflight: false });
      }
      continue;
    }
    if (!session.resetsAt) continue;
    const resetsAt = new Date(session.resetsAt).getTime();
    if (!Number.isFinite(resetsAt)) continue;
    if (resetsAt > now()) {
      if (arm(group, resetsAt)) persistEmit();
    } else if ((session.pctUsed ?? 0) > 0) {
      // Real work already anchored the next window — stand down until the
      // following reset.
      clearTimer(group);
      if (s.lastResult !== 'Skipped') {
        s.lastResult = 'Skipped';
        s.lastError = null;
        persistEmit();
      }
    } else {
      // Expired and idle: poke now.
      clearTimer(group);
      if (!preflighting.has(group)) void poke(group, resetsAt, { preflight: false });
    }
  }
}

export function initWindowAnchor({
  bus: b = bus, log, stateDir = STATE_DIR, usageStateDir = USAGE_SKILL_STATE,
  spawn: spawnFn = execFileP, usageRefresh = getUsage, now: nowFn,
} = {}) {
  logger = log;
  busRef = b;
  stateFile = join(stateDir, 'window-anchor.json');
  telemetryFile = join(usageStateDir, 'window-anchor-runs.jsonl');
  spawn = spawnFn;
  refreshUsage = usageRefresh;
  now = nowFn ?? (() => Date.now());
  latestUsage = null;

  // Re-init (tests): drop the previous subscription and any armed timers first.
  if (usageHandler) b.off('usage', usageHandler);
  for (const group of PROVIDERS) clearTimer(group);

  try {
    if (existsSync(stateFile)) {
      const data = JSON.parse(readFileSync(stateFile, 'utf8'));
      for (const group of PROVIDERS) {
        if (data[group] && typeof data[group] === 'object') state[group] = { ...defaultProviderState(), ...data[group], lastResult: capitalize(data[group].lastResult) };
      }
      log?.info({ file: stateFile }, 'loaded window-anchor.json');
    }
  } catch (e) { log?.warn({ err: e.message }, 'window-anchor.json load failed'); }

  usageHandler = (result) => onUsage(result);
  b.on('usage', usageHandler);
  return snapshot();
}

export function snapshotWindowAnchor() { return snapshot(); }

// POST body { enabled: { claude, codex } } — partial update, persists, then
// immediately applies the latest usage snapshot for newly-enabled providers.
export function setWindowAnchorEnabled(enabled = {}) {
  let changed = false;
  const newlyEnabled = new Set();
  for (const group of PROVIDERS) {
    if (typeof enabled[group] !== 'boolean') continue;
    if (enabled[group] && !state[group].enabled) newlyEnabled.add(group);
    state[group].enabled = enabled[group];
    if (!enabled[group]) clearTimer(group);
    changed = true;
  }
  if (changed) {
    persistEmit();
    if (latestUsage && newlyEnabled.size) onUsage(latestUsage, newlyEnabled);
  }
  return snapshot();
}

// Manual poke now. It runs regardless of `enabled`, but avoids spending a turn
// on an already-started window unless the caller explicitly requests force.
export async function pokeProvider(group, { force = false } = {}) {
  if (!PROVIDERS.includes(group)) throw new Error(`provider must be 'claude' or 'codex'`);
  await poke(group, now(), { trigger: 'manual', force });
  return { provider: group, result: state[group].lastResult };
}
