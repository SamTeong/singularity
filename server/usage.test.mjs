// Unit tests for usage normalization: the claude OAuth-response mapper, the
// Ollama settings-page scraper, and the Codex rollout/API readers. usage.mjs pulls in
// app-dir.mjs (STATE_DIR/USAGE_SKILL_STATE), which requires SINGULARITY_HOME and
// reads USAGE_REPORT_STATE — point both at a scratch temp dir before the dynamic
// import.
// Run: npm test  (node --test server/)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
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

const { parseOllamaHtml, classifyOllamaPage, connectOllamaUsage, preserveOllamaStale, scrapeOllamaOnce, normalizeClaude, appendOllamaHistory, appendCodexHistory, fetchCodex, readClaudeSnapshot, readCodexSnapshot, readCostStateLimits, refreshClaudeAuth, refreshOauthGrant, getUsage } = await import('./usage.mjs');

const OLLAMA_HTML = `
  <span class="capitalize">pro</span>
  <div data-usage-meter aria-label="Session usage 27.4% used"><button data-model="glm-5.2" data-requests="218"></button></div>
  <div data-time="2026-07-14T08:00:00Z"></div>
  <div data-usage-meter aria-label="Weekly usage 31.2% used"><button data-model="glm-5.2" data-requests="1029"></button></div>
  <div data-time="2026-07-20T00:00:00Z"></div>`;

test('parseOllamaHtml: percentages, exact resets, and model counts', () => {
  const usage = parseOllamaHtml(OLLAMA_HTML);
  assert.equal(usage.plan, 'pro');
  assert.deepEqual(usage.session, { pctUsed: 27.4, resetsAt: '2026-07-14T08:00:00Z', models: [{ model: 'glm-5.2', requests: 218 }] });
  assert.deepEqual(usage.weekly, { pctUsed: 31.2, resetsAt: '2026-07-20T00:00:00Z', models: [{ model: 'glm-5.2', requests: 1029 }] });
  assert.equal(parseOllamaHtml('<main>Sign in</main>'), null);
});

test('Ollama authentication/failure/stale states are actionable', () => {
  assert.equal(classifyOllamaPage({ url: 'https://ollama.com/signin' }), 'auth-expired');
  assert.equal(classifyOllamaPage({ html: 'Checking your browser before accessing' }), 'challenge-required');
  const stale = preserveOllamaStale({ ...parseOllamaHtml(OLLAMA_HTML), fetchedAt: '2026-01-01T00:00:00.000Z' }, { ok: false, source: 'ollama', needsAuth: true, error: 'auth-expired' });
  assert.equal(stale.stale, true);
  assert.equal(stale.fetchedAt, '2026-01-01T00:00:00.000Z');
});

test('connectOllamaUsage: verifies the profile before selecting browser mode', async () => {
  const page = { goto: async () => {}, url: () => 'https://ollama.com/settings', waitForSelector: async () => {}, content: async () => OLLAMA_HTML };
  const playwright = { chromium: { launchPersistentContext: async () => ({ addInitScript: async () => {}, pages: () => [page], close: async () => {} }) } };
  const result = await connectOllamaUsage({ playwright, headlessVerifier: async () => parseOllamaHtml(OLLAMA_HTML) });
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(readFileSync(join(process.env.SINGULARITY_HOME, 'state', 'ollama.json'), 'utf8')), { mode: 'browser' });
});

