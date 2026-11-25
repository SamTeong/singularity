// buildTaskPrompt branches on whether the task's cwd ships project agent defs
// (.claude/agents/<role>.md). These checks pin that branching: defs present →
// subagents routed via subagent_type; absent → generic fallback, or (with the
// caveman plugin enabled) the cavecrew fallback.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, existsSync, realpathSync, readdirSync, chmodSync, renameSync, readFileSync, cpSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Route app state to scratch before importing tasks.mjs — it pulls in agents.mjs
// → app-dir.mjs, which requires SINGULARITY_HOME at load. Static imports are
// hoisted above this assignment, so a dynamic import is required.
const scratch = mkdtempSync(join(tmpdir(), 'sing-tasks-'));
process.env.SINGULARITY_HOME = join(scratch, 'sing');
process.env.SING_TRUSTED_ROOT = join(scratch, 'trusted');
// agents.mjs captures OLLAMA_BIN/CODEX_BIN once at load. Clear them here (before
// import) so the "failed spawn cleans up" tests get a deterministic buildSpawn
// throw regardless of whether ollama/codex is installed on the machine running
// the suite.
delete process.env.OLLAMA_BIN;
delete process.env.CODEX_BIN;
// tasks.mjs captures the daemon port at load, from the same DAEMON_PORT
// index.mjs listens on. Pin it (before the import) so the status-curl assertion
// below is decisive rather than dependent on the machine's .env.
process.env.DAEMON_PORT = '4999';
// Shrinks git()'s hard timeout (default 10s in prod) so the hang-detection
// test below stays cheap; real git calls in this file finish in well under
// 3s, so this doesn't make the other git-backed tests flaky.
process.env.SING_GIT_TIMEOUT_MS = '3000';

const modelStore = await import('./model-store.mjs');
const modelBackend = (await import('./rust-backend.mjs')).createRustBackend();
await modelBackend.start();
modelStore.setModelsBackend(modelBackend);
const taskModule = await import('./tasks.mjs');
taskModule.setTasksBackend(modelBackend);
after(async () => {
  await modelBackend.stop();
  rmSync(scratch, { recursive: true, force: true });
});

const { buildTaskPrompt, buildBackgroundPrompt, buildCodexTaskPrompt, buildCodexBackgroundPrompt, createTask, updateTask, concludeTask, snapshotTasks, initTasks, RATE_LIMIT_RE, classifyLimit, parseLimitResetAt, cleanupGitTask, ensureWorktree } = taskModule;
const reg = await import('./agents.mjs');

// Built once; each test copies it (git spawns are the cost on Windows).
const TEMPLATE_REPO = (() => {
  const repo = mkdtempSync(join(tmpdir(), 'sing-repo-tpl-'));
  execFileSync('git', ['-C', repo, 'init', '-q']);
  execFileSync('git', ['-C', repo, 'config', 'user.email', 'x@x.com']);
  execFileSync('git', ['-C', repo, 'config', 'user.name', 'x']);
  writeFileSync(join(repo, 'f.txt'), 'x');
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'init']);
  return repo;
})();
after(() => rmRepo(TEMPLATE_REPO));

function initRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'sing-repo-'));
  cpSync(TEMPLATE_REPO, repo, { recursive: true });
  return repo;
}

// git writes loose objects read-only (mode 444), and rmSync won't clear that —
// on win32 it fails EPERM. Make everything writable first, then delete.
function rmRepo(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) rmRepo(p);
    else chmodSync(p, 0o666);
  }
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (let retries = 0; ; retries++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      break;
    } catch (error) {
      if (!['EPERM', 'EBUSY', 'ENOTEMPTY'].includes(error.code) || retries >= 5) throw error;
      Atomics.wait(pause, 0, 0, 100);
    }
  }
}

const baseTask = {
  id: 't1', title: 'T', description: 'D', model: 'sonnet',
  kind: 'git', repo: '/r', worktree: null, branch: 'b', baseBranch: 'main',
  ticketDir: '/tickets/t1', requirePlanApproval: false, mergeMode: 'manual',
};

function withAgents(files) {
  const cwd = mkdtempSync(join(tmpdir(), 'sing-agents-'));
  if (files.length) {
    mkdirSync(join(cwd, '.claude', 'agents'), { recursive: true });
    for (const f of files) writeFileSync(join(cwd, '.claude', 'agents', f), '---\nname: x\n---\n');
  }
  return cwd;
}

test('project agent defs present → subagents routed via subagent_type', async () => {
  const cwd = withAgents(['reviewer.md', 'senior-software-engineer.md']);
  const p = await buildTaskPrompt({ ...baseTask, worktree: cwd }, false);
  assert.match(p, /subagent_type: "reviewer"/);
  assert.match(p, /subagent_type: "senior-software-engineer"/);
  assert.match(p, /security checklist/);
  rmSync(cwd, { recursive: true, force: true });
});

