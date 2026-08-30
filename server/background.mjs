// Background tasks: quota-soak agent runs during working hours. A minute-
// resolution tick, when due by TICK_MINUTES and inside a job's own window,
// gates on live 5h/7d usage (Claude first, else Ollama) against that job's own
// thresholds, picks the oldest off-cooldown job round-robin, and spawns it as
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
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as reg from './agents.mjs';
import { createTask, updateTask, snapshotTasks } from './tasks.mjs';
import { getUsage } from './usage.mjs';
import { parseSession } from './stats.mjs';
import { isClaudeModel, isCodexModel } from './models.mjs';

const BACKGROUND_FILE = join(reg.STATE_DIR, 'background.json');
const FLAGS_FILE = join(reg.STATE_DIR, 'report-flags.json'); // Set of unflagged (dismissed) taskIds; absent = all flagged (need attention)
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

// Per-task defaults — every job merges over this on create, and legacy flat
// installs get seeded from their old top-level copy (see migrateLegacyConfig).
const DEFAULT_JOB = {
  window: { startHour: 9, endHour: 18, days: [1, 2, 3, 4, 5] },
  thresholds: {
    claude: { start: 50, stop: 75, weeklyMax: 50 },
    codex: { start: 50, stop: 75, weeklyMax: 50 },
    ollama: { start: 50, stop: 75, weeklyMax: 50 },
  },
  models: { claude: 'opus', codex: 'gpt-5.6-luna', ollama: 'glm-5.3:cloud' },
  tokenCaps: { claude: 15_000_000, codex: 15_000_000, ollama: 15_000_000 },
  scopes: [],
};

let config = { jobs: [] };
let lastTick = null; // { at, action:'ran'|'skipped', reason }
let logger = null;
let lastDueAt = 0; // when the tick logic last ran (minute-resolution gating)
let injectedTaskId = null; // watchdog: wrap-up injected for this bg task (once)

// ---- Pure functions (exported, unit-tested) ------------------------------------

// Daemon-local: is `date` within this job's configured weekday+hour window?
export function inWindow(job, date) {
  const { startHour, endHour, days } = job.window;
  const h = date.getHours();
  return days.includes(date.getDay()) && h >= startHour && h < endHour;
}

// Why a backend's gate fails, or null when it passes. A source with ok:false
// (or missing/incomplete usage) fails closed.
function gateReason(u, th, name) {
  if (!u || !u.ok) return `${name} usage unavailable`;
  const sess = u.session?.pctUsed, wk = u.weekly?.pctUsed;
  if (sess == null && wk == null) return `${name} usage incomplete`;
  if (sess != null && sess >= th.start) return `${name} 5h ${sess}% >= ${th.start}%`;
  if (wk != null && wk >= th.weeklyMax) return `${name} 7d ${wk}% >= ${th.weeklyMax}%`;
  return null;
}

// Claude first, then Codex (both paid subscription quotas — soak them before
// the free local fallback), then Ollama, against this job's own thresholds.
// Each source fails only its own gate (fail closed).
export function evalGate(usage, job) {
  const reasons = [];
  for (const backend of ['claude', 'codex', 'ollama']) {
    const r = gateReason(usage?.[backend], job.thresholds[backend], backend);
    if (r == null) return { backend, reason: `${backend} within budget` };
    reasons.push(r);
  }
  return { backend: null, reason: reasons.join('; ') };
}

// Oldest off-cooldown enabled job (null lastRunAt = oldest), ignoring window and
// gate entirely — used only for a forced (bypassGate) manual run.
export function pickJob(jobs, now) {
  const ready = (jobs || []).filter((d) =>
    d.enabled && (d.lastRunAt == null || now - d.lastRunAt > d.cooldownHours * 3_600_000));
  ready.sort((a, b) => (a.lastRunAt ?? -Infinity) - (b.lastRunAt ?? -Infinity));
  return ready[0] || null;
}

