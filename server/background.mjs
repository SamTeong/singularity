// Background tasks: quota-soak agent runs during working hours. A minute-
// resolution tick, when due by TICK_MINUTES and inside a def's own window,
// gates on live 5h/7d usage (Claude first, else Ollama) against that def's own
// thresholds, picks the oldest off-cooldown def round-robin, and spawns it as
// a normal Tasks-board card
// tagged 'background' with an unattended prompt. No write guard on the
// checkout is in effect (deny array empty, prompt ban removed). A watchdog
// re-polls usage while a run is live and injects
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
const TICK_MS = 60_000; // minute-resolution timer; logic fires when due by TICK_MINUTES
const TICK_MINUTES = 60; // fixed cadence — no per-install override
const WATCHDOG_MS = 120_000;
const KILL_GRACE_MS = 5 * 60_000;
const WRAPUP = 'Usage budget reached — stop working now, write Report.md with current progress + remaining steps, move the card to inreview, then stop.';
// No write guard on the singularity checkout is in effect: the settings deny
// array is intentionally empty, and the prompt-side ban was removed from
// tasks.mjs. Re-enable the hard guard by adding 'Edit(//c/git/singularity/**)'
// back here: Claude Code normalizes paths to POSIX (C:\git\singularity →
// /c/git/singularity) before matching, a leading // anchors to the filesystem
// root, and a single Edit(...) rule also covers Write/NotebookEdit (a separate
// Write(...) rule is accepted but never matched, and warns at startup).
// Merged into the same --settings JSON as the statusline in tasks.mjs.
// Residual risk: a background run can write freely to the singularity checkout
// (Edit or Bash echo>file) — no settings block, no prompt ban. Accepted.
const DENY = { permissions: { deny: [] } };

// Per-task defaults — every def merges over this on create, and legacy flat
// installs get seeded from their old top-level copy (see migrateLegacyConfig).
const DEFAULT_DEF = {
  window: { startHour: 9, endHour: 18, days: [1, 2, 3, 4, 5] },
  thresholds: {
    claude: { start: 50, stop: 75, weeklyMax: 50 },
    ollama: { start: 50, stop: 75, weeklyMax: 50 },
  },
  models: { claude: 'opus', ollama: 'glm-5.2:cloud' },
  tokenCaps: { claude: 15_000_000, ollama: 15_000_000 },
  scopes: [],
};

let config = { defs: [] };
let lastTick = null; // { at, action:'ran'|'skipped', reason }
let logger = null;
let lastDueAt = 0; // when the tick logic last ran (minute-resolution gating)
let injectedTaskId = null; // watchdog: wrap-up injected for this bg task (once)

// ---- Pure functions (exported, unit-tested) ------------------------------------

