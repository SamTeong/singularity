// Integration test for the worktree-reclaim path in createTask's failure
// cleanup (tasks.mjs ~lines 336-364): when ANY error throws after `git worktree
// add` succeeds, the catch block must `git worktree remove --force` + `git
// branch -D` so the worktree/branch don't orphan.
//
// The existing tasks.test.mjs "failed spawn cleans up the worktree" case covers
// the trigger where reg.create's buildSpawn throws (ollama-not-found). This file
// covers a DIFFERENT trigger point — the ticketDir mkdir/write step that runs
// BEFORE reg.create is reached — so a regression in the catch block that only
// fires on early (pre-spawn) failures would be caught here, not there.
//
// Trigger: point SING_TRUSTED_ROOT at a temp dir where `.worktrees/` is a real
// directory (so `git worktree add` succeeds) but `.tickets` is a regular FILE
// (so `mkdirSync(ticketDir, { recursive: true })` throws ENOTDIR). Real git, real
// filesystem, NO real `claude` spawn — the throw happens before reg.create is
// called. Same SINGULARITY_HOME-before-dynamic-import harness as the other
// suites (static imports hoist above the env assignment; app-dir.mjs throws
// without SINGULARITY_HOME).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// App state → scratch (required by app-dir.mjs at load).
const scratch = mkdtempSync(join(tmpdir(), 'sing-tasks-int-'));
process.env.SINGULARITY_HOME = join(scratch, 'sing');
// Trusted root holds .worktrees/ (real dir) + .tickets (a FILE → ticketDir
// mkdir throws). Both paths are read once at module load from app-dir.mjs.
const trusted = mkdtempSync(join(tmpdir(), 'sing-trusted-'));
process.env.SING_TRUSTED_ROOT = trusted;
mkdirSync(join(trusted, '.worktrees'), { recursive: true });
writeFileSync(join(trusted, '.tickets'), 'not a directory');

// Clear OLLAMA_BIN so buildSpawn's ollama branch isn't a confounder (we never
// reach reg.create, but match tasks.test.mjs's convention for determinism).
delete process.env.OLLAMA_BIN;

const { createTask } = await import('./tasks.mjs');

function initRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'sing-repo-int-'));
  execFileSync('git', ['-C', repo, 'init', '-q']);
  execFileSync('git', ['-C', repo, 'config', 'user.email', 'x@x.com']);
  execFileSync('git', ['-C', repo, 'config', 'user.name', 'x']);
  writeFileSync(join(repo, 'f.txt'), 'x');
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'init']);
  return repo;
}

test('createTask: ticketDir failure after git worktree add reclaims worktree + branch', () => {
  const repo = initRepo();
  try {
    // .tickets is a file → mkdirSync(join('.tickets', short), { recursive: true })
    // throws ENOTDIR. This throws AFTER `git worktree add` succeeded but BEFORE
    // reg.create is called — a different trigger than the spawn-fail test in
    // tasks.test.mjs. The catch block must remove the worktree and delete the
    // branch it just created.
    assert.throws(
      () => createTask({ repo, title: 'T', description: 'D', model: 'sonnet', scopes: [] }),
      /(ENOTDIR|EEXIST|ENOENT|not a directory)/,
    );

    const wtList = execFileSync('git', ['-C', repo, 'worktree', 'list'], { encoding: 'utf8' }).trim().split('\n');
    assert.equal(wtList.length, 1, 'only the main worktree remains — task worktree was reclaimed');

    // No task/* branch should remain: the catch block ran `git branch -D`.
    const branches = execFileSync('git', ['-C', repo, 'branch', '--list', 'task/*'], { encoding: 'utf8' }).trim();
    assert.equal(branches, '', 'task branch was deleted by the failure cleanup');
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(trusted, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
});