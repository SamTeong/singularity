// Codex config.toml editor backend — mirrors server/config.mjs for Codex's
// config.toml (project + user scopes). Codex has no config.local.toml upstream,
// so only the project (.codex/config.toml) and user (~/.codex/config.toml)
// scopes are exposed. Paths are derived server-side from (cwd, scope) — the
// client never supplies a path. Writes validate TOML (via @iarna/toml) and back
// up the existing file to .bak before overwriting.
import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname, resolve, sep, normalize } from 'node:path';
import { homedir } from 'node:os';
import { parse as tomlParse } from '@iarna/toml';
import { STATE_DIR } from './app-dir.mjs';

const CODEX_HOME = process.env.CODEX_HOME || join(homedir(), '.codex');

function scopePaths(cwd) {
  return {
    user: join(CODEX_HOME, 'config.toml'),
    project: join(cwd, '.codex', 'config.toml'),
  };
}

// Both scopes are editable (project + user). No config.local.toml analog.
const EDIT_SCOPES = ['project', 'user'];

export function readConfig(cwd) {
  if (!isKnownConfigRoot(cwd)) {
    // cwd is outside known roots; return empty configs to prevent information disclosure
    const paths = scopePaths(cwd);
    const out = {};
    for (const scope of EDIT_SCOPES) {
      out[scope] = { path: paths[scope], exists: false, content: '' };
    }
    return out;
  }
  const paths = scopePaths(cwd);
  const out = {};
  for (const scope of EDIT_SCOPES) {
    const p = paths[scope];
    const exists = existsSync(p);
    out[scope] = { path: p, exists, content: exists ? readFileSync(p, 'utf8') : '' };
  }
  return out;
}

// Search config.toml content across the given roots. Dedup by path (same root
// passed twice → one hit). Returns first matching line per file with a trimmed
// snippet.
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

// Recursively walk `root` for dirs holding .codex/config.toml. Bounded (dir cap)
// so a huge tree can't hang the daemon; skips noise dirs + all dotdirs (except
// detecting .codex itself). Returns matching cwd's (the dir that holds .codex),
// sorted, + a truncated flag.
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
    if (ents.some((e) => e.name === '.codex')) {
      if (existsSync(scopePaths(dir).project)) hits.push(dir);
    }
    for (const e of ents) {
      if (e.isDirectory() && !e.name.startsWith('.') && !SCAN_SKIP.has(e.name)) stack.push(join(dir, e.name));
    }
  }
  return { roots: hits.sort((a, b) => a.localeCompare(b)), truncated: seen >= cap };
}

// Config root list: the picker's pinned roots. FS-persisted (survives browser
// cache clear) under STATE_DIR. Seeded with '~' when absent/empty.
const ROOTS_FILE = join(STATE_DIR, 'codex-config-roots.json');
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

// Resolve a ~-prefixed client path to an absolute one (mirror rules.mjs resolveRoot).
function resolveRoot(raw) {
  if (!raw) return null;
  let p = raw;
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) p = normalize(homedir() + p.slice(1));
  try { return resolve(p); } catch { return null; }
}

// A write target's cwd must resolve under one of the pinned config roots
// (getConfigRoots) — mirrors config.mjs isKnownConfigRoot so the editor can't
// be pointed at an arbitrary directory to plant a config.toml.
function isKnownConfigRoot(cwd) {
  if (!cwd) return false;
  const abs = resolve(cwd);
  return getConfigRoots().some((raw) => {
    const root = resolveRoot(raw);
    return root && (abs === root || abs.startsWith(root + sep));
  });
}

export function writeConfig(cwd, scope, content) {
  if (!EDIT_SCOPES.includes(scope)) return { ok: false, error: 'bad scope' };
  if (!isKnownConfigRoot(cwd)) return { ok: false, error: 'cwd outside config roots' };
  // Enforce the client's cwd→scope mapping: 'user' only for cwd ~ (home),
  // 'project' only for a non-home cwd. Otherwise a project-scope write with
  // cwd ~ would target ~/.codex/config.toml (the user file) and vice versa.
  const isHome = resolve(cwd) === resolve(homedir());
  if (scope === 'user' && !isHome) return { ok: false, error: 'user scope requires cwd ~' };
  if (scope === 'project' && isHome) return { ok: false, error: 'project scope requires a non-home cwd' };
  const paths = scopePaths(cwd);
  const p = paths[scope];
  try { tomlParse(content); } catch (e) { return { ok: false, error: `invalid TOML: ${e.message}` }; }
  try {
    if (existsSync(p)) copyFileSync(p, `${p}.bak`);
    else mkdirSync(dirname(p), { recursive: true }); // first write of a project scope
    writeFileSync(p, content);
    return { ok: true, backup: existsSync(`${p}.bak`), path: p };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}