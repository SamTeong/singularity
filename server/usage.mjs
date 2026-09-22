// Usage backend: pull the 5h/7d limits for three providers and normalize them to
// one shape. Files first — the network is only for demand:
//  - claude/anthropic: the global statusline writes the whole OAuth payload to
//    usage-snapshots.jsonl once a turn and stamps cost-state/<session>.json on
//    every turn of every session, so the OAuth usage API is read only on ?force=1
//    or when neither local tier is fresh (that endpoint allows roughly one call a
//    minute per account, and the statusline already spends it).
//  - ollama: authenticated Playwright scrape of ollama.com/settings.
//  - codex/openai: the Stop hook's codex-usage.jsonl tail when fresh, then a
//    bounded rollout-log scan; live wham/usage only on ?force=1.
// The daemon is one long-lived process, so a small in-memory cache per source is
// enough — no cross-session file needed.
// SECURITY: reads full account credentials (browser profile / OAuth token) but NEVER returns
// them to the client — only derived %/reset/plan leave this module.
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, appendFileSync, readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { STATE_DIR, CACHE_DIR, USAGE_SKILL_STATE } from './app-dir.mjs';
import { fetchExternal, retryAfterMs } from './external-fetch.mjs';

const OLLAMA_CFG = join(STATE_DIR, 'ollama.json');
export const OLLAMA_PROFILE_DIR = join(CACHE_DIR, 'pw-ollama-profile');
const OLLAMA_SETTINGS_URL = 'https://ollama.com/settings';
export const PW_STEALTH = {
  channel: 'msedge',
  args: ['--disable-blink-features=AutomationControlled'],
  ignoreDefaultArgs: ['--enable-automation'],
};
export async function pwHideWebdriver(ctx) {
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
}
// CLAUDE_CONFIG_DIR is Claude Code's own override for ~/.claude — honour it so
// the refresh below reads and rewrites the same file the CLI does (and so tests
// can point at a scratch dir instead of the real credentials).
const CREDENTIALS_PATH = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), '.credentials.json');
const USAGE_API_URL = 'https://api.anthropic.com/api/oauth/usage';
const USAGE_API_BETA = 'oauth-2025-04-20'; // schema ref: stats.mjs L34
const TTL = 60_000;
const REQ_TIMEOUT_MS = 10_000;

// ---- Ollama: authoritative settings-page scrape -----------------------------
export function parseOllamaHtml(html) {
  const plan = html.match(/capitalize"\s*>\s*([A-Za-z][\w-]*)\s*</)?.[1] ?? null;
  const meters = [...html.matchAll(/aria-label="(Session|Weekly) usage ([\d.]+)% used"/g)];
  if (meters.length < 2) return null;
  const times = [...html.matchAll(/data-time="([^"]+)"/g)].map((m) => m[1]);
  const windowAt = (i) => {
    const start = meters[i].index;
    const end = i + 1 < meters.length ? meters[i + 1].index : html.length;
    const models = [...html.slice(start, end).matchAll(/data-model="([^"]+)"[\s\S]*?data-requests="(\d+)"/g)]
      .map((m) => ({ model: m[1], requests: Number(m[2]) }));
    return { pctUsed: parseFloat(meters[i][2]), resetsAt: times[i] ?? null, models };
  };
  return { ok: true, source: 'ollama', plan, session: windowAt(0), weekly: windowAt(1), extra: null };
}

// ---- Ollama usage history (feeds the harness-usage-report skill) ----------
// Every successful ollama read is appended as one snapshot in the report skill's
// own record shape ({fetched_at, session, weekly, plan, models}) — a hard contract
// with that skill's stats.mjs, which already knows how to chart/forecast records
// shaped this way, so the daemon just has to write them in the right shape and no
// new maths lives here. `models` is the weekly window's per-model requests (from
// the API, when it reports any). fetched_at is LOCAL time (the skill parses it as
// local), zero-padded YYYY-MM-DD HH:MM:SS, no timezone suffix.
// ponytail: the file only ever grows (~10KB/day at 48 samples/day) — fine at
// this scale; trim-to-last-N is the upgrade path if it ever matters.
const OLLAMA_HISTORY = join(USAGE_SKILL_STATE, 'ollama-usage.jsonl');

// Last row actually written, so a duplicate reading (idle-debounce refreshes hit
// this often) doesn't spam the file. Simplest seed: null at daemon start, so the
// first successful append after a restart always writes — even if it matches the
// prior process's last line — rather than paying for a read-last-line probe.
let lastOllamaReading = null;

function pad2(n) { return String(n).padStart(2, '0'); }
function localTimestamp(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

export function appendOllamaHistory(data) {
  const reading = {
    sessionUtil: data.session?.pctUsed ?? null, sessionResets: data.session?.resetsAt ?? null,
    weeklyUtil: data.weekly?.pctUsed ?? null, weeklyResets: data.weekly?.resetsAt ?? null,
  };
  if (lastOllamaReading
    && reading.sessionUtil === lastOllamaReading.sessionUtil && reading.sessionResets === lastOllamaReading.sessionResets
    && reading.weeklyUtil === lastOllamaReading.weeklyUtil && reading.weeklyResets === lastOllamaReading.weeklyResets) return;
  lastOllamaReading = reading;
  const record = {
    fetched_at: localTimestamp(new Date()),
    session: data.session ? { utilization: data.session.pctUsed, resets_at: data.session.resetsAt } : null,
    weekly: data.weekly ? { utilization: data.weekly.pctUsed, resets_at: data.weekly.resetsAt } : null,
    plan: data.plan ?? null,
    models: data.weekly?.models ?? [],
  };
  appendJsonl(OLLAMA_HISTORY, record);
}

function appendJsonl(file, record) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  } catch {} // best-effort, never break /usage
}

// ---- Codex usage history (same skill contract as the ollama history above) ----
// Every successful Codex read (rollout scan, or the on-demand live wham/usage) is
// appended as one snapshot in the report skill's codex-usage.jsonl shape
// ({fetched_at, session, weekly, plan}) — session = 5h window, weekly = 7d. No
// `models` key (Codex exposes no per-model split). The skill's own rollout
// ingestion also appends this file; both writers dedupe against their last
// reading, and a zero-delta duplicate line is harmless to the estimators.
const CODEX_HISTORY = join(USAGE_SKILL_STATE, 'codex-usage.jsonl');
let lastCodexReading = null;

