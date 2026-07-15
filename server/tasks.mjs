// Task board: tasks.json persistence, one git worktree + agent session per
// task, workflow prompt. Columns move via POST /tasks/:id/status — called by
// the task's own agent (curl, prompt-instructed) or by a UI drag. Emits
// 'tasks' on the shared agents bus; pty-ws fans it out.
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import * as reg from './agents.mjs';
import { isClaudeModel } from './models.mjs';
import { statsFor } from './stats.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATUSLINE_SCRIPT = join(__dirname, 'statusline-capture.mjs');

const TASKS_FILE = join(reg.STATE_DIR, 'tasks.json');
const WORKTREE_ROOT = reg.WORKTREES_DIR;
// Ticket artifacts (Requirements.md + Plan.md) live under state/ — stable and
// cwd-independent, since a task's working directory varies (worktree or arbitrary
// repo) and the source of truth can't live there.
const TICKETS_ROOT = join(reg.STATE_DIR, 'tickets');
const COLUMNS = ['todo', 'inprogress', 'inreview', 'done'];
const PORT = Number(process.env.PORT);
const MAX_REVIEW_REJECTS = 3;
const RETENTION_MS = 7 * 24 * 3600 * 1000; // Done cards auto-conclude to history after this long.

const tasks = new Map(); // id -> task record (plain object, see plan/data model)
let history = []; // concluded tasks: task fields + outcome, concludedAt, finalStats
let logger = null;

