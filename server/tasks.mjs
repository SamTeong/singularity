// Task board: tasks.json persistence, one git worktree + agent session per
// task, workflow prompt. Columns move via POST /tasks/:id/status — called by
// the task's own agent (curl, prompt-instructed) or by a UI drag. Emits
// 'tasks' on the shared agents bus; pty-ws fans it out.
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as reg from './agents.mjs';
import { getModelRoute } from './models.mjs';
import { statsFor } from './stats.mjs';

const TASKS_FILE = join(reg.STATE_DIR, 'tasks.json');
const WORKTREE_ROOT = reg.WORKTREES_DIR;
// Ticket artifacts (Requirements.md + Plan.md) live at the repo root (trusted —
// so Claude honors repo-controllable permissions) — stable and cwd-independent,
// since a task's working directory varies (worktree or arbitrary repo) and the
// source of truth can't live there.
const TICKETS_ROOT = reg.TICKETS_DIR;
const REPORTS_ROOT = reg.REPORTS_DIR;
const COLUMNS = ['todo', 'inprogress', 'inreview', 'done'];
// Per-column state vocabulary (SSOT). updateTask hard-rejects a state that
// isn't valid for its column. OVERLAY_STATES may appear on any column —
// transient, set by the log-tail watcher, cleared on the next real transition.
const STATES = {
  todo: ['analyzing', 'clarifying', 'awaiting plan approval'],
  inprogress: ['working', 'implementing', 'fixing'],
  inreview: ['reviewing', 'parked — needs human', 'parked — merge conflict', 'awaiting human merge', 'awaiting human review', 'stopped — budget'],
  done: ['complete', 'report ready'],
};
// usage-limited = Claude plan limit; rate-limited = a plain 429.
const OVERLAY_STATES = ['usage-limited', 'rate-limited'];
// Same var index.mjs listens on — the prompts below embed it in the status-curl
// URL every task agent posts to, so a mismatch here is a silent NaN port.
const PORT = Number(process.env.DAEMON_PORT);
const MAX_REVIEW_REJECTS = 3;
const RETENTION_MS = 7 * 24 * 3600 * 1000; // Done cards auto-conclude to history after this long.
export const USAGE_LIMIT_RE = /reached your session usage limit/;
export const RATE_LIMIT_RE = /Request rejected \(429\)/;
const RATE_LIMIT_TAIL_CHARS = 400;
// Escape sequences (CSI, OSC, other ESC forms) and C0 controls except \t \n \r.
const ANSI_RE = new RegExp([
  '\\x1b\\[[0-?]*[ -/]*[@-~]',
  '\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)',
  '\\x1b[ -/]*[0-~]',
  '[\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f]',
].join('|'), 'g');
// TUI repaints are mostly escapes; match limit phrases on the visible text.
export function stripAnsi(s) { return s.replace(ANSI_RE, ''); }

// Overlay for a rolling output tail. The plan-limit phrase wins: Claude's
// usage-limit error arrives as a 429 carrying it.
export function classifyLimit(tail) {
  if (USAGE_LIMIT_RE.test(tail)) return 'usage-limited';
  if (RATE_LIMIT_RE.test(tail)) return 'rate-limited';
  return null;
}

const RESET_RE = /\bresets?(?:\s+at)?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*\(([^)]+)\))?/i;

// Wall clock of `tz` at `at` read as UTC, minus `at`: the zone's offset.
function zoneOffsetMs(tz, at) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric',
  }).formatToParts(at).map((p) => [p.type, p.value]));
  return Date.UTC(+parts.year, parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second) - Math.floor(at / 1000) * 1000;
}

// Best-effort epoch ms of the limit reset named in the tail ("resets 3pm",
// "reset at 3:30pm (Europe/Zurich)", "resets 15:00"): the next such wall-clock
// time after `now`, in the named zone or the host zone. Unparsable -> null.
export function parseLimitResetAt(tail, now = Date.now()) {
  const m = RESET_RE.exec(tail);
  if (!m || (!m[2] && !m[3])) return null;
  let hour = Number(m[1]);
  const minute = Number(m[2] ?? 0);
  const meridiem = m[3]?.toLowerCase();
  if (minute > 59) return null;
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (meridiem === 'pm' ? 12 : 0);
  } else if (hour > 23) return null;
  const tz = m[4]?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone;
  try {
    const today = new Date(now + zoneOffsetMs(tz, now));
    for (let day = 0; day <= 1; day += 1) {
      const wall = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + day, hour, minute);
      const at = wall - zoneOffsetMs(tz, wall - zoneOffsetMs(tz, wall));
      if (at > now) return at;
    }
  } catch { /* unknown zone */ }
  return null;
}

const tasks = new Map(); // id -> task record (plain object, see plan/data model)
const taskBySession = new Map(); // sessionId -> taskId: reverse index so the output-listener rate-limit scan is O(1), not a linear find over all tasks per PTY chunk. Set where a task's sessionId is assigned (createTask), dropped where the session leaves the board for good (done-transition, conclude).
let history = []; // concluded tasks: task fields + outcome, concludedAt, finalStats
let logger = null;
// Rolling output tail per session id, for rate-limit detection (see initTasks).
// Cleared wherever a task's session leaves the board for good (done-transition,
// conclude) so this never grows across a daemon's lifetime.
const tails = new Map();
const limitTimers = new Map(); // taskId -> timeout clearing its usage limit at limitResetAt