export function appendCodexHistory(data) {
  const reading = JSON.stringify([
    data.session?.pctUsed ?? null, data.session?.resetsAt ?? null,
    data.weekly?.pctUsed ?? null, data.weekly?.resetsAt ?? null,
  ]);
  if (reading === lastCodexReading) return;
  lastCodexReading = reading;
  appendJsonl(CODEX_HISTORY, {
    fetched_at: localTimestamp(new Date()),
    session: data.session ? { utilization: data.session.pctUsed, resets_at: data.session.resetsAt } : null,
    weekly: data.weekly ? { utilization: data.weekly.pctUsed, resets_at: data.weekly.resetsAt } : null,
    plan: data.plan ?? null,
  });
}

// The global statusline writes this same file once a turn, from the same
// endpoint — which is also why the daemon used to keep getting 429s:
// api.anthropic.com's oauth/usage allows roughly one call a minute per account,
// and the statusline already spends it. So read the newest line before reaching
// for the network; a fresh one is the same payload for free. Tail-read a fixed
// window rather than the whole file: this log is megabytes and append-only.
const CLAUDE_HISTORY = join(USAGE_SKILL_STATE, 'usage-snapshots.jsonl');
const SNAPSHOT_TAIL_BYTES = 8192;
export const SNAPSHOT_MAX_AGE_MS = 2 * TTL; // one missed ~60s statusline tick
// How old a local reading may be before it is worse than nothing. Capped at the
// 5h window because past that the session meter describes a window that has
// already rolled over; anything inside it is served marked stale.
export const CLAUDE_STALE_MAX_MS = 5 * 3.6e6;

export function readClaudeSnapshot(maxAgeMs = SNAPSHOT_MAX_AGE_MS, now = Date.now()) {
  let fd;
  try {
    fd = openSync(CLAUDE_HISTORY, 'r');
    const size = statSync(CLAUDE_HISTORY).size;
    const len = Math.min(size, SNAPSHOT_TAIL_BYTES);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    // Only the last complete line matters; a leading fragment from a mid-line
    // window start is never read.
    const lines = buf.toString('utf8').split('\n').filter(Boolean);
    const record = JSON.parse(lines[lines.length - 1]);
    // localTimestamp's 'YYYY-MM-DD HH:MM:SS' has no zone — parsed as local, which
    // is what wrote it.
    const at = Date.parse(record.fetched_at);
    if (!record.raw || Number.isNaN(at) || now - at > maxAgeMs) return null;
    return { raw: record.raw, fetchedAt: new Date(at).toISOString() };
  } catch { return null; } finally { if (fd !== undefined) closeSync(fd); }
}

// Codex's parallel: the harness Stop hook appends codex-usage.jsonl once a turn
// end (appendCodexHistory writes daemon-sourced reads to the same file), so a
// fresh tail line resolves the lane with no rollout scan at all. Same fixed
// tail window, same 120s freshness gate (SNAPSHOT_MAX_AGE_MS).
export function readCodexSnapshot(maxAgeMs = SNAPSHOT_MAX_AGE_MS, now = Date.now()) {
  let fd;
  try {
    fd = openSync(CODEX_HISTORY, 'r');
    const size = statSync(CODEX_HISTORY).size;
    const len = Math.min(size, SNAPSHOT_TAIL_BYTES);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n').filter(Boolean);
    const record = JSON.parse(lines[lines.length - 1]);
    const at = Date.parse(record.fetched_at);
    if (Number.isNaN(at) || now - at > maxAgeMs) return null;
    const win = (w) => (Number.isFinite(w?.utilization)
      ? { pctUsed: w.utilization, resetsAt: w.resets_at ?? null, models: [] }
      : null);
    const session = win(record.session);
    const weekly = win(record.weekly);
    if (!session && !weekly) return null;
    // The Stop hook writes plan_type (the API's own field name); the daemon's
    // appendCodexHistory writes the normalized payload with `plan`.
    return {
      ok: true, source: 'codex', plan: record.plan_type ?? record.plan ?? null,
      fetchedAt: new Date(at).toISOString(), session, weekly,
    };
  } catch { return null; } finally { if (fd !== undefined) closeSync(fd); }
}

// Second free source, denser than the snapshot log: the statusline writes
// cost-state/<session_id>.json on every turn of every session — foreground and
// task/background alike — and Claude Code hands it the same 5h/7d rate limits.
// Newest file wins (a session that hasn't taken a turn has no rate_limits and is
// skipped). Windows only: plan still comes from the credentials file, and
// extra_usage / per-model carry from the last good reading in fetchClaude.
const COST_STATE_DIR = join(USAGE_SKILL_STATE, 'cost-state');

export function readCostStateLimits(maxAgeMs = SNAPSHOT_MAX_AGE_MS, now = Date.now()) {
  let candidates;
  try {
    candidates = readdirSync(COST_STATE_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        const file = join(COST_STATE_DIR, f);
        try { return [file, statSync(file).mtimeMs]; } catch { return [file, 0]; }
      })
      .filter(([, at]) => now - at <= maxAgeMs)
      .sort((a, b) => b[1] - a[1]);
  } catch { return null; }
  const win = (w) => (Number.isFinite(w?.used_percentage)
    ? {
        pctUsed: w.used_percentage,
        // epoch seconds here, ISO everywhere else in this module
        resetsAt: Number.isFinite(w.resets_at) ? new Date(w.resets_at * 1000).toISOString() : null,
        models: [],
      }
    : null);
  for (const [file, at] of candidates) {
    try {
      const rl = JSON.parse(readFileSync(file, 'utf8')).rate_limits;
      const session = win(rl?.five_hour);
      const weekly = win(rl?.seven_day);
      if (session || weekly) return { session, weekly, fetchedAt: new Date(at).toISOString() };
    } catch { /* unreadable or caught mid-write: fall through to the next newest */ }
  }
  return null;
}

// ---- Ollama: authenticated persistent-browser scrape --------------------------
let ollamaProfileTail = Promise.resolve();
function ownOllamaProfile(work) {
  const run = ollamaProfileTail.catch(() => {}).then(work);
  ollamaProfileTail = run.catch(() => {});
  return run;
}

export function classifyOllamaPage({ url = '', html = '' } = {}) {
  if (/\/signin|\/login/i.test(url) || /sign in|log in to ollama/i.test(html)) return 'auth-expired';
  if (/turnstile|verify (you are )?human|checking your browser|challenge/i.test(html)) return 'challenge-required';
  return 'scrape-incompatible';
}

