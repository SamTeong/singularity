import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// app-dir.mjs captures SINGULARITY_HOME at import, so set it before loading the adapter.
const home = mkdtempSync(join(tmpdir(), 'sing-config-state-'));
process.env.SINGULARITY_HOME = home;
const [{ getConfigState, setConfigState, setConfigStateBackend }, { createRustBackend }] = await Promise.all([
  import('./config-state.mjs'), import('./rust-backend.mjs'),
]);
const backend = createRustBackend();
await backend.start();
setConfigStateBackend(backend);
const stateFile = join(home, 'state', 'config-state.json');

after(async () => { await backend.stop(); rmSync(home, { recursive: true, force: true }); });

async function clearState() {
  await setConfigState({ tabs: [], expanded: [], active: null, autosave: false });
}

test('missing and malformed files return defaults without requiring Node persistence', async () => {
  assert.deepEqual(await getConfigState(), { tabs: [], active: null, autosave: false, expanded: [] });
  mkdirSync(join(home, 'state'), { recursive: true });
  writeFileSync(stateFile, '{malformed');
  assert.deepEqual(await getConfigState(), { tabs: [], active: null, autosave: false, expanded: [] });
  assert.equal(readFileSync(stateFile, 'utf8'), '{malformed');
});

test('stored objects preserve unknown and wrong-typed known fields', async () => {
  writeFileSync(stateFile, JSON.stringify({ tabs: 'old', active: 42, autosave: 'yes', expanded: null, extra: { keep: true } }));
  assert.deepEqual(await getConfigState(), {
    tabs: 'old', active: 42, autosave: 'yes', expanded: null, extra: { keep: true },
  });
});

test('arrays and non-object JSON values reset to defaults', async () => {
  for (const invalid of [['first', null, 3], 'text', '😀', 'café', 42, true, null]) {
    writeFileSync(stateFile, JSON.stringify(invalid));
    assert.deepEqual(await getConfigState(), { tabs: [], active: null, autosave: false, expanded: [] });
  }
});

test('set filters and caps values, accepts empty strings, and partially merges', async () => {
  const tabs = Array.from({ length: 60 }, (_, index) => ({
    cwd: index === 0 ? '' : `/${index}`,
    tool: '', scope: 'project', path: index === 1 ? 1 : '',
  }));
  tabs.splice(1, 0, { cwd: '/invalid' }, null);
  const expanded = Array.from({ length: 510 }, (_, index) => (index === 0 ? '' : `/${index}`));
  expanded.splice(1, 0, 5, null);
  const result = await setConfigState({
    tabs, expanded, active: '', autosave: true,
  });
  assert.equal(result.ok, true);
  assert.equal(result.state.tabs.length, 50);
  assert.deepEqual(result.state.tabs[0], { cwd: '', tool: '', scope: 'project', path: '' });
  assert.equal(result.state.expanded.length, 500);
  assert.equal(result.state.expanded[0], '');
  assert.equal(result.state.active, '');
  assert.equal(result.state.autosave, true);

  const partial = await setConfigState({ active: null, autosave: 'invalid', tabs: null });
  assert.equal(partial.state.active, null);
  assert.equal(partial.state.autosave, true);
  assert.equal(partial.state.tabs.length, 50);
  assert.deepEqual(await getConfigState(), partial.state);
});

test('concurrent partial updates are serialized by the shared bridge queue', async () => {
  await clearState();
  const results = await Promise.all([
    setConfigState({ active: '/a' }),
    setConfigState({ autosave: true }),
    setConfigState({ expanded: ['/a'] }),
  ]);
  assert.ok(results.every((result) => result.ok));
  assert.deepEqual(await getConfigState(), {
    tabs: [], active: '/a', autosave: true, expanded: ['/a'],
  });
});

test('write failures keep the {ok:false,error} result shape', async () => {
  await clearState();
  rmSync(stateFile, { force: true, recursive: true });
  mkdirSync(stateFile, { recursive: true });
  const result = await setConfigState({ autosave: true });
  assert.equal(result.ok, false);
  assert.equal(typeof result.error, 'string');
});
