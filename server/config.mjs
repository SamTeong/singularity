// Config editor backend: resolve the 3 settings.json scopes for a cwd,
// read them, and write with a .bak backup + JSON validation. Paths are derived
// server-side from (cwd, scope) — the client never supplies a path.
import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync, lstatSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

function scopePaths(cwd) {
  return {
    user: join(homedir(), '.claude', 'settings.json'),
    project: join(cwd, '.claude', 'settings.json'),
    local: join(cwd, '.claude', 'settings.local.json'),
  };
}

export function readConfig(cwd) {
  const paths = scopePaths(cwd);
  const out = {};
  for (const [scope, p] of Object.entries(paths)) {
    const exists = existsSync(p);
    out[scope] = { path: p, exists, content: exists ? readFileSync(p, 'utf8') : '' };
  }
  // Guardrail signal: user settings may be a junction/symlink into versioned shared config.
  try { out.user.symlink = lstatSync(paths.user).isSymbolicLink(); } catch { out.user.symlink = false; }
  return out;
}

export function writeConfig(cwd, scope, content) {
  const paths = scopePaths(cwd);
  const p = paths[scope];
  if (!p) return { ok: false, error: 'bad scope' };
  try { JSON.parse(content); } catch (e) { return { ok: false, error: `invalid JSON: ${e.message}` }; }
  try {
    if (existsSync(p)) copyFileSync(p, `${p}.bak`);
    else mkdirSync(dirname(p), { recursive: true }); // first write of a project scope
    writeFileSync(p, content);
    return { ok: true, backup: existsSync(`${p}.bak`), path: p };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
