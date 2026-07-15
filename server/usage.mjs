// Usage backend: pull 5h/7d limits from two account-wide sources and normalize
// them to one shape. Ollama Cloud = scrape ollama.com/settings (server-rendered
// HTML, cookie auth). Claude subscription = GET the OAuth usage API (bearer token
// from ~/.claude/.credentials.json). The daemon is one long-lived process, so a
// small in-memory cache per source is enough — no cross-session file needed.
// SECURITY: reads full account creds (cookie / OAuth token) but NEVER returns
// them to the client — only derived %/reset/plan leave this module.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { STATE_DIR, CACHE_DIR } from './app-dir.mjs';

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
const CREDENTIALS_PATH = join(homedir(), '.claude', '.credentials.json');
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
export function claudeOauthToken() {
  if (!existsSync(CREDENTIALS_PATH)) return null;
  let oauth;
  try { oauth = JSON.parse(readFileSync(CREDENTIALS_PATH, 'utf8')).claudeAiOauth; }
  catch { return null; }
  if (!oauth?.accessToken) return null;
  if (oauth.expiresAt && Number(oauth.expiresAt) < Date.now()) return null;
  return { accessToken: oauth.accessToken, expiresAt: oauth.expiresAt ?? null, subscriptionType: oauth.subscriptionType ?? null };
}

async function fetchClaude() {
  const oauth = claudeOauthToken();
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
  if (resp.status === 401) return { ok: false, source: 'claude', needsAuth: true, error: 'auth-expired' };
  if (resp.status === 429) return { ok: false, source: 'claude', error: 'rate-limited' };
  if (resp.status !== 200) return { ok: false, source: 'claude', error: `HTTP ${resp.status}` };
  try {
    return normalizeClaude(await resp.json(), oauth.subscriptionType);
  } catch (e) {
    return { ok: false, source: 'claude', error: `parse error: ${e.message}` };
  }
}

// ---- Cache + public API -------------------------------------------------------
const cache = { ollama: { data: null, at: 0 }, claude: { data: null, at: 0 } };

// Warm-start from disk so a freshly-restarted daemon serves last-known values
// before the first live fetch. Best-effort; a corrupt/absent file is ignored.
try {
  if (existsSync(CACHE_FILE)) {
    const saved = JSON.parse(readFileSync(CACHE_FILE, 'utf8'));
    for (const src of ['ollama', 'claude']) {
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
  const data = { ...(await fetcher()), fetchedAt: new Date().toISOString() };
  // Keep the last good payload on a transient failure so the UI doesn't flip to
  // "error" on one blip — but always surface a fresh needsAuth.
  if (data.ok || data.needsAuth || !slot.data) { slot.data = data; slot.at = Date.now(); persist(); }
  return slot.data;
}

export async function getUsage({ force = false } = {}) {
  const [ollama, claude] = await Promise.all([
    pull('ollama', fetchOllama, force),
    pull('claude', fetchClaude, force),
  ]);
  const result = { ollama, claude };
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
  for (const src of ['ollama', 'claude']) {
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
}
