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
const codexAuth = join(process.env.CODEX_HOME, 'auth.json');
const writeCodexAuth = (tokens) => writeFileSync(codexAuth, JSON.stringify({ tokens }));

// Point the OAuth refresh at scratch credentials, never the real ~/.claude — a
// live refresh_token grant here would rotate the developer's own token.
const claudeCfg = join(scratch, 'claude-home');
mkdirSync(claudeCfg, { recursive: true });
process.env.CLAUDE_CONFIG_DIR = claudeCfg;
const writeCreds = (oauth) => writeFileSync(join(claudeCfg, '.credentials.json'), JSON.stringify({ claudeAiOauth: oauth }));

after(() => { rmSync(scratch, { recursive: true, force: true }); });

const { parseOllamaHtml, classifyOllamaPage, connectOllamaUsage, preserveOllamaStale, preserveClaudeStale, scrapeOllamaOnce, normalizeClaude, appendOllamaHistory, appendClaudeSnapshot, appendCodexHistory, fetchCodex, refreshClaudeAuth, refreshOauthGrant, getUsage } = await import('./usage.mjs');

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

test('Ollama failure classification is actionable and deterministic', () => {
  assert.equal(classifyOllamaPage({ url: 'https://ollama.com/signin' }), 'auth-expired');
  assert.equal(classifyOllamaPage({ html: 'Checking your browser before accessing' }), 'challenge-required');
  assert.equal(classifyOllamaPage({ html: '<main>Settings</main>' }), 'scrape-incompatible');
});

test('Ollama refresh failure retains the timestamped last-good reading as stale', () => {
  const previous = { ...parseOllamaHtml(OLLAMA_HTML), fetchedAt: '2026-01-01T00:00:00.000Z' };
  const result = preserveOllamaStale(previous, { ok: false, source: 'ollama', needsAuth: true, error: 'auth-expired' });
  assert.equal(result.ok, true);
  assert.equal(result.stale, true);
  assert.equal(result.fetchedAt, '2026-01-01T00:00:00.000Z');
  assert.equal(result.error, 'auth-expired');
});

test('connectOllamaUsage: headful connector verifies meter and atomically selects browser mode', async () => {
  let launched = null;
  const page = {
    goto: async () => {}, url: () => 'https://ollama.com/settings',
    waitForSelector: async () => {}, content: async () => OLLAMA_HTML,
  };
  const playwright = { chromium: { launchPersistentContext: async (_dir, opts) => {
    launched = opts;
    return { addInitScript: async () => {}, pages: () => [page], close: async () => {} };
  } } };
  const result = await connectOllamaUsage({ playwright, headlessVerifier: async () => ({ ...parseOllamaHtml(OLLAMA_HTML), fetchedAt: '2026-01-01T00:00:00.000Z' }) });
  assert.equal(launched.headless, false);
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(readFileSync(join(process.env.SINGULARITY_HOME, 'state', 'ollama.json'), 'utf8')), { mode: 'browser' });
});

test('connectOllamaUsage: deadline closes Edge when the optional CLI acknowledgement never resolves', async () => {
  let closed = false;
  const page = { goto: async () => {}, url: () => 'https://ollama.com/settings', waitForSelector: () => new Promise(() => {}), content: async () => '' };
  const playwright = { chromium: { launchPersistentContext: async () => ({ addInitScript: async () => {}, pages: () => [page], close: async () => { closed = true; } }) } };
  const result = await connectOllamaUsage({ playwright, waitForUser: () => new Promise(() => {}), timeoutMs: 5 });
  assert.equal(closed, true);
  assert.equal(result.ok, false);
});

test('connectOllamaUsage: failed headless verification leaves existing config byte-for-byte intact', async () => {
  const configPath = join(process.env.SINGULARITY_HOME, 'state', 'ollama.json');
  const prior = '{"cookie":"still-valid","userAgent":"test-agent"}';
  mkdirSync(join(process.env.SINGULARITY_HOME, 'state'), { recursive: true });
  writeFileSync(configPath, prior);
  const page = { goto: async () => {}, url: () => 'https://ollama.com/settings', waitForSelector: async () => {}, content: async () => OLLAMA_HTML };
  const playwright = { chromium: { launchPersistentContext: async () => ({ addInitScript: async () => {}, pages: () => [page], close: async () => {} }) } };
  const result = await connectOllamaUsage({ playwright, headlessVerifier: async () => ({ ok: false, source: 'ollama', error: 'unavailable' }) });
  assert.equal(result.ok, false);
  assert.equal(readFileSync(configPath, 'utf8'), prior);
});

