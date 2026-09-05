// User-managed model list: FS-persisted under STATE_DIR, same read-on-every-get
// pattern as config-state.mjs. The file is the source of truth once seeded —
// SEED below only supplies the first-boot document and the "restore defaults"
// merge set.
//
// Imports are deliberately limited to node:fs, node:path and app-dir.mjs. This
// module is destined to be imported by models.mjs (which agents.mjs imports), so
// it must not pull in agents.mjs: that module loads node-pty and resolves
// CLAUDE_BIN at import time, before index.mjs's requireEnv runs. Hence the
// inlined atomic write rather than agents.mjs's writeAtomic — same reason
// migrate-state.mjs inlines its own.
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_DIR } from './app-dir.mjs';

const STATE_FILE = join(STATE_DIR, 'models.json');

const GROUPS = new Set(['claude', 'ollama', 'codex']);
const MAX_MODELS = 200;
const MAX_LABEL = 80;

// Shipped defaults: the claude aliases (mirror /model) + ollama presets + codex
// presets, with the friendly claude names that used to live client-side in
// ModelSelect.jsx's CLAUDE_NAMES map. Non-claude entries render their id bare,
// which is what an empty label means. Exported: models.mjs derives its
// free-text floor set (the shipped claude ids) from this one copy of the list.
export const SEED = {
  models: [
    { id: 'claude', group: 'claude', label: 'Default', enabled: true },
    { id: 'best', group: 'claude', label: 'Best available', enabled: true },
    { id: 'fable', group: 'claude', label: 'Fable', enabled: true },
    { id: 'opus', group: 'claude', label: 'Opus', enabled: true },
    { id: 'sonnet', group: 'claude', label: 'Sonnet', enabled: true },
    { id: 'haiku', group: 'claude', label: 'Haiku', enabled: true },
    { id: 'opus[1m]', group: 'claude', label: 'Opus (1M context)', enabled: true },
    { id: 'sonnet[1m]', group: 'claude', label: 'Sonnet (1M context)', enabled: true },
    { id: 'opusplan', group: 'claude', label: 'Opus in plan mode, Sonnet after', enabled: true },
    { id: 'deepseek-v4-flash:cloud', group: 'ollama', label: '', enabled: true },
    { id: 'glm-5.2:cloud', group: 'ollama', label: '', enabled: true },
    { id: 'glm-5.3:cloud', group: 'ollama', label: '', enabled: true },
    { id: 'glm-5.3-flash:cloud', group: 'ollama', label: '', enabled: true },
    { id: 'kimi-k2.7-code:cloud', group: 'ollama', label: '', enabled: true },
    { id: 'kimi-k3:cloud', group: 'ollama', label: '', enabled: true },
    { id: 'gpt-5.6-luna', group: 'codex', label: '', enabled: true },
    { id: 'gpt-5.6-sol', group: 'codex', label: '', enabled: true },
    { id: 'gpt-5.6-terra', group: 'codex', label: '', enabled: true },
    { id: 'gpt-5.4', group: 'codex', label: '', enabled: true },
    { id: 'gpt-5.4-mini', group: 'codex', label: '', enabled: true },
    { id: 'gpt-5.4-pro', group: 'codex', label: '', enabled: true },
  ],
  // 'claude' is the alias that means "CLI default" — seeding it keeps today's
  // behaviour. 'deepseek-v4-flash:cloud' is what history.mjs's OLLAMA_PRESETS[0]
  // resolves to today, made explicit instead of positional.
  defaultModel: 'claude',
  summariserModel: 'deepseek-v4-flash:cloud',
};

const seedDoc = () => JSON.parse(JSON.stringify(SEED));