test('no defs → generic fallback, no subagent_type', async () => {
  const cwd = withAgents([]);
  const p = await buildTaskPrompt({ ...baseTask, worktree: cwd }, false);
  assert.doesNotMatch(p, /subagent_type/);
  assert.match(p, /spawn a reviewer subagent via the Task tool with model/);
  rmSync(cwd, { recursive: true, force: true });
});

test('only junior def → impl routes to junior-software-engineer', async () => {
  const cwd = withAgents(['junior-software-engineer.md']);
  const p = await buildTaskPrompt({ ...baseTask, worktree: cwd }, false);
  assert.match(p, /subagent_type: "junior-software-engineer"/);
  assert.doesNotMatch(p, /senior-software-engineer/);
  rmSync(cwd, { recursive: true, force: true });
});

test('no defs + caveman plugin → cavecrew fallback', async () => {
  const cwd = withAgents([]);
  const p = await buildTaskPrompt({ ...baseTask, worktree: cwd }, true);
  assert.match(p, /subagent_type: "caveman:cavecrew-reviewer"/);
  assert.match(p, /caveman:cavecrew-investigator/);
  rmSync(cwd, { recursive: true, force: true });
});

test('project defs win over cavecrew', async () => {
  const cwd = withAgents(['reviewer.md', 'senior-software-engineer.md']);
  const p = await buildTaskPrompt({ ...baseTask, worktree: cwd }, true);
  assert.doesNotMatch(p, /cavecrew/);
  assert.match(p, /subagent_type: "reviewer"/);
  rmSync(cwd, { recursive: true, force: true });
});

test('subagent economy guidance in prompt', async () => {
  const cwd = withAgents([]);
  const p = await buildTaskPrompt({ ...baseTask, worktree: cwd }, false);
  assert.match(p, /at most 3 subagents/);
  assert.match(p, /write its full output to a file/);
  rmSync(cwd, { recursive: true, force: true });
});

test('ollama model → turn-economy guidance', async () => {
  const cwd = withAgents([]);
  const p = await buildTaskPrompt({ ...baseTask, model: 'glm-5.2:cloud', worktree: cwd }, false);
  assert.match(p, /no prompt caching/);
  assert.match(p, /batch the board status curl/);
  assert.match(p, /model: glm-5.2:cloud/);
  rmSync(cwd, { recursive: true, force: true });
});

test('claude model → no turn-economy bullet', async () => {
  const p = await buildTaskPrompt(baseTask, false);
  assert.doesNotMatch(p, /no prompt caching/);
});

test('max-turn caps injected when set', async () => {
  const p = await buildTaskPrompt({ ...baseTask, orchestratorMaxTurns: 30, implMaxTurns: 20, reviewerMaxTurns: 10 }, false);
  assert.match(p, /orchestrator ≤30/);
  assert.match(p, /implementor subagent ≤20/);
  assert.match(p, /reviewer subagent ≤10/);
  assert.match(p, /soft — self-enforced/);
});

test('no turn-budget bullet when caps absent', async () => {
  const p = await buildTaskPrompt(baseTask, false);
  assert.doesNotMatch(p, /Turn budgets/);
});

test('claude model, no overrides → impl=sonnet, reviewer=opus', async () => {
  const p = await buildTaskPrompt(baseTask, false);
  assert.match(p, /model: sonnet\b/);
  assert.match(p, /model: opus\b/);
});

test('impl/reviewer overrides win over the claude defaults', async () => {
  const p = await buildTaskPrompt({ ...baseTask, implModel: 'haiku', reviewerModel: 'opus[1m]' }, false);
  assert.match(p, /model: haiku\b/);
  assert.match(p, /model: opus\[1m\]/);
  assert.doesNotMatch(p, /model: sonnet\b/);
});

test('ollama model, no overrides → impl+reviewer mirror the orchestrator', async () => {
  const cwd = withAgents([]);
  const p = await buildTaskPrompt({ ...baseTask, model: 'glm-5.2:cloud', worktree: cwd }, false);
  const hits = p.match(/model: glm-5\.2:cloud\b/g) || [];
  assert.ok(hits.length >= 2, 'both impl and reviewer spawns use the ollama model');
  rmSync(cwd, { recursive: true, force: true });
});

test('plain-kind prompt also gets turn-economy guidance', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'sing-plain-'));
  const p = await buildTaskPrompt({ ...baseTask, kind: 'plain', repo: cwd, worktree: null, mergeMode: null, model: 'glm-5.2:cloud' }, false);
  assert.match(p, /no prompt caching/);
  rmSync(cwd, { recursive: true, force: true });
});

