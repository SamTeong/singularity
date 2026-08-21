// Usage backend: pull 5h/7d limits from two account-wide sources and normalize
// them to one shape. Ollama Cloud = scrape ollama.com/settings (server-rendered
// HTML, cookie auth). Claude subscription = GET the OAuth usage API (bearer token
// from ~/.claude/.credentials.json). The daemon is one long-lived process, so a
// small in-memory cache per source is enough — no cross-session file needed.
// SECURITY: reads full account creds (cookie / OAuth token) but NEVER returns
// them to the client — only derived %/reset/plan leave this module.
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, appendFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { execFile, execFileSync } from 'node:child_process';
import { STATE_DIR, CACHE_DIR, USAGE_SKILL_STATE } from './app-dir.mjs';

const OLLAMA_CFG = join(STATE_DIR, 'ollama.json');
export const OLLAMA_PROFILE_DIR = join(CACHE_DIR, 'pw-ollama-profile');
const CACHE_FILE = join(CACHE_DIR, 'usage-cache.json');

// Anti-detection launch bits: Cloudflare Turnstile auto-fails a browser that
// advertises automation (--enable-automation / navigator.webdriver=true) even
// when a human interacts. Strip those so the persistent real-Edge profile can
// pass the challenge. Shared by the login bootstrap and the runtime scrape.
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
const OLLAMA_SETTINGS_URL = 'https://ollama.com/settings';
const TTL = 60_000;
const REQ_TIMEOUT_MS = 10_000;

// ---- Ollama: parse the server-rendered settings HTML --------------------------
// The page renders two usage meters (Session, then Weekly in DOM order), each a
// track with aria-label "<Window> usage <pct>% used", per-model segment buttons
// (data-model / data-requests), and a reset timestamp (data-time). Only two
// literal data-time attributes exist on the page — the two resets, in order.
export function parseOllamaHtml(html) {
  const plan = html.match(/capitalize"\s*>\s*([A-Za-z][\w-]*)\s*</)?.[1] ?? null;
  const meters = [...html.matchAll(/aria-label="(Session|Weekly) usage ([\d.]+)% used"/g)];
  if (meters.length < 2) return null; // not logged in (login page has no meters)
  const times = [...html.matchAll(/data-time="([^"]+)"/g)].map((m) => m[1]);

  const windowAt = (i) => {
    const start = meters[i].index;
    const end = i + 1 < meters.length ? meters[i + 1].index : html.length;
    const slice = html.slice(start, end);
    const models = [...slice.matchAll(/data-model="([^"]+)"[\s\S]*?data-requests="(\d+)"/g)]
      .map((m) => ({ model: m[1], requests: Number(m[2]) }));
    return { pctUsed: parseFloat(meters[i][2]), resetsAt: times[i] ?? null, models };
  };

  return {
    ok: true, source: 'ollama', plan,
    session: windowAt(0),
    weekly: windowAt(1),
    extra: null,
  };
}

// ---- Ollama usage history (feeds the harness-usage-report skill) ----------
// Every successful ollama scrape is appended as one snapshot in the report
// skill's own record shape ({fetched_at, session, weekly, plan, models}) — a hard
// contract with that skill's stats.mjs, which already knows how to chart/forecast
// records shaped this way, so the daemon just has to write them in the right
// shape and no new maths lives here. `models` is the weekly window's per-model
// requests (already parsed). fetched_at is LOCAL time (the skill parses it as
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
  } catch {} // best-effort, same posture as persist() — never break /usage
}

// ---- Claude usage snapshots (same file the skill's fetch-usage --oauth --save writes)
// The daemon already GETs api/oauth/usage for the Usage page, so the OAuth
// snapshot the rate-limit forecast feeds on is a free by-product — no scheduled
// agent needs to re-fetch it. Record shape mirrors stats.mjs _map_usage +
// fetched_at + raw exactly (five_hour/seven_day/per_model/extra_usage), because
// _gauge_windows/_fit_gauge read these keys. Same dedup + best-effort posture as
// the ollama history above.
const CLAUDE_HISTORY = join(USAGE_SKILL_STATE, 'usage-snapshots.jsonl');
let lastClaudeReading = null;

