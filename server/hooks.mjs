// Hooks editor backend: list + read + write hook script files under a root's
// .claude/hooks/ directory (raw file content, not settings.json). Client-supplied
// paths are guarded to resolve under ONE of the configured hook roots'
// <root>/.claude/hooks — mirror rules.mjs isRulePath / memory.mjs isMemoryPath
// (resolve-then-containment against known roots), not a bare path-segment check
// (which can't stop a write to ANY */.claude/hooks/ on the machine — hooks are
// auto-executed by Claude). Roots are an independent FS-persisted list under STATE_DIR.
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join, sep, resolve, normalize } from 'node:path';
import { homedir } from 'node:os';
import { STATE_DIR } from './app-dir.mjs';
import { backupFile } from './backups.mjs';

// Resolve a ~-prefixed client path to an absolute one (mirror rules.mjs resolveRoot).
function resolveRoot(raw) {
  if (!raw) return null;
  let p = raw;
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) p = normalize(homedir() + p.slice(1));
  try { return resolve(p); } catch { return null; }
}

// The hooks dir for a picked base root: <base>/.claude/hooks (absolute).
function hooksDir(base) {
  const r = resolveRoot(base);
  return r ? resolve(join(r, '.claude', 'hooks')) : null;
}

// A client path must resolve under one of the configured hook roots' hooksDir.
// Resolve first so `..` is collapsed (a raw string can contain the right segment
// yet climb out of it), then test the RESOLVED absolute path against every
// known root. Returns the resolved path on success, else null.
function guard(path) {
  if (typeof path !== 'string' || !path) return null;
  const abs = resolve(path);
  const inRoot = getHookRoots().some((raw) => {
    const dir = hooksDir(raw);
    return dir && (abs === dir || abs.startsWith(dir + sep));
  });
  return inRoot ? abs : null;
}

// Scan pair handed to Rust: the verbatim client cwd + its <cwd>/.claude/hooks
// dir (joined here, unresolved, exactly as the Node walk did).
const scan = (cwd) => ({ root: cwd, dir: join(cwd, '.claude', 'hooks') });

// Bounded recursive walk of each <cwd>/.claude/hooks (Rust hooks_read.rs) —
// files only, sorted by rel per cwd. Missing dir → no files.
export function listHookGroups(roots, backend) {
  return backend.hooksList((roots || []).map(scan));
}

// Search hook file content across roots (Rust). First matching line per file →
// { cwd, path, rel, line, text } (trimmed snippet). Dedup by path, sorted by path.
export async function searchHooks(roots, q, backend) {
  const needle = String(q || '');
  if (!needle) return [];
  return backend.hooksSearch([...(roots || [])].map(scan), needle);
}

// Node keeps the root guard; the read itself runs in Rust.
export async function readHook(path, backend) {
  const abs = guard(path);
  if (!abs) return { path, exists: false, error: 'bad path' };
  return { path: abs, ...await backend.hooksRead(abs) };
}

// Write raw content back with a backup (mirror writeConfig). No JSON
// validation — hook files are scripts, not JSON.
export async function writeHook(path, content, mtime, force, backend, logger) {
  const abs = guard(path);
  if (!abs) return { ok: false, error: 'bad path' };
  try {
    if (mtime != null && !force && existsSync(abs) && Math.abs(statSync(abs).mtimeMs - mtime) > 1) {
      return { ok: false, error: 'changed on disk' };
    }
    const backup = await backupFile(abs);
    // Re-check: backupFile's await can yield to a concurrent save of this
    // same path landing in between, which the first check (above) can't see.
    if (mtime != null && !force && existsSync(abs) && Math.abs(statSync(abs).mtimeMs - mtime) > 1) {
      return { ok: false, error: 'changed on disk' };
    }
    if (typeof content !== 'string') return { ok: false, error: 'content must be a string' };
    let result;
    try { result = await backend.hooksWrite(abs, content, mtime, force); }
    catch (e) {
      logger?.error({ err: e.message }, 'Rust Hooks write backend failed');
      return { ok: false, error: 'hook write failed' };
    }
    if (!result.ok) {
      if (result.error === 'changed on disk') return result;
      logger?.error({ err: result.error }, 'Rust Hooks write backend failed');
      return { ok: false, error: 'hook write failed' };
    }
    return { ...result, backup, path: abs };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Hook root list: FS-persisted under STATE_DIR, seeded with '~', capped 50.
const ROOTS_FILE = join(STATE_DIR, 'hook-roots.json');
export function getHookRoots() {
  try {
    const r = JSON.parse(readFileSync(ROOTS_FILE, 'utf8'));
    return Array.isArray(r) && r.length ? r : ['~'];
  } catch { return ['~']; }
}
export function setHookRoots(roots) {
  const clean = [...new Set((roots || []).filter((r) => typeof r === 'string' && r))].slice(0, 50);
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(ROOTS_FILE, JSON.stringify(clean, null, 2));
    return { ok: true, roots: clean };
  } catch (e) { return { ok: false, error: e.message }; }
}
