import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// model-store.mjs imports app-dir.mjs (STATE_DIR), which throws without
// SINGULARITY_HOME. Point it at a scratch temp dir before a dynamic import.
process.env.SINGULARITY_HOME = mkdtempSync(join(tmpdir(), 'sing-modelstore-'));
const { getModels, setModels, restoreDefaults, groupFor, listEnabled, getSummariserModel, getSummariser, getDefaultModel } =
  await import('./model-store.mjs');
const { createRustBackend } = await import('./rust-backend.mjs');
const { setModelsBackend } = await import('./model-store.mjs');
const backend = createRustBackend();
before(async () => { await backend.start(); setModelsBackend(backend); });
after(async () => { await backend.stop(); rmSync(process.env.SINGULARITY_HOME, { recursive: true, force: true }); });

const FILE = join(process.env.SINGULARITY_HOME, 'state', 'models.json');

test('seeds the file on first read', async () => {
  assert.equal(existsSync(FILE), false);
  const doc = await getModels();
  assert.equal(existsSync(FILE), true);
  assert.deepEqual(JSON.parse(readFileSync(FILE, 'utf8')), doc);

  // Seed carries all three groups plus the friendly claude labels.
  assert.deepEqual(doc.models.find((m) => m.id === 'opus[1m]'), { id: 'opus[1m]', group: 'claude', label: 'Opus (1M context)', enabled: true });
  assert.equal(doc.models.filter((m) => m.group === 'claude').length, 9);
  assert.equal(doc.models.filter((m) => m.group === 'ollama').length, 6);
  assert.equal(doc.models.filter((m) => m.group === 'codex').length, 7); // VERIFY: wave8-catalogue-1 — main 6ad27f8 added gpt-6.1-terra
  assert.equal(doc.defaultModel, 'claude');
  assert.equal(doc.summariserModel, 'deepseek-v4-flash:cloud');

  // Every codex seed entry is a gpt-* id (web/src/lib/models.js mirrors that check).
  for (const m of doc.models) if (m.group === 'codex') assert.ok(m.id.startsWith('gpt-'), m.id);
});

test('corrupt catalogue falls back to the seed without clobbering the file', async () => {
  const corrupt = '{not-json';
  writeFileSync(FILE, corrupt);
  const doc = await getModels();
  assert.equal(doc.models.length, 22); // VERIFY: wave8-catalogue-2 — 9 claude + 6 ollama + 7 codex shipped ids
  assert.equal(readFileSync(FILE, 'utf8'), corrupt);
});

test('accessors read the store', async () => {
  assert.equal(await groupFor('sonnet'), 'claude');
  assert.equal(await groupFor('kimi-k3:cloud'), 'ollama');
  assert.equal(await groupFor('gpt-5.4-mini'), 'codex');
  assert.equal(await groupFor('made-up-model'), null);
  assert.equal((await listEnabled()).length, (await getModels()).models.length);
  assert.equal(await getSummariserModel(), 'deepseek-v4-flash:cloud');
  assert.equal(await getDefaultModel(), 'claude');
});

