// Session history routes: list, read, search, and per-session stats for the
// Transcripts panel (SessionHistory + TranscriptView). Shapes mirror
// server/index.mjs + server/sessions.mjs + server/stats.mjs exactly (design.md
// D8): /transcripts/root GET is a bare { root }, /transcripts is a bare
// { sessions }, /transcript returns { ok, meta, messages } with real 400/404s,
// /transcripts/search returns { results, capped }, and /transcripts/stats
// returns { stats } keyed by
// session id. The mock has no codex sessions and no agent-registry launch
// configs, so the codex source and scopes-merge branches are skipped.
import { Response } from 'miragejs';
import { db } from '../db.js';
import { ROOTS } from '../fixtures.js';
import { parseBody } from '../helpers.js';
import { untildify } from '@/lib/paths.js';

const RUNNING_MS = 30000;        // mtime within this window reads as a live session (sessions.mjs)
const RESULT_CAP = 200;          // search result cap (sessions.mjs)
const TOOL_TRUNC = 300;          // tool_use inputs / tool_result bodies in the view payload
const SEARCH_TOOL_TRUNC = 500;   // tool bodies in the search payload

// Reverse-map a resolved claude model id back to its family alias so the
// Resume prefill shows a recognized dropdown option (models.mjs claudeIdToAlias).
const CLAUDE_ID_TO_ALIAS = [
  [/^claude-(opus)-[0-9].*\[1m\]$/, 'opus[1m]'],
  [/^claude-(sonnet)-[0-9].*\[1m\]$/, 'sonnet[1m]'],
  [/^claude-opus-/, 'opus'],
  [/^claude-sonnet-/, 'sonnet'],
  [/^claude-haiku-/, 'haiku'],
  [/^claude-fable-/, 'fable'],
];
const ALIAS_SET = new Set(['claude', 'best', 'fable', 'opus', 'sonnet', 'haiku', 'opus[1m]', 'sonnet[1m]', 'opusplan']);
function claudeIdToAlias(model) {
  if (!model || ALIAS_SET.has(model) || !model.startsWith('claude-')) return model;
  for (const [re, alias] of CLAUDE_ID_TO_ALIAS) if (re.test(model)) return alias;
  return model;
}

// The claude bin logs an ollama model on assistant events with its `:tag`
// stripped; restore the full preset when the stripped base uniquely matches
// (models.mjs restoreOllamaTag). No-op for the seeded claude models.
const OLLAMA_PRESETS = ['deepseek-v4-flash:cloud', 'glm-5.2:cloud', 'glm-5.3:cloud', 'glm-5.3-flash:cloud', 'kimi-k2.7-code:cloud', 'kimi-k3:cloud'];
function restoreOllamaTag(model) {
  if (!model || model.includes(':')) return model;
  const hits = OLLAMA_PRESETS.filter((p) => p.split(':')[0] === model);
  return hits.length === 1 ? hits[0] : model;
}

function trunc(s, n) {
  s = typeof s === 'string' ? s : JSON.stringify(s);
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

// First text out of a user event's content — tool_result blocks are never text
// (sessions.mjs firstUserText).
function firstUserText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const b = content.find((x) => x.type === 'text');
    return b ? b.text : null;
  }
  return null;
}

// Slash-command echoes surface as ordinary user events — skip them for blurb
// (sessions.mjs isCommandWrapper).
function isCommandWrapper(text) {
  const t = text.trimStart();
  return t.startsWith('<command-name') || t.startsWith('<local-command');
}

// Reduce a session's events to {cwd, title, blurb} — the list row's peek
// (sessions.mjs peekMeta): cwd = first event carrying one, title = last
// ai-title, blurb = first real user prompt flattened to ~140 chars.
function peekMeta(events) {
  let cwd = null;
  let title = null;
  let blurb = null;
  for (const e of events) {
    if (!cwd && e.cwd) cwd = e.cwd;
    if (e.type === 'ai-title' && e.aiTitle) title = e.aiTitle;
    if (!blurb && e.type === 'user' && !e.isMeta && !e.isCompactSummary) {
      const text = firstUserText(e.message?.content);
      if (text && !isCommandWrapper(text)) {
        const flat = text.replace(/\s+/g, ' ').trim();
        if (flat) blurb = flat.slice(0, 140);
      }
    }
  }
  return { cwd, title, blurb };
}