function pickWindow(w) {
  return w && typeof w === 'object' ? { utilization: w.utilization ?? null, resets_at: w.resets_at ?? null } : null;
}

export function appendClaudeSnapshot(raw) {
  const fiveHour = pickWindow(raw.five_hour);
  const sevenDay = pickWindow(raw.seven_day);
  const reading = JSON.stringify([fiveHour, sevenDay]);
  if (reading === lastClaudeReading) return;
  lastClaudeReading = reading;
  const eu = raw.extra_usage;
  appendJsonl(CLAUDE_HISTORY, {
    fetched_at: localTimestamp(new Date()),
    five_hour: fiveHour,
    seven_day: sevenDay,
    per_model: {
      sonnet: pickWindow(raw.seven_day_sonnet),
      opus: pickWindow(raw.seven_day_opus),
      design: pickWindow(raw.seven_day_omelette), // API key omelette → "design" (stats.mjs _map_usage)
    },
    extra_usage: eu && typeof eu === 'object'
      ? { is_enabled: eu.is_enabled ?? null, monthly_limit: eu.monthly_limit ?? null,
          used_credits: eu.used_credits ?? null, utilization: eu.utilization ?? null }
      : null,
    raw,
  });
}

async function fetchWithTimeout(url, opts) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQ_TIMEOUT_MS);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(timer); }
}

async function fetchOllama() {
  if (!existsSync(OLLAMA_CFG)) {
    return { ok: false, source: 'ollama', needsAuth: true, error: 'no-config' };
  }
  let cfg;
  try { cfg = JSON.parse(readFileSync(OLLAMA_CFG, 'utf8')); }
  catch (e) { return { ok: false, source: 'ollama', error: `bad ${OLLAMA_CFG}: ${e.message}` }; }

  // Browser mode: a persistent logged-in Edge profile is the auth — no cookies.
  if (cfg.mode === 'browser') return fetchOllamaBrowser(cfg);

  if (!cfg.cookie) return { ok: false, source: 'ollama', needsAuth: true, error: 'no-config' };

  let resp;
  try {
    // No accept-encoding override: let undici negotiate + auto-decode gzip/br
    // (zstd would arrive undecoded). redirect:manual so a bounce to /signin
    // surfaces as a 3xx (dead cf_clearance) instead of a silently-followed 200.
    resp = await fetchWithTimeout(OLLAMA_SETTINGS_URL, {
      redirect: 'manual',
      headers: {
        cookie: cfg.cookie,
        'user-agent': cfg.userAgent || 'Mozilla/5.0',
        accept: 'text/html',
      },
    });
  } catch (e) {
    return { ok: false, source: 'ollama', error: `request failed: ${e.message}` };
  }
  if (resp.status >= 300 && resp.status < 400) {
    return { ok: false, source: 'ollama', needsAuth: true, error: `redirect ${resp.status}` };
  }
  if (resp.status !== 200) {
    return { ok: false, source: 'ollama', error: `HTTP ${resp.status}` };
  }
  const parsed = parseOllamaHtml(await resp.text());
  if (!parsed) return { ok: false, source: 'ollama', needsAuth: true, error: 'no-meters' };
  return parsed;
}

