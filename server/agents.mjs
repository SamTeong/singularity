// Agent registry: spawn/kill, in-memory ptys, agents.json persistence, recent-repos.
// Emits 'output'{id,data}, 'status'{id,status}, 'list' — pty-ws fans these out to sockets.
import { spawn } from 'node-pty';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { homedir } from 'node:os';

const RING_MAX = 256 * 1024; // per-agent in-mem scrollback cap (bytes). Disk ring = Phase 3.
const RECENT_MAX = 10;

// --- app-data dir ---
export const APP_DIR = join(process.env.APPDATA || join(homedir(), '.config'), 'singularity');
const STATE_FILE = join(APP_DIR, 'agents.json');
mkdirSync(APP_DIR, { recursive: true });

// --- claude binary (Windows node-pty does NO PATH resolution) ---
function resolveClaude() {
  if (process.env.CLAUDE_BIN && existsSync(process.env.CLAUDE_BIN)) return process.env.CLAUDE_BIN;
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    for (const ext of exts) {
      const p = join(dir, 'claude' + ext);
      if (existsSync(p)) return p;
    }
  }
  return 'claude';
}
const CLAUDE_BIN = resolveClaude();

export const bus = new EventEmitter();

// id -> { id, name, cwd, status, pid, createdAt, proc, buf:string[] }
const agents = new Map();
let recentRepos = [];

// --- persistence ---
function persist() {
  const data = {
    agents: [...agents.values()].map(({ id, name, cwd, status, createdAt }) => ({
      id, name, cwd, createdAt,
      status: status === 'running' || status === 'starting' || status === 'idle' ? 'detached' : status,
    })),
    recentRepos,
  };
  try { writeFileSync(STATE_FILE, JSON.stringify(data, null, 2)); } catch {}
}

export function init(log) {
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
  return [...agents.values()].map(({ id, name, cwd, status, pid, createdAt }) => ({ id, name, cwd, status, pid, createdAt }));
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
function setStatus(a, status) { a.status = status; bus.emit('status', { id: a.id, status }); }
function pushBuf(a, data) {
  a.buf.push(data);
  let total = a.buf.reduce((n, s) => n + s.length, 0);
  while (total > RING_MAX && a.buf.length > 1) total -= a.buf.shift().length;
}

function rememberRepo(cwd) {
  recentRepos = [cwd, ...recentRepos.filter((r) => r !== cwd)].slice(0, RECENT_MAX);
}

function wire(a) {
  a.proc.onData((data) => {
    pushBuf(a, data);
    if (a.status === 'starting') setStatus(a, 'running');
    bus.emit('output', { id: a.id, data });
  });
  a.proc.onExit(({ exitCode }) => {
    setStatus(a, 'exited');
    a.proc = null;
    bus.emit('output', { id: a.id, data: `\r\n\x1b[90m[agent exited code=${exitCode}]\x1b[0m\r\n` });
    persist();
  });
}

// create new agent (id IS the claude --session-id)
export function create({ cwd, name }) {
  const id = randomUUID();
  const proc = spawn(CLAUDE_BIN, ['--session-id', id, '--name', name || id.slice(0, 8)], {
    cwd, cols: 80, rows: 24, env: process.env,
  });
  const a = { id, name: name || id.slice(0, 8), cwd, status: 'starting', pid: proc.pid, createdAt: Date.now(), proc, buf: [] };
  agents.set(id, a);
  wire(a);
  rememberRepo(cwd);
  persist();
  emitList();
  return a;
}

// Claude logs a session to ~/.claude/projects/<encoded-cwd>/<id>.jsonl, where
// encoded-cwd is the abs path with :, \, / all replaced by '-'.
function sessionLogExists(cwd, id) {
  const encoded = cwd.replace(/[:\\/]/g, '-');
  return existsSync(join(homedir(), '.claude', 'projects', encoded, `${id}.jsonl`));
}

// reattach a detached agent: `--resume <id>` if a conversation was persisted,
// else spawn fresh with the same `--session-id` (a session that never had a
// turn has no log to resume — resuming it errors "No conversation found").
export function reattach(id) {
  const a = agents.get(id);
  if (!a || a.proc) return a;
  const canResume = sessionLogExists(a.cwd, id);
  const args = canResume ? ['--resume', id, '--name', a.name] : ['--session-id', id, '--name', a.name];
  const proc = spawn(CLAUDE_BIN, args, {
    cwd: a.cwd, cols: 80, rows: 24, env: process.env,
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

export { CLAUDE_BIN };
