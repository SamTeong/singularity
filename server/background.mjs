// Background tasks: quota-soak agent runs during working hours. A minute-
// resolution tick, when due by tickMinutes and inside the configured window,
// gates on live 5h/7d usage (Claude first, else Ollama), picks the oldest
// off-cooldown def round-robin, and spawns it as a normal Tasks-board card
// tagged 'background' with an unattended prompt + a deny rule barring writes to
// C:\git\singularity. A watchdog re-polls usage while a run is live and injects
// a wrap-up (then hard-kills after a grace) when the budget is spent.
//
// State: STATE_DIR/background.json (atomic tmp+rename, like crons). Emits
// 'background' on the shared agents bus; pty-ws fans it out. Pure gate/pick/
// window/watchdog functions are exported for unit tests (no side effects).
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import * as reg from './agents.mjs';
import { createTask, updateTask, snapshotTasks } from './tasks.mjs';
import { getUsage } from './usage.mjs';
import { parseSession } from './stats.mjs';
import { isClaudeModel } from './models.mjs';

const BACKGROUND_FILE = join(reg.STATE_DIR, 'background.json');
const TICK_MS = 60_000; // minute-resolution timer; logic fires when due by tickMinutes
const WATCHDOG_MS = 120_000;
const KILL_GRACE_MS = 5 * 60_000;
const WRAPUP = 'Usage budget reached — stop working now, write Report.md with current progress + remaining steps, move the card to inreview, then stop.';
// Agent may write anywhere EXCEPT the singularity checkout (deny rules + prompt
// ban). Merged into the same --settings JSON as the statusline in tasks.mjs.
const DENY = { permissions: { deny: ['Edit(C://git//singularity/**)', 'Write(C://git//singularity/**)'] } };

const DEFAULT_CONFIG = {
  enabled: false,
  window: { startHour: 9, endHour: 18, days: [1, 2, 3, 4, 5] },
  tickMinutes: 60,
  thresholds: {
    claude: { start: 50, stop: 75, weeklyMax: 75 },
    ollama: { start: 50, stop: 75, weeklyMax: 75 },
  },
  models: { claude: 'opus', ollama: 'glm-5.2:cloud' },
  tokenCaps: { claude: 15_000_000, ollama: 2_000_000 },
  defs: [],
};

let config = structuredClone(DEFAULT_CONFIG);
let lastTick = null; // { at, action:'ran'|'skipped', reason }
let logger = null;
let lastDueAt = 0; // when the tick logic last ran (minute-resolution gating)
let injectedTaskId = null; // watchdog: wrap-up injected for this bg task (once)

// ---- Pure functions (exported, unit-tested) ------------------------------------

// Daemon-local: is `date` a configured weekday within [startHour, endHour)?
export function inWindow(cfg, date) {
  const { startHour, endHour, days } = cfg.window;
  const h = date.getHours();
  return days.includes(date.getDay()) && h >= startHour && h < endHour;
}

// Why a backend's gate fails, or null when it passes. A source with ok:false
// (or missing/incomplete usage) fails closed.
function gateReason(u, th, name) {
  if (!u || !u.ok) return `${name} usage unavailable`;
  const sess = u.session?.pctUsed, wk = u.weekly?.pctUsed;
  if (sess == null || wk == null) return `${name} usage incomplete`;
  if (sess >= th.start) return `${name} 5h ${sess}% >= ${th.start}%`;
  if (wk >= th.weeklyMax) return `${name} 7d ${wk}% >= ${th.weeklyMax}%`;
  return null;
}

// Claude first, then Ollama. Each source fails only its own gate (fail closed).
export function evalGate(usage, cfg) {
  const reasons = [];
  for (const backend of ['claude', 'ollama']) {
    const r = gateReason(usage?.[backend], cfg.thresholds[backend], backend);
    if (r == null) return { backend, reason: `${backend} within budget` };
    reasons.push(r);
  }
  return { backend: null, reason: reasons.join('; ') };
}

// Oldest off-cooldown enabled def (null lastRunAt = oldest), or null.
export function pickDef(cfg, now) {
  const ready = (cfg.defs || []).filter((d) =>
    d.enabled && (d.lastRunAt == null || now - d.lastRunAt > d.cooldownHours * 3_600_000));
  ready.sort((a, b) => (a.lastRunAt ?? -Infinity) - (b.lastRunAt ?? -Infinity));
  return ready[0] || null;
}

// Should a live run stop? Fail closed on unavailable usage.
export function watchdogDecision(usage, backend, cfg, tokens) {
  const u = usage?.[backend];
  const th = cfg.thresholds[backend];
  if (!u || !u.ok) return 'stop';
  if ((u.session?.pctUsed ?? 0) >= th.stop) return 'stop';
  if ((u.weekly?.pctUsed ?? 0) >= th.weeklyMax) return 'stop';
  if (tokens >= cfg.tokenCaps[backend]) return 'stop';
  return 'continue';
}

// ---- State + bus ----------------------------------------------------------------

function persist() {
  try {
    writeFileSync(BACKGROUND_FILE + '.tmp', JSON.stringify(config, null, 2));
    renameSync(BACKGROUND_FILE + '.tmp', BACKGROUND_FILE); // atomic swap
  } catch (e) { logger?.warn({ err: e.message }, 'background.json write failed'); }
}

function emit() { reg.bus.emit('background', snapshotBackground()); }

// Single-flight: the one live background-tagged card not yet done, or null.
function liveBgTask() {
  return snapshotTasks().tasks.find((t) => (t.tags || []).includes('background') && t.column !== 'done') || null;
}

