// Rebindable keyboard shortcuts: persists only the user's OVERRIDES of key
// bindings, keyed by action id. The action registry (which ids exist, their
// default bindings, labels, scopes) lives client-side and can grow or change
// freely — this module never needs to know an action name, only that an id
// string looks plausible. Patches are arbitrary client JSON, so every field
// is validated before it reaches disk.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_DIR } from './app-dir.mjs';

const STATE_FILE = join(STATE_DIR, 'keys.json');
const ID_RE = /^[a-z][a-zA-Z0-9]{0,32}$/;
const MODIFIERS = ['alt', 'ctrl', 'shift', 'meta', 'mod'];
const MAX_ENTRIES = 64;

export function getKeys() {
  try {
    const s = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    return (s && typeof s === 'object' && !Array.isArray(s)) ? s : {};
  } catch { return {}; }
}

function sanitiseEntry(v) {
  if (v === null) return null;
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const out = {};
  if (typeof v.key === 'string' && v.key.length >= 1 && v.key.length <= 32) out.key = v.key;
  if (typeof v.doubleTap === 'string' && v.doubleTap.length >= 1 && v.doubleTap.length <= 16) out.doubleTap = v.doubleTap;
  for (const m of MODIFIERS) if (typeof v[m] === 'boolean') out[m] = v[m];
  if (!out.key && !out.doubleTap) return undefined;
  return out;
}

export function setKeys(patch) {
  const next = { ...getKeys() };
  if (patch && typeof patch === 'object' && !Array.isArray(patch)) {
    for (const [id, value] of Object.entries(patch)) {
      if (!ID_RE.test(id)) continue;
      const entry = sanitiseEntry(value);
      if (entry === null) delete next[id];
      else if (entry !== undefined) next[id] = entry;
    }
  }
  const capped = Object.fromEntries(Object.entries(next).slice(0, MAX_ENTRIES));
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(capped));
    return { ok: true, keys: capped };
  } catch (e) { return { ok: false, error: e.message }; }
}
