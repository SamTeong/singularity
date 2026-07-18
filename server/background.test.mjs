// Unit tests for the background-task pure functions (inWindow / evalGate /
// pickDef / pickRunnableDef / watchdogDecision / migrateLegacyConfig) +
// createTask tag normalization. background.mjs pulls in agents.mjs ->
// app-dir.mjs, which throws without SINGULARITY_HOME, so point it at a scratch
// temp dir *before* the dynamic import (same pattern as crons.test.mjs). No
// agent is ever spawned: the pure fns take a def argument, and the tags test
// exercises the exported normalizeTags helper directly rather than createTask
// (which would try to spawn a real claude). Run: npm test
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const scratch = mkdtempSync(join(tmpdir(), 'singularity-background-test-'));
process.env.SINGULARITY_HOME = join(scratch, 'singularity');
after(() => rmSync(scratch, { recursive: true, force: true }));

const { inWindow, evalGate, pickDef, pickRunnableDef, watchdogDecision, migrateLegacyConfig, createDef, updateDef, listReports, getReport } = await import('./background.mjs');
const { normalizeTags, initTasks } = await import('./tasks.mjs');
const { STATE_DIR } = await import('./agents.mjs');

// Full per-def config shape (window/thresholds/tokenCaps) — same values the old
// global DEFAULT_CONFIG shipped, now owned by each def.
const def = (over = {}) => ({
  id: 'a', title: 'a', enabled: true, cooldownHours: 24, lastRunAt: null,
  window: { startHour: 9, endHour: 18, days: [1, 2, 3, 4, 5] },
  thresholds: {
    claude: { start: 50, stop: 75, weeklyMax: 75 },
    ollama: { start: 50, stop: 75, weeklyMax: 75 },
  },
  tokenCaps: { claude: 15_000_000, ollama: 2_000_000 },
  ...over,
});
const src = (over = {}) => ({ ok: true, session: { pctUsed: 10 }, weekly: { pctUsed: 10 }, ...over });

// ---- inWindow ------------------------------------------------------------------
// 2026-07-15 = Wednesday (getDay 3), 2026-07-18 = Saturday (getDay 6).
test('inWindow: weekday inside hours is true', () => {
  assert.equal(inWindow(def(), new Date(2026, 6, 15, 10)), true);
});
test('inWindow: weekend is false', () => {
  assert.equal(inWindow(def(), new Date(2026, 6, 18, 10)), false);
});
test('inWindow: startHour inclusive, endHour exclusive', () => {
  assert.equal(inWindow(def(), new Date(2026, 6, 15, 9)), true);
  assert.equal(inWindow(def(), new Date(2026, 6, 15, 18)), false);
  assert.equal(inWindow(def(), new Date(2026, 6, 15, 8)), false);
});

// ---- evalGate ------------------------------------------------------------------
test('evalGate: claude within budget → claude', () => {
  const g = evalGate({ claude: src(), ollama: src() }, def());
  assert.equal(g.backend, 'claude');
});
test('evalGate: claude over start → ollama', () => {
  const g = evalGate({ claude: src({ session: { pctUsed: 60 } }), ollama: src() }, def());
  assert.equal(g.backend, 'ollama');
});
test('evalGate: both over → null with reason', () => {
  const g = evalGate({
    claude: src({ session: { pctUsed: 60 } }),
    ollama: src({ weekly: { pctUsed: 80 } }),
  }, def());
  assert.equal(g.backend, null);
  assert.equal(typeof g.reason, 'string');
  assert.ok(g.reason.length > 0);
});
test('evalGate: claude ok:false fails closed → ollama evaluated', () => {
  const g = evalGate({ claude: { ok: false, error: 'auth' }, ollama: src() }, def());
  assert.equal(g.backend, 'ollama');
});

// ---- pickDef (forced-bypass: ignores window+gate) -------------------------------
const now = 1_000_000_000_000;
const hr = 3_600_000;
test('pickDef: cooldown excludes a recently-run def', () => {
  const defs = [def({ lastRunAt: now - hr })];
  assert.equal(pickDef(defs, now), null);
});
test('pickDef: round-robin picks the oldest lastRunAt', () => {
  const defs = [
    def({ id: 'new', cooldownHours: 1, lastRunAt: now - 2 * hr }),
    def({ id: 'old', cooldownHours: 1, lastRunAt: now - 10 * hr }),
  ];
  assert.equal(pickDef(defs, now).id, 'old');
});
test('pickDef: null lastRunAt wins (never run)', () => {
  const defs = [
    def({ id: 'ran', cooldownHours: 1, lastRunAt: now - 10 * hr }),
    def({ id: 'fresh', cooldownHours: 1, lastRunAt: null }),
  ];
  assert.equal(pickDef(defs, now).id, 'fresh');
});
test('pickDef: disabled defs are skipped', () => {
  const defs = [def({ enabled: false, cooldownHours: 1, lastRunAt: null })];
  assert.equal(pickDef(defs, now), null);
});