function git(repo, ...args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

function isGitWorkTree(repo) {
  try { return git(repo, 'rev-parse', '--is-inside-work-tree') === 'true'; }
  catch { return false; }
}

function persist() {
  try {
    writeFileSync(TASKS_FILE + '.tmp', JSON.stringify({ tasks: [...tasks.values()], history }, null, 2));
    renameSync(TASKS_FILE + '.tmp', TASKS_FILE); // atomic swap — a crash mid-write never truncates TASKS_FILE
  } catch (e) { logger?.warn({ err: e.message }, 'tasks.json write failed'); }
}

function emitTasks() { reg.bus.emit('tasks', snapshotTasks()); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

// Caveman plugin (user scope) ships compressed cavecrew subagents — usable from
// any cwd. Detected from ~/.claude/settings.json enabledPlugins.
function cavecrewAvailable() {
  try {
    const s = JSON.parse(readFileSync(join(homedir(), '.claude', 'settings.json'), 'utf8'));
    return Object.keys(s.enabledPlugins || {}).some((k) => k.startsWith('caveman@'));
  } catch { return false; }
}

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
export function buildTaskPrompt(t, cavecrew = cavecrewAvailable()) {
  const tokenHeader = process.env.SING_TOKEN ? ' -H "x-sing-token: $SING_TOKEN"' : '';
  const status = (column, state) =>
    `curl -s -X POST http://127.0.0.1:${PORT}/tasks/${t.id}/status${tokenHeader} -H "content-type: application/json" -d '{"column":"${column}","state":"${state}"}'`;
  // Subagent model routing: an ollama model runs the whole fleet on that same
  // model (saves Claude budget); a claude model splits impl=sonnet, reviewer=opus.
  const ollama = !isClaudeModel(t.model);
  const implModel = ollama ? t.model : 'sonnet';
  const reviewerModel = ollama ? t.model : 'opus';
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
  const implSpawn = implAgent
    ? `Use the Task tool with subagents (subagent_type: "${implAgent}", model: ${implModel}) for the implementation work where it helps; small changes you may do directly. The subagent def carries this repo's stack rules — still tell subagents to keep changes minimal (no speculative abstractions or features) and to use lean-ctx (ctx_read/ctx_search) over native Read for bulk reads.`
    : `Use the Task tool with subagents (model: ${implModel}) for the implementation work where it helps; small changes you may do directly. Tell subagents to keep changes minimal (no speculative abstractions or features) and to use lean-ctx (ctx_read/ctx_search) over native Read for bulk reads.${cavecrew ? ' For read-only exploration (locating code, mapping structure, listing usages), spawn subagent_type: "caveman:cavecrew-investigator" instead of a generic subagent — its output is compressed.' : ''}`;
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
- You move your own task card by calling the board API with Bash (curl). Update the card at every phase change as instructed below. The "state" field is a short free-text phase label shown on the card.

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
   ${status('inprogress', 'fixing (review N/' + MAX_REVIEW_REJECTS + ')')}
   (N = rejection count), have a ${fixSub} implement the fixes and go back to step 4. After ${MAX_REVIEW_REJECTS} rejections, stop: run
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
- You move your own task card by calling the board API with Bash (curl). Update the card at every phase change as instructed below. The "state" field is a short free-text phase label shown on the card.

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
   ${status('inprogress', 'fixing (review N/' + MAX_REVIEW_REJECTS + ')')}
   (N = rejection count), have a ${fixSub} implement the fixes, commit, and go back to step 4. After ${MAX_REVIEW_REJECTS} rejections, stop: run
   ${status('inreview', 'parked — needs human')}
   summarize the blockers here in the terminal, and end your involvement.
6. **On PASS**: apply the merge policy above (if it conflicts: run ${status('inreview', 'parked — merge conflict')} and stop). Then conclude with a one-line summary of what was done and run
   ${status('done', 'complete')}
   as your very last action — the daemon terminates this session when the card reaches done.`;
}

export function createTask({ repo, title, description, model, scopes, requirePlanApproval, mergeMode }) {
  if (!repo || !title?.trim() || !description?.trim()) throw new Error('repo, title and description required');
  if (!existsSync(repo)) throw new Error('working directory does not exist');
  const kind = isGitWorkTree(repo) ? 'git' : 'plain';
  const id = randomUUID();
  const short = id.slice(0, 8);
  let baseBranch = null, branch = null, worktree = null, cwd = repo;
  if (kind === 'git') {
    baseBranch = git(repo, 'rev-parse', '--abbrev-ref', 'HEAD');
    branch = `task/${short}`;
    worktree = join(WORKTREE_ROOT, short);
    mkdirSync(WORKTREE_ROOT, { recursive: true });
    git(repo, 'worktree', 'add', worktree, '-b', branch);
    cwd = worktree;
  }
  const ticketDir = join(TICKETS_ROOT, short);
  mkdirSync(ticketDir, { recursive: true });
  writeFileSync(join(ticketDir, 'Requirements.md'), `# ${title.trim()}\n\n${description.trim()}\n`);
  const t = {
    id, title: title.trim(), description: description.trim(), repo, kind, worktree, branch, baseBranch, ticketDir,
    model, scopes, requirePlanApproval: !!requirePlanApproval, mergeMode: kind === 'git' ? (mergeMode === 'auto' ? 'auto' : 'manual') : null,
    column: 'todo', state: 'analyzing', sessionId: null, createdAt: Date.now(), updatedAt: Date.now(),
  };
  // Statusline capture: per-session cost/duration written to state/cost/<id>.json
  // (read by stats.mjs). Passed as extraArgs so it also survives reattach.
  const extraArgs = ['--settings', JSON.stringify({ statusLine: { type: 'command', command: `node "${STATUSLINE_SCRIPT}"` } })];
  try {
    const agent = reg.create({ cwd, name: t.title, model, scopes, prompt: buildTaskPrompt(t), permissionMode: 'acceptEdits', extraArgs });
    t.sessionId = agent.id;
  } catch (e) {
    if (kind === 'git') { try { git(repo, 'worktree', 'remove', '--force', worktree); git(repo, 'branch', '-D', branch); } catch {} }
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
      // Task concluded — remove the session outright (kills the pty, ending its
      // cost) so it drops off the session list instead of lingering as 'exited'.
      if (t.sessionId) reg.remove(t.sessionId);
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
  const finalStats = t.sessionId ? statsFor([{ id: t.sessionId, cwd: t.worktree ?? t.repo }])[t.sessionId] : null;
  const wasLive = reg.isLive(t.sessionId);
  if (wasLive) reg.kill(t.sessionId);
  // Windows: the just-killed pty process may still hold file locks for a
  // moment — wait for it to actually die before removing the worktree, or
  // `git worktree remove` fails and orphans the dir.
  for (let waited = 0; wasLive && reg.isLive(t.sessionId) && waited < 3000; waited += 200) await sleep(200);
  if (t.kind !== 'plain') {
    // Worktree goes; the task branch stays (it may hold unmerged work).
    try { git(t.repo, 'worktree', 'remove', '--force', t.worktree); }
    catch (e) {
      logger?.warn({ err: e.message }, 'worktree remove failed — retrying once');
      await sleep(1000);
      try { git(t.repo, 'worktree', 'remove', '--force', t.worktree); }
      catch (e2) { logger?.warn({ err: e2.message }, 'worktree remove retry failed (already gone?)'); }
    }
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
