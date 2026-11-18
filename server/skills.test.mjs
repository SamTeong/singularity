// Unit tests for the skills viewer (listSkills/readSkill). skills.mjs reads
// SING_SCOPE_ROOT via agents.mjs at load, so both SINGULARITY_HOME and
// SING_SCOPE_ROOT are pointed at scratch temp dirs BEFORE the module graph is
// imported (dynamic import after the env tweak). One shared tree per file —
// matches crons.test.mjs convention (a single top-level import, not per-test).
// The read paths dispatch through the real Rust stdio bridge (release binary),
// started once here; the write paths stay Node and need no bridge.
// Run: npm test  (node --test server/)
import Fastify from 'fastify';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync, utimesSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';

const scratch = mkdtempSync(join(tmpdir(), 'singularity-skills-test-'));
const root = join(scratch, 'scopes');
mkdirSync(root, { recursive: true });
process.env.SINGULARITY_HOME = join(scratch, 'singularity');
process.env.SING_SCOPE_ROOT = root;

// Shared tree: coding (freeze with desc, noisy without frontmatter), common,
// and empty (scope with no skills dir).
mkdirSync(join(root, 'coding', '.claude', 'skills', 'freeze'), { recursive: true });
writeFileSync(join(root, 'coding', '.claude', 'skills', 'freeze', 'SKILL.md'),
  '---\nname: freeze\ndescription: Lock edits to a directory.\ntriggers:\n  - freeze edits\n---\n\n# freeze\n\nbody');
mkdirSync(join(root, 'coding', '.claude', 'skills', 'freeze', 'scripts'), { recursive: true });
writeFileSync(join(root, 'coding', '.claude', 'skills', 'freeze', 'scripts', 'run.mjs'), "console.log('run')");
mkdirSync(join(root, 'coding', '.claude', 'skills', 'freeze', 'references'), { recursive: true });
writeFileSync(join(root, 'coding', '.claude', 'skills', 'freeze', 'references', 'notes.md'), '# notes\n\nref body');
mkdirSync(join(root, 'coding', '.claude', 'skills', 'noisy'), { recursive: true });
writeFileSync(join(root, 'coding', '.claude', 'skills', 'noisy', 'SKILL.md'), '# noisy\n\nno frontmatter');
mkdirSync(join(root, 'common', '.claude', 'skills', 'x'), { recursive: true });
writeFileSync(join(root, 'common', '.claude', 'skills', 'x', 'SKILL.md'), '---\nname: x\ndescription: hidden\n---\n');
mkdirSync(join(root, 'empty', '.claude'), { recursive: true });

// Flat layout: a bare .claude/skills-style dir (subfolder-per-skill, no scopes).
const flatRoot = join(scratch, 'flat');
mkdirSync(join(flatRoot, 'declawed'), { recursive: true });
writeFileSync(join(flatRoot, 'declawed', 'SKILL.md'), '---\nname: declawed\ndescription: De-slop text.\n---\n\n# declawed\n\nbody');
mkdirSync(join(flatRoot, 'not-a-skill'), { recursive: true }); // no SKILL.md → skipped

const { createRustBackend } = await import('./rust-backend.mjs');
const backend = createRustBackend();
await backend.start();
const { listSkills, readSkillsDir, readSkill, readSkillFile, writeSkill, writeSkillFile, getSkillsRoots, setSkillsRoots, setSkillsBackend, createSkillsRootsGetHandler, createSkillsRootsSetHandler, createSkillsListHandler, createSkillReadHandler, createSkillWriteHandler } = await import('./skills.mjs');
const { STATE_DIR, BACKUPS_DIR } = await import('./app-dir.mjs');
setSkillsBackend(backend);
after(async () => { await backend.stop(); rmSync(scratch, { recursive: true, force: true }); });

function backupSnapshot(sourcePath) {
  const key = createHash('sha256').update(sourcePath).digest('hex').slice(0, 16);
  const dir = join(BACKUPS_DIR, key);
  let files = [];
  try { files = readdirSync(dir).filter((name) => name.endsWith('.bak')); } catch {}
  return { dir, files: new Set(files) };
}

