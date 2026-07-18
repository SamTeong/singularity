// Config editor backend: resolve the 3 settings.json scopes for a cwd,
// read them, and write with a .bak backup + JSON validation. Paths are derived
// server-side from (cwd, scope) — the client never supplies a path.
import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync, lstatSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

function expandTilde(p) {
  return p === '~' || p.startsWith('~/') || p.startsWith('~\\') ? homedir() + p.slice(1) : p;
}

function scopePaths(cwd) {
  cwd = expandTilde(cwd);
  return {
    user: join(homedir(), '.claude', 'settings.json'),
    project: join(cwd, '.claude', 'settings.json'),
    local: join(cwd, '.claude', 'settings.local.json'),
  };
}

// Claude's own UI theme, resolved to light|dark — drives the embedded terminal
// palette so xterm's background matches what claude paints. Reads the global
// settings.json `theme`; 'light*' → light, everything else → dark. 'auto' lands
// here as dark: claude resolves auto by querying the terminal bg (OSC 11), which
// doesn't survive the Windows ConPTY round-trip, so claude renders dark.
export function claudeTheme() {
  try {
    const t = JSON.parse(readFileSync(scopePaths('').user, 'utf8')).theme;
    return typeof t === 'string' && t.toLowerCase().includes('light') ? 'light' : 'dark';
  } catch { return 'dark'; }
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
