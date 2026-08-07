// Session history backend: enumerate, read, and search the Claude Code
// transcripts at <root>/<project>/<id>.jsonl (root is FS-persisted and client-
// selectable, default ~/.claude/projects — mirrors memory.mjs's root pattern).
// Each .jsonl is one session; `project` is the encoded-cwd dirname (we pull
// the real cwd out of the events themselves rather than decoding the lossy
// dirname). The chat module reuses readSession()/sessionText() to build LLM
// context.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { readdir, stat, readFile, open } from 'node:fs/promises';
import { join, resolve, sep, normalize, basename, relative } from 'node:path';
import { homedir } from 'node:os';
import { encodeCwd } from './agents.mjs';
import { OLLAMA_PRESETS, claudeIdToAlias } from './models.mjs';
import { STATE_DIR } from './app-dir.mjs';
import { CODEX_HOME } from './usage.mjs';

const DEFAULT_ROOT = join(homedir(), '.claude', 'projects');

// The claude bin logs an ollama model on assistant events with its `:tag`
// stripped (glm-5.2:cloud -> glm-5.2). That stripped name is what readSession()
// would otherwise return as meta.model, and what the Transcripts Resume button
// prefills — but ollama rejects it at spawn. Restore the full preset when the
// stripped base uniquely matches a known ollama preset. No match → pass through
// (free-text model, a future preset, or a claude alias/id unchanged).
function restoreOllamaTag(model) {
  if (!model || model.includes(':')) return model;
  const hits = OLLAMA_PRESETS.filter((p) => p.split(':')[0] === model);
  return hits.length === 1 ? hits[0] : model;
}
const PEEK_BYTES = 65536;     // list only peeks the head — full MB reads are deferred to open
const RESULT_CAP = 200;
const TOOL_TRUNC = 300;       // tool_use inputs / tool_result bodies in the view payload
const TEXT_CAP = 80000;       // sessionText head+tail cap (chars)
const RUNNING_MS = 30000;     // external-session recency heuristic: mtime within this window counts as running

