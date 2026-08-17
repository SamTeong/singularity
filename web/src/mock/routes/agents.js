// Agent routes: the dock's per-agent stats, live-subagent rows, and the two
// session actions that leave the dock (external terminal, codex transcript).
// These mirror server/index.mjs exactly (design.md D8): /agent-stats and
// /subagents are bare keyed objects with no `ok`; /session/external and
// /session/codex-thread report failure as real HTTP 400/404 with an `ok:false`
// body. The mock has no transcript files and no codex threads, so stats are
// derived from each agent's cumulative pty bytes (written) and subagents are
// always empty — the client renders nothing for an empty map (AgentsProvider
// polls both once the socket connects).
import { Response } from 'miragejs';
import { db } from '../db.js';
import { broadcast } from '../ws.js';
import { parseBody } from '../helpers.js';

// The `list` frame's agents array — the 9 fields reg.snapshot() exposes
// (server/agents.mjs:128). ws.js keeps the same projection module-private, so
// this route rebuilds it inline to fan the post-removal list to every socket.
function snapshotAgents() {
  return db.agents.map(({ id, title, cwd, status, pid, createdAt, model, scopes, tool }) => ({
    id, title, cwd, status, pid, createdAt, model, scopes, tool,
  }));
}

export function registerAgents(server) {
  // /agent-stats — { stats: { [id]: { turns, tokens, inputTokens, ... } } }.
  // The daemon parses each session's .jsonl (stats.mjs statsFor); the mock has
  // no transcripts, so derive plausible counts from the agent's cumulative pty
  // bytes (written). The client only displays these (SessionRow.jsx), never
  // acts on them.
  server.get('/agent-stats', () => {
    const stats = {};
    for (const a of db.agents) {
      const written = a.written || 0;
      const turns = Math.floor(written / 100);
      const tokens = written;
      const inputTokens = Math.floor(tokens * 0.7);
      stats[a.id] = {
        turns, tokens, inputTokens,
        outputTokens: tokens - inputTokens,
        cacheReadTokens: 0, cacheWriteTokens: 0,
        models: a.model ? [a.model] : [],
        exists: true, estCostUsd: null,
        costUsd: null, costSource: null,
        apiMs: null, wallMs: null, busyMs: 0,
      };
    }
    return { stats };
  });

  // /subagents — { subagents: { [agentId]: [row] } }. The daemon scans each
  // live agent's <id>/subagents/ dir (sessions.mjs subagentsFor); the mock has
  // no subagent transcripts, so the map is always empty — the client renders
  // nothing for an empty map (SessionDock passes subagents[a.id] || []).
  server.get('/subagents', () => ({ subagents: {} }));

  // /session/external — POST { id }. The daemon spawns an external terminal
  // then drops the session from the dock (agents.mjs externalLaunch + remove);
  // the mock can't spawn a terminal, so it mirrors the observable behaviour:
  // validate the id, remove the agent, fan the updated list, return { ok: true }.
  server.post('/session/external', (schema, req) => {
    const id = parseBody(req).id;
    if (!id) return new Response(400, {}, { ok: false, error: 'id required' });
    const i = db.agents.findIndex((a) => a.id === id);
    if (i < 0) return new Response(400, {}, { ok: false, error: 'not found' });
    db.agents.splice(i, 1);
    broadcast({ t: 'list', agents: snapshotAgents(), recentRepos: db.recentRepos || [] });
    return { ok: true };
  }, 200);

  // /session/codex-thread — GET ?id=. The daemon resolves a codex agent's
  // registry id to its codex-minted thread uuid (agents.mjs codexThreadFor);
  // the mock never seeds codex agents and has no codex threads, so every lookup
  // 404s. The client (AppShell viewTranscript) only calls this for codex agents
  // and falls back to the id itself on a non-ok reply, so 404 is safe.
  server.get('/session/codex-thread', (schema, req) => {
    const id = req.queryParams?.id;
    if (!id) return new Response(400, {}, { ok: false, error: 'id required' });
    return new Response(404, {}, { ok: false, error: 'not found' });
  });
}
