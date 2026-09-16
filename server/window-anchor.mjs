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
import { existsSync, readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { bus, writeAtomic, STATE_DIR } from './agents.mjs';
import { groupFor } from './model-store.mjs';
import { runOneShotPrompt } from './one-shot.mjs';

const execFileP = promisify(execFile);

const WINDOW_MS = 5 * 3.6e6;       // the plan window an anchor pins
const ANCHOR_DELAY_MS = 5000;      // fire just after the reset, like usage.mjs's reset refresh (+2000)
const POKE_TIMEOUT_MS = 90_000;
const MIN_POKE_GAP_MS = 60_000;    // an errored poke may be retried, but no faster than this

// Cheapest route per provider (model-store SEED aliases). The ids go through
// the model store, never hardcoded routing: an alias that moved to another
// group disables that provider's poke rather than misrouting it.
const CHEAP_MODELS = { claude: 'haiku', codex: 'gpt-5.6-luna' };
// Effort flags verified on this box: `claude --help` has --effort <level>;
// codex takes the config override -c model_reasoning_effort=low.
const EFFORT_ARGS = {
  claude: ['--effort', 'low'],
  codex: ['-c', 'model_reasoning_effort=low'],
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
let logger = null;
let stateFile = join(STATE_DIR, 'window-anchor.json');
let now = () => Date.now();
let spawn = execFileP;
let busRef = bus;
let usageHandler = null;

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

function clearTimer(group) {
  const cur = armed.get(group);
  if (cur) clearTimeout(cur.timer);
  armed.delete(group);
  state[group].nextAnchorAt = null;
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
  return state[group].lastResult !== 'Ok' && now() - last.at >= MIN_POKE_GAP_MS;
}

// Resolve the anchor model through the model store: null when the SEED alias
// moved to another group (repurposed id) — never poke a wrong-group model.
function anchorModel(group) {
  const id = CHEAP_MODELS[group];
  const g = groupFor(id);
  return g === null || g === group ? id : null;
}

async function poke(group, windowEnd) {
  const s = state[group];
  if (!shouldPoke(group, windowEnd)) return 'Skipped';
  lastAttempt.set(group, { window: windowEnd, at: now() });
  try {
    const modelId = anchorModel(group);
    if (!modelId) throw new Error(`no '${CHEAP_MODELS[group]}' model in the ${group} group`);
    await runOneShotPrompt(group, modelId, 'ok', { timeoutMs: POKE_TIMEOUT_MS, extraArgs: EFFORT_ARGS[group] ?? [], spawn });
    s.lastAnchorAt = now();
    s.lastResult = 'Ok';
    s.lastError = null;
  } catch (e) {
    s.lastResult = 'Error';
    s.lastError = String(e.message || e).slice(0, 200);
  }
  persistEmit();
  return s.lastResult;
}

function onUsage(result) {
  for (const group of PROVIDERS) {
    const s = state[group];
    if (!s.enabled) { clearTimer(group); continue; }
    const src = result?.[group];
    const session = src?.session;
    if (!src?.ok || !session) continue; // no window info yet
    // Codex reports a window that has not begun (usage.mjs strips its sliding
    // reset projection). There is no reset to arm against and none will appear
    // until a turn starts the window — which is the anchor's whole job, so
    // poke now. One poke per window span: lastAnchorAt is the previous poke and
    // expires with the window it started; passing it as the window identity
    // lets shouldPoke space out retries after an error without blocking the
    // next lapse.
    if (session.started === false) {
      clearTimer(group);
      if (!s.lastAnchorAt || now() - s.lastAnchorAt >= WINDOW_MS) void poke(group, s.lastAnchorAt ?? 0);
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
      void poke(group, resetsAt);
    }
  }
}

export function initWindowAnchor({ bus: b = bus, log, stateDir = STATE_DIR, spawn: spawnFn = execFileP, now: nowFn } = {}) {
  logger = log;
  busRef = b;
  stateFile = join(stateDir, 'window-anchor.json');
  spawn = spawnFn;
  now = nowFn ?? (() => Date.now());

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

// POST body { enabled: { claude, codex } } — partial update, persists.
export function setWindowAnchorEnabled(enabled = {}) {
  let changed = false;
  for (const group of PROVIDERS) {
    if (typeof enabled[group] !== 'boolean') continue;
    state[group].enabled = enabled[group];
    if (!enabled[group]) clearTimer(group);
    changed = true;
  }
  if (changed) persistEmit();
  return snapshot();
}

// Manual poke now — explicit user action, so it runs regardless of `enabled`
// and of the same-window guard (fresh window identity = now).
export async function pokeProvider(group) {
  if (!PROVIDERS.includes(group)) throw new Error(`provider must be 'claude' or 'codex'`);
  await poke(group, now());
  return { provider: group, result: state[group].lastResult };
}