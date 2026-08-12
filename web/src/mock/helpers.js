// Shared helpers for the repeated Mirage route shapes (design.md D8, Risks).
// Two patterns cover most of the surface:
//
// 1. `{base}/roots` GET+PUT — the per-panel picker-root list. 5 uses:
//    /config/roots, /codex-config/roots, /hooks/roots, /rules/roots, /skills/roots.
//    GET returns `{ roots: [...] }`; PUT accepts `{ roots: [...] }` and returns
//    `{ ok: true, roots }` or `{ ok: false, error }`. The daemon seeds with `['~']`
//    when empty; the mock seeds from fixtures (db.roots) so it never returns `~`.
//
// 2. mtime-guarded file GET+PUT — the editor save loop. 6 uses: /hooks/file,
//    /rules/file, /memory/file, /config/:scope, /codex-config/:scope, /skill,
//    plus /fs/write (the same guard, different path shape). The guard is:
//    `mtime != null && !force && file exists && |stored.mtime - mtime| > 1` → 409
//    `{ ok: false, error: 'changed on disk' }`. A forced write overrides the guard
//    and returns the new mtime.
//
// All writes target db.files (the in-memory `path -> {content, mtime}` map),
// so a subsequent read of the same path observes the write (spec scenario
// "A saved file reads back"). mtime is bumped to Date.now() on every write so
// the guard sees a real change.
import { Response } from 'miragejs';
import { db } from './db.js';

// --------------------------------------------------------------------- roots

// Register GET `{base}/roots` + PUT `{base}/roots` against a key in db.roots.
// `key` is the db.roots field name (e.g. 'config', 'hooks', 'skills'). The
// daemon returns `['~']` when the persisted list is empty; the mock seeds from
// fixtures so it always has a real path, and an empty list is preserved as-is
// (PUT with [] clears the picker, which the daemon also accepts).
export function rootsRoutes(server, key) {
  server.get(`/${key}/roots`, () => ({ roots: db.roots[key] || [] }));
  server.put(`/${key}/roots`, (schema, req) => {
    let body = {};
    try { body = JSON.parse(req.requestBody || '{}'); } catch {}
    const roots = Array.isArray(body.roots)
      ? [...new Set(body.roots.filter((r) => typeof r === 'string' && r))].slice(0, 50)
      : (db.roots[key] || []);
    db.roots[key] = roots;
    return { ok: true, roots };
  });
}

// --------------------------------------------------------- mtime-guarded I/O

// Read a file from db.files. Returns `{ ok:false, error:'not found' }` when the
// path is absent. Callers that need a different not-found shape (e.g. /hooks/file
// returns `{ path, exists:false, error:'bad path' }`) wrap this.
export function guardedRead(path) {
  const f = db.files[path];
  if (!f) return { ok: false, error: 'not found' };
  return { ok: true, content: f.content, mtime: f.mtime };
}

// Write a file to db.files with the mtime guard. Returns:
//   - `{ ok:false, error:'changed on disk' }` on a stale mtime (caller returns 409)
//   - `{ ok:true, mtime }` on success
// The caller may augment the success shape (e.g. add `backup`, `path`). `force`
// bypasses the mtime check. A new file (no stored mtime) always writes.
export function guardedWrite(path, content, mtime, force) {
  const existing = db.files[path];
  if (mtime != null && !force && existing && Math.abs(existing.mtime - mtime) > 1) {
    return { ok: false, error: 'changed on disk' };
  }
  const now = Date.now();
  db.files[path] = { content, mtime: now };
  return { ok: true, mtime: now };
}

// A 409 Response carrying the stale-mismatch error. Used by every guarded write
// route so the client sees the same HTTP status the daemon returns.
export function conflict(body) {
  return new Response(409, {}, body);
}

// Parse a JSON request body, returning {} on failure (never throws).
export function parseBody(req) {
  try { return JSON.parse(req.requestBody || '{}') || {}; } catch { return {}; }
}