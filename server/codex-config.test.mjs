import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

// codex-config.mjs imports app-dir.mjs (STATE_DIR), which throws without
// SINGULARITY_HOME. Point it at a scratch temp dir before a dynamic import
// (static imports hoist).
process.env.SINGULARITY_HOME = mkdtempSync(join(tmpdir(), 'sing-home-'));
const { readConfig, searchConfig, findConfigRoots, getConfigRoots, setConfigRoots, writeConfig } = await import('./codex-config.mjs');

function makeRoot(toml) {
  const cwd = mkdtempSync(join(tmpdir(), 'sing-cdx-'));
  mkdirSync(join(cwd, '.codex'), { recursive: true });
  if (toml != null) writeFileSync(join(cwd, '.codex', 'config.toml'), toml);
  return cwd;
}

test('searchConfig matches content and reports scope + line', () => {
  const cwd = makeRoot('model = "gpt-5"\ntheme = "dark"\n');
  const hits = searchConfig([cwd], 'theme');
  const project = hits.find((h) => h.cwd === cwd && h.scope === 'project');
  assert.ok(project, 'project scope hit');
  assert.equal(project.line, 2);
  assert.match(project.text, /theme/);
});

test('searchConfig is case-insensitive and skips non-matches', () => {
  const cwd = makeRoot('model = "x"\n');
  assert.equal(searchConfig([cwd], 'MODEL').some((h) => h.scope === 'project'), true);
});

test('searchConfig dedups shared paths across repeated roots', () => {
  const cwd = makeRoot('theme = "dark"\n');
  const hits = searchConfig([cwd, cwd], 'theme');
  assert.equal(hits.filter((h) => h.scope === 'project' && h.cwd === cwd).length, 1);
});

test('searchConfig empty query returns nothing', () => {
  assert.deepEqual(searchConfig(['/whatever'], ''), []);
});

test('findConfigRoots finds nested dirs holding .codex/config.toml, skips others', () => {
  const root = mkdtempSync(join(tmpdir(), 'sing-scan-'));
  // root itself: no .codex. nested/a has config.toml, nested/b/deep has config.toml.
  mkdirSync(join(root, 'nested', 'a', '.codex'), { recursive: true });
  writeFileSync(join(root, 'nested', 'a', '.codex', 'config.toml'), 'model = "x"\n');
  mkdirSync(join(root, 'nested', 'b', 'deep', '.codex'), { recursive: true });
  writeFileSync(join(root, 'nested', 'b', 'deep', '.codex', 'config.toml'), 'model = "y"\n');
  // node_modules is skipped even with a matching config inside.
  mkdirSync(join(root, 'node_modules', 'pkg', '.codex'), { recursive: true });
  writeFileSync(join(root, 'node_modules', 'pkg', '.codex', 'config.toml'), 'model = "z"\n');
  // .codex dir with no config.toml → not a hit.
  mkdirSync(join(root, 'empty', '.codex'), { recursive: true });

  const { roots, truncated } = findConfigRoots(root);
  assert.equal(truncated, false);
  assert.deepEqual(roots, [join(root, 'nested', 'a'), join(root, 'nested', 'b', 'deep')]);
});

test('codex config roots persist to FS: default ~, dedup, roundtrip', () => {
  assert.deepEqual(getConfigRoots(), ['~']); // seeded default when file absent
  const r = setConfigRoots(['~', '/a', '/a', '/b', 123, '']);
  assert.equal(r.ok, true);
  assert.deepEqual(r.roots, ['~', '/a', '/b']); // deduped, non-strings dropped
  assert.deepEqual(getConfigRoots(), ['~', '/a', '/b']); // read back from disk
});

test('writeConfig valid TOML writes + backup', () => {
  const cwd = makeRoot('model = "x"\n');
  setConfigRoots([cwd]); // writeConfig requires isKnownConfigRoot(cwd)
  const r = writeConfig(cwd, 'project', 'model = "y"\n');
  assert.equal(r.ok, true);
  assert.equal(r.path, join(cwd, '.codex', 'config.toml'));
  assert.equal(readFileSync(join(cwd, '.codex', 'config.toml'), 'utf8'), 'model = "y"\n');
  assert.equal(existsSync(r.backup), true);
});

test('writeConfig invalid TOML returns ok:false and does not write', () => {
  const cwd = makeRoot('model = "x"\n');
  setConfigRoots([cwd]);
  const orig = readFileSync(join(cwd, '.codex', 'config.toml'), 'utf8');
  const r = writeConfig(cwd, 'project', 'model = "unterminated\n');
  assert.equal(r.ok, false);
  assert.match(r.error, /TOML/);
  assert.equal(readFileSync(join(cwd, '.codex', 'config.toml'), 'utf8'), orig);
});

test('writeConfig rejects cwd outside config roots', () => {
  const cwd = makeRoot('model = "x"\n');
  setConfigRoots([mkdtempSync(join(tmpdir(), 'sing-other-'))]); // a different root
  const r = writeConfig(cwd, 'project', 'model = "y"\n');
  assert.equal(r.ok, false);
  assert.match(r.error, /outside config roots/);
});

test('writeConfig enforces cwd<->scope invariant', () => {
  const cwd = makeRoot('model = "x"\n');
  setConfigRoots([cwd]);
  // user scope requires cwd ~ (home); a project cwd is not home.
  assert.equal(writeConfig(cwd, 'user', 'model = "y"\n').ok, false);
  // project scope requires a non-home cwd; home (untildified ~) is home.
  setConfigRoots(['~']);
  const rp = writeConfig(homedir(), 'project', 'model = "y"\n');
  assert.equal(rp.ok, false);
  assert.match(rp.error, /non-home/);
});

test('readConfig rejects cwd outside config roots', () => {
  const cwd = makeRoot('model = "x"\n');
  setConfigRoots([mkdtempSync(join(tmpdir(), 'sing-other-'))]); // a different root
  const result = readConfig(cwd);
  assert.equal(result.project.exists, false);
  assert.equal(result.project.content, '');
  assert.equal(result.user.exists, false);
  assert.equal(result.user.content, '');
  // Path should still be present but file is marked non-existent
  assert.ok(result.project.path);
  assert.ok(result.user.path);
});