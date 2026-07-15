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
import { tmpdir } from 'node:os';

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
mkdirSync(join(root, 'coding', '.claude', 'skills', 'noisy'), { recursive: true });
writeFileSync(join(root, 'coding', '.claude', 'skills', 'noisy', 'SKILL.md'), '# noisy\n\nno frontmatter');
mkdirSync(join(root, 'common', '.claude', 'skills', 'x'), { recursive: true });
writeFileSync(join(root, 'common', '.claude', 'skills', 'x', 'SKILL.md'), '---\nname: x\ndescription: hidden\n---\n');
mkdirSync(join(root, 'empty', '.claude'), { recursive: true });

const { listSkills, readSkill } = await import('./skills.mjs');

test('listSkills: excludes common, skips scopes with no skills, carries description', () => {
  const { scopes } = listSkills();
  assert.deepEqual(scopes.map((s) => s.name), ['coding'], 'common excluded, empty skipped');
  const coding = scopes[0];
  assert.deepEqual(coding.skills.map((s) => s.name), ['freeze', 'noisy'], 'sorted');
  assert.equal(coding.skills.find((s) => s.name === 'freeze').description, 'Lock edits to a directory.');
  assert.equal(coding.skills.find((s) => s.name === 'noisy').description, '');
});

test('readSkill: rejects bad names', () => {
  assert.equal(readSkill('../x', 'freeze').ok, false);
  assert.equal(readSkill('a/b', 'freeze').ok, false);
  assert.equal(readSkill('', 'freeze').ok, false);
  assert.equal(readSkill('..', 'x').ok, false, 'bare .. scope would traverse above root');
  assert.equal(readSkill('coding', '..').ok, false, 'bare .. skill would traverse above skills dir');
  assert.equal(readSkill('coding', '.').ok, false);
  assert.equal(readSkill('coding', '...').ok, false);
  assert.equal(readSkill('coding', 'nope').ok, false, 'missing skill');
});

test('readSkill: returns structured meta + body + path for a real skill', () => {
  const r = readSkill('coding', 'freeze');
  assert.ok(r.ok);
  assert.equal(r.name, 'freeze');
  assert.equal(r.description, 'Lock edits to a directory.');
  assert.deepEqual(r.triggers, ['freeze edits']);
  assert.match(r.body, /# freeze/);
  assert.match(r.path, /coding.*SKILL\.md$/);
});