test('buildTaskPrompt terminal column: mergeMode "auto" ends on done', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'sing-merge-'));
  const p = await buildTaskPrompt({ ...baseTask, worktree: cwd, mergeMode: 'auto' }, false);
  assert.match(p, /"column":"done"/);
  assert.match(p, /complete/);
  rmSync(cwd, { recursive: true, force: true });
});

test('buildTaskPrompt terminal column: mergeMode "manual" never reaches done', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'sing-merge-'));
  const p = await buildTaskPrompt({ ...baseTask, worktree: cwd, mergeMode: 'manual' }, false);
  assert.match(p, /awaiting human merge/);
  assert.doesNotMatch(p, /"column":"done"/);
  rmSync(cwd, { recursive: true, force: true });
});

// Every builder embeds the status-curl URL the agent posts its column moves to.
// Read the wrong env var and the port interpolates as NaN — nothing throws, the
// prompt still looks right, and every card silently stops moving.
test('every prompt builder embeds the daemon port in the status-curl URL', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'sing-port-'));
  const bg = { ...baseTask, kind: 'plain', repo: cwd, worktree: null, prompt: 'do it' };
  const prompts = [
    await buildTaskPrompt({ ...baseTask, worktree: cwd }, false),
    await buildBackgroundPrompt(bg),
    buildCodexTaskPrompt({ ...baseTask, worktree: cwd, tool: 'codex' }),
    buildCodexBackgroundPrompt({ ...bg, tool: 'codex' }),
  ];
  for (const p of prompts) {
    assert.match(p, /http:\/\/127\.0\.0\.1:4999\/api\/tasks\/t1\/status/);
    assert.doesNotMatch(p, /127\.0\.0\.1:NaN/);
  }
  rmSync(cwd, { recursive: true, force: true });
});

test('classifyLimit splits the Claude usage limit from a plain 429', async () => {
  assert.equal(classifyLimit('API Error: Request rejected (429) · you (x) have reached your session usage limit'), 'usage-limited');
  assert.equal(classifyLimit('reached your session usage limit'), 'usage-limited');
  assert.equal(classifyLimit('Request rejected (429)'), 'rate-limited');
  assert.match('Request rejected (429)', RATE_LIMIT_RE);
  assert.doesNotMatch('reached your session usage limit', RATE_LIMIT_RE);
  assert.equal(classifyLimit('session usage limit'), null);
  assert.equal(classifyLimit('HTTP 429'), null);
});

test('parseLimitResetAt reads the reset wall clock, best-effort', async () => {
  const now = Date.UTC(2026, 0, 10, 10, 0);
  assert.equal(parseLimitResetAt('limit · resets 3pm (UTC)', now), Date.UTC(2026, 0, 10, 15, 0));
  assert.equal(parseLimitResetAt('resets 15:00 (UTC)', now), Date.UTC(2026, 0, 10, 15, 0));
  // 17:00 in Zurich (UTC+1 in January): 3:30pm has passed, so tomorrow's.
  assert.equal(parseLimitResetAt('reset at 3:30pm (Europe/Zurich)', Date.UTC(2026, 0, 10, 16, 0)), Date.UTC(2026, 0, 11, 14, 30));
  const local = new Date(2026, 0, 10, 9, 0).getTime();
  assert.equal(parseLimitResetAt('resets 3pm', local), new Date(2026, 0, 10, 15, 0).getTime());
  for (const tail of ['resets soon', 'resets 3 times', 'resets 13pm', 'resets 3pm (Not/AZone)', 'no reset here']) {
    assert.equal(parseLimitResetAt(tail, now), null, tail);
  }
});

async function waitForTask(id, predicate, ms = 3000) {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 20))) {
    const t = snapshotTasks().tasks.find((x) => x.id === id);
    if (t && predicate(t)) return t;
  }
  return snapshotTasks().tasks.find((x) => x.id === id);
}

