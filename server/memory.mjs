// Memory backend: search + guarded read/write across per-project memory dirs
// (<root>/<encoded-cwd>/memory/*.md, default root ~/.claude/projects). Writes are
// confined to those dirs — a path outside any project's memory/ is rejected.
import { existsSync, readFileSync, writeFileSync, statSync, mkdirSync } from 'node:fs';
import { join, resolve, sep, normalize } from 'node:path';
import { homedir } from 'node:os';
import { STATE_DIR } from './app-dir.mjs';
import { backupFile } from './backups.mjs';
import { norm, contains } from './path-containment.mjs';

const DEFAULT_ROOT = join(homedir(), '.claude', 'projects');
let memoryReadBackend;
export function setMemoryReadBackend(backend) { memoryReadBackend = backend; }

// Memory root choice, FS-persisted (survives browser cache clear). Single value —
// the root holds one dir per project, each with a memory/ subdir. Defaults to
// ~/.claude/projects.
const ROOT_FILE = join(STATE_DIR, 'memory-root.json');
export function getMemoryRoot() {
  try { const r = JSON.parse(readFileSync(ROOT_FILE, 'utf8')).root; return typeof r === 'string' && r ? r : '~/.claude/projects'; }
  catch { return '~/.claude/projects'; }
}
export function setMemoryRoot(root) {
  if (typeof root !== 'string' || !root) return { ok: false, error: 'bad root' };
  try { mkdirSync(STATE_DIR, { recursive: true }); writeFileSync(ROOT_FILE, JSON.stringify({ root })); return { ok: true, root }; }
  catch (e) { return { ok: false, error: e.message }; }
}

// Resolve a ~-prefixed client path to an absolute one. Falls back to the
// FS-persisted root (then the default) when raw is empty.
export function resolveRoot(raw) {
  let p = raw || getMemoryRoot();
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) p = normalize(homedir() + p.slice(1));
  try { return resolve(p); } catch { return DEFAULT_ROOT; }
}

// Path guard: must resolve to <root>/<project>/memory/<...>.md, no escape.
// root must equal the server-persisted memory root (getMemoryRoot): trusting
// whatever root the caller/request supplies would let it invent a root that
// trivially "contains" any path, defeating containment (path-traversal via
// ?root=). resolveRoot already falls back to the persisted root when rootRaw
// is empty, so an omitted root still matches.
export function isMemoryPath(p, rootRaw) {
  if (!p) return false;
  const abs = resolve(p);
  const root = resolveRoot(rootRaw);
  const persisted = resolveRoot(getMemoryRoot());
  if (norm(root) !== norm(persisted)) return false;
  if (!contains(root, abs)) return false;
  const rel = abs.slice(root.length);
  const re = new RegExp(`^\\${sep}[^\\${sep}]+\\${sep}memory\\${sep}.+\\.md$`, 'i');
  return re.test(rel);
}

export async function listFiles(rootRaw) {
  return memoryReadBackend.memoryList(resolveRoot(rootRaw));
}

export async function searchMemory(q, rootRaw) {
  return memoryReadBackend.memorySearch(resolveRoot(rootRaw), q || '');
}

export async function readMemoryFile(p, rootRaw) {
  if (!isMemoryPath(p, rootRaw)) return { ok: false, error: 'path outside memory dirs' };
  try { return await memoryReadBackend.memoryRead(p); }
  catch (e) { return { ok: false, error: e.message }; }
}

export async function writeMemoryFile(p, content, rootRaw, mtime, force, backend, logger) {
  if (!isMemoryPath(p, rootRaw)) return { ok: false, error: 'path outside memory dirs' };
  try {
    if (mtime != null && !force && existsSync(p) && Math.abs(statSync(p).mtimeMs - mtime) > 1) {
      return { ok: false, error: 'changed on disk' };
    }
    await backupFile(p);
    // Re-check: backupFile's await can yield to a concurrent save of this
    // same path landing in between, which the first check (above) can't see.
    if (mtime != null && !force && existsSync(p) && Math.abs(statSync(p).mtimeMs - mtime) > 1) {
      return { ok: false, error: 'changed on disk' };
    }
    try { return await backend.memoryWrite(p, content, mtime, force); }
    catch (error) {
      logger?.error({ err: error.message }, 'Rust Memory write backend failed');
      return { ok: false, error: 'memory write backend unavailable' };
    }
  }
  catch (e) { return { ok: false, error: e.message }; }
}

export function createMemoryWriteHandler(backend, logger) {
  return async (req, reply) => {
    const { path, content, root, mtime, force } = req.body || {};
    if (path == null || content == null) return reply.code(400).send({ ok: false, error: 'path + content required' });
    const result = await writeMemoryFile(path, content, root, mtime, force, backend, logger);
    if (!result.ok) reply.code(result.error === 'changed on disk' ? 409 : 400);
    return result;
  };
}