function hasNewBackup(snapshot, content) {
  try {
    return readdirSync(snapshot.dir)
      .filter((name) => name.endsWith('.bak') && !snapshot.files.has(name))
      .some((name) => readFileSync(join(snapshot.dir, name), 'utf8') === content);
  } catch { return false; }
}

test('listSkills: grouped — includes common, skips scopes with no skills, carries description', async () => {
  const { scopes, flat } = await listSkills(root);
  assert.equal(flat, false);
  assert.deepEqual(scopes.map((s) => s.name), ['coding', 'common'], 'common included, empty skipped');
  const coding = scopes[0];
  assert.deepEqual(coding.skills.map((s) => s.name), ['freeze', 'noisy'], 'sorted');
  assert.equal(coding.skills.find((s) => s.name === 'freeze').description, 'Lock edits to a directory.');
  assert.equal(coding.skills.find((s) => s.name === 'noisy').description, '');
});

test('listSkills: carries supporting files (relative paths, SKILL.md excluded)', async () => {
  const { scopes } = await listSkills(root);
  const freeze = scopes[0].skills.find((s) => s.name === 'freeze');
  assert.deepEqual(freeze.files, ['references/notes.md', 'scripts/run.mjs']);
  const noisy = scopes[0].skills.find((s) => s.name === 'noisy');
  assert.deepEqual(noisy.files, []);
});

