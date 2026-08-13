// mock-socket server — the in-browser stand-in for the daemon's /ws protocol.
// Bound to the exact URL AgentsProvider.jsx computes (`ws://${location.host}/ws`)
// so the client's own `new WebSocket(...)` is transparently intercepted.
//
// Frame shapes mirror server/pty-ws.mjs exactly — the client parses them
// field-by-field (AgentsProvider.jsx onmessage), so a missing field silently
// degrades a surface. On connect we emit the daemon's opening burst in its
// order (list, tasks, crons, background); then we answer the client frames that
// drive the dock, terminals, and chat (tasks.md section 4).
//
// Mutating REST handlers in routes/*.js call the exported broadcast() to push
// the matching frame, the same way the daemon's bus fans reg events to sockets
// (design.md D7). State lives in db.js, shared with the Mirage handlers.
import { Server } from 'mock-socket';
import { db } from './db.js';

const RING_MAX = 256 * 1024; // mirrors server/agents.mjs RING_MAX
const OPEN = 1; // WebSocket.OPEN — mock-socket sockets report the same constants
const sockets = new Set();

// Fake-pid source for every agent the mock creates. pid 1 is reserved for the
// mock's own "daemon" row (routes/telemetry.js /procs adds it), so agent pids
// start at 2000. The pid is fake but must be unique and stable per agent
// because routes/telemetry.js's /procs lists it and /procs/kill resolves a
// kill back to the agent by matching a.pid.
let nextPid = 2000;

// The `list` frame's agents array — the 9 fields reg.snapshot() exposes
// (server/agents.mjs:128). db.agents holds the full objects (with buf/written);
// this projection is what the client renders.
function snapshotAgents() {
  return db.agents.map(({ id, title, cwd, status, pid, createdAt, model, scopes, tool }) => ({
    id, title, cwd, status, pid, createdAt, model, scopes, tool,
  }));
}

function send(ws, msg) {
  if (ws.readyState === OPEN) ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
}

// Broadcast a frame to every connected socket — the daemon's bus fan-out
// (pty-ws.mjs:38-69). Mirage route handlers call this after mutating db.
export function broadcast(frame) {
  for (const ws of sockets) send(ws, frame);
}

function broadcastList() {
  broadcast({ t: 'list', agents: snapshotAgents(), recentRepos: db.recentRepos || [] });
}

// Append pty bytes to an agent's ring buffer and push them to sockets attached
// to that agent (output only reaches attached sockets — pty-ws.mjs:40). Mirrors
// agents.mjs pushBuf: written is cumulative (never trimmed), buf is capped.
function emitOutput(id, data) {
  const a = db.agents.find((x) => x.id === id);
  if (a) {
    a.buf.push(data);
    a.written = (a.written || 0) + data.length;
    let total = a.buf.reduce((n, s) => n + s.length, 0);
    while (total > RING_MAX && a.buf.length > 1) total -= a.buf.shift().length;
  }
  for (const ws of sockets) if (ws.attached?.has(id)) send(ws, { t: 'output', id, data });
}

function setStatus(id, status) {
  const a = db.agents.find((x) => x.id === id);
  if (a) a.status = status;
  broadcast({ t: 'status', id, status });
}

// A fresh agent object for the mock registry. pid is fake (no real pty) but
// unique and stable — see the nextPid counter above; routes/telemetry.js's
// /procs lists it and /procs/kill resolves a kill by matching it.
function makeAgent({ id, title, cwd, model, scopes, tool }) {
  return {
    id, title: title || id.slice(0, 8), cwd,
    model: model || 'claude', scopes: scopes || [], tool: tool || 'claude',
    status: 'starting', pid: nextPid++, createdAt: Date.now(), buf: [], written: 0,
  };
}

// Simulate a pty boot: a welcome banner into the ring, then the running status.
// The banner lands in buf so a later attach replays it; the live broadcast is
// dropped by the client until the terminal mounts (which is fine — attach
// replays buf).
function bootAgent(ws, agent, note) {
  ws.attached.add(agent.id);
  send(ws, { t: 'attached', id: agent.id });
  db.recentRepos = [agent.cwd, ...(db.recentRepos || []).filter((r) => r !== agent.cwd)].slice(0, 10);
  broadcastList();
  emitOutput(agent.id, `\r\n\x1b[32m${agent.title}\x1b[0m — ${note} in ${agent.cwd}\r\n`);
  setStatus(agent.id, 'running');
}

