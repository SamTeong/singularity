// Unit tests for usage normalization: the ollama HTML scraper parser and the
// claude OAuth-response mapper. No network — both operate on captured fixtures.
// usage.mjs pulls in app-dir.mjs (STATE_DIR/CACHE_DIR/USAGE_SKILL_STATE), which
// requires SINGULARITY_HOME and reads USAGE_REPORT_STATE — point both at a
// scratch temp dir before the dynamic import.
// Run: npm test  (node --test server/)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const scratch = mkdtempSync(join(tmpdir(), 'singularity-usage-test-'));
process.env.SINGULARITY_HOME = join(scratch, 'sing');
process.env.USAGE_REPORT_STATE = join(scratch, 'usage-report-state');

// Codex fixture: one rollout jsonl under the newest date dir, a couple of
// non-matching lines plus two token_count lines — the backwards scan must
// pick the LAST one (used_percent 87, not the earlier 40).
const codexDay = join(scratch, 'codex-home', 'sessions', '2026', '07', '20');
mkdirSync(codexDay, { recursive: true });
const rolloutLines = [
  '{"timestamp":"2026-07-20T00:00:00.000Z","type":"session_meta","payload":{}}',
  '{"timestamp":"2026-07-20T00:05:00.000Z","type":"event_msg","payload":{"type":"token_count","rate_limits":{"limit_id":"codex","primary":{"used_percent":40.0,"window_minutes":10080,"resets_at":1786000000},"secondary":null,"plan_type":"plus"}}}',
  '{"timestamp":"2026-07-20T00:10:00.000Z","type":"other","payload":{}}',
  '{"timestamp":"2026-07-20T00:15:00.000Z","type":"event_msg","payload":{"type":"token_count","rate_limits":{"limit_id":"codex","primary":{"used_percent":87.0,"window_minutes":10080,"resets_at":1786172475},"secondary":null,"plan_type":"plus"}}}',
];
writeFileSync(join(codexDay, 'rollout-2026-07-20T00-00-00-abc123.jsonl'), `${rolloutLines.join('\n')}\n`);
process.env.CODEX_HOME = join(scratch, 'codex-home');

// Point the OAuth refresh at scratch credentials, never the real ~/.claude — a
// live refresh_token grant here would rotate the developer's own token.
const claudeCfg = join(scratch, 'claude-home');
mkdirSync(claudeCfg, { recursive: true });
process.env.CLAUDE_CONFIG_DIR = claudeCfg;
const writeCreds = (oauth) => writeFileSync(join(claudeCfg, '.credentials.json'), JSON.stringify({ claudeAiOauth: oauth }));

after(() => { rmSync(scratch, { recursive: true, force: true }); });

const { parseOllamaHtml, normalizeClaude, appendOllamaHistory, appendClaudeSnapshot, fetchCodex, refreshClaudeAuth, refreshOauthGrant } = await import('./usage.mjs');

// Trimmed to the parser-relevant markup from a real logged-in ollama.com/settings
// response: plan badge, Session then Weekly meter (aria-label + segment buttons),
// each followed by its reset data-time.
const OLLAMA_HTML = `
  <h2><span>Cloud usage</span>
    <span class="text-xs font-normal px-2 py-0.5 rounded-full bg-neutral-100 text-neutral-600 capitalize"
      >pro</span></h2>
  <div>
    <div class="flex justify-between mb-2"><span>Session usage</span><span>27.4% used</span></div>
    <div class="relative group" data-usage-meter>
      <div class="relative h-3" data-usage-track aria-label="Session usage 27.4% used">
        <div style="width: 27.4%;">
          <button data-usage-segment data-model="glm-5.2" data-requests="218" aria-label="glm-5.2: 218 requests"></button>
          <button data-usage-segment data-model="web search" data-requests="8" aria-label="web search: 8 requests"></button>
        </div>
      </div>
    </div>
    <div class="text-xs local-time" data-time="2026-07-14T08:00:00Z">Resets in 2 hours.</div>
  </div>
  <div>
    <div class="flex justify-between mb-2"><span>Weekly usage</span><span>27.4% used</span></div>
    <div class="relative group" data-usage-meter>
      <div class="relative h-3" data-usage-track aria-label="Weekly usage 27.4% used">
        <div style="width: 27.4%">
          <button data-usage-segment data-model="glm-5.2" data-requests="1029" aria-label="glm-5.2: 1029 requests"></button>
          <button data-usage-segment data-model="web search" data-requests="96" aria-label="web search: 96 requests"></button>
        </div>
      </div>
    </div>
    <div class="text-xs local-time" data-time="2026-07-20T00:00:00Z">Resets in 5 days.</div>
  </div>`;

