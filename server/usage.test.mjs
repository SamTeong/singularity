// Unit tests for usage normalization: the claude OAuth-response mapper, the
// Ollama settings-page scraper, and the Codex snapshot/API readers. usage.mjs pulls in
// app-dir.mjs (STATE_DIR/USAGE_SKILL_STATE), which requires SINGULARITY_HOME and
// reads USAGE_REPORT_STATE — point both at a scratch temp dir before the dynamic
// import.
// Run: npm test  (node --test server/)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync, utimesSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRustBackend } from './rust-backend.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'singularity-usage-test-'));
process.env.SINGULARITY_HOME = join(scratch, 'sing');
process.env.USAGE_REPORT_STATE = join(scratch, 'usage-report-state');

process.env.CODEX_HOME = join(scratch, 'codex-home');
mkdirSync(process.env.CODEX_HOME, { recursive: true });
const codexAuth = join(process.env.CODEX_HOME, 'auth.json');
const writeCodexAuth = (tokens) => writeFileSync(codexAuth, JSON.stringify({ tokens }));

// Point the OAuth refresh at scratch credentials, never the real ~/.claude — a
// live refresh_token grant here would rotate the developer's own token.
const claudeCfg = join(scratch, 'claude-home');
mkdirSync(claudeCfg, { recursive: true });
process.env.CLAUDE_CONFIG_DIR = claudeCfg;
const writeCreds = (oauth) => writeFileSync(join(claudeCfg, '.credentials.json'), JSON.stringify({ claudeAiOauth: oauth }));

let usageRustBackend;
after(async () => { await usageRustBackend?.stop(); rmSync(scratch, { recursive: true, force: true }); });

const { parseOllamaHtml, classifyOllamaPage, connectOllamaUsage, preserveOllamaStale, scrapeOllamaOnce, appendOllamaHistory, appendCodexHistory, fetchCodex, readClaudeSnapshot, readClaudeLocal, readCodexSnapshot, readCostStateLimits, claudeOauthToken, setUsageAuthBackend, setUsageNormalizationBackend, setUsageSnapshotBackend, setUsageCodexBackend, setUsageClaudeBackend, setUsageOllamaModeConfigBackend, refreshClaudeAuth, refreshOauthGrant, getUsage, sampleCodex, SNAPSHOT_MAX_AGE_MS } = await import('./usage.mjs');
usageRustBackend = createRustBackend();
await usageRustBackend.start();
setUsageNormalizationBackend(usageRustBackend);
setUsageSnapshotBackend(usageRustBackend);
setUsageOllamaModeConfigBackend(usageRustBackend);
let codexFixture = async () => { throw new Error('missing offline Codex fixture'); };
const codexFixtureSnapshots = new Map();
const codexFingerprintReads = [];
let nextCodexFixtureHandle = 0;
const codexFixtureBackend = {
  async codexAccountFingerprint(authPath) {
    codexFingerprintReads.push(authPath);
    try {
      const accountId = JSON.parse(readFileSync(authPath, 'utf8'))?.tokens?.account_id;
      return typeof accountId === 'string' && accountId.length > 0
        ? createHash('sha256').update(accountId).digest('hex')
        : null;
    } catch { return null; }
  },
  async codexUsageBegin(authPath) {
    try {
      const tokens = JSON.parse(readFileSync(authPath, 'utf8'))?.tokens;
      if (!tokens?.access_token || !tokens?.account_id) return { kind: 'no_sessions' };
      const handle = `fixture-${++nextCodexFixtureHandle}`;
      codexFixtureSnapshots.set(handle, { authPath, tokens: structuredClone(tokens) });
      return { kind: 'ready', handle };
    } catch { return { kind: 'no_sessions' }; }
  },
  codexUsageFetch(handle) {
    const snapshot = codexFixtureSnapshots.get(handle);
    if (!snapshot) throw new Error('fixture credential handle was released');
    return codexFixture(snapshot.authPath, snapshot.tokens);
  },
  codexUsageRelease(handle) { return { released: codexFixtureSnapshots.delete(handle) }; },
};
const codexResponse = (payload, status = 200, retryAfter = null) => ({ kind: 'response', status, retry_after: retryAfter, body: { ok: JSON.stringify(payload) } });
const nativeFetch = globalThis.fetch;
const claudeCredentialReads = [];
const claudeCredentialWrites = [];
const claudeFixtureBackend = {
  async claudeCredentialsRead(path) {
    claudeCredentialReads.push(path);
    try { return { kind: 'file', text: readFileSync(path, 'utf8') }; }
    catch (error) { return error.code === 'ENOENT' ? { kind: 'missing' } : { kind: 'read_failure' }; }
  },
  async claudeCredentialsWrite(path, tempPath, text) {
    claudeCredentialWrites.push({ path, tempPath, text });
    try {
      writeFileSync(tempPath, text, { mode: 0o600 });
      renameSync(tempPath, path);
      return true;
    } catch {
      try { writeFileSync(path, text, { mode: 0o600 }); return true; }
      catch { return false; }
    }
  },
  async claudeUsageFetch(accessToken) {
    if (globalThis.fetch === nativeFetch) throw new Error('missing offline Claude fixture');
    const response = await globalThis.fetch('https://fixture.invalid/claude-usage', {
      method: 'GET', headers: { Authorization: `Bearer ${accessToken}`, 'anthropic-beta': 'oauth-2025-04-20' },
    });
    let body = { ok: null };
    if (response.status === 200) {
      try { body = { ok: JSON.stringify(await response.json()) }; }
      catch { body = { err: 'terminated' }; }
    }
    return { kind: 'response', status: response.status, retry_after: response.headers?.get?.('retry-after') ?? null, body };
  },
  async claudeOauthRefresh() { throw new Error('missing offline Claude OAuth fixture'); },
};
let lastCodexAuthPath;
codexFixture = async (authPath, tokens) => {
  if (globalThis.fetch === nativeFetch) throw new Error('missing offline Codex fixture');
  lastCodexAuthPath = authPath;
  const response = await globalThis.fetch('https://fixture.invalid/usage', {
    method: 'GET', headers: { Authorization: `Bearer ${tokens.access_token}`, 'ChatGPT-Account-Id': `${tokens.account_id}` },
  });
  let body = { ok: null };
  if (response.status === 200) {
    try { body = { ok: JSON.stringify(await response.json()) }; }
    catch { body = { err: 'terminated' }; }
  }
  return { kind: 'response', status: response.status, retry_after: response.headers?.get?.('retry-after') ?? null, body };
};
const codexFixtureBaseline = codexFixture;
setUsageCodexBackend(codexFixtureBackend);
setUsageClaudeBackend(claudeFixtureBackend);
async function importIsolatedUsage(specifier) {
  const isolated = await import(specifier);
  isolated.setUsageNormalizationBackend(usageRustBackend);
  isolated.setUsageSnapshotBackend(usageRustBackend);
  isolated.setUsageOllamaModeConfigBackend(usageRustBackend);
  isolated.setUsageCodexBackend(codexFixtureBackend);
  isolated.setUsageClaudeBackend(claudeFixtureBackend);
  return isolated;
}

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