let gitBackend = null;
// Hard timeout + non-interactive flags on every git call: this runs on the
// request path (route handlers, awaited below), and a hung subprocess — a
// credential-helper prompt is the classic case — must never block forever.
// GIT_TERMINAL_PROMPT/GIT_ASKPASS/core.askpass cover *nix-style prompts;
// GCM_INTERACTIVE is Windows Git Credential Manager, what this machine uses.
// Overridable via SING_GIT_TIMEOUT_MS for tests that need a short bound.
const GIT_TIMEOUT_MS = Number(process.env.SING_GIT_TIMEOUT_MS) || 10_000;
// Absolute path from .env when set; else `git` on PATH (execFile resolves it).
const GIT_BIN = process.env.GIT_BIN || 'git';
const GIT_OPTS = {
  encoding: 'utf8', timeout: GIT_TIMEOUT_MS, killSignal: 'SIGKILL',
  env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_ASKPASS: 'echo' },
};

// Async — used by every request-path caller so a slow/hung git process can't
// block the event loop (and freeze live PTY agents + WS clients).
export function setTasksBackend(backend) { gitBackend = backend; }

export async function git(repo, ...args) {
  if (!gitBackend) throw new Error('Rust backend is not configured for Git');
  try {
    return (await gitBackend.git(GIT_BIN, ['-C', repo, '-c', 'core.askpass=', ...args], {
      timeout: GIT_TIMEOUT_MS, maxBuffer: 1024 * 1024,
      env: GIT_OPTS.env,
    })).stdout.trim();
  } catch (e) {
    throw new Error(`git ${args.join(' ')} failed: ${e.message}`, { cause: e });
  }
}
async function isGitWorkTree(repo) {
  try { return await git(repo, 'rev-parse', '--is-inside-work-tree') === 'true'; }
  catch { return false; }
}

function persist(nextTasks = tasks, nextHistory = history) {
  try {
    reg.writeAtomic(TASKS_FILE, JSON.stringify({ tasks: [...nextTasks.values()], history: nextHistory }, null, 2)); // atomic swap — a crash mid-write never truncates TASKS_FILE
  } catch (e) {
    logger?.warn({ err: e.message }, 'tasks.json write failed');
    const err = new Error(`tasks.json write failed: ${e.message}`);
    err.persistFailure = true; // flags a genuine disk write failure vs. a validation error — index.mjs routes surface it as 500
    throw err;
  }
}