export async function scrapeOllamaOnce(pw, headless) {
  let ctx;
  try {
    ctx = await pw.chromium.launchPersistentContext(OLLAMA_PROFILE_DIR, { ...PW_STEALTH, headless });
    await pwHideWebdriver(ctx);
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto(OLLAMA_SETTINGS_URL, { waitUntil: 'domcontentloaded', timeout: REQ_TIMEOUT_MS });
    const gotMeter = await page.waitForSelector('[data-usage-meter]', { timeout: REQ_TIMEOUT_MS })
      .then(() => true).catch(() => false);
    const html = await page.content();
    if (!gotMeter || /\/signin/.test(page.url())) {
      const error = classifyOllamaPage({ url: page.url(), html });
      return { ok: false, source: 'ollama', needsAuth: error === 'auth-expired', error };
    }
    return parseOllamaHtml(html) ?? { ok: false, source: 'ollama', error: 'scrape-incompatible' };
  } catch {
    return { ok: false, source: 'ollama', error: 'unavailable' };
  } finally {
    if (ctx) await ctx.close().catch(() => {});
  }
}

let ollamaBrowserInflight = null;
function fetchOllamaBrowser() {
  if (ollamaBrowserInflight) return ollamaBrowserInflight;
  ollamaBrowserInflight = (async () => {
    const pw = await import('playwright-core').catch(() => null);
    if (!pw) return { ok: false, source: 'ollama', error: 'playwright-core not installed (pnpm install)' };
    return ownOllamaProfile(() => scrapeOllamaOnce(pw, true));
  })();
  return ollamaBrowserInflight.finally(() => { ollamaBrowserInflight = null; });
}

async function fetchOllama() {
  if (!existsSync(OLLAMA_CFG)) return { ok: false, source: 'ollama', needsAuth: true, error: 'no-config' };
  try {
    if (JSON.parse(readFileSync(OLLAMA_CFG, 'utf8'))?.mode === 'browser') return fetchOllamaBrowser();
  } catch (e) {
    return { ok: false, source: 'ollama', error: `bad ${OLLAMA_CFG}: ${e.message}` };
  }
  return { ok: false, source: 'ollama', needsAuth: true, error: 'no-config' };
}

function writeOllamaBrowserMode() {
  mkdirSync(dirname(OLLAMA_CFG), { recursive: true });
  const tmp = `${OLLAMA_CFG}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify({ mode: 'browser' }), { mode: 0o600 });
  renameSync(tmp, OLLAMA_CFG);
}

export function sanitizeOllamaUsage(data) {
  return {
    ok: !!data?.ok, source: 'ollama', plan: data?.plan ?? null,
    session: data?.session ?? null, weekly: data?.weekly ?? null, extra: null,
    fetchedAt: data?.fetchedAt ?? null, stale: !!data?.stale,
    needsAuth: !!data?.needsAuth, error: data?.error ?? null,
  };
}

export async function connectOllamaUsage({ playwright, waitForUser, timeoutMs = 120_000, headlessVerifier } = {}) {
  const pw = playwright ?? await import('playwright-core').catch(() => null);
  if (!pw) return { ok: false, source: 'ollama', error: 'unavailable' };
  const interactive = await ownOllamaProfile(async () => {
    let ctx;
    try {
      ctx = await pw.chromium.launchPersistentContext(OLLAMA_PROFILE_DIR, { ...PW_STEALTH, headless: false });
      await pwHideWebdriver(ctx);
      const page = ctx.pages()[0] ?? await ctx.newPage();
      await page.goto(OLLAMA_SETTINGS_URL, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
      if (waitForUser) Promise.resolve().then(waitForUser).catch(() => {});
      let deadlineTimer;
      const deadline = new Promise((resolve) => { deadlineTimer = setTimeout(() => resolve(false), timeoutMs); });
      let gotMeter;
      try {
        gotMeter = await Promise.race([
          page.waitForSelector('[data-usage-meter]', { timeout: timeoutMs }).then(() => true).catch(() => false), deadline,
        ]);
      } finally { clearTimeout(deadlineTimer); }
      const html = await page.content();
      if (!gotMeter) {
        const error = classifyOllamaPage({ url: page.url(), html });
        return { ok: false, source: 'ollama', needsAuth: error === 'auth-expired', error };
      }
      return parseOllamaHtml(html) ?? { ok: false, source: 'ollama', error: 'scrape-incompatible' };
    } catch {
      return { ok: false, source: 'ollama', error: 'unavailable' };
    } finally { if (ctx) await ctx.close().catch(() => {}); }
  });
  if (!interactive.ok) return sanitizeOllamaUsage(interactive);
  const verified = await (headlessVerifier ?? fetchOllamaBrowser)();
  if (!verified.ok) return sanitizeOllamaUsage(verified);
  writeOllamaBrowserMode();
  cache.ollama = { data: null, at: 0 };
  historyPaused = null;
  historyBackoffMs = 0;
  ollamaGate.clear();
  startHistorySampler();
  return sanitizeOllamaUsage({ ...verified, fetchedAt: new Date().toISOString() });
}

export function preserveOllamaStale(lastGood, failure) {
  return lastGood?.ok && !failure.ok
    ? { ...lastGood, stale: true, error: failure.error, needsAuth: !!failure.needsAuth }
    : failure;
}

export function preserveClaudeStale(lastGood, failure) {
  return lastGood?.ok && !failure.ok
    ? { ...lastGood, stale: true, error: failure.error, needsAuth: !!failure.needsAuth }
    : failure;
}

// ---- Claude: OAuth usage API --------------------------------------------------
// Schema mirrors stats.mjs (L1795-1812): raw has five_hour, seven_day,
// seven_day_{sonnet,opus,omelette}, extra_usage; each window {utilization,resets_at}.
export function normalizeClaude(raw, plan) {
  const win = (w) => {
    if (!w || w.utilization == null) return null;
    const pctUsed = Number(w.utilization);
    const resetsAt = w.resets_at ?? null;
    return {
      pctUsed, resetsAt, models: [],
      ...(pctUsed === 0 && resetsAt == null ? { started: false } : {}),
    };
  };
  const models = [
    ['sonnet', raw.seven_day_sonnet],
    ['opus', raw.seven_day_opus],
    ['design', raw.seven_day_omelette], // API key omelette → "design" (stats.mjs L1804)
  ]
    .filter(([, w]) => w && w.utilization != null)
    .map(([model, w]) => ({ model, pctUsed: Number(w.utilization) }));

  const weekly = win(raw.seven_day);
  if (weekly) weekly.models = models;
  const eu = raw.extra_usage;
  return {
    ok: true, source: 'claude', plan: plan ?? null,
    session: win(raw.five_hour),
    weekly,
    extra: eu && typeof eu === 'object'
      ? { enabled: eu.is_enabled ?? null, used: eu.used_credits ?? null,
          monthlyLimit: eu.monthly_limit ?? null,
          pctUsed: eu.utilization != null ? Number(eu.utilization) : null,
          resetsAt: eu.resets_at ?? null }
      : null,
  };
}

// Read the Claude Code OAuth token from ~/.claude/.credentials.json. Returns
// {accessToken, expiresAt, subscriptionType} or null when absent/expired. The
// daemon's own on-demand usage fetch uses it; exported so the session-history
// chat can reuse the same credentials for /v1/messages instead of keeping its
// own copy.
//
// macOS note: Claude Code stores its OAuth token in the Keychain under the
// "Claude Code-credentials" generic password, not in .credentials.json. When
// the file is absent or has no accessToken on darwin, fall back to
// `security find-generic-password -s "Claude Code-credentials" -w`, which
// prints the same JSON blob to stdout. This stays synchronous because
// chat.mjs calls claudeOauthToken() without await — `security` is a fast
// local lookup so the brief event-loop block is acceptable.
export function claudeOauthToken() {
  const fromFile = readCredentialsFile();
  const oauth = fromFile ?? readKeychainOnDarwin();
  if (!oauth?.accessToken) return null;
  if (oauth.expiresAt && Number(oauth.expiresAt) < Date.now()) return null;
  return { accessToken: oauth.accessToken, expiresAt: oauth.expiresAt ?? null, subscriptionType: oauth.subscriptionType ?? null };
}

// A one-way credential marker lets the cache detect a Claude account switch
// without storing or returning either OAuth token. Prefer the longer-lived
// refresh token so ordinary access-token renewal does not usually look like a
// switch; rotation is safe to treat conservatively as one.
function claudeCredentialFingerprint() {
  const oauth = readCredentialsFile() ?? readKeychainOnDarwin();
  const secretMaterial = oauth && (oauth.refreshToken || oauth.accessToken);
  return secretMaterial ? createHash('sha256').update(secretMaterial).digest('hex') : null;
}

function readCredentialsFile() {
  if (!existsSync(CREDENTIALS_PATH)) return null;
  try { return JSON.parse(readFileSync(CREDENTIALS_PATH, 'utf8')).claudeAiOauth; }
  catch { return null; }
}

// darwin-only Keychain fallback. Returns the parsed claudeAiOauth object or
// null on any failure (no entry, user denies, parse fail) — never throws.
function readKeychainOnDarwin() {
  if (process.platform !== 'darwin') return null;
  try {
    const stdout = execFileSync(
      'security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return JSON.parse(stdout).claudeAiOauth;
  } catch { return null; }
}

// ---- Keeping the OAuth token alive ------------------------------------------
// The access token lives ~8h and nothing but a Claude Code run renews it, so an
// idle night leaves the on-demand Usage read without credentials until the user
// starts (and kills) a session purely to trigger a refresh. Do the refresh here
// instead: same refresh_token grant Claude Code uses, then persist the (rotated)
// pair back to .credentials.json so the CLI keeps working off the same file.
// `claude auth status` is the fallback for what the grant can't cover — macOS
// Keychain storage, or a refresh token the server has already retired.
const OAUTH_TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';
const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'; // Claude Code's public client
const AUTH_REFRESH_THROTTLE_MS = 5 * 60_000;
let lastAuthRefresh = 0;

// Merge a fresh token response into ~/.claude/.credentials.json, preserving
// every field we didn't get back (subscriptionType, rateLimitTier, …) and any
// sibling keys the file holds. tmp+rename so a crash can't truncate the file;
// a plain write is the last resort because losing a just-rotated refresh token
// costs the user a full re-login, which is worse than a non-atomic write.
function persistOauth(fresh) {
  let file = {};
  try { file = JSON.parse(readFileSync(CREDENTIALS_PATH, 'utf8')); } catch {}
  file.claudeAiOauth = { ...file.claudeAiOauth, ...fresh };
  const data = JSON.stringify(file);
  const tmp = `${CREDENTIALS_PATH}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, data, { mode: 0o600 });
    renameSync(tmp, CREDENTIALS_PATH);
  } catch {
    try { writeFileSync(CREDENTIALS_PATH, data, { mode: 0o600 }); } catch { return false; }
  }
  return true;
}

