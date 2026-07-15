// Agent registry: spawn/kill, in-memory ptys, agents.json persistence, recent-repos.
// Emits 'output'{id,data}, 'status'{id,status}, 'list' — pty-ws fans these out to sockets.
import { spawn } from 'node-pty';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { homedir } from 'node:os';
import { isClaudeModel } from './models.mjs';

const RING_MAX = 256 * 1024; // per-agent in-mem scrollback cap (bytes). Disk ring = Phase 3.
const IDLE_MS = 2000; // no pty output for this long while running → 'idle' (waiting for input).
const RECENT_MAX = 10;

// --- app-data dir ---
export const APP_DIR = join(process.env.APPDATA || join(homedir(), '.config'), 'singularity');
const STATE_FILE = join(APP_DIR, 'agents.json');
const SCOPE_ROOT = join(homedir(), '.agents', 'skill-scopes');
mkdirSync(APP_DIR, { recursive: true });

// --- claude binary (Windows node-pty does NO PATH resolution) ---
function resolveBin(name, envOverride) {
  if (envOverride && existsSync(envOverride)) return envOverride;
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    for (const ext of exts) {
      const p = join(dir, name + ext);
      if (existsSync(p)) return p;
    }
  }
  return name;
}
const CLAUDE_BIN = resolveBin('claude', process.env.CLAUDE_BIN);
const OLLAMA_BIN = resolveBin('ollama', process.env.OLLAMA_BIN);

export const bus = new EventEmitter();

// id -> { id, name, cwd, status, pid, createdAt, proc, buf:string[] }
const agents = new Map();
let recentRepos = [];

// --- persistence ---
let logger = null;
function persist() {
  const data = {
    agents: [...agents.values()].map(({ id, name, cwd, status, createdAt, model, scopes, permissionMode, extraArgs, activeMs }) => ({
      id, name, cwd, createdAt, model, scopes, permissionMode, extraArgs, activeMs,
      status: status === 'running' || status === 'starting' || status === 'idle' ? 'detached' : status,
    })),
    recentRepos,
  };
  try {
    writeFileSync(STATE_FILE + '.tmp', JSON.stringify(data, null, 2));
    renameSync(STATE_FILE + '.tmp', STATE_FILE); // atomic swap — a crash mid-write never truncates STATE_FILE
  } catch (e) { logger?.warn({ err: e.message }, 'agents.json write failed — registry not persisted'); }
}

export function init(log) {
  logger = log;
  try {
    if (existsSync(STATE_FILE)) {
      const data = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
      recentRepos = data.recentRepos || [];
      for (const a of data.agents || []) {
        // ptys are gone after a daemon restart → mark detached, no proc.
        agents.set(a.id, { ...a, status: 'detached', proc: null, buf: [] });
      }
      log?.info({ agents: agents.size }, 'loaded agents.json (detached)');
    }
  } catch (e) { log?.warn({ err: e.message }, 'agents.json load failed'); }
}

// --- snapshots ---
export function snapshot() {
  return [...agents.values()].map(({ id, name, cwd, status, pid, createdAt, model, scopes }) => ({ id, name, cwd, status, pid, createdAt, model, scopes }));
}
export function getRecentRepos() { return recentRepos; }
export function getBuf(id) { return agents.get(id)?.buf.join('') ?? ''; }
export function getStatus(id) { return agents.get(id)?.status; }
export function isLive(id) { return !!agents.get(id)?.proc; }
// PIDs of agents this daemon currently owns a live pty for (for process classification).
export function livePids() {
  return new Set([...agents.values()].filter((a) => a.proc).map((a) => a.pid));
}

function emitList() { bus.emit('list', snapshot()); }
// Single transition point for agent status. Tracks activeMs (persisted, wall
// time spent 'running') across the running <-> idle/exited/detached edges.
function setStatus(a, status) {
  if (status === 'running' && a.status !== 'running') a.runningSince = Date.now();
  else if (a.status === 'running' && status !== 'running') { a.activeMs = (a.activeMs || 0) + (Date.now() - a.runningSince); a.runningSince = null; }
  a.status = status;
  bus.emit('status', { id: a.id, status });
}
// Persisted activeMs plus the live delta while currently running.
export function getActiveMs(id) {
  const a = agents.get(id);
  if (!a) return 0;
  const base = a.activeMs || 0;
  return a.status === 'running' && a.runningSince ? base + (Date.now() - a.runningSince) : base;
}
function pushBuf(a, data) {
  a.buf.push(data);
  let total = a.buf.reduce((n, s) => n + s.length, 0);
  while (total > RING_MAX && a.buf.length > 1) total -= a.buf.shift().length;
}

function rememberRepo(cwd) {
  recentRepos = [cwd, ...recentRepos.filter((r) => r !== cwd)].slice(0, RECENT_MAX);
}

function wire(a) {
  // Idle heuristic: Claude Code's TUI spinner emits output continuously while
  // working; a turn waiting for user input goes quiet. No pty output for
  // IDLE_MS while 'running' → mark 'idle'; the next byte flips it back.
  const armIdle = () => {
    clearTimeout(a.idleTimer);
    a.idleTimer = setTimeout(() => { if (a.status === 'running') setStatus(a, 'idle'); }, IDLE_MS);
  };
  a.proc.onData((data) => {
    pushBuf(a, data);
    if (a.status === 'starting' || a.status === 'idle') setStatus(a, 'running');
    bus.emit('output', { id: a.id, data });
    armIdle();
  });
  a.proc.onExit(({ exitCode }) => {
    clearTimeout(a.idleTimer);
    setStatus(a, 'exited');
    a.proc = null;
    const resumeCmd = isClaudeModel(a.model)
      ? `claude --resume ${a.id}${a.model && a.model !== 'claude' ? ` --model ${a.model}` : ''}`
      : `ollama launch claude --model ${a.model} -- --resume ${a.id}`;
    bus.emit('output', { id: a.id, data: `\r\n\x1b[90m[agent exited code=${exitCode}] resume: ${resumeCmd}\x1b[0m\r\n` });
    persist();
  });
}