test('limit overlay: entered from ANSI-stripped output, never cleared by output, cleared by input, re-flagged by the phrase', async () => {
  const tasksFile = join(process.env.SINGULARITY_HOME, 'state', 'tasks.json');
  writeFileSync(tasksFile, JSON.stringify({
    tasks: [
      { id: 'lim-1', title: 'seed', description: 'd', column: 'inprogress', state: 'implementing', kind: 'plain', repo: '/r', sessionId: 'lim-sess-1' },
      { id: 'lim-2', title: 'seed', description: 'd', column: 'inprogress', state: 'working', kind: 'plain', repo: '/r', sessionId: 'lim-sess-2' },
    ],
    history: [],
  }));
  initTasks(null);
  const stateOf = (id) => snapshotTasks().tasks.find((x) => x.id === id).state;
  const pause = () => new Promise((r) => setTimeout(r, 100));

  reg.bus.emit('output', { id: 'lim-sess-1', data: '\x1b[31mreached your \x1b[1msession usage limit\x1b[0m · resets 3pm (UTC)' });
  let t = await waitForTask('lim-1', (x) => x.state === 'usage-limited');
  assert.equal(t.state, 'usage-limited');
  assert.equal(t.limitPrevState, 'implementing');
  assert.ok(Number.isFinite(t.limitResetAt) && t.limitResetAt > Date.now());

  // A TUI repaint: well over 400 bytes (and 400 visible chars), none of it the phrase.
  const repaint = `\x1b[2K\x1b[1G\x1b[38;5;246m${'─'.repeat(20)}\x1b[0m\r\n`.repeat(30);
  assert.ok(repaint.length > 400);
  reg.bus.emit('output', { id: 'lim-sess-1', data: repaint });
  await pause();
  assert.equal(stateOf('lim-1'), 'usage-limited', 'repaint output does not clear');

  reg.bus.emit('output', { id: 'lim-sess-1', data: 'reached your session usage limit' }); // back in the tail

  reg.bus.emit('input', { id: 'lim-sess-1', data: '\x1b[I' });
  await pause();
  assert.equal(stateOf('lim-1'), 'usage-limited', 'a focus report is not a resume');

  reg.bus.emit('input', { id: 'lim-sess-1', data: '\r' });
  t = await waitForTask('lim-1', (x) => x.state === 'implementing');
  assert.equal(t.state, 'implementing');
  assert.equal('limitPrevState' in t, false);
  assert.equal('limitResetAt' in t, false);
  assert.deepEqual(t.transitions, [], 'clearing adds no transition');

  reg.bus.emit('output', { id: 'lim-sess-1', data: ' ' });
  await pause();
  assert.equal(stateOf('lim-1'), 'implementing', 'the stale phrase was dropped with the tail');

  reg.bus.emit('output', { id: 'lim-sess-1', data: 'reached your session usage limit' });
  t = await waitForTask('lim-1', (x) => x.state === 'usage-limited');
  assert.equal(t.state, 'usage-limited', 'the phrase reappearing after input re-flags');

  reg.bus.emit('output', { id: 'lim-sess-2', data: 'API Error: Request rejected (429)' });
  t = await waitForTask('lim-2', (x) => x.state === 'rate-limited');
  assert.equal(t.state, 'rate-limited');
  assert.equal(t.limitPrevState, 'working');
  assert.equal('limitResetAt' in t, false);
});

test('limit overlay: the retention loop clears a usage limit past its reset', async () => {
  const tasksFile = join(process.env.SINGULARITY_HOME, 'state', 'tasks.json');
  writeFileSync(tasksFile, JSON.stringify({
    tasks: [
      { id: 'lim-due', title: 'seed', description: 'd', column: 'inprogress', state: 'usage-limited', limitPrevState: 'fixing', limitResetAt: Date.now() - 1000, kind: 'plain', repo: '/r', transitions: [] },
      { id: 'lim-later', title: 'seed', description: 'd', column: 'inprogress', state: 'usage-limited', limitPrevState: 'fixing', limitResetAt: Date.now() + 3600_000, kind: 'plain', repo: '/r', transitions: [] },
    ],
    history: [],
  }));
  initTasks(null);
  const t = await waitForTask('lim-due', (x) => x.state === 'fixing');
  assert.equal(t.state, 'fixing');
  assert.equal('limitResetAt' in t, false);
  assert.deepEqual(t.transitions, []);
  assert.equal(snapshotTasks().tasks.find((x) => x.id === 'lim-later').state, 'usage-limited');
});

test('limit overlay: a persisted usage limit clears at its reset time, not before', async () => {
  const tasksFile = join(process.env.SINGULARITY_HOME, 'state', 'tasks.json');
  writeFileSync(tasksFile, JSON.stringify({
    tasks: [{ id: 'lim-timer', title: 'seed', description: 'd', column: 'inprogress', state: 'usage-limited', limitPrevState: 'fixing', limitResetAt: Date.now() + 400, kind: 'plain', repo: '/r', transitions: [] }],
    history: [],
  }));
  initTasks(null);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(snapshotTasks().tasks.find((x) => x.id === 'lim-timer').state, 'usage-limited', 'not before the reset');
  const t = await waitForTask('lim-timer', (x) => x.state === 'fixing');
  assert.equal(t.state, 'fixing');
  assert.equal('limitResetAt' in t, false);
  assert.deepEqual(t.transitions, []);
});

