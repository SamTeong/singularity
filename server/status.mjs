// Provider status backend: pulls Atlassian Statuspage `summary.json` for each
// configured provider (overall indicator + per-component status + active
// incidents/maintenance) and normalizes it to one shape. Public status APIs,
// no auth — the daemon proxies so the browser never faces the pages' CORS /
// X-Frame-Options quirks. Short in-memory cache per provider (no disk: status
// is ephemeral, unlike usage).
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

async function fetchWithTimeout(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQ_TIMEOUT_MS);
  try { return await fetch(url, { signal: ctrl.signal }); }
  finally { clearTimeout(timer); }
}

async function fetchProvider(provider) {
  let resp;
  try {
    resp = await fetchWithTimeout(`${provider.url}/api/v2/summary.json`);
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

const cache = Object.fromEntries(STATUS_PROVIDERS.map((p) => [p.key, { data: null, at: 0 }]));

async function pull(provider, force) {
  const slot = cache[provider.key];
  if (!force && slot.data && Date.now() - slot.at < TTL) return slot.data;
  const data = { ...(await fetchProvider(provider)), fetchedAt: new Date().toISOString() };
  // Keep last good payload on a transient failure (a blip shouldn't flip the UI
  // to "error"), but always overwrite with a fresh successful pull.
  if (data.ok || !slot.data) { slot.data = data; slot.at = Date.now(); }
  return slot.data;
}

export async function getStatus({ force = false } = {}) {
  const out = {};
  for (const p of STATUS_PROVIDERS) out[p.key] = await pull(p, force);
  return out;
}