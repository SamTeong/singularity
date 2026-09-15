// Cron jobs: crons.json persistence + in-process UTC scheduler. Each fire
// spawns a fresh agent (reg.create) with the job's stored description; the session
// auto-kills when it goes idle (description done). Overlap = skip if the previous
// run is still alive. Emits 'crons' on the shared agents bus; pty-ws fans it out.
//
// "Ignore missed on restart" is structural: nextFire is recomputed from the
// current time on load (cron-parser .next() yields the next future match), so
// no past occurrence is ever replayed. Daemon down / machine asleep = the
// in-process tick loop simply stops; on wake it resumes from now.
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CronExpressionParser } from 'cron-parser';
import * as reg from './agents.mjs';

const CRONS_FILE = join(reg.STATE_DIR, 'crons.json');
const TICK_MS = 1000;

const crons = new Map(); // id -> job (plain object)
const nextFires = new Map(); // id -> CronDate (in-memory only, never persisted)
const cronSessions = new Set(); // session ids spawned by a cron fire (for auto-kill on idle)
const killTimers = new Map(); // session id -> confirm timer (ride out startup pauses before killing)
const KILL_CONFIRM_MS = 6000; // kill only after this much sustained idle
let logger = null;

function persist(jobs = crons) {
  try {
    reg.writeAtomic(CRONS_FILE, JSON.stringify({ crons: [...jobs.values()] }, null, 2)); // atomic swap — a crash mid-write never truncates CRONS_FILE
  } catch (e) {
    logger?.warn({ err: e.message }, 'crons.json write failed');
    const err = new Error(`crons.json write failed: ${e.message}`);
    err.persistFailure = true; // flags a genuine disk write failure vs. a validation error — index.mjs routes surface it as 500
    throw err;
  }
}

function emitCrons() { reg.bus.emit('crons', snapshotCrons()); }

function validateExpr(expr) {
  // Throws on invalid expr (caller turns it into a 400).
  CronExpressionParser.parse(expr, { utc: true, tz: 'UTC' });
}

function recomputeNext(job) {
  try { nextFires.set(job.id, CronExpressionParser.parse(job.cronExpr, { utc: true, tz: 'UTC' }).next()); }
  catch (e) { logger?.warn({ id: job.id, expr: job.cronExpr, err: e.message }, 'cron parse failed — no further fires until fixed'); nextFires.delete(job.id); }
}

export function initCrons(log) {
  logger = log;
  try {
    if (existsSync(CRONS_FILE)) {
      const data = JSON.parse(readFileSync(CRONS_FILE, 'utf8'));
      for (const j of data.crons || []) crons.set(j.id, j);
      log?.info({ crons: crons.size }, 'loaded crons.json');
    }
  } catch (e) { log?.warn({ err: e.message }, 'crons.json load failed'); }

  // A pending run is a durable unknown outcome. Only finalize it when the
  // registry carries the same stable run id; otherwise leave it blocked rather
  // than risking a duplicate scheduled agent after restart.
  for (const job of crons.values()) {
    if (!job.pendingRunId) continue;
    const pendingRunId = job.pendingRunId;
    const pendingRunAt = job.pendingRunAt;
    const agent = reg.findByRunId(job.pendingRunId);
    if (!agent) continue;
    job.lastSessionId = agent.id;
    job.lastFiredAt = job.pendingRunAt;
    job.updatedAt = Date.now();
    delete job.pendingRunId;
    delete job.pendingRunAt;
    cronSessions.add(agent.id);
    try { persist(); }
    catch (e) {
      job.pendingRunId = pendingRunId;
      job.pendingRunAt = pendingRunAt;
      log?.warn({ err: e.message, id: job.id }, 'cron run recovery persist failed');
    }
  }

  // A cron-fired session still alive at the last shutdown reloads (via reg.init)
  // as a dead 'detached' registry entry — reg never auto-kills it, so it'd sit
  // there forever. Sweep those now that the registry is loaded.
  for (const job of crons.values()) {
    if (job.lastSessionId && reg.getStatus(job.lastSessionId) && !reg.isLive(job.lastSessionId)) reg.kill(job.lastSessionId);
  }

  for (const job of crons.values()) if (job.enabled) recomputeNext(job);

  // Auto-kill on completion. A cron-fired agent going idle means its turn is
  // done and it's waiting for input nobody will give. But claude's TUI has a
  // ~2-4s quiet window during startup, before the spinner emits continuously —
  // the agents.mjs idle heuristic (IDLE_MS=2000) false-positives there. So
  // don't kill on the first idle: arm a confirm timer, cancel it if the agent
  // emits again (running), and only kill after KILL_CONFIRM_MS of sustained
  // idle. On the kill, onExit -> 'exited' -> second reg.kill removes the record
  // from the registry (no lingering 'exited' entries).
  reg.bus.on('status', ({ id, status }) => {
    if (!cronSessions.has(id)) return;
    if (status === 'running') {
      if (killTimers.has(id)) { clearTimeout(killTimers.get(id)); killTimers.delete(id); }
    } else if (status === 'idle') {
      if (!killTimers.has(id)) {
        killTimers.set(id, setTimeout(() => { killTimers.delete(id); reg.kill(id); }, KILL_CONFIRM_MS));
      }
    } else if (status === 'exited') {
      if (killTimers.has(id)) { clearTimeout(killTimers.get(id)); killTimers.delete(id); }
      cronSessions.delete(id);
      reg.kill(id); // proc is now null -> deletes the record from the registry
    }
  });

  setInterval(tick, TICK_MS).unref();
}