// ---- Codex CLI transcripts (~/.codex/sessions/**/rollout-*.jsonl) ----
// Codex stores one JSONL per thread under CODEX_HOME/sessions/ (and
// archived_sessions/). The filename embeds the thread uuid (rollout-<ts>-<uuid>.jsonl);
// we use it as the row id. session_meta carries the root session_id + cwd.
const CODEX_FILE_CAP = 5000;
const CODEX_THREAD_RE = /-([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;

function codexThreadId(filename) {
  const base = filename.slice(0, -6); // strip .jsonl
  const m = CODEX_THREAD_RE.exec(base);
  return m ? m[1] : base;
}

// Reduce a peek's events to {cwd, sessionId, title}. session_meta gives cwd +
// session_id; the first user_message gives the title (fallback: Codex <uuid>).
function peekCodexMeta(events) {
  let cwd = null, sessionId = null, title = null;
  for (const e of events) {
    if (e.type === 'session_meta' && e.payload) {
      if (!sessionId) sessionId = e.payload.session_id || e.payload.id || null;
      if (!cwd && e.payload.cwd) cwd = e.payload.cwd;
    }
    if (!title && e.type === 'event_msg' && e.payload?.type === 'user_message' && e.payload.message) {
      title = e.payload.message;
    }
  }
  return { cwd, sessionId, title };
}

// Bounded recursive walk collecting rollout-*.jsonl under base. Stops at
// CODEX_FILE_CAP files (logs once) — guards against an exploded sessions tree.
async function listCodexRollouts(base, acc) {
  if (acc.length >= CODEX_FILE_CAP) return;
  let entries;
  try { entries = await readdir(base, { withFileTypes: true }); } catch { return; }
  for (const ent of entries) {
    if (acc.length >= CODEX_FILE_CAP) return;
    const p = join(base, ent.name);
    if (ent.isDirectory()) await listCodexRollouts(p, acc);
    else if (ent.name.startsWith('rollout-') && ent.name.endsWith('.jsonl')) acc.push(p);
  }
}

const codexMetaCache = new Map(); // path -> { mtimeMs, size, cwd, sessionId, title }
// Callers pass `cap`, but codex rollouts have never been capped — the param was
// accepted and ignored. Dropped from the signature rather than left as dead
// weight; wire it up here if the rollout count ever needs bounding.
async function listCodexSessions({ isLive = () => false, now = Date.now() } = {}) {
  if (!existsSync(CODEX_HOME)) return [];
  const files = [];
  for (const sub of ['sessions', 'archived_sessions']) await listCodexRollouts(join(CODEX_HOME, sub), files);
  if (files.length >= CODEX_FILE_CAP) console.error('[codex] hit file cap, truncating');
  const out = [];
  for (const p of files) {
    const pk = await peek(p);
    if (!pk) continue;
    const { st } = pk;
    const id = codexThreadId(basename(p));
    let cwd, sessionId, title;
    const hit = codexMetaCache.get(p);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
      ({ cwd, sessionId, title } = hit);
    } else {
      ({ cwd, sessionId, title } = peekCodexMeta(parseEvents(pk.head)));
      if (!title) title = `Codex ${id.slice(0, 8)}`;
      codexMetaCache.set(p, { mtimeMs: st.mtimeMs, size: st.size, cwd, sessionId, title });
      if (codexMetaCache.size > 200) codexMetaCache.delete(codexMetaCache.keys().next().value);
    }
    out.push({
      id, project: '<codex>', cwd, title, mtime: st.mtimeMs, size: st.size,
      running: isLive(id) || (now - st.mtimeMs) < RUNNING_MS,
      source: 'codex', sessionId,
      file: relative(CODEX_HOME, p),
    });
  }
  return out;
}

// Resolve a codex rollout relpath (stored in the row) to an absolute path,
// guarded to stay under CODEX_HOME — mirrors pathFor's claude guard.
export function pathForCodex(file) {
  if (!file) return null;
  const base = resolve(CODEX_HOME);
  const abs = resolve(CODEX_HOME, file);
  if (abs !== base && !abs.startsWith(base + sep)) return null;
  return abs;
}

// Locate a codex rollout by thread uuid (filename trailing UUID). Bounded walk
// of CODEX_HOME — used as a fallback when the caller has no stored relpath.
async function findCodexById(id) {
  if (!id || !existsSync(CODEX_HOME)) return null;
  const files = [];
  for (const sub of ['sessions', 'archived_sessions']) await listCodexRollouts(join(CODEX_HOME, sub), files);
  for (const p of files) if (codexThreadId(basename(p)) === id) return p;
  return null;
}

// Parse a codex rollout into the same {ok, meta, messages} shape as readSession.
// session_meta → meta only; event_msg user_message → user text; response_item
// message/reasoning/function_call/custom_tool_call → assistant entries.
// ponytail: codex cost notional, wire stats when needed
async function readCodexSession(p) {
  const events = parseEvents(await readFile(p, 'utf8'));
  const messages = [];
  let cwd = null, sessionId = null, title = null, turns = 0, firstTs = null, lastTs = null, lastModel = null;
  for (const e of events) {
    if (!e || typeof e !== 'object') continue;
    const ts = e.timestamp ?? null;
    if (ts) { if (!firstTs) firstTs = ts; lastTs = ts; }
    const typ = e.type;
    const payload = e.payload || {};
    if (typ === 'session_meta') {
      if (!sessionId) sessionId = payload.session_id || payload.id || null;
      if (!cwd && payload.cwd) cwd = payload.cwd;
      continue;
    }
    if (typ === 'turn_context') { if (payload.model) lastModel = payload.model; continue; }
    if (typ === 'response_item') {
      if (payload.type === 'message') {
        if (payload.role === 'assistant') {
          turns++;
          const text = (payload.content || []).map((c) => c.text || '').join('');
          if (text) messages.push({ ts, role: 'assistant', kind: 'text', text });
        }
      } else if (payload.type === 'reasoning') {
        const text = [...(payload.summary || []), ...(payload.content || [])].map((c) => c.text || '').join('');
        if (text) messages.push({ ts, role: 'assistant', kind: 'thinking', text });
      } else if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
        const name = payload.name || '?';
        const args = payload.arguments || payload.input || '';
        messages.push({ ts, role: 'assistant', kind: 'toolUse', name, text: trunc(args, TOOL_TRUNC) });
      }
      continue;
    }
    if (typ === 'event_msg') {
      if (payload.type === 'user_message') {
        const text = payload.message || payload.text || '';
        if (text) {
          messages.push({ ts, role: 'user', kind: 'text', text });
          if (!title) title = text.slice(0, 120);
        }
      } else if (payload.type === 'mcp_tool_call_end') {
        const name = payload.invocation?.tool || '?';
        messages.push({ ts, role: 'assistant', kind: 'toolUse', name, text: name });
      }
      // token_count and other event_msg types skipped
    }
  }
  return { ok: true, meta: { cwd, title, turns, firstTs, lastTs, model: lastModel, source: 'codex', sessionId }, messages };
}

