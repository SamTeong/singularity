// WebSocket wiring — fans agents.bus events to sockets, routes client messages to the registry.
import * as reg from './agents.mjs';

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
}

export function attachPtyWs(wss, log, token = null) {
  const sockets = new Set();

  // registry -> sockets
  reg.bus.on('output', ({ id, data }) => {
    const msg = JSON.stringify({ t: 'output', id, data });
    for (const ws of sockets) if (ws.attached.has(id)) send(ws, msg);
  });
  reg.bus.on('status', ({ id, status }) => {
    const msg = JSON.stringify({ t: 'status', id, status });
    for (const ws of sockets) send(ws, msg);
  });
  reg.bus.on('list', () => {
    const msg = JSON.stringify({ t: 'list', agents: reg.snapshot(), recentRepos: reg.getRecentRepos() });
    for (const ws of sockets) send(ws, msg);
  });

  wss.on('connection', (ws, req) => {
    if (token) {
      const t = new URL(req.url, 'http://localhost').searchParams.get('token');
      if (t !== token) { ws.close(1008, 'unauthorized'); return; }
    }
    ws.attached = new Set();
    sockets.add(ws);
    send(ws, { t: 'list', agents: reg.snapshot(), recentRepos: reg.getRecentRepos() });

    ws.on('message', (raw) => {
      let m;
      try { m = JSON.parse(raw.toString()); } catch { return; }
      switch (m.t) {
        case 'create': {
          try {
            const na = reg.create({ cwd: m.cwd, name: m.name });
            ws.attached.add(na.id);
            send(ws, { t: 'attached', id: na.id });
          } catch (e) {
            log?.error({ err: e.message }, 'spawn failed');
            send(ws, { t: 'error', msg: `spawn failed: ${e.message}` });
          }
          break;
        }
        case 'reattach': {
          try {
            const a = reg.reattach(m.id);
            if (a) { ws.attached.add(a.id); send(ws, { t: 'attached', id: a.id }); }
          } catch (e) {
            send(ws, { t: 'error', msg: `reattach failed: ${e.message}` });
          }
          break;
        }
        case 'attach': {
          if (!reg.getStatus(m.id)) return;
          ws.attached.add(m.id);
          send(ws, { t: 'output', id: m.id, data: reg.getBuf(m.id) }); // replay scrollback
          send(ws, { t: 'status', id: m.id, status: reg.getStatus(m.id) });
          break;
        }
        case 'input': reg.input(m.id, m.data); break;
        case 'resize': reg.resize(m.id, m.cols, m.rows); break;
        case 'kill': reg.kill(m.id); break;
      }
    });

    ws.on('close', () => sockets.delete(ws));
  });
  log?.info('pty-ws attached at /ws');
}