function tick() {
  const now = Date.now();
  for (const job of crons.values()) {
    if (!job.enabled) continue;
    const nf = nextFires.get(job.id);
    if (nf && now >= nf.getTime()) fire(job); // fire() recomputes nextFire
  }
}

// Spawn the job's description into a fresh agent + record the run. Shared by the
// scheduler (fire) and manual run (runCron). Does NOT touch nextFire.
function spawnForJob(job) {
  // reg.create's params (title/prompt) are the session-registry contract; the
  // cron stores them as title/description, so map at the call site.
  const agent = reg.create({ cwd: job.cwd, title: job.title, model: job.model, scopes: job.scopes, prompt: job.description, permissionMode: job.permissionMode, runId: job.pendingRunId });
  job.lastSessionId = agent.id;
  job.lastFiredAt = Date.now();
  job.updatedAt = Date.now();
  job.lastError = null;
  cronSessions.add(agent.id);
  const pendingRunId = job.pendingRunId;
  const pendingRunAt = job.pendingRunAt;
  delete job.pendingRunId;
  delete job.pendingRunAt;
  try { persist(); }
  catch (e) {
    job.pendingRunId = pendingRunId;
    job.pendingRunAt = pendingRunAt;
    throw e;
  }
  emitCrons();
  return agent;
}

function beginRun(job) {
  const pending = { ...job, pendingRunId: randomUUID(), pendingRunAt: Date.now() };
  const next = new Map(crons);
  next.set(job.id, pending);
  persist(next);
  Object.assign(job, pending);
}

// Scheduled fire: skip if previous run still alive, else advance nextFire + spawn.
// recomputeNext runs BEFORE spawnForJob so the snapshot spawnForJob emits already
// carries the new nextFire. Clients learn nextFire only from a pushed snapshot (no
// polling), so a push carrying the boundary that just fired leaves the row counting
// down past zero ("in -80s") until the next fire. Every path emits exactly once.
function fire(job) {
  if (job.pendingRunId || reg.isLive(job.lastSessionId)) {
    logger?.info({ id: job.id }, 'cron skipped — previous run still active');
    recomputeNext(job);
    emitCrons();
    return;
  }
  recomputeNext(job);
  try { beginRun(job); spawnForJob(job); }
  catch (e) {
    logger?.warn({ id: job.id, err: e.message }, 'cron spawn failed');
    const failed = { ...job, lastError: e.message, updatedAt: Date.now() };
    const staged = new Map(crons);
    staged.set(job.id, failed);
    try {
      persist(staged);
      Object.assign(job, failed);
      emitCrons();
    } catch (persistError) {
      logger?.warn({ id: job.id, err: persistError.message }, 'cron failed-run persistence failed');
    }
  }
}

