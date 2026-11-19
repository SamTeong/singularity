// Session service adapter. Transcript parsing, discovery, and file access live
// in the Rust backend; Node retains route-facing helpers and local path guards.
import { readFileSync } from 'node:fs';
import { join, resolve, sep, normalize } from 'node:path';
import { homedir } from 'node:os';
import { CACHE_DIR, STATE_DIR } from './app-dir.mjs';
import { CODEX_HOME } from './usage.mjs';
import { getModels } from './model-store.mjs';

const DEFAULT_ROOT = join(homedir(), '.claude', 'projects');
const ROOT_FILE = join(STATE_DIR, 'sessions-root.json');
const TEXT_CAP = 80000;
let transcriptBackend;

export function setTranscriptBackend(backend) {
  transcriptBackend = backend;
}

async function inputs() {
  return {
    state_dir: STATE_DIR,
    cache_dir: CACHE_DIR,
    claude_home: homedir(),
    codex_home: CODEX_HOME,
    model_catalog: (await getModels()).models,
  };
}

function backend() {
  if (!transcriptBackend) throw new Error('Rust transcript backend is not configured');
  return transcriptBackend;
}

function unwrap(payload) {
  if (payload?.error) {
    const error = new Error(payload.error);
    error.code = payload.code;
    throw error;
  }
  return payload;
}

function savedRoot() {
  try {
    const root = JSON.parse(readFileSync(ROOT_FILE, 'utf8')).root;
    return typeof root === 'string' && root ? root : '~/.claude/projects';
  } catch { return '~/.claude/projects'; }
}

export async function getSessionsRoot() {
  return unwrap(await backend().transcriptRootGet(await inputs()));
}

export async function setSessionsRoot(root) {
  if (typeof root !== 'string' || !root) return { ok: false, error: 'bad root' };
  try { return unwrap(await backend().transcriptRootSet(await inputs(), root)); }
  catch (error) { return { ok: false, error: error.message }; }
}

// Synchronous compatibility for stats/history consumers. Rust owns root
// persistence; this reads only the tiny saved preference, never transcripts.
export function resolveRoot(raw) {
  let path = raw || savedRoot();
  if (path === '~' || path.startsWith('~/') || path.startsWith('~\\')) path = normalize(homedir() + path.slice(1));
  try { return resolve(path); } catch { return DEFAULT_ROOT; }
}

export function pathFor(project, id, root) {
  if (!project || !id || /[\\/]/.test(project)) return null;
  const nested = /^[^\\/]+\/subagents\/agent-[^\\/]+$/.test(id);
  if (!nested && /[\\/]/.test(id)) return null;
  const projects = resolveRoot(root);
  const path = join(projects, project, `${id}.jsonl`);
  const rootAbs = resolve(projects);
  const abs = resolve(path);
  return abs !== rootAbs && !abs.startsWith(rootAbs + sep) ? null : path;
}

export function pathForCodex(file) {
  if (!file) return null;
  const base = resolve(CODEX_HOME);
  const abs = resolve(CODEX_HOME, file);
  return abs !== base && !abs.startsWith(base + sep) ? null : abs;
}

// Main derives all four liveness fields from the injected `isLive`
// (`66591a9:server/sessions.mjs:199-205,501-506,557-568`): `running` is the owned
// live process only and recency stays in `activityRecent`. The Rust sidecar has
// no agent registry — `transcript_bridge.rs:119,184` passes an empty live-id
// list, so its `processLive`/`processState` are always the idle values — so the
// adapter overlays the same contract here. Context shapes match main: root rows
// `{source, cwd}`, Claude subagent rows `{source: 'claude-subagent'}`.
// VERIFY: wave4-f3-1
function updateRunning(row, isLive) {
  const id = row.agentId ?? row.id;
  const source = row.source ?? (row.agentId == null ? 'claude' : 'claude-subagent');
  const live = isLive(id, { source, cwd: row.cwd ?? undefined });
  row.processLive = live;
  row.processState = live ? 'live' : 'unknown';
  row.running = live;
  for (const child of row.subagents ?? []) updateRunning(child, isLive);
  return row;
}

export async function listSessions({ cap = 5000, isLive = () => false, now = Date.now(), root, hideReviews = false } = {}) {
  const payload = unwrap(await backend().transcriptsList(await inputs(), {
    ...(root === undefined ? {} : { transcript_root: root }),
    cap,
    now_ms: now,
    hide_reviews: hideReviews,
  }));
  return payload.map((row) => updateRunning(row, isLive));
}

export async function subagentsFor(cwd, id, isLive = () => false, now = Date.now(), root = DEFAULT_ROOT) {
  if (!cwd || !id) return [];
  const payload = unwrap(await backend().transcriptSubagents(await inputs(), {
    transcript_cwd: cwd,
    transcript_id: id,
    transcript_root: root,
    now_ms: now,
  }));
  return payload.map((row) => updateRunning(row, isLive));
}

export async function readSession(project, id, root, source = 'claude', file) {
  const result = await backend().transcriptRead(await inputs(), {
    transcript_project: project ?? (source === 'codex' ? '<codex>' : project),
    transcript_id: id,
    ...(root === undefined ? {} : { transcript_root: root }),
    transcript_source: source,
    ...(file === undefined ? {} : { transcript_file: file }),
  });
  if (result?.code === 'not_found') return { ok: false, error: 'not found' };
  return unwrap(result);
}

export async function sessionText(project, id, cap = TEXT_CAP, root, source, file) {
  const session = await readSession(project, id, root, source, file);
  if (!session.ok) return '';
  const lines = [];
  for (const message of session.messages) {
    if (message.kind === 'toolResult') lines.push(`[tool_result] ${message.text}`);
    else if (message.kind === 'toolUse') lines.push(`[tool: ${message.name}] ${message.text}`);
    else lines.push(`[${message.role}] ${message.text}`);
  }
  const text = lines.join('\n');
  if (text.length <= cap) return text;
  const half = Math.floor(cap / 2);
  return `${text.slice(0, half)}\n\n[…truncated…]\n\n${text.slice(-half)}`;
}

export async function searchSessions(q, { project, id, root, hideReviews = false } = {}) {
  if (!q) return { results: [], capped: false };
  const queryUnits = [];
  for (let i = 0; i < q.length; i++) queryUnits.push(q.charCodeAt(i));
  const payload = unwrap(await backend().transcriptsSearch(await inputs(), {
    transcript_q_units: queryUnits,
    ...(project === undefined ? {} : { transcript_project: project }),
    ...(id === undefined ? {} : { transcript_id: id }),
    ...(root === undefined ? {} : { transcript_root: root }),
    hide_reviews: hideReviews,
  }));
  return payload;
}
