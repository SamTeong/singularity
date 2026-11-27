import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkRoot, extractRefs, parseFrontmatter } from './check-instructions.mjs';

const roots = [];
after(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

function repo(files) {
  const root = mkdtempSync(join(tmpdir(), 'singularity-instr-'));
  roots.push(root);
  for (const [rel, body] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
  return root;
}

const messages = (root) => checkRoot(root).map((p) => `${p.file}:${p.line}: ${p.message}`);

test('a clean tree reports nothing', () => {
  const root = repo({
    'CLAUDE.md': '# Hi\n@.claude/rules/a.md\n[ref](.claude/rules-reference/r.md#top)\n[web](https://x.test/y)\n',
    '.claude/rules/a.md': 'rule\n',
    '.claude/rules-reference/r.md': 'ref\n',
    '.claude/agents/bot.md': '---\nname: bot\ndescription: >\n  does things\n  well\n---\nbody\n',
    '.claude/skills/add/SKILL.md': '---\nname: add\ndescription: "adds"\n---\n',
    'openspec/specs/x/spec.md': '# spec\n',
  });
  assert.deepEqual(messages(root), []);
});

test('frontmatter errors carry file line numbers', () => {
  const root = repo({
    '.claude/rules/a.md': '---\ntitle: ok\nnot a key\n---\n',
    '.claude/rules/b.md': '---\ntitle: never closed\n',
  });
  assert.deepEqual(messages(root), [
    '.claude/rules/a.md:3: frontmatter line is not "key: value": not a key',
    '.claude/rules/b.md:1: frontmatter is not closed with ---',
  ]);
});

test('agents and skills need name and description; skill name equals its dir', () => {
  const root = repo({
    '.claude/agents/none.md': 'no frontmatter\n',
    '.claude/agents/half.md': '---\nname: half\n---\n',
    '.claude/skills/one/SKILL.md': '---\nname: other\ndescription: d\n---\n',
  });
  assert.deepEqual(messages(root).sort(), [
    '.claude/agents/half.md:1: frontmatter is missing "description"',
    '.claude/agents/none.md:1: agent needs YAML frontmatter with name and description',
    '.claude/skills/one/SKILL.md:1: skill name "other" must equal its directory "one"',
  ]);
});

test('broken links and @imports are reported, code spans and fences are ignored', () => {
  const root = repo({
    'AGENTS.md': [
      '[gone](missing.md)',
      '@.claude/rules/nope.md',
      '`[inline](ignored.md)`',
      '```',
      '[fenced](ignored.md)',
      '@ignored/file.md',
      '```',
      '[anchor](#here) [mail](mailto:a@b.c)',
      '',
    ].join('\n'),
  });
  assert.deepEqual(messages(root), [
    'AGENTS.md:1: link does not resolve: missing.md',
    'AGENTS.md:2: @import does not resolve: .claude/rules/nope.md',
  ]);
});

test('links resolve relative to the containing file', () => {
  const root = repo({
    '.claude/rules/a.md': '[sib](b.md) [up](../rules-reference/r.md) [bad](../c.md)\n',
    '.claude/rules/b.md': '',
    '.claude/rules-reference/r.md': '',
  });
  assert.deepEqual(messages(root), ['.claude/rules/a.md:1: link does not resolve: ../c.md']);
});

test('parser helpers', () => {
  assert.equal(parseFrontmatter('# none').present, false);
  assert.deepEqual(parseFrontmatter('---\nname: "x y"\n---\n').data, { name: 'x y' });
  assert.deepEqual(extractRefs('see [a](b.md "t")\n@x/y.md\n@mention text'), [
    { line: 1, kind: 'link', target: 'b.md' },
    { line: 2, kind: '@import', target: 'x/y.md' },
  ]);
});
