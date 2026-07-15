// buildTaskPrompt branches on whether the task's cwd ships project agent defs
// (.claude/agents/<role>.md). These checks pin that branching: defs present →
// subagents routed via subagent_type; absent → generic fallback, or (with the
// caveman plugin enabled) the cavecrew fallback.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Route app state to scratch before importing tasks.mjs — it pulls in agents.mjs
// → app-dir.mjs, which requires SINGULARITY_HOME at load. Static imports are
// hoisted above this assignment, so a dynamic import is required.
const scratch = mkdtempSync(join(tmpdir(), 'sing-tasks-'));
process.env.SINGULARITY_HOME = join(scratch, 'sing');

const { buildTaskPrompt, createTask } = await import('./tasks.mjs');

function initRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'sing-repo-'));
  execFileSync('git', ['-C', repo, 'init', '-q']);
  execFileSync('git', ['-C', repo, 'config', 'user.email', 'x@x.com']);
  execFileSync('git', ['-C', repo, 'config', 'user.name', 'x']);
  writeFileSync(join(repo, 'f.txt'), 'x');
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'init']);
  return repo;
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

test('project agent defs present → subagents routed via subagent_type', () => {
  const cwd = withAgents(['reviewer.md', 'senior-software-engineer.md']);
  const p = buildTaskPrompt({ ...baseTask, worktree: cwd }, false);
  assert.match(p, /subagent_type: "reviewer"/);
  assert.match(p, /subagent_type: "senior-software-engineer"/);
  assert.match(p, /security checklist/);
  rmSync(cwd, { recursive: true, force: true });
});

test('no defs → generic fallback, no subagent_type', () => {
  const cwd = withAgents([]);
  const p = buildTaskPrompt({ ...baseTask, worktree: cwd }, false);
  assert.doesNotMatch(p, /subagent_type/);
  assert.match(p, /spawn a reviewer subagent via the Task tool with model/);
  rmSync(cwd, { recursive: true, force: true });
});

test('only junior def → impl routes to junior-software-engineer', () => {
  const cwd = withAgents(['junior-software-engineer.md']);
  const p = buildTaskPrompt({ ...baseTask, worktree: cwd }, false);
  assert.match(p, /subagent_type: "junior-software-engineer"/);
  assert.doesNotMatch(p, /senior-software-engineer/);
  rmSync(cwd, { recursive: true, force: true });
});

test('no defs + caveman plugin → cavecrew fallback', () => {
  const cwd = withAgents([]);
  const p = buildTaskPrompt({ ...baseTask, worktree: cwd }, true);
  assert.match(p, /subagent_type: "caveman:cavecrew-reviewer"/);
  assert.match(p, /caveman:cavecrew-investigator/);
  rmSync(cwd, { recursive: true, force: true });
});

test('project defs win over cavecrew', () => {
  const cwd = withAgents(['reviewer.md', 'senior-software-engineer.md']);
  const p = buildTaskPrompt({ ...baseTask, worktree: cwd }, true);
  assert.doesNotMatch(p, /cavecrew/);
  assert.match(p, /subagent_type: "reviewer"/);
  rmSync(cwd, { recursive: true, force: true });
});

// createTask: a failure after `git worktree add` succeeds but before the task
// is persisted/spawned must not orphan the worktree. OLLAMA_BIN is unset in
// this test process (no .env loaded), so routing to a non-claude model makes
// reg.create's buildSpawn throw synchronously ("ollama not found") — a
// deterministic failure with no mocking needed.
test('createTask: failed spawn cleans up the worktree it just created', () => {
  const repo = initRepo();
  try {
    assert.throws(
      () => createTask({ repo, title: 'T', description: 'D', model: 'not-a-claude-model', scopes: [] }),
      /ollama not found/,
    );
    const list = execFileSync('git', ['-C', repo, 'worktree', 'list'], { encoding: 'utf8' }).trim().split('\n');
    assert.equal(list.length, 1, 'only the main worktree should remain — task worktree was cleaned up');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