// Full parse into the {ok, meta, messages} readSession shape (sessions.mjs
// readSession). The mock has no codex source and no launch-config scopes, so
// the scopes merge is skipped.
function readSessionShape(session) {
  const events = session.events;
  const messages = [];
  let cwd = null, title = null, turns = 0, firstTs = null, lastTs = null, lastModel = null;
  for (const e of events) {
    if (e.cwd && !cwd) cwd = e.cwd;
    if (e.type === 'ai-title' && e.aiTitle) title = e.aiTitle;
    if (e.timestamp) {
      if (!firstTs) firstTs = e.timestamp;
      lastTs = e.timestamp;
    }
    const msg = e.message;
    if (!msg) continue;
    const ts = e.timestamp ?? null;
    if (e.type === 'user') {
      const c = msg.content;
      const extra = e.isCompactSummary ? { recap: true } : {};
      if (typeof c === 'string') {
        messages.push({ ts, role: 'user', kind: 'text', text: c, ...extra });
      } else if (Array.isArray(c)) {
        for (const b of c) {
          if (b.type === 'tool_result') messages.push({ ts, role: 'user', kind: 'toolResult', text: trunc(b.content, TOOL_TRUNC) });
          else if (b.type === 'text') messages.push({ ts, role: 'user', kind: 'text', text: b.text, ...extra });
        }
      }
    } else if (e.type === 'assistant') {
      turns++;
      if (msg.model) lastModel = msg.model;
      for (const b of (msg.content || [])) {
        if (b.type === 'text') messages.push({ ts, role: 'assistant', kind: 'text', text: b.text });
        else if (b.type === 'thinking') messages.push({ ts, role: 'assistant', kind: 'thinking', text: b.thinking });
        else if (b.type === 'tool_use') messages.push({ ts, role: 'assistant', kind: 'toolUse', name: b.name, text: trunc(b.input, TOOL_TRUNC) });
      }
    }
  }
  return { ok: true, meta: { cwd, title, turns, firstTs, lastTs, model: restoreOllamaTag(claudeIdToAlias(lastModel)) }, messages };
}

// Text items for search — cheaper than readSessionShape, text only
// (sessions.mjs readSessionForSearch).
function textItems(session) {
  const items = [];
  let cwd = null;
  for (const e of session.events) {
    if (e.cwd && !cwd) cwd = e.cwd;
    const msg = e.message;
    if (!msg) continue;
    if (e.type === 'user') {
      const c = msg.content;
      if (typeof c === 'string') items.push({ idx: items.length, role: 'user', text: c, cwd });
      else if (Array.isArray(c)) for (const b of c) {
        if (b.type === 'text') items.push({ idx: items.length, role: 'user', text: b.text, cwd });
        else if (b.type === 'tool_result') items.push({ idx: items.length, role: 'user', text: trunc(b.content, SEARCH_TOOL_TRUNC), cwd });
      }
    } else if (e.type === 'assistant') {
      for (const b of (msg.content || [])) {
        if (b.type === 'text') items.push({ idx: items.length, role: 'assistant', text: b.text, cwd });
        else if (b.type === 'thinking') items.push({ idx: items.length, role: 'assistant', text: b.thinking, cwd });
        else if (b.type === 'tool_use') items.push({ idx: items.length, role: 'assistant', text: `[tool: ${b.name}] ${trunc(b.input, SEARCH_TOOL_TRUNC)}`, cwd });
      }
    }
  }
  return items;
}

// Context window around a match, same as sessions.mjs snippet.
function snippet(text, at, q) {
  const start = Math.max(0, at - 60);
  const end = Math.min(text.length, at + q.length + 60);
  return (start > 0 ? '…' : '') + text.slice(start, end).trim() + (end < text.length ? '…' : '');
}

// Per-session stats (stats.mjs sessionStats). The seeded events carry no usage
// blocks, so every token bucket is 0 and cost is null — exactly what the
// daemon's parseByPath returns for them (the e2e spec asserts the "0 sent · 0
// received" line), with turns derived from the assistant-event count.
function sessionStatsFor(session) {
  const turns = session.events.filter((e) => e.type === 'assistant').length;
  return {
    turns,
    tokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    models: [],
    exists: true,
    estCostUsd: null,
    costUsd: null,
    costSource: null,
  };
}

const EMPTY_SESSION = { turns: 0, tokens: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, models: [], exists: false, estCostUsd: null, costUsd: null, costSource: null };

function findSession(project, id) {
  const list = db.sessions[project];
  if (!list) return null;
  return list.find((s) => s.id === id) || null;
}