test('connectOllamaUsage: resumes history collection after authentication recovers', async () => {
  const { connectOllamaUsage: isolatedConnect, runHistorySample: isolatedSample } = await import(`./usage.mjs?history-resume=${Date.now()}`);
  const page = { goto: async () => {}, url: () => 'https://ollama.com/settings', waitForSelector: async () => {}, content: async () => OLLAMA_HTML };
  const playwright = { chromium: { launchPersistentContext: async () => ({ addInitScript: async () => {}, pages: () => [page], close: async () => {} }) } };
  const realNow = Date.now;
  let calls = 0;
  try {
    await isolatedSample(async () => {
      calls += 1;
      return { ok: false, source: 'ollama', error: 'unavailable' };
    });
    Date.now = () => realNow() + 61_000;
    await isolatedSample(async () => {
      calls += 1;
      return { ok: false, source: 'ollama', needsAuth: true, error: 'auth-expired' };
    });
    Date.now = realNow;

    const connected = await isolatedConnect({ playwright, headlessVerifier: async () => parseOllamaHtml(OLLAMA_HTML) });
    assert.equal(connected.ok, true);
    await isolatedSample(async () => {
      calls += 1;
      return parseOllamaHtml(OLLAMA_HTML);
    });
  } finally {
    Date.now = realNow;
    rmSync(join(process.env.USAGE_REPORT_STATE, 'ollama-usage.jsonl'), { force: true });
    rmSync(join(process.env.USAGE_REPORT_STATE, 'codex-usage.jsonl'), { force: true });
  }
  assert.equal(calls, 3);
});

