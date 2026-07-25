import { test } from 'node:test';
import assert from 'node:assert';
import { normalizeStatus, STATUS_PROVIDERS } from './status.mjs';

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