// updateTask validates `state` against the per-column STATES map. Seeded
// directly into tasks.json + initTasks() (mirrors agents.test.mjs's
// seed-via-JSON + init() pattern) so this never goes through createTask's
// real agent spawn.
test('updateTask: state validated against the per-column STATES map', async () => {
  const tasksFile = join(process.env.SINGULARITY_HOME, 'state', 'tasks.json');
  writeFileSync(tasksFile, JSON.stringify({
    tasks: [{ id: 'seed-1', title: 'seed', description: 'd', column: 'inprogress', state: 'working', kind: 'plain', repo: '/r' }],
    history: [],
  }));
  initTasks(null);

  const ok = await updateTask('seed-1', { state: 'implementing' });
  assert.equal(ok.state, 'implementing');

  await assert.rejects(() => updateTask('seed-1', { state: 'reviewing' }), /bad state for inprogress/);

  const overlay = await updateTask('seed-1', { state: 'rate-limited' });
  assert.equal(overlay.state, 'rate-limited');
});

// Durable transition history: updateTaskInner appends a { from, to, at } record
// to the task's `transitions` array only on a real column change — state-only
// updates (incl. rate-limited overlays) leave no trace, and actor/source/reason
// ride along only when the caller supplies them in the POST body.
test('updateTask: column change appends a durable transition record', async () => {
  const tasksFile = join(process.env.SINGULARITY_HOME, 'state', 'tasks.json');
  writeFileSync(tasksFile, JSON.stringify({
    tasks: [{ id: 'seed-tr1', title: 'seed', description: 'd', column: 'todo', state: 'analyzing', kind: 'plain', repo: '/r' }],
    history: [],
  }));
  initTasks(null);

  const t = await updateTask('seed-tr1', { column: 'inprogress' });
  assert.equal(t.transitions.length, 1);
  assert.equal(t.transitions[0].from, 'todo');
  assert.equal(t.transitions[0].to, 'inprogress');
  assert.ok(Number.isFinite(t.transitions[0].at));
  // Durable: the record reached tasks.json, not just the in-memory map.
  // (Find by id — the module Map carries seeds from earlier tests, so [0] is
  // not this task.)
  const saved = JSON.parse(readFileSync(tasksFile, 'utf8'));
  assert.equal(saved.tasks.find((x) => x.id === 'seed-tr1').transitions.length, 1);
});

test('updateTask: state-only update (incl. overlay) appends no transition', async () => {
  const tasksFile = join(process.env.SINGULARITY_HOME, 'state', 'tasks.json');
  writeFileSync(tasksFile, JSON.stringify({
    tasks: [{ id: 'seed-tr2', title: 'seed', description: 'd', column: 'inprogress', state: 'working', kind: 'plain', repo: '/r' }],
    history: [],
  }));
  initTasks(null);

  await updateTask('seed-tr2', { state: 'fixing' });
  await updateTask('seed-tr2', { state: 'rate-limited' });
  assert.deepEqual(snapshotTasks().tasks.find((t) => t.id === 'seed-tr2').transitions, []);
});

test('updateTask: actor/source/reason recorded only when supplied, trimmed + capped at 120', async () => {
  const tasksFile = join(process.env.SINGULARITY_HOME, 'state', 'tasks.json');
  writeFileSync(tasksFile, JSON.stringify({
    tasks: [{ id: 'seed-tr3', title: 'seed', description: 'd', column: 'todo', state: 'analyzing', kind: 'plain', repo: '/r' }],
    history: [],
  }));
  initTasks(null);

  const bare = await updateTask('seed-tr3', { column: 'inprogress' });
  assert.deepEqual(Object.keys(bare.transitions[0]), ['from', 'to', 'at']);
  const rich = await updateTask('seed-tr3', { column: 'inreview', actor: '  sam  ', source: 'ui', reason: 'x'.repeat(200) });
  const rec = rich.transitions[1];
  assert.equal(rec.actor, 'sam');
  assert.equal(rec.source, 'ui');
  assert.equal(rec.reason, 'x'.repeat(120));
});

test('updateTask: done round trip leaves two transition records', async () => {
  const tasksFile = join(process.env.SINGULARITY_HOME, 'state', 'tasks.json');
  writeFileSync(tasksFile, JSON.stringify({
    tasks: [{ id: 'seed-tr4', title: 'seed', description: 'd', column: 'done', state: 'complete', kind: 'plain', repo: '/r' }],
    history: [],
  }));
  initTasks(null);

  await updateTask('seed-tr4', { column: 'inreview' });
  const t = await updateTask('seed-tr4', { column: 'done' });
  assert.deepEqual(t.transitions.map((r) => [r.from, r.to]), [['done', 'inreview'], ['inreview', 'done']]);
});