// Codex search: text items from a rollout, cached by (mtime,size) like the
// claude textCache. Lighter than readCodexSession — text only, no meta.
const codexTextCache = new Map();
async function codexTextItems(p) {
  let st;
  try { st = await stat(p); } catch { return null; }
  const hit = codexTextCache.get(p);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.items;
  let s;
  try { s = await readCodexForSearch(p); } catch { return null; }
  codexTextCache.set(p, { mtimeMs: st.mtimeMs, size: st.size, items: s });
  if (codexTextCache.size > 200) codexTextCache.delete(codexTextCache.keys().next().value);
  return s;
}
async function readCodexForSearch(p) {
  const events = parseEvents(await readFile(p, 'utf8'));
  const items = [];
  let cwd = null;
  for (const e of events) {
    if (!e || typeof e !== 'object') continue;
    if (e.type === 'session_meta' && e.payload && !cwd) cwd = e.payload.cwd || null;
    const payload = e.payload || {};
    if (e.type === 'event_msg' && payload.type === 'user_message') {
      const text = payload.message || payload.text || '';
      if (text) items.push({ idx: items.length, role: 'user', text, cwd });
    } else if (e.type === 'response_item') {
      if (payload.type === 'message' && payload.role === 'assistant') {
        const text = (payload.content || []).map((c) => c.text || '').join('');
        if (text) items.push({ idx: items.length, role: 'assistant', text, cwd });
      } else if (payload.type === 'reasoning') {
        const text = [...(payload.summary || []), ...(payload.content || [])].map((c) => c.text || '').join('');
        if (text) items.push({ idx: items.length, role: 'assistant', text, cwd });
      } else if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
        const name = payload.name || '?';
        items.push({ idx: items.length, role: 'assistant', text: `[tool: ${name}] ${trunc(payload.arguments || payload.input || '', 500)}`, cwd });
      }
    } else if (e.type === 'event_msg' && payload.type === 'mcp_tool_call_end') {
      const name = payload.invocation?.tool || '?';
      items.push({ idx: items.length, role: 'assistant', text: `[tool: ${name}]`, cwd });
    }
  }
  return items;
}

// Sessions root choice, FS-persisted (survives browser cache clear). Defaults
// to ~/.claude/projects.
const ROOT_FILE = join(STATE_DIR, 'sessions-root.json');
export function getSessionsRoot() {
  try { const r = JSON.parse(readFileSync(ROOT_FILE, 'utf8')).root; return typeof r === 'string' && r ? r : '~/.claude/projects'; }
  catch { return '~/.claude/projects'; }
}
export function setSessionsRoot(root) {
  if (typeof root !== 'string' || !root) return { ok: false, error: 'bad root' };
  try { mkdirSync(STATE_DIR, { recursive: true }); writeFileSync(ROOT_FILE, JSON.stringify({ root })); return { ok: true, root }; }
  catch (e) { return { ok: false, error: e.message }; }
}

// Resolve a ~-prefixed client path to an absolute one. Falls back to the
// FS-persisted root (then the default) when raw is empty.
export function resolveRoot(raw) {
  let p = raw || getSessionsRoot();
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) p = normalize(homedir() + p.slice(1));
  try { return resolve(p); } catch { return DEFAULT_ROOT; }
}

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

// First text out of a user event's content — mirrors readSession's own
// string-vs-array handling (tool_result blocks are never text).
function firstUserText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const b = content.find((x) => x.type === 'text');
    return b ? b.text : null;
  }
  return null;
}
// Slash-command echoes (`/exit`, etc.) surface as ordinary user events —
// `<command-name>`/`<local-command...>` wrappers, not isMeta-flagged — so a
// text-prefix check is needed alongside the isMeta/isCompactSummary flags.
function isCommandWrapper(text) {
  const t = text.trimStart();
  return t.startsWith('<command-name') || t.startsWith('<local-command');
}

// Reduce a peek's events to {cwd, title, blurb}. cwd = first event carrying
// one; title = last `ai-title` seen (Claude Code refines it across the
// session); blurb = the first real user prompt, flattened to one line —
// title fallback for sessions that never got an ai-title.
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

