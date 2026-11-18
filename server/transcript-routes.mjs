import { resolve } from 'node:path';

// Same comparison codex-thread.mjs's normPath applies (main's cwd rule for
// `codexOwnerForThread`), duplicated here because that module's usage.mjs ->
// app-dir.mjs chain requires SINGULARITY_HOME at module load — this route module
// must stay importable before a test sets it.
function normCwd(path) {
  const normalized = resolve(path).replace(/\\/g, '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

// Main's `/transcripts` handed sessions.mjs the codex-aware `reg.isLiveSession`
// (`66591a9:server/index.mjs:919`, `agents.mjs:153-156`): a codex row's id is the
// rollout thread uuid, not the registry key, so liveness must resolve through
// `codexOwnerForThread(threadId, cwd)`. The Rust port moved that relation into
// `rust/backend/src/agent_registry.rs:584-620` and dropped it from the Node
// registry, so rebuild it from the registry's public surface: for every live
// agent resolve its pinned codex thread (`reg.codexThreadFor`, the async
// `rememberCodexThread` wrapper; null for claude agents) and match rows by thread
// uuid with main's cwd rule. `codexThreadFor` can await the model route (main's
// sync `isCodexModel` could not fail), so a lookup error leaves that row non-live
// instead of failing the whole list — main has no async failure to mirror here.
// VERIFY: wave5-js_followup-1
async function codexAwareIsLive(reg) {
  const owners = new Map(); // codex thread uuid -> live owner agent
  for (const a of reg.snapshot()) {
    if (!reg.isLive(a.id)) continue; // main skips detached records before discovery
    let threadId = null;
    try { threadId = await reg.codexThreadFor(a.id); } catch { /* best-effort, as above */ }
    if (threadId && !owners.has(threadId)) owners.set(threadId, a);
  }
  return (id, { source, cwd } = {}) => {
    if (reg.isLive(id)) return true;
    if (source !== 'codex' || !id) return false;
    const owner = owners.get(id);
    if (!owner) return false;
    return !cwd || (!!owner.cwd && normCwd(owner.cwd) === normCwd(cwd));
  };
}

export function registerTranscriptRoutes(app, { reg, listSessions, readSession, searchSessions, subagentsFor, getSessionsRoot, setSessionsRoot }) {
  app.get('/transcripts/root', async () => ({ root: await getSessionsRoot() }));
  app.put('/transcripts/root', async (req) => setSessionsRoot(req.body?.root));
  app.get('/transcripts', async (req) => ({ sessions: await listSessions({ cap: Number(req.query.cap) || 5000, isLive: await codexAwareIsLive(reg), root: req.query.root, hideReviews: req.query.hideReviews === '1' }) }));
  // Resolve a registered agent's id to its codex-minted thread uuid — the Sessions
  // dock's "View transcript" button needs this before it can open a codex agent's
  // transcript (its registry id is unrelated to the rollout's thread uuid).
  app.get('/transcripts/codex-thread', async (req, reply) => {
    const id = req.query?.id;
    if (!id) return reply.code(400).send({ ok: false, error: 'id required' });
    const threadId = await reg.codexThreadFor(id);
    if (!threadId) return reply.code(404).send({ ok: false, error: 'not found' });
    return { ok: true, threadId };
  });
  app.get('/transcript', async (req, reply) => {
    const { project, id, root, source, file } = req.query || {};
    if (!project || !id) return reply.code(400).send({ ok: false, error: 'project + id required' });
    const r = await readSession(project, id, root, source, file);
    if (r.ok) {
      // Skill-scopes live only in the agent registry (not the transcript), so
      // merge them in here for the Resume prefill when the id is a known agent.
      // For codex threads, the registry lookup is by (thread uuid + cwd), not agent id.
      const lc = source === 'codex'
        ? await reg.getLaunchConfigForCodexThread(id, r.meta?.cwd)
        : reg.getLaunchConfig(id);
      if (lc?.scopes?.length) r.meta.scopes = lc.scopes;
    }
    if (!r.ok) reply.code(404);
    return r;
  });
  app.get('/transcripts/search', (req) => searchSessions(req.query.q, { project: req.query.project, id: req.query.id, root: req.query.root, hideReviews: req.query.hideReviews === '1' }));
  // Live subagents nested under the dock's agent rows (indicator only). Scoped to
  // live agents so it stays cheap — no full 500-session scan like /transcripts.
  app.get('/subagents', async () => {
    const out = {};
    for (const a of reg.snapshot()) {
      if (a.status !== 'running' && a.status !== 'idle' && a.status !== 'starting') continue;
      const subs = await subagentsFor(a.cwd, a.id, reg.isLive);
      if (subs.length) out[a.id] = subs;
    }
    return { subagents: out };
  });
}
