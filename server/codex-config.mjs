// Codex config.toml editor backend — mirrors server/config.mjs for Codex's
// config.toml (project + user scopes). Codex has no config.local.toml upstream,
// so only the project (.codex/config.toml) and user (~/.codex/config.toml)
// scopes are exposed. Paths are derived server-side from (cwd, scope) — the
// client never supplies a path. Writes validate TOML (via @iarna/toml) and back
// up the existing file (backups.mjs) before overwriting.
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname, resolve, sep, normalize } from 'node:path';
import { homedir } from 'node:os';
import { parse as tomlParse } from '@iarna/toml';
import { STATE_DIR } from './app-dir.mjs';
import { backupFile } from './backups.mjs';

const CODEX_HOME = process.env.CODEX_HOME || join(homedir(), '.codex');

function scopePaths(cwd) {
  return {
    user: join(CODEX_HOME, 'config.toml'),
    project: join(cwd, '.codex', 'config.toml'),
  };
}

// Both scopes are editable (project + user). No config.local.toml analog.
const EDIT_SCOPES = ['project', 'user'];
let configReadBackend = null;
export function setCodexConfigReadBackend(backend) { configReadBackend = backend; }

function requireCodexConfigReadBackend(backend = configReadBackend) {
  if (!backend) throw new Error('Rust Codex config read backend is not configured');
  return backend;
}

export async function readConfig(cwd) {
  const backend = requireCodexConfigReadBackend();
  const paths = scopePaths(cwd);
  if (!await isKnownConfigRoot(cwd)) {
    // cwd is outside known roots; return empty configs to prevent information disclosure
    const out = {};
    for (const scope of EDIT_SCOPES) {
      out[scope] = { path: paths[scope], exists: false, content: '', mtime: 0 };
    }
    return out;
  }
  const out = {};
  for (const scope of EDIT_SCOPES) {
    const p = paths[scope];
    out[scope] = { path: p, ...await backend.codexConfigRead(p) };
  }
  return out;
}

// Search config.toml content across the given roots. Dedup by path (same root
// passed twice → one hit). Returns first matching line per file with a trimmed
// snippet.
export async function searchConfig(roots, q) {
  const needle = String(q || '').toLowerCase();
  if (!needle) return [];
  const backend = requireCodexConfigReadBackend();
  const authorized = [];
  for (const cwd of roots || []) {
    if (!await isKnownConfigRoot(cwd)) continue;
    const paths = scopePaths(cwd);
    authorized.push({ cwd, project: paths.project, user: paths.user });
  }
  // Stable order (by path) so clicking a hit — which reorders recent (MRU) and
  // re-runs the search — doesn't reshuffle the list under the cursor.
  return backend.codexConfigSearch(authorized, needle);
}

// Recursively walk `root` for dirs holding .codex/config.toml. Bounded (dir cap)
// so a huge tree can't hang the daemon; skips noise dirs + all dotdirs (except
// detecting .codex itself). Returns matching cwd's (the dir that holds .codex),
// sorted, + a truncated flag.
export async function findConfigRoots(root, cap = 20000, backend = configReadBackend) {
  return requireCodexConfigReadBackend(backend).codexConfigScan(root, cap);
}

// Config root list: the picker's pinned roots, persisted by Rust under STATE_DIR.
const ROOTS_FILE = join(STATE_DIR, 'codex-config-roots.json');
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
// (getConfigRoots) — mirrors config.mjs isKnownConfigRoot so the editor can't
// be pointed at an arbitrary directory to plant a config.toml.
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
  // Enforce the client's cwd→scope mapping: 'user' only for cwd ~ (home),
  // 'project' only for a non-home cwd. Otherwise a project-scope write with
  // cwd ~ would target ~/.codex/config.toml (the user file) and vice versa.
  const isHome = resolveRoot(cwd) === resolve(homedir()); // untildify so cwd '~' reads as home
  if (scope === 'user' && !isHome) return { ok: false, error: 'user scope requires cwd ~' };
  if (scope === 'project' && isHome) return { ok: false, error: 'project scope requires a non-home cwd' };
  const paths = scopePaths(cwd);
  const p = paths[scope];
  try { tomlParse(content); } catch (e) { return { ok: false, error: `invalid TOML: ${e.message}` }; }
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
    const result = await backend.codexConfigWrite(p, content, mtime, force);
    if (!result.ok && result.error !== 'changed on disk') {
      logger?.error({ err: result.error }, 'Rust Codex Config write backend failed');
      return { ok: false, error: 'codex config write failed' };
    }
    return result.ok ? { ...result, backup, path: p } : result;
  } catch (e) {
    logger?.error({ err: e.message }, 'Rust Codex Config write backend failed');
    return { ok: false, error: 'codex config write backend unavailable' };
  }
}
