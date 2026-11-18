// Node retains Plans root configuration and the SID-to-directory security
// boundary. Markdown parsing and bounded read operations run in Rust.
import { realpath, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

export const PLAN_ROOT = process.env.SING_PLANS_ROOT
  ? resolve(process.env.SING_PLANS_ROOT)
  : null;

const SID_RE = /^[0-9a-f-]{8,64}$/i;

export async function resolveSessionDirectory(sid) {
  if (PLAN_ROOT == null) return { ok: false, error: 'plans disabled' };
  if (typeof sid !== 'string' || !SID_RE.test(sid)) return { ok: false, error: 'bad sid' };
  try {
    const root = await realpath(PLAN_ROOT);
    const dir = await realpath(resolve(root, sid));
    if (dir !== root && !dir.startsWith(root + sep)) return { ok: false, error: 'bad sid' };
    if (!(await stat(dir)).isDirectory()) return { ok: false, error: 'not found' };
    return { ok: true, dir };
  } catch {
    return { ok: false, error: 'not found' };
  }
}

export function createPlanSessionsHandler(backend, logger) {
  return async (_req, reply) => {
    try { return await backend.planSessions(PLAN_ROOT); }
    catch (error) {
      logger.error({ err: error.message }, 'Rust Plans list backend failed');
      reply.code(500);
      return { ok: false, error: 'plans backend unavailable' };
    }
  };
}

export function createPlanSessionHandler(backend, logger) {
  return async (req, reply) => {
    const result = await resolveSessionDirectory(req.query.sid);
    if (!result.ok) {
      reply.code(result.error === 'not found' || result.error === 'plans disabled' ? 404 : 400);
      return result;
    }
    try { return await backend.planSession(result.dir, req.query.sid); }
    catch (error) {
      logger.error({ err: error.message }, 'Rust Plans detail backend failed');
      reply.code(500);
      return { ok: false, error: 'plans backend unavailable' };
    }
  };
}