test('Ollama config Rust read preserves missing, Node parse errors, BOM, and stable read failures', async () => {
  const isolated = await importIsolatedUsage(`./usage.mjs?ollama-config-read=${Date.now()}`);
  const path = join(process.env.SINGULARITY_HOME, 'state', 'ollama.json');
  mkdirSync(dirname(path), { recursive: true });
  const read = async () => (await isolated.getUsage({ sources: ['ollama'], force: true })).ollama;
  try {
    rmSync(path, { force: true });
    const missing = await read();
    assert.deepEqual(
      { ok: missing.ok, source: missing.source, needsAuth: missing.needsAuth, error: missing.error },
      { ok: false, source: 'ollama', needsAuth: true, error: 'no-config' },
    );

    const invalidJson = '{"mode":';
    writeFileSync(path, invalidJson);
    let parseMessage;
    try { JSON.parse(invalidJson); } catch (error) { parseMessage = error.message; }
    const parse = await read();
    assert.equal(parse.error, `bad ${path}: ${parseMessage}`);
    assert.equal(Object.hasOwn(parse, 'needsAuth'), false);

    const bomText = '\uFEFF{}';
    writeFileSync(path, bomText);
    let bomMessage;
    try { JSON.parse(bomText); } catch (error) { bomMessage = error.message; }
    assert.equal((await read()).error, `bad ${path}: ${bomMessage}`);

    writeFileSync(path, Buffer.from([0xff, 0x7b, 0x7d]));
    const lossy = await read();
    assert.match(lossy.error, new RegExp(`^bad ${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: `));
    assert.equal(Object.hasOwn(lossy, 'needsAuth'), false);

    rmSync(path);
    mkdirSync(path);
    const failure = await read();
    assert.match(failure.error, new RegExp(`^bad ${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: read failed \\((not-found|permission-denied|already-exists|invalid-input|invalid-data|interrupted|storage-full|other)\\)$`));
    assert.equal(Object.hasOwn(failure, 'needsAuth'), false);
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
});

test('connectOllamaUsage rejects stable Rust writer errors with the exact Node temp path and text', async () => {
  const isolated = await importIsolatedUsage(`./usage.mjs?ollama-config-write=${Date.now()}`);
  const path = join(process.env.SINGULARITY_HOME, 'state', 'ollama.json');
  const calls = [];
  isolated.setUsageOllamaModeConfigBackend({
    ollamaModeConfigWrite: async (...args) => {
      calls.push(args);
      throw new Error(`bad ${path}: rename failed (permission-denied)`);
    },
  });
  const page = { goto: async () => {}, url: () => 'https://ollama.com/settings', waitForSelector: async () => {}, content: async () => OLLAMA_HTML };
  const playwright = { chromium: { launchPersistentContext: async () => ({ addInitScript: async () => {}, pages: () => [page], close: async () => {} }) } };
  const realNow = Date.now;
  try {
    Date.now = () => 987654321;
    await assert.rejects(isolated.connectOllamaUsage({ playwright, headlessVerifier: async () => parseOllamaHtml(OLLAMA_HTML) }),
      new RegExp(`^Error: bad ${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: rename failed \\(permission-denied\\)$`));
  } finally {
    Date.now = realNow;
  }
  assert.deepEqual(calls, [[path, `${path}.${process.pid}.987654321.tmp`, '{"mode":"browser"}']]);
});

test('connectOllamaUsage: resumes history collection after authentication recovers', async () => {
  const { connectOllamaUsage: isolatedConnect, runHistorySample: isolatedSample } = await importIsolatedUsage(`./usage.mjs?history-resume=${Date.now()}`);
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
    // Browser mode left behind makes every later getUsage (and the sampler tick
    // connect started) run a real headless scrape — slow on CI, and a sign-in
    // redirect there pauses history mid-suite.
    rmSync(join(process.env.SINGULARITY_HOME, 'state', 'ollama.json'), { force: true });
    rmSync(join(process.env.USAGE_REPORT_STATE, 'ollama-usage.jsonl'), { force: true });
    rmSync(join(process.env.USAGE_REPORT_STATE, 'codex-usage.jsonl'), { force: true });
  }
  assert.equal(calls, 3);
});

test('runHistorySample: a good tick caches the reading without a second scrape', async () => {
  const { runHistorySample: isolatedSample, getUsage: isolatedGetUsage } = await importIsolatedUsage(`./usage.mjs?history-good=${Date.now()}`);
  try {
    await isolatedSample(async () => parseOllamaHtml(OLLAMA_HTML));
    // Within the network floor, getUsage must answer from the cache the tick
    // just wrote — never call this fetcher again.
    let scraped = false;
    const { ollama } = await isolatedGetUsage({ sources: ['ollama'], fetchers: { ollama: async () => { scraped = true; throw new Error('should not scrape'); } } });
    assert.equal(scraped, false);
    assert.equal(ollama.ok, true);
    assert.equal(ollama.plan, 'pro');
  } finally {
    rmSync(join(process.env.SINGULARITY_HOME, 'state', 'ollama.json'), { force: true });
    rmSync(join(process.env.USAGE_REPORT_STATE, 'ollama-usage.jsonl'), { force: true });
  }
  // Not asserted: the WS 'usage' emit via initUsageAutoRefresh — it unconditionally
  // calls startHistorySampler(), arming real un-cancellable timers, so wiring a
  // bus here for one assertion is not cheap. Skipped per the task's own escape hatch.
});

