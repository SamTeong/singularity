// Config editor UI state (open tabs/active/autosave/expanded roots): FS-persisted
// under STATE_DIR, same pattern as explorer.mjs's STATE_FILE. Tabs store the
// (cwd, tool, scope) triple plus the derived `path` (display + tab identity);
// storing the triple is what lets a restore re-resolve correctly after a
// rename/move, since the path is derived server-side from (cwd, scope).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_DIR } from './app-dir.mjs';

const STATE_FILE = join(STATE_DIR, 'config-state.json');
const DEFAULT_STATE = { tabs: [], active: null, autosave: false, expanded: [] };

export function getConfigState() {
  try {
    const s = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    return { ...DEFAULT_STATE, ...s };
  } catch { return { ...DEFAULT_STATE }; }
}

function tabArray(v) {
  if (!Array.isArray(v)) return undefined;
  const out = [];
  for (const t of v) {
    if (!t || typeof t.cwd !== 'string' || typeof t.tool !== 'string' || typeof t.scope !== 'string') continue;
    out.push({ cwd: t.cwd, tool: t.tool, scope: t.scope, path: typeof t.path === 'string' ? t.path : '' });
  }
  return out.slice(0, 50);
}

function strArray(v) {
  return Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, 500) : undefined;
}

export function setConfigState(patch) {
  const cur = getConfigState();
  const next = { ...cur };
  const tabs = tabArray(patch?.tabs);
  if (tabs) next.tabs = tabs;
  if (patch && (typeof patch.active === 'string' || patch.active === null)) next.active = patch.active;
  if (patch && typeof patch.autosave === 'boolean') next.autosave = patch.autosave;
  const expanded = strArray(patch?.expanded);
  if (expanded) next.expanded = expanded;
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(next));
    return { ok: true, state: next };
  } catch (e) { return { ok: false, error: e.message }; }
}