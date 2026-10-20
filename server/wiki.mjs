// Wiki root choice stays in Node; read traversal and page content run in Rust.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, normalize } from 'node:path';
import { homedir } from 'node:os';
import { STATE_DIR } from './app-dir.mjs';
import { norm, contains } from './path-containment.mjs';

const ROOT_FILE = join(STATE_DIR, 'wiki-root.json');

export function getWikiRoot() {
  try { const root = JSON.parse(readFileSync(ROOT_FILE, 'utf8')).root; return typeof root === 'string' && root ? root : '~/wiki'; }
  catch { return '~/wiki'; }
}

export function setWikiRoot(root) {
  if (typeof root !== 'string' || !root) return { ok: false, error: 'bad root' };
  try { mkdirSync(STATE_DIR, { recursive: true }); writeFileSync(ROOT_FILE, JSON.stringify({ root })); return { ok: true, root }; }
  catch (error) { return { ok: false, error: error.message }; }
}

// Resolve a ~-prefixed client path to an absolute one (mirror /fs/browse).
export function resolveRoot(raw) {
  if (!raw) return null;
  let path = raw;
  if (path === '~' || path.startsWith('~/') || path.startsWith('~\\')) path = normalize(homedir() + path.slice(1));
  try { return resolve(path); } catch { return null; }
}

// Keep persisted-root equality and shared path containment as the authorization boundary.
export function isWikiPath(path, root) {
  if (!path || !root) return false;
  const absolutePath = resolve(path);
  const resolvedRoot = resolveRoot(root);
  const persistedRoot = resolveRoot(getWikiRoot());
  if (!resolvedRoot || !persistedRoot || norm(resolvedRoot) !== norm(persistedRoot)) return false;
  if (!contains(resolvedRoot, absolutePath)) return false;
  return absolutePath.toLowerCase().endsWith('.md');
}
