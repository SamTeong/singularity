// Cron jobs: crons.json persistence + in-process UTC scheduler. Each fire
// spawns a fresh agent (reg.create) with the job's stored prompt; the session
// auto-kills when it goes idle (prompt done). Overlap = skip if the previous
// run is still alive. Emits 'crons' on the shared agents bus; pty-ws fans it out.
//
// "Ignore missed on restart" is structural: nextFire is recomputed from the
// current time on load (cron-parser .next() yields the next future match), so
// no past occurrence is ever replayed. Daemon down / machine asleep = the
// in-process tick loop simply stops; on wake it resumes from now.
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CronExpressionParser } from 'cron-parser';
import * as reg from './agents.mjs';

const CRONS_FILE = join(reg.APP_DIR, 'crons.json');
const TICK_MS = 1000;

const crons = new Map(); // id -> job (plain object)
const nextFires = new Map(); // id -> CronDate (in-memory only, never persisted)
const cronSessions = new Set(); // session ids spawned by a cron fire (for auto-kill on idle)
const killTimers = new Map(); // session id -> confirm timer (ride out startup pauses before killing)
const KILL_CONFIRM_MS = 6000; // kill only after this much sustained idle
let logger = null;

function persist() {
  try { writeFileSync(CRONS_FILE, JSON.stringify({ crons: [...crons.values()] }, null, 2)); }
  catch (e) { logger?.warn({ err: e.message }, 'crons.json write failed'); }
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

// Spawn the job's prompt into a fresh agent + record the run. Shared by the
// scheduler (fire) and manual run (runCron). Does NOT touch nextFire.
function spawnForJob(job) {
  const agent = reg.create({ cwd: job.cwd, name: job.name, model: job.model, scopes: job.scopes, prompt: job.prompt, permissionMode: job.permissionMode });
  job.lastSessionId = agent.id;
  job.lastFiredAt = Date.now();
  job.updatedAt = Date.now();
  cronSessions.add(agent.id);
  persist();
  emitCrons();
  return agent;
}

// Scheduled fire: skip if previous run still alive, else spawn + advance nextFire.
function fire(job) {
  if (reg.isLive(job.lastSessionId)) {
    logger?.info({ id: job.id }, 'cron skipped — previous run still active');
    recomputeNext(job);
    return;
  }
  try { spawnForJob(job); }
  catch (e) { logger?.warn({ id: job.id, err: e.message }, 'cron spawn failed'); }
  recomputeNext(job);
}

export function snapshotCrons() {
  return [...crons.values()].map((j) => ({ ...j, nextFire: nextFires.get(j.id)?.toISOString() ?? null }));
}

export function createCron({ name, cronExpr, prompt, cwd, model, scopes, permissionMode, enabled }) {
  if (!name?.trim() || !cronExpr?.trim() || !prompt?.trim() || !cwd?.trim()) throw new Error('name, cronExpr, prompt, cwd required');
  validateExpr(cronExpr.trim());
  const id = randomUUID();
  const job = {
    id, name: name.trim(), enabled: enabled !== false, cronExpr: cronExpr.trim(), prompt: prompt.trim(),
    cwd: cwd.trim(), model: model || 'claude', scopes: scopes || [], permissionMode: permissionMode || 'acceptEdits',
    lastSessionId: null, lastFiredAt: null, createdAt: Date.now(), updatedAt: Date.now(),
  };
  crons.set(id, job);
  if (job.enabled) recomputeNext(job);
  persist();
  emitCrons();
  return job;
}

export function updateCron(id, body) {
  const job = crons.get(id);
  if (!job) throw new Error('no such cron');
  if (body.name !== undefined) job.name = String(body.name).trim();
  if (body.cronExpr !== undefined) { validateExpr(body.cronExpr); job.cronExpr = String(body.cronExpr).trim(); }
  if (body.prompt !== undefined) job.prompt = String(body.prompt).trim();
  if (body.cwd !== undefined) job.cwd = String(body.cwd).trim();
  if (body.model !== undefined) job.model = body.model;
  if (body.scopes !== undefined) job.scopes = body.scopes;
  if (body.permissionMode !== undefined) job.permissionMode = body.permissionMode;
  if (body.enabled !== undefined) job.enabled = !!body.enabled;
  job.updatedAt = Date.now();
  if (job.enabled) recomputeNext(job); else nextFires.delete(job.id);
  persist();
  emitCrons();
  return job;
}

export function deleteCron(id) {
  if (!crons.delete(id)) throw new Error('no such cron');
  nextFires.delete(id);
  persist();
  emitCrons();
}

// Manual "Run now": same overlap rule as the scheduler, but expressed as an
// error (so the UI can surface it) and does not disturb the scheduled nextFire.
export function runCron(id) {
  const job = crons.get(id);
  if (!job) throw new Error('no such cron');
  if (reg.isLive(job.lastSessionId)) throw new Error('previous run still active');
  return spawnForJob(job);
}