test('setModels round-trips, normalizes and persists', async () => {
  const r = await setModels({
    models: [
      { id: '  opus  ', group: 'claude', label: 'Big Model' },
      { id: 'glm-5.3:cloud', group: 'ollama', label: '', enabled: false },
      { id: 'gpt-5.4', group: 'codex' },
    ],
    defaultModel: 'opus',
    summariserModel: '',
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.state.models[0], { id: 'opus', group: 'claude', label: 'Big Model', enabled: true }); // trimmed, enabled defaults true
  assert.equal(r.state.models[1].enabled, false);
  assert.deepEqual(await getModels(), r.state);
  assert.deepEqual(JSON.parse(readFileSync(FILE, 'utf8')), r.state);
  assert.deepEqual((await listEnabled()).map((m) => m.id), ['opus', 'gpt-5.4']);
  assert.equal(await getSummariserModel(), '');
});

test('summariserModel accepts any enabled group', async () => {
  const claude = await setModels({ models: [{ id: 'opus', group: 'claude', label: '' }], defaultModel: '', summariserModel: 'opus' });
  assert.equal(claude.ok, true);
  assert.deepEqual(await getSummariser(), { id: 'opus', group: 'claude' });

  const codex = await setModels({ models: [{ id: 'gpt-5.4', group: 'codex', label: '' }], defaultModel: '', summariserModel: 'gpt-5.4' });
  assert.equal(codex.ok, true);
  assert.deepEqual(await getSummariser(), { id: 'gpt-5.4', group: 'codex' });

  await setModels({ models: [{ id: 'gpt-5.4', group: 'codex', label: '' }], defaultModel: '', summariserModel: '' });
  assert.equal(await getSummariser(), null);
});

test('validation rejects bad documents without touching the file', async () => {
  const before = readFileSync(FILE, 'utf8');
  const bad = async (doc) => {
    const r = await setModels(doc);
    assert.equal(r.ok, false);
    assert.equal(typeof r.error, 'string');
    return r.error;
  };
  const one = (over) => [{ id: 'opus', group: 'claude', label: '', enabled: true }, over];

  await bad({ models: 'nope' });
  await bad({ models: [{ id: 'opus', group: 'claude' }, { id: 'opus', group: 'claude' }] });     // duplicate
  await bad({ models: [{ id: '   ', group: 'claude' }] });                                        // empty id
  await bad({ models: [{ id: 'opus', group: 'anthropic' }] });                                    // unknown group
  await bad({ models: [{ id: 'luna', group: 'codex' }] });                                        // codex must be gpt-*
  await bad({ models: one({ id: 'x', group: 'claude', label: 'y'.repeat(81) }) });                // label cap
  await bad({ models: Array.from({ length: 201 }, (_, i) => ({ id: `m${i}`, group: 'claude' })) }); // 200 cap
  await bad({ models: one({ id: 'sonnet', group: 'claude' }), defaultModel: 'ghost' });            // default missing
  await bad({ models: one({ id: 'sonnet', group: 'claude', enabled: false }), defaultModel: 'sonnet' }); // default disabled
  await bad({ models: one({ id: 'gpt-5.4', group: 'codex', enabled: false }), summariserModel: 'gpt-5.4' }); // summariser disabled
  await bad({ models: one({ id: 'gpt-5.4', group: 'codex' }), summariserModel: 'ghost' });          // summariser unknown

  assert.equal(readFileSync(FILE, 'utf8'), before);
});

test('restoreDefaults re-adds deleted seed ids without duplicating or resetting survivors', async () => {
  await setModels({
    models: [
      { id: 'opus', group: 'claude', label: 'Renamed Opus', enabled: false },
      { id: 'my-own:cloud', group: 'ollama', label: 'Mine', enabled: true },
    ],
    defaultModel: '',
    summariserModel: 'my-own:cloud',
  });

  const doc = await restoreDefaults();
  const ids = doc.models.map((m) => m.id);
  assert.equal(new Set(ids).size, ids.length, 'no duplicates');
  assert.deepEqual(ids.slice(0, 2), ['opus', 'my-own:cloud'], 'survivors keep their order, seed entries append');
  assert.deepEqual(doc.models[0], { id: 'opus', group: 'claude', label: 'Renamed Opus', enabled: false }, 'renamed label and disabled flag preserved');
  assert.ok(ids.includes('haiku') && ids.includes('gpt-6-luna') && ids.includes('gpt-6-sol') && ids.includes('gpt-6.1-sol'), 'deleted built-ins are back');
  assert.equal(doc.models.filter((m) => m.id === 'opus').length, 1);
  assert.equal(doc.summariserModel, 'my-own:cloud', 'settings untouched');
  assert.deepEqual(await getModels(), doc, 'persisted');

  // Idempotent — a second restore changes nothing.
  assert.deepEqual(await restoreDefaults(), doc);
});