// POST the refresh_token grant. Returns true only when a new access token was
// obtained AND persisted — a false sends the caller on to the CLI fallback.
export async function refreshOauthGrant() {
  const cur = readCredentialsFile(); // file only: the darwin Keychain path is the CLI's job
  if (!cur?.refreshToken) return false;
  if (cur.refreshTokenExpiresAt && Number(cur.refreshTokenExpiresAt) < Date.now()) return false;
  let resp;
  try {
    resp = await fetchExternal(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: cur.refreshToken, client_id: OAUTH_CLIENT_ID }),
    }, { timeoutMs: REQ_TIMEOUT_MS });
  } catch { return false; }
  if (resp.status !== 200) return false;
  let body;
  try { body = await resp.json(); } catch { return false; }
  if (!body.access_token) return false;
  return persistOauth({
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? cur.refreshToken, // rotation is optional server-side
    expiresAt: body.expires_in ? Date.now() + Number(body.expires_in) * 1000 : cur.expiresAt,
    scopes: body.scope ? body.scope.split(' ') : cur.scopes,
  });
}

// Grant first (no spawn, keeps the CLI's own file as the store), CLI second.
// Throttled as a pair so a genuinely signed-out user doesn't get a request +
// spawn on every usage pull.
export async function refreshClaudeAuth() {
  if (Date.now() - lastAuthRefresh < AUTH_REFRESH_THROTTLE_MS) return false;
  lastAuthRefresh = Date.now();
  if (await refreshOauthGrant()) return true;
  const bin = process.env.CLAUDE_BIN;
  if (!bin) return false;
  return new Promise((resolve) => {
    execFile(bin, ['auth', 'status'], { timeout: REQ_TIMEOUT_MS, windowsHide: true }, () => resolve(true));
  });
}