test('readSkillFile: grouped reads a supporting file with type', async () => {
  const r = await readSkillFile(root, 'coding', 'freeze', 'scripts/run.mjs');
  assert.ok(r.ok);
  assert.equal(r.type, 'code');
  assert.match(r.content, /console\.log/);
  const md = await readSkillFile(root, 'coding', 'freeze', 'references/notes.md');
  assert.equal(md.type, 'markdown');
  assert.match(md.content, /# notes/);
});

test('readSkillFile: rejects traversal and bad file paths', async () => {
  assert.equal((await readSkillFile(root, 'coding', 'freeze', '../SKILL.md')).ok, false, '.. segment rejected');
  assert.equal((await readSkillFile(root, 'coding', 'freeze', 'scripts/../run.mjs')).ok, false, '.. segment in middle rejected');
  assert.equal((await readSkillFile(root, 'coding', 'freeze', 'nope.mjs')).ok, false, 'missing file');
  assert.equal((await readSkillFile(root, 'coding', 'freeze', '')).ok, false, 'empty file');
});

test('readSkillFile: flat resolves <root>/<skill>/<file>', async () => {
  // flat fixture has no supporting files; create one on the fly.
  writeFileSync(join(flatRoot, 'declawed', 'scripts.js'), 'x');
  const r = await readSkillFile(flatRoot, null, 'declawed', 'scripts.js', true);
  assert.ok(r.ok);
  assert.equal(r.type, 'code');
});

test('writeSkill: round-trips raw content (frontmatter preserved)', async () => {
  const r = await writeSkill(root, 'coding', 'noisy', '# rewritten\n\nnew body');
  assert.equal(r.ok, true);
  const back = await readSkill(root, 'coding', 'noisy');
  assert.equal(back.ok, true);
  assert.equal(back.raw, '# rewritten\n\nnew body');
});

test('writeSkill: rejects bad names + non-string content', async () => {
  assert.equal((await writeSkill(root, '..', 'x', 'y')).ok, false);
  assert.equal((await writeSkill(root, 'coding', '..', 'y')).ok, false);
  assert.equal((await writeSkill(root, 'coding', 'nope', null)).ok, false, 'non-string content');
});

test('writeSkillFile: writes + round-trips a supporting file', async () => {
  const r = await writeSkillFile(root, 'coding', 'freeze', 'scripts/run.mjs', "console.log('new')");
  assert.equal(r.ok, true);
  const back = await readSkillFile(root, 'coding', 'freeze', 'scripts/run.mjs');
  assert.equal(back.content, "console.log('new')");
});

test('writeSkillFile: rejects traversal, image edit, bad content', async () => {
  assert.equal((await writeSkillFile(root, 'coding', 'freeze', '../SKILL.md', 'x')).ok, false, 'traversal');
  assert.equal((await writeSkillFile(root, 'coding', 'freeze', 'scripts/run.mjs', 42)).ok, false, 'non-string content');
  // image ext → not editable
  assert.equal((await writeSkillFile(root, 'coding', 'freeze', 'a.png', 'x')).ok, false, 'image not editable');
});

test('listSkills: flat — root is a .claude/skills dir, one scope', async () => {
  const { scopes, flat } = await listSkills(flatRoot);
  assert.equal(flat, true);
  assert.equal(scopes.length, 1, 'single synthetic scope');
  assert.equal(scopes[0].name, 'flat');
  assert.deepEqual(scopes[0].skills.map((s) => s.name), ['declawed'], 'no-SKILL.md subdir skipped');
});

test('listSkills: bad root reports error', async () => {
  assert.equal((await listSkills(join(scratch, 'nope'))).error, 'skills root not found');
});

test('readSkill: grouped rejects bad names', async () => {
  assert.equal((await readSkill(root, '../x', 'freeze')).ok, false);
  assert.equal((await readSkill(root, 'a/b', 'freeze')).ok, false);
  assert.equal((await readSkill(root, '..', 'x')).ok, false, 'bare .. scope would traverse above root');
  assert.equal((await readSkill(root, 'coding', '..')).ok, false, 'bare .. skill would traverse above skills dir');
  assert.equal((await readSkill(root, 'coding', '.')).ok, false);
  assert.equal((await readSkill(root, 'coding', '...')).ok, false);
  assert.equal((await readSkill(root, 'coding', 'nope')).ok, false, 'missing skill');
});

test('readSkill: grouped returns structured meta + body + path', async () => {
  const r = await readSkill(root, 'coding', 'freeze');
  assert.ok(r.ok);
  assert.equal(r.name, 'freeze');
  assert.equal(r.description, 'Lock edits to a directory.');
  assert.deepEqual(r.triggers, ['freeze edits']);
  assert.match(r.body, /# freeze/);
  assert.match(r.path, /coding.*SKILL\.md$/);
});

test('readSkill: flat resolves <root>/<skill>/SKILL.md, ignores scope', async () => {
  const r = await readSkill(flatRoot, null, 'declawed', true);
  assert.ok(r.ok);
  assert.equal(r.name, 'declawed');
  assert.equal((await readSkill(flatRoot, null, '..', true)).ok, false, 'bad skill name still rejected in flat');
});

// Runs before any roots file (new or old) exists, so this exercises the final
// fallback: the user's ~/.claude/skills (a flat skills dir).
test('getSkillsRoots: defaults to ~/.claude/skills when nothing is configured', async () => {
  assert.deepEqual(await getSkillsRoots(), [join(homedir(), '.claude', 'skills')]);
});

// Runs before any setSkillsRoots call, so `skills-roots.json` doesn't exist yet
// and the old single-root file is the only thing to migrate from.
test('getSkillsRoots: migrates from old skills-root.json when present', async () => {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(join(STATE_DIR, 'skills-root.json'), JSON.stringify({ root }));
  assert.deepEqual(await getSkillsRoots(), [root]);
});

test('setSkillsRoots: persists compact bytes + getSkillsRoots reads back the array', async () => {
  const r = await setSkillsRoots([root, flatRoot]);
  assert.deepEqual(r, { ok: true, roots: [root, flatRoot] });
  assert.equal(readFileSync(join(STATE_DIR, 'skills-roots.json'), 'utf8'), JSON.stringify({ roots: [root, flatRoot] }));
  assert.deepEqual(await getSkillsRoots(), [root, flatRoot]);
});

test('setSkillsRoots: filters transport candidates, dedups and caps at 50', async () => {
  const many = Array.from({ length: 60 }, (_, i) => `${root}-${i % 10}`);
  const r = await setSkillsRoots(many);
  assert.equal(r.ok, true);
  assert.equal(r.roots.length, 10, 'deduped to 10 unique values');
  assert.deepEqual(await getSkillsRoots(), r.roots);
  const hostile = { toJSON() { throw new Error('must not serialize'); } };
  assert.deepEqual(await setSkillsRoots([root, '', ' ', root, hostile, 1n]), { ok: true, roots: [root, ' '] });
  assert.equal(readFileSync(join(STATE_DIR, 'skills-roots.json'), 'utf8'), JSON.stringify({ roots: [root, ' '] }));
});

test('setSkillsRoots: bad input (non-array) reports ok:false', async () => {
  assert.deepEqual(await setSkillsRoots('not-an-array'), { ok: false, error: 'bad roots' });
  assert.deepEqual(await setSkillsRoots(null), { ok: false, error: 'bad roots' });
});

test('skills root adapters pass explicit paths and default root to the injected backend', async () => {
  const calls = [];
  const fake = {
    skillsRootsGet: async (...args) => { calls.push(['get', ...args]); return ['/configured']; },
    skillsRootsSet: async (...args) => { calls.push(['set', ...args]); return { ok: true, roots: [] }; },
  };
  assert.deepEqual(await getSkillsRoots(fake), ['/configured']);
  assert.deepEqual(await setSkillsRoots([], fake), { ok: true, roots: [] });
  assert.deepEqual(calls[0], ['get', join(STATE_DIR, 'skills-roots.json'), join(STATE_DIR, 'skills-root.json'), join(homedir(), '.claude', 'skills')]);
  assert.deepEqual(calls[1], ['set', join(STATE_DIR, 'skills-roots.json'), join(STATE_DIR, 'skills-root.json'), join(homedir(), '.claude', 'skills'), []]);
});

test('skills roots HTTP handlers preserve configured, bad-input, and storage responses', async () => {
  const app = Fastify();
  const fake = {
    skillsRootsGet: async () => ['/configured', ''],
    skillsRootsSet: async (_rootsFile, _legacyFile, _defaultRoot, roots) => roots === 'bad'
      ? { ok: false, error: 'bad roots' }
      : roots.length === 1 && roots[0] === '/saved'
        ? { ok: true, roots: ['/saved'] }
        : { ok: false, error: 'native storage failure' },
  };
  app.get('/api/skills/roots', createSkillsRootsGetHandler(fake));
  app.put('/api/skills/roots', createSkillsRootsSetHandler(fake));
  const get = await app.inject({ method: 'GET', url: '/api/skills/roots' });
  assert.equal(get.statusCode, 200);
  assert.deepEqual(get.json(), { roots: ['/configured', ''] });
  const saved = await app.inject({ method: 'PUT', url: '/api/skills/roots', payload: { roots: ['/saved'] } });
  assert.equal(saved.statusCode, 200);
  assert.deepEqual(saved.json(), { ok: true, roots: ['/saved'] });
  const bad = await app.inject({ method: 'PUT', url: '/api/skills/roots', payload: { roots: 'bad' } });
  assert.equal(bad.statusCode, 200);
  assert.deepEqual(bad.json(), { ok: false, error: 'bad roots' });
  const storage = await app.inject({ method: 'PUT', url: '/api/skills/roots', payload: { roots: [] } });
  assert.equal(storage.statusCode, 200);
  assert.deepEqual(storage.json(), { ok: false, error: 'native storage failure' });
  await app.close();
});

test('skills roots HTTP handlers leave bridge rejections to Fastify', async () => {
  const app = Fastify();
  const broken = {
    skillsRootsGet: async () => { throw new Error('child exited'); },
    skillsRootsSet: async () => { throw new Error('child exited'); },
  };
  app.get('/api/skills/roots', createSkillsRootsGetHandler(broken));
  app.put('/api/skills/roots', createSkillsRootsSetHandler(broken));
  const get = await app.inject({ method: 'GET', url: '/api/skills/roots' });
  assert.equal(get.statusCode, 500);
  assert.equal(get.json().statusCode, 500);
  assert.equal(get.json().message, 'child exited');
  const put = await app.inject({ method: 'PUT', url: '/api/skills/roots', payload: { roots: [] } });
  assert.equal(put.statusCode, 500);
  assert.equal(put.json().statusCode, 500);
  assert.equal(put.json().message, 'child exited');
  await app.close();
});

test('all Skills helpers skip root lookup for truthy roots and use only configured index zero otherwise', async () => {
  const requested = [];
  let configured = ['/configured-first', '/configured-second'];
  let lookups = 0;
  const fake = {
    skillsRootsGet: async () => { lookups++; return configured; },
    skillsList: async (selected) => { requested.push(selected); return { scopes: [], flat: false }; },
    skillRead: async (selected) => { requested.push(selected); return { ok: true }; },
    skillFileRead: async (selected) => { requested.push(selected); return { ok: true }; },
    skillWrite: async (selected) => { requested.push(selected); return { ok: true }; },
  };
  setSkillsBackend(fake);
  try {
    await listSkills('/explicit');
    await readSkill('/explicit', 'scope', 'skill');
    await readSkillFile('/explicit', 'scope', 'skill', 'file.md');
    assert.equal((await writeSkill('/explicit', 'scope', 'skill', null)).error, 'bad content');
    assert.equal((await writeSkillFile('/explicit', 'scope', 'skill', 'file.md', null)).error, 'bad content');
    assert.equal(lookups, 0);
    assert.deepEqual(requested, Array(3).fill('/explicit'));
    await listSkills('');
    assert.equal(requested[3], '/configured-first');
    assert.equal(lookups, 1);
    configured = ['', '/configured-second'];
    const missing = await listSkills(null);
    assert.equal(missing.error, 'skills root not configured');
    assert.equal(requested.length, 4, 'later truthy roots are not considered');
  } finally { setSkillsBackend(backend); }
});

test('readSkill + readSkillFile report mtime as a number', async () => {
  const r = await readSkill(root, 'coding', 'freeze');
  assert.ok(r.ok);
  assert.equal(typeof r.mtime, 'number');
  assert.ok(r.mtime > 0);
  const f = await readSkillFile(root, 'coding', 'freeze', 'scripts/run.mjs');
  assert.ok(f.ok);
  assert.equal(typeof f.mtime, 'number');
  assert.ok(f.mtime > 0);
});

test('writeSkill rejects a stale mtime with "changed on disk"; force overrides', async () => {
  const skillPath = join(root, 'coding', '.claude', 'skills', 'noisy', 'SKILL.md');
  await writeSkill(root, 'coding', 'noisy', 'v1');
  const stale = (await readSkill(root, 'coding', 'noisy')).mtime;
  // Externally rewrite + bump mtime past the 1ms guard window.
  writeFileSync(skillPath, 'v-external');
  const future = (Date.now() + 5000) / 1000;
  utimesSync(skillPath, future, future);
  const rejected = await writeSkill(root, 'coding', 'noisy', 'v2', false, stale);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error, 'changed on disk');
  assert.equal(readFileSync(skillPath, 'utf8'), 'v-external');
  // force overrides the drift.
  const forced = await writeSkill(root, 'coding', 'noisy', 'v-forced', false, stale, true);
  assert.equal(forced.ok, true);
  assert.equal(typeof forced.mtime, 'number');
  assert.equal(readFileSync(skillPath, 'utf8'), 'v-forced');
});

test('writeSkillFile rejects a stale mtime with "changed on disk"; force overrides', async () => {
  const fp = join(root, 'coding', '.claude', 'skills', 'freeze', 'scripts', 'run.mjs');
  await writeSkillFile(root, 'coding', 'freeze', 'scripts/run.mjs', 'v1');
  const stale = (await readSkillFile(root, 'coding', 'freeze', 'scripts/run.mjs')).mtime;
  // Externally rewrite + bump mtime past the 1ms guard window.
  writeFileSync(fp, 'v-external');
  const future = (Date.now() + 5000) / 1000;
  utimesSync(fp, future, future);
  const rejected = await writeSkillFile(root, 'coding', 'freeze', 'scripts/run.mjs', 'v2', false, String(stale));
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error, 'changed on disk');
  assert.equal(readFileSync(fp, 'utf8'), 'v-external');
  // force overrides the drift.
  const forced = await writeSkillFile(root, 'coding', 'freeze', 'scripts/run.mjs', 'v-forced', false, stale, 'false');
  assert.equal(forced.ok, true);
  assert.equal(typeof forced.mtime, 'number');
  assert.equal(readFileSync(fp, 'utf8'), 'v-forced');
});