test('initTasks: old-shape task and history records load with transitions defaulted to []', async () => {
  const tasksFile = join(process.env.SINGULARITY_HOME, 'state', 'tasks.json');
  writeFileSync(tasksFile, JSON.stringify({
    tasks: [
      { id: 'seed-tr5', title: 'seed', description: 'd', column: 'todo', state: 'analyzing', kind: 'plain', repo: '/r' },
      { id: 'seed-tr6', title: 'seed', description: 'd', column: 'inprogress', state: 'working', kind: 'plain', repo: '/r', transitions: [{ from: 'todo', to: 'inprogress', at: 123 }] },
    ],
    history: [{ id: 'seed-tr5h', title: 'h', column: 'done', kind: 'plain', repo: '/r' }],
  }));
  initTasks(null);

  const snap = snapshotTasks();
  assert.deepEqual(snap.tasks.find((t) => t.id === 'seed-tr5').transitions, []);
  assert.deepEqual(snap.tasks.find((t) => t.id === 'seed-tr6').transitions, [{ from: 'todo', to: 'inprogress', at: 123 }]);
  assert.deepEqual(snap.history[0].transitions, []);
});

test('updateTask: failed Done persistence leaves the session and worktree untouched', async () => {
  const tasksFile = join(process.env.SINGULARITY_HOME, 'state', 'tasks.json');
  const worktree = mkdtempSync(join(scratch, 'pending-cleanup-'));
  writeFileSync(tasksFile, JSON.stringify({
    tasks: [{ id: 'seed-done-failure', title: 'seed', description: 'd', column: 'inprogress', state: 'working', kind: 'git', repo: scratch, worktree, branch: 'x', sessionId: 'not-a-live-session' }],
    history: [],
  }));
  initTasks(null);
  const backup = `${tasksFile}.backup`;
  renameSync(tasksFile, backup);
  mkdirSync(tasksFile);
  try {
    await assert.rejects(() => updateTask('seed-done-failure', { column: 'done' }), (err) => err.persistFailure === true);
    assert.equal(snapshotTasks().tasks.find((t) => t.id === 'seed-done-failure').column, 'inprogress');
    assert.equal(existsSync(worktree), true, 'cleanup cannot start before the durable transition');
  } finally {
    rmSync(tasksFile, { recursive: true });
    renameSync(backup, tasksFile);
    rmSync(worktree, { recursive: true, force: true });
  }
});

// concludeTask mutates task state across several awaits (statsFor, the pty-death
// wait, cleanupGitTask). Before it was routed through serialized(), two
// concurrent conclusions both read tasks.get(id) as present and both ran to
// completion — cleanupGitTask twice, two history rows for one task. The second
// caller must now see the first's result and no-op.
test('concludeTask: concurrent calls on the same task conclude it exactly once', async () => {
  const tasksFile = join(process.env.SINGULARITY_HOME, 'state', 'tasks.json');
  writeFileSync(tasksFile, JSON.stringify({
    tasks: [{ id: 'seed-cc', title: 'seed', description: 'd', column: 'done', state: 'complete', kind: 'plain', repo: '/r' }],
    history: [],
  }));
  initTasks(null);

  await Promise.all([concludeTask('seed-cc', 'completed'), concludeTask('seed-cc', 'completed')]);

  const snap = snapshotTasks();
  assert.equal(snap.history.filter((h) => h.id === 'seed-cc').length, 1);
  assert.equal(snap.tasks.some((t) => t.id === 'seed-cc'), false);
});

// git() runs on the request path, so a subprocess that never returns (the
// classic case is a credential-helper prompt) used to wedge the daemon forever.
// `hash-object --stdin` blocks reading a stdin that execFile never closes —
// a portable stand-in for that hang. It must lose to the timeout, not hang.
test('git: a hung subprocess loses to the hard timeout instead of blocking forever', async () => {
  // GIT_TIMEOUT_MS is read at module load: load a fresh copy with a 200 ms bound
  // so the hang costs 0.2 s, not the file-wide 3 s (usage.test.mjs isolated-import pattern).
  process.env.SING_GIT_TIMEOUT_MS = '200';
  const shortTasks = await import('./tasks.mjs?git-timeout-200');
  process.env.SING_GIT_TIMEOUT_MS = '3000';
  shortTasks.setTasksBackend(modelBackend);
  const repo = initRepo();
  try {
    await assert.rejects(() => shortTasks.git(repo, 'hash-object', '--stdin'), (error) => {
      assert.match(error.message, /git hash-object --stdin failed: Command failed:/);
      assert.equal(error.cause.signal, 'SIGKILL');
      assert.equal(error.cause.killed, true);
      return true;
    });
  } finally {
    rmRepo(repo);
  }
});

test('buildBackgroundPrompt: conclude "done" moves the card to done as the last action', async () => {
  const p = await buildBackgroundPrompt({ ...baseTask, conclude: 'done' });
  assert.match(p, /move the card to Done/);
  assert.match(p, /tasks\/t1\/status.*-d '\{"column":"done","state":"report ready"\}'/);
  assert.doesNotMatch(p, /Do NOT move the card to done/);
});
test('buildBackgroundPrompt: conclude "inreview" (or absent) keeps the human-review text verbatim', async () => {
  const p = await buildBackgroundPrompt({ ...baseTask, conclude: 'inreview' });
  const pAbsent = await buildBackgroundPrompt(baseTask);
  for (const prompt of [p, pAbsent]) {
    assert.match(prompt, /move the card to In Review/);
    assert.match(prompt, /Do NOT move the card to done — a human concludes the run\./);
  }
});