// ---- pickRunnableDef (normal path: window + per-def gate folded together) ------
// Fixed instant inside the default window (Wed 2026-07-15 10:00 local).
const inWin = new Date(2026, 6, 15, 10).getTime();
const outWin = new Date(2026, 6, 18, 10).getTime(); // Saturday

test('pickRunnableDef: out-of-window def is skipped → no def ready', () => {
  const defs = [def({ lastRunAt: null })];
  const r = pickRunnableDef(defs, { claude: src(), ollama: src() }, outWin);
  assert.equal(r.def, null);
  assert.equal(r.backend, null);
  assert.equal(r.reason, 'no def ready');
});
test('pickRunnableDef: bypassWindow picks an out-of-window def if its gate passes', () => {
  const defs = [def({ lastRunAt: null })];
  const r = pickRunnableDef(defs, { claude: src(), ollama: src() }, outWin, { bypassWindow: true });
  assert.equal(r.def.id, 'a');
  assert.equal(r.backend, 'claude');
});
test('pickRunnableDef: all in-window candidates fail their own gate → joined reasons', () => {
  const defs = [def({ id: 'x', title: 'x', lastRunAt: null })];
  const usage = { claude: src({ session: { pctUsed: 90 } }), ollama: src({ session: { pctUsed: 90 } }) };
  const r = pickRunnableDef(defs, usage, inWin);
  assert.equal(r.def, null);
  assert.ok(r.reason.includes('x:'), 'reason names the failing def');
});
test('pickRunnableDef: oldest passing candidate wins, skipping a younger passer', () => {
  const defs = [
    def({ id: 'new', cooldownHours: 1, lastRunAt: inWin - 2 * hr }),
    def({ id: 'old', cooldownHours: 1, lastRunAt: inWin - 10 * hr }),
  ];
  const r = pickRunnableDef(defs, { claude: src(), ollama: src() }, inWin);
  assert.equal(r.def.id, 'old');
  assert.equal(r.backend, 'claude');
});

// ---- watchdogDecision ----------------------------------------------------------
test('watchdogDecision: session pct at/over stop → stop', () => {
  assert.equal(watchdogDecision({ claude: src({ session: { pctUsed: 75 } }) }, 'claude', def(), 0), 'stop');
});
test('watchdogDecision: weekly at/over weeklyMax → stop', () => {
  assert.equal(watchdogDecision({ claude: src({ weekly: { pctUsed: 90 } }) }, 'claude', def(), 0), 'stop');
});
test('watchdogDecision: token cap reached → stop', () => {
  assert.equal(watchdogDecision({ claude: src() }, 'claude', def(), 15_000_000), 'stop');
});
test('watchdogDecision: ok:false fails closed → stop', () => {
  assert.equal(watchdogDecision({ claude: { ok: false } }, 'claude', def(), 0), 'stop');
});
test('watchdogDecision: within budget → continue', () => {
  assert.equal(watchdogDecision({ claude: src() }, 'claude', def(), 100), 'continue');
});

// ---- migrateLegacyConfig (global → per-def seeding) ----------------------------
test('migrateLegacyConfig: old flat shape seeds window/thresholds/models/tokenCaps onto every def', () => {
  const legacyWindow = { startHour: 8, endHour: 17, days: [1, 2, 3, 4, 5] };
  const legacyThresholds = { claude: { start: 40, stop: 70, weeklyMax: 70 }, ollama: { start: 40, stop: 70, weeklyMax: 70 } };
  const legacyModels = { claude: 'opus', ollama: 'glm-5.2:cloud' };
  const legacyTokenCaps = { claude: 10_000_000, ollama: 1_000_000 };
  const loaded = {
    enabled: true, tickMinutes: 60,
    window: legacyWindow, thresholds: legacyThresholds, models: legacyModels, tokenCaps: legacyTokenCaps,
    defs: [{ id: 'a', title: 'A', enabled: true, cooldownHours: 24, lastRunAt: null }],
  };
  const { defs, migrated } = migrateLegacyConfig(loaded);
  assert.equal(migrated, true);
  assert.deepEqual(defs[0].window, legacyWindow);
  assert.deepEqual(defs[0].thresholds, legacyThresholds);
  assert.deepEqual(defs[0].models, legacyModels);
  assert.deepEqual(defs[0].tokenCaps, legacyTokenCaps);
});
test('migrateLegacyConfig: a def with its own config is left untouched even when legacy keys are present', () => {
  const ownWindow = { startHour: 7, endHour: 12, days: [6, 0] };
  const loaded = {
    window: { startHour: 8, endHour: 17, days: [1, 2, 3, 4, 5] },
    defs: [{ id: 'a', window: ownWindow }],
  };
  const { defs, migrated } = migrateLegacyConfig(loaded);
  assert.equal(migrated, true);
  assert.deepEqual(defs[0].window, ownWindow, 'own window not clobbered by legacy top-level window');
});
test('migrateLegacyConfig: already-migrated shape (no legacy keys) is a no-op', () => {
  const loaded = { defs: [{ id: 'a', window: { startHour: 9, endHour: 18, days: [1] } }] };
  const { defs, migrated } = migrateLegacyConfig(loaded);
  assert.equal(migrated, false);
  assert.deepEqual(defs, loaded.defs);
});

