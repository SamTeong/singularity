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

export function registerPlans(server) {
  // /plans/sessions — one row per session, shaped like listSessions' (with the
  // branch + contextTokens fields the daemon folds in from state.json).
  server.get('/plans/sessions', () => MOCK_SESSIONS.map((s) => ({
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
    const s = MOCK_SESSIONS.find((x) => x.sid === sid);
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
}
