// Unit tests for the wiki path guard (isWikiPath) — the read-confinement
// boundary. Run: npm test  (node --test server/)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, sep } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';

// wiki.mjs imports app-dir.mjs (STATE_DIR), which throws without SINGULARITY_HOME.
// Point it at a scratch temp dir before a dynamic import (static imports hoist).
process.env.SINGULARITY_HOME = mkdtempSync(join(tmpdir(), 'sing-home-'));
const { isWikiPath, readWikiFile, getWikiRoot, setWikiRoot, parseSweepHistory, wikiSweepHistory } = await import('./wiki.mjs');

const ROOT = join(homedir(), 'wiki');
const w = (...parts) => join(ROOT, ...parts);

test('accepts a .md file under root, including nested', () => {
  assert.equal(isWikiPath(w('a.md'), ROOT), true);
  assert.equal(isWikiPath(w('notes', 'sub.md'), ROOT), true);
  assert.equal(isWikiPath(w('deep', 'path', 'page.md'), ROOT), true);
});

test('rejects non-.md, outside root, escapes, and empty', () => {
  assert.equal(isWikiPath(w('a.txt'), ROOT), false); // wrong ext
  assert.equal(isWikiPath(join(homedir(), 'evil.md'), ROOT), false); // outside root
  assert.equal(isWikiPath(w('..', '..', 'escape.md'), ROOT), false); // .. escape
  assert.equal(isWikiPath(w('A.MD'), ROOT), true); // case-insensitive ext
  assert.equal(isWikiPath('', ROOT), false);
  assert.equal(isWikiPath(null, ROOT), false);
  assert.equal(isWikiPath(w('a.md'), null), false); // no root
});

// isWikiPath must accept only the server-persisted root — a caller-invented
// root (e.g. the drive root) trivially "contains" any path, so it must not
// be enough to pass the guard on its own.
test('rejects a caller-supplied root that is not the persisted one, even the drive root', () => {
  const driveRoot = ROOT.slice(0, ROOT.indexOf(sep) + 1) || sep; // e.g. "C:\" or "/"
  const evil = join(homedir(), 'secret.md'); // shape-valid (.md), just outside ROOT
  assert.equal(isWikiPath(evil, driveRoot), false);
  assert.equal(readWikiFile(evil, driveRoot).ok, false);
});

test('wiki root persists to FS: default, roundtrip, bad input', () => {
  assert.equal(getWikiRoot(), '~/wiki'); // default when file absent
  assert.deepEqual(setWikiRoot('~/notes'), { ok: true, root: '~/notes' });
  assert.equal(getWikiRoot(), '~/notes'); // read back from disk
  assert.equal(setWikiRoot('').ok, false); // rejects empty
});

test('sweep history keeps latest completed typed entries and ignores interrupted attempts', () => {
  assert.deepEqual(parseSweepHistory([
    '## [2026-10-12] shallow | lanes: all',
    '- NEW: —',
    '## [2026-10-11] horizon | stopped before completion',
    '- This partial sweep stopped before saturation.',
    '## [2026-10-10] horizon continuation | lane 1',
    '- Continuation completed after four rounds.',
    '## [2026-10-04] deep | lanes: all',
    '- OVERTURNS: —',
    '## [2026-10-01] thorough | lanes: all',
    '- not a displayed sweep type',
  ].join('\n')), {
    shallow: '2026-10-12',
    deep: '2026-10-04',
    horizon: '2026-10-10',
  });
  assert.deepEqual(parseSweepHistory(''), { shallow: null, deep: null, horizon: null });
});

test('wiki sweep history returns the three supported domains and null for a missing ledger', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wiki-sweeps-'));
  const ledger = join(root, 'agentic-coding', 'meta', 'websearch-log.md');
  mkdirSync(join(root, 'agentic-coding', 'meta'), { recursive: true });
  writeFileSync(ledger, '## [2026-10-12] shallow | lanes: all\n- NEW: —\n');

  assert.deepEqual(await wikiSweepHistory(root), { wikis: [
    { name: 'agentic-coding', shallow: '2026-10-12', deep: null, horizon: null },
    { name: 'dotnet', shallow: null, deep: null, horizon: null },
    { name: 'iap', shallow: null, deep: null, horizon: null },
  ] });
});