test('Rust-backed Skills writes preserve backups, UTF-8, layout, optional mtime and the final guard', async () => {
  const skillPath = join(root, 'coding', '.claude', 'skills', 'noisy', 'SKILL.md');
  const priorSkill = `prior-skill:${scratch}`;
  writeFileSync(skillPath, priorSkill);
  const skillBackups = backupSnapshot(skillPath);
  const empty = await writeSkill(root, 'coding', 'noisy', '');
  assert.equal(empty.ok, true);
  assert.equal(typeof empty.mtime, 'number');
  assert.equal(readFileSync(skillPath, 'utf8'), '');
  assert.equal(hasNewBackup(skillBackups, priorSkill), true, 'SKILL.md gets a current-run prior-byte backup');
  const unicode = await writeSkill(root, 'coding', 'noisy', '技能 🧪');
  assert.equal(unicode.ok, true);
  assert.equal(readFileSync(skillPath, 'utf8'), '技能 🧪');

  const supportPath = join(root, 'coding', '.claude', 'skills', 'freeze', 'scripts', 'run.mjs');
  const priorSupport = `prior-support:${scratch}`;
  writeFileSync(supportPath, priorSupport);
  const supportBackups = backupSnapshot(supportPath);
  const support = await writeSkillFile(root, 'coding', 'freeze', 'scripts/run.mjs', 'support ✓');
  assert.equal(support.ok, true);
  assert.equal(readFileSync(supportPath, 'utf8'), 'support ✓');
  assert.equal(hasNewBackup(supportBackups, priorSupport), true, 'supporting file gets a current-run prior-byte backup');

  const flat = await writeSkillFile(flatRoot, null, 'declawed', 'new.txt', 'flat ✓', true);
  assert.equal(flat.ok, true);
  assert.equal(readFileSync(join(flatRoot, 'declawed', 'new.txt'), 'utf8'), 'flat ✓');
  const missingParent = join(flatRoot, 'declawed', 'missing', 'child.txt');
  assert.equal((await writeSkillFile(flatRoot, null, 'declawed', 'missing/child.txt', 'x', true)).ok, false);
  assert.equal(readdirSync(join(flatRoot, 'declawed')).includes('missing'), false);

  assert.equal((await writeSkillFile(flatRoot, null, 'declawed', 'optional.txt', 'optional', true, null)).ok, true);
  const guardPath = join(flatRoot, 'declawed', 'guard.txt');
  const initial = await backend.skillWrite(guardPath, 'initial', null, false);
  assert.equal(initial.ok, true);
  writeFileSync(guardPath, 'external');
  const future = (Date.now() + 5000) / 1000;
  utimesSync(guardPath, future, future);
  const stale = await backend.skillWrite(guardPath, 'rejected', initial.mtime, false);
  assert.deepEqual(stale, { ok: false, error: 'changed on disk' });
  assert.equal(readFileSync(guardPath, 'utf8'), 'external');
  assert.equal(missingParent.includes('missing'), true);
});