// Browser mode: drive a headless Edge against the persistent login profile
// (bootstrapped via `npm run ollama-login`) — the browser handles Cloudflare +
// session cookies transparently, so nothing expires and nothing is re-pasted.
// Launch-per-scrape; a module-level in-flight promise coalesces concurrent
// callers so two launches never fight over the profile-dir lock.
// One launch-and-scrape at the given visibility. Serial by construction (the
// inflight coalescer below never runs two concurrently), so headless→headful
// retries reuse the profile dir without fighting over its lock.
async function scrapeOllamaOnce(pw, headless) {
  let ctx;
  try {
    ctx = await pw.chromium.launchPersistentContext(OLLAMA_PROFILE_DIR, { ...PW_STEALTH, headless });
    await pwHideWebdriver(ctx);
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto(OLLAMA_SETTINGS_URL, { waitUntil: 'domcontentloaded', timeout: REQ_TIMEOUT_MS });
    // Logged-out → redirect to /signin; CF challenge → no meter. Either way,
    // the meter's absence within the wait means we need a (re-)login.
    const gotMeter = await page.waitForSelector('[data-usage-meter]', { timeout: REQ_TIMEOUT_MS })
      .then(() => true).catch(() => false);
    if (!gotMeter || /\/signin/.test(page.url())) {
      return { ok: false, source: 'ollama', needsAuth: true, error: 'no-login' };
    }
    const parsed = parseOllamaHtml(await page.content());
    return parsed ?? { ok: false, source: 'ollama', needsAuth: true, error: 'no-login' };
  } catch (e) {
    return { ok: false, source: 'ollama', error: `browser: ${e.message}` };
  } finally {
    if (ctx) await ctx.close().catch(() => {});
  }
}

// Browser mode: drive Edge against the persistent login profile (bootstrapped
// via `npm run ollama-login`) — the browser handles Cloudflare + session cookies
// transparently, so nothing expires and nothing is re-pasted. Try headless first
// (invisible, fast); if it fails (Cloudflare challenge headless can't clear),
// retry headful once — a visible window can pass the challenge. Set cfg.headless
// === false to skip straight to headful. A module-level in-flight promise
// coalesces concurrent callers so two launches never fight over the profile lock.
let ollamaBrowserInflight = null;
function fetchOllamaBrowser(cfg) {
  if (ollamaBrowserInflight) return ollamaBrowserInflight;
  ollamaBrowserInflight = (async () => {
    const pw = await import('playwright-core').catch(() => null);
    if (!pw) return { ok: false, source: 'ollama', error: 'playwright-core not installed (npm i playwright-core)' };
    if (cfg.headless === false) return scrapeOllamaOnce(pw, false);
    const first = await scrapeOllamaOnce(pw, true);
    if (first.ok) return first;
    return scrapeOllamaOnce(pw, false); // headless failed → headful fallback
  })();
  return ollamaBrowserInflight.finally(() => { ollamaBrowserInflight = null; });
}

// ---- Claude: OAuth usage API --------------------------------------------------
// Schema mirrors stats.mjs (L1795-1812): raw has five_hour, seven_day,
// seven_day_{sonnet,opus,omelette}, extra_usage; each window {utilization,resets_at}.
export function normalizeClaude(raw, plan) {
  const win = (w) => (w && w.utilization != null
    ? { pctUsed: Number(w.utilization), resetsAt: w.resets_at ?? null, models: [] }
    : null);
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
// daemon's own usage scrape uses it; exported so the session-history chat can
// reuse the same credentials for /v1/messages instead of keeping its own copy.
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
// idle night leaves the Usage page dark until the user starts (and kills) a
// session purely to trigger a refresh. Do the refresh here instead: same
// refresh_token grant Claude Code uses, then persist the (rotated) pair back to
// .credentials.json so the CLI keeps working off the same file. `claude auth
// status` is the fallback for what the grant can't cover — macOS Keychain
// storage, or a refresh token the server has already retired.
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
    resp = await fetchWithTimeout(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: cur.refreshToken, client_id: OAUTH_CLIENT_ID }),
    });
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

