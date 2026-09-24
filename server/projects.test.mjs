import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, readdirSync, chmodSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

// projects.mjs imports tasks.mjs -> agents.mjs -> app-dir.mjs, which requires
// SINGULARITY_HOME at load. Static imports hoist above this assignment, so a
// dynamic import is required (wiki.test.mjs pattern).
process.env.SINGULARITY_HOME = mkdtempSync(join(tmpdir(), 'sing-home-'));
// Shrinks git()'s hard timeout (default 10s) so a hang stays cheap; real git
// calls here finish in well under 3s (tasks.test.mjs pattern).
process.env.SING_GIT_TIMEOUT_MS = '3000';
// CLAUDE_BIN existsSync-true (SINGULARITY_HOME itself), never actually
// executed — summary()'s LLM path is always exercised with a stubbed
// callSummariser (history.test.mjs pattern).
process.env.CLAUDE_BIN = process.env.SINGULARITY_HOME;
delete process.env.OLLAMA_BIN;
delete process.env.CODEX_BIN;
const { list, add, remove, reorder, gitStatus, summary, has } = await import('./projects.mjs');
const { getModels, setModels } = await import('./model-store.mjs');
const DEFAULT_SUMMARISER = getModels().summariserModel;
function setSummariser(id) { setModels({ ...getModels(), summariserModel: id }); }

const PROJECTS_FILE = join(process.env.SINGULARITY_HOME, 'state', 'projects.json');

function initRepo() {
  // Long-form path: a Windows runner's tmpdir() is 8.3 (RUNNER~1), but add()
  // stores git's toplevel, which git reports in long form.
  const repo = realpathSync.native(mkdtempSync(join(tmpdir(), 'sing-proj-')));
  execFileSync('git', ['-c', 'init.defaultBranch=main', 'init', '-q', repo]);
  execFileSync('git', ['-C', repo, 'config', 'user.email', 'x@x.com']);
  execFileSync('git', ['-C', repo, 'config', 'user.name', 'x']);
  writeFileSync(join(repo, 'f.txt'), 'x');
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'init']);
  return repo;
}

// git writes loose objects read-only; rmSync won't clear that on win32
// (tasks.test.mjs pattern) — make everything writable first, then delete.
function rmRepo(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) rmRepo(p);
    else chmodSync(p, 0o666);
  }
  rmSync(dir, { recursive: true, force: true });
}

test('add rejects a non-repo dir and a nonexistent path', async () => {
  const notRepo = mkdtempSync(join(tmpdir(), 'sing-notrepo-'));
  assert.deepEqual(await add(notRepo), { ok: false, error: 'not a git repository' });
  assert.equal((await add(join(notRepo, 'nope'))).ok, false);
  rmSync(notRepo, { recursive: true, force: true });
});

test('add resolves a subfolder to the toplevel; re-adding the toplevel does not duplicate', async () => {
  const repo = initRepo();
  mkdirSync(join(repo, 'sub'));
  const r1 = await add(join(repo, 'sub'));
  assert.equal(r1.ok, true);
  assert.deepEqual(r1.projects, [resolve(repo)]);
  const r2 = await add(repo);
  assert.deepEqual(r2.projects, [resolve(repo)]); // no duplicate
  remove(repo);
  rmRepo(repo);
});

test('remove drops a matching entry; unknown path is a no-op ok', async () => {
  const repo = initRepo();
  await add(repo);
  const r1 = remove(join(tmpdir(), 'sing-unknown-xyz'));
  assert.equal(r1.ok, true);
  assert.equal(r1.projects.includes(resolve(repo)), true); // untouched
  const r2 = remove(repo);
  assert.deepEqual(r2, { ok: true, projects: [] });
  rmRepo(repo);
});

test('reorder: valid permutation ok; non-permutation rejected', async () => {
  const a = initRepo();
  const b = initRepo();
  await add(a);
  await add(b);
  const swapped = [resolve(b), resolve(a)];
  assert.deepEqual(reorder(swapped), { ok: true, projects: swapped });
  assert.equal(reorder([resolve(a)]).ok, false); // wrong length
  assert.equal(reorder([resolve(a), '/not/in/list']).ok, false); // wrong set
  remove(a); remove(b);
  rmRepo(a); rmRepo(b);
});

test('list prunes a repo whose dir was deleted, and persists the pruned list', async () => {
  const repo = initRepo();
  await add(repo);
  rmRepo(repo);
  const kept = await list();
  assert.equal(kept.includes(resolve(repo)), false);
  const onDisk = JSON.parse(readFileSync(PROJECTS_FILE, 'utf8'));
  assert.equal(onDisk.includes(resolve(repo)), false); // pruning was persisted
});

test('gitStatus: upstream + 1 unpushed commit -> ahead 1; staged/modified/untracked; stash count', async () => {
  const repo = initRepo();
  const bare = mkdtempSync(join(tmpdir(), 'sing-bare-'));
  execFileSync('git', ['init', '--bare', '-q', bare]);
  execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', bare]);
  execFileSync('git', ['-C', repo, 'push', '-q', '-u', 'origin', 'main']);
  writeFileSync(join(repo, 'f.txt'), 'unpushed change');
  execFileSync('git', ['-C', repo, 'commit', '-q', '-am', 'second']);

  // One stash entry, then the working tree gets its own separate dirty state.
  writeFileSync(join(repo, 'f.txt'), 'temp');
  execFileSync('git', ['-C', repo, 'stash', '-q']);
  writeFileSync(join(repo, 'staged.txt'), 's');
  execFileSync('git', ['-C', repo, 'add', 'staged.txt']);
  writeFileSync(join(repo, 'f.txt'), 'modified again');
  writeFileSync(join(repo, 'untracked.txt'), 'u');

  const s = await gitStatus(repo);
  assert.equal(s.branch, 'main');
  assert.equal(s.upstream, 'origin/main');
  assert.equal(s.ahead, 1);
  assert.equal(s.behind, 0);
  assert.equal(s.staged, 1);
  assert.equal(s.modified, 1);
  assert.equal(s.untracked, 1);
  assert.equal(s.stash, 1);
  assert.equal(s.lastCommit.subject, 'second');

  rmRepo(bare);
  rmRepo(repo);
});

