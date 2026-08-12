// Explorer + DirPicker routes: full-FS browse/edit over the mock's virtual
// filesystem — db.files, a flat `path -> {content, mtime}` map (fixtures.js).
// Shapes mirror server/explorer.mjs + server/index.mjs exactly (design.md D8):
// bare keyed objects with no `ok` where the daemon has none, real 409 on
// stale-mtime writes, error keys inside 400/404.
//
// A path is a "directory" when it is a prefix of other keys (`path + '/'` is a
// prefix of some key in db.files) or when it carries a `dir: true` marker —
// POST /fs/entry stores that marker for empty folders, which have no children
// to derive from. Binary files (content === null, e.g. the seeded pixel.png)
// appear in listings; /fs/read reports them as `kind: 'image'` (image
// extensions) or `kind: 'binary'` (anything else) with no content — the real
// bytes are served by the mock-assets plugin's /fs/raw (tasks.md section 6).
import { Response } from 'miragejs';
import { db } from '../db.js';
import { FAKE_HOME } from '../fixtures.js';
import { guardedWrite, conflict, parseBody } from '../helpers.js';

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']);
const TOOLARGE = 2 * 1024 * 1024; // mirrors server/explorer.mjs

// Mirrors explorer.mjs's bad(): a non-empty absolute path. The mock's virtual
// FS is POSIX-shaped (fixtures join with '/'), so absolute means leading '/'.
const bad = (p) => typeof p !== 'string' || !p || !p.startsWith('/');

// Is `path` a directory? A prefix of other keys, or a `dir: true` marker
// (an empty folder created via POST /fs/entry).
function isDir(path) {
  if (db.files[path]?.dir === true) return true;
  const prefix = path + '/';
  return Object.keys(db.files).some((k) => k.startsWith(prefix));
}

// The immediate children of `dir` — `{ dirs: [names], files: [names] }` —
// derived from the first path segment of every key under `dir/`. A child is a
// dir when it has a `dir: true` marker or when its segment is a prefix of
// deeper keys (i.e. the remainder still contains a separator).
function childrenOf(dir) {
  const dirs = new Set();
  const files = new Set();
  const prefix = dir + '/';
  for (const k of Object.keys(db.files)) {
    if (!k.startsWith(prefix)) continue;
    const rest = k.slice(prefix.length);
    const slash = rest.indexOf('/');
    const seg = slash < 0 ? rest : rest.slice(0, slash);
    const childPath = dir + '/' + seg;
    if (db.files[childPath]?.dir === true || slash >= 0) dirs.add(seg);
    else files.add(seg);
  }
  return { dirs: [...dirs], files: [...files] };
}

// The directory containing `path`, or null at the top of the virtual FS
// (FAKE_HOME — the mock analog of the daemon's parsePath root).
function parentOf(path) {
  if (path === FAKE_HOME) return null;
  return path.slice(0, path.lastIndexOf('/')) || null;
}

// Lowercased extension incl. dot ('' when none) — mirrors extname().
function extOf(path) {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot < 0 ? '' : base.slice(dot).toLowerCase();
}