export function registerSessions(server) {
  // /transcripts/root — the FS-persisted picker root. GET returns the bare
  // { root } the daemon serves; PUT stores the choice in db.roots.sessions and
  // mirrors setSessionsRoot's { ok, root } / { ok:false, error:'bad root' }.
  server.get('/transcripts/root', () => ({ root: db.roots.sessions || ROOTS.projects }));
  server.put('/transcripts/root', (schema, req) => {
    const root = parseBody(req).root;
    if (typeof root !== 'string' || !root) return { ok: false, error: 'bad root' };
    db.roots.sessions = root;
    return { ok: true, root };
  });

  // /transcripts — every transcript, reverse-chrono by mtime, capped. Row shape
  // matches listSessions: { id, project, cwd, title, blurb, mtime, size,
  // running, source }. The mock has no subagents, so no subagents field.
  server.get('/transcripts', (schema, req) => {
    const cap = Number(req.queryParams.cap) || 5000;
    // The daemon resolves the client-supplied root to enumerate transcripts
    // (sessions.mjs listSessions). The seeded 32-session corpus lives at the
    // ROOTS.projects path and never moves — a root other than that corpus root
    // has no sessions in the mock, so return an empty list. Compare against the
    // constant, not the mutable db.roots.sessions (PUT /transcripts/root mutates
    // it), or the corpus would be served under any freshly-picked root.
    const root = req.queryParams.root;
    if (root && untildify(root) !== ROOTS.projects) return { sessions: [] };
    const now = Date.now();
    const rows = [];
    for (const [project, sessions] of Object.entries(db.sessions)) {
      for (const s of sessions) {
        const { cwd, title, blurb } = peekMeta(s.events);
        rows.push({
          id: s.id,
          project,
          cwd,
          title,
          blurb,
          mtime: s.mtimeMs,
          size: JSON.stringify(s.events).length,
          running: (now - s.mtimeMs) < RUNNING_MS,
          source: 'claude',
        });
      }
    }
    rows.sort((a, b) => b.mtime - a.mtime);
    return { sessions: rows.slice(0, cap) };
  });

  // /transcript — one transcript. 400 when project/id are missing, 404 on miss,
  // else the { ok, meta, messages } readSession shape.
  server.get('/transcript', (schema, req) => {
    const { project, id } = req.queryParams || {};
    if (!project || !id) return new Response(400, {}, { ok: false, error: 'project + id required' });
    const session = findSession(project, id);
    if (!session) return new Response(404, {}, { ok: false, error: 'not found' });
    return readSessionShape(session);
  });

  // /transcripts/search — substring search over session text, scoped to one
  // session when {project,id} given. Mirrors searchSessions: id matches
  // synthesize a role:'id' hit; text matches carry the line-indexed snippet.
  server.get('/transcripts/search', (schema, req) => {
    const q = req.queryParams.q || '';
    const ql = q.toLowerCase();
    if (!ql) return { results: [], capped: false };
    // Same root gate as /transcripts: the corpus lives at ROOTS.projects, so any
    // other root (including a freshly-picked db.roots.sessions) has nothing to
    // search.
    const root = req.queryParams.root;
    if (root && untildify(root) !== ROOTS.projects) return { results: [], capped: false };
    const { project, id } = req.queryParams || {};
    const targets = [];
    if (project && id) {
      const s = findSession(project, id);
      if (s) targets.push(s);
    } else {
      for (const sessions of Object.values(db.sessions)) for (const s of sessions) targets.push(s);
    }
    const results = [];
    for (const t of targets) {
      const items = textItems(t);
      if (t.id.toLowerCase().includes(ql)) {
        results.push({ project: t.project, id: t.id, cwd: items?.[0]?.cwd || null, lineIndex: 0, role: 'id', snippet: t.id, source: 'claude' });
        if (results.length >= RESULT_CAP) return { results, capped: true };
        continue;
      }
      for (const it of items) {
        const at = it.text.toLowerCase().indexOf(ql);
        if (at < 0) continue;
        results.push({ project: t.project, id: t.id, cwd: it.cwd, lineIndex: it.idx, role: it.role, snippet: snippet(it.text, at, q), source: 'claude' });
        if (results.length >= RESULT_CAP) return { results, capped: true };
      }
    }
    return { results, capped: false };
  });

  // /transcripts/stats — batched per-session cost + token breakdown for the
  // visible list page. Mirrors index.mjs: { stats } keyed by session id.
  server.post('/transcripts/stats', (schema, req) => {
    const body = parseBody(req);
    const items = Array.isArray(body.items) ? body.items.slice(0, 200) : [];
    const stats = {};
    for (const it of items) {
      if (it?.project && it?.id) {
        const s = findSession(it.project, it.id);
        stats[it.id] = s ? sessionStatsFor(s) : EMPTY_SESSION;
      }
    }
    return { stats };
  }, 200);
}
