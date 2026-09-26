import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, readdirSync, chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// project-review.mjs imports tasks.mjs -> agents.mjs -> app-dir.mjs, which
// requires SINGULARITY_HOME at load; static imports hoist above this
// assignment, so a dynamic import is required (projects.test.mjs pattern).
process.env.SINGULARITY_HOME = mkdtempSync(join(tmpdir(), 'sing-home-'));
process.env.SING_GIT_TIMEOUT_MS = '3000';
process.env.CLAUDE_BIN = process.env.SINGULARITY_HOME;
delete process.env.OLLAMA_BIN;
delete process.env.CODEX_BIN;

const REVIEW_DIR = mkdtempSync(join(tmpdir(), 'sing-review-'));
process.env.PROJECT_REVIEW_DIR = REVIEW_DIR;
const { reviewStatus, readReviewFile } = await import('./project-review.mjs');

function writeRun(sid, files) {
  const dir = join(REVIEW_DIR, sid, 'findings');
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
}

function initRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'sing-review-repo-'));
  execFileSync('git', ['-c', 'init.defaultBranch=main', 'init', '-q', repo]);
  execFileSync('git', ['-C', repo, 'config', 'user.email', 'x@x.com']);
  execFileSync('git', ['-C', repo, 'config', 'user.name', 'x']);
  writeFileSync(join(repo, 'f.txt'), 'x');
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'init']);
  return repo;
}
function commit(repo, name) {
  writeFileSync(join(repo, name), 'x');
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, 'commit', '-q', '-m', name]);
}
function headSha(repo) {
  return execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}
function rmRepo(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) rmRepo(p); else chmodSync(p, 0o666);
  }
  rmSync(dir, { recursive: true, force: true });
}

const repo = initRepo();
const sha1 = headSha(repo);

// sid-fformat: legacy Claude-Code category format (## Blocker/Minor, ### F<n>.)
writeRun('sid-fformat', {
  'introduced.md': `# F-format legacy findings

## Blocker

### F1. Something severe (CONFIRMED)
- detail bullet

## Minor

### F2. Something minor (PLAUSIBLE)
- detail bullet
`,
});

// sid-legacy: legacy Codex P-heading format (## P<n> — title, no Status line)
writeRun('sid-legacy', {
  'introduced.md': `# Introduced findings

## P1 — Something bad
\`config/foo.js:8\` bla bla description, no status line.

## P2 — Another issue
Some other description text.
`,
  'preexisting.md': `# Preexisting findings

## P0 — Old bug already there
Status: wontfix — acceptable risk

No further items.
`,
});

// sid-new: new Phase-1 Status format, worktree is a *subdir* of the project
// (a ticket worktree reviewed under its own row) — exercises path-prefix match.
writeRun('sid-new', {
  'introduced.md': `# Introduced findings

## P2 — Race condition on save
Status: open

CONFIRMED via test run.

## P1 — Second finding
Status: fixed — abc1234
`,
  'preexisting.md': `# Preexisting findings

No findings.
`,
});

const ledger = `---
title: Project Review Log
type: meta
status: active
---

# Project Review Log

| Session ID | Worktree | Baseline SHA | Target SHA | Started at | Completed at | Harness | Model | Effort | Status | Artifacts |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| sid-fformat | ${repo.replace(/\\/g, '/')} | none | deadbeef1 | 2026-09-25T01:00:00Z | 2026-09-25T01:10:00Z | Claude Code | claude-opus-5-5 | unknown | DONE | [report](sid-fformat/reports/review.md), [findings](sid-fformat/findings/introduced.md) |
| sid-legacy | ${repo.replace(/\\/g, '/')} | none | deadbeef2 | 2026-09-25T02:00:00Z | 2026-09-25T02:10:00Z | Codex | unknown | unknown | DONE | [report](sid-legacy/reports/review.md), [findings](sid-legacy/findings/introduced.md), [pre-existing](sid-legacy/findings/preexisting.md) |
| sid-new | ${repo.replace(/\\/g, '/')}/sub | ${sha1} | ${sha1} | 2026-09-25T03:00:00Z | 2026-09-25T03:10:00Z | Claude Code | claude-sonnet-5 | unknown | DONE | [report](sid-new/reports/review.md), [findings](sid-new/findings/introduced.md) |
| sid-blocked | /some/other/repo | none | cafef00d | 2026-09-25T04:00:00Z |  | Codex | unknown | unknown | BLOCKED | [report](sid-blocked/reports/review.md) |
`;
writeFileSync(join(REVIEW_DIR, 'project-review-log.md'), ledger);

