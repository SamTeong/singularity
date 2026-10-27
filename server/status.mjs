// Provider status backend: pulls Atlassian Statuspage `summary.json` for each
// configured provider (overall indicator + per-component status + active
// incidents/maintenance) and normalizes it to one shape. Public status APIs,
// no auth — the daemon proxies so the browser never faces the pages' CORS /
// X-Frame-Options quirks. Short in-memory cache per provider (no disk: status
// is ephemeral, unlike usage).
import { fetchExternal } from './external-fetch.mjs';

const TTL = 20_000; // cache 20s; client polls every 30s → always fresh
const REQ_TIMEOUT_MS = 10_000;

// ponytail: hardcode the two status pages the user named. Swap here to monitor
// more (e.g. status.ollama.com) — array, not config, because the set is fixed.
export const STATUS_PROVIDERS = [
  { key: 'openai', label: 'OpenAI', url: 'https://status.openai.com' },
  { key: 'claude', label: 'Claude', url: 'https://status.claude.com' },
];

// Statuspage `summary.json` → flat shape the Status view renders. Pure so the
// test can exercise it without the network.
export function normalizeStatus(raw, provider) {
  const comp = (raw.components || [])
    .filter((c) => c && c.group !== true && c.status) // drop group containers, keep leaves with a real status
    .map((c) => ({ name: c.name, status: c.status }));
  const incident = (i) => ({
    name: i.name,
    impact: i.impact, // none|minor|major|critical|maintenance
    status: i.status,
    shortlink: i.shortlink,
    createdAt: i.created_at ?? null,
  });
  return {
    ok: true,
    key: provider.key,
    label: provider.label,
    pageUrl: provider.url,
    updatedAt: raw.page?.updated_at ?? null,
    indicator: raw.status?.indicator ?? 'none', // none|minor|major|critical|maintenance
    description: raw.status?.description ?? '',
    components: comp,
    incidents: (raw.incidents || []).map(incident),
    maintenances: (raw.scheduled_maintenances || []).map(incident),
  };
}

async function fetchProvider(provider) {
  let resp;
  try {
    resp = await fetchExternal(`${provider.url}/api/v2/summary.json`, {}, { timeoutMs: REQ_TIMEOUT_MS });
  } catch (e) {
    return { ok: false, key: provider.key, label: provider.label, pageUrl: provider.url, error: `request failed: ${e.message}` };
  }
  if (resp.status !== 200) return { ok: false, key: provider.key, label: provider.label, pageUrl: provider.url, error: `HTTP ${resp.status}` };
  try {
    return normalizeStatus(await resp.json(), provider);
  } catch (e) {
    return { ok: false, key: provider.key, label: provider.label, pageUrl: provider.url, error: `parse error: ${e.message}` };
  }
}

export function createStatusService({ providers = STATUS_PROVIDERS, fetch = fetchProvider, now = () => Date.now() } = {}) {
  const cache = Object.fromEntries(providers.map((p) => [p.key, { data: null, at: 0 }]));

  async function pull(provider, force) {
    const slot = cache[provider.key];
    if (!force && slot.data && now() - slot.at < TTL) return slot.data;
    const attemptedAt = new Date(now()).toISOString();
    const result = await fetch(provider);
    if (result.ok) {
      const data = { ...result, fetchedAt: attemptedAt, lastAttemptAt: attemptedAt, lastSuccessAt: attemptedAt, refreshError: null, stale: false };
      slot.data = data;
      slot.at = now();
      return data;
    }
    const error = result.error || 'unknown error';
    if (!slot.data) {
      slot.data = { ...result, fetchedAt: null, lastAttemptAt: attemptedAt, lastSuccessAt: null, refreshError: error, stale: true };
    } else {
      slot.data = { ...slot.data, lastAttemptAt: attemptedAt, refreshError: error, stale: true };
    }
    return slot.data;
  }

  return { async getStatus({ force = false } = {}) {
    const out = {};
    for (const p of providers) out[p.key] = await pull(p, force);
    return out;
  } };
}

export const { getStatus } = createStatusService();
