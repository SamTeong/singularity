// Config editor backend: resolve the 3 settings.json scopes for a cwd,
// read them, and write with a backup (backups.mjs) + JSON validation. Paths
// are derived server-side from (cwd, scope) — the client never supplies a path.
import { existsSync, mkdirSync, statSync } from 'node:fs';
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
let configReadBackend = null;
export function setConfigReadBackend(backend) { configReadBackend = backend; }
function requireConfigReadBackend(backend = configReadBackend) {
  if (!backend) throw new Error('Rust config read backend is not configured');
  return backend;
}

export async function claudeTheme(backend = configReadBackend) {
  try {
    const t = JSON.parse((await requireConfigReadBackend(backend).configRead(scopePaths('').user)).content).theme;
    return typeof t === 'string' && t.toLowerCase().includes('light') ? 'light' : 'dark';
  } catch { return 'dark'; }
}

// Editor exposes project + project-local only. User settings.json is shared,
// versioned config edited elsewhere — not through this UI.
const EDIT_SCOPES = ['project', 'local'];

export async function readConfig(cwd, backend = configReadBackend) {
  const paths = scopePaths(cwd);
  const out = {};
  for (const scope of EDIT_SCOPES) {
    const p = paths[scope];
    const file = await requireConfigReadBackend(backend).configRead(p);
    out[scope] = { path: p, exists: file.exists, content: file.content, mtime: file.mtime };
  }
  return out;
}

// Search settings.json/settings.local.json content across the given roots.
// Dedup by path (same root passed twice → one hit). Returns first matching line
// per file with a trimmed snippet.
export async function searchConfig(roots, q, backend = configReadBackend) {
  const needle = String(q || '').toLowerCase();
  if (!needle) return [];
  const scans = [];
  for (const cwd of roots || []) {
    try {
      const paths = scopePaths(cwd);
      scans.push({ cwd, project: paths.project, local: paths.local });
    } catch { continue; } // a bad root is skipped, as before the Rust move
  }
  return requireConfigReadBackend(backend).configSearch(scans, needle);
}

// Recursively walk `root` for dirs holding .claude/settings.json or
// settings.local.json. Bounded (dir cap) so a huge tree can't hang the daemon;
// skips noise dirs + all dotdirs (except detecting .claude itself). Returns
// matching cwd's (the dir that holds .claude), sorted, + a truncated flag.
export async function findConfigRoots(root, cap = 20000, backend = configReadBackend) {
  return requireConfigReadBackend(backend).configScan(root, cap);
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
