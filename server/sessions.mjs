// Session history backend: enumerate, read, and search the Claude Code
// transcripts at ~/.claude/projects/<project>/<id>.jsonl. Each .jsonl is one
// session; `project` is the encoded-cwd dirname (we pull the real cwd out of
// the events themselves rather than decoding the lossy dirname). The chat
// module reuses readSession()/sessionText() to build LLM context.
import { existsSync, readdirSync, statSync, readFileSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const PROJECTS = join(homedir(), '.claude', 'projects');
const PEEK_BYTES = 65536;     // list only peeks the head — full MB reads are deferred to open
const RESULT_CAP = 200;
const TOOL_TRUNC = 300;       // tool_use inputs / tool_result bodies in the view payload
const TEXT_CAP = 80000;       // sessionText head+tail cap (chars)

// Parse JSONL text (head chunk or full file) into event objects, skipping
// unparseable lines. Pure, no FS — shared by peek + full read.
function parseEvents(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch { /* partial/locked */ }
  }
  return out;
}

// Read only the first PEEK_BYTES of a file — stat the size + head chunk so the
// list endpoint never reads whole multi-MB transcripts. Returns null if gone.
function peek(p) {
  let st;
  try { st = statSync(p); } catch { return null; }
  let head = '';
  try {
    const fd = openSync(p, 'r');
    const buf = Buffer.alloc(PEEK_BYTES);
    const n = readSync(fd, buf, 0, Math.min(PEEK_BYTES, st.size), 0);
    head = buf.slice(0, n).toString('utf8');
    closeSync(fd);
  } catch {}
  return { st, head };
}

// Reduce a peek's events to {cwd, title}. cwd = first event carrying one;
// title = last `ai-title` seen (Claude Code refines it across the session).
function peekMeta(events) {
  let cwd = null;
  let title = null;
  for (const e of events) {
    if (!cwd && e.cwd) cwd = e.cwd;
    if (e.type === 'ai-title' && e.aiTitle) title = e.aiTitle;
  }
  return { cwd, title };
}

// listSessions: every *.jsonl under PROJECTS, reverse-chrono by mtime. The
// (mtime,size)-keyed cache holds the peeked meta so repeated list calls don't
// re-read heads of unchanged files.
const metaCache = new Map(); // path -> { mtimeMs, size, cwd, title }
export function listSessions({ cap = 5000 } = {}) {
  if (!existsSync(PROJECTS)) return [];
  const out = [];
  for (const proj of readdirSync(PROJECTS, { withFileTypes: true })) {
    if (!proj.isDirectory()) continue;
    const dir = join(PROJECTS, proj.name);
    let files;
    try { files = readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const p = join(dir, f);
      const pk = peek(p);
      if (!pk) continue;
      const { st } = pk;
      let cwd = null, title = null;
      const hit = metaCache.get(p);
      if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
        cwd = hit.cwd; title = hit.title;
      } else {
        ({ cwd, title } = peekMeta(parseEvents(pk.head)));
        metaCache.set(p, { mtimeMs: st.mtimeMs, size: st.size, cwd, title });
      }
      out.push({ id: f.slice(0, -6), project: proj.name, cwd, title, mtime: st.mtimeMs, size: st.size });
    }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out.slice(0, cap);
}

function pathFor(project, id) { return join(PROJECTS, project, `${id}.jsonl`); }

function trunc(s, n) {
  s = typeof s === 'string' ? s : JSON.stringify(s);
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

// readSession: full parse into a renderable message list + meta. tool_use inputs
// and tool_result bodies are truncated in the payload (the raw file is the
// source of truth); text/thinking are kept whole for the chat context.
export function readSession(project, id) {
  const p = pathFor(project, id);
  if (!existsSync(p)) return { ok: false, error: 'not found' };
  const events = parseEvents(readFileSync(p, 'utf8'));
  const messages = [];
  let cwd = null, title = null, turns = 0, firstTs = null, lastTs = null;
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
      if (typeof c === 'string') {
        messages.push({ ts, role: 'user', kind: 'text', text: c });
      } else if (Array.isArray(c)) {
        for (const b of c) {
          if (b.type === 'tool_result') messages.push({ ts, role: 'user', kind: 'toolResult', text: trunc(b.content, TOOL_TRUNC) });
          else if (b.type === 'text') messages.push({ ts, role: 'user', kind: 'text', text: b.text });
        }
      }
    } else if (e.type === 'assistant') {
      turns++;
      for (const b of (msg.content || [])) {
        if (b.type === 'text') messages.push({ ts, role: 'assistant', kind: 'text', text: b.text });
        else if (b.type === 'thinking') messages.push({ ts, role: 'assistant', kind: 'thinking', text: b.thinking });
        else if (b.type === 'tool_use') messages.push({ ts, role: 'assistant', kind: 'toolUse', name: b.name, text: trunc(b.input, TOOL_TRUNC) });
      }
    }
  }
  return { ok: true, meta: { cwd, title, turns, firstTs, lastTs }, messages };
}

