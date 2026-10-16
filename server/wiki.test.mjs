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
    '## [9999-99-99] shallow | lanes: all',
    '- Sweep completed.',
    '## [2026-10-15] deep | lanes: all',
    '- Interrupted: sweep not completed because lane 3 failed; lanes 1 and 2 completed.',
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

test('sweep completion markers for individual lanes do not override interruption', () => {
  assert.deepEqual(parseSweepHistory([
    '## [2026-10-15] shallow | lanes: all',
    '- Interrupted: lane 3 failed; lanes 1 and 2 completed.',
    '## [2026-10-12] shallow | lanes: all',
    '- Sweep completed.',
  ].join('\n')), { shallow: '2026-10-12', deep: null, horizon: null });
});

test('negated completion counts as interrupted and the completed override must end its clause', () => {
  const deep = (line) => parseSweepHistory(`## [2026-10-20] deep | lanes: all\n${line}\n`).deep;
  assert.equal(deep('- Sweep not completed: lane 3 failed.'), null);
  assert.equal(deep('- Sweep completed lanes 1 and 2 only; lane 3 interrupted.'), null);
  for (const line of ['- Not completed.', '- Incomplete.', '- Lane 3 failed.', '- Lane 3 did not finish.',
    '- Cancelled by user.', '- Canceled by user.', '- Lane 2 timed out.', '- Partially done.']) {
    assert.equal(deep(line), null, line);
  }
  assert.equal(deep('- Sweep completed.'), '2026-10-20');
  assert.equal(deep('- Sweep completed: lane 3 failed then retried.'), '2026-10-20');
  assert.equal(deep('- Sweep completed - lane 2 timed out on retry'), '2026-10-20');
  assert.equal(deep('- Sweep completed\r\n- one lane failed and was rerun.'), '2026-10-20');
});

test('status words in NEW claim payloads do not mark a completed sweep as interrupted', () => {
  assert.deepEqual(parseSweepHistory([
    '## [2026-10-20] deep | lanes: all',
    '- NEW: [[failed-login-handling]]',
  ].join('\n')), { shallow: null, deep: '2026-10-20', horizon: null });
});

test('long claim rows do not hide a later interrupted sweep marker', () => {
  assert.equal(parseSweepHistory([
    '## [2026-10-20] deep | lanes: all',
    `- NEW: ${'claim '.repeat(220)}`,
    '- Lane 3 failed.',
  ].join('\n')).deep, null);
});

test('sweep types are case-insensitive, rollover dates are rejected, and any heading ends a body', () => {
  assert.deepEqual(parseSweepHistory('## [2026-10-20] Shallow | lanes: all\n- NEW: —\n'), { shallow: '2026-10-20', deep: null, horizon: null });
  assert.deepEqual(parseSweepHistory([
    '## [2026-02-30] shallow | lanes: all',
    '- Sweep completed.',
    '## [2026-02-29] deep | lanes: all',
    '- Sweep completed.',
  ].join('\n')), { shallow: null, deep: null, horizon: null });
  assert.deepEqual(parseSweepHistory([
    '## [2026-10-20] shallow | lanes: all',
    '- NEW: —',
    '## Notes',
    '- partial notes',
    '## [2026-10-19] deep | lanes: all',
    '- NEW: —',
    '## [2026-10-21] lint',
    '- interrupted lint run',
  ].join('\n')), { shallow: '2026-10-20', deep: '2026-10-19', horizon: null });
});

test('sweep type headings reject hyphenated words while retaining supported delimiters', () => {
  assert.deepEqual(parseSweepHistory([
    '## [2026-10-20] deep-dive notes',
    '- Sweep completed.',
    '## [2026-10-19] deep continuation',
    '- Sweep completed.',
    '## [2026-10-18] shallow | lanes: all',
    '- Sweep completed.',
  ].join('\n')), {
    shallow: '2026-10-18',
    deep: '2026-10-19',
    horizon: null,
  });
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
  // index.mjs coerces an array-valued ?root= to null; that path must not throw.
  assert.deepEqual((await wikiSweepHistory(null)).wikis.map((w) => w.shallow), [null, null, null]);
});

test('iap freshness uses wiki-sync.json lastIngestedAt as Deep and ignores any sweep ledger', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wiki-iap-'));
  mkdirSync(join(root, 'iap', 'meta'), { recursive: true });
  const iap = async () => (await wikiSweepHistory(root)).wikis.find((w) => w.name === 'iap');
  assert.deepEqual(await iap(), { name: 'iap', shallow: null, deep: null, horizon: null }); // missing file
  writeFileSync(join(root, 'iap', 'meta', 'websearch-log.md'), '## [2026-10-12] shallow | lanes: all\n- NEW: —\n');
  writeFileSync(join(root, 'iap', 'wiki-sync.json'), JSON.stringify({ lastIngestedAt: '2026-10-10' }));
  assert.deepEqual(await iap(), { name: 'iap', shallow: null, deep: '2026-10-10', horizon: null });
  for (const bad of [{ lastIngestedAt: '2026-02-30' }, { lastIngestedAt: '2026-10-10T08:00:00Z' }, { lastIngestedAt: 20261010 }, {}]) {
    writeFileSync(join(root, 'iap', 'wiki-sync.json'), JSON.stringify(bad));
    assert.equal((await iap()).deep, null, JSON.stringify(bad));
  }
  writeFileSync(join(root, 'iap', 'wiki-sync.json'), '{not json');
  assert.equal((await iap()).deep, null);
});