// The two free tiers, in freshness order. Tier 1: whoever fetched last — us or
// the statusline — left the whole payload on disk. Tier 2: the statusline stamps
// the live 5h/7d limits into cost-state on every turn of every session, so a
// session that is mid-task keeps this card fed without spending the account's
// one-call-a-minute quota; it carries the fields that payload has no room for
// (extra_usage, per-model) from the last good reading. Both are plain file reads,
// which is why pull() runs this ahead of the TTL gate — that guards the network
// leg only.
export function readClaudeLocal(prev, plan, maxAgeMs = SNAPSHOT_MAX_AGE_MS) {
  const snapshot = readClaudeSnapshot(maxAgeMs);
  if (snapshot) return { ...normalizeClaude(snapshot.raw, plan), fetchedAt: snapshot.fetchedAt };

  const limits = readCostStateLimits(maxAgeMs);
  if (!limits) return null;
  const weekly = limits.weekly && { ...limits.weekly, models: prev?.weekly?.models ?? [] };
  return {
    ok: true, source: 'claude', plan: plan ?? null,
    session: limits.session, weekly, extra: prev?.extra ?? null,
    fetchedAt: limits.fetchedAt,
  };
}

async function fetchClaude(retry = true, prev = cache.claude.data, force = false) {
  let oauth = claudeOauthToken();
  // Expired token → renew it here rather than making the user open a session.
  if (!oauth && retry && await refreshClaudeAuth()) oauth = claudeOauthToken();
  if (!oauth) {
    // Distinguish no-creds vs expired for the UI's auth prompt.
    let err;
    if (!existsSync(CREDENTIALS_PATH)) err = 'no-credentials';
    else {
      try { err = JSON.parse(readFileSync(CREDENTIALS_PATH, 'utf8')).claudeAiOauth?.accessToken ? 'token-expired' : 'no-token'; }
      catch { err = 'bad credentials'; }
    }
    return { ok: false, source: 'claude', needsAuth: true, error: err };
  }

  // Files first for a direct caller (the history sampler). pull() has already
  // looked and found nothing fresh by the time it forces, so this is belt and
  // braces there rather than a second chance.
  if (!force) {
    const local = readClaudeLocal(prev, oauth.subscriptionType);
    if (local) return local;
  }

  let resp;
  try {
    resp = await fetchExternal(USAGE_API_URL, {
      headers: { Authorization: `Bearer ${oauth.accessToken}`, 'anthropic-beta': USAGE_API_BETA },
    }, { timeoutMs: REQ_TIMEOUT_MS });
  } catch (e) {
    return { ok: false, source: 'claude', error: `request failed: ${e.message}` };
  }
  if (resp.status === 401) {
    // Token looked valid locally but the server rejected it — same cure, once.
    if (retry && await refreshClaudeAuth()) return fetchClaude(false, prev, force);
    return { ok: false, source: 'claude', needsAuth: true, error: 'auth-expired' };
  }
  // The endpoint hands back a Retry-After (~66s) — back off exactly that long
  // instead of guessing, so the next pull lands just past the window.
  if (resp.status === 429) return { ok: false, source: 'claude', error: 'rate-limited', retryAfterMs: retryAfterMs(resp.headers?.get?.('retry-after')) };
  if (resp.status !== 200) return { ok: false, source: 'claude', error: `HTTP ${resp.status}` };
  try {
    const raw = await resp.json();
    // Feed a fresh network reading back into the statusline's own log so R2
    // tails stay fed for sessions starting mid-idle (readClaudeSnapshot reads
    // {fetched_at, raw}). Failures and file-sourced reads append nothing.
    appendJsonl(CLAUDE_HISTORY, { fetched_at: localTimestamp(new Date()), raw });
    return normalizeClaude(raw, oauth.subscriptionType);
  } catch (e) {
    return { ok: false, source: 'claude', error: `parse error: ${e.message}` };
  }
}

// ---- Codex: local rollout logs first, live usage API on demand --------------
// The API credentials live in ~/.codex/auth.json (CODEX_HOME overrides
// ~/.codex). The rollout-*.jsonl session records retain the last server-provided
// rate_limits payload from normal use — appended mid-session, so they are live
// data, not exit-only residue — and cost nothing to read. Read order: the Stop
// hook's codex-usage.jsonl tail when fresh, then this bounded rollout scan; the
// live API is only consulted on ?force=1.
export const CODEX_HOME = process.env.CODEX_HOME || join(homedir(), '.codex');
const CODEX_SESSIONS_DIR = join(CODEX_HOME, 'sessions');
const CODEX_AUTH_PATH = join(CODEX_HOME, 'auth.json');
const CODEX_USAGE_API_URL = 'https://chatgpt.com/backend-api/wham/usage';

// Newest date dirs (sessions/YYYY/MM/DD), newest first, capped at `maxDirs` —
// bounded backward walk like findCodexRolloutForCwd in stats.mjs, never walks
// the whole tree. Zero-padded names sort correctly as strings.
function newestCodexDateDirs(maxDirs) {
  const dirs = [];
  let years;
  try { years = readdirSync(CODEX_SESSIONS_DIR).sort(); } catch { return dirs; }
  for (const year of [...years].reverse()) {
    if (dirs.length >= maxDirs) break;
    let months;
    try { months = readdirSync(join(CODEX_SESSIONS_DIR, year)).sort(); } catch { continue; }
    for (const month of [...months].reverse()) {
      if (dirs.length >= maxDirs) break;
      let days;
      try { days = readdirSync(join(CODEX_SESSIONS_DIR, year, month)).sort(); } catch { continue; }
      for (const day of [...days].reverse()) {
        if (dirs.length >= maxDirs) break;
        dirs.push(join(CODEX_SESSIONS_DIR, year, month, day));
      }
    }
  }
  return dirs;
}

// Newest rollout files across the newest `maxDateDirs` date dirs, newest-mtime
// first, capped at `maxFiles` total — the bounded candidate list fetchCodex
// scans for the freshest rate_limits reading. mtime only orders last-append
// time (any event), not each file's last rate_limits record, so it's just a
// cheap relevance pre-filter — fetchCodex compares record timestamps itself.
function newestCodexRollouts(maxFiles, maxDateDirs) {
  const files = [];
  for (const dir of newestCodexDateDirs(maxDateDirs)) {
    let names;
    try { names = readdirSync(dir).filter((f) => f.startsWith('rollout-') && f.endsWith('.jsonl')); }
    catch { continue; }
    for (const f of names) files.push(join(dir, f));
  }
  return files
    .map((f) => [f, statSync(f).mtimeMs])
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxFiles)
    .map(([f]) => f);
}

// Bounded candidate scan: newest 20 rollout files across the newest 2 date dirs.
// Launching Codex without taking a turn leaves a session_meta-only stub rollout
// with no rate_limits — a handful of those would exhaust a tighter cap and hide
// the newest real reading behind a "no Codex sessions found" error.
const CODEX_ROLLOUT_SCAN_CAP = 20;
const CODEX_DATE_DIR_SCAN_CAP = 2;

