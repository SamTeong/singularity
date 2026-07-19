// Config editor backend: resolve the 3 settings.json scopes for a cwd,
// read them, and write with a .bak backup + JSON validation. Paths are derived
// server-side from (cwd, scope) — the client never supplies a path.
import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { STATE_DIR } from './app-dir.mjs';

function scopePaths(cwd) {
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

// Editor exposes project + project-local only. User settings.json is shared,
// versioned config edited elsewhere — not through this UI.
const EDIT_SCOPES = ['project', 'local'];

export function readConfig(cwd) {
  const paths = scopePaths(cwd);
  const out = {};
  for (const scope of EDIT_SCOPES) {
    const p = paths[scope];
    const exists = existsSync(p);
    out[scope] = { path: p, exists, content: exists ? readFileSync(p, 'utf8') : '' };
  }
  return out;
}

// Search settings.json/settings.local.json content across the given roots.
// Dedup by path (same root passed twice → one hit). Returns first matching line
// per file with a trimmed snippet.
export function searchConfig(roots, q) {
  const needle = String(q || '').toLowerCase();
  if (!needle) return [];
  const seen = new Set();
  const results = [];
  for (const cwd of roots || []) {
    let cfg;
    try { cfg = readConfig(cwd); } catch { continue; }
    for (const scope of EDIT_SCOPES) {
      const { path, content } = cfg[scope];
      if (!content || seen.has(path)) continue;
      seen.add(path);
      const lines = content.split('\n');
      const i = lines.findIndex((l) => l.toLowerCase().includes(needle));
      if (i < 0) continue;
      results.push({ cwd, scope, path, line: i + 1, text: lines[i].trim().slice(0, 200) });
    }
  }
  // Stable order (by path) so clicking a hit — which reorders recent (MRU) and
  // re-runs the search — doesn't reshuffle the list under the cursor.
  return results.sort((a, b) => a.path.localeCompare(b.path));
}

// Recursively walk `root` for dirs holding .claude/settings.json or
// settings.local.json. Bounded (dir cap) so a huge tree can't hang the daemon;
// skips noise dirs + all dotdirs (except detecting .claude itself). Returns
// matching cwd's (the dir that holds .claude), sorted, + a truncated flag.
const SCAN_SKIP = new Set(['node_modules', 'dist', 'build', 'worktrees', '.cache', 'AppData', 'Temp']);
export function findConfigRoots(root, cap = 20000) {
  const hits = [];
  const stack = [root];
  let seen = 0;
  while (stack.length && seen < cap) {
    const dir = stack.pop();
    seen++;
    let ents;
    try { ents = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    if (ents.some((e) => e.name === '.claude')) {
      const c = scopePaths(dir);
      if (existsSync(c.project) || existsSync(c.local)) hits.push(dir);
    }
    for (const e of ents) {
      if (e.isDirectory() && !e.name.startsWith('.') && !SCAN_SKIP.has(e.name)) stack.push(join(dir, e.name));
    }
  }
  return { roots: hits.sort((a, b) => a.localeCompare(b)), truncated: seen >= cap };
}

// Config root list: the picker's pinned roots. FS-persisted (survives browser
// cache clear) under STATE_DIR. Seeded with '~' when absent/empty.
const ROOTS_FILE = join(STATE_DIR, 'config-roots.json');
export function getConfigRoots() {
  try {
    const r = JSON.parse(readFileSync(ROOTS_FILE, 'utf8'));
    return Array.isArray(r) && r.length ? r : ['~'];
  } catch { return ['~']; }
}
export function setConfigRoots(roots) {
  const clean = [...new Set((roots || []).filter((r) => typeof r === 'string' && r))].slice(0, 50);
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(ROOTS_FILE, JSON.stringify(clean, null, 2));
    return { ok: true, roots: clean };
  } catch (e) { return { ok: false, error: e.message }; }
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