test('Skills write handler preserves application statuses and isolates bridge failures', async () => {
  const app = Fastify();
  let calls = 0;
  const child = { skillWrite: async () => { calls++; return { ok: false, error: 'changed on disk' }; } };
  app.put('/skill', createSkillWriteHandler(child, app.log));
  const conflict = await app.inject({ method: 'PUT', url: '/skill', payload: { root, scope: 'coding', skill: 'noisy', content: 'x' } });
  assert.equal(conflict.statusCode, 409);
  const badName = await app.inject({ method: 'PUT', url: '/skill', payload: { root, scope: 'coding', skill: '..', content: 'x' } });
  assert.equal(badName.statusCode, 400);
  assert.equal(calls, 1, 'invalid names do not reach Rust');
  await app.close();

  const failedApp = Fastify();
  failedApp.put('/skill', createSkillWriteHandler({ skillWrite: async () => { throw new Error('child exited'); } }, failedApp.log));
  const unavailable = await failedApp.inject({ method: 'PUT', url: '/skill', payload: { root, scope: 'coding', skill: 'noisy', content: 'x' } });
  assert.equal(unavailable.statusCode, 500);
  assert.deepEqual(unavailable.json(), { ok: false, error: 'skills write backend unavailable' });
  await failedApp.close();
});

