// buildTaskPrompt branches on whether the task's cwd ships project agent defs
// (.claude/agents/<role>.md). These checks pin that branching: defs present →
// subagents routed via subagent_type; absent → generic fallback.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Route app state to scratch before importing tasks.mjs — it pulls in agents.mjs
// → app-dir.mjs, which requires SINGULARITY_HOME at load. Static imports are
// hoisted above this assignment, so a dynamic import is required.
const scratch = mkdtempSync(join(tmpdir(), 'sing-tasks-'));
process.env.SINGULARITY_HOME = join(scratch, 'sing');

const { buildTaskPrompt } = await import('./tasks.mjs');

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
  const p = buildTaskPrompt({ ...baseTask, worktree: cwd });
  assert.match(p, /subagent_type: "reviewer"/);
  assert.match(p, /subagent_type: "senior-software-engineer"/);
  assert.match(p, /security checklist/);
  rmSync(cwd, { recursive: true, force: true });
});

test('no defs → generic fallback, no subagent_type', () => {
  const cwd = withAgents([]);
  const p = buildTaskPrompt({ ...baseTask, worktree: cwd });
  assert.doesNotMatch(p, /subagent_type/);
  assert.match(p, /spawn a reviewer subagent via the Task tool with model/);
  rmSync(cwd, { recursive: true, force: true });
});

test('only junior def → impl routes to junior-software-engineer', () => {
  const cwd = withAgents(['junior-software-engineer.md']);
  const p = buildTaskPrompt({ ...baseTask, worktree: cwd });
  assert.match(p, /subagent_type: "junior-software-engineer"/);
  assert.doesNotMatch(p, /senior-software-engineer/);
  rmSync(cwd, { recursive: true, force: true });
});