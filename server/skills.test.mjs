// Unit tests for the skills viewer (listSkills/readSkill). skills.mjs reads
// SING_SCOPE_ROOT via agents.mjs at load, so both SINGULARITY_HOME and
// SING_SCOPE_ROOT are pointed at scratch temp dirs BEFORE the module graph is
// imported (dynamic import after the env tweak). One shared tree per file —
// matches crons.test.mjs convention (a single top-level import, not per-test).
// Run: npm test  (node --test server/)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';

const scratch = mkdtempSync(join(tmpdir(), 'singularity-skills-test-'));
const root = join(scratch, 'scopes');
mkdirSync(root, { recursive: true });
process.env.SINGULARITY_HOME = join(scratch, 'singularity');
process.env.SING_SCOPE_ROOT = root;
after(() => rmSync(scratch, { recursive: true, force: true }));

// Shared tree: coding (freeze with desc, noisy without frontmatter), common
// (must be excluded), empty (scope with no skills dir).
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

const { listSkills, readSkill, readSkillFile, writeSkill, writeSkillFile, getSkillsRoots, setSkillsRoots } = await import('./skills.mjs');
const { STATE_DIR } = await import('./app-dir.mjs');

test('listSkills: grouped — excludes common, skips scopes with no skills, carries description', () => {
  const { scopes, flat } = listSkills(root);
  assert.equal(flat, false);
  assert.deepEqual(scopes.map((s) => s.name), ['coding'], 'common excluded, empty skipped');
  const coding = scopes[0];
  assert.deepEqual(coding.skills.map((s) => s.name), ['freeze', 'noisy'], 'sorted');
  assert.equal(coding.skills.find((s) => s.name === 'freeze').description, 'Lock edits to a directory.');
  assert.equal(coding.skills.find((s) => s.name === 'noisy').description, '');
});

test('listSkills: carries supporting files (relative paths, SKILL.md excluded)', () => {
  const { scopes } = listSkills(root);
  const freeze = scopes[0].skills.find((s) => s.name === 'freeze');
  assert.deepEqual(freeze.files, ['references/notes.md', 'scripts/run.mjs']);
  const noisy = scopes[0].skills.find((s) => s.name === 'noisy');
  assert.deepEqual(noisy.files, []);
});

test('readSkillFile: grouped reads a supporting file with type', () => {
  const r = readSkillFile(root, 'coding', 'freeze', 'scripts/run.mjs');
  assert.ok(r.ok);
  assert.equal(r.type, 'code');
  assert.match(r.content, /console\.log/);
  const md = readSkillFile(root, 'coding', 'freeze', 'references/notes.md');
  assert.equal(md.type, 'markdown');
  assert.match(md.content, /# notes/);
});

test('readSkillFile: rejects traversal and bad file paths', () => {
  assert.equal(readSkillFile(root, 'coding', 'freeze', '../SKILL.md').ok, false, '.. segment rejected');
  assert.equal(readSkillFile(root, 'coding', 'freeze', 'scripts/../run.mjs').ok, false, '.. segment in middle rejected');
  assert.equal(readSkillFile(root, 'coding', 'freeze', 'nope.mjs').ok, false, 'missing file');
  assert.equal(readSkillFile(root, 'coding', 'freeze', '').ok, false, 'empty file');
});

test('readSkillFile: flat resolves <root>/<skill>/<file>', () => {
  // flat fixture has no supporting files; create one on the fly.
  writeFileSync(join(flatRoot, 'declawed', 'scripts.js'), 'x');
  const r = readSkillFile(flatRoot, null, 'declawed', 'scripts.js', true);
  assert.ok(r.ok);
  assert.equal(r.type, 'code');
});

test('writeSkill: round-trips raw content (frontmatter preserved)', () => {
  const r = writeSkill(root, 'coding', 'noisy', '# rewritten\n\nnew body');
  assert.equal(r.ok, true);
  const back = readSkill(root, 'coding', 'noisy');
  assert.equal(back.ok, true);
  assert.equal(back.raw, '# rewritten\n\nnew body');
});

test('writeSkill: rejects bad names + non-string content', () => {
  assert.equal(writeSkill(root, '..', 'x', 'y').ok, false);
  assert.equal(writeSkill(root, 'coding', '..', 'y').ok, false);
  assert.equal(writeSkill(root, 'coding', 'nope', null).ok, false, 'non-string content');
});

test('writeSkillFile: writes + round-trips a supporting file', () => {
  const r = writeSkillFile(root, 'coding', 'freeze', 'scripts/run.mjs', "console.log('new')");
  assert.equal(r.ok, true);
  const back = readSkillFile(root, 'coding', 'freeze', 'scripts/run.mjs');
  assert.equal(back.content, "console.log('new')");
});

test('writeSkillFile: rejects traversal, image edit, bad content', () => {
  assert.equal(writeSkillFile(root, 'coding', 'freeze', '../SKILL.md', 'x').ok, false, 'traversal');
  assert.equal(writeSkillFile(root, 'coding', 'freeze', 'scripts/run.mjs', 42).ok, false, 'non-string content');
  // image ext → not editable
  assert.equal(writeSkillFile(root, 'coding', 'freeze', 'a.png', 'x').ok, false, 'image not editable');
});

test('listSkills: flat — root is a .claude/skills dir, one scope', () => {
  const { scopes, flat } = listSkills(flatRoot);
  assert.equal(flat, true);
  assert.equal(scopes.length, 1, 'single synthetic scope');
  assert.equal(scopes[0].name, 'flat');
  assert.deepEqual(scopes[0].skills.map((s) => s.name), ['declawed'], 'no-SKILL.md subdir skipped');
});

test('listSkills: bad root reports error', () => {
  assert.equal(listSkills(join(scratch, 'nope')).error, 'skills root not found');
});

test('readSkill: grouped rejects bad names', () => {
  assert.equal(readSkill(root, '../x', 'freeze').ok, false);
  assert.equal(readSkill(root, 'a/b', 'freeze').ok, false);
  assert.equal(readSkill(root, '..', 'x').ok, false, 'bare .. scope would traverse above root');
  assert.equal(readSkill(root, 'coding', '..').ok, false, 'bare .. skill would traverse above skills dir');
  assert.equal(readSkill(root, 'coding', '.').ok, false);
  assert.equal(readSkill(root, 'coding', '...').ok, false);
  assert.equal(readSkill(root, 'coding', 'nope').ok, false, 'missing skill');
});

test('readSkill: grouped returns structured meta + body + path', () => {
  const r = readSkill(root, 'coding', 'freeze');
  assert.ok(r.ok);
  assert.equal(r.name, 'freeze');
  assert.equal(r.description, 'Lock edits to a directory.');
  assert.deepEqual(r.triggers, ['freeze edits']);
  assert.match(r.body, /# freeze/);
  assert.match(r.path, /coding.*SKILL\.md$/);
});

test('readSkill: flat resolves <root>/<skill>/SKILL.md, ignores scope', () => {
  const r = readSkill(flatRoot, null, 'declawed', true);
  assert.ok(r.ok);
  assert.equal(r.name, 'declawed');
  assert.equal(readSkill(flatRoot, null, '..', true).ok, false, 'bad skill name still rejected in flat');
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