export function snapshotBackground() {
  const live = liveBgTask();
  return { config, lastTick, liveTaskId: live ? live.id : null };
}

// ---- Scheduler ------------------------------------------------------------------

// Shared "go" path for the tick and manual run. Returns the created task, or
// throws (manual) / records a skip (tick) with a human reason when refused.
async function attemptRun({ bypassWindow, bypassGate, manual }) {
  const now = Date.now();
  const refuse = (reason) => {
    if (manual) throw new Error(reason);
    lastTick = { at: now, action: 'skipped', reason };
    emit();
    return null;
  };
  if (!manual && !config.enabled) return refuse('disabled');
  if (!bypassWindow && !inWindow(config, new Date(now))) return refuse('outside window');
  if (liveBgTask()) return refuse('a background run is already live');

  let backend;
  if (bypassGate) backend = 'claude'; // forced run: no gate, default to claude budget/model
  else {
    const gate = evalGate(await getUsage(), config);
    if (!gate.backend) return refuse(gate.reason);
    backend = gate.backend;
  }

  const def = pickDef(config, now);
  if (!def) return refuse('no def ready');

  const model = def.model || config.models[backend];
  const task = createTask({
    repo: def.cwd, title: def.title, description: def.description, model,
    tags: ['background'], background: true, permissionSettings: DENY,
  });
  def.lastRunAt = now;
  def.lastTaskId = task.id;
  persist();
  lastTick = { at: Date.now(), action: 'ran', reason: `${def.title} → ${backend}/${model}` };
  emit();
  return task;
}

function tick() {
  const now = Date.now();
  if (now - lastDueAt < config.tickMinutes * 60_000) return;
  lastDueAt = now;
  attemptRun({ bypassWindow: false, bypassGate: false, manual: false })
    .catch((e) => logger?.warn({ err: e.message }, 'background tick failed'));
}

// Watchdog: only acts while a bg run is live. Injects the wrap-up once, then
// hard-kills after the grace if the session is still alive.
async function watchdog() {
  const task = liveBgTask();
  if (!task) { injectedTaskId = null; return; }
  if (injectedTaskId === task.id) return; // already wrapping up this run
  let usage, tokens;
  try {
    usage = await getUsage();
    tokens = parseSession(task.worktree || task.repo, task.sessionId).tokens;
  } catch (e) { logger?.warn({ err: e.message }, 'background watchdog poll failed'); return; }
  const backend = isClaudeModel(task.model) ? 'claude' : 'ollama';
  if (watchdogDecision(usage, backend, config, tokens) !== 'stop') return;

  injectedTaskId = task.id;
  reg.input(task.sessionId, '\r' + WRAPUP + '\r');
  setTimeout(() => {
    if (reg.isLive(task.sessionId)) {
      reg.kill(task.sessionId);
      try { updateTask(task.id, { column: 'inreview', state: 'stopped — budget' }); }
      catch (e) { logger?.warn({ err: e.message }, 'background watchdog updateTask failed'); }
    }
  }, KILL_GRACE_MS).unref();
}

export function initBackground(log) {
  logger = log;
  try {
    if (existsSync(BACKGROUND_FILE)) {
      const loaded = JSON.parse(readFileSync(BACKGROUND_FILE, 'utf8'));
      config = { ...structuredClone(DEFAULT_CONFIG), ...loaded }; // fill any keys added since last write
      log?.info({ defs: config.defs.length, enabled: config.enabled }, 'loaded background.json');
    } else {
      persist(); // materialize the shipped default so the file exists
    }
  } catch (e) { log?.warn({ err: e.message }, 'background.json load failed'); }
  lastDueAt = Date.now(); // wait one tickMinutes before the first run
  setInterval(tick, TICK_MS).unref();
  setInterval(() => { watchdog().catch(() => {}); }, WATCHDOG_MS).unref();
}

// ---- CRUD -----------------------------------------------------------------------

export function updateBackgroundConfig(partial) {
  const deep = new Set(['window', 'thresholds', 'models', 'tokenCaps']);
  for (const [k, v] of Object.entries(partial || {})) {
    if (deep.has(k) && v && typeof v === 'object') config[k] = { ...config[k], ...v };
    else config[k] = v;
  }
  persist();
  emit();
  return config;
}

export function createDef({ title, description, cwd, cooldownHours, model, enabled }) {
  if (!title?.trim() || !description?.trim() || !cwd?.trim()) throw new Error('title, description, cwd required');
  const def = {
    id: randomUUID(), title: title.trim(), description: description.trim(), cwd: cwd.trim(),
    cooldownHours: cooldownHours ?? 24, enabled: enabled !== false, model: model || null,
    lastRunAt: null, lastTaskId: null,
  };
  config.defs.push(def);
  persist();
  emit();
  return def;
}

export function updateDef(id, partial) {
  const def = config.defs.find((d) => d.id === id);
  if (!def) throw new Error('no such def');
  for (const k of ['title', 'description', 'cwd', 'cooldownHours', 'model', 'enabled', 'lastRunAt', 'lastTaskId']) {
    if (partial[k] !== undefined) def[k] = partial[k];
  }
  persist();
  emit();
  return def;
}

export function deleteDef(id) {
  const i = config.defs.findIndex((d) => d.id === id);
  if (i === -1) throw new Error('no such def');
  config.defs.splice(i, 1);
  persist();
  emit();
}

// Manual trigger: bypass the window (and, with force, the gate too). Still
// single-flight. Runs the tick "go" path or throws with a reason.
export async function runBackgroundNow({ force } = {}) {
  const task = await attemptRun({ bypassWindow: true, bypassGate: !!force, manual: true });
  return { taskId: task.id };
}