test('gitStatus: no upstream -> upstream null, ahead/behind 0, lastCommit subject', async () => {
  const repo = initRepo();
  const s = await gitStatus(repo);
  assert.equal(s.branch, 'main');
  assert.equal(s.upstream, null);
  assert.equal(s.ahead, 0);
  assert.equal(s.behind, 0);
  assert.equal(s.lastCommit.subject, 'init');
  rmRepo(repo);
});

test('has: gates on the stored list', async () => {
  const repo = initRepo();
  assert.equal(has(repo), false);
  await add(repo);
  assert.equal(has(repo), true);
  remove(repo);
  rmRepo(repo);
});

test('summary: no summariser configured, upstream present -> deterministic, scope unpushed, commit subject only', async () => {
  const repo = initRepo();
  const bare = mkdtempSync(join(tmpdir(), 'sing-bare-'));
  execFileSync('git', ['init', '--bare', '-q', bare]);
  execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', bare]);
  execFileSync('git', ['-C', repo, 'push', '-q', '-u', 'origin', 'main']);
  writeFileSync(join(repo, 'f.txt'), 'unpushed change');
  execFileSync('git', ['-C', repo, 'commit', '-q', '-am', 'second commit']);

  setSummariser('');
  try {
    const r = await summary(repo);
    assert.equal(r.scope, 'unpushed');
    assert.deepEqual(r.committed, ['second commit']); // only the unpushed one, not 'init'
    assert.equal(r.source, 'deterministic');
    assert.equal(r.llm.reason, 'no-summariser');
  } finally { setSummariser(DEFAULT_SUMMARISER); }
  rmRepo(bare);
  rmRepo(repo);
});

test('summary: no upstream -> scope recent, deterministic commit subjects, empty uncommitted', async () => {
  const repo = initRepo(); // one commit 'init', no upstream, clean tree
  setSummariser('');
  try {
    const r = await summary(repo);
    assert.equal(r.scope, 'recent');
    assert.deepEqual(r.committed, ['init']);
    assert.deepEqual(r.uncommitted, []);
  } finally { setSummariser(DEFAULT_SUMMARISER); }
  rmRepo(repo);
});

test('summary: deterministic uncommitted = --stat file lines plus the trailing summary line', async () => {
  const repo = initRepo();
  writeFileSync(join(repo, 'f.txt'), 'changed');
  setSummariser('');
  try {
    const r = await summary(repo);
    assert.equal(r.uncommitted.length, 2);
    assert.match(r.uncommitted[0], /f\.txt/);
    assert.match(r.uncommitted[1], /file changed/);
  } finally { setSummariser(DEFAULT_SUMMARISER); }
  rmRepo(repo);
});

test('summary: untracked-only tree is not reported clean', async () => {
  const repo = initRepo();
  writeFileSync(join(repo, 'new1.txt'), 'x');
  writeFileSync(join(repo, 'new2.txt'), 'y');
  setSummariser('');
  try {
    const r = await summary(repo);
    assert.deepEqual(r.uncommitted, ['2 untracked files']);
  } finally { setSummariser(DEFAULT_SUMMARISER); }
  rmRepo(repo);
});

test('summary: LLM path parses JSON and caches; a cache hit skips the stub; a changed tree busts the cache', async () => {
  const repo = initRepo();
  setSummariser('opus'); // claude-group entry; CLAUDE_BIN existsSync-true, never actually run
  let calls = 0;
  const callSummariser = async () => { calls++; return { text: JSON.stringify({ committed: ['did x'], uncommitted: ['changed y'] }) }; };
  try {
    const r1 = await summary(repo, { callSummariser });
    assert.equal(r1.source, 'llm');
    assert.equal(r1.model, 'opus');
    assert.deepEqual(r1.committed, ['did x']);
    assert.equal(calls, 1);

    const r2 = await summary(repo, { callSummariser });
    assert.equal(r2.cached, true);
    assert.deepEqual(r2.committed, ['did x']);
    assert.equal(calls, 1, 'cache hit — the stub is not called again');

    writeFileSync(join(repo, 'new.txt'), 'x'); // untracked — changes status --porcelain
    const r3 = await summary(repo, { callSummariser });
    assert.equal(calls, 2, 'a changed working tree busts the cache');
    assert.equal(r3.cached, undefined);
  } finally { setSummariser(DEFAULT_SUMMARISER); }
  rmRepo(repo);
});

test('summary: bad LLM JSON falls back to deterministic', async () => {
  const repo = initRepo();
  setSummariser('opus');
  try {
    const r = await summary(repo, { callSummariser: async () => ({ text: 'not json' }) });
    assert.equal(r.source, 'deterministic');
    assert.equal(r.llm.ok, false);
    assert.deepEqual(r.committed, ['init']);
  } finally { setSummariser(DEFAULT_SUMMARISER); }
  rmRepo(repo);
});
