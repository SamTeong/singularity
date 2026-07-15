// Task board: tasks.json persistence, one git worktree + agent session per
// task, workflow prompt. Columns move via POST /tasks/:id/status — called by
// the task's own agent (curl, prompt-instructed) or by a UI drag. Emits
// 'tasks' on the shared agents bus; pty-ws fans it out.
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as reg from './agents.mjs';
import { statsFor } from './stats.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATUSLINE_SCRIPT = join(__dirname, 'statusline-capture.mjs');

const TASKS_FILE = join(reg.APP_DIR, 'tasks.json');
const WORKTREE_ROOT = join(reg.APP_DIR, 'worktrees');
const COLUMNS = ['todo', 'inprogress', 'inreview', 'done'];
const PORT = Number(process.env.PORT ?? 4317);
const MAX_REVIEW_REJECTS = 3;
const RETENTION_MS = 7 * 24 * 3600 * 1000; // Done cards auto-conclude to history after this long.

const tasks = new Map(); // id -> task record (plain object, see plan/data model)
let history = []; // concluded tasks: task fields + outcome, concludedAt, finalStats
let logger = null;

function git(repo, ...args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

function persist() {
  try {
    writeFileSync(TASKS_FILE + '.tmp', JSON.stringify({ tasks: [...tasks.values()], history }, null, 2));
    renameSync(TASKS_FILE + '.tmp', TASKS_FILE); // atomic swap — a crash mid-write never truncates TASKS_FILE
  } catch (e) { logger?.warn({ err: e.message }, 'tasks.json write failed'); }
}

function emitTasks() { reg.bus.emit('tasks', snapshotTasks()); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

export function initTasks(log) {
  logger = log;
  try {
    if (existsSync(TASKS_FILE)) {
      const data = JSON.parse(readFileSync(TASKS_FILE, 'utf8'));
      for (const t of data.tasks || []) tasks.set(t.id, t);
      history = data.history || []; // old tasks.json shape { tasks } has no history — defaults []
      log?.info({ tasks: tasks.size, history: history.length }, 'loaded tasks.json');
    }
  } catch (e) { log?.warn({ err: e.message }, 'tasks.json load failed'); }
  // Crash between `git worktree add` and persist leaves an orphaned worktree
  // dir with no task record — flag it (log-only, no auto-delete).
  if (existsSync(WORKTREE_ROOT)) {
    const referenced = new Set([...tasks.values()].map((t) => t.worktree));
    for (const d of readdirSync(WORKTREE_ROOT, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const full = join(WORKTREE_ROOT, d.name);
      if (!referenced.has(full)) log?.warn({ dir: full }, 'orphaned worktree dir — no task references it');
    }
  }
  sweepRetention();
  setInterval(sweepRetention, 3600_000).unref();
}

export function snapshotTasks() { return { tasks: [...tasks.values()], history }; }

// The whole autonomous workflow lives in this prompt — the daemon only stores
// column/state and kills the session on 'done'. Transitions are prompt-driven.
function buildTaskPrompt(t) {
  const tokenHeader = process.env.SING_TOKEN ? ' -H "x-sing-token: $SING_TOKEN"' : '';
  const status = (column, state) =>
    `curl -s -X POST http://127.0.0.1:${PORT}/tasks/${t.id}/status${tokenHeader} -H "content-type: application/json" -d '{"column":"${column}","state":"${state}"}'`;
  return `You are the orchestrator for the task "${t.title}" on a kanban board.

## Requirements

${t.description}

## Environment

- You are in a dedicated git worktree (${t.worktree}) on branch ${t.branch}, branched from ${t.baseBranch} of the main repo at ${t.repo}. Do all work here.
- Merge policy: ${t.mergeMode === 'auto' ? `after the review passes, merge ${t.branch} into ${t.baseBranch} in the main repo (git -C "${t.repo}" merge ${t.branch}). If the merge conflicts, abort it and park the task instead (see below).` : `leave the branch for the user to merge — do NOT merge or push.`}
- You move your own task card by calling the board API with Bash (curl). Update the card at every phase change as instructed below. The "state" field is a short free-text phase label shown on the card.

## Workflow

1. **Analyze** the requirements against the codebase. If anything is ambiguous or underspecified, ask the user clarifying questions here in this terminal and wait for their answers. While waiting, run:
   ${status('todo', 'clarifying')}
2. **Plan** the implementation.${t.requirePlanApproval ? ` Present the plan here and wait for the user to approve it before writing any code. While waiting, run:
   ${status('todo', 'awaiting plan approval')}` : ' No user approval of the plan is required — proceed once your questions (if any) are answered.'}
3. **Implement**: first run
   ${status('inprogress', 'implementing')}
   then implement the plan. Use the Task tool with subagents (model: sonnet) for the implementation work where it helps; small changes you may do directly.
4. **Review**: commit your work on ${t.branch}, then run
   ${status('inreview', 'reviewing')}
   and spawn a reviewer subagent via the Task tool with model: opus. The reviewer must independently examine the diff against the requirements and return a verdict: PASS, or REJECT with concrete feedback on what must change.
5. **On REJECT**: run
   ${status('inprogress', 'fixing (review N/' + MAX_REVIEW_REJECTS + ')')}
   (N = rejection count), have a sonnet subagent implement the fixes, commit, and go back to step 4. After ${MAX_REVIEW_REJECTS} rejections, stop: run
   ${status('inreview', 'parked — needs human')}
   summarize the blockers here in the terminal, and end your involvement.
6. **On PASS**: apply the merge policy above (if it conflicts: run ${status('inreview', 'parked — merge conflict')} and stop). Then conclude with a one-line summary of what was done and run
   ${status('done', 'complete')}
   as your very last action — the daemon terminates this session when the card reaches done.`;
}

export function createTask({ repo, title, description, model, scopes, requirePlanApproval, mergeMode }) {
  if (!repo || !title?.trim() || !description?.trim()) throw new Error('repo, title and description required');
  const baseBranch = git(repo, 'rev-parse', '--abbrev-ref', 'HEAD'); // also validates repo is git
  const id = randomUUID();
  const short = id.slice(0, 8);
  const branch = `task/${short}`;
  const worktree = join(WORKTREE_ROOT, short);
  mkdirSync(WORKTREE_ROOT, { recursive: true });
  git(repo, 'worktree', 'add', worktree, '-b', branch);
  const t = {
    id, title: title.trim(), description: description.trim(), repo, worktree, branch, baseBranch,
    model, scopes, requirePlanApproval: !!requirePlanApproval, mergeMode: mergeMode === 'auto' ? 'auto' : 'manual',
    column: 'todo', state: 'analyzing', sessionId: null, createdAt: Date.now(), updatedAt: Date.now(),
  };
  // Statusline capture: per-session cost/duration written to APP_DIR/cost/<id>.json
  // (read by stats.mjs). Passed as extraArgs so it also survives reattach.
  const extraArgs = ['--settings', JSON.stringify({ statusLine: { type: 'command', command: `node "${STATUSLINE_SCRIPT}"` } })];
  try {
    const agent = reg.create({ cwd: worktree, name: t.title, model, scopes, prompt: buildTaskPrompt(t), permissionMode: 'acceptEdits', extraArgs });
    t.sessionId = agent.id;
  } catch (e) {
    try { git(repo, 'worktree', 'remove', '--force', worktree); git(repo, 'branch', '-D', branch); } catch {}
    throw e;
  }
  tasks.set(id, t);
  persist();
  emitTasks();
  return t;
}

export function updateTask(id, { column, state }) {
  const t = tasks.get(id);
  if (!t) throw new Error('no such task');
  if (column !== undefined) {
    if (!COLUMNS.includes(column)) throw new Error(`bad column (expected ${COLUMNS.join('|')})`);
    const wasDone = t.column === 'done';
    t.column = column;
    if (column === 'done' && !wasDone) {
      t.doneAt = Date.now();
      // Task concluded — kill the pty so the session (and its cost) ends here.
      if (reg.isLive(t.sessionId)) reg.kill(t.sessionId);
    } else if (column !== 'done' && wasDone) {
      delete t.doneAt;
    }
  }
  if (state !== undefined) t.state = String(state).slice(0, 120);
  t.updatedAt = Date.now();
  persist();
  emitTasks();
  return t;
}

// Full cleanup (kill session, remove worktree, keep branch) + move to history
// with a stats snapshot. Replaces the old hard-delete for board cards:
// 'abandoned' from any column, 'completed' when removing a Done card (or via
// the retention sweep).
export async function concludeTask(id, outcome) {
  if (outcome !== 'completed' && outcome !== 'abandoned') throw new Error('bad outcome (expected completed|abandoned)');
  const t = tasks.get(id);
  if (!t) throw new Error('no such task');
  const finalStats = t.sessionId ? statsFor([{ id: t.sessionId, cwd: t.worktree }])[t.sessionId] : null;
  const wasLive = reg.isLive(t.sessionId);
  if (wasLive) reg.kill(t.sessionId);
  // Windows: the just-killed pty process may still hold file locks for a
  // moment — wait for it to actually die before removing the worktree, or
  // `git worktree remove` fails and orphans the dir.
  for (let waited = 0; wasLive && reg.isLive(t.sessionId) && waited < 3000; waited += 200) await sleep(200);
  // Worktree goes; the task branch stays (it may hold unmerged work).
  try { git(t.repo, 'worktree', 'remove', '--force', t.worktree); }
  catch (e) {
    logger?.warn({ err: e.message }, 'worktree remove failed — retrying once');
    await sleep(1000);
    try { git(t.repo, 'worktree', 'remove', '--force', t.worktree); }
    catch (e2) { logger?.warn({ err: e2.message }, 'worktree remove retry failed (already gone?)'); }
  }
  tasks.delete(id);
  history.push({ ...t, outcome, concludedAt: Date.now(), finalStats });
  persist();
  emitTasks();
}

export function deleteHistory(id) {
  const before = history.length;
  history = history.filter((h) => h.id !== id);
  if (history.length === before) throw new Error('no such history entry');
  persist();
  emitTasks();
}

// Done cards older than RETENTION_MS auto-conclude ('completed') so the board
// doesn't accumulate stale cards forever; the history entry keeps the record.
async function sweepRetention() {
  const cutoff = Date.now() - RETENTION_MS;
  for (const t of [...tasks.values()]) {
    if (t.column === 'done' && t.doneAt && t.doneAt < cutoff) {
      try { await concludeTask(t.id, 'completed'); }
      catch (e) { logger?.warn({ err: e.message, id: t.id }, 'retention sweep: conclude failed'); }
    }
  }
}