test('parseOllamaHtml: plan, both windows, resets, per-model breakdown', () => {
  const u = parseOllamaHtml(OLLAMA_HTML);
  assert.equal(u.ok, true);
  assert.equal(u.source, 'ollama');
  assert.equal(u.plan, 'pro');

  assert.equal(u.session.pctUsed, 27.4);
  assert.equal(u.session.resetsAt, '2026-07-14T08:00:00Z');
  assert.deepEqual(u.session.models, [
    { model: 'glm-5.2', requests: 218 },
    { model: 'web search', requests: 8 },
  ]);

  assert.equal(u.weekly.pctUsed, 27.4);
  assert.equal(u.weekly.resetsAt, '2026-07-20T00:00:00Z');
  assert.deepEqual(u.weekly.models, [
    { model: 'glm-5.2', requests: 1029 },
    { model: 'web search', requests: 96 },
  ]);
});

test('parseOllamaHtml: login page (no meters) → null', () => {
  assert.equal(parseOllamaHtml('<html><body>Sign in</body></html>'), null);
});

// Sample shaped after the OAuth usage API (stats.mjs normalizer L1795-1812).
const CLAUDE_RAW = {
  five_hour: { utilization: 42, resets_at: '2026-07-14T13:00:00Z' },
  seven_day: { utilization: 63.5, resets_at: '2026-07-19T00:00:00Z' },
  seven_day_sonnet: { utilization: 30, resets_at: '2026-07-19T00:00:00Z' },
  seven_day_opus: { utilization: 71, resets_at: '2026-07-19T00:00:00Z' },
  seven_day_omelette: { utilization: 5, resets_at: '2026-07-19T00:00:00Z' },
  extra_usage: { is_enabled: true, used_credits: 12, monthly_limit: 40, utilization: 30 },
};

test('normalizeClaude: five_hour→session, seven_day→weekly, per-model + extra', () => {
  const u = normalizeClaude(CLAUDE_RAW, 'max');
  assert.equal(u.ok, true);
  assert.equal(u.source, 'claude');
  assert.equal(u.plan, 'max');

  assert.deepEqual(u.session, { pctUsed: 42, resetsAt: '2026-07-14T13:00:00Z', models: [] });
  assert.equal(u.weekly.pctUsed, 63.5);
  assert.equal(u.weekly.resetsAt, '2026-07-19T00:00:00Z');
  assert.deepEqual(u.weekly.models, [
    { model: 'sonnet', pctUsed: 30 },
    { model: 'opus', pctUsed: 71 },
    { model: 'design', pctUsed: 5 },
  ]);
  assert.deepEqual(u.extra, {
    enabled: true, used: 12, monthlyLimit: 40, pctUsed: 30, resetsAt: null,
  });
});

test('normalizeClaude: missing windows/extra → nulls, no throw', () => {
  const u = normalizeClaude({ five_hour: null, seven_day: null }, undefined);
  assert.equal(u.session, null);
  assert.equal(u.weekly, null);
  assert.equal(u.extra, null);
  assert.equal(u.plan, null);
});

// appendOllamaHistory writes the report skill's snapshot shape and de-dupes an
// unchanged reading (idle-debounce refreshes call this often).
const HISTORY_FILE = join(process.env.USAGE_REPORT_STATE, 'ollama-usage.jsonl');
const READING = {
  plan: 'pro',
  session: { pctUsed: 27.4, resetsAt: '2026-07-14T08:00:00Z' },
  weekly: {
    pctUsed: 31.2, resetsAt: '2026-07-19T00:00:00Z',
    models: [{ model: 'glm-5.2', requests: 218 }],
  },
};