async function fetchClaude(retry = true) {
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

  let resp;
  try {
    resp = await fetchWithTimeout(USAGE_API_URL, {
      headers: { Authorization: `Bearer ${oauth.accessToken}`, 'anthropic-beta': USAGE_API_BETA },
    });
  } catch (e) {
    return { ok: false, source: 'claude', error: `request failed: ${e.message}` };
  }
  if (resp.status === 401) {
    // Token looked valid locally but the server rejected it — same cure, once.
    if (retry && await refreshClaudeAuth()) return fetchClaude(false);
    return { ok: false, source: 'claude', needsAuth: true, error: 'auth-expired' };
  }
  if (resp.status === 429) return { ok: false, source: 'claude', error: 'rate-limited' };
  if (resp.status !== 200) return { ok: false, source: 'claude', error: `HTTP ${resp.status}` };
  try {
    const raw = await resp.json();
    appendClaudeSnapshot(raw); // this fetch IS the snapshot the forecast needs
    return normalizeClaude(raw, oauth.subscriptionType);
  } catch (e) {
    return { ok: false, source: 'claude', error: `parse error: ${e.message}` };
  }
}

// ---- Codex: parse local session rollout logs ----------------------------
// Codex CLI has no 5h-window data and no limits API/cache file — the only
// source is its own session rollout logs (~/.codex/sessions/YYYY/MM/DD/
// rollout-*.jsonl, CODEX_HOME overrides ~/.codex), which record a
// "token_count" event carrying the server's rate_limits payload as a side
// effect of normal use. Push-only: fetchedAt below is that record's own
// timestamp (can be a day stale), not "now".
export const CODEX_HOME = process.env.CODEX_HOME || join(homedir(), '.codex');
const CODEX_SESSIONS_DIR = join(CODEX_HOME, 'sessions');

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
// first, capped at `maxFiles` total — the bounded fallback list fetchCodex
// scans for a usable rate_limits reading (a brand-new session's rollout has
// none yet; older ones still hold a usable, if slightly stale, reading).
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

// Bounded fallback scan: newest 20 rollout files across the newest 2 date dirs.
// Launching Codex without taking a turn leaves a session_meta-only stub rollout
// with no rate_limits — a handful of those would exhaust a tighter cap and hide
// the newest real reading behind a "no Codex sessions found" error.
const CODEX_ROLLOUT_SCAN_CAP = 20;
const CODEX_DATE_DIR_SCAN_CAP = 2;

export async function fetchCodex() {
  try {
    const files = newestCodexRollouts(CODEX_ROLLOUT_SCAN_CAP, CODEX_DATE_DIR_SCAN_CAP);
    if (!files.length) return { ok: false, source: 'codex', error: 'no Codex sessions found', fetchedAt: new Date().toISOString() };

    let record = null;
    for (const file of files) {
      const lines = readFileSync(file, 'utf8').split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].includes('rate_limits')) continue;
        let parsed;
        try { parsed = JSON.parse(lines[i]); } catch { continue; }
        if (parsed?.payload?.rate_limits) { record = parsed; break; }
      }
      if (record) break;
    }
    if (!record) return { ok: false, source: 'codex', error: 'no Codex sessions found', fetchedAt: new Date().toISOString() };

    const rl = record.payload.rate_limits;
    const mapWindow = (w) => (w ? {
      pctUsed: w.used_percent,
      resetsAt: w.resets_at ? new Date(w.resets_at * 1000).toISOString() : null,
      models: [],
    } : null);
    // window_minutes >= 1 day → weekly slot, else session slot. Codex only
    // reports the 7d window today; this keeps a future 5h window landing in
    // the right slot for free.
    let session = null;
    let weekly = null;
    for (const w of [rl.primary, rl.secondary]) {
      if (!w) continue;
      if (w.window_minutes >= 1440) weekly = mapWindow(w);
      else session = mapWindow(w);
    }
    return { ok: true, source: 'codex', plan: rl.plan_type ?? null, fetchedAt: record.timestamp, session, weekly };
  } catch (e) {
    return { ok: false, source: 'codex', error: e.message, fetchedAt: new Date().toISOString() };
  }
}

