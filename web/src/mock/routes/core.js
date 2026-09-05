// Core routes: the shell's boot-time and singleton endpoints. Every panel
// that renders on first paint depends on at least one of these — /capabilities
// drives the feature hints, /keys arms the keyboard, /models populates the
// task dialog, /health is polled for restart detection. These shapes mirror
// server/index.mjs exactly (design.md D8): bare objects with no `ok` wrapper
// (the daemon has no `ok` on any of these).
import { Response } from 'miragejs';
import { db } from '../db.js';
import { FAKE_HOME } from '../fixtures.js';

// Shipped model defaults — a verbatim mirror of server/model-store.mjs's SEED.
// Mirage throws on unhandled requests, so this file is the mock suite's only
// copy of the model list; keep it in step with the daemon's.
const MODEL_SEED = {
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
  defaultModel: 'claude',
  summariserModel: 'deepseek-v4-flash:cloud',
};

// Exported so sibling route modules (sessions.js restoreOllamaTag) read the
// same editable document instead of a private literal copy.
export const modelsDoc = () => (db.ui.models ||= JSON.parse(JSON.stringify(MODEL_SEED)));

// Mirror of model-store.mjs's validate().
function validateModels(doc) {
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.models)) return { ok: false, error: 'models must be an array' };
  if (doc.models.length > 200) return { ok: false, error: 'too many models (max 200)' };
  const models = [];
  const seen = new Set();
  for (const m of doc.models) {
    if (!m || typeof m.id !== 'string') return { ok: false, error: 'every model needs a string id' };
    const id = m.id.trim();
    if (!id) return { ok: false, error: 'model id must not be empty' };
    if (seen.has(id)) return { ok: false, error: `duplicate model id '${id}'` };
    seen.add(id);
    if (!['claude', 'ollama', 'codex'].includes(m.group)) return { ok: false, error: `unknown group '${m.group}' for '${id}'` };
    if (m.group === 'codex' && !id.startsWith('gpt-')) return { ok: false, error: `codex model '${id}' must be a gpt-* id` };
    const label = typeof m.label === 'string' ? m.label : '';
    if (label.length > 80) return { ok: false, error: `label too long for '${id}' (max 80)` };
    models.push({ id, group: m.group, label, enabled: m.enabled !== false });
  }
  const defaultModel = typeof doc.defaultModel === 'string' ? doc.defaultModel.trim() : '';
  if (defaultModel && !models.some((m) => m.id === defaultModel && m.enabled)) return { ok: false, error: `defaultModel '${defaultModel}' is not an enabled model` };
  const summariserModel = typeof doc.summariserModel === 'string' ? doc.summariserModel.trim() : '';
  if (summariserModel && !models.some((m) => m.id === summariserModel && m.enabled)) return { ok: false, error: `summariserModel '${summariserModel}' is not an enabled model` };
  return { ok: true, state: { models, defaultModel, summariserModel } };
}