// Job-first pass for the normal (non-forced) run path: candidates are enabled +
// off-cooldown + (in their own window, unless bypassWindow), oldest lastRunAt
// first. Returns the first candidate whose own gate passes as { job, backend,
// reason: null }, or { job: null, backend: null, reason } when none qualify —
// 'did not find eligible task to run' when there were no candidates at all, else the joined
// per-candidate gate reasons.
export function pickRunnableJob(jobs, usage, now, { bypassWindow = false } = {}) {
  const ready = (jobs || []).filter((d) =>
    d.enabled &&
    (d.lastRunAt == null || now - d.lastRunAt > d.cooldownHours * 3_600_000) &&
    (bypassWindow || inWindow(d, new Date(now))));
  ready.sort((a, b) => (a.lastRunAt ?? -Infinity) - (b.lastRunAt ?? -Infinity));
  if (ready.length === 0) return { job: null, backend: null, reason: 'did not find eligible task to run' };
  const reasons = [];
  for (const job of ready) {
    const gate = evalGate(usage, job);
    if (gate.backend) return { job, backend: gate.backend, reason: null };
    reasons.push(`${job.title}: ${gate.reason}`);
  }
  return { job: null, backend: null, reason: reasons.join('; ') };
}

// Should a live run stop? Fail closed on unavailable usage.
export function watchdogDecision(usage, backend, job, tokens) {
  const u = usage?.[backend];
  const th = job.thresholds[backend];
  if (!u || !u.ok) return 'stop';
  if ((u.session?.pctUsed ?? 0) >= th.stop) return 'stop';
  if ((u.weekly?.pctUsed ?? 0) >= th.weeklyMax) return 'stop';
  if (tokens >= job.tokenCaps[backend]) return 'stop';
  return 'continue';
}

// ---- State + bus ----------------------------------------------------------------