// ---- Cache + public API -------------------------------------------------------
const cache = { ollama: { data: null, at: 0 }, claude: { data: null, at: 0 }, codex: { data: null, at: 0 } };

// Warm-start from disk so a freshly-restarted daemon serves last-known values
// before the first live fetch. Best-effort; a corrupt/absent file is ignored.
try {
  if (existsSync(CACHE_FILE)) {
    const saved = JSON.parse(readFileSync(CACHE_FILE, 'utf8'));
    for (const src of ['ollama', 'claude', 'codex']) {
      if (saved[src]?.data) cache[src] = { data: saved[src].data, at: 0 }; // at:0 → stale, refetched on first pull
    }
  }
} catch {}

function persist() {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify(cache));
  } catch {}
}

async function pull(src, fetcher, force) {
  const slot = cache[src];
  if (!force && slot.data && Date.now() - slot.at < TTL) return slot.data;
  const fetched = await fetcher();
  // codex's fetchedAt is the record's own (possibly stale) timestamp — keep it;
  // ollama/claude never set one, so they still default to "now".
  const data = { fetchedAt: new Date().toISOString(), ...fetched };
  // Keep the last good payload on a transient failure so the UI doesn't flip to
  // "error" on one blip — but always surface a fresh needsAuth.
  if (data.ok || data.needsAuth || !slot.data) { slot.data = data; slot.at = Date.now(); persist(); }
  if (src === 'ollama' && data.ok) {
    appendOllamaHistory(data);
    // A successful ollama read from ANY path (manual Refresh, idle debounce,
    // reset timer, or the sampler itself) is the "re-enable" signal — clear a
    // prior stop-on-fail and re-arm the clock sampler if it isn't running.
    historyPaused = null;
    startHistorySampler();
  }
  return slot.data;
}

export async function getUsage({ force = false } = {}) {
  const [ollama, claude, codex] = await Promise.all([
    pull('ollama', fetchOllama, force),
    pull('claude', fetchClaude, force),
    pull('codex', fetchCodex, force),
  ]);
  const result = { ollama: { ...ollama, historyPaused }, claude, codex };
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
// sees the % drop to 0. Rescheduled from every getUsage result.
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
// Fills ollama-usage.jsonl + usage-snapshots.jsonl unattended (the weekly gauges
// need ~2 weeks of samples, longer than anyone keeps the Usage page open) by
// forcing a pull every 30m — this is what replaces a scheduled agent that did
// nothing but re-fetch the same two sources. Never fires immediately: an eager
// first call could hit the headful Edge fallback and pop a visible window right
// as the daemon boots.
const HISTORY_SAMPLE_MS = 30 * 60_000;
let historyInterval = null;
let historyPaused = null; // {at, error} while the sampler is stopped, else null

function startHistorySampler() {
  if (historyInterval) return;
  historyInterval = setInterval(async () => {
    const result = await getUsage({ force: true }).catch(() => null);
    // Stop on the sampler's own first ollama failure — an unattended timer is the
    // wrong place to keep retrying an expired cookie/profile every 30m. Re-arming
    // is pull()'s job, on the next successful ollama read from any path.
    // 'no-config' is not a failure: an ollama-less install still wants the timer
    // running for the Claude snapshots it also collects.
    if (result?.ollama && !result.ollama.ok && result.ollama.error !== 'no-config') {
      clearInterval(historyInterval);
      historyInterval = null;
      historyPaused = { at: new Date().toISOString(), error: result.ollama.error || 'unknown error' };
      // getUsage already emitted this result without the flag (it's set here,
      // after the await) — re-emit so open tabs learn the sampler stopped
      // without waiting for the user to hit Refresh first.
      usageBus?.emit('usage', { ...result, ollama: { ...result.ollama, historyPaused } });
    }
  }, HISTORY_SAMPLE_MS).unref();
}