export function registerCore(server) {
  // /health — { ok, pid, clients }. The daemon reports live WS client count; the
  // mock has no live socket accounting, so clients is hardcoded to 0 here
  // (nothing in the UI reads it). AppShell's restart loop polls this and reloads
  // once the pid changes — under the mock the pid never changes, but /restart is
  // a no-op below, so the loop times out harmlessly.
  server.get('/health', () => ({ ok: true, pid: 1, clients: 0 }));

  // /capabilities — feature availability flags. The mock pretends every optional
  // feature is available so the hints never fire; the panels that gate on these
  // (Usage report, Skills scopes, Codex card) render their populated state.
  server.get('/capabilities', () => ({
    ollama:      { available: true, hint: 'Set OLLAMA_BIN in .env to enable Ollama model spawns.' },
    codex:       { available: true, hint: 'Run Codex CLI once to enable the Codex usage card.' },
    codexSpawn:  { available: true, hint: 'Set CODEX_BIN in .env to enable Codex agent/task spawns.' },
    skillScopes: { available: true, hint: 'Set SING_SCOPE_ROOT in .env to enable skill-scope picking.' },
    usageReport: { available: true, hint: 'Set SING_USAGE_SKILL + SING_USAGE_REPORTS in .env to enable the usage report.' },
    wiki:        { available: true, hint: 'Pick a wiki root in the Wiki panel to enable it.' },
    leanCtx:     { available: true, hint: 'Install the lean-ctx MCP server to enable compressed reads in task subagents.' },
    token:       { available: false, hint: 'Set SING_TOKEN in .env to require an auth token on data endpoints.' },
  }));

  // /env — { home }. The client no longer fetches this (home is injected into
  // index.html), but the daemon still serves it; keep parity so a future caller
  // doesn't hit an unhandled route. Returns FAKE_HOME, matching index.js.
  server.get('/env', () => ({ home: FAKE_HOME }));

  // /models — the user-managed model list. Mirrors server/model-store.mjs: the
  // daemon persists STATE_DIR/models.json, the mock keeps the same document in
  // db.ui.models for the page lifetime (the lazy db.ui.keys pattern). Returns
  // every entry incl. disabled ones — Settings needs them, the picker filters.
  server.get('/models', () => modelsDoc());

  // Whole-document replace, validated like model-store.mjs so the panel's
  // error path is exercisable under the mock.
  server.put('/models', (schema, req) => {
    let body = {};
    try { body = JSON.parse(req.requestBody || '{}') || {}; } catch {}
    const r = validateModels(body);
    if (!r.ok) return new Response(400, {}, r);
    db.ui.models = r.state;
    return r;
  });

  // Re-add any shipped default the user deleted, appended in seed order.
  server.post('/models/restore-defaults', () => {
    const doc = modelsDoc();
    const have = new Set(doc.models.map((m) => m.id));
    db.ui.models = { ...doc, models: [...doc.models, ...MODEL_SEED.models.filter((m) => !have.has(m.id)).map((m) => ({ ...m }))] };
    return { ok: true, state: db.ui.models };
  });

  // /keys — rebindable shortcut overrides. The mock persists nothing to disk,
  // so this starts empty and setKeys below mutates db.ui.keys in memory for the
  // page lifetime (spec: "Mutations persist for the lifetime of the page").
  server.get('/keys', () => ({ keys: db.ui.keys || {} }));
  server.put('/keys', (schema, req) => {
    let patch = {};
    try { patch = JSON.parse(req.requestBody || '{}') || {}; } catch {}
    const ID_RE = /^[a-z][a-zA-Z0-9]{0,32}$/;
    const MODIFIERS = ['alt', 'ctrl', 'shift', 'meta', 'mod'];
    const next = { ...(db.ui.keys || {}) };
    if (patch && typeof patch === 'object' && !Array.isArray(patch)) {
      for (const [id, value] of Object.entries(patch)) {
        if (!ID_RE.test(id)) continue;
        if (value === null) { delete next[id]; continue; }
        if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
        const out = {};
        if (typeof value.key === 'string' && value.key.length >= 1 && value.key.length <= 32) out.key = value.key;
        if (typeof value.doubleTap === 'string' && value.doubleTap.length >= 1 && value.doubleTap.length <= 16) out.doubleTap = value.doubleTap;
        for (const m of MODIFIERS) if (typeof value[m] === 'boolean') out[m] = value[m];
        if (!out.key && !out.doubleTap) continue;
        next[id] = out;
      }
    }
    // Cap like the daemon (keys.mjs MAX_ENTRIES=64) so GET never returns more
    // overrides than the real server would ever persist.
    const capped = Object.fromEntries(Object.entries(next).slice(0, 64));
    db.ui.keys = capped;
    return { ok: true, keys: capped };
  });

  // /skill-scopes — scope picker source. The daemon reads SING_SCOPE_ROOT; the
  // mock seeds two grouped scopes (coding/lint-guard, design/color-audit) from
  // fixtures so the picker renders a populated tree. skillsByScope maps each
  // scope to its skill names (listSkills's shape).
  server.get('/skill-scopes', () => {
    const scopes = ['coding', 'design'];
    const skillsByScope = {
      coding: ['lint-guard'],
      design: ['color-audit'],
    };
    return { scopes, skillsByScope };
  });

  // /claude/theme — resolved light|dark. The daemon reads ~/.claude/settings.json;
  // the mock has no settings file, so return 'dark' (the daemon's own fallback).
  server.get('/claude/theme', () => ({ theme: 'dark' }));

  // /restart — the daemon respawns itself detached and exits. The mock can't
  // respawn a browser tab, so this is a no-op that returns { ok: true } — the
  // AppShell restart loop will poll /health, see the same pid, and time out
  // harmlessly. Mirrors the daemon's own immediate reply (it exits after a
  // 100ms setTimeout).
  server.post('/restart', () => ({ ok: true }), 200);
}