// createTask: a failure after `git worktree add` succeeds but before the task
// is persisted/spawned must not orphan the worktree. OLLAMA_BIN is cleared at
// the top of this file, so routing to a non-claude model makes reg.create's
// buildSpawn throw synchronously ("ollama not found") — a deterministic failure
// with no mocking needed.
test('createTask: failed spawn cleans up the worktree it just created', async () => {
  const repo = initRepo();
  try {
    await assert.rejects(
      () => createTask({ repo, title: 'T', description: 'D', model: 'not-a-claude-model', scopes: [] }),
      /ollama not found/,
    );
    const list = execFileSync('git', ['-C', repo, 'worktree', 'list'], { encoding: 'utf8' }).trim().split('\n');
    assert.equal(list.length, 1, 'only the main worktree should remain — task worktree was cleaned up');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ---- codex task prompt ----
// Codex tasks are single-agent (no Task tool / subagents): the prompt must
// contain the title + description and never reference subagents or the Task
// tool. buildTaskPrompt routes to buildCodexTaskPrompt via the early return.
test('buildCodexTaskPrompt: contains title/description, no Task tool/subagent references', async () => {
  const p = buildCodexTaskPrompt({ ...baseTask, title: 'My Codex Task', description: 'Do the thing', tool: 'codex' });
  assert.match(p, /My Codex Task/);
  assert.match(p, /Do the thing/);
  assert.doesNotMatch(p, /Task tool/);
  assert.doesNotMatch(p, /subagent/);
});

test('buildTaskPrompt: codex tool returns codex prompt (early return, no subagent refs)', async () => {
  const p = await buildTaskPrompt({ ...baseTask, title: 'C Task', description: 'C Desc', tool: 'codex' }, false);
  assert.match(p, /C Task/);
  assert.match(p, /C Desc/);
  assert.doesNotMatch(p, /subagent/);
  assert.doesNotMatch(p, /Task tool/);
});

test('buildBackgroundPrompt: codex tool returns codex background prompt (no subagent refs)', async () => {
  const p = await buildBackgroundPrompt({ ...baseTask, title: 'C Bg', description: 'C Bg Desc', tool: 'codex' });
  assert.match(p, /C Bg/);
  assert.match(p, /C Bg Desc/);
  assert.doesNotMatch(p, /subagent/);
});

// createTask with tool:'codex' but no CODEX_BIN (cleared at file top via the
// optional-env convention) → buildSpawn throws "codex not found" synchronously,
// and the worktree created just above is cleaned up. Mirrors the existing
// "not-a-claude-model" → ollama throw test.
test('createTask: codex tool with no CODEX_BIN throws /codex not found/ and cleans up the worktree', async () => {
  const repo = initRepo();
  try {
    await assert.rejects(
      () => createTask({ repo, title: 'T', description: 'D', model: 'gpt-5.3-codex-spark', scopes: [], tool: 'codex' }),
      /codex not found/,
    );
    const list = execFileSync('git', ['-C', repo, 'worktree', 'list'], { encoding: 'utf8' }).trim().split('\n');
    assert.equal(list.length, 1, 'only the main worktree should remain — task worktree was cleaned up');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('cleanupGitTask: merged branch → worktree removed, branch deleted', async () => {
  const repo = initRepo();
  const wtParent = mkdtempSync(join(tmpdir(), 'sing-wt-'));
  const wt = join(wtParent, 'wt');
  try {
    execFileSync('git', ['-C', repo, 'worktree', 'add', wt, '-b', 'task/x']);
    writeFileSync(join(wt, 'g.txt'), 'y');
    execFileSync('git', ['-C', wt, 'add', '.']);
    execFileSync('git', ['-C', wt, 'commit', '-q', '-m', 'work']);
    execFileSync('git', ['-C', repo, 'merge', 'task/x', '-q']);
    await cleanupGitTask({ kind: 'git', repo, worktree: wt, branch: 'task/x' });
    assert.equal(existsSync(wt), false);
    const list = execFileSync('git', ['-C', repo, 'branch', '--list', 'task/x'], { encoding: 'utf8' }).trim();
    assert.equal(list, '');
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(wtParent, { recursive: true, force: true });
  }
});

// State shared between the next two tests: an unmerged branch/worktree cleaned
// up by cleanupGitTask, then recreated by ensureWorktree.
let sharedRepo, sharedWt, sharedWtParent, sharedBase;

test('cleanupGitTask: unmerged branch → worktree removed, branch kept', async () => {
  sharedRepo = initRepo();
  sharedBase = execFileSync('git', ['-C', sharedRepo, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim();
  sharedWtParent = mkdtempSync(join(tmpdir(), 'sing-wt-'));
  sharedWt = join(sharedWtParent, 'wt');
  execFileSync('git', ['-C', sharedRepo, 'worktree', 'add', sharedWt, '-b', 'task/y']);
  writeFileSync(join(sharedWt, 'g.txt'), 'y');
  execFileSync('git', ['-C', sharedWt, 'add', '.']);
  execFileSync('git', ['-C', sharedWt, 'commit', '-q', '-m', 'work']);
  await cleanupGitTask({ kind: 'git', repo: sharedRepo, worktree: sharedWt, branch: 'task/y' });
  assert.equal(existsSync(sharedWt), false);
  const list = execFileSync('git', ['-C', sharedRepo, 'branch', '--list', 'task/y'], { encoding: 'utf8' }).trim();
  assert.match(list, /task\/y/);
});

test('ensureWorktree: recreates when missing, reusing the existing branch; no-op once present', async () => {
  try {
    await ensureWorktree({ kind: 'git', repo: sharedRepo, worktree: sharedWt, branch: 'task/y', baseBranch: sharedBase });
    assert.equal(existsSync(sharedWt), true);
    const wtList = execFileSync('git', ['-C', sharedRepo, 'worktree', 'list'], { encoding: 'utf8' });
    // Normalize both sides: the Windows CI runner's tmpdir() is an 8.3 short
    // path (RUNNER~1) while `git worktree list` emits the long form; realpath
    // (on the real path) + slash/case folding reconciles short/long + drive-
    // letter casing so the compare holds.
    const slash = (s) => s.replace(/\\/g, '/').toLowerCase();
    const wanted = slash(realpathSync.native(sharedWt));
    assert.ok(slash(wtList).includes(wanted), 'worktree list includes the recreated worktree');
    // ensureWorktree is async now — doesNotThrow can't see a rejection, so await it directly.
    await ensureWorktree({ kind: 'git', repo: sharedRepo, worktree: sharedWt, branch: 'task/y', baseBranch: sharedBase });
  } finally {
    rmSync(sharedRepo, { recursive: true, force: true });
    rmSync(sharedWtParent, { recursive: true, force: true });
  }
});

// initTasks must rebuild taskBySession reverse index from tasks.json so the
// rate-limit detection listener (reg.bus 'output') can find tasks by sessionId
// after a daemon restart. Without the fix, taskBySession.get(id) returns
// undefined for all persisted tasks, and rate-limited state never fires.
test('initTasks: rebuilds taskBySession reverse index from tasks.json for rate-limit detection', async () => {
  const tasksFile = join(process.env.SINGULARITY_HOME, 'state', 'tasks.json');
  const sessionId = 'session-persist-123';
  writeFileSync(tasksFile, JSON.stringify({
    tasks: [{ id: 'persist-1', title: 'Persisted', description: 'd', column: 'inprogress', state: 'working', kind: 'plain', repo: '/r', sessionId }],
    history: [],
  }));
  initTasks(null);

  // Verify the reverse index is populated: emit rate-limit output and check
  // that the task state transitions to 'rate-limited' (the listener uses
  // taskBySession to find the task, so this only works if the index was rebuilt).
  let stateAfterOutput = null;
  let sawTasks;
  const emitted = new Promise((resolve) => { sawTasks = resolve; });
  reg.bus.once('tasks', () => { stateAfterOutput = snapshotTasks().tasks.find((t) => t.id === 'persist-1')?.state; sawTasks(); });
  reg.bus.emit('output', { id: sessionId, data: 'reached your session usage limit' });
  await Promise.race([emitted, new Promise((resolve) => setTimeout(resolve, 3500))]);

  assert.equal(stateAfterOutput, 'usage-limited', 'taskBySession reverse index was rebuilt, rate-limit listener fired');
});

test('updateTask: state-only Done update does not recreate a cleaned git worktree', async () => {
  const repo = initRepo();
  const worktree = join(scratch, `gone-${Date.now()}`);
  const tasksFile = join(process.env.SINGULARITY_HOME, 'state', 'tasks.json');
  try {
    writeFileSync(tasksFile, JSON.stringify({
      tasks: [{ id: 'done-state-only', title: 'seed', description: 'd', column: 'done', state: 'complete', kind: 'git', repo, worktree, branch: 'gone-branch' }], history: [],
    }));
    initTasks(null);
    await updateTask('done-state-only', { state: 'report ready' });
    assert.equal(existsSync(worktree), false);
    assert.throws(() => execFileSync('git', ['-C', repo, 'show-ref', '--verify', '--quiet', 'refs/heads/gone-branch']));
  } finally {
    rmRepo(repo);
  }
});