// --- Bridge-port additions (behaviors the old Node tests never pinned) ---

test('readSkillFile: image type ships metadata with no content', async () => {
  writeFileSync(join(root, 'coding', '.claude', 'skills', 'freeze', 'pic.png'), 'binaryish');
  const r = await readSkillFile(root, 'coding', 'freeze', 'pic.png');
  assert.ok(r.ok);
  assert.equal(r.type, 'image');
  assert.equal(r.name, 'pic.png');
  assert.equal('content' in r, false, 'binary never ships');
  assert.equal(typeof r.mtime, 'number');
  assert.match(r.path, /pic\.png$/);
});

test('listSkills: unreadable SKILL.md still lists the skill with empty raw/description', async () => {
  const badRoot = join(scratch, 'badmd');
  mkdirSync(join(badRoot, 'weird', 'SKILL.md'), { recursive: true }); // SKILL.md is a directory
  const { scopes } = await listSkills(badRoot);
  assert.deepEqual(scopes[0].skills, [{ name: 'weird', description: '', raw: '', files: [] }]);
});

test('readSkillsDir: null for missing/unreadable dirs, skills for readable ones', async () => {
  assert.equal(await readSkillsDir(join(scratch, 'absent')), null);
  assert.equal(await readSkillsDir(join(scratch, 'singularity', 'state.json-not-a-dir')), null);
  const r = await readSkillsDir(join(root, 'coding', '.claude', 'skills'));
  assert.deepEqual(r.skills.map((s) => s.name).sort(), ['freeze', 'noisy']);
});