function handleMessage(ws, raw) {
  let m;
  try { m = JSON.parse(raw); } catch { return; }
  switch (m.t) {
    case 'create': {
      const id = (m.sessionId && m.sessionId.trim()) || crypto.randomUUID();
      if (db.agents.some((a) => a.id === id)) {
        send(ws, { t: 'error', msg: 'session id already in use' });
        break;
      }
      const agent = makeAgent({ id, title: m.title, cwd: m.cwd || '/home/mock', model: m.model, scopes: m.scopes, tool: m.tool });
      db.agents.push(agent);
      bootAgent(ws, agent, 'mock session started');
      break;
    }
    case 'fork': {
      const src = db.agents.find((a) => a.id === m.id);
      if (!src) { send(ws, { t: 'error', msg: 'source not found' }); break; }
      const agent = makeAgent({ id: crypto.randomUUID(), title: m.title || src.title, cwd: src.cwd, model: src.model, scopes: src.scopes, tool: src.tool });
      db.agents.push(agent);
      bootAgent(ws, agent, `forked from ${src.title}`);
      break;
    }
    case 'reattach': {
      const a = db.agents.find((x) => x.id === m.id);
      if (!a) break;
      ws.attached.add(a.id);
      send(ws, { t: 'attached', id: a.id });
      a.status = 'starting';
      broadcastList();
      emitOutput(a.id, '\r\n\x1b[90m[reattached]\x1b[0m\r\n');
      setStatus(a.id, 'running');
      break;
    }
    case 'attach': {
      const a = db.agents.find((x) => x.id === m.id);
      if (!a) return;
      ws.attached.add(m.id);
      send(ws, { t: 'output', id: m.id, data: a.buf.join('') }); // replay scrollback
      send(ws, { t: 'status', id: m.id, status: a.status });
      break;
    }
    case 'input': {
      // The pty echoes keystrokes back as output — the mock does the same.
      if (db.agents.some((x) => x.id === m.id)) emitOutput(m.id, m.data);
      break;
    }
    case 'txmeta': {
      const a = db.agents.find((x) => x.id === m.id);
      send(ws, { t: 'txmeta', id: m.id, written: a?.written ?? 0, ringMax: RING_MAX });
      break;
    }
    case 'resize': break; // no real pty to resize — accept and ignore
    case 'kill': {
      const i = db.agents.findIndex((x) => x.id === m.id);
      if (i < 0) break;
      const a = db.agents[i];
      if (a.status === 'exited' || a.status === 'detached') {
        db.agents.splice(i, 1); // dead row → drop outright (agents.mjs kill)
        broadcastList();
      } else {
        setStatus(a.id, 'exited');
        emitOutput(a.id, `\r\n\x1b[90m[agent exited] resume: claude --resume ${a.id}\x1b[0m\r\n`);
        db.agents.splice(i, 1); // live kill → exited then removed (onExit path)
        broadcastList();
      }
      break;
    }
    case 'respawn': {
      const a = db.agents.find((x) => x.id === m.id);
      if (!a) return;
      a.status = 'starting';
      broadcastList();
      emitOutput(a.id, '\r\n\x1b[90m[respawned]\x1b[0m\r\n');
      setStatus(a.id, 'running');
      break;
    }
    case 'respawnAll': {
      for (const a of db.agents) a.status = 'starting';
      broadcastList();
      for (const a of db.agents) setStatus(a.id, 'running');
      break;
    }
    case 'reorder': {
      if (!Array.isArray(m.ids) || m.ids.length !== db.agents.length) return;
      const next = [];
      for (const id of m.ids) { const a = db.agents.find((x) => x.id === id); if (!a) return; next.push(a); }
      if (next.length !== db.agents.length) return;
      db.agents = next;
      broadcastList();
      break;
    }
    case 'chat': {
      // One in-flight chat per socket: a new request cancels the prior
      // (pty-ws.mjs:148-155).
      if (ws.chatAbort) ws.chatAbort.abort();
      ws.chatAbort = new AbortController();
      streamChat(ws, m, ws.chatAbort.signal);
      break;
    }
    case 'chat:stop': ws.chatAbort?.abort(); break;
  }
}

// Stream a canned answer: a few chat:delta frames then chat:done, abortable via
// signal (chat:stop or a superseding chat). Mirrors server/chat.mjs's contract
// — the client ignores any frame whose chatId isn't its current one.
function streamChat(ws, m, signal) {
  const { chatId } = m;
  const answer = `Mock answer to: ${m.question || '(no question)'}\n\nThis is a canned reply from the in-browser mock. The real daemon streams a Claude Messages API response here.`;
  const chunks = [answer.slice(0, 24), answer.slice(24, 72), answer.slice(72)];
  let i = 0;
  const timer = setInterval(() => {
    if (signal.aborted) { clearInterval(timer); return; }
    if (i < chunks.length) {
      send(ws, { t: 'chat:delta', chatId, text: chunks[i] });
      i += 1;
    } else {
      clearInterval(timer);
      send(ws, { t: 'chat:done', chatId });
    }
  }, 120);
}

export function startWs() {
  // No __SING_TOKEN__ is ever set in mock mode (see index.js), so this always
  // matches the client's URL exactly — mock-socket matches on exact URL.
  const url = `ws://${location.host}/ws`;
  const server = new Server(url);
  server.on('connection', (socket) => {
    socket.attached = new Set();
    sockets.add(socket);
    // On-connect burst, in the daemon's order (pty-ws.mjs:94-97).
    send(socket, { t: 'list', agents: snapshotAgents(), recentRepos: db.recentRepos || [] });
    send(socket, { t: 'tasks', tasks: db.tasks, history: db.taskHistory });
    send(socket, { t: 'crons', crons: db.crons });
    // nextDueAt mirrors the daemon's `lastDueAt + TICK_MINUTES*60_000` — a fresh
    // daemon's lastDueAt is its boot time, so the first check is ~1h out.
    send(socket, { t: 'background', config: { jobs: db.background }, lastTick: null, liveTaskId: null, nextDueAt: Date.now() + 60 * 60 * 1000 });
    // mock-socket passes the message data as the listener's first argument
    // (its dispatchEvent forwards custom args, not the event object).
    socket.on('message', (data) => handleMessage(socket, data));
    socket.on('close', () => { socket.chatAbort?.abort(); sockets.delete(socket); });
  });
  return server;
}