function persist(doc) {
  mkdirSync(STATE_DIR, { recursive: true });
  const tmp = `${STATE_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(doc, null, 2));
  renameSync(tmp, STATE_FILE);
}

// Validate a whole document. Returns { ok:true, state } with every entry
// normalized (trimmed id, string label, boolean enabled) or { ok:false, error }.
function validate(doc) {
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.models)) return { ok: false, error: 'models must be an array' };
  if (doc.models.length > MAX_MODELS) return { ok: false, error: `too many models (max ${MAX_MODELS})` };
  const models = [];
  const seen = new Set();
  for (const m of doc.models) {
    if (!m || typeof m.id !== 'string') return { ok: false, error: 'every model needs a string id' };
    const id = m.id.trim();
    if (!id) return { ok: false, error: 'model id must not be empty' };
    if (seen.has(id)) return { ok: false, error: `duplicate model id '${id}'` };
    seen.add(id);
    if (!GROUPS.has(m.group)) return { ok: false, error: `unknown group '${m.group}' for '${id}'` };
    // web/src/lib/models.js mirrors isCodexModel with a bare gpt- prefix check
    // (it runs before /models resolves), so a non-gpt codex id misroutes client-side.
    if (m.group === 'codex' && !id.startsWith('gpt-')) return { ok: false, error: `codex model '${id}' must be a gpt-* id` };
    const label = typeof m.label === 'string' ? m.label : '';
    if (label.length > MAX_LABEL) return { ok: false, error: `label too long for '${id}' (max ${MAX_LABEL})` };
    models.push({ id, group: m.group, label, enabled: m.enabled !== false });
  }
  const defaultModel = typeof doc.defaultModel === 'string' ? doc.defaultModel.trim() : '';
  if (defaultModel && !models.some((m) => m.id === defaultModel && m.enabled)) {
    return { ok: false, error: `defaultModel '${defaultModel}' is not an enabled model` };
  }
  const summariserModel = typeof doc.summariserModel === 'string' ? doc.summariserModel.trim() : '';
  if (summariserModel && !models.some((m) => m.id === summariserModel && m.enabled)) {
    return { ok: false, error: `summariserModel '${summariserModel}' is not an enabled model` };
  }
  return { ok: true, state: { models, defaultModel, summariserModel } };
}

// The whole document, seeding the file on first call. A file that exists but is
// unreadable/corrupt degrades to the seed in memory without clobbering it —
// same "degrade, never crash" rule the other stores follow.
export function getModels() {
  try {
    const parsed = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    const r = validate(parsed);
    if (r.ok) return r.state;
  } catch { /* absent or corrupt — fall through to the seed */ }
  const seed = seedDoc();
  if (!existsSync(STATE_FILE)) {
    try { persist(seed); } catch { /* read-only state dir: still serve the seed */ }
  }
  return seed;
}

export function setModels(doc) {
  const r = validate(doc);
  if (!r.ok) return r;
  try {
    persist(r.state);
    return { ok: true, state: r.state };
  } catch (e) { return { ok: false, error: e.message }; }
}

// Re-add any shipped id the user deleted, appended in seed order. Existing
// entries (including renamed labels, disabled flags and order) are untouched.
export function restoreDefaults() {
  const cur = getModels();
  const have = new Set(cur.models.map((m) => m.id));
  const next = { ...cur, models: [...cur.models, ...seedDoc().models.filter((m) => !have.has(m.id))] };
  const r = setModels(next);
  return r.ok ? r.state : cur;
}

// 'claude' | 'ollama' | 'codex', or null when the id is not in the store
// (free-text passthrough — callers fall back to their own heuristic).
export function groupFor(id) {
  return getModels().models.find((m) => m.id === id)?.group ?? null;
}

export function listEnabled() {
  return getModels().models.filter((m) => m.enabled);
}

export function getSummariserModel() {
  return getModels().summariserModel;
}

// { id, group } for the configured summariser, or null when unset or when the
// id no longer resolves to an entry in the store.
export function getSummariser() {
  const { summariserModel, models } = getModels();
  if (!summariserModel) return null;
  const m = models.find((m) => m.id === summariserModel);
  return m ? { id: m.id, group: m.group } : null;
}

export function getDefaultModel() {
  return getModels().defaultModel;
}