function normalizeCodexLimits(plan, windows, durationKey, fetchedAt, resetKey = 'resets_at') {
  let session = null;
  let weekly = null;
  for (const w of windows) {
    const duration = Number(w?.[durationKey]);
    if (!Number.isFinite(w?.used_percent) || !Number.isFinite(duration)) continue;
    // A window that has not begun yet: the live API still fills in reset_at,
    // but as a rolling projection of now + the whole window, so it slides
    // forward on every poll (seen live: the 5h reset walking 8:31 → 8:32 →
    // 8:33pm). That is not a reset instant, so drop it and say so — a pinned
    // reset always has reset_after_seconds below the window length. Rollout
    // records carry no reset_after_seconds, so they never trip this.
    const unstarted = Number(w.reset_after_seconds) >= Number(w.limit_window_seconds);
    const window = {
      pctUsed: w.used_percent,
      resetsAt: !unstarted && Number.isFinite(w[resetKey]) ? new Date(w[resetKey] * 1000).toISOString() : null,
      models: [],
      ...(unstarted ? { started: false } : {}),
    };
    if (duration >= (durationKey === 'window_minutes' ? 1440 : 86400)) weekly = window;
    else session = window;
  }
  return session || weekly ? { ok: true, source: 'codex', plan: plan ?? null, fetchedAt, session, weekly } : null;
}

export function fetchCodexRollout() {
  try {
    const files = newestCodexRollouts(CODEX_ROLLOUT_SCAN_CAP, CODEX_DATE_DIR_SCAN_CAP);
    if (!files.length) return { ok: false, source: 'codex', error: 'no Codex sessions found', fetchedAt: new Date().toISOString() };

    // Freshest reading wins by the record's own timestamp, not file mtime: with
    // parallel Codex sessions a rollout's last append is usually not a
    // rate_limits event, so the newest-mtime file can carry an older record
    // than a quieter session's file (seen live: 87% picked over a 99% recorded
    // 4 minutes later). Within a file the backwards scan takes its last record.
    let record = null;
    for (const file of files) {
      const lines = readFileSync(file, 'utf8').split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].includes('rate_limits')) continue;
        let parsed;
        try { parsed = JSON.parse(lines[i]); } catch { continue; }
        if (parsed?.payload?.rate_limits) {
          if (!record || parsed.timestamp > (record.timestamp ?? '')) record = parsed;
          break;
        }
      }
    }
    if (!record) return { ok: false, source: 'codex', error: 'no Codex sessions found', fetchedAt: new Date().toISOString() };

    const rl = record.payload.rate_limits;
    return normalizeCodexLimits(rl.plan_type, [rl.primary, rl.secondary], 'window_minutes', record.timestamp)
      ?? { ok: false, source: 'codex', error: 'no Codex sessions found', fetchedAt: new Date().toISOString() };
  } catch (e) {
    return { ok: false, source: 'codex', error: e.message, fetchedAt: new Date().toISOString() };
  }
}

export async function fetchCodex(force = false) {
  // The Stop hook's tail is the freshest free source: a fresh codex-usage.jsonl
  // line answers with no rollout scan at all; stale or missing falls through.
  if (!force) {
    const snapshot = readCodexSnapshot();
    if (snapshot) return snapshot;
  }
  const rollout = fetchCodexRollout();
  // Passively the rollout scan IS the answer: it is the same rate_limits payload
  // the API would hand back, from the CLI's own log, at no request cost.
  if (!force) return rollout;

  let auth;
  try { auth = JSON.parse(readFileSync(CODEX_AUTH_PATH, 'utf8')); }
  catch { return rollout; }
  const token = auth?.tokens?.access_token;
  const accountId = auth?.tokens?.account_id;
  if (!token || !accountId) return rollout;

  let liveError;
  let resp;
  try {
    resp = await fetchExternal(CODEX_USAGE_API_URL, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, 'ChatGPT-Account-Id': accountId },
    }, { timeoutMs: REQ_TIMEOUT_MS });
  } catch (e) {
    liveError = `request failed: ${e.message}`;
  }
  if (resp && resp.status !== 200) {
    liveError = resp.status === 429 ? 'rate-limited' : resp.status === 401 || resp.status === 403 ? 'auth rejected' : `HTTP ${resp.status}`;
  } else if (resp) {
    let raw;
    try { raw = await resp.json(); }
    catch (e) { liveError = `parse error: ${e.message}`; }
    const live = normalizeCodexLimits(raw?.plan_type, [raw?.rate_limit?.primary_window, raw?.rate_limit?.secondary_window], 'limit_window_seconds', new Date().toISOString(), 'reset_at');
    if (live) return live;
    liveError ??= 'no usable rate limits';
  }

  return !rollout.ok && liveError ? { ...rollout, error: liveError } : rollout;
}

// ---- Cache + public API -------------------------------------------------------
const cache = {
  ollama: { data: null, at: 0 },
  claude: { data: null, at: 0, credentialFingerprint: null },
  codex: { data: null, at: 0 },
};
const SOURCES = ['ollama', 'claude', 'codex'];
const CLAUDE_RATE_LIMIT_BACKOFF_MS = 5 * 60_000;

// The cross-request gate both network lanes need: "no attempt before T, and
// forget T when the key it was armed for changes". How long to wait is the
// caller's call — Claude obeys the server's Retry-After, ollama doubles its own
// — and so is what a key means (Claude passes the credential fingerprint so a
// different token is never held to a wait it was never told to make; ollama has
// no key). The per-attempt retries inside one call are external-fetch.mjs's job,
// not this.
function rateGate() {
  let until = 0;
  let key = null;
  return {
    blocked(k = null) {
      if (k !== key) until = 0;
      return Date.now() < until;
    },
    arm(ms, k = null) { until = Date.now() + ms; key = k; },
    clear() { until = 0; key = null; },
  };
}
const claudeGate = rateGate();
const ollamaGate = rateGate();

// The best Claude reading reachable without the network, for the two paths that
// have no answer of their own: a 429 backoff and a failed pull. The 120s gate
// above protects freshness, not the card — when the API is out of reach the
// reading it rejected is still on disk, and an hour-old statusline reading beats
// "Couldn't load this: rate-limited" on an empty card. Re-read the local tiers
// with the gate widened to the 5h window, keep whichever of that / the cached
// reading is newer, and hand it back marked stale.
function claudeStaleFloor(slot, failure) {
  const widened = readClaudeLocal(slot.data, claudeOauthToken()?.subscriptionType, CLAUDE_STALE_MAX_MS);
  const lastGood = slot.data?.ok ? slot.data : null;
  const best = widened && !(lastGood?.fetchedAt > widened.fetchedAt) ? widened : lastGood;
  return best ? preserveClaudeStale(best, failure) : null;
}

