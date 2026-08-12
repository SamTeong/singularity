// Core routes: the shell's boot-time and singleton endpoints. Every panel
// that renders on first paint depends on at least one of these — /capabilities
// drives the feature hints, /keys arms the keyboard, /models populates the
// task dialog, /health is polled for restart detection. These shapes mirror
// server/index.mjs exactly (design.md D8): bare objects with no `ok` wrapper
// (the daemon has no `ok` on any of these).
import { db } from '../db.js';
import { FAKE_HOME } from '../fixtures.js';

export function registerCore(server) {
  // /health — { ok, pid, clients }. The daemon reports live WS client count; the
  // mock has one WS server, so clients is the count of connected sockets at call
  // time. AppShell's restart loop polls this and reloads once the pid changes —
  // under the mock the pid never changes, but /restart is a no-op below, so the
  // loop times out harmlessly.
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

  // /models — claude aliases + ollama presets + codex presets. ModelSelect and
  // CreateTaskDialog fetch this on first open; the mock ships the same lists as
  // the daemon (models.mjs) so the dropdowns render their real options.
  server.get('/models', () => ({
    claude: ['claude', 'best', 'fable', 'opus', 'sonnet', 'haiku', 'opus[1m]', 'sonnet[1m]', 'opusplan'],
    ollama: ['deepseek-v4-flash:cloud', 'glm-5.2:cloud', 'kimi-k2.7-code:cloud'],
    codex: ['gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.4-pro'],
  }));

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
  server.post('/restart', () => ({ ok: true }));
}