test('appendOllamaHistory: dedupes an unchanged reading, writes a changed one', () => {
  appendOllamaHistory(READING);
  appendOllamaHistory(READING); // identical → no second line
  const changed = { ...READING, session: { ...READING.session, pctUsed: 28.1 } };
  appendOllamaHistory(changed);

  const lines = readFileSync(HISTORY_FILE, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  for (const line of lines) {
    const row = JSON.parse(line);
    assert.match(row.fetched_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    assert.equal(typeof row.session.utilization, 'number');
    assert.ok('resets_at' in row.weekly);
  }
  assert.equal(JSON.parse(lines[0]).session.utilization, 27.4);
  assert.equal(JSON.parse(lines[1]).session.utilization, 28.1);
});

// appendClaudeSnapshot must reproduce the record the skill's own
// `fetch-usage --oauth --save` writes (stats.mjs _map_usage + fetched_at + raw),
// since the same _gauge_windows/_fit_gauge code reads both writers' rows.
test('appendClaudeSnapshot: skill snapshot shape, dedupes an unchanged reading', () => {
  appendClaudeSnapshot(CLAUDE_RAW);
  appendClaudeSnapshot(CLAUDE_RAW); // identical → no second line
  appendClaudeSnapshot({ ...CLAUDE_RAW, five_hour: { utilization: 55, resets_at: '2026-07-14T13:00:00Z' } });

  const lines = readFileSync(join(process.env.USAGE_REPORT_STATE, 'usage-snapshots.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  const row = JSON.parse(lines[0]);
  assert.match(row.fetched_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.deepEqual(row.five_hour, { utilization: 42, resets_at: '2026-07-14T13:00:00Z' });
  assert.deepEqual(row.seven_day, { utilization: 63.5, resets_at: '2026-07-19T00:00:00Z' });
  assert.equal(row.per_model.opus.utilization, 71);
  assert.equal(row.per_model.design.utilization, 5); // seven_day_omelette → design
  assert.equal(row.extra_usage.used_credits, 12);
  assert.equal(row.raw.five_hour.utilization, 42); // full body kept, like the skill's writer
  assert.equal(JSON.parse(lines[1]).five_hour.utilization, 55);
});

// fetchCodex scans a rollout jsonl backwards for the last token_count line's
// rate_limits, mapping the 10080-minute (7d) window to `weekly` only.
test('fetchCodex: backwards-scans to the last token_count line', async () => {
  const u = await fetchCodex();
  assert.equal(u.ok, true);
  assert.equal(u.source, 'codex');
  assert.equal(u.plan, 'plus');
  assert.equal(u.session, null);
  assert.equal(u.weekly.pctUsed, 87);
  assert.equal(u.weekly.resetsAt, new Date(1786172475 * 1000).toISOString());
});

// A freshly-started Codex session's rollout has session_meta but no
// token_count yet (no turn completed) — it's now the newest file, but
// fetchCodex must fall back to the older rollout's reading instead of
// reporting "no Codex sessions found".
test('fetchCodex: newest rollout has no rate_limits yet → falls back to older rollout', async () => {
  const freshDay = join(scratch, 'codex-home', 'sessions', '2026', '07', '21');
  mkdirSync(freshDay, { recursive: true });
  writeFileSync(
    join(freshDay, 'rollout-2026-07-21T00-00-00-fresh01.jsonl'),
    '{"timestamp":"2026-07-21T00:00:00.000Z","type":"session_meta","payload":{}}\n',
  );

  const u = await fetchCodex();
  assert.equal(u.ok, true);
  assert.equal(u.weekly.pctUsed, 87);
});

// The access token expires overnight, so the usage fetch renews it itself via
// the refresh_token grant. These cover the pre-network guards (no request is
// made — a real grant here would rotate the developer's own token) and the
// throttle that stops a signed-out user costing a request + spawn per pull.
test('refreshOauthGrant: no refresh token → no request', async () => {
  writeCreds({ accessToken: 'stale', expiresAt: Date.now() - 1000 });
  assert.equal(await refreshOauthGrant(), false);
});

test('refreshOauthGrant: dead refresh token → no request', async () => {
  writeCreds({ accessToken: 'stale', refreshToken: 'rt', refreshTokenExpiresAt: Date.now() - 1000 });
  assert.equal(await refreshOauthGrant(), false);
});

test('refreshClaudeAuth: falls back to the CLI once, then throttles', async () => {
  process.env.CLAUDE_BIN = process.execPath; // real exe; `auth status` args just make it exit
  assert.equal(await refreshClaudeAuth(), true);
  assert.equal(await refreshClaudeAuth(), false);
});
