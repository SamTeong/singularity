// Projects routes: an ordered list of git repo toplevels, each carrying a
// baked-in git-status readout (the mock has no real git — the daemon shells
// out for this; server/projects.mjs:gitStatus). Shapes mirror the daemon
// exactly: bare `{ projects }` (string[]), `/projects/status` returns the
// status object itself, real 400/404s with `{ error }`.
import { Response } from 'miragejs';
import { db } from '../db.js';
import { parseBody } from '../helpers.js';

// A freshly-added repo: clean status, main branch, no upstream — same
// defaults a brand-new local clone would show.
function freshStatus(path) {
  return {
    path, branch: 'main', upstream: null, ahead: 0, behind: 0,
    staged: 0, modified: 0, untracked: 0, conflicted: 0, stash: 0, lastCommit: null,
  };
}

// A freshly-added repo has no commits/changes to summarize yet — same
// deterministic no-summariser shape server/projects.mjs returns for an empty
// repo.
function freshSummary(path) {
  return { path, scope: 'recent', source: 'deterministic', llm: { ok: false, reason: 'no-summariser' }, committed: [], uncommitted: [] };
}

export function registerProjects(server) {
  server.get('/projects', () => ({ projects: db.projects.map((p) => p.path) }));

  // A path containing "not-a-repo" always 400s — exercises the UI's add-error
  // path the same way the daemon's real `git rev-parse` failure would.
  server.post('/projects', (schema, req) => {
    const { path } = parseBody(req);
    if (typeof path !== 'string' || !path || path.includes('not-a-repo')) {
      return new Response(400, {}, { ok: false, error: 'not a git repository' });
    }
    if (!db.projects.some((p) => p.path === path)) {
      db.projects.push(freshStatus(path));
      db.projectSummaries[path] = freshSummary(path);
    }
    return { ok: true, projects: db.projects.map((p) => p.path) };
  });

  server.delete('/projects', (schema, req) => {
    const { path } = parseBody(req);
    db.projects = db.projects.filter((p) => p.path !== path);
    delete db.projectSummaries[path];
    return { ok: true, projects: db.projects.map((p) => p.path) };
  });

  server.put('/projects/order', (schema, req) => {
    const { paths } = parseBody(req);
    const current = db.projects.map((p) => p.path);
    const sameSet = Array.isArray(paths) && paths.length === current.length && current.every((p) => paths.includes(p));
    if (!sameSet) return new Response(400, {}, { ok: false, error: 'not a permutation' });
    db.projects = paths.map((path) => db.projects.find((p) => p.path === path));
    return { ok: true, projects: paths };
  });

  server.get('/projects/status', (schema, req) => {
    const path = req.queryParams.path;
    if (!path) return new Response(400, {}, { error: 'path required' });
    const p = db.projects.find((x) => x.path === path);
    if (!p) return new Response(404, {}, { error: 'not found' });
    return p;
  });

  // No real git in the mock: any tracked repo's fetch/rebase/sync succeeds.
  server.post('/projects/git', (schema, req) => {
    const { path, op } = parseBody(req);
    if (!path || !['fetch', 'rebase', 'sync'].includes(op)) return new Response(400, {}, { ok: false, error: 'path and op (fetch|rebase|sync) required' });
    if (!db.projects.some((p) => p.path === path)) return new Response(404, {}, { ok: false, error: 'not found' });
    return { ok: true };
  });

  server.get('/projects/summary', (schema, req) => {
    const path = req.queryParams.path;
    if (!path) return new Response(400, {}, { error: 'path required' });
    const s = db.projectSummaries[path];
    if (!s) return new Response(404, {}, { error: 'not found' });
    return s;
  });
}
