import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// config-state.mjs imports app-dir.mjs (STATE_DIR), which throws without
// SINGULARITY_HOME. Point it at a scratch temp dir before a dynamic import.
process.env.SINGULARITY_HOME = mkdtempSync(join(tmpdir(), 'sing-cfgstate-'));
const { getConfigState, setConfigState } = await import('./config-state.mjs');

test('default state seeds when absent', () => {
  assert.deepEqual(getConfigState(), { tabs: [], active: null, autosave: false, expanded: [] });
});

test('setState partial-merges, validates tabs, persists to disk', () => {
  const r = setConfigState({
    tabs: [
      { cwd: '/a', tool: 'claude', scope: 'project', path: '/a/.claude/settings.json' },
      { cwd: '/a', tool: 'codex', scope: 'user', path: '/a/.codex/config.toml' },
      { bad: 'tab' }, // dropped — missing cwd/tool/scope
    ],
    active: '/a/.claude/settings.json',
    autosave: true,
    expanded: ['/a', '/b'],
  });
  assert.equal(r.ok, true);
  assert.equal(r.state.tabs.length, 2);
  assert.deepEqual(r.state.tabs[0], { cwd: '/a', tool: 'claude', scope: 'project', path: '/a/.claude/settings.json' });
  assert.equal(r.state.active, '/a/.claude/settings.json');
  assert.equal(r.state.autosave, true);
  assert.deepEqual(r.state.expanded, ['/a', '/b']);

  // Partial patch leaves the untouched keys alone.
  const r2 = setConfigState({ active: null });
  assert.equal(r2.state.active, null);
  assert.equal(r2.state.tabs.length, 2);
  assert.equal(r2.state.autosave, true);

  // Persisted to STATE_DIR/config-state.json (round-trip via getConfigState).
  assert.deepEqual(getConfigState(), r2.state);
  void readFileSync(join(process.env.SINGULARITY_HOME, 'state', 'config-state.json'), 'utf8');
});