// sessionText: flatten a session into a compact transcript for LLM context.
// [user]/[assistant] turns + [tool: name] calls; head+tail cap keeps both the
// opening problem statement and the most recent turns when the log is long.
export function sessionText(project, id, cap = TEXT_CAP) {
  const s = readSession(project, id);
  if (!s.ok) return '';
  const lines = [];
  for (const m of s.messages) {
    if (m.kind === 'toolResult') lines.push(`[tool_result] ${m.text}`);
    else if (m.kind === 'toolUse') lines.push(`[tool: ${m.name}] ${m.text}`);
    else lines.push(`[${m.role}] ${m.text}`);
  }
  let text = lines.join('\n');
  if (text.length <= cap) return text;
  const half = Math.floor(cap / 2);
  return `${text.slice(0, half)}\n\n[…truncated…]\n\n${text.slice(-half)}`;
}

// searchSessions: substring search over session text. Scoped to one file when
// {project,id} given, else every *.jsonl. Returns line-indexed matches capped
// at RESULT_CAP. The text per message is cached by (mtime,size) like memory.mjs.
const textCache = new Map(); // path -> { mtimeMs, size, items: [{role,text}] }
function sessionTextItems(p) {
  let st;
  try { st = statSync(p); } catch { return null; }
  const hit = textCache.get(p);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.items;
  const s = readSessionForSearch(p);
  textCache.set(p, { mtimeMs: st.mtimeMs, size: st.size, items: s });
  return s;
}
// Cheaper than readSession: keep text/thinking/tool whole-ish (truncate tool
// bodies to a search-friendly 500) and drop the meta — search only needs text.
function readSessionForSearch(p) {
  const events = parseEvents(readFileSync(p, 'utf8'));
  const items = [];
  let cwd = null;
  for (const e of events) {
    if (e.cwd && !cwd) cwd = e.cwd;
    const msg = e.message;
    if (!msg) continue;
    if (e.type === 'user') {
      const c = msg.content;
      if (typeof c === 'string') items.push({ idx: items.length, role: 'user', text: c, cwd });
      else if (Array.isArray(c)) for (const b of c) {
        if (b.type === 'text') items.push({ idx: items.length, role: 'user', text: b.text, cwd });
        else if (b.type === 'tool_result') items.push({ idx: items.length, role: 'user', text: trunc(b.content, 500), cwd });
      }
    } else if (e.type === 'assistant') {
      for (const b of (msg.content || [])) {
        if (b.type === 'text') items.push({ idx: items.length, role: 'assistant', text: b.text, cwd });
        else if (b.type === 'thinking') items.push({ idx: items.length, role: 'assistant', text: b.thinking, cwd });
        else if (b.type === 'tool_use') items.push({ idx: items.length, role: 'assistant', text: `[tool: ${b.name}] ${trunc(b.input, 500)}`, cwd });
      }
    }
  }
  return items;
}

function snippet(text, at, q) {
  const start = Math.max(0, at - 60);
  const end = Math.min(text.length, at + q.length + 60);
  return (start > 0 ? '…' : '') + text.slice(start, end).trim() + (end < text.length ? '…' : '');
}

export function searchSessions(q, { project, id } = {}) {
  const ql = (q || '').toLowerCase();
  if (!ql) return { results: [], capped: false };
  const targets = [];
  if (project && id) {
    const p = pathFor(project, id);
    if (existsSync(p)) targets.push({ project, id, path: p });
  } else if (existsSync(PROJECTS)) {
    for (const proj of readdirSync(PROJECTS, { withFileTypes: true })) {
      if (!proj.isDirectory()) continue;
      const dir = join(PROJECTS, proj.name);
      let files;
      try { files = readdirSync(dir); } catch { continue; }
      for (const f of files) if (f.endsWith('.jsonl')) targets.push({ project: proj.name, id: f.slice(0, -6), path: join(dir, f) });
    }
  }
  const results = [];
  for (const t of targets) {
    const items = sessionTextItems(t.path);
    if (!items) continue;
    for (const it of items) {
      const at = it.text.toLowerCase().indexOf(ql);
      if (at < 0) continue;
      results.push({ project: t.project, id: t.id, cwd: it.cwd, lineIndex: it.idx, role: it.role, snippet: snippet(it.text, at, ql) });
      if (results.length >= RESULT_CAP) return { results, capped: true };
    }
  }
  return { results, capped: false };
}