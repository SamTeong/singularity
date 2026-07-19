// Session history backend: enumerate, read, and search the Claude Code
// transcripts at ~/.claude/projects/<project>/<id>.jsonl. Each .jsonl is one
// session; `project` is the encoded-cwd dirname (we pull the real cwd out of
// the events themselves rather than decoding the lossy dirname). The chat
// module reuses readSession()/sessionText() to build LLM context.
import { existsSync } from 'node:fs';
import { readdir, stat, readFile, open } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';

const PROJECTS = join(homedir(), '.claude', 'projects');
const PEEK_BYTES = 65536;     // list only peeks the head — full MB reads are deferred to open
const RESULT_CAP = 200;
const TOOL_TRUNC = 300;       // tool_use inputs / tool_result bodies in the view payload
const TEXT_CAP = 80000;       // sessionText head+tail cap (chars)
const RUNNING_MS = 30000;     // external-session recency heuristic: mtime within this window counts as running

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
async function peek(p) {
  let st;
  try { st = await stat(p); } catch { return null; }
  let head = '';
  try {
    const fh = await open(p, 'r');
    try {
      const buf = Buffer.alloc(PEEK_BYTES);
      const { bytesRead } = await fh.read(buf, 0, Math.min(PEEK_BYTES, st.size), 0);
      head = buf.slice(0, bytesRead).toString('utf8');
    } finally { await fh.close(); }
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
export async function listSessions({ cap = 5000, isLive = () => false, now = Date.now() } = {}) {
  if (!existsSync(PROJECTS)) return [];
  const out = [];
  for (const proj of await readdir(PROJECTS, { withFileTypes: true })) {
    if (!proj.isDirectory()) continue;
    const dir = join(PROJECTS, proj.name);
    let files;
    try { files = await readdir(dir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const p = join(dir, f);
      const pk = await peek(p);
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
      const id = f.slice(0, -6);
      const row = { id, project: proj.name, cwd, title, mtime: st.mtimeMs, size: st.size };
      row.running = isLive(id) || (now - st.mtimeMs) < RUNNING_MS;
      // Subagents are separate transcripts under <parent-id>/subagents/agent-*.jsonl,
      // full-session shape. Their tool_result bodies are inline in the jsonl (the
      // sibling tool-results/ dir is not referenced), so readSession renders them
      // unchanged — no ref resolution needed.
      const subagents = await listSubagents(dir, id, isLive, now);
      if (subagents.length) row.subagents = subagents;
      out.push(row);
    }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out.slice(0, cap);
}

// Scan <parentDir>/<parentId>/subagents/agent-*.jsonl and reduce each to a row.
// Reuses peek/peekMeta/metaCache for title fallback — same as the parent loop.
async function listSubagents(parentDir, parentId, isLive, now) {
  const subDir = join(parentDir, parentId, 'subagents');
  let files;
  try { files = await readdir(subDir); } catch { return []; }
  const out = [];
  for (const f of files) {
    if (!f.endsWith('.jsonl')) continue;
    const p = join(subDir, f);
    const pk = await peek(p);
    if (!pk) continue;
    const { st } = pk;
    const agentId = f.slice(0, -6);
    let title = null;
    try {
      const meta = JSON.parse(await readFile(join(subDir, `${agentId}.meta.json`), 'utf8'));
      if (meta.agentType) title = meta.description ? `${meta.agentType}: ${meta.description}` : meta.agentType;
    } catch {}
    if (!title) {
      const hit = metaCache.get(p);
      if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
        title = hit.title;
      } else {
        const peeked = peekMeta(parseEvents(pk.head));
        title = peeked.title;
        metaCache.set(p, { mtimeMs: st.mtimeMs, size: st.size, cwd: peeked.cwd, title: peeked.title });
      }
    }
    out.push({
      id: `${parentId}/subagents/${agentId}`,
      agentId,
      title,
      mtime: st.mtimeMs,
      size: st.size,
      running: isLive(agentId) || (now - st.mtimeMs) < RUNNING_MS,
    });
  }
  return out;
}

// Path guard: project/id come from the client query — reject separators (no
// nested traversal) and confirm the joined path still resolves under PROJECTS
// (mirrors isWikiPath/isMemoryPath in wiki.mjs/memory.mjs). The one relaxation:
// a subagent open-ref shaped "<parent-id>/subagents/agent-x" is allowed through
// as a nested relative path; anything else with a separator in id stays banned.
const SUBAGENT_ID = /^[^\\/]+\/subagents\/agent-[^\\/]+$/;
function pathFor(project, id) {
  if (!project || !id || /[\\/]/.test(project)) return null;
  const nested = SUBAGENT_ID.test(id);
  if (!nested && /[\\/]/.test(id)) return null;
  const p = join(PROJECTS, project, `${id}.jsonl`);
  const root = resolve(PROJECTS);
  const abs = resolve(p);
  if (abs !== root && !abs.startsWith(root + sep)) return null;
  return p;
}

function trunc(s, n) {
  s = typeof s === 'string' ? s : JSON.stringify(s);
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

// readSession: full parse into a renderable message list + meta. tool_use inputs
// and tool_result bodies are truncated in the payload (the raw file is the
// source of truth); text/thinking are kept whole for the chat context.
export async function readSession(project, id) {
  const p = pathFor(project, id);
  if (!p || !existsSync(p)) return { ok: false, error: 'not found' };
  const events = parseEvents(await readFile(p, 'utf8'));
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
export async function sessionText(project, id, cap = TEXT_CAP) {
  const s = await readSession(project, id);
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
async function sessionTextItems(p) {
  let st;
  try { st = await stat(p); } catch { return null; }
  const hit = textCache.get(p);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.items;
  let s;
  try { s = await readSessionForSearch(p); } catch { return null; }
  textCache.set(p, { mtimeMs: st.mtimeMs, size: st.size, items: s });
  if (textCache.size > 200) textCache.delete(textCache.keys().next().value);
  return s;
}
// Cheaper than readSession: keep text/thinking/tool whole-ish (truncate tool
// bodies to a search-friendly 500) and drop the meta — search only needs text.
async function readSessionForSearch(p) {
  const events = parseEvents(await readFile(p, 'utf8'));
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

export async function searchSessions(q, { project, id } = {}) {
  const ql = (q || '').toLowerCase();
  if (!ql) return { results: [], capped: false };
  const targets = [];
  if (project && id) {
    const p = pathFor(project, id);
    if (p && existsSync(p)) targets.push({ project, id, path: p });
  } else if (existsSync(PROJECTS)) {
    for (const proj of await readdir(PROJECTS, { withFileTypes: true })) {
      if (!proj.isDirectory()) continue;
      const dir = join(PROJECTS, proj.name);
      let files;
      try { files = await readdir(dir); } catch { continue; }
      for (const f of files) if (f.endsWith('.jsonl')) targets.push({ project: proj.name, id: f.slice(0, -6), path: join(dir, f) });
    }
  }
  const results = [];
  for (const t of targets) {
    const items = await sessionTextItems(t.path);
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