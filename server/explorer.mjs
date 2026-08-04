// Explorer backend: full-FS file browser/editor — list/read/write/create/
// delete/rename anywhere on disk. Unlike memory.mjs/rules.mjs/hooks.mjs there
// is NO containment guard: the daemon is loopback-only and already spawns
// claude with full FS access (see /fs/browse above, which has no guard
// either), and the feature's whole point is "edit anywhere". The only check
// is bad(p): must be a non-empty absolute path. Tildify/untildify is the
// client's job (like DirPicker) — paths here are absolute only.
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, rmSync, renameSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, dirname, parse as parsePath, isAbsolute, extname } from 'node:path';
import { STATE_DIR } from './app-dir.mjs';

const ENTRY_CAP = 2000;
const SEARCH_CAP = 300;
const DIR_BUDGET = 20000; // dirs visited before search gives up (a ~ walk is unbounded)
const SKIP_DIRS = new Set(['node_modules', '.git', '.cache', 'dist', 'build', '.next']);
const TOOLARGE = 2 * 1024 * 1024;
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']);
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' };

function bad(p) { return typeof p !== 'string' || !p || !isAbsolute(p); }

export function listEntries(dir) {
  if (bad(dir)) return { ok: false, error: 'bad path' };
  let ents;
  try { ents = readdirSync(dir, { withFileTypes: true }); }
  catch (e) { return { ok: false, error: e.message }; }
  const dirs = [];
  const files = [];
  for (const e of ents) {
    let type = e.isDirectory() ? 'dir' : null;
    let size = 0;
    // Dirent is lstat-based, so a junction/symlink is neither dir nor file —
    // stat through the link so a junction opens as its target (~/.agents and
    // ~/.claude/skills are wired entirely with junctions). Same call gets the
    // size. Broken link → skip; unreadable file → list it with size 0.
    if (!type) {
      let st = null;
      try { st = statSync(join(dir, e.name)); } catch { /* broken link or unreadable */ }
      if (st) { type = st.isDirectory() ? 'dir' : 'file'; size = st.isDirectory() ? 0 : st.size; }
      else if (e.isFile()) type = 'file';
      else continue;
    }
    (type === 'dir' ? dirs : files).push({ name: e.name, type, size });
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name));
  files.sort((a, b) => a.name.localeCompare(b.name));
  let entries = [...dirs, ...files];
  const capped = entries.length > ENTRY_CAP;
  if (capped) entries = entries.slice(0, ENTRY_CAP);
  const { dir: parent, root } = parsePath(dir);
  return { ok: true, path: dir, parent: dir === root ? null : parent, entries, capped };
}

// Recursive name search under `root` — the rail's filter box can only see
// folders already expanded, which is useless for a name buried deeper. BFS so
// shallow hits come first; async readdir so a big tree doesn't block the
// daemon. Junctions/symlinks report isDirectory() false here, so they're never
// walked — that also rules out link cycles.
export async function searchEntries(root, q) {
  if (bad(root)) return { ok: false, error: 'bad path' };
  const term = (q || '').trim().toLowerCase();
  if (!term) return { ok: true, results: [], capped: false };
  const results = [];
  const queue = [root];
  let visited = 0;
  while (queue.length && results.length < SEARCH_CAP && visited < DIR_BUDGET) {
    // Level at a time, 64 readdirs in flight: serial awaits spend the whole
    // walk waiting on one FS round-trip each (20s+ to exhaust the budget).
    const batch = queue.splice(0, 64);
    visited += batch.length;
    const lists = await Promise.all(batch.map((d) => readdir(d, { withFileTypes: true }).then((es) => [d, es]).catch(() => null)));
    for (const list of lists) {
      if (!list) continue;
      const [dir, ents] = list;
      for (const e of ents) {
        const isDir = e.isDirectory();
        if (e.name.toLowerCase().includes(term)) results.push({ path: join(dir, e.name), name: e.name, type: isDir ? 'dir' : 'file' });
        if (isDir && !SKIP_DIRS.has(e.name)) queue.push(join(dir, e.name));
      }
    }
  }
  if (results.length > SEARCH_CAP) results.length = SEARCH_CAP;
  return { ok: true, results, capped: results.length >= SEARCH_CAP || visited >= DIR_BUDGET };
}

