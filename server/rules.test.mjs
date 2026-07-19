import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// rules.mjs imports app-dir.mjs (STATE_DIR), which throws without SINGULARITY_HOME.
// Point it at a scratch temp dir before a dynamic import (static imports hoist).
process.env.SINGULARITY_HOME = mkdtempSync(join(tmpdir(), 'sing-home-'));
const { getRulesRoots, setRulesRoots, listRuleFiles, searchRules, isRulePath, readRuleFile, writeRuleFile } = await import('./rules.mjs');

test('rules roots persist to FS: default ~/.claude/rules, dedup, roundtrip', () => {
  assert.deepEqual(getRulesRoots(), ['~/.claude/rules']); // seeded default when file absent
  const root = mkdtempSync(join(tmpdir(), 'sing-rules-'));
  const r = setRulesRoots([root, root, 123, '']);
  assert.equal(r.ok, true);
  assert.deepEqual(r.roots, [root]); // deduped, non-strings dropped
  assert.deepEqual(getRulesRoots(), [root]); // read back from disk
});

test('listRuleFiles finds .md under a temp root, skips non-.md', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sing-rules-'));
  mkdirSync(join(root, 'sub'), { recursive: true });
  writeFileSync(join(root, 'a.md'), 'hello world');
  writeFileSync(join(root, 'sub', 'b.md'), 'nested rule');
  writeFileSync(join(root, 'ignore.txt'), 'not markdown');

  const { files, capped } = await listRuleFiles([root]);
  assert.equal(capped, false);
  assert.equal(files.length, 2);
  const rels = files.map((f) => f.rel).sort();
  assert.deepEqual(rels, ['a.md', 'sub/b.md']);
  assert.equal(files.find((f) => f.rel === 'a.md').file, 'a.md');
});

test('searchRules finds a hit with line + snippet', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sing-rules-'));
  writeFileSync(join(root, 'a.md'), 'line one\nfind me here\nline three');

  const { results, capped } = await searchRules([root], 'find me');
  assert.equal(capped, false);
  assert.equal(results.length, 1);
  assert.equal(results[0].line, 2);
  assert.match(results[0].text, /find me here/);
});

test('isRulePath rejects a path outside all persisted roots', () => {
  const root = mkdtempSync(join(tmpdir(), 'sing-rules-'));
  writeFileSync(join(root, 'a.md'), 'x');
  setRulesRoots([root]);

  assert.equal(isRulePath(join(root, 'a.md')), true);
  assert.equal(isRulePath(join(root, 'sub', '..', '..', 'escape.md')), false);
  assert.equal(isRulePath(join(tmpdir(), 'outside.md')), false); // outside any root
  assert.equal(isRulePath(join(root, 'a.txt')), false); // wrong ext
  assert.equal(isRulePath(''), false);
  assert.equal(isRulePath(null), false);
});

test('writeRuleFile then readRuleFile round-trips', () => {
  const root = mkdtempSync(join(tmpdir(), 'sing-rules-'));
  setRulesRoots([root]);
  const p = join(root, 'note.md');

  const w = writeRuleFile(p, '# hello');
  assert.equal(w.ok, true);
  const r = readRuleFile(p);
  assert.equal(r.ok, true);
  assert.equal(r.content, '# hello');
});