async function pull(src, fetcher, force) {
  const slot = cache[src];
  let claudeAccountChanged = false;
  let claudeFingerprint = null;
  // Claude's local tiers cost a file read, so they run ahead of both gates below
  // — a backed-off or within-TTL poll still picks up whatever the statusline
  // wrote since. Only a genuinely newer reading counts; an unchanged one falls
  // through so the gates decide whether the network leg is worth it.
  if (src === 'claude') {
    claudeFingerprint = claudeCredentialFingerprint();
    // The cache is in-memory only (no cross-restart persistence), so a still-null
    // slot.credentialFingerprint means "never established this process," not
    // "switched accounts." Only a fingerprint that actually moved counts.
    claudeAccountChanged = !!slot.credentialFingerprint && !!claudeFingerprint && claudeFingerprint !== slot.credentialFingerprint;
    if (claudeAccountChanged) {
      // Neither the snapshot log nor cost-state identifies its account. Do not
      // blend either with a cache created under different credentials; one live
      // OAuth read establishes the complete payload for the new account.
      slot.data = null;
      slot.at = 0;
    }
    const local = claudeAccountChanged ? null : readClaudeLocal(slot.data, claudeOauthToken()?.subscriptionType);
    // A reading inside the 120s gate is exactly what the endpoint would hand back,
    // and the endpoint is the one that 429s — so it wins on every path, force
    // included. Refresh means "look again", and looking again at a file the
    // statusline wrote seconds ago is the right answer; going to the network
    // instead is how a current card ended up labelled "refresh failed:
    // rate-limited". Identity is kept when nothing moved, so an unchanged reading
    // is not a new document for the WS push — but a reading that was labelled
    // stale by an earlier failed pull is replaced, since it is demonstrably fresh.
    if (local) {
      if (!slot.credentialFingerprint && claudeFingerprint) slot.credentialFingerprint = claudeFingerprint;
      const unchanged = slot.data?.ok && !slot.data.stale && slot.data.fetchedAt === local.fetchedAt;
      if (!unchanged) slot.data = local;
      slot.at = Date.now();
      return slot.data;
    }
    // Both tiers stale → the network is the only way to fill the card, and that is
    // still "on demand" (see fetchClaude): it never runs from a timer of its own,
    // only from a caller that asked.
  }
  // The endpoint allows roughly one call a minute per account; a 429's Retry-After
  // backs the network leg off without touching the free local reads above.
  // A cached failure is the one case worth re-deriving here: the backoff would
  // otherwise hold the error card up for the whole Retry-After even though the
  // local tiers can fill it.
  if (src === 'claude' && claudeGate.blocked(claudeFingerprint) && slot.data) {
    if (slot.data.ok) return slot.data;
    slot.data = claudeStaleFloor(slot, slot.data) ?? slot.data;
    return slot.data;
  }
  // Off by default: the daemon refreshes after each agent goes idle. ?force=1 from
  // a card's Refresh — or the interval a card was left on — re-reads regardless.
  if (!force && slot.data && Date.now() - slot.at < TTL) return slot.data;
  const fetched = src === 'claude'
    ? await fetcher(true, slot.data, force || claudeAccountChanged)
    : await fetcher(force);
  // codex's fetchedAt is the record's own (possibly stale) timestamp — keep it;
  // ollama/claude never set one, so they still default to "now".
  const data = { fetchedAt: new Date().toISOString(), ...fetched };
  if (src === 'claude' && data.ok) {
    slot['credentialFingerprint'] = claudeCredentialFingerprint();
    claudeGate.clear();
  }
  // A failure replaces a previous failure — the card must show this pull's error,
  // not one from an earlier attempt — but never a good reading; that is what
  // preserve*Stale below is for.
  const lastGood = slot.data?.ok ? slot.data : null;
  if (data.ok || !lastGood) slot.data = data;
  if (src === 'claude' && data.error === 'rate-limited') {
    claudeGate.arm(data.retryAfterMs ?? CLAUDE_RATE_LIMIT_BACKOFF_MS, claudeFingerprint);
  }
  if (src === 'ollama' && !data.ok && lastGood) {
    // Ollama failures retain the timestamped successful measurement and surface
    // the current actionable error; failures never reach the history writer.
    return preserveOllamaStale(lastGood, data);
  }
  // Claude uses the same last-good semantics. This keeps the meters visible while
  // making a failed pull unambiguously stale instead of green.
  if (src === 'claude' && !data.ok) {
    const floor = claudeStaleFloor(slot, data);
    if (floor) {
      slot.data = floor;
      slot.at = Date.now();
      return slot.data;
    }
  }
  if (src === 'ollama' && data.ok) {
    appendOllamaHistory(data);
    // A successful ollama read from ANY path (manual Refresh, idle debounce,
    // reset timer, or the sampler itself) is the "re-enable" signal — clear a
    // prior stop-on-fail and re-arm the sampler's clock.
    historyPaused = null;
    startHistorySampler();
  }
  if (src === 'codex' && data.ok) appendCodexHistory(data);
  return slot.data;
}

// Which sources a pull may hit the network for. Absent, empty, or all-unknown
// means all three.
function normalizeSources(sources) {
  if (!sources) return new Set(SOURCES);
  const listed = [].concat(sources).filter((s) => SOURCES.includes(s));
  return listed.length ? new Set(listed) : new Set(SOURCES);
}

export async function getUsage({ force = false, sources } = {}) {
  const allow = normalizeSources(sources);
  // An excluded source must never reach pull(): pull refetches on its own once
  // the slot is past TTL, so the allowlist is enforced by not calling it at all
  // rather than by holding force back. The slot is null until the first
  // successful fetch, so a filtered pull against a cold cache returns the key
  // as null — the card renders "Loading…", and the client merge keeps a null
  // from overwriting a card that already has data.
  const pick = (src, fetcher) => (allow.has(src) ? pull(src, fetcher, force) : cache[src].data);
  const [ollama, claude, codex] = await Promise.all([
    pick('ollama', fetchOllama),
    pick('claude', fetchClaude),
    pick('codex', fetchCodex),
  ]);
  // A full document even for a filtered pull: scheduleResetRefreshes() rebuilds
  // every source's reset timer from what it is handed, so a partial document
  // would clear the timers it does not mention and never recreate them, and the
  // ollama slot is what carries historyPaused.
  const result = { ollama: ollama ? { ...ollama, historyPaused } : null, claude, codex };
  usageBus?.emit('usage', result);
  scheduleResetRefreshes(result);
  return result;
}