export function registerFs(server) {
  // Seed the explorer's persisted UI state so the panel opens at the explorer
  // root — the mock analog of the daemon sandbox's seeded explorer-state.json
  // (e2e/fixtures/seed.mjs). The client's restore defaults root to '~' (home)
  // when state is empty, which would show the corpus root, not the explorer.
  if (!db.ui.fsState) {
    db.ui.fsState = { root: db.roots.explorer, expanded: [], tabs: [], active: null, autosave: false };
  }

  // Dir picker: subdirectories of `path` only (no file listing). 400 on a
  // missing/unknown path — bare `{ error }`, no `ok` (server/index.mjs:233).
  server.get('/fs/browse', (schema, req) => {
    const p = req.queryParams.path;
    if (bad(p) || !isDir(p)) return new Response(400, {}, { error: 'bad path' });
    const { dirs } = childrenOf(p);
    return { path: p, parent: parentOf(p), dirs: dirs.filter((d) => !d.startsWith('.')).sort((a, b) => a.localeCompare(b)) };
  });

  // Explorer listing: entries (dirs first, then files, each name-sorted),
  // `capped` always false — the virtual FS is far under the daemon's 2000 cap.
  server.get('/fs/list', (schema, req) => {
    const dir = req.queryParams.path;
    if (bad(dir) || !isDir(dir)) return new Response(400, {}, { ok: false, error: 'bad path' });
    const { dirs, files } = childrenOf(dir);
    const entries = [
      ...dirs.sort((a, b) => a.localeCompare(b)).map((name) => ({ name, type: 'dir', size: 0 })),
      ...files.sort((a, b) => a.localeCompare(b)).map((name) => {
        const f = db.files[dir + '/' + name];
        return { name, type: 'file', size: f?.content == null ? 0 : f.content.length };
      }),
    ];
    return { ok: true, path: dir, parent: parentOf(dir), entries, capped: false };
  });

  // Recursive name search under `root` — matches entry names, not paths.
  // Every ancestor directory of a matching key is itself a searchable entry.
  server.get('/fs/search', (schema, req) => {
    const root = req.queryParams.root;
    if (bad(root)) return new Response(400, {}, { ok: false, error: 'bad path' });
    const term = (req.queryParams.q || '').trim().toLowerCase();
    if (!term) return { ok: true, results: [], capped: false };
    const results = [];
    const seen = new Set();
    const prefix = root + '/';
    for (const k of Object.keys(db.files)) {
      if (!k.startsWith(prefix)) continue;
      const segs = k.slice(prefix.length).split('/');
      const markerDir = db.files[k]?.dir === true;
      for (let i = 0; i < segs.length; i++) {
        const name = segs[i];
        if (!name.toLowerCase().includes(term)) continue;
        const isLast = i === segs.length - 1;
        const type = isLast && !markerDir ? 'file' : 'dir';
        const path = isLast ? k : root + '/' + segs.slice(0, i + 1).join('/');
        const key = path + '\u0000' + type;
        if (seen.has(key)) continue;
        seen.add(key);
        results.push({ path, name, type });
      }
    }
    results.sort((a, b) => a.path.localeCompare(b.path));
    return { ok: true, results, capped: false };
  });

  // Read one file. Binary (content === null) reports kind 'image' for image
  // extensions (the client renders /fs/raw, served by the asset plugin) and
  // 'binary' otherwise — no content, matching readEntry's stamp-only shape.
  server.get('/fs/read', (schema, req) => {
    const path = req.queryParams.path;
    if (bad(path)) return new Response(400, {}, { ok: false, error: 'bad path' });
    const f = db.files[path];
    if (!f) return new Response(404, {}, { ok: false, error: 'not found' });
    const stamp = { size: f.content == null ? 0 : f.content.length, mtime: f.mtime };
    if (IMAGE_EXT.has(extOf(path))) return { ok: true, kind: 'image', ...stamp };
    if (f.content == null) return { ok: true, kind: 'binary', ...stamp };
    if (f.content.length > TOOLARGE) return { ok: true, kind: 'toolarge', ...stamp };
    return { ok: true, kind: 'text', ...stamp, content: f.content };
  });

  // mtime-guarded write — 409 on a stale mtime (conflict), else { ok, mtime }.
  server.put('/fs/write', (schema, req) => {
    const { path, content, mtime, force } = parseBody(req);
    if (path == null || content == null) return new Response(400, {}, { ok: false, error: 'path + content required' });
    if (bad(path)) return new Response(400, {}, { ok: false, error: 'bad path' });
    const r = guardedWrite(path, content, mtime, force);
    if (!r.ok) return conflict(r);
    return r;
  });

  // Create a file (empty content) or a folder (a `dir: true` marker — the
  // flat store has no other way to represent an empty directory).
  server.post('/fs/entry', (schema, req) => {
    const { path, kind } = parseBody(req);
    if (bad(path)) return new Response(400, {}, { ok: false, error: 'bad path' });
    if (db.files[path] != null || isDir(path)) return new Response(400, {}, { ok: false, error: 'already exists' });
    db.files[path] = kind === 'dir' ? { content: null, mtime: Date.now(), dir: true } : { content: '', mtime: Date.now() };
    return { ok: true };
  });

  // Delete a file or a folder (recursively — the marker plus every key under
  // `path/`, mirroring rmSync(path, { recursive: true })).
  server.delete('/fs/entry', (schema, req) => {
    const path = req.queryParams.path;
    if (bad(path)) return new Response(400, {}, { ok: false, error: 'bad path' });
    if (db.files[path] == null && !isDir(path)) return new Response(404, {}, { ok: false, error: 'not found' });
    for (const k of Object.keys(db.files)) {
      if (k === path || k.startsWith(path + '/')) delete db.files[k];
    }
    return { ok: true };
  });

  // Rename a file or folder — moves the key (and every key under `from/` for
  // a folder) to the `to` prefix.
  server.patch('/fs/rename', (schema, req) => {
    const { from, to } = parseBody(req);
    if (bad(from) || bad(to)) return new Response(400, {}, { ok: false, error: 'bad path' });
    const keys = Object.keys(db.files);
    const fromKeys = keys.filter((k) => k === from || k.startsWith(from + '/'));
    if (!fromKeys.length) return new Response(404, {}, { ok: false, error: 'not found' });
    if (keys.some((k) => k === to || k.startsWith(to + '/'))) return new Response(400, {}, { ok: false, error: 'already exists' });
    for (const k of fromKeys) {
      db.files[to + k.slice(from.length)] = db.files[k];
      delete db.files[k];
    }
    return { ok: true };
  });

  // Explorer UI state (root/expanded/tabs/active/autosave) — the daemon
  // persists it to explorer-state.json; the mock keeps it in db.ui.fsState for
  // the page lifetime. GET returns the bare `{ state }`; PUT merges the patch
  // (same field validation as setState) and returns `{ ok, state }`.
  server.get('/fs/state', () => ({ state: db.ui.fsState || {} }));
  server.put('/fs/state', (schema, req) => {
    const patch = parseBody(req);
    const next = { ...(db.ui.fsState || {}) };
    if (patch && typeof patch.root === 'string' && patch.root) next.root = patch.root;
    const strArray = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, 500) : undefined);
    const expanded = strArray(patch?.expanded);
    if (expanded) next.expanded = expanded;
    const tabs = strArray(patch?.tabs);
    if (tabs) next.tabs = tabs;
    if (patch && (typeof patch.active === 'string' || patch.active === null)) next.active = patch.active;
    if (patch && typeof patch.autosave === 'boolean') next.autosave = patch.autosave;
    db.ui.fsState = next;
    return { ok: true, state: next };
  });
}
