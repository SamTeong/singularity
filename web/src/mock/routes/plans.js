// Plans routes: read-only browse of the handoff plan tree (~/.agents/.plan) —
// session dirs holding markdown plans + a state.json snapshot. Mirrors
// server/plans.mjs listSessions/getSession exactly, sourced from the static
// MOCK_SESSIONS fixture (web/src/features/plans/plansMockData.mjs) rather than
// the mock's db.files — plans live outside the virtual FS.
// VERIFY: mock-plans-routes
import { Response } from 'miragejs';
import { MOCK_SESSIONS } from '../../features/plans/plansMockData.mjs';

// UI bucket order — the daemon collapses free-string statuses into these
// (server/plans.mjs BUCKETS/normalizeStatus); the fixture statuses are already
// normalized, so an off-list value folds to 'other'.
const BUCKETS = ['active', 'done', 'blocked', 'superseded', 'other'];
// Same sid shape guard the daemon applies before touching the FS.
const SID_RE = /^[0-9a-f-]{8,64}$/i;

// Distinct buckets present in a session, in canonical order.
function statusBuckets(plans) {
  const seen = new Set(plans.map((p) => (BUCKETS.includes(p.status) ? p.status : 'other')));
  return BUCKETS.filter((b) => seen.has(b));
}

// Fixture mtimes are absolute, so re-anchor them: the newest sits an hour
// behind Date.now(), keeping the default 3d window deterministic.
const FIXTURE_NEWEST = Math.max(...MOCK_SESSIONS.map((s) => Date.parse(s.mtime)));
const shifted = (s, now) => ({ ...s, mtime: new Date(now - 3600e3 - (FIXTURE_NEWEST - Date.parse(s.mtime))).toISOString() });

// Opt-in scale corpus for e2e: localStorage 'sing-mock-plans-extra' = N adds N
// sessions, 20 min apart, all inside the 3d window.
function allSessions() {
  const now = Date.now();
  const extra = Number(globalThis.localStorage?.getItem('sing-mock-plans-extra')) || 0;
  const generated = Array.from({ length: extra }, (_, i) => ({
    sid: `b0000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    mtime: new Date(now - 2 * 3600e3 - i * 20 * 60e3).toISOString(),
    branch: `bulk/${i}`,
    cwd: 'C:/git/singularity',
    plans: [{ file: 'plan.md', title: `Bulk session ${i}`, status: 'active', statusRaw: 'active', objective: 'Scale fixture.', currentPhase: null, phases: [], nextSteps: [], required: [], completed: null }],
    notes: [],
    state: { generatedAt: null, contextTokens: 1000, branch: `bulk/${i}` },
  }));
  return [...MOCK_SESSIONS.map((s) => shifted(s, now)), ...generated];
}

export function registerPlans(server) {
  // /plans/sessions — one row per session, shaped like listSessions' (with the
  // branch + contextTokens fields the daemon folds in from state.json).
  server.get('/plans/sessions', () => allSessions().map((s) => ({
    sid: s.sid,
    mtime: Date.parse(s.mtime),
    planCount: s.plans.length,
    statusBuckets: statusBuckets(s.plans),
    branch: s.branch ?? null,
    contextTokens: s.state?.contextTokens ?? null,
  })));

  // /plans/session?sid=… — the getSession payload { ok, sid, mtime, plans,
  // notes, state }. A malformed sid 400s, an unknown one 404s, both carrying
  // the daemon's { ok:false, error } body. state is reshaped to the daemon's
  // four picked fields (cwd comes from the session row, not state.json).
  server.get('/plans/session', (schema, req) => {
    const sid = req.queryParams.sid;
    if (typeof sid !== 'string' || !SID_RE.test(sid)) return new Response(400, {}, { ok: false, error: 'bad sid' });
    const s = allSessions().find((x) => x.sid === sid);
    if (!s) return new Response(404, {}, { ok: false, error: 'not found' });
    return {
      ok: true,
      sid: s.sid,
      mtime: Date.parse(s.mtime),
      plans: s.plans,
      notes: s.notes,
      state: s.state
        ? { generatedAt: s.state.generatedAt ?? null, cwd: s.cwd ?? null, branch: s.state.branch ?? null, contextTokens: s.state.contextTokens ?? null }
        : null,
    };
  });

  server.post('/plans/open', (schema, req) => {
    const sid = req.requestBody ? JSON.parse(req.requestBody).sid : null;
    if (typeof sid !== 'string' || !SID_RE.test(sid)) return new Response(400, {}, { ok: false, error: 'bad sid' });
    if (!allSessions().some((s) => s.sid === sid)) return new Response(404, {}, { ok: false, error: 'not found' });
    return { ok: true };
  });
}