// One more commit after the ledger's latest (DONE) target — commitsSince should be 1.
commit(repo, 'g.txt');

test('reviewStatus: matches worktree by exact + subdir prefix, newest first, aggregates counts, computes commitsSince for the latest DONE run', async () => {
  const r = await reviewStatus(repo);
  assert.equal(r.enabled, true);
  assert.deepEqual(r.runs.map((x) => x.sessionId), ['sid-new', 'sid-legacy', 'sid-fformat']); // newest first

  const [newRun, legacyRun, fRun] = r.runs;
  assert.deepEqual(fRun.findings.map((f) => [f.sev, f.status, f.kind]), [['P0', 'open', 'introduced'], ['P2', 'open', 'introduced']]);
  assert.deepEqual(legacyRun.findings.map((f) => [f.sev, f.status, f.kind]), [['P1', 'open', 'introduced'], ['P2', 'open', 'introduced'], ['P0', 'wontfix', 'preexisting']]);
  assert.deepEqual(newRun.findings.map((f) => [f.sev, f.status, f.kind]), [['P2', 'open', 'introduced'], ['P1', 'fixed', 'introduced']]);
  assert.equal(newRun.findings[0].rel, 'sid-new/findings/introduced.md');
  assert.equal(newRun.artifacts.length, 2);
  assert.deepEqual(newRun.artifacts[0], { label: 'report', rel: 'sid-new/reports/review.md' });

  assert.equal(r.latest.status, 'DONE');
  assert.equal(r.latest.target, sha1);
  assert.equal(r.latest.commitsSince, 1);
  assert.deepEqual(r.latest.counts, { P0: 2, P1: 2, P2: 3, P3: 0, open: 5, resolved: 2 });
});

test('reviewStatus: unrelated worktree with no matching row => runs empty, latest null', async () => {
  const r = await reviewStatus(join(tmpdir(), 'sing-review-none'));
  assert.equal(r.enabled, true);
  assert.deepEqual(r.runs, []);
  assert.equal(r.latest, null);
});

test('reviewStatus: BLOCKED latest run never attempts commitsSince', async () => {
  const r = await reviewStatus('/some/other/repo');
  assert.equal(r.latest.status, 'BLOCKED');
  assert.equal(r.latest.commitsSince, null);
});

test('reviewStatus: PROJECT_REVIEW_DIR unset => disabled', async () => {
  const saved = process.env.PROJECT_REVIEW_DIR;
  delete process.env.PROJECT_REVIEW_DIR;
  const { reviewStatus: disabledReviewStatus } = await import(`./project-review.mjs?disabled=${Date.now()}`);
  assert.deepEqual(await disabledReviewStatus(repo), { enabled: false });
  process.env.PROJECT_REVIEW_DIR = saved;
});

test('readReviewFile: reads a valid artifact, rejects escape/non-md/missing', () => {
  const ok = readReviewFile('sid-new/findings/introduced.md');
  assert.equal(ok.ok, true);
  assert.match(ok.content, /Race condition on save/);

  assert.equal(readReviewFile('../outside.md').ok, false);
  assert.equal(readReviewFile(`${REVIEW_DIR.replace(/\\/g, '/')}/../outside.md`).ok, false);
  assert.equal(readReviewFile('sid-new/findings/introduced.txt').ok, false); // not .md
  assert.equal(readReviewFile('sid-new/findings/missing.md').ok, false);
});

test.after(() => { rmRepo(repo); });