// Build (bin, args) for an agent's pty: skill-scopes → --add-dir <abs> (only
// existing dirs under the scope root), resume if a session log already exists
// for this id at this cwd (else fresh --session-id), optional ollama wrapper.
// Shared by create + reattach so reattach keeps the model + scopes.
// `prompt` (initial user message) is only sent on a fresh spawn — passing it
// with --resume would re-submit it as a new message on every reattach.
export function buildSpawn({ id, name, cwd, model, scopes, permissionMode, extraArgs }, prompt) {
  const claudeArgs = [];
  for (const s of (scopes || [])) {
    if (!s) continue;
    const dir = join(SCOPE_ROOT, s);
    if (existsSync(dir)) { claudeArgs.push('--add-dir', dir); }
  }
  const resuming = sessionLogExists(cwd, id);
  const sessionFlag = resuming ? ['--resume', id] : ['--session-id', id];
  claudeArgs.push(...sessionFlag, '--name', name);
  if (permissionMode) claudeArgs.push('--permission-mode', permissionMode);
  claudeArgs.push(...(extraArgs || []));
  if (prompt && !resuming) claudeArgs.push(prompt);
  if (isClaudeModel(model)) {
    // claude bin; --model only for a specific (non-default) alias or full id.
    if (model && model !== 'claude') claudeArgs.push('--model', model);
    return { bin: CLAUDE_BIN, args: claudeArgs };
  }
  if (OLLAMA_BIN === 'ollama') {
    throw new Error('ollama not found on PATH');
  }
  // On resume the transcript recorded the ollama model with its tag stripped
  // (glm-5.2:cloud -> glm-5.2); claude would request the stripped name and
  // ollama rejects it. --model overrides the transcript model on resume.
  if (resuming) claudeArgs.push('--model', model);
  return { bin: OLLAMA_BIN, args: ['launch', 'claude', '--model', model, '--', ...claudeArgs] };
}

// create new agent (id IS the claude --session-id)
export function create({ cwd, name, model, scopes, sessionId, prompt, permissionMode, extraArgs }) {
  const id = (sessionId && sessionId.trim()) || randomUUID();
  if (agents.has(id)) throw new Error('session id already in use');
  const displayName = name || id.slice(0, 8);
  const { bin, args } = buildSpawn({ id, name: displayName, cwd, model, scopes, permissionMode, extraArgs }, prompt);
  const proc = spawn(bin, args, { cwd, cols: 80, rows: 24, env: process.env, useConptyDll: true });
  const a = { id, name: displayName, cwd, model, scopes, permissionMode, extraArgs, activeMs: 0, status: 'starting', pid: proc.pid, createdAt: Date.now(), proc, buf: [] };
  agents.set(id, a);
  wire(a);
  rememberRepo(cwd);
  persist();
  emitList();
  return a;
}

// Claude logs a session to ~/.claude/projects/<encoded-cwd>/<id>.jsonl, where
// encoded-cwd is the abs path with every non-alphanumeric replaced by '-'
// (dots too: C:\Users\x\.claude -> C--Users-x--claude).
export function encodeCwd(cwd) { return cwd.replace(/[^a-zA-Z0-9]/g, '-'); }
function sessionLogExists(cwd, id) {
  return existsSync(join(homedir(), '.claude', 'projects', encodeCwd(cwd), `${id}.jsonl`));
}

// reattach a detached agent: `--resume <id>` if a conversation was persisted,
// else spawn fresh with the same `--session-id` (a session that never had a
// turn has no log to resume — resuming it errors "No conversation found").
// buildSpawn keeps the agent's model + skill-scopes from create time.
export function reattach(id) {
  const a = agents.get(id);
  if (!a || a.proc) return a;
  const { bin, args } = buildSpawn(a);
  const proc = spawn(bin, args, {
    cwd: a.cwd, cols: 80, rows: 24, env: process.env, useConptyDll: true,
  });
  a.proc = proc; a.pid = proc.pid; a.buf = []; a.status = 'starting';
  wire(a);
  persist();
  emitList();
  return a;
}

export function input(id, data) { agents.get(id)?.proc?.write(data); }
export function resize(id, cols, rows) { try { agents.get(id)?.proc?.resize(cols, rows); } catch {} }

// kill live agent; remove dead/detached agent from registry.
export function kill(id) {
  const a = agents.get(id);
  if (!a) return;
  if (a.proc) { a.proc.kill(); return; } // onExit -> status exited + persist
  agents.delete(id);
  persist();
  emitList();
}

// Reorder the registry to match `ids` (a permutation of every current id);
// rebuilds the Map in that insertion order, persists, and re-emits the list.
export function reorder(ids) {
  if (!Array.isArray(ids) || ids.length !== agents.size) return;
  const next = new Map();
  for (const id of ids) { const a = agents.get(id); if (!a) return; next.set(id, a); }
  if (next.size !== agents.size) return;
  agents.clear();
  for (const [id, a] of next) agents.set(id, a);
  persist();
  emitList();
}

export { CLAUDE_BIN };
