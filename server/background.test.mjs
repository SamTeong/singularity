// Unit tests for the background-task pure functions (inWindow / evalGate /
// pickDef / watchdogDecision) + createTask tag normalization. background.mjs
// pulls in agents.mjs -> app-dir.mjs, which throws without SINGULARITY_HOME, so
// point it at a scratch temp dir *before* the dynamic import (same pattern as
// crons.test.mjs). No agent is ever spawned: the pure fns take a cfg argument,
// and the tags test exercises the exported normalizeTags helper directly rather
// than createTask (which would try to spawn a real claude). Run: npm test
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const scratch = mkdtempSync(join(tmpdir(), 'singularity-background-test-'));
process.env.SINGULARITY_HOME = join(scratch, 'singularity');
after(() => rmSync(scratch, { recursive: true, force: true }));

const { inWindow, evalGate, pickDef, watchdogDecision, updateBackgroundConfig } = await import('./background.mjs');
const { normalizeTags } = await import('./tasks.mjs');

const cfg = () => ({
  window: { startHour: 9, endHour: 18, days: [1, 2, 3, 4, 5] },
  thresholds: {
    claude: { start: 50, stop: 75, weeklyMax: 75 },
    ollama: { start: 50, stop: 75, weeklyMax: 75 },
  },
  tokenCaps: { claude: 15_000_000, ollama: 2_000_000 },
});
const src = (over = {}) => ({ ok: true, session: { pctUsed: 10 }, weekly: { pctUsed: 10 }, ...over });

// ---- inWindow ------------------------------------------------------------------
// 2026-07-15 = Wednesday (getDay 3), 2026-07-18 = Saturday (getDay 6).
test('inWindow: weekday inside hours is true', () => {
  assert.equal(inWindow(cfg(), new Date(2026, 6, 15, 10)), true);
});
test('inWindow: weekend is false', () => {
  assert.equal(inWindow(cfg(), new Date(2026, 6, 18, 10)), false);
});
test('inWindow: startHour inclusive, endHour exclusive', () => {
  assert.equal(inWindow(cfg(), new Date(2026, 6, 15, 9)), true);
  assert.equal(inWindow(cfg(), new Date(2026, 6, 15, 18)), false);
  assert.equal(inWindow(cfg(), new Date(2026, 6, 15, 8)), false);
});

// ---- evalGate ------------------------------------------------------------------
test('evalGate: claude within budget → claude', () => {
  const g = evalGate({ claude: src(), ollama: src() }, cfg());
  assert.equal(g.backend, 'claude');
});
test('evalGate: claude over start → ollama', () => {
  const g = evalGate({ claude: src({ session: { pctUsed: 60 } }), ollama: src() }, cfg());
  assert.equal(g.backend, 'ollama');
});
test('evalGate: both over → null with reason', () => {
  const g = evalGate({
    claude: src({ session: { pctUsed: 60 } }),
    ollama: src({ weekly: { pctUsed: 80 } }),
  }, cfg());
  assert.equal(g.backend, null);
  assert.equal(typeof g.reason, 'string');
  assert.ok(g.reason.length > 0);
});
test('evalGate: claude ok:false fails closed → ollama evaluated', () => {
  const g = evalGate({ claude: { ok: false, error: 'auth' }, ollama: src() }, cfg());
  assert.equal(g.backend, 'ollama');
});

// ---- pickDef -------------------------------------------------------------------
const now = 1_000_000_000_000;
const hr = 3_600_000;
test('pickDef: cooldown excludes a recently-run def', () => {
  const c = { defs: [{ id: 'a', enabled: true, cooldownHours: 24, lastRunAt: now - hr }] };
  assert.equal(pickDef(c, now), null);
});
test('pickDef: round-robin picks the oldest lastRunAt', () => {
  const c = { defs: [
    { id: 'new', enabled: true, cooldownHours: 1, lastRunAt: now - 2 * hr },
    { id: 'old', enabled: true, cooldownHours: 1, lastRunAt: now - 10 * hr },
  ] };
  assert.equal(pickDef(c, now).id, 'old');
});
test('pickDef: null lastRunAt wins (never run)', () => {
  const c = { defs: [
    { id: 'ran', enabled: true, cooldownHours: 1, lastRunAt: now - 10 * hr },
    { id: 'fresh', enabled: true, cooldownHours: 1, lastRunAt: null },
  ] };
  assert.equal(pickDef(c, now).id, 'fresh');
});
test('pickDef: disabled defs are skipped', () => {
  const c = { defs: [{ id: 'a', enabled: false, cooldownHours: 1, lastRunAt: null }] };
  assert.equal(pickDef(c, now), null);
});

// ---- watchdogDecision ----------------------------------------------------------
test('watchdogDecision: session pct at/over stop → stop', () => {
  assert.equal(watchdogDecision({ claude: src({ session: { pctUsed: 75 } }) }, 'claude', cfg(), 0), 'stop');
});
test('watchdogDecision: weekly at/over weeklyMax → stop', () => {
  assert.equal(watchdogDecision({ claude: src({ weekly: { pctUsed: 90 } }) }, 'claude', cfg(), 0), 'stop');
});
test('watchdogDecision: token cap reached → stop', () => {
  assert.equal(watchdogDecision({ claude: src() }, 'claude', cfg(), 15_000_000), 'stop');
});
test('watchdogDecision: ok:false fails closed → stop', () => {
  assert.equal(watchdogDecision({ claude: { ok: false } }, 'claude', cfg(), 0), 'stop');
});
test('watchdogDecision: within budget → continue', () => {
  assert.equal(watchdogDecision({ claude: src() }, 'claude', cfg(), 100), 'continue');
});

// ---- normalizeTags (createTask tag handling) -----------------------------------
test('normalizeTags: trims, lowercases, drops blanks, dedupes', () => {
  assert.deepEqual(normalizeTags(['  Background ', 'BACKGROUND', 'Wiki', '', '  ']), ['background', 'wiki']);
});
test('normalizeTags: undefined/empty → []', () => {
  assert.deepEqual(normalizeTags(undefined), []);
  assert.deepEqual(normalizeTags([]), []);
});

// ---- updateBackgroundConfig (nested-merge safety) ------------------------------
// Editing one threshold field via the UI must NOT wipe its siblings — else the
// gate/watchdog compare against undefined and silently stop firing.
test('updateBackgroundConfig: partial threshold edit preserves siblings', () => {
  const c = updateBackgroundConfig({ thresholds: { claude: { start: 55 } } });
  assert.equal(c.thresholds.claude.start, 55);
  assert.equal(c.thresholds.claude.stop, 75, 'stop preserved');
  assert.equal(c.thresholds.claude.weeklyMax, 75, 'weeklyMax preserved');
  assert.equal(c.thresholds.ollama.stop, 75, 'other backend untouched');
});
test('updateBackgroundConfig: ignores defs key (defs go through def routes)', () => {
  const c = updateBackgroundConfig({ defs: [{ id: 'x' }] });
  assert.deepEqual(c.defs, [], 'defs not overwritten via config route');
});