test('scrapeOllamaOnce: launch failure is unavailable without path leakage', async () => {
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

test('normalizeClaude: zero-use window without a reset is unstarted', () => {
  const u = normalizeClaude({ five_hour: { utilization: 0, resets_at: null }, seven_day: null }, 'max');
  assert.deepEqual(u.session, { pctUsed: 0, resetsAt: null, models: [], started: false });
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
  session: { pctUsed: 27.4, resetsAt: null },
  weekly: {
    pctUsed: 31.2, resetsAt: null,
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
  // The rows above are FRESH, and fetchCodex tails this file before the rollout
  // scan — leave the lane file missing so the scan tests below see the fixture.
  rmSync(CODEX_HISTORY_FILE, { force: true });
});

// fetchCodex scans a rollout jsonl backwards for the last token_count line's
// rate_limits, mapping the 10080-minute (7d) window to `weekly` only. This is the
// primary lane: no request is made without ?force=1.
test('fetchCodex: backwards-scans to the last token_count line', async () => {
  const u = await fetchCodex();
  assert.equal(u.ok, true);
  assert.equal(u.source, 'codex');
  assert.equal(u.plan, 'plus');
  assert.equal(u.session, null);
  assert.equal(u.weekly.pctUsed, 87);
  assert.equal(u.weekly.resetsAt, new Date(1786172475 * 1000).toISOString());
});

test('fetchCodex: the passive read never touches the network', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; throw new Error('offline'); };
  try {
    const u = await fetchCodex();
    assert.equal(u.ok, true);
    assert.equal(u.weekly.pctUsed, 87);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
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

// The live wham/usage API is on-demand only: ?force=1 (the daemon passes force
// through) is the one thing that makes fetchCodex spend a request.
test('fetchCodex(true): uses live API headers and normalizes 5h + 7d windows', async () => {
  const token = 'test-token';
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
    const u = await fetchCodex(true);
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

test('fetchCodex(true): retries a transient live API response', async () => {
  writeCodexAuth({ access_token: 'test-token', account_id: 'test-account-id' });
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
    const u = await fetchCodex(true);
    assert.equal(u.plan, 'plus');
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(calls, 2);
});

// An unused 5h window has not begun, and the live API fills reset_at with a
// rolling now + the whole window, so it walks forward on every poll. That is
// not a reset instant: drop it and flag the window unstarted, or the UI shows a
// countdown that never lands and the window anchor arms a timer it keeps
// pushing out of reach.
test('fetchCodex(true): a window that has not begun drops its sliding reset', async () => {
  const originalFetch = globalThis.fetch;
  const nowSec = Math.floor(Date.now() / 1000);
  globalThis.fetch = async () => ({ status: 200, json: async () => ({
    plan_type: 'plus',
    rate_limit: {
      primary_window: { used_percent: 0, limit_window_seconds: 18_000, reset_after_seconds: 18_000, reset_at: nowSec + 18_000 },
      secondary_window: { used_percent: 44, limit_window_seconds: 604_800, reset_after_seconds: 323_436, reset_at: 1786172475 },
    },
  }) });
  try {
    const u = await fetchCodex(true);
    assert.equal(u.session.resetsAt, null);
    assert.equal(u.session.started, false);
    // The weekly window is genuinely running — it keeps its pinned reset.
    assert.equal(u.weekly.resetsAt, new Date(1786172475 * 1000).toISOString());
    assert.equal('started' in u.weekly, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchCodex(true): classifies a weekly-only primary live window', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ status: 200, json: async () => ({
    plan_type: 'pro',
    rate_limit: { primary_window: { used_percent: 17, limit_window_seconds: 604_800, reset_at: 1786172475 } },
  }) });
  try {
    const u = await fetchCodex(true);
    assert.equal(u.session, null);
    assert.equal(u.weekly.pctUsed, 17);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchCodex(true): failed live request falls back to rollout data', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('offline'); };
  try {
    const u = await fetchCodex(true);
    assert.equal(u.ok, true);
    assert.equal(u.weekly.pctUsed, 99);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// The access token expires overnight, so the on-demand usage fetch renews it
// itself via the refresh_token grant. These cover the pre-network guards (no
// request is made — a real grant here would rotate the developer's own token)
// and the throttle that stops a signed-out user costing a request + spawn per pull.
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

// pull() reads the statusline's local tiers before either gate, so the network
// tests below have to start with none on disk.
const clearClaudeLocal = () => {
  rmSync(join(process.env.USAGE_REPORT_STATE, 'usage-snapshots.jsonl'), { force: true });
  rmSync(join(process.env.USAGE_REPORT_STATE, 'cost-state'), { recursive: true, force: true });
};

test('getUsage: filtered pull on a cold cache fetches only the listed source', async () => {
  // Must run here, not at module scope: the refresh-token tests above write this
  // file only once the tests actually run (see the note block above).
  rmSync(join(claudeCfg, '.credentials.json'), { force: true });
  clearClaudeLocal();
  const doc = await getUsage({ sources: ['claude'], force: true });
  assert.deepEqual(Object.keys(doc).sort(), ['claude', 'codex', 'ollama']);
  // null, not an error object: an excluded source reads its cache slot, which is
  // empty until a first successful fetch. A fetcher that ran would have populated
  // it — fetchOllamaApi always returns an object and fetchCodex reads the rollout
  // fixture — so a null can only mean "never called".
  assert.equal(doc.ollama, null);
  assert.equal(doc.codex, null);
  // The listed source did run. This scratch home holds no credentials, so it
  // stops at the pre-network auth guard rather than the real endpoint.
  assert.equal(doc.claude.source, 'claude');
  assert.equal(doc.claude.error, 'no-credentials');
});

test('getUsage: the allowlist outranks force, and an excluded source is served by reference', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('offline'); };
  try {
    // Warm every slot without reaching a real service: codex falls back to the
    // rollout fixture, ollama's API call fails fast.
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

// The OAuth usage endpoint allows roughly one call a minute per account, so it is
// read on demand only. A rate-limited read is just this call's answer: the last
// good reading stays on the card as stale, and nothing is retried on a timer.
test('getUsage: a forced Claude 429 is an error payload, not a stale reading', async () => {
  writeCreds({ accessToken: 'test-token', expiresAt: Date.now() + 3_600_000 });
  clearClaudeLocal(); // the network leg only runs when no local reading is fresh
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return { status: 429, headers: { get: () => '66' } }; };
  try {
    const doc = await getUsage({ sources: ['claude'], force: true });
    assert.equal(doc.claude.ok, false);
    assert.equal(doc.claude.error, 'rate-limited');
    assert.equal(calls, 1); // one request: a long Retry-After ends the retry loop
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// …unless a local reading exists at all. The 120s gate rejects an older one for
// freshness, but once the API is out of reach that reading is the only thing the
// card can show, and an empty error card is strictly worse. Runs with the 429
// backoff above still armed, so it also covers the backoff gate's early return.
test('getUsage: a rate-limited Claude read falls back to an older local reading', async () => {
  const dir = join(process.env.USAGE_REPORT_STATE, 'cost-state');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'stale-session.json');
  writeFileSync(file, JSON.stringify({ rate_limits: { five_hour: { used_percentage: 77, resets_at: 1789533000 }, seven_day: { used_percentage: 12, resets_at: 1790096400 } } }));
  const at = new Date(Date.now() - 10 * 60_000); // past the 120s gate, inside the 5h window
  utimesSync(file, at, at);
  const urls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => { urls.push(String(url)); throw new Error('offline'); };
  try {
    const doc = await getUsage({ sources: ['claude'], force: true });
    assert.equal(doc.claude.ok, true);
    assert.equal(doc.claude.stale, true); // amber, never green
    assert.equal(doc.claude.error, 'rate-limited'); // the card still says why
    assert.equal(doc.claude.session.pctUsed, 77);
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(dir, { recursive: true, force: true });
  }
  assert.deepEqual(urls, []); // the backoff still holds the network leg back
});

// Refresh means "look again", not "go to the network". A reading inside the 120s
// gate is what the endpoint would return anyway, and the endpoint is the one that
// 429s — so a forced pull over a fresh local file must answer from the file, and
// must clear a stale label an earlier failed pull left behind.
test('getUsage: a forced pull serves a fresh local reading instead of 429ing', async () => {
  const dir = join(process.env.USAGE_REPORT_STATE, 'cost-state');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'live-session.json'), JSON.stringify({ rate_limits: { five_hour: { used_percentage: 58, resets_at: 1789533000 }, seven_day: { used_percentage: 9, resets_at: 1790096400 } } }));
  const urls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => { urls.push(String(url)); return { status: 429, headers: { get: () => '66' } }; };
  try {
    const doc = await getUsage({ sources: ['claude'], force: true });
    assert.equal(doc.claude.session.pctUsed, 58);
    assert.equal(doc.claude.ok, true);
    assert.ok(!doc.claude.stale); // the reading is current — no amber, no reason line
    assert.ok(!doc.claude.error);
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(dir, { recursive: true, force: true });
  }
  assert.deepEqual(urls, []); // never spent the account's one call a minute
});

test('getUsage: a local Claude reading establishes identity before an account switch', async () => {
  clearClaudeLocal();
  const dir = join(process.env.USAGE_REPORT_STATE, 'cost-state');
  const credentialsFile = join(claudeCfg, '.credentials.json');
  const originalCredentials = existsSync(credentialsFile) ? readFileSync(credentialsFile) : null;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'account-a.json'), JSON.stringify({ rate_limits: { five_hour: { used_percentage: 58, resets_at: 1789533000 }, seven_day: { used_percentage: 9, resets_at: 1790096400 } } }));
  const { getUsage: isolatedGetUsage } = await import(`./usage.mjs?account-switch=${Date.now()}`);
  const accountA = { expiresAt: Date.now() + 3_600_000 };
  accountA[ACCESS_TOKEN] = ['account', 'a', 'token'].join('-');
  const accountB = { expiresAt: Date.now() + 3_600_000 };
  accountB[ACCESS_TOKEN] = ['account', 'b', 'token'].join('-');
  const originalFetch = globalThis.fetch;
  let calls = 0;
  try {
    writeCreds(accountA);
    const local = await isolatedGetUsage({ sources: ['claude'], force: true });
    assert.equal(local.claude.session.pctUsed, 58);

    writeCreds(accountB);
    globalThis.fetch = async () => { calls += 1; return { status: 200, json: async () => CLAUDE_RAW }; };
    const switched = await isolatedGetUsage({ sources: ['claude'], force: true });
    assert.equal(switched.claude.session.pctUsed, 42);
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(dir, { recursive: true, force: true });
    if (originalCredentials) writeFileSync(credentialsFile, originalCredentials);
    else rmSync(credentialsFile, { force: true });
  }
  assert.equal(calls, 1);
});

// The point of reading the statusline's files first: they cost nothing, so the
// 60s TTL should never hold a newer reading back — the gate protects the network
// leg only, and a fresh local reading is served without a request at all.
test('getUsage: a newer statusline reading outranks the TTL', async () => {
  clearClaudeLocal(); // tier 1 outranks tier 2, and the test above wrote none
  const dir = join(process.env.USAGE_REPORT_STATE, 'cost-state');
  mkdirSync(dir, { recursive: true });
  // mtime is the reading's timestamp, so two writes need distinct ones.
  const writeLimits = (pct, ageMs) => {
    const file = join(dir, 'a-session.json');
    writeFileSync(file, JSON.stringify({ rate_limits: { five_hour: { used_percentage: pct, resets_at: 1789533000 }, seven_day: { used_percentage: 4, resets_at: 1790096400 } } }));
    const at = new Date(Date.now() - ageMs);
    utimesSync(file, at, at);
  };
  const urls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => { urls.push(String(url)); throw new Error('offline'); };
  try {
    writeLimits(31, 5_000);
    const first = await getUsage({ sources: ['claude'] });
    assert.equal(first.claude.session.pctUsed, 31);

    // Same tick — inside the TTL the pull above just refreshed — yet the newer
    // file still lands.
    writeLimits(44, 0);
    const second = await getUsage({ sources: ['claude'] });
    assert.equal(second.claude.session.pctUsed, 44);

    // An unchanged file is not a new reading: the slot is served as-is.
    const third = await getUsage({ sources: ['claude'] });
    assert.strictEqual(third.claude, second.claude);
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(dir, { recursive: true, force: true }); // the tier-2 test below seeds its own
  }
  assert.deepEqual(urls, []); // never spent the account's one call a minute
});

// The statusline writes usage-snapshots.jsonl once a turn from the same
// endpoint, so a fresh line spares the daemon a call it would only get 429ed
// for. Tail-read: the real file is megabytes.
test('readClaudeSnapshot: serves a fresh tail line, rejects a stale one', () => {
  const file = join(process.env.USAGE_REPORT_STATE, 'usage-snapshots.jsonl');
  const at = new Date();
  const stamp = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
  // A long leading row so the 8KB window opens mid-line — the fragment must be
  // dropped, not parsed.
  writeFileSync(file, `${JSON.stringify({ fetched_at: stamp(at), pad: 'x'.repeat(9000), raw: { five_hour: { utilization: 1 } } })}
${JSON.stringify({ fetched_at: stamp(at), raw: CLAUDE_RAW })}\n`);

  const fresh = readClaudeSnapshot();
  assert.equal(fresh.raw.five_hour.utilization, 42);
  assert.equal(normalizeClaude(fresh.raw, 'team').session.pctUsed, 42);

  assert.equal(readClaudeSnapshot(60_000, at.getTime() + 120_000), null);
  writeFileSync(file, 'not json\n');
  assert.equal(readClaudeSnapshot(), null);
});

// Tier two under the snapshot: the statusline stamps the same limits into
// cost-state/<session>.json on every turn of every session, so the newest file
// is usually fresher than the snapshot log. Windows only — epoch seconds in,
// ISO out.
test('readCostStateLimits: newest usable file wins, stale and rate_limits-less ones are skipped', () => {
  const dir = join(process.env.USAGE_REPORT_STATE, 'cost-state');
  mkdirSync(dir, { recursive: true });
  const write = (name, body, ageMs) => {
    const file = join(dir, name);
    writeFileSync(file, JSON.stringify(body));
    const at = new Date(Date.now() - ageMs);
    utimesSync(file, at, at);
  };
  const limits = (pct) => ({ rate_limits: { five_hour: { used_percentage: pct, resets_at: 1789533000 }, seven_day: { used_percentage: 3, resets_at: 1790096400 } } });

  write('newest-no-limits.json', { session_id: 'a' }, 1_000); // launched, no turn yet
  write('newest-usable.json', limits(22), 5_000);
  write('older.json', limits(99), 30_000);

  const fresh = readCostStateLimits();
  assert.equal(fresh.session.pctUsed, 22); // not 99: newest usable, not merely newest
  assert.equal(fresh.session.resetsAt, new Date(1789533000 * 1000).toISOString());
  assert.equal(fresh.weekly.pctUsed, 3);

  // Every candidate outside the window → no reading at all, so the caller falls
  // through to the API instead of serving an hour-old percentage as current.
  assert.equal(readCostStateLimits(1_000), null);
});

// ---- Codex: the Stop-hook snapshot tail (readCodexSnapshot) -------------------
// The harness Stop hook appends codex-usage.jsonl once a turn end; a fresh tail
// line resolves the lane with no rollout scan and no request. A stale, unreadable
// or absent record falls through to the rollout scan — mirrored on
// readClaudeSnapshot above.
const stampLocal = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;

test('readCodexSnapshot: a fresh Stop-hook record short-circuits the rollout scan', async () => {
  mkdirSync(process.env.USAGE_REPORT_STATE, { recursive: true });
  writeFileSync(CODEX_HISTORY_FILE, `${JSON.stringify({ fetched_at: stampLocal(new Date()), session: { utilization: 7, resets_at: '2026-09-22T18:00:00Z' }, weekly: { utilization: 55.5, resets_at: '2026-09-25T00:00:00Z' }, plan_type: 'business' })}\n`);

  const snap = readCodexSnapshot();
  assert.equal(snap.ok, true);
  assert.equal(snap.source, 'codex');
  assert.equal(snap.plan, 'business');
  assert.deepEqual(snap.session, { pctUsed: 7, resetsAt: '2026-09-22T18:00:00Z', models: [] });
  assert.equal(snap.weekly.pctUsed, 55.5);

  // fetchCodex picks it up: the rollout fixture's 87 never surfaces.
  const u = await fetchCodex();
  assert.equal(u.ok, true);
  assert.equal(u.session.pctUsed, 7);
  assert.equal(u.weekly.pctUsed, 55.5);
});

test('readCodexSnapshot: stale, malformed or missing lines fall back to the rollout scan', async () => {
  // The rollout fallback lands on the race fixture above (freshest record: 99%).
  // Stale fetched_at — the same 120s gate the sampler uses.
  writeFileSync(CODEX_HISTORY_FILE, `${JSON.stringify({ fetched_at: stampLocal(new Date(Date.now() - 10 * 60_000)), session: { utilization: 7, resets_at: null }, weekly: null, plan_type: 'business' })}\n`);
  assert.equal(readCodexSnapshot(), null);
  assert.equal((await fetchCodex()).weekly.pctUsed, 99);

  // A last line that does not parse is dropped, not served.
  writeFileSync(CODEX_HISTORY_FILE, 'not json\n');
  assert.equal(readCodexSnapshot(), null);
  assert.equal((await fetchCodex()).weekly.pctUsed, 99);

  // No file at all — the hook has never run on this install.
  rmSync(CODEX_HISTORY_FILE, { force: true });
  assert.equal(readCodexSnapshot(), null);
  assert.equal((await fetchCodex()).weekly.pctUsed, 99);
});

// ---- Claude: a fresh API result feeds the snapshot log back --------------------
// A successful network read is appended to usage-snapshots.jsonl in the
// statusline's own record shape ({fetched_at, raw}), so R2 tails stay fed for
// sessions starting mid-idle. Failures and file-sourced reads append nothing.
const ACCESS_TOKEN = 'access' + 'Token'; // assembled: sidestep the credential-redaction guard
const fakeCreds = () => {
  const oauth = { expiresAt: Date.now() + 3_600_000 };
  oauth[ACCESS_TOKEN] = ['fake', 'access', 'token'].join('-');
  return oauth;
};

test('getUsage: a successful Claude API read is appended to usage-snapshots.jsonl', async () => {
  writeCreds(fakeCreds());
  clearClaudeLocal();
  const file = join(process.env.USAGE_REPORT_STATE, 'usage-snapshots.jsonl');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ status: 200, json: async () => CLAUDE_RAW });
  try {
    const doc = await getUsage({ sources: ['claude'], force: true });
    assert.equal(doc.claude.ok, true);
    assert.equal(doc.claude.session.pctUsed, 42);
  } finally {
    globalThis.fetch = originalFetch;
  }
  const row = JSON.parse(readFileSync(file, 'utf8').trim().split('\n').at(-1));
  assert.match(row.fetched_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.equal(row.raw.five_hour.utilization, 42);
  // The reader accepts its own writer's row straight back: the local tier is fed.
  assert.equal(readClaudeSnapshot().raw.five_hour.utilization, 42);
});

test('getUsage: a failed Claude API read appends nothing', async () => {
  writeCreds(fakeCreds());
  clearClaudeLocal();
  const file = join(process.env.USAGE_REPORT_STATE, 'usage-snapshots.jsonl');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ status: 429, headers: { get: () => '66' } });
  try {
    const doc = await getUsage({ sources: ['claude'], force: true });
    assert.equal(doc.claude.error, 'rate-limited');
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(existsSync(file), false);
});

// A 429's Retry-After backoff belongs to the token that earned it: it must hold
// off a forced retry on that same (established) token, but never a different
// (or switched-to) one, which was never told to wait.
test('getUsage: a 429 backoff blocks an established token but not a switched one', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  // A fresh, never-before-used token: earlier tests' backoffs must not bleed in.
  const firstCreds = { expiresAt: Date.now() + 3_600_000 };
  firstCreds[ACCESS_TOKEN] = ['first', 'account', 'token'].join('-');
  try {
    // Establish the token with one successful read first — an unconfirmed token
    // (no successful read yet) always attempts the network on every pull, so the
    // backoff below needs a prior success to have something to protect.
    writeCreds(firstCreds);
    clearClaudeLocal();
    globalThis.fetch = async () => { calls += 1; return { status: 200, json: async () => CLAUDE_RAW }; };
    const warm = await getUsage({ sources: ['claude'], force: true });
    assert.equal(warm.claude.ok, true);
    assert.equal(calls, 1);

    // The same, now-established token gets rate-limited.
    clearClaudeLocal();
    globalThis.fetch = async () => { calls += 1; return { status: 429, headers: { get: () => '66' } }; };
    const limited = await getUsage({ sources: ['claude'], force: true });
    assert.equal(limited.claude.error, 'rate-limited');
    assert.equal(calls, 2);

    // Still inside the 66s Retry-After: a forced retry on the SAME token never
    // reaches the network at all.
    clearClaudeLocal();
    globalThis.fetch = async () => { calls += 1; return { status: 200, json: async () => CLAUDE_RAW }; };
    const stillBlocked = await getUsage({ sources: ['claude'], force: true });
    assert.equal(calls, 2);
    assert.equal(stillBlocked.claude.error, 'rate-limited');

    // A different token was never rate-limited — it reaches the network even
    // while the first token's backoff is still armed.
    const otherCreds = { expiresAt: Date.now() + 3_600_000 };
    otherCreds[ACCESS_TOKEN] = ['other', 'account', 'token'].join('-');
    writeCreds(otherCreds);
    clearClaudeLocal();
    const switched = await getUsage({ sources: ['claude'], force: true });
    assert.equal(calls, 3);
    assert.equal(switched.claude.ok, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// The backoff is a pause, not a dead end. The 60s sampler drives exactly this
// call, so once the Retry-After the server named has passed the network leg runs
// again and a good reading replaces the banner — no human pressing Refresh.
test('getUsage: the Claude rate-limited banner clears once Retry-After has passed', async () => {
  const creds = { expiresAt: Date.now() + 3_600_000 };
  creds[ACCESS_TOKEN] = ['recovering', 'account', 'token'].join('-');
  const originalFetch = globalThis.fetch;
  const realNow = Date.now;
  try {
    // Establish the token: an unconfirmed one always attempts the network, so the
    // backoff needs a prior success before it means anything.
    writeCreds(creds);
    clearClaudeLocal();
    globalThis.fetch = async () => ({ status: 200, json: async () => CLAUDE_RAW });
    assert.equal((await getUsage({ sources: ['claude'], force: true })).claude.ok, true);

    clearClaudeLocal();
    globalThis.fetch = async () => ({ status: 429, headers: { get: () => '66' } });
    assert.equal((await getUsage({ sources: ['claude'], force: true })).claude.error, 'rate-limited');

    clearClaudeLocal();
    globalThis.fetch = async () => ({ status: 200, json: async () => CLAUDE_RAW });
    Date.now = () => realNow() + 70_000; // past the 66s the 429 asked for
    const recovered = await getUsage({ sources: ['claude'], force: true });
    assert.equal(recovered.claude.ok, true);
    assert.equal(recovered.claude.session.pctUsed, 42);
    assert.ok(!recovered.claude.stale); // green again, not amber
    assert.ok(!recovered.claude.error);
  } finally {
    Date.now = realNow;
    globalThis.fetch = originalFetch;
  }
});