// ---- normalizeTags (createTask tag handling) -----------------------------------
test('normalizeTags: trims, lowercases, drops blanks, dedupes', () => {
  assert.deepEqual(normalizeTags(['  Background ', 'BACKGROUND', 'Wiki', '', '  ']), ['background', 'wiki']);
});
test('normalizeTags: undefined/empty → []', () => {
  assert.deepEqual(normalizeTags(undefined), []);
  assert.deepEqual(normalizeTags([]), []);
});

// ---- conclude field (createDef/updateDef) --------------------------------------
test('createDef: conclude defaults to "inreview"', () => {
  const d = createDef({ title: 'conclude-default', description: 'd', cwd: 'C:\\x' });
  assert.equal(d.conclude, 'inreview');
});
test('createDef: rejects an invalid conclude value', () => {
  assert.throws(() => createDef({ title: 'conclude-bad', description: 'd', cwd: 'C:\\x', conclude: 'garbage' }));
});
test('updateDef: accepts conclude "done"', () => {
  const d = createDef({ title: 'conclude-update', description: 'd', cwd: 'C:\\x' });
  assert.equal(updateDef(d.id, { conclude: 'done' }).conclude, 'done');
});
test('updateDef: rejects a garbage conclude value', () => {
  const d = createDef({ title: 'conclude-update-bad', description: 'd', cwd: 'C:\\x' });
  assert.throws(() => updateDef(d.id, { conclude: 'garbage' }));
});

// ---- reports (listReports / getReport) -----------------------------------------
test('listReports/getReport: background-tagged entries with correct hasReport, non-background excluded, content read/missing', () => {
  const ticketA = join(scratch, 'ticket-a'); // has a Report.md
  const ticketB = join(scratch, 'ticket-b'); // no Report.md
  mkdirSync(ticketA, { recursive: true });
  mkdirSync(ticketB, { recursive: true });
  writeFileSync(join(ticketA, 'Report.md'), '# report a\n');
  writeFileSync(join(STATE_DIR, 'tasks.json'), JSON.stringify({
    tasks: [
      { id: 'live1', title: 'Live BG', tags: ['background'], ticketDir: ticketA, column: 'inprogress', createdAt: 1000 },
      { id: 'live2', title: 'Not BG', tags: [], ticketDir: ticketB, column: 'todo', createdAt: 2000 },
    ],
    history: [
      { id: 'hist1', title: 'Hist BG', tags: ['background'], ticketDir: ticketB, outcome: 'completed', concludedAt: 3000, createdAt: 500 },
    ],
  }));
  initTasks();

  const reports = listReports();
  const ids = reports.map((r) => r.taskId);
  assert.ok(ids.includes('live1'));
  assert.ok(ids.includes('hist1'));
  assert.ok(!ids.includes('live2'), 'non-background task excluded');
  assert.equal(reports[0].taskId, 'hist1', 'newest first (concludedAt 3000 beats live1 createdAt 1000)');

  const live1 = reports.find((r) => r.taskId === 'live1');
  assert.equal(live1.hasReport, true);
  assert.equal(live1.status, 'inprogress');

  const hist1 = reports.find((r) => r.taskId === 'hist1');
  assert.equal(hist1.hasReport, false);
  assert.equal(hist1.status, 'completed');
  assert.equal(hist1.concludedAt, 3000);

  assert.equal(getReport('live1').content, '# report a\n');
  assert.equal(getReport('hist1'), null, 'no Report.md written for this one');
  assert.equal(getReport('live2'), null, 'not background-tagged');
  assert.equal(getReport('nope'), null, 'unknown id');
});