// Daemon-local: is `date` within this def's configured weekday+hour window?
export function inWindow(def, date) {
  const { startHour, endHour, days } = def.window;
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

// Claude first, then Ollama, against this def's own thresholds. Each source
// fails only its own gate (fail closed).
export function evalGate(usage, def) {
  const reasons = [];
  for (const backend of ['claude', 'ollama']) {
    const r = gateReason(usage?.[backend], def.thresholds[backend], backend);
    if (r == null) return { backend, reason: `${backend} within budget` };
    reasons.push(r);
  }
  return { backend: null, reason: reasons.join('; ') };
}

// Oldest off-cooldown enabled def (null lastRunAt = oldest), ignoring window and
// gate entirely — used only for a forced (bypassGate) manual run.
export function pickDef(defs, now) {
  const ready = (defs || []).filter((d) =>
    d.enabled && (d.lastRunAt == null || now - d.lastRunAt > d.cooldownHours * 3_600_000));
  ready.sort((a, b) => (a.lastRunAt ?? -Infinity) - (b.lastRunAt ?? -Infinity));
  return ready[0] || null;
}

// Def-first pass for the normal (non-forced) run path: candidates are enabled +
// off-cooldown + (in their own window, unless bypassWindow), oldest lastRunAt
// first. Returns the first candidate whose own gate passes as { def, backend,
// reason: null }, or { def: null, backend: null, reason } when none qualify —
// 'did not find eligible task to run' when there were no candidates at all, else the joined
// per-candidate gate reasons.
export function pickRunnableDef(defs, usage, now, { bypassWindow = false } = {}) {
  const ready = (defs || []).filter((d) =>
    d.enabled &&
    (d.lastRunAt == null || now - d.lastRunAt > d.cooldownHours * 3_600_000) &&
    (bypassWindow || inWindow(d, new Date(now))));
  ready.sort((a, b) => (a.lastRunAt ?? -Infinity) - (b.lastRunAt ?? -Infinity));
  if (ready.length === 0) return { def: null, backend: null, reason: 'did not find eligible task to run' };
  const reasons = [];
  for (const def of ready) {
    const gate = evalGate(usage, def);
    if (gate.backend) return { def, backend: gate.backend, reason: null };
    reasons.push(`${def.title}: ${gate.reason}`);
  }
  return { def: null, backend: null, reason: reasons.join('; ') };
}

// Should a live run stop? Fail closed on unavailable usage.
export function watchdogDecision(usage, backend, def, tokens) {
  const u = usage?.[backend];
  const th = def.thresholds[backend];
  if (!u || !u.ok) return 'stop';
  if ((u.session?.pctUsed ?? 0) >= th.stop) return 'stop';
  if ((u.weekly?.pctUsed ?? 0) >= th.weeklyMax) return 'stop';
  if (tokens >= def.tokenCaps[backend]) return 'stop';
  return 'continue';
}

// ---- State + bus ----------------------------------------------------------------

function persist() {
  try {
    writeFileSync(BACKGROUND_FILE + '.tmp', JSON.stringify(config, null, 2));
    renameSync(BACKGROUND_FILE + '.tmp', BACKGROUND_FILE); // atomic swap
  } catch (e) {
    logger?.warn({ err: e.message }, 'background.json write failed');
    const err = new Error(`background.json write failed: ${e.message}`);
    err.persistFailure = true; // flags a genuine disk write failure vs. a validation error — index.mjs routes surface it as 500
    throw err;
  }
}

function emit() { reg.bus.emit('background', snapshotBackground()); }

// Single-flight: the one actively-running background-tagged card, or null. Only
// todo/inprogress count as live — an inreview card has concluded (session dead,
// budget freed, awaiting a human) and must not block the next run.
function liveBgTask() {
  return snapshotTasks().tasks.find((t) =>
    (t.tags || []).includes('background') && (t.column === 'todo' || t.column === 'inprogress')) || null;
}

export function snapshotBackground() {
  const live = liveBgTask();
  return { config, lastTick, liveTaskId: live ? live.id : null, nextDueAt: lastDueAt + TICK_MINUTES * 60_000 };
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
  if (liveBgTask()) return refuse('a background run is already live');

  let def, backend;
  if (bypassGate) { // forced run: no gate, default to claude budget/model
    backend = 'claude';
    def = pickDef(config.defs, now);
    if (!def) return refuse('did not find eligible task to run');
  } else {
    const picked = pickRunnableDef(config.defs, await getUsage(), now, { bypassWindow });
    if (!picked.def) return refuse(picked.reason);
    ({ def, backend } = picked);
  }

  const model = def.models[backend];
  const task = createTask({
    repo: def.cwd, title: def.title, description: def.description, model,
    scopes: def.scopes, tags: ['background'], background: true, permissionSettings: DENY,
    conclude: def.conclude,
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
  if (now - lastDueAt < TICK_MINUTES * 60_000) return;
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
  let decision = 'stop'; // fail closed: a thrown poll (or a missing def) leaves the run unsupervised → stop
  try {
    const def = config.defs.find((d) => d.lastTaskId === task.id);
    const usage = await getUsage();
    const tokens = (await parseSession(task.worktree || task.repo, task.sessionId)).tokens;
    const backend = isClaudeModel(task.model) ? 'claude' : 'ollama';
    decision = def ? watchdogDecision(usage, backend, def, tokens) : 'stop';
  } catch (e) { logger?.warn({ err: e.message }, 'background watchdog poll failed — stopping run (fail closed)'); }
  if (decision !== 'stop') return;

  injectedTaskId = task.id;
  reg.input(task.sessionId, '\r' + WRAPUP + '\r');
  setTimeout(async () => {
    if (reg.isLive(task.sessionId)) {
      reg.kill(task.sessionId);
      try { await updateTask(task.id, { column: 'inreview', state: 'stopped — budget' }); }
      catch (e) { logger?.warn({ err: e.message }, 'background watchdog updateTask failed'); }
    }
  }, KILL_GRACE_MS).unref();
}

// Old flat shape stored window/thresholds/models/tokenCaps once at the top
// level, shared by every def. Seed those onto any def missing them; a def that
// already has its own copy (already migrated, or created post-refactor) is left
// untouched. Pure — exported so the migration test doesn't touch the filesystem.
export function migrateLegacyConfig(loaded) {
  const legacy = ['window', 'thresholds', 'models', 'tokenCaps'].filter((k) => loaded?.[k] != null);
  const defs = (loaded?.defs || []).map((d) => {
    if (legacy.length === 0) return d;
    const seeded = { ...d };
    for (const k of legacy) if (seeded[k] === undefined) seeded[k] = loaded[k];
    return seeded;
  });
  return { defs, migrated: legacy.length > 0 };
}

export function initBackground(log) {
  logger = log;
  try {
    if (existsSync(BACKGROUND_FILE)) {
      const loaded = JSON.parse(readFileSync(BACKGROUND_FILE, 'utf8'));
      const { defs, migrated } = migrateLegacyConfig(loaded);
      config = { defs };
      if (migrated) persist(); // rewrite state/background.json to the new {defs} shape
      log?.info({ defs: config.defs.length, migrated }, 'loaded background.json');
    } else {
      persist(); // materialize the shipped default so the file exists
    }
  } catch (e) { log?.warn({ err: e.message }, 'background.json load failed'); }
  lastDueAt = Date.now(); // wait one TICK_MINUTES before the first run
  setInterval(tick, TICK_MS).unref();
  setInterval(() => { watchdog().catch(() => {}); }, WATCHDOG_MS).unref();
}

// ---- CRUD -----------------------------------------------------------------------

// Per-def choice for how a run concludes: 'inreview' (default — a human reviews
// the report before the card reaches done) or 'done' (report is trusted enough
// to auto-conclude). The watchdog's budget-kill path always forces 'inreview'
// regardless of this setting (see watchdog() above).
const CONCLUDE_VALUES = ['inreview', 'done'];

export function createDef({ title, description, cwd, cooldownHours, enabled, window, thresholds, models, tokenCaps, scopes, conclude }) {
  if (!title?.trim() || !description?.trim() || !cwd?.trim()) throw new Error('title, description, cwd required');
  if (conclude !== undefined && !CONCLUDE_VALUES.includes(conclude)) throw new Error(`conclude must be one of ${CONCLUDE_VALUES.join('|')}`);
  const def = {
    id: randomUUID(), title: title.trim(), description: description.trim(), cwd: cwd.trim(),
    cooldownHours: cooldownHours ?? 24, enabled: enabled !== false,
    window: { ...DEFAULT_DEF.window, ...window },
    thresholds: {
      claude: { ...DEFAULT_DEF.thresholds.claude, ...thresholds?.claude },
      ollama: { ...DEFAULT_DEF.thresholds.ollama, ...thresholds?.ollama },
    },
    models: { ...DEFAULT_DEF.models, ...models },
    tokenCaps: { ...DEFAULT_DEF.tokenCaps, ...tokenCaps },
    scopes: Array.isArray(scopes) ? scopes : [],
    conclude: conclude ?? 'inreview',
    lastRunAt: null, lastTaskId: null,
  };
  config.defs.push(def);
  persist();
  emit();
  return def;
}

// `thresholds` is two levels deep ({claude:{...}, ollama:{...}}) — merge
// per-backend so editing one field (e.g. claude.start) doesn't wipe its
// siblings (claude.stop/weeklyMax) and silently disable the gate. Same for
// window/models/tokenCaps (single level, merge preserves untouched keys).
export function updateDef(id, partial) {
  const def = config.defs.find((d) => d.id === id);
  if (!def) throw new Error('no such def');
  if (partial.conclude !== undefined && !CONCLUDE_VALUES.includes(partial.conclude)) throw new Error(`conclude must be one of ${CONCLUDE_VALUES.join('|')}`);
  for (const k of ['title', 'description', 'cwd', 'cooldownHours', 'enabled', 'lastRunAt', 'lastTaskId', 'conclude']) {
    if (partial[k] !== undefined) def[k] = partial[k];
  }
  if (partial.window) def.window = { ...def.window, ...partial.window };
  if (partial.thresholds) {
    for (const [backend, tv] of Object.entries(partial.thresholds)) {
      if (tv && typeof tv === 'object') def.thresholds[backend] = { ...def.thresholds[backend], ...tv };
    }
  }
  if (partial.models) def.models = { ...def.models, ...partial.models };
  if (partial.tokenCaps) def.tokenCaps = { ...def.tokenCaps, ...partial.tokenCaps };
  if (Array.isArray(partial.scopes)) def.scopes = partial.scopes;
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

// Cosmetic row order (drag-to-reorder in the UI). Purely display — the
// scheduler still picks oldest-lastRunAt round-robin, not this order. `ids` is
// the full desired order; any def omitted keeps its relative tail position.
export function reorderDefs(ids) {
  if (!Array.isArray(ids)) throw new Error('ids array required');
  const rank = new Map(ids.map((id, i) => [id, i]));
  config.defs.sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity));
  persist();
  emit();
}

// ---- Reports ----------------------------------------------------------------

// Background-tagged tasks (live + concluded), newest first, with whether
// Report.md exists in their persistent reportDir (.reports/<short>).
// reportDir/id are read from the stored task/history records only.
export function listReports() {
  const { tasks, history } = snapshotTasks();
  const entries = [...tasks, ...history]
    .filter((t) => (t.tags || []).includes('background'))
    .map((t) => ({
      taskId: t.id,
      title: t.title,
      createdAt: t.createdAt,
      concludedAt: t.concludedAt ?? null,
      status: t.outcome ?? t.column,
      hasReport: existsSync(join(t.reportDir, 'Report.md')),
    }));
  entries.sort((a, b) => (b.concludedAt ?? b.createdAt) - (a.concludedAt ?? a.createdAt));
  return entries;
}

// Report.md content for one background task. reportDir is resolved only from
// the stored task/history record by id — never from client input. Returns null
// when the id is unknown or not background-tagged, or has no Report.md.
export function getReport(taskId) {
  const { tasks, history } = snapshotTasks();
  const t = [...tasks, ...history].find((x) => x.id === taskId && (x.tags || []).includes('background'));
  if (!t) return null;
  const file = join(t.reportDir, 'Report.md');
  if (!existsSync(file)) return null;
  return { taskId: t.id, title: t.title, content: readFileSync(file, 'utf8') };
}

// Manual trigger: bypass the window (and, with force, the gate too). Still
// single-flight. Runs the tick "go" path or throws with a reason.
export async function runBackgroundNow({ force } = {}) {
  const task = await attemptRun({ bypassWindow: true, bypassGate: !!force, manual: true });
  return { taskId: task.id };
}