test('scrapeOllamaOnce: browser launch failures are unavailable without diagnostic leakage', async () => {
  const result = await scrapeOllamaOnce({ chromium: { launchPersistentContext: async () => { throw new Error('secret profile path'); } } }, true);
  assert.deepEqual(result, { ok: false, source: 'ollama', error: 'unavailable' });
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

// appendCodexHistory writes the report skill's codex-usage.jsonl shape
// ({fetched_at, session, weekly, plan}) and de-dupes an unchanged reading —
// same contract as appendOllamaHistory above, feeding the skill's Codex
// 5h/7d forecast + window-balance cards.
const CODEX_HISTORY_FILE = join(process.env.USAGE_REPORT_STATE, 'codex-usage.jsonl');
const CODEX_READING = {
  ok: true, source: 'codex', plan: 'plus',
  session: { pctUsed: 40, resetsAt: '2026-09-09T18:00:00Z', models: [] },
  weekly: { pctUsed: 12.5, resetsAt: '2026-09-12T00:00:00Z', models: [] },
};

test('appendCodexHistory: skill snapshot shape, dedupes an unchanged reading', () => {
  appendCodexHistory(CODEX_READING);
  appendCodexHistory(CODEX_READING); // identical → no second line
  appendCodexHistory({ ...CODEX_READING, session: { ...CODEX_READING.session, pctUsed: 44 } });

  const lines = readFileSync(CODEX_HISTORY_FILE, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  const row = JSON.parse(lines[0]);
  assert.match(row.fetched_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.deepEqual(row.session, { utilization: 40, resets_at: '2026-09-09T18:00:00Z' });
  assert.deepEqual(row.weekly, { utilization: 12.5, resets_at: '2026-09-12T00:00:00Z' });
  assert.equal(row.plan, 'plus');
  assert.equal(JSON.parse(lines[1]).session.utilization, 44);
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

// Two parallel sessions: the newest-mtime rollout's last rate_limits record is
// OLDER (its later appends were other events) than a quieter session's record.
// Selection must go by the record's own timestamp, not file mtime — mtime-first
// picking served a stale 87% while a 99% reading sat in another file.
test('fetchCodex: freshest rate_limits record wins over newest-mtime file', async () => {
  const raceDay = join(scratch, 'codex-home', 'sessions', '2026', '07', '22');
  mkdirSync(raceDay, { recursive: true });
  const mk = (ts, pct) => JSON.stringify({ timestamp: ts, type: 'event_msg', payload: { type: 'token_count', rate_limits: { limit_id: 'codex', primary: { used_percent: pct, window_minutes: 10080, resets_at: 1786172475 }, secondary: null, plan_type: 'plus' } } });
  // Quiet file first, busy file last — write order guarantees busy01 has the
  // newest mtime while carrying the older rate_limits record.
  writeFileSync(join(raceDay, 'rollout-2026-07-22T00-00-00-quiet2.jsonl'), `${[
    '{"timestamp":"2026-07-22T00:00:00.000Z","type":"session_meta","payload":{}}',
    mk('2026-07-22T12:04:00.000Z', 99),
  ].join('\n')}\n`);
  writeFileSync(join(raceDay, 'rollout-2026-07-22T00-00-00-busy01.jsonl'), `${[
    '{"timestamp":"2026-07-22T00:00:00.000Z","type":"session_meta","payload":{}}',
    mk('2026-07-22T12:00:00.000Z', 87),
    '{"timestamp":"2026-07-22T12:05:00.000Z","type":"other","payload":{}}',
  ].join('\n')}\n`);

  const u = await fetchCodex();
  assert.equal(u.ok, true);
  assert.equal(u.weekly.pctUsed, 99);
});

test('fetchCodex: uses live API headers and normalizes 5h + 7d windows', async () => {
  const token = 'test-access-token';
  const accountId = 'test-account-id';
  writeCodexAuth({ access_token: token, account_id: accountId });
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, opts) => {
    request = { url, opts };
    return { status: 200, json: async () => ({
      plan_type: 'plus',
      rate_limit: {
        primary_window: { used_percent: 42, limit_window_seconds: 18_000, reset_at: 1786000000 },
        secondary_window: { used_percent: 63, limit_window_seconds: 604_800, reset_at: 1786172475 },
      },
    }) };
  };
  try {
    const u = await fetchCodex();
    assert.equal(request.url, 'https://chatgpt.com/backend-api/wham/usage');
    assert.equal(request.opts.method, 'GET');
    assert.deepEqual(request.opts.headers, { Authorization: `Bearer ${token}`, 'ChatGPT-Account-Id': accountId });
    assert.equal(u.plan, 'plus');
    assert.equal(u.session.pctUsed, 42);
    assert.equal(u.session.resetsAt, new Date(1786000000 * 1000).toISOString());
    assert.equal(u.weekly.pctUsed, 63);
    assert.equal(u.weekly.resetsAt, new Date(1786172475 * 1000).toISOString());
    assert.equal(JSON.stringify(u).includes(token), false);
    assert.equal(JSON.stringify(u).includes(accountId), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchCodex: retries a transient live API response', async () => {
  writeCodexAuth({ access_token: 'test-access-token', account_id: 'test-account-id' });
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) return { status: 503 };
    return {
      status: 200,
      json: async () => ({
        plan_type: 'plus',
        rate_limit: { primary_window: { used_percent: 42, limit_window_seconds: 18_000, reset_at: 1786000000 } },
      }),
    };
  };
  try {
    const u = await fetchCodex();
    assert.equal(u.plan, 'plus');
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(calls, 2);
});

test('fetchCodex: classifies a weekly-only primary live window', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ status: 200, json: async () => ({
    plan_type: 'pro',
    rate_limit: { primary_window: { used_percent: 17, limit_window_seconds: 604_800, reset_at: 1786172475 } },
  }) });
  try {
    const u = await fetchCodex();
    assert.equal(u.session, null);
    assert.equal(u.weekly.pctUsed, 17);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchCodex: failed live request falls back to rollout data', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('offline'); };
  try {
    const u = await fetchCodex();
    assert.equal(u.ok, true);
    assert.equal(u.weekly.pctUsed, 99);
  } finally {
    globalThis.fetch = originalFetch;
  }
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

// ---- getUsage({ sources }) — the per-card refresh allowlist ----------------------
// `sources` is a FETCH allowlist, not a projection: only the listed sources may hit
// the network, the rest are served from their cache slot, and the returned document
// still carries all three keys (the client merges wholesale). Order matters here —
// the cold-cache case must run before any other getUsage call in this file, while the
// module's cache is still empty. The refresh-token tests above leave a credentials
// file whose token has no `expiresAt`, which claudeOauthToken() still hands back —
// a permitted claude pull would then reach the real usage endpoint. Remove it, and
// every pull below stops at the pre-network auth guard.
let warm; // the fully-warmed document the filtered pulls below compare against

test('getUsage: filtered pull on a cold cache fetches only the listed source', async () => {
  // Must run here, not at module scope: the refresh-token tests above write this
  // file only once the tests actually run (see the note block above).
  rmSync(join(claudeCfg, '.credentials.json'), { force: true });
  const doc = await getUsage({ sources: ['claude'], force: true });
  assert.deepEqual(Object.keys(doc).sort(), ['claude', 'codex', 'ollama']);
  // null, not an error object: an excluded source reads its cache slot, which is
  // empty until a first successful fetch. A fetcher that ran would have populated
  // it — fetchOllama always returns an object and fetchCodex reads the rollout
  // fixture — so a null can only mean "never called".
  assert.equal(doc.ollama, null);
  assert.equal(doc.codex, null);
  // The listed source did run. This scratch home holds expired credentials, so it
  // stops at the pre-network auth guard rather than the real endpoint.
  assert.equal(doc.claude.source, 'claude');
  assert.equal(doc.claude.error, 'no-credentials');
});

test('getUsage: the allowlist outranks force, and an excluded source is served by reference', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('offline'); };
  try {
    // Warm every slot without touching the network: codex falls back to the
    // rollout fixture, ollama's cookie scrape fails fast.
    warm = await getUsage({ force: true });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(warm.codex.ok, true); // the fixture rollout, not a blank

  const urls = [];
  globalThis.fetch = async (url) => { urls.push(String(url)); throw new Error('offline'); };
  let second;
  try {
    second = await getUsage({ sources: ['claude'], force: true });
  } finally {
    globalThis.fetch = originalFetch;
  }
  // Zero requests: an excluded source never reaches the network even under
  // force=1, and the listed one has no usable credentials to spend.
  assert.deepEqual(urls, []);
  // Identity, not a deep-equal: an excluded source returns its slot by reference,
  // so the same object proves the fetcher never ran (a live fetch would have
  // replaced it with a fresh rollout read).
  assert.strictEqual(second.codex, warm.codex);
});

test('getUsage: an excluded source past its TTL is still not refetched', async () => {
  // pull() refetches on staleness by itself — force only adds reasons. Excluding a
  // source therefore has to mean never calling pull for it, which is what this
  // catches: advance the clock past TTL so the codex slot is stale, and a
  // claude-only pull must still leave it alone.
  const realNow = Date.now;
  const originalFetch = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => { urls.push(String(url)); throw new Error('offline'); };
  Date.now = () => realNow() + 10 * 60_000;
  let third;
  try {
    third = await getUsage({ sources: ['claude'] });
  } finally {
    Date.now = realNow;
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(urls, []);
  assert.strictEqual(third.codex, warm.codex);
});

test('getUsage: a filtered pull still assembles a full document', async () => {
  const doc = await getUsage({ sources: ['claude'] });
  // scheduleResetRefreshes() rebuilds every source's reset timer from what it is
  // handed, so a partial document would clear the timers it omits and never
  // recreate them — the excluded sources must arrive intact.
  assert.equal(doc.codex.weekly.pctUsed, warm.codex.weekly.pctUsed);
  assert.equal(doc.codex.weekly.resetsAt, warm.codex.weekly.resetsAt);
  // historyPaused rides the ollama slot, so it survives a pull that never read
  // ollama. 'in', not truthiness: null is the armed state.
  assert.ok('historyPaused' in doc.ollama);
  assert.equal(doc.ollama.historyPaused, null);
});

test('getUsage: Claude 429 preserves the last good reading and backs off', async () => {
  writeCreds({ accessToken: 'live-token', expiresAt: Date.now() + 60_000 });
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return calls === 1
      ? { status: 200, json: async () => CLAUDE_RAW }
      : { status: 429 };
  };
  try {
    const fresh = await getUsage({ sources: ['claude'], force: true });
    assert.equal(fresh.claude.ok, true);

    const limited = await getUsage({ sources: ['claude'], force: true });
    assert.equal(limited.claude.ok, true);
    assert.equal(limited.claude.stale, true);
    assert.equal(limited.claude.error, 'rate-limited');
    assert.equal(limited.claude.fetchedAt, fresh.claude.fetchedAt);

    const backedOff = await getUsage({ sources: ['claude'], force: true });
    assert.equal(backedOff.claude, limited.claude);
    assert.equal(calls, 4); // one success, then the shared helper's three 429 attempts
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('preserveClaudeStale keeps a failed pull separate from its last good reading', () => {
  const previous = { ok: true, source: 'claude', fetchedAt: '2026-01-01T00:00:00.000Z', session: { pctUsed: 20 } };
  const result = preserveClaudeStale(previous, { ok: false, source: 'claude', error: 'rate-limited' });
  assert.equal(result.ok, true);
  assert.equal(result.stale, true);
  assert.equal(result.error, 'rate-limited');
  assert.equal(result.fetchedAt, previous.fetchedAt);
});
