// Config editor backend: resolve the 3 settings.json scopes for a cwd,
// read them, and write with a backup (backups.mjs) + JSON validation. Paths
// are derived server-side from (cwd, scope) — the client never supplies a path.
import { existsSync, readFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve, sep, normalize } from 'node:path';
import { homedir } from 'node:os';
import { STATE_DIR } from './app-dir.mjs';
import { backupFile } from './backups.mjs';

function scopePaths(cwd) {
  // The ~ root is stored as the literal string '~' (useRootList initial), so
  // expand it before joining — otherwise project/local resolve to a literal
  // '~/.claude/...' path that existsSync can never find (mirrors resolveRoot).
  let c = cwd;
  if (c === '~' || c.startsWith('~/') || c.startsWith('~\\')) c = normalize(homedir() + c.slice(1));
  return {
    user: join(homedir(), '.claude', 'settings.json'),
    project: join(c, '.claude', 'settings.json'),
    local: join(c, '.claude', 'settings.local.json'),
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
    out[scope] = { path: p, exists, content: exists ? readFileSync(p, 'utf8') : '', mtime: exists ? statSync(p).mtimeMs : 0 };
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

// Config root list: the picker's pinned roots, persisted by Rust under STATE_DIR.
const ROOTS_FILE = join(STATE_DIR, 'config-roots.json');
let rootsBackend = null;
export function setConfigRootsBackend(backend) { rootsBackend = backend; }
export async function getConfigRoots(backend = rootsBackend) {
  if (!backend) throw new Error('Rust picker roots backend is not configured');
  return backend.pickerRootsGet(ROOTS_FILE);
}
export async function setConfigRoots(roots, backend = rootsBackend) {
  if (!backend) throw new Error('Rust picker roots backend is not configured');
  return backend.pickerRootsSet(ROOTS_FILE, roots);
}
export function createConfigRootsGetHandler(backend) {
  return async () => ({ roots: await getConfigRoots(backend) });
}
export function createConfigRootsSetHandler(backend) {
  return async (req) => setConfigRoots(req.body?.roots, backend);
}

// Resolve a ~-prefixed client path to an absolute one (mirror rules.mjs resolveRoot).
function resolveRoot(raw) {
  if (!raw) return null;
  let p = raw;
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) p = normalize(homedir() + p.slice(1));
  try { return resolve(p); } catch { return null; }
}

// A write target's cwd must resolve under one of the pinned config roots
// (getConfigRoots) — mirrors rules.mjs isRulePath / memory.mjs isMemoryPath so
// the editor can't be pointed at an arbitrary directory to plant a
// settings.json Claude will auto-execute (hooks/permissions) on next run there.
async function isKnownConfigRoot(cwd) {
  if (!cwd) return false;
  const abs = resolveRoot(cwd); // untildify '~' → home (resolve(cwd) would leave '~' literal)
  if (!abs) return false;
  return (await getConfigRoots()).some((raw) => {
    const root = resolveRoot(raw);
    return root && (abs === root || abs.startsWith(root + sep));
  });
}

export async function writeConfig(cwd, scope, content, mtime, force, backend, logger) {
  if (!EDIT_SCOPES.includes(scope)) return { ok: false, error: 'bad scope' };
  if (!await isKnownConfigRoot(cwd)) return { ok: false, error: 'cwd outside config roots' };
  const paths = scopePaths(cwd);
  const p = paths[scope];
  try { JSON.parse(content); } catch (e) { return { ok: false, error: `invalid JSON: ${e.message}` }; }
  let backup;
  try {
    if (mtime != null && !force && existsSync(p) && Math.abs(statSync(p).mtimeMs - mtime) > 1) {
      return { ok: false, error: 'changed on disk' };
    }
    backup = await backupFile(p);
    if (!backup) mkdirSync(dirname(p), { recursive: true }); // first write of a project scope
    // Re-check: backupFile's await can yield to a concurrent save of this
    // same path landing in between, which the first check (above) can't see.
    if (mtime != null && !force && existsSync(p) && Math.abs(statSync(p).mtimeMs - mtime) > 1) {
      return { ok: false, error: 'changed on disk' };
    }
  } catch (e) {
    return { ok: false, error: e.message };
  }
  try {
    const result = await backend.configWrite(p, content, mtime, force);
    if (!result.ok && result.error !== 'changed on disk') {
      logger?.error({ err: result.error }, 'Rust Config write backend failed');
      return { ok: false, error: 'config write failed' };
    }
    return result.ok ? { ...result, backup, path: p } : result;
  } catch (e) {
    logger?.error({ err: e.message }, 'Rust Config write backend failed');
    return { ok: false, error: 'config write backend unavailable' };
  }
}
