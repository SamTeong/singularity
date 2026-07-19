import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// config.mjs imports app-dir.mjs (STATE_DIR), which throws without SINGULARITY_HOME.
// Point it at a scratch temp dir before a dynamic import (static imports hoist).
process.env.SINGULARITY_HOME = mkdtempSync(join(tmpdir(), 'sing-home-'));
const { searchConfig, findConfigRoots, getConfigRoots, setConfigRoots } = await import('./config.mjs');

function makeRoot(project, local) {
  const cwd = mkdtempSync(join(tmpdir(), 'sing-cfg-'));
  mkdirSync(join(cwd, '.claude'), { recursive: true });
  if (project != null) writeFileSync(join(cwd, '.claude', 'settings.json'), project);
  if (local != null) writeFileSync(join(cwd, '.claude', 'settings.local.json'), local);
  return cwd;
}

test('searchConfig matches content and reports scope + line', () => {
  const cwd = makeRoot('{\n  "theme": "dark"\n}', null);
  const hits = searchConfig([cwd], 'theme');
  const project = hits.find((h) => h.cwd === cwd && h.scope === 'project');
  assert.ok(project, 'project scope hit');
  assert.equal(project.line, 2);
  assert.match(project.text, /theme/);
});

test('searchConfig is case-insensitive and skips non-matches', () => {
  const cwd = makeRoot('{ "model": "opus" }', '{ "other": 1 }');
  assert.equal(searchConfig([cwd], 'MODEL').some((h) => h.scope === 'project'), true);
  assert.equal(searchConfig([cwd], 'model').some((h) => h.scope === 'local'), false);
});

test('searchConfig dedups shared paths across repeated roots', () => {
  const cwd = makeRoot('{ "theme": "dark" }', null);
  // Same root twice → project path seen once, not duplicated.
  const hits = searchConfig([cwd, cwd], 'theme');
  assert.equal(hits.filter((h) => h.scope === 'project' && h.cwd === cwd).length, 1);
});

test('searchConfig empty query returns nothing', () => {
  assert.deepEqual(searchConfig(['/whatever'], ''), []);
});

test('findConfigRoots finds nested dirs holding .claude settings, skips others', () => {
  const root = mkdtempSync(join(tmpdir(), 'sing-scan-'));
  // root itself: no .claude. nested/a has settings.json, nested/b/deep has local.
  mkdirSync(join(root, 'nested', 'a', '.claude'), { recursive: true });
  writeFileSync(join(root, 'nested', 'a', '.claude', 'settings.json'), '{}');
  mkdirSync(join(root, 'nested', 'b', 'deep', '.claude'), { recursive: true });
  writeFileSync(join(root, 'nested', 'b', 'deep', '.claude', 'settings.local.json'), '{}');
  // node_modules is skipped even with a matching config inside.
  mkdirSync(join(root, 'node_modules', 'pkg', '.claude'), { recursive: true });
  writeFileSync(join(root, 'node_modules', 'pkg', '.claude', 'settings.json'), '{}');
  // .claude dir with no settings file → not a hit.
  mkdirSync(join(root, 'empty', '.claude'), { recursive: true });

  const { roots, truncated } = findConfigRoots(root);
  assert.equal(truncated, false);
  assert.deepEqual(roots, [join(root, 'nested', 'a'), join(root, 'nested', 'b', 'deep')]);
});

test('config roots persist to FS: default ~, dedup, roundtrip', () => {
  assert.deepEqual(getConfigRoots(), ['~']); // seeded default when file absent
  const r = setConfigRoots(['~', '/a', '/a', '/b', 123, '']);
  assert.equal(r.ok, true);
  assert.deepEqual(r.roots, ['~', '/a', '/b']); // deduped, non-strings dropped
  assert.deepEqual(getConfigRoots(), ['~', '/a', '/b']); // read back from disk
});