// ---- Auto-refresh (backend-owned) ----------------------------------------------
// The daemon schedules its own refreshes and pushes every cache update over the
// agents bus as 'usage' (pty-ws fans it out to all tabs) — browsers just listen.
const DEBOUNCE_MS = 30_000;
let usageBus = null;
let idleTimer = null;
let resetTimers = [];

// Schedulable if resetsAt is in the future and within a sane horizon (skip
// absurd/past values). Well under the ~24.8d setTimeout limit.
function resetDelay(iso, capMs = 7.75 * 24 * 3.6e6) {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0 || ms > capMs) return null;
  return ms;
}

// One forced refresh just after each 5h/7d window resets, so a passive viewer
// sees the % drop to 0. Rescheduled from every getUsage result — including a
// filtered one, which is why getUsage always assembles a full document.
// Rebuilding up to six timers per call is churn a 15s card cadence multiplies,
// and not worth a previous-document diff to avoid.
function scheduleResetRefreshes(result) {
  resetTimers.forEach(clearTimeout);
  resetTimers = [];
  for (const src of ['ollama', 'claude', 'codex']) {
    for (const win of ['session', 'weekly']) {
      const delay = resetDelay(result[src]?.[win]?.resetsAt);
      if (delay != null) resetTimers.push(setTimeout(() => getUsage({ force: true }).catch(() => {}), delay + 2000));
    }
  }
}

// Wire the triggers: store the bus for 'usage' emits, and refresh 30s after an
// agent goes idle (turn end likely spent tokens; the debounce coalesces a burst
// of agents finishing into one pull).
export function initUsageAutoRefresh(bus) {
  usageBus = bus;
  bus.on('status', ({ status }) => {
    if (status !== 'idle') return;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => getUsage({ force: true }).catch(() => {}), DEBOUNCE_MS);
  });
  startHistorySampler();
}

// ---- Usage history clock sampler -----------------------------------------------
// One 60s tick drives all three lanes, filling ollama-usage.jsonl /
// codex-usage.jsonl / usage-snapshots.jsonl unattended (the weekly gauges need
// ~2 weeks of samples, longer than anyone keeps the Usage page open). The tick is
// affordable because each lane prefers a free local source: claude reads
// usage-snapshots.jsonl + cost-state (the statusline writes both once a turn),
// codex reads codex-usage.jsonl, and ollama's Bearer API is the only lane whose
// sole source costs a request. So the two API legs run ONLY when their local
// files have gone stale (>120s, i.e. the statusline has stopped feeding them) —
// that keeps the daemon off api.anthropic.com's ~1/min per-account budget, which
// the statusline already spends. `USAGE_POLL_MS` overrides the cadence.
const USAGE_POLL_MS = Number(process.env.USAGE_POLL_MS) > 0
  ? Number(process.env.USAGE_POLL_MS)
  : 60_000;
const API_FRESH_MS = SNAPSHOT_MAX_AGE_MS; // 120s: one missed statusline tick
const OLLAMA_BACKOFF_CAP_MS = 15 * 60_000;
let historyTimer = null;
let historyPaused = null; // {at, error} while the ollama lane is stopped, else null
let historyBackoffMs = 0; // doubles on a 429/5xx, cleared by the next success

// The tick itself never re-arms early or backs off: a pause or backoff belongs to
// the ollama lane only (see runHistorySample) and must not stall Claude/Codex,
// whose local-file reads are unattended-collection's whole reason to exist.
function scheduleHistorySample() {
  if (historyTimer) return; // already ticking; never reset the countdown
  historyTimer = setTimeout(runHistorySample, USAGE_POLL_MS);
  historyTimer.unref();
}

// Claude leg: routed through getUsage, not a bare fetchClaude, because a reading
// nobody can see is not a retry — the direct call updated neither the cache nor
// the bus, so a rate-limited banner sat on the card until someone pressed
// Refresh. This IS the retry loop that clears it: pull() answers from disk when
// the statusline is feeding it (no request, but the card still refreshes), holds
// the network leg back while the 429's own Retry-After has not passed, and pushes
// the recovered reading to every tab the moment one lands. force, because the
// tick and the TTL are both 60s and a coin-flip skip would stall the retry — it
// costs nothing now that a fresh local reading outranks the network.
async function sampleClaude() {
  try { await getUsage({ sources: ['claude'], force: true }); } catch { /* transient */ }
}

// Codex leg: codex-usage.jsonl is fed per turn end by the harness; the rollout
// scan is the lazy fallback and only runs when that file has gone stale.
function sampleCodex() {
  let stale;
  try { stale = Date.now() - statSync(CODEX_HISTORY).mtimeMs > API_FRESH_MS; } catch { stale = true; }
  if (!stale) return;
  const codex = fetchCodexRollout();
  if (codex.ok) appendCodexHistory(codex);
}

export async function runHistorySample(fetchOllamaFn = fetchOllama) {
  historyTimer = null;
  // Ollama lane only — a pause or backoff here must never stall the local-read lanes.
  if (!historyPaused && !ollamaGate.blocked()) {
    let ollama;
    try { ollama = await fetchOllamaFn(); }
    catch { ollama = { ok: false, source: 'ollama', error: 'unavailable' }; }
    if (ollama.ok) {
      appendOllamaHistory(ollama);
      historyBackoffMs = 0; // a success clears an accumulated backoff
      ollamaGate.clear();
    } else if (ollama.error === 'no-config') {
      // Never configured — not a failure worth backing off for. Check back rarely
      // instead of doubling historyBackoffMs, which would otherwise drag Claude
      // and Codex sampling down to the 15m cap on an install that skipped Ollama.
      ollamaGate.arm(OLLAMA_BACKOFF_CAP_MS);
    } else if (ollama.needsAuth) {
      // An expired login pauses the lane; a successful manual refresh or Connect
      // action re-arms it (pull() clears historyPaused on the next good read).
      historyPaused = { at: new Date().toISOString(), error: ollama.error || 'unknown error' };
    } else {
      historyBackoffMs = Math.min(OLLAMA_BACKOFF_CAP_MS, historyBackoffMs * 2 || USAGE_POLL_MS);
      ollamaGate.arm(historyBackoffMs);
    }
  }

  // Neither of these can pause or back off the tick: they are local reads.
  await sampleClaude();
  sampleCodex();
  scheduleHistorySample();
}

function startHistorySampler() {
  scheduleHistorySample();
}