export function readEntry(path) {
  if (bad(path)) return { ok: false, error: 'bad path' };
  if (!existsSync(path)) return { ok: false, error: 'not found' };
  const st = statSync(path);
  const stamp = { size: st.size, mtime: st.mtimeMs }; // mtime lets the client spot an edit made outside the app
  if (IMAGE_EXT.has(extname(path).toLowerCase())) return { ok: true, kind: 'image', ...stamp };
  if (st.size > TOOLARGE) return { ok: true, kind: 'toolarge', ...stamp };
  const buf = readFileSync(path);
  if (buf.subarray(0, 8192).includes(0)) return { ok: true, kind: 'binary', ...stamp };
  return { ok: true, kind: 'text', ...stamp, content: buf.toString('utf8') };
}

// mtime (the value the client got from readEntry) makes the save conditional:
// if something else rewrote the file meanwhile, refuse instead of clobbering it
// silently. The client re-sends with force after asking.
export function writeEntry(path, content, mtime, force) {
  if (bad(path)) return { ok: false, error: 'bad path' };
  try {
    if (mtime != null && !force && existsSync(path) && Math.abs(statSync(path).mtimeMs - mtime) > 1) {
      return { ok: false, error: 'changed on disk' };
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    return { ok: true, mtime: statSync(path).mtimeMs };
  } catch (e) { return { ok: false, error: e.message }; }
}

export function createEntry(path, kind) {
  if (bad(path)) return { ok: false, error: 'bad path' };
  if (existsSync(path)) return { ok: false, error: 'already exists' };
  try {
    if (kind === 'dir') mkdirSync(path, { recursive: true });
    else writeFileSync(path, '');
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}

export function deleteEntry(path) {
  if (bad(path)) return { ok: false, error: 'bad path' };
  if (!existsSync(path)) return { ok: false, error: 'not found' };
  try {
    // recursive: true deletes non-empty dirs in one call — client confirms first.
    rmSync(path, { recursive: true });
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}

export function renameEntry(from, to) {
  if (bad(from) || bad(to)) return { ok: false, error: 'bad path' };
  if (!existsSync(from)) return { ok: false, error: 'not found' };
  if (existsSync(to)) return { ok: false, error: 'already exists' };
  try { renameSync(from, to); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
}

export function rawEntry(path) {
  if (bad(path)) return { ok: false, error: 'bad path' };
  if (!existsSync(path)) return { ok: false, error: 'not found' };
  try {
    const mime = MIME[extname(path).toLowerCase()] || 'application/octet-stream';
    return { ok: true, buf: readFileSync(path), mime };
  } catch (e) { return { ok: false, error: e.message }; }
}

// Explorer UI state (root/expanded tree/open tabs): FS-persisted under
// STATE_DIR, same pattern as memory.mjs's ROOT_FILE / hooks.mjs's ROOTS_FILE.
const STATE_FILE = join(STATE_DIR, 'explorer-state.json');
const DEFAULT_STATE = { root: '~', expanded: [], tabs: [], active: null, autosave: false };

export function getState() {
  try {
    const s = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    return { ...DEFAULT_STATE, ...s };
  } catch { return { ...DEFAULT_STATE }; }
}

function strArray(v) {
  return Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, 500) : undefined;
}

export function setState(patch) {
  const cur = getState();
  const next = { ...cur };
  if (patch && typeof patch.root === 'string' && patch.root) next.root = patch.root;
  const expanded = strArray(patch?.expanded);
  if (expanded) next.expanded = expanded;
  const tabs = strArray(patch?.tabs);
  if (tabs) next.tabs = tabs;
  if (patch && (typeof patch.active === 'string' || patch.active === null)) next.active = patch.active;
  if (patch && typeof patch.autosave === 'boolean') next.autosave = patch.autosave;
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(next));
    return { ok: true, state: next };
  } catch (e) { return { ok: false, error: e.message }; }
}