// listSessions: every *.jsonl under the resolved root, reverse-chrono by
// mtime. The (mtime,size)-keyed cache holds the peeked meta so repeated list
// calls don't re-read heads of unchanged files.
const metaCache = new Map(); // path -> { mtimeMs, size, cwd, title }
export async function listSessions({ cap = 5000, isLive = () => false, now = Date.now(), root } = {}) {
  const PROJECTS = resolveRoot(root);
  if (!existsSync(PROJECTS)) {
    const codexOnly = await listCodexSessions({ cap, isLive, now });
    codexOnly.sort((a, b) => b.mtime - a.mtime);
    return codexOnly.slice(0, cap);
  }
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
      let cwd, title, blurb;
      const hit = metaCache.get(p);
      if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size && hit.blurb !== undefined) {
        cwd = hit.cwd; title = hit.title; blurb = hit.blurb;
      } else {
        ({ cwd, title, blurb } = peekMeta(parseEvents(pk.head)));
        metaCache.set(p, { mtimeMs: st.mtimeMs, size: st.size, cwd, title, blurb });
      }
      const id = f.slice(0, -6);
      const row = { id, project: proj.name, cwd, title, blurb, mtime: st.mtimeMs, size: st.size };
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
  for (const r of out) r.source = 'claude';
  const codex = await listCodexSessions({ cap, isLive, now });
  const all = out.concat(codex);
  all.sort((a, b) => b.mtime - a.mtime);
  return all.slice(0, cap);
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
    let metaTitle = null;
    try {
      const meta = JSON.parse(await readFile(join(subDir, `${agentId}.meta.json`), 'utf8'));
      if (meta.agentType) metaTitle = meta.description ? `${meta.agentType}: ${meta.description}` : meta.agentType;
    } catch {}
    // blurb always comes from the peek (meta.json never carries one), so peek
    // unconditionally even when meta.json already supplied a title.
    let peekTitle, blurb;
    const hit = metaCache.get(p);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size && hit.blurb !== undefined) {
      peekTitle = hit.title; blurb = hit.blurb;
    } else {
      const peeked = peekMeta(parseEvents(pk.head));
      peekTitle = peeked.title; blurb = peeked.blurb;
      metaCache.set(p, { mtimeMs: st.mtimeMs, size: st.size, cwd: peeked.cwd, title: peeked.title, blurb: peeked.blurb });
    }
    out.push({
      id: `${parentId}/subagents/${agentId}`,
      agentId,
      title: metaTitle || peekTitle,
      blurb,
      mtime: st.mtimeMs,
      size: st.size,
      running: isLive(agentId) || (now - st.mtimeMs) < RUNNING_MS,
    });
  }
  return out;
}

// Live subagents for one agent session: the daemon agent's id IS its Claude
// session id (agents.mjs create()), logged under <encodeCwd(cwd)>/<id>.jsonl,
// so its subagents live in the sibling <id>/subagents/ dir. Reuses listSubagents.
export async function subagentsFor(cwd, id, isLive = () => false, now = Date.now(), root = DEFAULT_ROOT) {
  if (!cwd || !id) return [];
  const PROJECTS = resolveRoot(root);
  return listSubagents(join(PROJECTS, encodeCwd(cwd)), id, isLive, now);
}

// Path guard: project/id come from the client query — reject separators (no
// nested traversal) and confirm the joined path still resolves under the
// active root (mirrors isWikiPath/isMemoryPath in wiki.mjs/memory.mjs). The
// one relaxation: a subagent open-ref shaped "<parent-id>/subagents/agent-x"
// is allowed through as a nested relative path; anything else with a
// separator in id stays banned.
const SUBAGENT_ID = /^[^\\/]+\/subagents\/agent-[^\\/]+$/;
export function pathFor(project, id, root) {
  if (!project || !id || /[\\/]/.test(project)) return null;
  const nested = SUBAGENT_ID.test(id);
  if (!nested && /[\\/]/.test(id)) return null;
  const PROJECTS = resolveRoot(root);
  const p = join(PROJECTS, project, `${id}.jsonl`);
  const rootAbs = resolve(PROJECTS);
  const abs = resolve(p);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + sep)) return null;
  return p;
}