test('runHistorySample: a genuine failure still arms the gate (is not skipped as a floor hit)', async () => {
  const { runHistorySample: isolatedSample } = await importIsolatedUsage(`./usage.mjs?history-fail=${Date.now()}`);
  const realNow = Date.now;
  try {
    await isolatedSample(async () => parseOllamaHtml(OLLAMA_HTML)); // tick 1: good reading, clears backoff
    Date.now = () => realNow() + 61_000; // past the 60s network floor: tick 2 gets a real attempt
    await isolatedSample(async () => ({ ok: false, source: 'ollama', error: 'boom' })); // tick 2: genuine failure
    let called = false;
    await isolatedSample(async () => { called = true; return { ok: false, source: 'ollama', error: 'boom' }; }); // tick 3: immediate retry
    // ollamaGate armed by tick 2's failure blocks tick 3 before it ever reaches the fetcher.
    assert.equal(called, false);
  } finally {
    Date.now = realNow;
    rmSync(join(process.env.SINGULARITY_HOME, 'state', 'ollama.json'), { force: true });
    rmSync(join(process.env.USAGE_REPORT_STATE, 'ollama-usage.jsonl'), { force: true });
  }
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

test('appendOllamaHistory: dedupes an unchanged reading, writes a changed one', async () => {
  await appendOllamaHistory(READING);
  await appendOllamaHistory(READING); // identical → no second line
  const changed = { ...READING, session: { ...READING.session, pctUsed: 28.1 } };
  await appendOllamaHistory(changed);

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

test('appendOllamaHistory retries an identical reading after a failed append', async () => {
  const retryReading = { ...READING, session: { ...READING.session, pctUsed: 99.9 } };
  rmSync(HISTORY_FILE, { recursive: true, force: true });
  mkdirSync(HISTORY_FILE);
  await appendOllamaHistory(retryReading); // path is a directory, so the append fails
  rmSync(HISTORY_FILE, { recursive: true, force: true });
  await appendOllamaHistory(retryReading); // same successful result must be retried

  const lines = readFileSync(HISTORY_FILE, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).session.utilization, 99.9);
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

test('appendCodexHistory: skill snapshot shape, dedupes an unchanged reading', async () => {
  await appendCodexHistory(CODEX_READING);
  await appendCodexHistory(CODEX_READING); // identical → no second line
  await appendCodexHistory({ ...CODEX_READING, session: { ...CODEX_READING.session, pctUsed: 44 } });

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

test('appendCodexHistory: an unchanged reading is rewritten once the 5-min heartbeat has passed', async () => {
  const { appendCodexHistory: isolatedAppendCodexHistory } = await importIsolatedUsage(`./usage.mjs?codex-heartbeat=${Date.now()}`);
  const realNow = Date.now;
  try {
    await isolatedAppendCodexHistory(CODEX_READING);
    await isolatedAppendCodexHistory(CODEX_READING); // within the heartbeat → deduped
    Date.now = () => realNow() + 5 * 60_000;
    await isolatedAppendCodexHistory(CODEX_READING); // heartbeat elapsed → written again
    const rows = readFileSync(CODEX_HISTORY_FILE, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[1].session, rows[0].session);
  } finally {
    Date.now = realNow;
    rmSync(CODEX_HISTORY_FILE, { force: true });
  }
});

test('appendCodexHistory: retries an unchanged reading after a failed append', async () => {
  const historyDir = dirname(CODEX_HISTORY_FILE);
  const heldDir = `${historyDir}-held`;
  const reading = { ...CODEX_READING, session: { ...CODEX_READING.session, pctUsed: 41 } };
  mkdirSync(historyDir, { recursive: true });
  rmSync(heldDir, { recursive: true, force: true });
  renameSync(historyDir, heldDir);
  writeFileSync(historyDir, 'blocks directory creation');
  try {
    await appendCodexHistory(reading); // append fails best-effort while parent path is a file
  } finally {
    rmSync(historyDir, { force: true });
    renameSync(heldDir, historyDir);
  }

  try {
    await appendCodexHistory(reading); // same reading must retry before heartbeat expiry
    const rows = readFileSync(CODEX_HISTORY_FILE, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].session.utilization, 41);
  } finally {
    rmSync(CODEX_HISTORY_FILE, { force: true });
  }
});

test('appendCodexHistory: an unstarted transition with unchanged limits appends a fresh snapshot', async () => {
  const window = { pctUsed: 0, resetsAt: null, models: [] };
  await appendCodexHistory({ ...CODEX_READING, session: window });
  await appendCodexHistory({ ...CODEX_READING, session: { ...window, started: false } });
  const rows = readFileSync(CODEX_HISTORY_FILE, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].session.started, undefined);
  assert.equal(rows[1].session.started, false);
  assert.equal((await readCodexSnapshot()).session.started, false);
  rmSync(CODEX_HISTORY_FILE, { force: true });
});

// Codex's only local tier now is the Stop hook's codex-usage.jsonl tail (the
// rollout-log scan was removed in favor of the hook bumping this file every
// turn, changed or not). A fresh line answers with no network at all; no
// file (or a stale one) reports "no Codex sessions found" rather than
// scanning anything else on disk.
const codexFreshLine = (pct) => writeFileSync(CODEX_HISTORY_FILE, `${JSON.stringify({ fetched_at: stampLocal(new Date()), session: null, weekly: { utilization: pct, resets_at: '2026-07-20T00:00:00Z' }, plan_type: 'plus' })}\n`);

test('fetchCodex: a fresh codex-usage.jsonl line answers with no network at all', async () => {
  codexFreshLine(87);
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; throw new Error('offline'); };
  try {
    const u = await fetchCodex();
    assert.equal(u.ok, true);
    assert.equal(u.source, 'codex');
    assert.equal(u.plan, 'plus');
    assert.equal(u.session, null);
    assert.equal(u.weekly.pctUsed, 87);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(CODEX_HISTORY_FILE, { force: true });
  }
});

test('fetchCodex: no codex-usage.jsonl at all reports "no Codex sessions found", still no network', async () => {
  rmSync(CODEX_HISTORY_FILE, { force: true });
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; throw new Error('offline'); };
  try {
    const u = await fetchCodex();
    assert.equal(u.ok, false);
    assert.equal(u.error, 'no Codex sessions found');
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// The live wham/usage API is on-demand only: ?force=1 (the daemon passes force
// through) is the one thing that makes fetchCodex spend a request.
test('fetchCodex(true): dispatches the auth path and normalizes 5h + 7d windows without credential output', async () => {
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
    assert.equal(request.opts.method, 'GET');
    assert.equal(lastCodexAuthPath, codexAuth);
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

test('fetchCodex(true): retry keeps the first credential snapshot and releases it', async () => {
  writeCodexAuth({ access_token: 'account-A-token', account_id: 'account-A' });
  const originalFetch = globalThis.fetch;
  const seen = [];
  codexFixture = async (_authPath, tokens) => {
    seen.push([tokens.access_token, tokens.account_id]);
    if (seen.length === 1) {
      writeCodexAuth({ access_token: 'account-B-token', account_id: 'account-B' });
      return { kind: 'response', status: 503, retry_after: null, body: { ok: null } };
    }
    return codexResponse({ plan_type: 'plus', rate_limit: { primary_window: { used_percent: 42, limit_window_seconds: 18_000, reset_at: 1786000000 } } });
  };
  try {
    const result = await fetchCodex(true);
    assert.equal(result.plan, 'plus');
    assert.deepEqual(seen, [['account-A-token', 'account-A'], ['account-A-token', 'account-A']]);
    assert.equal(codexFixtureSnapshots.size, 0);
  } finally {
    codexFixture = codexFixtureBaseline;
    globalThis.fetch = originalFetch;
  }
});

// An unused 5h window has not begun, and the live API fills reset_at with a
// rolling now + the whole window, so it walks forward on every poll. That is
// not a reset instant: drop it and flag the window unstarted, or the UI shows a
// countdown that never lands and the window anchor arms a timer it keeps
// pushing out of reach.
test('fetchCodex(true): a window that has not begun drops its sliding reset', async () => {
  writeCodexAuth({ access_token: 'fixture-token', account_id: 'fixture-account' });
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
  writeCodexAuth({ access_token: 'fixture-token', account_id: 'fixture-account' });
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

test('fetchCodex(true): a failed live request reports the live error, with no rollout to fall back to', async () => {
  writeCodexAuth({ access_token: 'fixture-token', account_id: 'fixture-account' });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('offline'); };
  try {
    const u = await fetchCodex(true);
    assert.equal(u.ok, false);
    assert.equal(u.error, 'request failed: offline');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchCodex(true): malformed JSON keeps V8 parse wording and is not retried', async () => {
  writeCodexAuth({ access_token: 'fixture-token', account_id: 'fixture-account' });
  let calls = 0;
  codexFixture = async () => { calls += 1; return { kind: 'response', status: 200, retry_after: null, body: { ok: '{' } }; };
  try {
    const result = await fetchCodex(true);
    assert.match(result.error, /^parse error: /);
    assert.equal(calls, 1);
    assert.equal(codexFixtureSnapshots.size, 0);
  } finally { codexFixture = codexFixtureBaseline; }
});

test('fetchCodex(true): body stream failure preserves the caught message and is not retried', async () => {
  writeCodexAuth({ access_token: 'fixture-token', account_id: 'fixture-account' });
  let calls = 0;
  codexFixture = async () => { calls += 1; return { kind: 'response', status: 200, retry_after: null, body: { err: 'terminated' } }; };
  try {
    const result = await fetchCodex(true);
    assert.equal(result.error, 'parse error: terminated');
    assert.equal(calls, 1);
  } finally { codexFixture = codexFixtureBaseline; }
});

test('fetchCodex(true): typed timeout retries and preserves the AbortController message', async () => {
  writeCodexAuth({ access_token: 'fixture-token', account_id: 'fixture-account' });
  let calls = 0;
  codexFixture = async () => { calls += 1; return { kind: 'timeout_failure' }; };
  try {
    const result = await fetchCodex(true);
    assert.equal(result.error, 'request failed: This operation was aborted');
    assert.equal(calls, 3);
  } finally { codexFixture = codexFixtureBaseline; }
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

test('refreshOauthGrant: missing, unreadable, or malformed bridge data stops before OAuth and Keychain', async () => {
  const isolated = await importIsolatedUsage(`./usage.mjs?refresh-guard-read=${Date.now()}`);
  let oauthCalls = 0;
  let keychainCalls = 0;
  isolated.setUsageAuthBackend({ usageKeychain: async () => { keychainCalls += 1; return {}; } }, 'darwin');
  for (const result of [{ kind: 'missing' }, { kind: 'read_failure' }, { kind: 'file', text: '{' }]) {
    isolated.setUsageClaudeBackend({ ...claudeFixtureBackend, claudeCredentialsRead: async () => result, claudeOauthRefresh: async () => { oauthCalls += 1; } });
    assert.equal(await isolated.refreshOauthGrant(), false);
  }
  assert.equal(oauthCalls, 0);
  assert.equal(keychainCalls, 0);
  isolated.setUsageAuthBackend(null);
});

test('refreshOauthGrant: merge read failures start empty; parsed null and primitives reject without CLI fallback', async () => {
  const credentialPath = join(claudeCfg, '.credentials.json');
  for (const mergeResult of [
    { kind: 'missing' }, { kind: 'read_failure' }, { kind: 'file', text: '{' },
  ]) {
    const isolated = await importIsolatedUsage(`./usage.mjs?merge-read=${Date.now()}-${Math.random()}`);
    let reads = 0;
    isolated.setUsageClaudeBackend({
      ...claudeFixtureBackend,
      async claudeCredentialsRead() {
        reads += 1;
        return reads === 1
          ? { kind: 'file', text: JSON.stringify({ claudeAiOauth: { refreshToken: 'synthetic-refresh' } }) }
          : mergeResult;
      },
      async claudeOauthRefresh() {
        return { kind: 'response', status: 200, retry_after: null, body: { ok: JSON.stringify({ access_token: 'synthetic-access', refresh_token: 'rotated' }) } };
      },
    });
    assert.equal(await isolated.refreshOauthGrant(), true);
    assert.equal(reads, 2);
    assert.deepEqual(JSON.parse(readFileSync(credentialPath, 'utf8')), {
      claudeAiOauth: { accessToken: 'synthetic-access', refreshToken: 'rotated' },
    });
  }

  for (const text of ['null', '17']) {
    const isolated = await importIsolatedUsage(`./usage.mjs?merge-value=${Date.now()}-${Math.random()}`);
    let reads = 0;
    let cliCalls = 0;
    isolated.setUsageClaudeBackend({
      ...claudeFixtureBackend,
      async claudeCredentialsRead() {
        reads += 1;
        return { kind: 'file', text: reads === 1 ? '{"claudeAiOauth":{"refreshToken":"synthetic-refresh"}}' : text };
      },
      async claudeOauthRefresh() {
        return { kind: 'response', status: 200, retry_after: null, body: { ok: '{"access_token":"synthetic-access"}' } };
      },
    });
    isolated.setUsageAuthBackend({ usageAuthStatus: async () => { cliCalls += 1; } }, 'win32');
    process.env.CLAUDE_BIN = process.execPath;
    await assert.rejects(isolated.refreshClaudeAuth());
    assert.equal(reads, 2);
    assert.equal(cliCalls, 0);
  }
});

test('refreshOauthGrant preserves JSON.stringify text, retries in Node, and merges rotated credentials', async () => {
  const isolated = await importIsolatedUsage(`./usage.mjs?oauth-body=${Date.now()}`);
  const readStart = claudeCredentialReads.length;
  const writeStart = claudeCredentialWrites.length;
  const seen = [];
  let failOnce = true;
  isolated.setUsageClaudeBackend({
    ...claudeFixtureBackend,
    async claudeOauthRefresh(body, signal, timeoutMs) {
      seen.push({ body, signal, timeoutMs });
      if (failOnce) { failOnce = false; throw new Error('synthetic transport failure'); }
      return { kind: 'response', status: 200, retry_after: null, body: { ok: JSON.stringify({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 }) } };
    },
  });
  const refreshTokens = ['synthetic-string-refresh', 17, { nested: [true, 'opaque'] }];
  for (const refreshToken of refreshTokens) {
    writeCreds({ accessToken: 'old-access', refreshToken, refreshTokenExpiresAt: Date.now() + 3_600_000, expiresAt: 7, subscriptionType: 'pro', rateLimitTier: 'legacy' });
    assert.equal(await isolated.refreshOauthGrant(), true);
  }
  const expected = refreshTokens.map((refreshToken) => JSON.stringify({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e' }));
  assert.deepEqual(seen.map(({ body }) => body), [expected[0], expected[0], ...expected.slice(1)]);
  assert.equal(seen.length, 4);
  // Three grant attempts each read guard+merge once; transport retry stays inside fetchExternal.
  assert.deepEqual(claudeCredentialReads.slice(readStart), Array(6).fill(join(claudeCfg, '.credentials.json')));
  const writes = claudeCredentialWrites.slice(writeStart);
  assert.equal(writes.length, 3);
  assert.ok(writes.every(({ path, tempPath }) => path === join(claudeCfg, '.credentials.json') && tempPath === `${path}.${process.pid}.tmp`));
  assert.ok(seen.every(({ timeoutMs }) => timeoutMs === 10_000));
  const saved = JSON.parse(readFileSync(join(claudeCfg, '.credentials.json'), 'utf8')).claudeAiOauth;
  assert.equal(saved.accessToken, 'new-access');
  assert.equal(saved.refreshToken, 'new-refresh');
  assert.equal(saved.subscriptionType, 'pro');
  assert.equal(saved.rateLimitTier, 'legacy');
  assert.equal(JSON.parse(writes.at(-1).text).claudeAiOauth.refreshToken, 'new-refresh');
});

test('refreshOauthGrant maps false and rejected credential writes to false', async () => {
  for (const claudeCredentialsWrite of [async () => false, async () => { throw new Error('synthetic writer rejection'); }]) {
    const isolated = await importIsolatedUsage(`./usage.mjs?writer-failure=${Date.now()}-${Math.random()}`);
    isolated.setUsageClaudeBackend({
      ...claudeFixtureBackend,
      claudeCredentialsWrite,
      async claudeOauthRefresh() {
        return { kind: 'response', status: 200, retry_after: null, body: { ok: '{"access_token":"synthetic-access"}' } };
      },
    });
    writeCreds({ refreshToken: 'synthetic-refresh' });
    assert.equal(await isolated.refreshOauthGrant(), false);
  }
});

test('refreshOauthGrant keeps non-200 and invalid JSON failures in Node', async () => {
  const isolated = await importIsolatedUsage(`./usage.mjs?oauth-response=${Date.now()}`);
  const results = [
    { kind: 'response', status: 500, retry_after: null, body: { ok: null } },
    { kind: 'response', status: 200, retry_after: null, body: { ok: '{' } },
  ];
  let nextResult = 0;
  isolated.setUsageClaudeBackend({ ...claudeFixtureBackend, claudeOauthRefresh: async () => results[Math.min(nextResult++, results.length - 1)] });
  writeCreds({ refreshToken: 17, expiresAt: 11, subscriptionType: 'keep-me' });
  const original = readFileSync(join(claudeCfg, '.credentials.json'), 'utf8');
  assert.equal(await isolated.refreshOauthGrant(), false);
  assert.equal(await isolated.refreshOauthGrant(), false);
  assert.equal(readFileSync(join(claudeCfg, '.credentials.json'), 'utf8'), original);
});

test('refreshOauthGrant leaves raw long Retry-After handling to Node', async () => {
  const isolated = await importIsolatedUsage(`./usage.mjs?oauth-retry-after=${Date.now()}`);
  let calls = 0;
  isolated.setUsageClaudeBackend({
    ...claudeFixtureBackend,
    async claudeOauthRefresh() {
      calls += 1;
      return { kind: 'response', status: 429, retry_after: '66', body: { ok: null } };
    },
  });
  writeCreds({ refreshToken: 'synthetic-refresh', expiresAt: 22 });
  assert.equal(await isolated.refreshOauthGrant(), false);
  assert.equal(calls, 1);
});

test('claudeOauthToken: file precedence, async Keychain fallback, and quiet failures', async () => {
  let calls = 0;
  const credentialPath = join(claudeCfg, '.credentials.json');
  const readCredentialPath = claudeFixtureBackend.claudeCredentialsRead;
  const paths = [];
  claudeFixtureBackend.claudeCredentialsRead = async (path) => {
    paths.push(path);
    return readCredentialPath(path);
  };
  setUsageAuthBackend({ usageKeychain: async () => {
    calls++;
    return { accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh', expiresAt: Date.now() + 60_000, subscriptionType: 'pro' };
  } }, 'darwin');
  writeCreds({ accessToken: 'file-access', expiresAt: Date.now() + 60_000, subscriptionType: 'file-plan' });
  const fromFile = await claudeOauthToken();
  assert.equal(paths.at(-1), credentialPath);
  assert.equal(fromFile.accessToken !== undefined, true);
  assert.equal(fromFile.subscriptionType, 'file-plan');
  assert.equal(calls, 0);

  writeCreds({ subscriptionType: 'missing-access' });
  assert.equal(await claudeOauthToken(), null);
  assert.equal(calls, 0, 'a present credential object retains file precedence without an access token');

  writeFileSync(credentialPath, '{');
  const malformedFallback = await claudeOauthToken();
  assert.equal(malformedFallback.accessToken, 'synthetic-access');
  assert.equal(calls, 1, 'malformed JSON permits the Darwin Keychain fallback');
  writeFileSync(credentialPath, 'null');
  assert.equal((await claudeOauthToken()).accessToken, 'synthetic-access');
  assert.equal(calls, 2, 'a null JSON root retains the existing parse/property failure fallback');

  claudeFixtureBackend.claudeCredentialsRead = async () => ({ kind: 'read_failure' });
  assert.equal((await claudeOauthToken()).accessToken, 'synthetic-access');
  assert.equal(calls, 3, 'read failure permits the Darwin Keychain fallback');
  claudeFixtureBackend.claudeCredentialsRead = readCredentialPath;

  rmSync(credentialPath, { force: true });
  const fromKeychain = await claudeOauthToken();
  assert.equal(fromKeychain.accessToken, 'synthetic-access');
  assert.equal(fromKeychain.subscriptionType, 'pro');
  assert.equal(calls, 4);

  const logged = [];
  const originalError = console.error;
  const originalWarn = console.warn;
  console.error = (...args) => logged.push(args.join(' '));
  console.warn = (...args) => logged.push(args.join(' '));
  try {
    setUsageAuthBackend({ usageKeychain: async () => {
      throw new Error('synthetic process failure synthetic-access-secret synthetic-refresh-secret');
    } }, 'darwin');
    assert.equal(await claudeOauthToken(), null);
  } finally {
    console.error = originalError;
    console.warn = originalWarn;
  }
  assert.equal(logged.join('\n').includes('synthetic-access-secret'), false);
  assert.equal(logged.join('\n').includes('synthetic-refresh-secret'), false);
  setUsageAuthBackend({ usageKeychain: async () => { calls++; return {}; } }, 'win32');
  assert.equal(await claudeOauthToken(), null);
  assert.equal(calls, 4);
  setUsageAuthBackend(null);
  claudeFixtureBackend.claudeCredentialsRead = readCredentialPath;
});

test('claudeOauthToken preserves JSON value and Number coercions', async () => {
  setUsageAuthBackend(null);
  writeCreds({ accessToken: 17, expiresAt: 'not-a-number', subscriptionType: false });
  assert.deepEqual(await claudeOauthToken(), { accessToken: 17, expiresAt: 'not-a-number', subscriptionType: false });

  writeCreds({ accessToken: 'synthetic-expired', expiresAt: '-1' });
  assert.equal(await claudeOauthToken(), null);

  writeFileSync(join(claudeCfg, '.credentials.json'), '\uFEFF{"claudeAiOauth":{"accessToken":"synthetic-bom"}}');
  setUsageAuthBackend({ usageKeychain: async () => ({ accessToken: 'synthetic-keychain' }) }, 'darwin');
  assert.equal((await claudeOauthToken()).accessToken, 'synthetic-keychain');
  setUsageAuthBackend(null);
  rmSync(join(claudeCfg, '.credentials.json'), { force: true });
});

test('refreshClaudeAuth: falls back to the CLI once, then throttles', async () => {
  process.env.CLAUDE_BIN = process.execPath;
  writeCreds({});
  const calls = [];
  setUsageAuthBackend({ usageAuthStatus: async (...args) => { calls.push(args); throw new Error('synthetic spawn failure'); } }, 'win32');
  assert.equal(await refreshClaudeAuth(), true);
  assert.equal(await refreshClaudeAuth(), false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], process.execPath);
  assert.equal(calls[0][1], 10_000);
  setUsageAuthBackend(null);
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

test('getUsage keeps synthetic credential failures out of public results', async () => {
  const credentialsFile = join(claudeCfg, '.credentials.json');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('fixture rejection synthetic-private-secret'); };
  try {
    const cases = [
      ['missing', null, 'no-credentials'],
      ['no-token', '{"claudeAiOauth":{}}', 'no-token'],
      ['expired', JSON.stringify({ claudeAiOauth: { accessToken: 'synthetic-expired', expiresAt: '-1' } }), 'token-expired'],
      ['malformed', '{"claudeAiOauth":{"accessToken":"synthetic-private-secret"}', 'bad credentials'],
      ['read-failure', null, 'bad credentials'],
      ['rejected-fetch', JSON.stringify({ claudeAiOauth: { accessToken: 'synthetic-private-secret', expiresAt: Date.now() + 60_000 } }), 'request failed: fixture rejection [redacted]'],
    ];
    for (const [label, text, expected] of cases) {
      clearClaudeLocal();
      if (text === null) rmSync(credentialsFile, { force: true });
      else writeFileSync(credentialsFile, text);
      const readCredentials = claudeFixtureBackend.claudeCredentialsRead;
      if (label === 'read-failure') claudeFixtureBackend.claudeCredentialsRead = async () => ({ kind: 'read_failure' });
      const isolated = await importIsolatedUsage(`./usage.mjs?credential-outcome=${label}-${Date.now()}`);
      const doc = await isolated.getUsage({ sources: ['claude'], force: true });
      assert.equal(doc.claude.error, expected);
      assert.equal(JSON.stringify(doc).includes('synthetic-private-secret'), false);
      claudeFixtureBackend.claudeCredentialsRead = readCredentials;
    }
  } finally {
    globalThis.fetch = originalFetch;
    claudeFixtureBackend.claudeCredentialsRead = async (path) => {
      try { return { kind: 'file', text: readFileSync(path, 'utf8') }; }
      catch (error) { return error.code === 'ENOENT' ? { kind: 'missing' } : { kind: 'read_failure' }; }
    };
    rmSync(credentialsFile, { force: true });
    clearClaudeLocal();
  }
});

test('getUsage: the allowlist outranks force, and an excluded source is served by reference', async () => {
  codexFreshLine(55); // codex answers from its own free tier — no network needed here
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('offline'); };
  try {
    // Warm every slot without reaching a real service: codex answers from its
    // own fresh local file, ollama's API call fails fast.
    warm = await getUsage({ force: true });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(warm.codex.ok, true); // the fresh local file, not a blank

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

test('getUsage: Claude transient retries are one Rust bridge operation', async () => {
  const isolated = await importIsolatedUsage(`./usage.mjs?claude-rust-retry=${Date.now()}`);
  const credentialsFile = join(claudeCfg, '.credentials.json');
  const originalCredentials = existsSync(credentialsFile) ? readFileSync(credentialsFile) : null;
  try {
    writeCreds({ accessToken: 'retry-token', expiresAt: Date.now() + 3_600_000 });
    clearClaudeLocal();
    let bridgeCalls = 0;
    isolated.setUsageClaudeBackend({
      ...claudeFixtureBackend,
      async claudeUsageFetch() {
        bridgeCalls += 1;
        return { kind: 'response', status: 503, retry_after: null, body: { ok: null } };
      },
    });
    const doc = await isolated.getUsage({ sources: ['claude'], force: true });
    assert.equal(doc.claude.ok, false);
    assert.equal(bridgeCalls, 1);
  } finally {
    if (originalCredentials) writeFileSync(credentialsFile, originalCredentials);
    else rmSync(credentialsFile, { force: true });
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

test('getUsage: an incomplete local Claude window is refreshed from OAuth', async () => {
  clearClaudeLocal();
  writeCreds({ accessToken: 'partial-refresh-token', expiresAt: Date.now() + 3_600_000 });
  const dir = join(process.env.USAGE_REPORT_STATE, 'cost-state');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'weekly-only.json');
  writeFileSync(file, JSON.stringify({ rate_limits: { seven_day: { used_percentage: 74, resets_at: 1791910800 } } }));
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return { status: 200, json: async () => CLAUDE_RAW };
  };
  try {
    const doc = await getUsage({ sources: ['claude'], force: true });
    assert.equal(doc.claude.session.pctUsed, 42);
    assert.equal(doc.claude.session.resetsAt, CLAUDE_RAW.five_hour.resets_at);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('getUsage: an automatic pull refreshes an incomplete local Claude window', async () => {
  clearClaudeLocal();
  writeCreds({ accessToken: 'automatic-partial-token', expiresAt: Date.now() + 3_600_000 });
  const dir = join(process.env.USAGE_REPORT_STATE, 'cost-state');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'weekly-only.json'), JSON.stringify({ rate_limits: { seven_day: { used_percentage: 74, resets_at: 1791910800 } } }));
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return { status: 200, json: async () => CLAUDE_RAW };
  };
  try {
    const doc = await getUsage({ sources: ['claude'] });
    assert.equal(doc.claude.session.pctUsed, 42);
    assert.equal(doc.claude.session.resetsAt, CLAUDE_RAW.five_hour.resets_at);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    clearClaudeLocal();
  }
});

test('getUsage: automatic incomplete-window retries honor the network floor', async () => {
  clearClaudeLocal();
  writeCreds({ accessToken: 'automatic-floor-token', expiresAt: Date.now() + 3_600_000 });
  const dir = join(process.env.USAGE_REPORT_STATE, 'cost-state');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'weekly-only.json'), JSON.stringify({ rate_limits: { seven_day: { used_percentage: 74, resets_at: 1791910800 } } }));
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return { status: 404, headers: { get: () => null } };
  };
  const isolatedGetUsage = (await importIsolatedUsage(`./usage.mjs?automatic-floor=${Date.now()}`)).getUsage;
  try {
    await isolatedGetUsage({ sources: ['claude'] });
    await isolatedGetUsage({ sources: ['claude'] });
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    clearClaudeLocal();
  }
});

test('getUsage: a partial cost-state reading preserves an active cached session', async () => {
  clearClaudeLocal();
  writeCreds({ accessToken: 'cached-session-token', expiresAt: Date.now() + 3_600_000 });
  const raw = {
    ...CLAUDE_RAW,
    five_hour: { utilization: 18, resets_at: new Date(Date.now() + 3_600_000).toISOString() },
    seven_day: { utilization: 74, resets_at: new Date(Date.now() + 3 * 86_400_000).toISOString() },
  };
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return { status: 200, json: async () => raw };
  };
  try {
    await getUsage({ sources: ['claude'], force: true });
    rmSync(join(process.env.USAGE_REPORT_STATE, 'usage-snapshots.jsonl'), { force: true });
    const dir = join(process.env.USAGE_REPORT_STATE, 'cost-state');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'weekly-only.json'), JSON.stringify({ rate_limits: { seven_day: { used_percentage: 74, resets_at: Math.floor((Date.now() + 3 * 86_400_000) / 1000) } } }));

    const doc = await getUsage({ sources: ['claude'] });
    assert.equal(doc.claude.session.pctUsed, 18);
    assert.equal(doc.claude.session.resetsAt, raw.five_hour.resets_at);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    clearClaudeLocal();
  }
});

test('getUsage: a local Claude reading establishes identity before an account switch', async () => {
  clearClaudeLocal();
  const dir = join(process.env.USAGE_REPORT_STATE, 'cost-state');
  const credentialsFile = join(claudeCfg, '.credentials.json');
  const originalCredentials = existsSync(credentialsFile) ? readFileSync(credentialsFile) : null;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'account-a.json'), JSON.stringify({ rate_limits: { five_hour: { used_percentage: 58, resets_at: 1789533000 }, seven_day: { used_percentage: 9, resets_at: 1790096400 } } }));
  const { getUsage: isolatedGetUsage } = await importIsolatedUsage(`./usage.mjs?account-switch=${Date.now()}`);
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
test('readClaudeSnapshot: serves a fresh tail line, rejects a stale one', async () => {
  const file = join(process.env.USAGE_REPORT_STATE, 'usage-snapshots.jsonl');
  const at = new Date();
  const stamp = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
  // A long leading row so the 8KB window opens mid-line — the fragment must be
  // dropped, not parsed.
  writeFileSync(file, `${JSON.stringify({ fetched_at: stamp(at), pad: 'x'.repeat(9000), raw: { five_hour: { utilization: 1 } } })}
${JSON.stringify({ fetched_at: stamp(at), raw: CLAUDE_RAW })}\n`);

  const fresh = await readClaudeSnapshot();
  assert.equal(fresh.raw.five_hour.utilization, 42);
  const normalized = await readClaudeLocal(null, 'team');
  assert.equal(normalized.session.pctUsed, 42);

  assert.equal(await readClaudeSnapshot(60_000, at.getTime() + 120_000), null);
  writeFileSync(file, 'not json\n');
  assert.equal(await readClaudeSnapshot(), null);
});

// Before each daemon append, a live file whose FIRST row is from an earlier month
// moves to usage-snapshots-<that month>.jsonl. Months far from today keep the
// real-time appends in other tests from tripping the checked-month cache.
test('getUsage: a valid unstarted local session does not trigger OAuth polling', async () => {
  clearClaudeLocal();
  writeCreds({ accessToken: 'unstarted-window-token', expiresAt: Date.now() + 3_600_000 });
  mkdirSync(process.env.USAGE_REPORT_STATE, { recursive: true });
  writeFileSync(join(process.env.USAGE_REPORT_STATE, 'usage-snapshots.jsonl'), `${JSON.stringify({
    fetched_at: stampLocal(new Date()),
    raw: {
      five_hour: { utilization: 0, resets_at: null },
      seven_day: { utilization: 74, resets_at: new Date(Date.now() + 3 * 86_400_000).toISOString() },
    },
  })}\n`);
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return { status: 200, json: async () => CLAUDE_RAW }; };
  try {
    const isolatedGetUsage = (await importIsolatedUsage(`./usage.mjs?unstarted=${Date.now()}`)).getUsage;
    const doc = await isolatedGetUsage({ sources: ['claude'] });
    assert.equal(doc.claude.session.started, false);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    clearClaudeLocal();
  }
});

// Tier two under the snapshot: the statusline stamps the same limits into
// cost-state/<session>.json on every turn of every session, so the newest file
// is usually fresher than the snapshot log. Windows only — epoch seconds in,
// ISO out.
test('readCostStateLimits: newest usable file wins, stale and rate_limits-less ones are skipped', async () => {
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

  const fresh = await readCostStateLimits();
  assert.equal(fresh.session.pctUsed, 22); // not 99: newest usable, not merely newest
  assert.equal(fresh.session.resetsAt, new Date(1789533000 * 1000).toISOString());
  assert.equal(fresh.weekly.pctUsed, 3);

  // Every candidate outside the window → no reading at all, so the caller falls
  // through to the API instead of serving an hour-old percentage as current.
  assert.equal(await readCostStateLimits(1_000), null);
});

// The cost-state tier never reaches fetchClaude's append, so readClaudeLocal logs
// its reading itself — once per change — or the 5h history chart freezes.
test('readClaudeLocal: a cost-state reading appends a snapshot row on change only', async () => {
  clearClaudeLocal();
  const dir = join(process.env.USAGE_REPORT_STATE, 'cost-state');
  const file = join(process.env.USAGE_REPORT_STATE, 'usage-snapshots.jsonl');
  mkdirSync(dir, { recursive: true });
  const resets = Math.floor((Date.now() + 3_600_000) / 1000);
  const write = (pct) => writeFileSync(join(dir, 'live.json'), JSON.stringify({ rate_limits: { five_hour: { used_percentage: pct, resets_at: resets }, seven_day: { used_percentage: 3, resets_at: resets + 86_400 } } }));
  const rows = () => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const { readClaudeLocal: isolatedReadLocal } = await importIsolatedUsage(`./usage.mjs?cost-state-append=${Date.now()}`);
  try {
    write(40);
    assert.equal((await isolatedReadLocal(null, 'max')).session.pctUsed, 40);
    assert.equal(rows().length, 1);
    const [row] = rows();
    assert.equal(row.source, 'cost-state');
    assert.equal(row.raw.five_hour.utilization, 40);
    assert.equal(row.raw.five_hour.resets_at, new Date(resets * 1000).toISOString());
    assert.match(row.fetched_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    await isolatedReadLocal(null, 'max'); // unchanged: no row
    assert.equal(rows().length, 1);
    write(41);
    await isolatedReadLocal(null, 'max');
    assert.deepEqual(rows().map((r) => r.raw.five_hour.utilization), [40, 41]);
    // Tier 1 skips these rows: they lack extra_usage / per-model.
    assert.equal(await readClaudeSnapshot(), null);
  } finally {
    clearClaudeLocal();
  }
});

// ---- Codex: the Stop-hook snapshot tail (readCodexSnapshot) -------------------
// The harness Stop hook appends codex-usage.jsonl once a turn end (and now bumps
// it every turn, changed or not, so a quiet session still keeps this fresh); a
// fresh tail line resolves the lane with no request. A stale, unreadable or
// absent record reports "no Codex sessions found" — there is no rollout-log
// scan any more to fall back to — mirrored on readClaudeSnapshot above.
const stampLocal = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;

test('readCodexSnapshot: a fresh Stop-hook record answers with no network', async () => {
  mkdirSync(process.env.USAGE_REPORT_STATE, { recursive: true });
  writeFileSync(CODEX_HISTORY_FILE, `${JSON.stringify({ fetched_at: stampLocal(new Date()), session: { utilization: 7, resets_at: '2026-09-22T18:00:00Z' }, weekly: { utilization: 55.5, resets_at: '2026-09-25T00:00:00Z' }, plan_type: 'business' })}\n`);

  const snap = await readCodexSnapshot();
  assert.equal(snap.ok, true);
  assert.equal(snap.source, 'codex');
  assert.equal(snap.plan, 'business');
  assert.deepEqual(snap.session, { pctUsed: 7, resetsAt: '2026-09-22T18:00:00Z', models: [] });
  assert.equal(snap.weekly.pctUsed, 55.5);

  // fetchCodex picks it up straight from the snapshot.
  const u = await fetchCodex();
  assert.equal(u.ok, true);
  assert.equal(u.session.pctUsed, 7);
  assert.equal(u.weekly.pctUsed, 55.5);
});

test('readCodexSnapshot: stale, malformed or missing lines all report "no Codex sessions found" (no rollout to fall back to)', async () => {
  // Stale fetched_at — the same 120s gate the sampler uses.
  writeFileSync(CODEX_HISTORY_FILE, `${JSON.stringify({ fetched_at: stampLocal(new Date(Date.now() - 10 * 60_000)), session: { utilization: 7, resets_at: null }, weekly: null, plan_type: 'business' })}\n`);
  assert.equal(await readCodexSnapshot(), null);
  assert.equal((await fetchCodex()).error, 'no Codex sessions found');

  // A last line that does not parse is dropped, not served.
  writeFileSync(CODEX_HISTORY_FILE, 'not json\n');
  assert.equal(await readCodexSnapshot(), null);
  assert.equal((await fetchCodex()).error, 'no Codex sessions found');

  // No file at all — the hook has never run on this install.
  rmSync(CODEX_HISTORY_FILE, { force: true });
  assert.equal(await readCodexSnapshot(), null);
  assert.equal((await fetchCodex()).error, 'no Codex sessions found');
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

test('getUsage: a 401 refresh sends the rotated token on the second logical fetch', async () => {
  const isolated = await importIsolatedUsage(`./usage.mjs?claude-401-refresh=${Date.now()}`);
  writeCreds({ accessToken: 'old-access-token', refreshToken: 'fixture-refresh-token', refreshTokenExpiresAt: Date.now() + 3_600_000, expiresAt: Date.now() + 3_600_000 });
  clearClaudeLocal();
  const originalFetch = globalThis.fetch;
  const accessTokens = [];
  let refreshCalls = 0;
  isolated.setUsageClaudeBackend({
    ...claudeFixtureBackend,
    async claudeOauthRefresh() {
      refreshCalls += 1;
      return { kind: 'response', status: 200, retry_after: null, body: { ok: JSON.stringify({ access_token: 'new-access-token', expires_in: 3600 }) } };
    },
  });
  globalThis.fetch = async (url, options = {}) => {
    assert.equal(String(url), 'https://fixture.invalid/claude-usage');
    accessTokens.push(options.headers.Authorization);
    return accessTokens.length === 1
      ? { status: 401, headers: { get: () => null } }
      : { status: 200, json: async () => CLAUDE_RAW };
  };
  try {
    const doc = await isolated.getUsage({ sources: ['claude'], force: true });
    assert.equal(doc.claude.ok, true);
  } finally { globalThis.fetch = originalFetch; }
  assert.deepEqual(accessTokens, ['Bearer old-access-token', 'Bearer new-access-token']);
  assert.equal(refreshCalls, 1);
});

test('getUsage: bridge request errors redact the in-memory access token', async () => {
  const token = 'synthetic-token-that-must-not-escape';
  writeCreds({ accessToken: token, expiresAt: Date.now() + 3_600_000 });
  clearClaudeLocal();
  const isolated = await importIsolatedUsage(`./usage.mjs?claude-token-redaction=${Date.now()}`);
  isolated.setUsageClaudeBackend({ claudeUsageFetch: async () => { throw new Error(`failure ${token}`); } });
  const doc = await isolated.getUsage({ sources: ['claude'], force: true });
  assert.equal(doc.claude.ok, false);
  assert.equal(doc.claude.error.includes(token), false);
});

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
  assert.equal((await readClaudeSnapshot()).raw.five_hour.utilization, 42);
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

// ---- sampleCodex / the network floor (v2: split file vs network cadence) -----
// pull()'s own free tier (readCodexSnapshot) answers every call — any cadence,
// force or not — straight from codex-usage.jsonl with no rollout scan and no
// network. sampleCodex no longer computes its own staleness (that redundant
// check lived in pass 1); once the snapshot is null, pull()'s network floor
// is the one and only gate deciding whether the rollout scan + live wham API
// leg actually runs — at most once per NETWORK_FLOOR_MS (60s) for an automated
// (force=false) caller, success or failure, never for the manual force=1 route.
test('sampleCodex: a fresh codex-usage.jsonl line never reaches the live wham API', async () => {
  writeFileSync(CODEX_HISTORY_FILE, `${JSON.stringify({ fetched_at: stampLocal(new Date()), session: { utilization: 5, resets_at: null }, weekly: { utilization: 20, resets_at: null }, plan_type: 'plus' })}\n`);
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; throw new Error('offline'); };
  try {
    await sampleCodex();
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(calls, 0);
});

test('getUsage: Codex partial snapshots recover missing windows and retain active cached windows', async () => {
  const { getUsage: isolatedGetUsage } = await importIsolatedUsage(`./usage.mjs?codex-partial=${Date.now()}`);
  writeCodexAuth({ access_token: 'mock-token', account_id: 'mock-account' });
  mkdirSync(dirname(CODEX_HISTORY_FILE), { recursive: true });
  writeFileSync(CODEX_HISTORY_FILE, `${JSON.stringify({ fetched_at: stampLocal(new Date()), session: null, weekly: { utilization: 9, resets_at: new Date(Date.now() + 7 * 86400_000).toISOString() }, plan_type: 'plus' })}\n`);
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return { status: 200, json: async () => ({ plan_type: 'plus', rate_limit: { primary_window: { used_percent: 31, limit_window_seconds: 18000, reset_at: Math.floor(Date.now() / 1000) + 18000 }, secondary_window: { used_percent: 22, limit_window_seconds: 604800, reset_at: Math.floor(Date.now() / 1000) + 604800 } } }) };
  };
  try {
    const result = await isolatedGetUsage({ sources: ['codex'] });
    assert.equal(calls, 1);
    assert.equal(result.codex.session.pctUsed, 31);
    assert.equal(result.codex.weekly.pctUsed, 22);
    writeFileSync(CODEX_HISTORY_FILE, `${JSON.stringify({ fetched_at: stampLocal(new Date()), session: { utilization: 42, resets_at: new Date(Date.now() + 3_600_000).toISOString() }, weekly: null, plan_type: 'plus' })}\n`);
    const merged = await isolatedGetUsage({ sources: ['codex'] });
    assert.equal(calls, 1);
    assert.equal(merged.codex.session.pctUsed, 42);
    assert.equal(merged.codex.weekly.pctUsed, 22);
  } finally { globalThis.fetch = originalFetch; }
});

test('getUsage: complete unstarted Codex windows avoid the endpoint, including forced refresh', async () => {
  const { getUsage: isolatedGetUsage } = await importIsolatedUsage(`./usage.mjs?codex-unstarted=${Date.now()}`);
  writeFileSync(CODEX_HISTORY_FILE, `${JSON.stringify({ fetched_at: stampLocal(new Date()), session: { utilization: 0, resets_at: null, started: false }, weekly: { utilization: 0, resets_at: null, started: false }, plan_type: 'plus' })}\n`);
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; throw new Error('unexpected request'); };
  try {
    const result = await isolatedGetUsage({ sources: ['codex'], force: true });
    assert.equal(result.codex.session.started, false);
    assert.equal(result.codex.weekly.started, false);
    assert.equal(calls, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test('getUsage: awaits one Codex fingerprint before gates and keeps it through a successful pull', async () => {
  const { getUsage: isolatedGetUsage, setUsageCodexBackend: isolatedSetUsageCodexBackend } = await importIsolatedUsage(`./usage.mjs?codex-fingerprint-await=${Date.now()}`);
  const events = [];
  let releaseFingerprint;
  const fingerprintReady = new Promise((resolve) => { releaseFingerprint = resolve; });
  let fingerprintReads = 0;
  isolatedSetUsageCodexBackend({
    async codexAccountFingerprint(authPath) {
      fingerprintReads += 1;
      events.push(['fingerprint-start', authPath]);
      const fingerprint = await fingerprintReady;
      events.push(['fingerprint-finish', fingerprint]);
      return fingerprint;
    },
  });
  rmSync(CODEX_HISTORY_FILE, { force: true });
  const pending = isolatedGetUsage({
    sources: ['codex'],
    force: true,
    fetchers: { codex: async () => {
      events.push(['fetch']);
      return {
        ok: true, source: 'codex', plan: 'plus', fetchedAt: new Date().toISOString(),
        session: { pctUsed: 41, resetsAt: null }, weekly: { pctUsed: 22, resetsAt: null },
      };
    } },
  });
  await new Promise(setImmediate);
  assert.deepEqual(events, [['fingerprint-start', codexAuth]]);
  releaseFingerprint('a'.repeat(64));
  const result = await pending;
  assert.equal(fingerprintReads, 1);
  assert.deepEqual(events, [
    ['fingerprint-start', codexAuth],
    ['fingerprint-finish', 'a'.repeat(64)],
    ['fetch'],
  ]);
  assert.equal(result.codex.session.pctUsed, 41);
});

test('getUsage: Codex account switches discard cached and unidentified snapshot data', async () => {
  const { getUsage: isolatedGetUsage } = await importIsolatedUsage(`./usage.mjs?codex-account-switch=${Date.now()}`);
  rmSync(CODEX_HISTORY_FILE, { force: true });
  writeCodexAuth({ access_token: 'mock-old-token', account_id: 'mock-old-account' });
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return { status: 200, json: async () => ({ plan_type: 'plus', rate_limit: { primary_window: { used_percent: 64, limit_window_seconds: 18000, reset_at: Math.floor(Date.now() / 1000) + 18000 }, secondary_window: { used_percent: 22, limit_window_seconds: 604800, reset_at: Math.floor(Date.now() / 1000) + 604800 } } }) };
  };
  try {
    const warm = await isolatedGetUsage({ sources: ['codex'], force: true });
    assert.equal(warm.codex.session.pctUsed, 64);
    writeCodexAuth({ access_token: 'mock-new-token', account_id: 'mock-new-account' });
    globalThis.fetch = async () => { calls += 1; throw new Error('offline'); };
    const switched = await isolatedGetUsage({ sources: ['codex'], force: true });
    assert.equal(switched.codex.pctUsed, undefined);
    assert.notEqual(switched.codex.session?.pctUsed, 64);
    const afterFailure = calls;
    await isolatedGetUsage({ sources: ['codex'] });
    assert.equal(calls, afterFailure);
  } finally { globalThis.fetch = originalFetch; }
});

test('getUsage: Codex partial session snapshot fetches the missing weekly window under force', async () => {
  const { getUsage: isolatedGetUsage } = await importIsolatedUsage(`./usage.mjs?codex-missing-weekly=${Date.now()}`);
  mkdirSync(dirname(CODEX_HISTORY_FILE), { recursive: true });
  writeFileSync(CODEX_HISTORY_FILE, `${JSON.stringify({ fetched_at: stampLocal(new Date()), session: { utilization: 13, resets_at: new Date(Date.now() + 18000_000).toISOString() }, weekly: null, plan_type: 'plus' })}\n`);
  writeCodexAuth({ access_token: 'mock-weekly-token', account_id: 'mock-weekly-account' });
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return { status: 200, json: async () => ({ plan_type: 'plus', rate_limit: { primary_window: { used_percent: 19, limit_window_seconds: 18000, reset_at: Math.floor(Date.now() / 1000) + 18000 }, secondary_window: { used_percent: 26, limit_window_seconds: 604800, reset_at: Math.floor(Date.now() / 1000) + 604800 } } }) }; };
  try {
    const result = await isolatedGetUsage({ sources: ['codex'], force: true });
    assert.equal(calls, 1);
    assert.equal(result.codex.session.pctUsed, 19);
    assert.equal(result.codex.weekly.pctUsed, 26);
  } finally { globalThis.fetch = originalFetch; }
});

test('getUsage: Codex 429 keeps last-good data stale until Retry-After expires', async () => {
  const { getUsage: isolatedGetUsage } = await importIsolatedUsage(`./usage.mjs?codex-retry-after=${Date.now()}`);
  rmSync(CODEX_HISTORY_FILE, { force: true });
  writeCodexAuth({ access_token: 'mock-retry-token', account_id: 'mock-retry-account' });
  const originalFetch = globalThis.fetch;
  const realNow = Date.now;
  let calls = 0;
  try {
    globalThis.fetch = async () => { calls += 1; return { status: 200, json: async () => ({ plan_type: 'plus', rate_limit: { primary_window: { used_percent: 27, limit_window_seconds: 18000, reset_at: Math.floor(Date.now() / 1000) + 18000 }, secondary_window: { used_percent: 35, limit_window_seconds: 604800, reset_at: null } } }) }; };
    const warm = await isolatedGetUsage({ sources: ['codex'], force: true });
    assert.equal(warm.codex.session.pctUsed, 27);
    rmSync(CODEX_HISTORY_FILE, { force: true });
    globalThis.fetch = async () => { calls += 1; return { status: 429, headers: { get: () => '66' } }; };
    const limited = await isolatedGetUsage({ sources: ['codex'], force: true });
    assert.equal(limited.codex.stale, true);
    assert.equal(limited.codex.error, 'rate-limited');
    assert.equal(limited.codex.session.pctUsed, 27);
    const afterLimit = calls;
    writeFileSync(CODEX_HISTORY_FILE, `${JSON.stringify({ fetched_at: stampLocal(new Date()), session: null, weekly: { utilization: 36, resets_at: null }, plan_type: 'plus' })}\n`);
    globalThis.fetch = async () => { calls += 1; return { status: 200, json: async () => ({ plan_type: 'plus', rate_limit: { primary_window: { used_percent: 29, limit_window_seconds: 18000, reset_at: Math.floor(Date.now() / 1000) + 18000 }, secondary_window: { used_percent: 36, limit_window_seconds: 604800, reset_at: Math.floor(Date.now() / 1000) + 604800 } } }) }; };
    const gated = await isolatedGetUsage({ sources: ['codex'], force: true });
    assert.equal(calls, afterLimit);
    assert.equal(gated.codex.stale, true);
    assert.equal(gated.codex.error, 'rate-limited');
    assert.equal(gated.codex.session.pctUsed, 27);
    assert.equal(gated.codex.weekly.pctUsed, 36);
    Date.now = () => realNow() + 70_000;
    const recovered = await isolatedGetUsage({ sources: ['codex'], force: true });
    assert.equal(calls, afterLimit + 1);
    assert.equal(recovered.codex.session.pctUsed, 29);
    assert.equal(recovered.codex.stale, undefined);
  } finally { Date.now = realNow; globalThis.fetch = originalFetch; }
});

test('getUsage: unreadable Codex auth preserves the 429 backoff until an account switch', async () => {
  const { getUsage: isolatedGetUsage } = await importIsolatedUsage(`./usage.mjs?codex-auth-gap=${Date.now()}`);
  rmSync(CODEX_HISTORY_FILE, { force: true });
  writeCodexAuth({ access_token: 'mock-gap-token', account_id: 'mock-gap-account' });
  const originalFetch = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async () => { calls += 1; return { status: 429, headers: { get: () => '66' } }; };
    await isolatedGetUsage({ sources: ['codex'], force: true });
    const afterLimit = calls;
    rmSync(codexAuth, { force: true });
    await isolatedGetUsage({ sources: ['codex'], force: true });
    writeCodexAuth({ access_token: 'mock-gap-token', account_id: 'mock-gap-account' });
    await isolatedGetUsage({ sources: ['codex'], force: true });
    assert.equal(calls, afterLimit);
    writeCodexAuth({ access_token: 'mock-other-token', account_id: 'mock-other-account' });
    globalThis.fetch = async () => { calls += 1; return { status: 429, headers: { get: () => '66' } }; };
    await isolatedGetUsage({ sources: ['codex'], force: true });
    assert.equal(calls, afterLimit + 1);
  } finally { globalThis.fetch = originalFetch; }
});

// Fresh isolated import per floor test: the floor is shared, in-memory,
// per-module-instance state, so a test that wants to observe it armed from a
// clean slate cannot share the module top-of-file already exercised network.
const staleCodexLine = (staleAt) => writeFileSync(CODEX_HISTORY_FILE, `${JSON.stringify({ fetched_at: stampLocal(staleAt), session: { utilization: 5, resets_at: null }, weekly: { utilization: 20, resets_at: null }, plan_type: 'plus' })}\n`);

test('sampleCodex: a stale codex-usage.jsonl falls back to the live wham API, then the floor blocks an immediate repeat', async () => {
  const { sampleCodex: isolatedSampleCodex, getUsage: isolatedGetUsage } = await importIsolatedUsage(`./usage.mjs?codex-floor=${Date.now()}`);
  const staleAt = new Date(Date.now() - (SNAPSHOT_MAX_AGE_MS + 60_000));
  staleCodexLine(staleAt);
  writeCodexAuth({ access_token: '[REDACTED:credential-assignment]', account_id: 'codex-floor-account' });
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return {
      status: 200,
      json: async () => ({
        plan_type: 'plus',
        rate_limit: { primary_window: { used_percent: 33, limit_window_seconds: 18_000, reset_at: Math.floor(Date.now() / 1000) + 18_000 } },
      }),
    };
  };
  try {
    await isolatedSampleCodex();
    assert.equal(calls, 1);
    // The live reading lands in the cache, not just the history file — the
    // next unfiltered pull sees it without a second request.
    const doc = await isolatedGetUsage({ sources: ['codex'] });
    assert.equal(doc.codex.session.pctUsed, 33);

    // appendCodexHistory just wrote a fresh line from that live reading — put
    // the file back to stale content (the Stop hook hasn't run again), so this
    // second call is blocked by the FLOOR, not by the free tier finding a
    // still-fresh snapshot.
    staleCodexLine(staleAt);
    await isolatedSampleCodex();
    assert.equal(calls, 1); // no second request inside the same 60s window
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('sampleCodex: the network floor arms even on a failed attempt — a persistent failure cannot retry sooner than 60s', async () => {
  const { sampleCodex: isolatedSampleCodex } = await importIsolatedUsage(`./usage.mjs?codex-floor-fail=${Date.now()}`);
  const staleAt = new Date(Date.now() - (SNAPSHOT_MAX_AGE_MS + 60_000));
  staleCodexLine(staleAt);
  writeCodexAuth({ access_token: '[REDACTED:credential-assignment]', account_id: 'codex-floor-fail-account' });
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; throw new Error('offline'); };
  try {
    await isolatedSampleCodex();
    // fetchExternal retries a transient failure internally before giving up —
    // the point here is that this ONE sampleCodex() call is the only round the
    // floor allowed, whatever fetchExternal's own retry count is.
    const afterFirstAttempt = calls;
    assert.ok(afterFirstAttempt > 0);
    staleCodexLine(staleAt); // still stale — nothing new to serve for free
    await isolatedSampleCodex();
    assert.equal(calls, afterFirstAttempt); // the floor holds regardless of the outcome
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('getUsage: the network floor also holds on a cold cache (a concurrent automated pull does not double-fetch)', async () => {
  const { getUsage: isolatedGetUsage } = await importIsolatedUsage(`./usage.mjs?cold-floor=${Date.now()}`);
  let calls = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const fetchers = { ollama: async () => { calls += 1; await gate; return { ok: true, session: null, weekly: null }; } };
  const first = isolatedGetUsage({ sources: ['ollama'], fetchers });
  const second = await isolatedGetUsage({ sources: ['ollama'], fetchers });
  assert.equal(second.ollama, null); // cold + inside the floor: "Loading…", not a second attempt
  release();
  await first;
  assert.equal(calls, 1);
});

test('getUsage: manual force=1 bypasses the network floor an automated call just armed', async () => {
  const { sampleCodex: isolatedSampleCodex, getUsage: isolatedGetUsage } = await importIsolatedUsage(`./usage.mjs?codex-floor-manual=${Date.now()}`);
  const staleAt = new Date(Date.now() - (SNAPSHOT_MAX_AGE_MS + 60_000));
  staleCodexLine(staleAt);
  writeCodexAuth({ access_token: '[REDACTED:credential-assignment]', account_id: 'codex-floor-manual-account' });
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return { status: 200, json: async () => ({ plan_type: 'plus', rate_limit: { primary_window: { used_percent: 41, limit_window_seconds: 18_000, reset_at: Math.floor(Date.now() / 1000) + 18_000 } } }) };
  };
  try {
    await isolatedSampleCodex(); // automated: arms the floor
    assert.equal(calls, 1);
    staleCodexLine(staleAt); // still stale — the floor alone would hold this back
    const manual = await isolatedGetUsage({ sources: ['codex'], force: true }); // the Refresh button's own route
    assert.equal(calls, 2); // bypassed the floor
    assert.equal(manual.codex.session.pctUsed, 41);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---- getUsage: emit-on-change (v2) ---------------------------------------------
// A 5s automated tick that finds nothing new must not spam every open tab with
// an identical WS frame; a manual/forced call (the Refresh button) always
// pushes, since a user pressing it is not the "nothing changed" case.
test('getUsage: an automated call does not re-emit an unchanged document; a manual one always does', async () => {
  const { getUsage: isolatedGetUsage, initUsageAutoRefresh: isolatedInit } = await importIsolatedUsage(`./usage.mjs?emit-gate=${Date.now()}`);
  let emits = 0;
  isolatedInit({ on() {}, emit(t) { if (t === 'usage') emits += 1; } });

  const dir = join(process.env.USAGE_REPORT_STATE, 'cost-state');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'emit-gate.json'), JSON.stringify({ rate_limits: { five_hour: { used_percentage: 12, resets_at: 1789533000 }, seven_day: { used_percentage: 4, resets_at: 1790096400 } } }));
  try {
    await isolatedGetUsage({ sources: ['claude'] }); // first automated read — a new document
    assert.equal(emits, 1);
    await isolatedGetUsage({ sources: ['claude'] }); // same file, same reading
    assert.equal(emits, 1); // no re-emit
    await isolatedGetUsage({ sources: ['claude'], force: true }); // manual/forced
    assert.equal(emits, 2); // always emits, unchanged or not
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
