// Projects: an ordered list of git repo toplevels, persisted at
// STATE_DIR/projects.json (wiki-root.json pattern — see wiki.mjs). Each entry
// gets an on-demand git status readout (branch, ahead/behind, working-tree
// counts, stash, last commit). Never runs `git fetch` — ahead/behind are "as
// of last fetch".
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as reg from './agents.mjs';
import { git } from './tasks.mjs';

const PROJECTS_FILE = join(reg.STATE_DIR, 'projects.json');
const IS_WIN = process.platform === 'win32';
// Comparison key: resolved absolute path, case-folded on win32 (NTFS is
// case-insensitive) so a repo can't be added/removed/reordered twice under two
// spellings of the same path.
const key = (p) => { const r = resolve(p); return IS_WIN ? r.toLowerCase() : r; };

function readList() {
  try {
    const arr = JSON.parse(readFileSync(PROJECTS_FILE, 'utf8'));
    return Array.isArray(arr) ? arr.filter((p) => typeof p === 'string') : [];
  } catch { return []; }
}
function writeList(list) {
  reg.writeAtomic(PROJECTS_FILE, JSON.stringify(list, null, 2));
}

// Still a git repo on disk right now?
async function isLiveRepo(p) {
  if (!existsSync(p)) return false;
  try { await git(p, 'rev-parse', '--show-toplevel'); return true; }
  catch { return false; }
}

// Is `p` in the stored list? Used to gate the status route (a caller can't
// probe an arbitrary directory's git status via /projects/status).
export function has(p) {
  const k = key(p);
  return readList().some((s) => key(s) === k);
}

export async function list() {
  const stored = readList();
  const kept = [];
  for (const p of stored) if (await isLiveRepo(p)) kept.push(p);
  if (kept.length !== stored.length) writeList(kept);
  return kept;
}

export async function add(rawPath) {
  if (typeof rawPath !== 'string' || !rawPath) return { ok: false, error: 'not a git repository' };
  const resolved = resolve(rawPath);
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) return { ok: false, error: 'not a git repository' };
  let toplevel;
  try { toplevel = resolve(await git(resolved, 'rev-parse', '--show-toplevel')); }
  catch { return { ok: false, error: 'not a git repository' }; }
  const stored = readList();
  const k = key(toplevel);
  if (stored.some((p) => key(p) === k)) return { ok: true, projects: stored };
  const next = [...stored, toplevel];
  writeList(next);
  return { ok: true, projects: next };
}

export function remove(rawPath) {
  const k = key(rawPath);
  const stored = readList();
  const next = stored.filter((p) => key(p) !== k);
  if (next.length !== stored.length) writeList(next);
  return { ok: true, projects: next };
}

export function reorder(paths) {
  if (!Array.isArray(paths)) return { ok: false, error: 'not a permutation' };
  const stored = readList();
  if (paths.length !== stored.length) return { ok: false, error: 'not a permutation' };
  const storedKeys = new Set(stored.map(key));
  const seen = new Set();
  for (const p of paths) {
    if (typeof p !== 'string') return { ok: false, error: 'not a permutation' };
    const k = key(p);
    if (!storedKeys.has(k) || seen.has(k)) return { ok: false, error: 'not a permutation' };
    seen.add(k);
  }
  const byKey = new Map(stored.map((p) => [key(p), p]));
  const next = paths.map((p) => byKey.get(key(p)));
  writeList(next);
  return { ok: true, projects: next };
}

// git status --porcelain=v2 --branch: '# branch.*' header lines, then one
// entry line per changed/untracked/conflicted path. XY column meanings for
// entry types '1'/'2': X (index) != '.' => staged, Y (worktree) != '.' =>
// modified. Type 'u' is an unmerged/conflicted path; '?' is untracked.
export async function gitStatus(path) {
  const out = await git(path, 'status', '--porcelain=v2', '--branch');
  let branch = null, upstream = null, ahead = 0, behind = 0;
  let staged = 0, modified = 0, untracked = 0, conflicted = 0;
  for (const line of out.split('\n')) {
    if (line.startsWith('# branch.head ')) {
      const h = line.slice('# branch.head '.length);
      branch = h === '(detached)' ? null : h;
    } else if (line.startsWith('# branch.upstream ')) {
      upstream = line.slice('# branch.upstream '.length);
    } else if (line.startsWith('# branch.ab ')) {
      const m = line.match(/\+(\d+) -(\d+)/);
      if (m) { ahead = Number(m[1]); behind = Number(m[2]); }
    } else if (line.startsWith('1 ') || line.startsWith('2 ')) {
      const xy = line.split(' ')[1];
      if (xy[0] !== '.') staged++;
      if (xy[1] !== '.') modified++;
    } else if (line.startsWith('u ')) conflicted++;
    else if (line.startsWith('? ')) untracked++;
  }
  const stashOut = await git(path, 'stash', 'list');
  const stash = stashOut ? stashOut.split('\n').filter(Boolean).length : 0;
  let lastCommit = null;
  try {
    const [sha, subject, date] = (await git(path, 'log', '-1', '--format=%H%x00%s%x00%cI')).split('\0');
    lastCommit = { sha, subject, date };
  } catch { /* empty repo — no commits yet */ }
  return { path, branch, upstream, ahead, behind, staged, modified, untracked, conflicted, stash, lastCommit };
}
