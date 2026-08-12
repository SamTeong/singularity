// Automation routes: scheduled cron jobs + background quota-soak scheduler.
// Mirrors server/index.mjs's /crons and /background surface (design.md D8):
// GET /crons returns a BARE ARRAY (snapshotCrons), GET /background returns the
// snapshotBackground shape, and every mutating handler broadcasts the matching
// WS frame so the UI converges from the socket (design.md D7). The mock has no
// scheduler and no real background runs, so nextFire is always null, reports
// are always empty, and /background/run can only ever refuse or bump lastRunAt.
import { Response } from 'miragejs';
import { CronExpressionParser } from 'cron-parser';
import { db } from '../db.js';
import { broadcast } from '../ws.js';
import { parseBody } from '../helpers.js';

// Per-job defaults — mirrors server/background.mjs DEFAULT_JOB.
const DEFAULT_JOB = {
  window: { startHour: 9, endHour: 18, days: [1, 2, 3, 4, 5] },
  thresholds: {
    claude: { start: 50, stop: 75, weeklyMax: 50 },
    codex: { start: 50, stop: 75, weeklyMax: 50 },
    ollama: { start: 50, stop: 75, weeklyMax: 50 },
  },
  models: { claude: 'opus', codex: 'gpt-5.6-luna', ollama: 'glm-5.2:cloud' },
  tokenCaps: { claude: 15_000_000, codex: 15_000_000, ollama: 15_000_000 },
  scopes: [],
};
const CONCLUDE_VALUES = ['inreview', 'done'];

// The GET /background body and the WS `background` frame share this shape
// (server/background.mjs snapshotBackground: { config, lastTick, liveTaskId,
// nextDueAt }). The mock has no scheduler, so lastTick is always null and
// nextDueAt is a fresh hour out — the same values ws.js sends on connect.
const snapshotBackground = () => ({
  config: { jobs: db.background },
  lastTick: null,
  liveTaskId: null,
  nextDueAt: Date.now() + 60 * 60 * 1000,
});

const bgFrame = () => ({ t: 'background', ...snapshotBackground() });

// Throws on an invalid cron expression (caller turns it into a 400) — mirrors
// server/crons.mjs validateExpr.
function validateExpr(expr) {
  CronExpressionParser.parse(expr, { utc: true, tz: 'UTC' });
}

