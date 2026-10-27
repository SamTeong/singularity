import { test } from 'node:test';
import assert from 'node:assert';
import { createStatusService, normalizeStatus, STATUS_PROVIDERS } from './status.mjs';

const PROVIDER = STATUS_PROVIDERS[1]; // claude

test('normalizeStatus flattens summary.json to the view shape', () => {
  const raw = {
    page: { id: 'p', name: 'Claude', url: 'https://status.claude.com', updated_at: '2026-07-25T00:00:00Z' },
    status: { indicator: 'minor', description: 'Partial degradation' },
    components: [
      { name: 'Group', status: 'operational', group: true },
      { name: 'Claude API', status: 'partial_outage', group: false },
      { name: 'Claude Code', status: 'operational', group: false },
    ],
    incidents: [{ name: 'Inc', impact: 'minor', status: 'investigating', shortlink: 'https://x', created_at: '2026-07-25T01:00:00Z' }],
    scheduled_maintenances: [],
  };
  const n = normalizeStatus(raw, PROVIDER);
  assert.strictEqual(n.ok, true);
  assert.strictEqual(n.label, 'Claude');
  assert.strictEqual(n.indicator, 'minor');
  assert.strictEqual(n.description, 'Partial degradation');
  // group container dropped, two leaves kept
  assert.deepStrictEqual(n.components.map((c) => c.name), ['Claude API', 'Claude Code']);
  assert.deepStrictEqual(n.components[0].status, 'partial_outage');
  assert.strictEqual(n.incidents.length, 1);
  assert.strictEqual(n.incidents[0].shortlink, 'https://x');
  assert.strictEqual(n.maintenances.length, 0);
});

test('normalizeStatus tolerates missing optional fields', () => {
  const n = normalizeStatus({}, PROVIDER);
  assert.strictEqual(n.ok, true);
  assert.strictEqual(n.indicator, 'none');
  assert.strictEqual(n.description, '');
  assert.deepStrictEqual(n.components, []);
  assert.deepStrictEqual(n.incidents, []);
});

test('status freshness keeps last-good data and isolates provider attempts', async () => {
  let clock = Date.parse('2026-10-27T00:00:00Z');
  const outcomes = {
    openai: [
      { ok: true, key: 'openai', label: 'OpenAI', indicator: 'none', description: 'All good' },
      { ok: false, key: 'openai', label: 'OpenAI', error: 'offline' },
      { ok: false, key: 'openai', label: 'OpenAI', error: 'still offline' },
      { ok: true, key: 'openai', label: 'OpenAI', indicator: 'minor', description: 'Recovered' },
    ],
    claude: [
      { ok: true, key: 'claude', label: 'Claude', indicator: 'none', description: 'All good' },
      { ok: false, key: 'claude', label: 'Claude', error: 'offline' },
      { ok: false, key: 'claude', label: 'Claude', error: 'offline' },
      { ok: false, key: 'claude', label: 'Claude', error: 'offline' },
    ],
  };
  const service = createStatusService({
    providers: STATUS_PROVIDERS,
    now: () => clock,
    fetch: async (provider) => outcomes[provider.key].shift(),
  });
  const initial = await service.getStatus({ force: true });
  assert.equal(initial.openai.lastSuccessAt, '2026-10-27T00:00:00.000Z');
  clock += 60_000;
  const firstFailure = await service.getStatus({ force: true });
  assert.equal(firstFailure.openai.ok, true);
  assert.equal(firstFailure.openai.indicator, 'none');
  assert.equal(firstFailure.openai.stale, true);
  assert.equal(firstFailure.openai.refreshError, 'offline');
  assert.equal(firstFailure.openai.lastSuccessAt, initial.openai.lastSuccessAt);
  assert.equal(firstFailure.openai.lastAttemptAt, '2026-10-27T00:01:00.000Z');
  assert.equal(firstFailure.claude.lastSuccessAt, initial.claude.lastSuccessAt);
  clock += 60_000;
  const repeatedFailure = await service.getStatus({ force: true });
  assert.equal(repeatedFailure.openai.refreshError, 'still offline');
  assert.equal(repeatedFailure.openai.lastSuccessAt, initial.openai.lastSuccessAt);
  assert.equal(repeatedFailure.openai.lastAttemptAt, '2026-10-27T00:02:00.000Z');
  clock += 60_000;
  const recovered = await service.getStatus({ force: true });
  assert.equal(recovered.openai.indicator, 'minor');
  assert.equal(recovered.openai.stale, false);
  assert.equal(recovered.openai.refreshError, null);
  assert.equal(recovered.openai.lastSuccessAt, '2026-10-27T00:03:00.000Z');
  assert.equal(recovered.claude.lastSuccessAt, initial.claude.lastSuccessAt);
});