// Fallback resolver: the session id is a globally-unique UUID, so when the
// caller's project slug is stale (worktree relocated by a state migration,
// cleaned-up worktree, session that ran in the repo not the worktree) the file
// still lives under *some* project dir. Scan for <id>.jsonl. Skipped for nested
// subagent ids — their project dir is authoritative. Miss-path only.
async function findById(id, root) {
  const PROJECTS = resolveRoot(root);
  if (/[\\/]/.test(id)) return null;
  if (existsSync(PROJECTS)) {
    for (const proj of await readdir(PROJECTS)) {
      const p = join(PROJECTS, proj, `${id}.jsonl`);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

function trunc(s, n) {
  s = typeof s === 'string' ? s : JSON.stringify(s);
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

// readSession: full parse into a renderable message list + meta. tool_use inputs
// and tool_result bodies are truncated in the payload (the raw file is the
// source of truth); text/thinking are kept whole for the chat context.
export async function readSession(project, id, root, source = 'claude', file) {
  if (source === 'codex') {
    let p = file ? pathForCodex(file) : await findCodexById(id);
    if (!p || !existsSync(p)) return { ok: false, error: 'not found' };
    return readCodexSession(p);
  }
  let p = pathFor(project, id, root);
  if (!p || !existsSync(p)) p = await findById(id, root); // stale project slug → locate by unique id
  if (!p || !existsSync(p)) return { ok: false, error: 'not found' };
  const events = parseEvents(await readFile(p, 'utf8'));
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
      // Recap (context-compaction summary) events are flagged isCompactSummary;
      // tag them so the history digest can compress long sessions to recap +
      // last assistant instead of dropping them. Conditional spread keeps the
      // message shape identical for non-recap events (deepEqual tests rely on it).
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
      // Last model used in the session — assistant events carry it on the
      // message. A /model switch mid-session shows up here as a later event,
      // so the last assistant turn wins (matches "last configuration").
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

// sessionText: flatten a session into a compact transcript for LLM context.
// [user]/[assistant] turns + [tool: name] calls; head+tail cap keeps both the
// opening problem statement and the most recent turns when the log is long.
export async function sessionText(project, id, cap = TEXT_CAP, root, source, file) {
  const s = await readSession(project, id, root, source, file);
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
// {project,id} given, else every *.jsonl under the resolved root. Returns
// line-indexed matches capped at RESULT_CAP. The text per message is cached
// by (mtime,size) like memory.mjs.
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

export async function searchSessions(q, { project, id, root } = {}) {
  const ql = (q || '').toLowerCase();
  if (!ql) return { results: [], capped: false };
  const PROJECTS = resolveRoot(root);
  const targets = [];
  if (project && id) {
    if (project === '<codex>') {
      const p = await findCodexById(id);
      if (p) targets.push({ project, id, path: p, source: 'codex' });
    } else {
      const p = pathFor(project, id, root);
      if (p && existsSync(p)) targets.push({ project, id, path: p, source: 'claude' });
    }
  } else {
    if (existsSync(PROJECTS)) {
      for (const proj of await readdir(PROJECTS, { withFileTypes: true })) {
        if (!proj.isDirectory()) continue;
        const dir = join(PROJECTS, proj.name);
        let files;
        try { files = await readdir(dir); } catch { continue; }
        for (const f of files) if (f.endsWith('.jsonl')) targets.push({ project: proj.name, id: f.slice(0, -6), path: join(dir, f), source: 'claude' });
      }
    }
    if (existsSync(CODEX_HOME)) {
      const codexFiles = [];
      for (const sub of ['sessions', 'archived_sessions']) await listCodexRollouts(join(CODEX_HOME, sub), codexFiles);
      for (const p of codexFiles) targets.push({ project: '<codex>', id: codexThreadId(basename(p)), path: p, source: 'codex' });
    }
  }
  const results = [];
  for (const t of targets) {
    // Match the query against the session id (filename stem) itself — the id
    // lives in event metadata (sessionId field), never in message text, so a
    // pure-id search otherwise returns nothing.
    if (t.id.toLowerCase().includes(ql)) {
      // id lives in event metadata, not message text — synthesize one hit and
      // skip the (always-empty) message-text scan for the same id.
      const items = t.source === 'codex' ? await codexTextItems(t.path) : await sessionTextItems(t.path);
      results.push({ project: t.project, id: t.id, cwd: items?.[0]?.cwd || null, lineIndex: 0, role: 'id', snippet: t.id, source: t.source });
      if (results.length >= RESULT_CAP) return { results, capped: true };
      continue;
    }
    const items = t.source === 'codex' ? await codexTextItems(t.path) : await sessionTextItems(t.path);
    if (!items) continue;
    for (const it of items) {
      const at = it.text.toLowerCase().indexOf(ql);
      if (at < 0) continue;
      results.push({ project: t.project, id: t.id, cwd: it.cwd, lineIndex: it.idx, role: it.role, snippet: snippet(it.text, at, ql), source: t.source });
      if (results.length >= RESULT_CAP) return { results, capped: true };
    }
  }
  return { results, capped: false };
}