export function registerAutomation(server) {
  // ---- Cron jobs ----------------------------------------------------------

  // GET /crons — BARE ARRAY (snapshotCrons returns an array, not an object).
  server.get('/crons', () => db.crons);

  server.post('/crons', (schema, req) => {
    const body = parseBody(req);
    if (!body.title?.trim() || !body.cronExpr?.trim() || !body.description?.trim() || !body.cwd?.trim()) {
      return new Response(400, {}, { ok: false, error: 'title, cronExpr, description, cwd required' });
    }
    try { validateExpr(body.cronExpr.trim()); }
    catch (e) { return new Response(400, {}, { ok: false, error: e.message }); }
    const cron = {
      id: crypto.randomUUID(), title: body.title.trim(), enabled: body.enabled !== false,
      cronExpr: body.cronExpr.trim(), description: body.description.trim(), cwd: body.cwd.trim(),
      model: body.model || 'claude', scopes: body.scopes || [], permissionMode: body.permissionMode || 'acceptEdits',
      lastSessionId: null, lastFiredAt: null, nextFire: null, createdAt: Date.now(), updatedAt: Date.now(),
    };
    db.crons.push(cron);
    broadcast({ t: 'crons', crons: db.crons });
    return { ok: true, cron };
  });

  server.post('/crons/:id', (schema, req) => {
    const job = db.crons.find((c) => c.id === req.params.id);
    if (!job) return new Response(400, {}, { ok: false, error: 'no such cron' });
    const body = parseBody(req);
    if (body.title !== undefined) job.title = String(body.title).trim();
    if (body.cronExpr !== undefined) {
      try { validateExpr(body.cronExpr); }
      catch (e) { return new Response(400, {}, { ok: false, error: e.message }); }
      job.cronExpr = String(body.cronExpr).trim();
    }
    if (body.description !== undefined) job.description = String(body.description).trim();
    if (body.cwd !== undefined) job.cwd = String(body.cwd).trim();
    if (body.model !== undefined) job.model = body.model;
    if (body.scopes !== undefined) job.scopes = body.scopes;
    if (body.permissionMode !== undefined) job.permissionMode = body.permissionMode;
    if (body.enabled !== undefined) job.enabled = !!body.enabled;
    job.updatedAt = Date.now();
    broadcast({ t: 'crons', crons: db.crons });
    return { ok: true, cron: job };
  });

  server.delete('/crons/:id', (schema, req) => {
    const i = db.crons.findIndex((c) => c.id === req.params.id);
    if (i === -1) return new Response(400, {}, { ok: false, error: 'no such cron' });
    db.crons.splice(i, 1);
    broadcast({ t: 'crons', crons: db.crons });
    return { ok: true };
  });

  server.post('/crons/:id/run', (schema, req) => {
    const job = db.crons.find((c) => c.id === req.params.id);
    if (!job) return new Response(400, {}, { ok: false, error: 'no such cron' });
    // The mock spawns no real agent — record the run on the job so the "Last
    // fired" column updates, then push the snapshot.
    job.lastFiredAt = Date.now();
    job.updatedAt = Date.now();
    job.lastError = null;
    broadcast({ t: 'crons', crons: db.crons });
    return { ok: true, cron: job };
  });

  // ---- Background jobs ----------------------------------------------------

  server.get('/background', () => snapshotBackground());

  // Static siblings register before the parameterised /background/jobs/:id
  // routes (design.md D8) so Mirage never mis-routes a literal path.
  server.post('/background/jobs', (schema, req) => {
    const body = parseBody(req);
    if (!body.title?.trim() || !body.description?.trim() || !body.cwd?.trim()) {
      return new Response(400, {}, { ok: false, error: 'title, description, cwd required' });
    }
    if (body.conclude !== undefined && !CONCLUDE_VALUES.includes(body.conclude)) {
      return new Response(400, {}, { ok: false, error: `conclude must be one of ${CONCLUDE_VALUES.join('|')}` });
    }
    const job = {
      id: crypto.randomUUID(), title: body.title.trim(), description: body.description.trim(), cwd: body.cwd.trim(),
      cooldownHours: body.cooldownHours ?? 24, enabled: body.enabled !== false,
      window: { ...DEFAULT_JOB.window, ...body.window },
      thresholds: {
        claude: { ...DEFAULT_JOB.thresholds.claude, ...body.thresholds?.claude },
        codex: { ...DEFAULT_JOB.thresholds.codex, ...body.thresholds?.codex },
        ollama: { ...DEFAULT_JOB.thresholds.ollama, ...body.thresholds?.ollama },
      },
      models: { ...DEFAULT_JOB.models, ...body.models },
      tokenCaps: { ...DEFAULT_JOB.tokenCaps, ...body.tokenCaps },
      scopes: Array.isArray(body.scopes) ? body.scopes : [],
      conclude: body.conclude ?? 'inreview',
      lastRunAt: null, lastTaskId: null,
    };
    db.background.push(job);
    broadcast(bgFrame());
    return { ok: true, job };
  });

  server.patch('/background/reorder', (schema, req) => {
    const ids = parseBody(req).ids;
    if (!Array.isArray(ids)) return new Response(400, {}, { ok: false, error: 'ids array required' });
    const rank = new Map(ids.map((id, i) => [id, i]));
    db.background.sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity));
    broadcast(bgFrame());
    return { ok: true };
  });

  server.post('/background/run', () => {
    // The mock has no usage data and spawns no real task — mirror the daemon's
    // pickJob: the oldest off-cooldown enabled job, else refuse with its exact
    // message. A picked job gets its lastRunAt bumped (visible in the table);
    // no task is created, so taskId is null.
    const now = Date.now();
    const ready = db.background
      .filter((d) => d.enabled && (d.lastRunAt == null || now - d.lastRunAt > d.cooldownHours * 3_600_000))
      .sort((a, b) => (a.lastRunAt ?? -Infinity) - (b.lastRunAt ?? -Infinity));
    const job = ready[0] || null;
    if (!job) return new Response(400, {}, { ok: false, error: 'did not find eligible task to run' });
    job.lastRunAt = now;
    broadcast(bgFrame());
    return { ok: true, taskId: null };
  });

  server.patch('/background/jobs/:id', (schema, req) => {
    const job = db.background.find((d) => d.id === req.params.id);
    if (!job) return new Response(400, {}, { ok: false, error: 'no such job' });
    const body = parseBody(req);
    if (body.conclude !== undefined && !CONCLUDE_VALUES.includes(body.conclude)) {
      return new Response(400, {}, { ok: false, error: `conclude must be one of ${CONCLUDE_VALUES.join('|')}` });
    }
    for (const k of ['title', 'description', 'cwd', 'cooldownHours', 'enabled', 'lastRunAt', 'lastTaskId', 'conclude']) {
      if (body[k] !== undefined) job[k] = body[k];
    }
    if (body.window) job.window = { ...job.window, ...body.window };
    if (body.thresholds) {
      for (const [backend, tv] of Object.entries(body.thresholds)) {
        if (tv && typeof tv === 'object') job.thresholds[backend] = { ...job.thresholds[backend], ...tv };
      }
    }
    if (body.models) job.models = { ...job.models, ...body.models };
    if (body.tokenCaps) job.tokenCaps = { ...job.tokenCaps, ...body.tokenCaps };
    if (Array.isArray(body.scopes)) job.scopes = body.scopes;
    broadcast(bgFrame());
    return { ok: true, job };
  });

  server.delete('/background/jobs/:id', (schema, req) => {
    const i = db.background.findIndex((d) => d.id === req.params.id);
    if (i === -1) return new Response(400, {}, { ok: false, error: 'no such job' });
    db.background.splice(i, 1);
    broadcast(bgFrame());
    return { ok: true };
  });

  // ---- Reports (always empty — the mock never runs a background task) -----

  server.get('/background/reports', () => ({ reports: [] }));

  server.get('/background/reports/:taskId', () => new Response(404, {}, { ok: false, error: 'not found' }));

  server.patch('/background/reports/:taskId/flag', () => new Response(400, {}, { ok: false, error: 'no such report' }));
}