function persist() {
  try {
    reg.writeAtomic(BACKGROUND_FILE, JSON.stringify(config, null, 2)); // atomic swap
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

// The one liveness escape hatch for the single-flight guard: a session can die
// (crash, kill, pty exit) without the agent ever curl-ing itself off
// todo/inprogress, which would otherwise leave liveBgTask() latched forever —
// refusing every later tick and stalling the watchdog. Both places that read
// liveBgTask() as a gate (attemptRun's single-flight check, watchdog) call
// this first instead, so a dead session can never block a new run past the
// next read of either. Reuses the reviewer's own "needs a human" {column,
// state} shape, so no new WS frame/mock handler is needed — updateTask's
// normal persist+broadcast already covers it. Returns the still-live task (or
// null), so callers can't tell a "never was live" null from a "just released"
// null — both mean "not blocked".
async function healLiveBgTask() {
  const task = liveBgTask();
  if (!task || !task.sessionId || reg.isLive(task.sessionId)) return task;
  injectedTaskId = null; // this run is over one way or another — drop any stale wrap-up mark
  try { await updateTask(task.id, { column: 'inreview', state: 'parked — needs human' }); emit(); }
  catch (e) { logger?.warn({ err: e.message }, 'background dead-session release failed'); return task; }
  return null;
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
  if (await healLiveBgTask()) return refuse('a background run is already live');

  let job, backend;
  if (bypassGate) { // forced run: no gate, default to claude budget/model
    backend = 'claude';
    job = pickJob(config.jobs, now);
    if (!job) return refuse('did not find eligible task to run');
  } else {
    const picked = pickRunnableJob(config.jobs, await getUsage(), now, { bypassWindow });
    if (!picked.job) return refuse(picked.reason);
    ({ job, backend } = picked);
  }

  const model = job.models[backend];
  const task = createTask({
    repo: job.cwd, title: job.title, description: job.description, model,
    scopes: job.scopes, tags: ['background'], background: true, permissionSettings: DENY,
    conclude: job.conclude,
  });
  job.lastRunAt = now;
  job.lastTaskId = task.id;
  persist();
  lastTick = { at: Date.now(), action: 'ran', reason: `${job.title} → ${backend}/${model}` };
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
  // healLiveBgTask is the backstop here: it catches a dead session even if
  // the 'exited' bus event (see initBackground) never fired for it in this
  // process — e.g. it died before the listener was registered, across a
  // daemon restart. This runs every WATCHDOG_MS regardless of window/gate, so
  // the guard is unlatched within one poll either way.
  const task = await healLiveBgTask();
  if (!task) { injectedTaskId = null; return; }
  if (injectedTaskId === task.id) return; // already wrapping up this run
  let decision = 'stop'; // fail closed: a thrown poll (or a missing job) leaves the run unsupervised → stop
  try {
    const job = config.jobs.find((d) => d.lastTaskId === task.id);
    const usage = await getUsage();
    const backend = isClaudeModel(task.model) ? 'claude' : isCodexModel(task.model) ? 'codex' : 'ollama';
    const tokens = (await parseSession(task.worktree || task.repo, task.sessionId, backend)).tokens;
    decision = job ? watchdogDecision(usage, backend, job, tokens) : 'stop';
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
// level, shared by every job. Seed those onto any job missing them; a job that
// already has its own copy (already migrated, or created post-refactor) is left
// untouched. Pure — exported so the migration test doesn't touch the filesystem.
export function migrateLegacyConfig(loaded) {
  const legacy = ['window', 'thresholds', 'models', 'tokenCaps'].filter((k) => loaded?.[k] != null);
  const jobs = (loaded?.jobs || loaded?.defs || []).map((d) => {
    if (legacy.length === 0) return d;
    const seeded = { ...d };
    for (const k of legacy) if (seeded[k] === undefined) seeded[k] = loaded[k];
    return seeded;
  });
  return { jobs, migrated: legacy.length > 0 };
}

export function initBackground(log) {
  logger = log;
  try {
    if (existsSync(BACKGROUND_FILE)) {
      const loaded = JSON.parse(readFileSync(BACKGROUND_FILE, 'utf8'));
      const { jobs, migrated } = migrateLegacyConfig(loaded);
      config = { jobs };
      if (migrated) persist(); // rewrite state/background.json to the new {jobs} shape
      log?.info({ jobs: config.jobs.length, migrated }, 'loaded background.json');
    } else {
      persist(); // materialize the shipped default so the file exists
    }
  } catch (e) { log?.warn({ err: e.message }, 'background.json load failed'); }
  lastDueAt = Date.now(); // wait one TICK_MINUTES before the first run
  setInterval(tick, TICK_MS).unref();
  setInterval(() => { watchdog().catch(() => {}); }, WATCHDOG_MS).unref();
  // Same registry exit signal crons.mjs already reacts to — releases the
  // guard the instant the session dies instead of waiting up to WATCHDOG_MS
  // for healLiveBgTask's own backstop (called from watchdog/attemptRun) to
  // notice on its next read.
  reg.bus.on('status', ({ id, status }) => {
    if (status !== 'exited') return;
    const task = liveBgTask();
    if (task && task.sessionId === id) healLiveBgTask();
  });
}

// ---- CRUD -----------------------------------------------------------------------

// Per-job choice for how a run concludes: 'inreview' (default — a human reviews
// the report before the card reaches done) or 'done' (report is trusted enough
// to auto-conclude). The watchdog's budget-kill path always forces 'inreview'
// regardless of this setting (see watchdog() above).
const CONCLUDE_VALUES = ['inreview', 'done'];

export function createJob({ title, description, cwd, cooldownHours, enabled, window, thresholds, models, tokenCaps, scopes, conclude }) {
  if (!title?.trim() || !description?.trim() || !cwd?.trim()) throw new Error('title, description, cwd required');
  if (conclude !== undefined && !CONCLUDE_VALUES.includes(conclude)) throw new Error(`conclude must be one of ${CONCLUDE_VALUES.join('|')}`);
  const job = {
    id: randomUUID(), title: title.trim(), description: description.trim(), cwd: cwd.trim(),
    cooldownHours: cooldownHours ?? 24, enabled: enabled !== false,
    window: { ...DEFAULT_JOB.window, ...window },
    thresholds: {
      claude: { ...DEFAULT_JOB.thresholds.claude, ...thresholds?.claude },
      codex: { ...DEFAULT_JOB.thresholds.codex, ...thresholds?.codex },
      ollama: { ...DEFAULT_JOB.thresholds.ollama, ...thresholds?.ollama },
    },
    models: { ...DEFAULT_JOB.models, ...models },
    tokenCaps: { ...DEFAULT_JOB.tokenCaps, ...tokenCaps },
    scopes: Array.isArray(scopes) ? scopes : [],
    conclude: conclude ?? 'inreview',
    lastRunAt: null, lastTaskId: null,
  };
  config.jobs.push(job);
  persist();
  emit();
  return job;
}

// `thresholds` is two levels deep ({claude:{...}, ollama:{...}}) — merge
// per-backend so editing one field (e.g. claude.start) doesn't wipe its
// siblings (claude.stop/weeklyMax) and silently disable the gate. Same for
// window/models/tokenCaps (single level, merge preserves untouched keys).
export function updateJob(id, partial) {
  const job = config.jobs.find((d) => d.id === id);
  if (!job) throw new Error('no such job');
  if (partial.conclude !== undefined && !CONCLUDE_VALUES.includes(partial.conclude)) throw new Error(`conclude must be one of ${CONCLUDE_VALUES.join('|')}`);
  for (const k of ['title', 'description', 'cwd', 'cooldownHours', 'enabled', 'lastRunAt', 'lastTaskId', 'conclude']) {
    if (partial[k] !== undefined) job[k] = partial[k];
  }
  if (partial.window) job.window = { ...job.window, ...partial.window };
  if (partial.thresholds) {
    for (const [backend, tv] of Object.entries(partial.thresholds)) {
      if (tv && typeof tv === 'object') job.thresholds[backend] = { ...job.thresholds[backend], ...tv };
    }
  }
  if (partial.models) job.models = { ...job.models, ...partial.models };
  if (partial.tokenCaps) job.tokenCaps = { ...job.tokenCaps, ...partial.tokenCaps };
  if (Array.isArray(partial.scopes)) job.scopes = partial.scopes;
  persist();
  emit();
  return job;
}

export function deleteJob(id) {
  const i = config.jobs.findIndex((d) => d.id === id);
  if (i === -1) throw new Error('no such job');
  config.jobs.splice(i, 1);
  persist();
  emit();
}

// Cosmetic row order (drag-to-reorder in the UI). Purely display — the
// scheduler still picks oldest-lastRunAt round-robin, not this order. `ids` is
// the full desired order; any job omitted keeps its relative tail position.
export function reorderJobs(ids) {
  if (!Array.isArray(ids)) throw new Error('ids array required');
  const rank = new Map(ids.map((id, i) => [id, i]));
  config.jobs.sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity));
  persist();
  emit();
}

// ---- Reports ----------------------------------------------------------------

// Flag-state: a set of report taskIds the user has unflagged (dismissed).
// Everything not in the set is flagged (= still needs attention), so new
// reports default flagged. Persisted separately from background.json so job
// CRUD never touches it; atomic tmp+rename like persist().
function loadUnflagged() {
  try {
    if (existsSync(FLAGS_FILE)) return new Set(JSON.parse(readFileSync(FLAGS_FILE, 'utf8')));
  } catch (e) { logger?.warn({ err: e.message }, 'report-flags.json load failed'); }
  return new Set();
}
function saveUnflagged(set) {
  try {
    reg.writeAtomic(FLAGS_FILE, JSON.stringify([...set]));
  } catch (e) { logger?.warn({ err: e.message }, 'report-flags.json write failed'); throw e; }
}

// Flag/unflag a report. flagged=true means it needs attention; unflagging
// records a dismissal. Only prunes to real report ids on write to keep the file
// from growing unbounded as tasks age out of history.
export function setReportFlag(taskId, flagged) {
  const ids = new Set(listReports().map((r) => r.taskId));
  if (!ids.has(taskId)) throw new Error('no such report');
  const set = loadUnflagged();
  if (flagged) set.delete(taskId); else set.add(taskId);
  for (const id of set) if (!ids.has(id)) set.delete(id); // drop stale ids
  saveUnflagged(set);
  emit();
  return { taskId, flagged: !!flagged };
}

// Background-tagged tasks (live + concluded), newest first, with whether
// Report.md exists in their persistent reportDir (.reports/<short>) and whether
// it is flagged (needs attention). reportDir/id are read from stored records only.
export function listReports() {
  const { tasks, history } = snapshotTasks();
  const unflagged = loadUnflagged();
  const entries = [...tasks, ...history]
    .filter((t) => (t.tags || []).includes('background'))
    .map((t) => ({
      taskId: t.id,
      title: t.title,
      createdAt: t.createdAt,
      concludedAt: t.concludedAt ?? null,
      status: t.outcome ?? t.column,
      hasReport: existsSync(join(t.reportDir, 'Report.md')),
      flagged: !unflagged.has(t.id),
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