test('listSkills: follows symlinked skill dirs; a cycle re-lists files until the depth bound', async () => {
  const loopRoot = join(scratch, 'loop');
  const spin = join(loopRoot, 'spin');
  mkdirSync(join(spin, 'sub'), { recursive: true });
  writeFileSync(join(spin, 'SKILL.md'), 'body');
  writeFileSync(join(spin, 'sub', 'note.md'), 'x');
  try {
    symlinkSync(spin, join(spin, 'loop'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch {
    return; // no symlink privilege in this environment — cycle branch stays Rust-pinned
  }
  const { scopes } = await listSkills(loopRoot);
  const files = scopes[0].skills.find((s) => s.name === 'spin').files;
  assert.ok(files.includes('sub/note.md'));
  assert.ok(files.includes('loop/sub/note.md'), 'symlinked dirs followed at every level');
  const dup = files.filter((f) => f.endsWith('note.md')).length;
  assert.ok(dup > 1, `cycle re-lists reachable files (${dup} occurrences)`);
  assert.ok(dup <= 7, 'the depth bound ends the cycle');
});

test('skills read handlers map a bridge failure to an explicit 500 sentinel', async () => {
  const app = Fastify();
  const broken = {
    skillsList: async () => { throw new Error('child exited'); },
    skillRead: async () => { throw new Error('child exited'); },
    skillFileRead: async () => { throw new Error('child exited'); },
  };
  app.get('/api/skills', createSkillsListHandler(broken, app.log));
  app.get('/api/skill', createSkillReadHandler(broken, app.log));
  const list = await app.inject({ url: '/api/skills?root=/x' });
  assert.equal(list.statusCode, 500);
  assert.deepEqual(list.json(), { error: 'skills list backend unavailable' });
  const read = await app.inject({ url: '/api/skill?root=/x&scope=s&skill=k' });
  assert.equal(read.statusCode, 500);
  assert.deepEqual(read.json(), { ok: false, error: 'skills read backend unavailable' });
  const fileRead = await app.inject({ url: '/api/skill?root=/x&scope=s&skill=k&file=a.md' });
  assert.equal(fileRead.statusCode, 500);
  assert.deepEqual(fileRead.json(), { ok: false, error: 'skills read backend unavailable' });
  await app.close();
});