function emitTasks() { reg.bus.emit('tasks', snapshotTasks()); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

// Remove a git task's worktree and safe-delete its branch. `-d` deletes a
// merged branch (Done ⟹ merged) and refuses an unmerged one, so a stray
// unmerged branch is never nuked. Async: a just-killed pty may still hold
// Windows file locks, so retry the worktree removal once after a beat.
export async function cleanupGitTask(t) {
  if (t.kind === 'plain') return;
  if (existsSync(t.worktree)) {
    try { await git(t.repo, 'worktree', 'remove', '--force', t.worktree); }
    catch (e) {
      logger?.warn({ err: e.message }, 'worktree remove failed — retrying once');
      await sleep(1000);
      try { await git(t.repo, 'worktree', 'remove', '--force', t.worktree); }
      catch (e2) { logger?.warn({ err: e2.message }, 'worktree remove retry failed (already gone?)'); }
    }
  }
  try { await git(t.repo, 'branch', '-d', t.branch); }
  catch { /* unmerged — keep the branch */ }
}

// Recreate a git task's worktree when it's gone (cleaned on Done, then the card
// moved back). Reuse the branch if it still exists (unmerged work kept), else
// branch fresh off the current base — a clean slate on top of the merged work.
// No-op if the worktree is already present.
export async function ensureWorktree(t) {
  if (t.kind === 'plain' || existsSync(t.worktree)) return;
  mkdirSync(WORKTREE_ROOT, { recursive: true });
  let branchExists = true;
  try { await git(t.repo, 'rev-parse', '--verify', `refs/heads/${t.branch}`); } catch { branchExists = false; }
  if (branchExists) await git(t.repo, 'worktree', 'add', t.worktree, t.branch);
  else await git(t.repo, 'worktree', 'add', t.worktree, '-b', t.branch, t.baseBranch);
}

// Caveman plugin (user scope) ships compressed cavecrew subagents — usable from
// any cwd. Opt-in via SING_CAVECREW=1 in .env (external plugin, not shipped).
function cavecrewAvailable() {
  return process.env.SING_CAVECREW === '1';
}

export function initTasks(log) {
  logger = log;
  try {
    if (existsSync(TASKS_FILE)) {
      const data = JSON.parse(readFileSync(TASKS_FILE, 'utf8'));
      for (const t of data.tasks || []) tasks.set(t.id, { transitions: [], ...t });
      for (const t of tasks.values()) if (t.sessionId) taskBySession.set(t.sessionId, t.id);
      history = (data.history || []).map((h) => ({ transitions: [], ...h })); // old tasks.json shape { tasks } has no history — defaults []; same default for records saved before transition history existed
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
  // A crash after the durable transition but before its cleanup is safe to
  // retry: Done tasks still need their session/worktree reclaimed, while a
  // reopened git task may need its worktree recreated.
  for (const t of tasks.values()) {
    if (t.column === 'done') serialized(() => finishDoneTask(t)).catch((e) => log?.warn({ err: e.message, id: t.id }, 'done-task recovery failed'));
    else if (t.kind === 'git' && !existsSync(t.worktree)) serialized(() => ensureWorktree(t)).catch((e) => log?.warn({ err: e.message, id: t.id }, 'worktree recovery failed'));
  }
  for (const t of tasks.values()) syncLimitTimer(t); // persisted usage limits clear at their reset
  sweepRetention();
  setInterval(sweepRetention, 3600_000).unref();
  // Usage limits and Ollama 429s surface only in the pty stream — flag the card
  // so it doesn't sit looking idle. Rolling tail (ANSI-stripped) absorbs chunk
  // splits. Output only ever enters an overlay: Claude's TUI repaints while it
  // waits, so a tail without the phrase proves nothing. Input or the reset
  // timer clears it.
  reg.bus.on('output', async ({ id, data }) => {
    const tid = taskBySession.get(id);
    const t = tid ? tasks.get(tid) : null;
    if (!t || t.column === 'done') return;
    const tail = ((tails.get(id) || '') + stripAnsi(data)).slice(-RATE_LIMIT_TAIL_CHARS);
    tails.set(id, tail);
    const kind = classifyLimit(tail);
    if (!kind || OVERLAY_STATES.includes(t.state)) return;
    await serialized(() => updateTaskInner(t.id, { state: kind }, { limitResetAt: parseLimitResetAt(tail) }))
      .catch((e) => logger?.warn({ err: e.message, id }, 'rate-limit update failed'));
  });
  // Input to a limited session is a resume attempt: clear the overlay and drop
  // the stale tail. If the limit still holds, Claude reprints the phrase and
  // the output watcher re-flags. Escape-only input (focus/mouse reports, arrow
  // keys) is not a resume.
  reg.bus.on('input', async ({ id, data }) => {
    const tid = taskBySession.get(id);
    const t = tid ? tasks.get(tid) : null;
    if (!t || !OVERLAY_STATES.includes(t.state) || !stripAnsi(String(data))) return;
    tails.delete(id);
    await serialized(() => clearLimitInner(t.id)).catch((e) => logger?.warn({ err: e.message, id }, 'limit clear failed'));
  });
}

// Keep one timer per usage-limited task, firing at its limitResetAt; any other
// state (cleared, re-set, concluded) cancels it. Delays past setTimeout's
// 32-bit cap re-arm on fire instead of clearing early.
function syncLimitTimer(t) {
  clearTimeout(limitTimers.get(t.id));
  limitTimers.delete(t.id);
  if (t.state !== 'usage-limited' || t.limitResetAt == null) return;
  const at = t.limitResetAt;
  limitTimers.set(t.id, setTimeout(() => {
    limitTimers.delete(t.id);
    const cur = tasks.get(t.id);
    if (!cur || cur.state !== 'usage-limited' || cur.limitResetAt !== at) return;
    if (Date.now() < at) return syncLimitTimer(cur);
    if (cur.sessionId) tails.delete(cur.sessionId);
    serialized(() => clearLimitInner(cur.id)).catch((e) => logger?.warn({ err: e.message, id: cur.id }, 'limit clear failed'));
  }, Math.min(Math.max(0, at - Date.now()), 2 ** 31 - 1)).unref());
}

// Drop a limit overlay: restore the state it covered (the column's first state
// when a column move made that one invalid) and drop the limit fields. A
// state-only update, so no transition record. No-op when not limited.
function clearLimitInner(id) {
  const t = tasks.get(id);
  if (!t || !OVERLAY_STATES.includes(t.state)) return t;
  const { limitPrevState, limitResetAt, ...next } = t;
  const allowed = STATES[next.column] ?? [];
  next.state = allowed.includes(limitPrevState) ? limitPrevState : (allowed[0] ?? limitPrevState ?? t.state);
  next.updatedAt = Date.now();
  const staged = new Map(tasks);
  staged.set(id, next);
  persist(staged);
  tasks.set(id, next);
  syncLimitTimer(next);
  emitTasks();
  return next;
}

export function snapshotTasks() { return { tasks: [...tasks.values()], history }; }

// Codex tasks are single-agent (codex has no Task tool / subagents): a minimal
// prompt that skips the orchestrator/subagent/reviewer dance entirely. Same
// board-status curl contract so the card still moves through columns + the
// daemon reclaims the worktree on Done.
export function buildCodexTaskPrompt(t) {
  const tokenHeader = process.env.SING_TOKEN ? ' -H "x-sing-token: $SING_TOKEN"' : '';
  const status = (column, state) =>
    `curl -s -X POST http://127.0.0.1:${PORT}/api/tasks/${t.id}/status${tokenHeader} -H "content-type: application/json" -d '{"column":"${column}","state":"${state}"}'`;
  const cwd = t.worktree || t.repo;
  const gitLine = t.kind === 'git'
    ? `\n- You are in a git worktree on branch ${t.branch}. ${t.mergeMode === 'auto' ? `After review, merge ${t.branch} into ${t.baseBranch} (git -C "${t.repo}" merge ${t.branch}); abort if it conflicts.` : `Leave the branch for the user to merge — do NOT merge or push.`}`
    : '';
  return `You are working on the task "${t.title}".

## Requirements

${t.description}

## Environment

- You are working in \`${cwd}\`.${gitLine}
- Ticket artifacts live in \`${t.ticketDir}\`: read \`Requirements.md\` for the requirements; write \`Plan.md\` before implementing if helpful.
- Write your \`Report.md\` to \`${t.reportDir}\` when done.

## Workflow

1. Read \`Requirements.md\` in \`${t.ticketDir}\`. If anything is ambiguous, ask the user here and wait.
2. Plan the implementation, write it to \`${t.ticketDir}/Plan.md\`.
3. Implement: run
   ${status('inprogress', 'implementing')}
   then do the work. Keep changes minimal — no speculative abstractions or features.
4. Review your own work against the requirements.
5. Write \`Report.md\` to \`${t.reportDir}\` summarizing what you did, then run
   ${status('done', 'complete')}
   as your very last action — the daemon ends this session when the card reaches Done.`;
}

// Codex background variant: same unattended contract as buildBackgroundPrompt
// but without the subagent references (codex has no Task tool).
export function buildCodexBackgroundPrompt(t) {
  const cwd = t.worktree || t.repo;
  const tokenHeader = process.env.SING_TOKEN ? ' -H "x-sing-token: $SING_TOKEN"' : '';
  const status = (column, state) =>
    `curl -s -X POST http://127.0.0.1:${PORT}/api/tasks/${t.id}/status${tokenHeader} -H "content-type: application/json" -d '{"column":"${column}","state":"${state}"}'`;
  const lastStep = t.conclude === 'done'
    ? `As your LAST action, move the card to Done:
  ${status('done', 'report ready')}`
    : `As your LAST action, move the card to In Review:
  ${status('inreview', 'awaiting human review')}
  Do NOT move the card to done — a human concludes the run.`;
  return `You are an unattended background agent working on "${t.title}".

## Requirements

${t.description}

## Environment

- You are working directly in \`${cwd}\`. Do the work described above in place.
- Ticket artifacts live in \`${t.ticketDir}\`: \`Requirements.md\` (already written for you).
- Write your \`Report.md\` to \`${t.reportDir}\` — a persistent store kept across cleanups.

## Rules

- NO clarifying questions, NO plan-approval step — just do the work directly and efficiently. Nobody is watching this terminal.
- At the START, run:
  ${status('inprogress', 'working')}
- When the work is done, write \`Report.md\` to \`${t.reportDir}\` summarizing what you did / found / proposed, and print a short summary in this terminal.
- ${lastStep}`;
}

// The whole autonomous workflow lives in this prompt — the daemon only stores
// column/state and kills the session on 'done'. Transitions are prompt-driven.
export async function buildTaskPrompt(t, cavecrew = cavecrewAvailable(), route) {
  route ??= await getModelRoute(t.model, t.tool);
  if (t.tool === 'codex' || route.isCodexModel) return buildCodexTaskPrompt(t);
  const tokenHeader = process.env.SING_TOKEN ? ' -H "x-sing-token: $SING_TOKEN"' : '';
  const status = (column, state) =>
    `curl -s -X POST http://127.0.0.1:${PORT}/api/tasks/${t.id}/status${tokenHeader} -H "content-type: application/json" -d '{"column":"${column}","state":"${state}"}'`;
  // Subagent model routing: an ollama model runs the whole fleet on that same
  // model (saves Claude budget); a claude model splits impl=sonnet, reviewer=opus.
  const ollama = !route.isClaudeModel;
  // Ollama models have no prompt caching — every turn resends the full
  // context, so nudge the orchestrator toward fewer, batched turns.
  const turnEconomy = ollama ? `\n- Your model has no prompt caching — every turn resends the full context. Minimize turns: batch the board status curl together with your next Bash command instead of running it alone, avoid re-reading files you have already seen, and prefer one larger subagent over many small ones.` : '';
  // Impl/reviewer models: explicit dialog overrides win; else the claude split
  // (impl=sonnet, reviewer=opus) or, for ollama, mirror the orchestrator model.
  const implModel = t.implModel || (ollama ? t.model : 'sonnet');
  const reviewerModel = t.reviewerModel || (ollama ? t.model : 'opus');
  // Per-role max-turn caps from the dialog. Soft — the orchestrator runs as an
  // interactive pty, so --max-turns/CLAUDE_CODE_MAX_TURNS (print-mode only) can't
  // hard-kill it, and the Agent tool takes no inline maxTurns. The orchestrator
  // self-limits and relays subagent caps in the spawn prompt.
  const turnCaps = [];
  if (t.orchestratorMaxTurns) turnCaps.push(`orchestrator ≤${t.orchestratorMaxTurns}`);
  if (t.implMaxTurns) turnCaps.push(`implementor subagent ≤${t.implMaxTurns}`);
  if (t.reviewerMaxTurns) turnCaps.push(`reviewer subagent ≤${t.reviewerMaxTurns}`);
  const turnBudget = turnCaps.length
    ? `\n- Turn budgets (soft — self-enforced, no hard kill): ${turnCaps.join(', ')}. Stay within your own cap; for subagents, include "stop after ≤N turns" in the spawn prompt and wrap up when reached.`
    : '';
  // Project agent defs: if the task's cwd ships .claude/agents/<role>.md, route
  // subagents through that def (it carries the repo's stack + security rules)
  // instead of a generic Task-tool subagent. Discovery is deterministic here —
  // the orchestrator just uses the name we hand it. Defs are only present when
  // tracked in the repo (worktrees check out tracked files), so absent → generic
  // fallback. Model override still applies (defs have no model pin). When no
  // def exists and the user-scope caveman plugin is enabled, fall back further
  // to caveman's global compressed cavecrew subagents instead of generic ones.
  const taskCwd = t.worktree || t.repo;
  const hasDef = (name) => existsSync(join(taskCwd, '.claude', 'agents', `${name}.md`));
  const implAgent = hasDef('senior-software-engineer') ? 'senior-software-engineer'
    : hasDef('junior-software-engineer') ? 'junior-software-engineer' : null;
  const reviewerAgent = hasDef('reviewer') ? 'reviewer' : null;
  // Keep subagent fan-out and file I/O bounded — large subagent output eats
  // context fast, especially for ollama models with no prompt caching.
  const subagentEconomy = ` Run at most 3 subagents concurrently. Have each subagent write its full output to a file under \`${t.ticketDir}\` and return only a short summary (≤10 lines) — keep large results out of your context.`;
  const implSpawn = implAgent
    ? `Use the Task tool with subagents (subagent_type: "${implAgent}", model: ${implModel}) for the implementation work where it helps; small changes you may do directly. The subagent def carries this repo's stack rules — still tell subagents to keep changes minimal (no speculative abstractions or features).${subagentEconomy}`
    : `Use the Task tool with subagents (model: ${implModel}) for the implementation work where it helps; small changes you may do directly. Tell subagents to keep changes minimal (no speculative abstractions or features).${cavecrew ? ' For read-only exploration (locating code, mapping structure, listing usages), spawn subagent_type: "caveman:cavecrew-investigator" instead of a generic subagent — its output is compressed.' : ''}${subagentEconomy}`;
  const fixSub = implAgent
    ? `subagent (subagent_type: "${implAgent}", model: ${implModel})`
    : `${implModel} subagent`;
  const reviewSpawn = (examine) => reviewerAgent
    ? `spawn a reviewer subagent via the Task tool (subagent_type: "${reviewerAgent}", model: ${reviewerModel}). The reviewer def carries this repo's security checklist; the reviewer must ${examine} against the requirements and plan in \`${t.ticketDir}\` (\`Requirements.md\` + \`Plan.md\`) and return a verdict: PASS, or REJECT with concrete feedback`
    : cavecrew
      ? `spawn a reviewer subagent via the Task tool (subagent_type: "caveman:cavecrew-reviewer", model: ${reviewerModel}). The reviewer must ${examine} against the requirements and plan in \`${t.ticketDir}\` (\`Requirements.md\` + \`Plan.md\`) and return a verdict: PASS, or REJECT with concrete feedback`
      : `spawn a reviewer subagent via the Task tool with model: ${reviewerModel}. The reviewer must ${examine} against the requirements and plan in \`${t.ticketDir}\` (\`Requirements.md\` + \`Plan.md\`) and return a verdict: PASS, or REJECT with concrete feedback`;
  const intro = `You are the orchestrator for the task "${t.title}" on a kanban board.

## Requirements

${t.description}`;
  if (t.kind === 'plain') {
    return `${intro}

## Environment

- You are working directly in \`${t.repo}\` (not a git repo). Make all changes in place.
- Ticket artifacts live in \`${t.ticketDir}\`: \`Requirements.md\` (the requirements, already written for you) and \`Plan.md\` (you write it during planning). This is the stable source of truth — you and your subagents read from here, not the working directory.
- You move your own task card by calling the board API with Bash (curl). Update the card at every phase change as instructed below. The "state" field is a short free-text phase label shown on the card.${turnEconomy}${turnBudget}

## Workflow

1. **Analyze** the requirements against the codebase. If anything is ambiguous or underspecified, ask the user clarifying questions here in this terminal and wait for their answers. While waiting, run:
   ${status('todo', 'clarifying')}
2. **Plan** the implementation.${t.requirePlanApproval ? ` Present the plan here and wait for the user to approve it before writing any code. While waiting, run:
   ${status('todo', 'awaiting plan approval')}` : ' No user approval of the plan is required — proceed once your questions (if any) are answered.'} Write the finalized plan to \`${t.ticketDir}/Plan.md\` before implementing.
3. **Implement**: first run
   ${status('inprogress', 'implementing')}
   then implement the plan. ${implSpawn}
4. **Review**: run
   ${status('inreview', 'reviewing')}
   and ${reviewSpawn('independently examine the files you changed')}.
5. **On REJECT**: run
   ${status('inprogress', 'fixing')}
   have a ${fixSub} implement the fixes and go back to step 4. After ${MAX_REVIEW_REJECTS} rejections, stop: run
   ${status('inreview', 'parked — needs human')}
   summarize the blockers here in the terminal, and end your involvement.
6. **On PASS**: conclude with a one-line summary of what was done and run
   ${status('done', 'complete')}
   as your very last action — the daemon terminates this session when the card reaches done.`;
  }
  return `${intro}

## Environment

- You are in a dedicated git worktree (${t.worktree}) on branch ${t.branch}, branched from ${t.baseBranch} of the main repo at ${t.repo}. Do all work here.
- Merge policy: ${t.mergeMode === 'auto' ? `after the review passes, merge ${t.branch} into ${t.baseBranch} in the main repo (git -C "${t.repo}" merge ${t.branch}). If the merge conflicts, abort it and park the task instead (see below).` : `leave the branch for the user to merge — do NOT merge or push.`}
- Ticket artifacts live in \`${t.ticketDir}\`: \`Requirements.md\` (the requirements, already written for you) and \`Plan.md\` (you write it during planning). This is the stable source of truth — you and your subagents read from here, not the working directory.
- You move your own task card by calling the board API with Bash (curl). Update the card at every phase change as instructed below. The "state" field is a short free-text phase label shown on the card.${turnEconomy}${turnBudget}

## Workflow

1. **Analyze** the requirements against the codebase. If anything is ambiguous or underspecified, ask the user clarifying questions here in this terminal and wait for their answers. While waiting, run:
   ${status('todo', 'clarifying')}
2. **Plan** the implementation.${t.requirePlanApproval ? ` Present the plan here and wait for the user to approve it before writing any code. While waiting, run:
   ${status('todo', 'awaiting plan approval')}` : ' No user approval of the plan is required — proceed once your questions (if any) are answered.'} Write the finalized plan to \`${t.ticketDir}/Plan.md\` before implementing.
3. **Implement**: first run
   ${status('inprogress', 'implementing')}
   then implement the plan. ${implSpawn}
4. **Review**: commit your work on ${t.branch}, then run
   ${status('inreview', 'reviewing')}
   and ${reviewSpawn('independently examine the diff')} on what must change.
5. **On REJECT**: run
   ${status('inprogress', 'fixing')}
   have a ${fixSub} implement the fixes, commit, and go back to step 4. After ${MAX_REVIEW_REJECTS} rejections, stop: run
   ${status('inreview', 'parked — needs human')}
   summarize the blockers here in the terminal, and end your involvement.
6. **On PASS**: apply the merge policy above.${t.mergeMode === 'auto'
  ? ` If it conflicts, run ${status('inreview', 'parked — merge conflict')} and stop. Otherwise conclude with a one-line summary of what was done and run
   ${status('done', 'complete')}
   as your very last action — the daemon ends this session and reclaims the worktree when the card reaches Done.`
  : ` Do NOT merge — leave ${t.branch} for a human. Conclude with a one-line summary of what was done and run
   ${status('inreview', 'awaiting human merge')}
   as your very last action — a human reviews, merges, and moves the card to Done.`}`;
}

// Normalize free-form tags: trim, lowercase, drop blanks, dedupe.
export function normalizeTags(tags) {
  return [...new Set((tags || []).map((s) => String(s).trim().toLowerCase()).filter(Boolean))];
}

// Unattended variant of the workflow prompt for background quota-soak runs: no
// clarifying questions, no plan approval, no impl/reviewer subagent dance — just
// do the work, write a report, and hand the card to a human for review. The
// daemon's watchdog (background.mjs) stops the run when the budget is spent.
export async function buildBackgroundPrompt(t, route) {
  route ??= await getModelRoute(t.model, t.tool);
  if (t.tool === 'codex' || route.isCodexModel) return buildCodexBackgroundPrompt(t);
  const cwd = t.worktree || t.repo;
  const tokenHeader = process.env.SING_TOKEN ? ' -H "x-sing-token: $SING_TOKEN"' : '';
  const status = (column, state) =>
    `curl -s -X POST http://127.0.0.1:${PORT}/api/tasks/${t.id}/status${tokenHeader} -H "content-type: application/json" -d '{"column":"${column}","state":"${state}"}'`;
  // conclude 'done' trusts the report enough to auto-conclude the card; default
  // 'inreview' hands it to a human. The watchdog's budget-kill path always
  // forces inreview regardless of this setting (see background.mjs watchdog()).
  const lastStep = t.conclude === 'done'
    ? `As your LAST action, move the card to Done:
  ${status('done', 'report ready')}`
    : `As your LAST action, move the card to In Review:
  ${status('inreview', 'awaiting human review')}
  Do NOT move the card to done — a human concludes the run.`;
  return `You are an unattended background agent working on "${t.title}".

## Requirements

${t.description}

## Environment

- You are working directly in \`${cwd}\`. Do the work described above in place.
- Ticket artifacts live in \`${t.ticketDir}\`: \`Requirements.md\` (already written for you).
- Write your \`Report.md\` to \`${t.reportDir}\` — a persistent store kept across cleanups, NOT the ticket dir.

## Rules

- NO clarifying questions, NO plan-approval step, NO impl/reviewer subagent workflow — just do the work directly and efficiently. Nobody is watching this terminal.
- At the START, run:
  ${status('inprogress', 'working')}
- When the work is done, write \`Report.md\` to \`${t.reportDir}\` summarizing what you did / found / proposed, and print a short summary in this terminal.
- ${lastStep}`;
}

// Max-turn cap from the dialog: positive int or null (empty/0/invalid → no cap).
const posInt = (v) => { const n = Math.trunc(Number(v)); return Number.isFinite(n) && n > 0 ? n : null; };

export async function createTask({ repo, title, description, model, implModel, reviewerModel, orchestratorMaxTurns, implMaxTurns, reviewerMaxTurns, scopes, requirePlanApproval, mergeMode, mock, tags, promptOverride, permissionSettings, background, backgroundJobId, backgroundRunId, conclude, tool }) {
  if (!repo || !title?.trim() || !description?.trim()) throw new Error('repo, title and description required');
  const modelRoute = await getModelRoute(model, tool);
  if (modelRoute.toolModelError) throw new Error(modelRoute.toolModelError);
  if (!existsSync(repo)) throw new Error('working directory does not exist');
  const kind = await isGitWorkTree(repo) ? 'git' : 'plain';
  const id = randomUUID();
  const short = id.slice(0, 8);
  let baseBranch = null, branch = null, worktree = null, cwd = repo;
  if (kind === 'git') {
    baseBranch = await git(repo, 'rev-parse', '--abbrev-ref', 'HEAD');
    branch = `task/${short}`;
    worktree = join(WORKTREE_ROOT, short);
    mkdirSync(WORKTREE_ROOT, { recursive: true });
    await git(repo, 'worktree', 'add', worktree, '-b', branch);
    cwd = worktree;
  }
  // Everything from here on can fail (disk, spawn, ...) after `git worktree
  // add` already succeeded — on any failure, best-effort clean up the
  // worktree/branch before rethrowing so it doesn't orphan.
  try {
    const ticketDir = join(TICKETS_ROOT, short);
    mkdirSync(ticketDir, { recursive: true });
    writeFileSync(join(ticketDir, 'Requirements.md'), `# ${title.trim()}\n\n${description.trim()}\n`);
    // Background reports go to a persistent .reports/<short> the hygiene sweep
    // leaves alone; the transient ticketDir holds only working artifacts.
    let reportDir = ticketDir;
    if (background) { reportDir = join(REPORTS_ROOT, short); mkdirSync(reportDir, { recursive: true }); }
    const t = {
      id, title: title.trim(), description: description.trim(), repo, kind, worktree, branch, baseBranch, ticketDir, reportDir,
      model, implModel, reviewerModel,
      orchestratorMaxTurns: posInt(orchestratorMaxTurns), implMaxTurns: posInt(implMaxTurns), reviewerMaxTurns: posInt(reviewerMaxTurns),
      scopes, tags: normalizeTags(tags), requirePlanApproval: !!requirePlanApproval, mergeMode: kind === 'git' ? (mergeMode === 'auto' ? 'auto' : 'manual') : null,
      column: 'todo', state: 'analyzing', transitions: [], sessionId: null, createdAt: Date.now(), updatedAt: Date.now(),
      ...(background ? { conclude: conclude === 'done' ? 'done' : 'inreview' } : {}),
      ...(backgroundJobId ? { backgroundJobId } : {}),
      ...(backgroundRunId ? { backgroundRunId } : {}),
      ...(tool ? { tool } : {}),
    };
    // Cost is captured by the global statusline (harness-usage-report skill,
    // from ~/.claude/settings.json) writing the full payload to cost-state/<id>.json,
    // read by stats.mjs — no per-task statusline override. permissionSettings
    // (e.g. background-run deny rules) still ride --settings as a sibling key.
    const extraArgs = ['--settings', JSON.stringify(permissionSettings || {})];
    // mock (demo only): spawn an idle claude with no workflow prompt — a live
    // session for the status pill, but no turn ever starts, so zero tokens. The
    // demo driver moves the card itself. Real tasks always get the prompt.
    const prompt = mock ? undefined : (promptOverride ?? (background ? await buildBackgroundPrompt(t, modelRoute) : await buildTaskPrompt(t, cavecrewAvailable(), modelRoute)));
    const agent = await reg.create({ cwd, title: t.title, model, scopes, prompt, permissionMode: 'acceptEdits', extraArgs, mock, tool, modelRoute });
    t.sessionId = agent.id;
    taskBySession.set(agent.id, id);
    tasks.set(id, t);
    persist();
    emitTasks();
    return t;
  } catch (e) {
    if (kind === 'git') { try { await git(repo, 'worktree', 'remove', '--force', worktree); await git(repo, 'branch', '-D', branch); } catch {} }
    throw e;
  }
}

// Serialize all task mutations: the done-transition below awaits a ≤3s
// pty-death wait mid-update, and an un-awaited bus listener (rate-limit
// detection, see initTasks) can fire updateTask concurrently on the same or a
// different task — without this, the two can interleave across that await and
// clobber state/updatedAt. Single-user local daemon + rare overlap, so a
// process-wide chain (vs. a per-task lock) is the simplest correct fix.
let mutationChain = Promise.resolve();
function serialized(fn) {
  const result = mutationChain.then(fn, fn);
  mutationChain = result.then(() => {}, () => {}); // keep the chain alive past a rejection
  return result;
}

export function updateTask(id, body) {
  return serialized(() => updateTaskInner(id, body));
}

// `limitResetAt` is internal (the output watcher's parsed reset), never body.
async function updateTaskInner(id, { column, state, actor, source, reason }, { limitResetAt = null } = {}) {
  const t = tasks.get(id);
  if (!t) throw new Error('no such task');
  const next = { ...t };
  const wasDone = t.column === 'done';
  if (column !== undefined) {
    if (!COLUMNS.includes(column)) throw new Error(`bad column (expected ${COLUMNS.join('|')})`);
    next.column = column;
    if (column === 'done' && !wasDone) {
      next.doneAt = Date.now();
      next.state = 'complete'; // clear stale agent state (e.g. "awaiting human review") on manual move; matches auto-flow done state, explicit state param below still wins
    } else if (column !== 'done' && wasDone) {
      delete next.doneAt;
    }
    // Durable transition record — appended only on a real column change, so
    // state-only updates (incl. rate-limited overlays) leave no trace.
    if (t.column !== column) {
      next.transitions = [...(t.transitions ?? []), {
        from: t.column, to: column, at: Date.now(),
        ...(actor !== undefined ? { actor: String(actor).trim().slice(0, 120) } : {}),
        ...(source !== undefined ? { source: String(source).trim().slice(0, 120) } : {}),
        ...(reason !== undefined ? { reason: String(reason).trim().slice(0, 120) } : {}),
      }];
    }
  }
  if (state !== undefined) {
    const col = column ?? next.column;
    const s = String(state).slice(0, 120);
    const allowed = [...(STATES[col] ?? []), ...OVERLAY_STATES];
    if (!allowed.includes(s)) throw new Error(`bad state for ${col} (expected ${allowed.join('|')})`);
    // Entering a limit overlay remembers the state it covers; any real state
    // ends the overlay and its limit fields.
    if (!OVERLAY_STATES.includes(s)) {
      delete next.limitPrevState;
      delete next.limitResetAt;
    } else if (!OVERLAY_STATES.includes(t.state)) {
      next.limitPrevState = t.state;
      if (s === 'usage-limited' && limitResetAt != null) next.limitResetAt = limitResetAt;
    }
    next.state = s;
  }
  next.updatedAt = Date.now();
  const staged = new Map(tasks);
  staged.set(id, next);
  // Make the transition durable before its irreversible process/worktree work.
  persist(staged);
  tasks.set(id, next);
  syncLimitTimer(next);
  emitTasks();
  if (column === 'done' && !wasDone) await finishDoneTask(next);
  else if (column !== undefined && column !== 'done' && wasDone) await ensureWorktree(next);
  return next;
}

async function finishDoneTask(t) {
  // Idempotent recovery work for a durable Done transition. A later failure
  // never turns a killed process or removed worktree back into a live task.
  if (t.sessionId) {
    taskBySession.delete(t.sessionId);
    const wasLive = reg.isLive(t.sessionId);
    reg.remove(t.sessionId);
    tails.delete(t.sessionId);
    for (let waited = 0; wasLive && reg.isLive(t.sessionId) && waited < 3000; waited += 200) await sleep(200);
  }
  await cleanupGitTask(t);
}

// Full cleanup (kill session, remove worktree, keep branch) + move to history
// with a stats snapshot. Replaces the old hard-delete for board cards:
// 'abandoned' from any column, 'completed' when removing a Done card (or via
// the retention sweep).
// Routed through the same serialized() chain as updateTask: this mutates task
// state across several `await`s (stats lookup, pty-death wait, worktree
// removal). Two concurrent conclusions on the same id would otherwise
// interleave — cleanupGitTask running twice, history getting a half-applied
// snapshot. serialized() makes the second call wait for the first to fully
// finish, then re-reads task state below and no-ops instead of double-cleaning.
export async function concludeTask(id, outcome) {
  return serialized(() => concludeTaskInner(id, outcome));
}

async function concludeTaskInner(id, outcome) {
  if (outcome !== 'completed' && outcome !== 'abandoned') throw new Error('bad outcome (expected completed|abandoned)');
  const t = tasks.get(id);
  if (!t) {
    // Already concluded by a call that ran earlier in this same chain — the
    // first caller's result stands, so this is a no-op, not an error.
    if (history.some((h) => h.id === id)) return;
    throw new Error('no such task');
  }
  const finalStats = t.sessionId ? (await statsFor([{ id: t.sessionId, cwd: t.worktree ?? t.repo }]))[t.sessionId] : null;
  const wasLive = reg.isLive(t.sessionId);
  if (wasLive) reg.kill(t.sessionId);
  if (t.sessionId) tails.delete(t.sessionId); // session concluded for good — stop tracking its rate-limit tail
  // Windows: the just-killed pty process may still hold file locks for a
  // moment — wait for it to actually die before removing the worktree, or
  // `git worktree remove` fails and orphans the dir.
  for (let waited = 0; wasLive && reg.isLive(t.sessionId) && waited < 3000; waited += 200) await sleep(200);
  await cleanupGitTask(t);
  if (t.sessionId) taskBySession.delete(t.sessionId);
  tasks.delete(id);
  syncLimitTimer({ id }); // concluded: cancel a pending reset timer
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
  const now = Date.now();
  const cutoff = now - RETENTION_MS;
  for (const t of [...tasks.values()]) {
    // Backstop for the reset timer: a usage limit past its parsed reset
    // clears; its stale tail goes too, so the old phrase can't re-flag the card.
    if (t.state === 'usage-limited' && t.limitResetAt != null && now >= t.limitResetAt) {
      if (t.sessionId) tails.delete(t.sessionId);
      await serialized(() => clearLimitInner(t.id)).catch((e) => logger?.warn({ err: e.message, id: t.id }, 'limit clear failed'));
    }
    if (t.column === 'done' && t.doneAt && t.doneAt < cutoff) {
      try { await concludeTask(t.id, 'completed'); }
      catch (e) { logger?.warn({ err: e.message, id: t.id }, 'retention sweep: conclude failed'); }
    }
  }
}
