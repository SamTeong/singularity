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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, utimesSync, symlinkSync } from 'node:fs';
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
const { listSkills, readSkillsDir, readSkill, readSkillFile, writeSkill, writeSkillFile, getSkillsRoots, setSkillsRoots, setSkillsBackend, createSkillsListHandler, createSkillReadHandler } = await import('./skills.mjs');
const { STATE_DIR } = await import('./app-dir.mjs');
setSkillsBackend(backend);
after(async () => { await backend.stop(); rmSync(scratch, { recursive: true, force: true }); });

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
test('getSkillsRoots: defaults to ~/.claude/skills when nothing is configured', () => {
  assert.deepEqual(getSkillsRoots(), [join(homedir(), '.claude', 'skills')]);
});

// Runs before any setSkillsRoots call, so `skills-roots.json` doesn't exist yet
// and the old single-root file is the only thing to migrate from.
test('getSkillsRoots: migrates from old skills-root.json when present', () => {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(join(STATE_DIR, 'skills-root.json'), JSON.stringify({ root }));
  assert.deepEqual(getSkillsRoots(), [root]);
});

test('setSkillsRoots: persists + getSkillsRoots reads back the array', () => {
  const r = setSkillsRoots([root, flatRoot]);
  assert.deepEqual(r, { ok: true, roots: [root, flatRoot] });
  assert.deepEqual(getSkillsRoots(), [root, flatRoot]);
});

test('setSkillsRoots: dedups and caps at 50', () => {
  const many = Array.from({ length: 60 }, (_, i) => `${root}-${i % 10}`);
  const r = setSkillsRoots(many);
  assert.equal(r.ok, true);
  assert.equal(r.roots.length, 10, 'deduped to 10 unique values');
  assert.deepEqual(getSkillsRoots(), r.roots);
});

test('setSkillsRoots: bad input (non-array) reports ok:false', () => {
  assert.equal(setSkillsRoots('not-an-array').ok, false);
  assert.equal(setSkillsRoots(null).ok, false);
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
  const rejected = await writeSkillFile(root, 'coding', 'freeze', 'scripts/run.mjs', 'v2', false, stale);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error, 'changed on disk');
  assert.equal(readFileSync(fp, 'utf8'), 'v-external');
  // force overrides the drift.
  const forced = await writeSkillFile(root, 'coding', 'freeze', 'scripts/run.mjs', 'v-forced', false, stale, true);
  assert.equal(forced.ok, true);
  assert.equal(typeof forced.mtime, 'number');
  assert.equal(readFileSync(fp, 'utf8'), 'v-forced');
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