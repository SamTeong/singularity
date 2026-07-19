import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// rules.mjs imports app-dir.mjs (STATE_DIR), which throws without SINGULARITY_HOME.
// Point it at a scratch temp dir before a dynamic import (static imports hoist).
process.env.SINGULARITY_HOME = mkdtempSync(join(tmpdir(), 'sing-home-'));
const { getRulesRoots, setRulesRoots, listRuleFiles, searchRules, isRulePath, readRuleFile, writeRuleFile } = await import('./rules.mjs');

// A base root's rules live at <base>/.claude/rules — make + return that dir.
const mkRoot = () => {
  const root = mkdtempSync(join(tmpdir(), 'sing-rules-'));
  const dir = join(root, '.claude', 'rules');
  mkdirSync(dir, { recursive: true });
  return { root, dir };
};

test('rules roots persist to FS: default ~, dedup, roundtrip', () => {
  assert.deepEqual(getRulesRoots(), ['~']); // seeded default when file absent
  const { root } = mkRoot();
  const r = setRulesRoots([root, root, 123, '']);
  assert.equal(r.ok, true);
  assert.deepEqual(r.roots, [root]); // deduped, non-strings dropped
  assert.deepEqual(getRulesRoots(), [root]); // read back from disk
});

test('listRuleFiles finds .md under <base>/.claude/rules, skips non-.md', async () => {
  const { root, dir } = mkRoot();
  mkdirSync(join(dir, 'sub'), { recursive: true });
  writeFileSync(join(dir, 'a.md'), 'hello world');
  writeFileSync(join(dir, 'sub', 'b.md'), 'nested rule');
  writeFileSync(join(dir, 'ignore.txt'), 'not markdown');

  const { files, capped } = await listRuleFiles([root]);
  assert.equal(capped, false);
  assert.equal(files.length, 2);
  const rels = files.map((f) => f.rel).sort();
  assert.deepEqual(rels, ['a.md', 'sub/b.md']); // rel is relative to the rules dir
  assert.equal(files.find((f) => f.rel === 'a.md').file, 'a.md');
  assert.equal(files[0].root, root); // grouped under the picked base
});

test('searchRules finds a hit with line + snippet', async () => {
  const { root, dir } = mkRoot();
  writeFileSync(join(dir, 'a.md'), 'line one\nfind me here\nline three');

  const { results, capped } = await searchRules([root], 'find me');
  assert.equal(capped, false);
  assert.equal(results.length, 1);
  assert.equal(results[0].line, 2);
  assert.match(results[0].text, /find me here/);
});

test('isRulePath rejects a path outside all persisted rules dirs', () => {
  const { root, dir } = mkRoot();
  writeFileSync(join(dir, 'a.md'), 'x');
  setRulesRoots([root]);

  assert.equal(isRulePath(join(dir, 'a.md')), true);
  assert.equal(isRulePath(join(root, 'a.md')), false); // base itself, not under .claude/rules
  assert.equal(isRulePath(join(dir, 'sub', '..', '..', 'escape.md')), false);
  assert.equal(isRulePath(join(tmpdir(), 'outside.md')), false); // outside any root
  assert.equal(isRulePath(join(dir, 'a.txt')), false); // wrong ext
  assert.equal(isRulePath(''), false);
  assert.equal(isRulePath(null), false);
});

test('writeRuleFile then readRuleFile round-trips', () => {
  const { root, dir } = mkRoot();
  setRulesRoots([root]);
  const p = join(dir, 'note.md');

  const w = writeRuleFile(p, '# hello');
  assert.equal(w.ok, true);
  const r = readRuleFile(p);
  assert.equal(r.ok, true);
  assert.equal(r.content, '# hello');
});