export function snapshotCrons() {
  return [...crons.values()].map((j) => ({ ...j, nextFire: nextFires.get(j.id)?.toISOString() ?? null }));
}

export function createCron({ title, cronExpr, description, cwd, model, scopes, permissionMode, enabled, idempotencyKey }) {
  if (!title?.trim() || !cronExpr?.trim() || !description?.trim() || !cwd?.trim()) throw new Error('title, cronExpr, description, cwd required');
  validateExpr(cronExpr.trim());
  const payload = {
    title: title.trim(), enabled: enabled !== false, cronExpr: cronExpr.trim(), description: description.trim(),
    cwd: cwd.trim(), model: model || 'claude', scopes: scopes || [], permissionMode: permissionMode || 'acceptEdits',
  };
  const key = typeof idempotencyKey === 'string' && idempotencyKey.trim() ? idempotencyKey.trim() : null;
  const existing = key && [...crons.values()].find((job) => job.idempotencyKey === key);
  if (existing) {
    const fingerprint = existing.idempotencyPayload ?? JSON.stringify({ title: existing.title, enabled: existing.enabled, cronExpr: existing.cronExpr, description: existing.description, cwd: existing.cwd, model: existing.model, scopes: existing.scopes, permissionMode: existing.permissionMode });
    const same = JSON.stringify(payload) === fingerprint;
    if (!same) { const err = new Error('Idempotency-Key was already used with a different payload'); err.statusCode = 409; throw err; }
    return existing;
  }
  const id = randomUUID();
  const job = {
    id, ...payload, ...(key ? { idempotencyKey: key, idempotencyPayload: JSON.stringify(payload) } : {}),
    lastSessionId: null, lastFiredAt: null, createdAt: Date.now(), updatedAt: Date.now(),
  };
  const pending = new Map(crons);
  pending.set(id, job);
  persist(pending);
  crons.set(id, job);
  if (job.enabled) recomputeNext(job);
  emitCrons();
  return job;
}

export function updateCron(id, body) {
  const current = crons.get(id);
  if (!current) throw new Error('no such cron');
  const job = { ...current };
  if (body.title !== undefined) job.title = String(body.title).trim();
  if (body.cronExpr !== undefined) { validateExpr(body.cronExpr); job.cronExpr = String(body.cronExpr).trim(); }
  if (body.description !== undefined) job.description = String(body.description).trim();
  if (body.cwd !== undefined) job.cwd = String(body.cwd).trim();
  if (body.model !== undefined) job.model = body.model;
  if (body.scopes !== undefined) job.scopes = body.scopes;
  if (body.permissionMode !== undefined) job.permissionMode = body.permissionMode;
  if (body.enabled !== undefined) job.enabled = !!body.enabled;
  if (!job.title?.trim() || !job.cronExpr?.trim() || !job.description?.trim() || !job.cwd?.trim()) throw new Error('title, cronExpr, description, cwd required');
  job.updatedAt = Date.now();
  const pending = new Map(crons);
  pending.set(id, job);
  persist(pending);
  Object.assign(current, job);
  if (job.enabled) recomputeNext(job); else nextFires.delete(job.id);
  emitCrons();
  return current;
}

export function deleteCron(id) {
  if (!crons.has(id)) throw new Error('no such cron');
  const pending = new Map(crons);
  pending.delete(id);
  persist(pending);
  crons.delete(id);
  nextFires.delete(id);
  emitCrons();
}

// Manual "Run now": same overlap rule as the scheduler, but expressed as an
// error (so the UI can surface it) and does not disturb the scheduled nextFire.
export function runCron(id) {
  const job = crons.get(id);
  if (!job) throw new Error('no such cron');
  if (job.pendingRunId || reg.isLive(job.lastSessionId)) throw new Error('previous run still active');
  beginRun(job);
  try {
    return spawnForJob(job);
  } catch (e) {
    const agent = reg.findByRunId(job.pendingRunId);
    if (agent) {
      job.lastSessionId = agent.id;
      job.lastFiredAt = Date.now();
      job.updatedAt = Date.now();
      persist();
      delete job.pendingRunId;
      delete job.pendingRunAt;
    }
    throw e;
  }
}
