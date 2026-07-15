import { WebSocket } from 'ws';
const ws = new WebSocket('ws://127.0.0.1:4399/ws');
const t0 = Date.now();
const ts = () => `+${Math.round((Date.now()-t0)/1000)}s`;
let cronSession = null;
const seen = new Set();
ws.on('open', () => console.log(ts(), 'ws open'));
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.t === 'crons') {
    const j = m.crons.find(x => x.name === 'check1');
    if (j && j.lastSessionId && !cronSession) {
      cronSession = j.lastSessionId;
      console.log(ts(), `FIRED sid=${cronSession.slice(0,8)} at=${new Date(j.lastFiredAt).toISOString()}`);
    }
  } else if (m.t === 'status' && m.id === cronSession) {
    console.log(ts(), `status=${m.status}`);
  } else if (m.t === 'list') {
    const a = m.agents.find((x) => x.id === cronSession);
    if (a && !seen.has(a.status)) { seen.add(a.status); console.log(ts(), `list status=${a.status} name=${a.name}`); }
    if (cronSession && seen.size > 0 && !m.agents.some((x) => x.id === cronSession) && !seen.has('gone')) { seen.add('gone'); console.log(ts(), `agent GONE (auto-killed)`); }
  }
});
ws.on('error', (e) => console.log(ts(), 'ws err', e.message));
setTimeout(() => { console.log(ts(), 'done'); ws.close(); process.exit(0); }, 100000);
