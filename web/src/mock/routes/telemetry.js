// Telemetry routes: usage limits, provider status, machine stats, the daily
// history archive, the process manager, and the usage report. These mirror
// server/index.mjs exactly (design.md D8): /usage, /status, /sysstats return
// bare keyed objects with no `ok`; /procs/kill failures are HTTP 200 with
// ok:false (killClaudePid never sets a 4xx for a failed kill); /history
// returns { ok:true, entries, pending, today }.
import { Response } from 'miragejs';
import { db } from '../db.js';
import { broadcast } from '../ws.js';
import { parseBody } from '../helpers.js';
import { sessionId, RICH_SESSION, PROJECT_A, PROJECT_B } from '../fixtures.js';

// Machine-local YYYY-MM-DD — same convention as server/history.mjs localDay.
const localDay = (ts) => (ts ? new Date(ts) : new Date()).toLocaleDateString('en-CA');
const iso = (ms) => new Date(ms).toISOString();

// The `list` WS frame's agents projection (ws.js snapshotAgents) — rebuilt
// here because ws.js doesn't export it and /procs/kill must broadcast after a
// kill so the dock drops the row.
function listFrame() {
  const agents = db.agents.map(({ id, title, cwd, status, pid, createdAt, model, scopes, tool }) => ({
    id, title, cwd, status, pid, createdAt, model, scopes, tool,
  }));
  return { t: 'list', agents, recentRepos: db.recentRepos || [] };
}

// The pid on each agent row is the single source of truth — ws.js makeAgent
// stamps a unique fake pid (>= 2000) on every agent, and /procs + /procs/kill
// both read a.pid directly. pid 1 is the mock's own 'daemon' row (added in
// /procs below), not an agent.

// ---- /history seed ---------------------------------------------------------
// Seven days (yesterday back), one per day in the default 7-day window, so
// `pending` is always empty and the page never shimmers. Mirrors the e2e
// sandbox corpus (e2e/fixtures/seed.mjs seedHistory) so a ported spec keeps
// its assertions verbatim; sessions reference real fixture ids so the
// deep-link into Transcripts resolves.
function seedHistoryEntries() {
  const dayStr = (offset) => { const d = new Date(); d.setDate(d.getDate() - offset); return d.toLocaleDateString('en-CA'); };
  const sess = (id, project, cwd, title, turns, blurb) => ({ id, project, cwd, source: 'claude', title, turns, dayTurns: turns, blurb });
  const ok = { ok: true, provider: 'anthropic-oauth', model: 'claude-haiku-4-5-20251001', inputTokens: 5000, outputTokens: 80 };
  const empty = { ok: false, provider: null, model: null, reason: 'empty' };
  const m = (sessions, turns, tokens, cost) => ({
    sessions, turns, tokens, costUsd: cost,
    byHarness: sessions > 0 ? { claude: { sessions, turns } } : {},
  });
  const e = (date, projects, topics, repos, sessions, metrics, llm) => ({
    date, projects, topics, repos, sessions, metrics, llm, builtAt: new Date().toISOString(),
  });
  const p = (path, ...bullets) => [{ path, bullets }];
  return [
    e(dayStr(7), p('/fixture/alpha', 'Refactored the config editor backup path'), ['config', 'backups'], ['alpha'],
      [sess(sessionId(4), PROJECT_A, '/fixture/alpha', 'Fixture session 4', 3, 'Fixture request 4: summarize the module.')], m(1, 3, 8000, 0.15), ok),
    e(dayStr(6), p('/fixture/alpha', 'Hardened the explorer fixture against path traversal'), ['explorer', 'security'], ['alpha'],
      [sess(sessionId(3), PROJECT_A, '/fixture/alpha', 'Fixture session 3', 4, 'Fixture request 3: summarize the module.')], m(1, 4, 10000, 0.22), ok),
    e(dayStr(5), p('/fixture/alpha', 'Added pagination to the skills viewer'), ['skills', 'pagination'], ['alpha'],
      [sess(sessionId(2), PROJECT_A, '/fixture/alpha', 'Fixture session 2', 5, 'Fixture request 2: summarize the module.')], m(1, 5, 12000, 0.31), ok),
    e(dayStr(4), p('/fixture/alpha', 'Wired the wiki category filter to folder segments'), ['wiki', 'categories'], ['alpha'],
      [sess(sessionId(1), PROJECT_A, '/fixture/alpha', 'Fixture session 1', 6, 'Fixture request 1: summarize the module.')], m(1, 6, 14000, 0.38), ok),
    e(dayStr(3), p('/fixture/alpha', 'Built the e2e sandbox seed corpus for the history spec'), ['e2e', 'fixtures'], ['alpha'],
      [sess(sessionId(0), PROJECT_A, '/fixture/alpha', 'Fixture session 0', 3, 'Fixture request 0: summarize the module.')], m(1, 3, 12000, 0.42), ok),
    e(dayStr(2), [], [], [], [], m(0, 0, 0, 0), empty),
    e(dayStr(1), p('/fixture/beta', 'Shipped the history timeline', 'Fixed a concurrent backfill bug'), ['history', 'backfill'], ['beta'],
      [sess(RICH_SESSION, PROJECT_B, '/fixture/beta', 'Retry backoff cap', 5, 'Trace the retry path and tell me where the backoff is capped.'),
       sess(sessionId(901), PROJECT_B, '/fixture/beta', 'Fixture session 901', 2, 'Fixture request 901: summarize the module.')],
      m(2, 7, 45000, 1.23), ok),
  ];
}

// Today is always computed live (never persisted) — server/history.mjs liveToday.
function liveToday() {
  return {
    date: localDay(), live: true,
    repos: ['beta'],
    sessions: [
      { id: RICH_SESSION, project: PROJECT_B, cwd: '/fixture/beta', source: 'claude', title: 'Retry backoff cap', turns: 2, dayTurns: 2, blurb: 'Trace the retry path and tell me where the backoff is capped.' },
    ],
    metrics: { sessions: 1, turns: 2, tokens: 6000, costUsd: 0.08, byHarness: { claude: { sessions: 1, turns: 2 } } },
  };
}

export function registerTelemetry(server) {
  // /usage — { ollama, claude, codex }, each a provider payload (usage.mjs
  // getUsage). The mock can't scrape real accounts, so every provider reports
  // ok:true with plausible windows; the cards render their populated state.
  server.get('/usage', () => {
    const now = Date.now();
    return {
      claude: {
        ok: true, source: 'claude', plan: 'pro',
        session: { pctUsed: 42, resetsAt: iso(now + 3.6e6), models: [] },
        weekly: { pctUsed: 61, resetsAt: iso(now + 4 * 86_400_000), models: [{ model: 'sonnet', pctUsed: 55 }, { model: 'opus', pctUsed: 70 }] },
        extra: { enabled: true, used: 1200, monthlyLimit: 5000, pctUsed: 24, resetsAt: iso(now + 20 * 86_400_000) },
        fetchedAt: iso(now),
      },
      ollama: {
        ok: true, source: 'ollama', plan: 'pro',
        session: { pctUsed: 12, resetsAt: iso(now + 2 * 3.6e6), models: [{ model: 'deepseek-v4-flash:cloud', requests: 34 }] },
        weekly: { pctUsed: 38, resetsAt: iso(now + 3 * 86_400_000), models: [{ model: 'deepseek-v4-flash:cloud', requests: 210 }] },
        extra: null,
        fetchedAt: iso(now),
      },
      codex: {
        ok: true, source: 'codex', plan: 'pro',
        fetchedAt: iso(now - 3.6e6), // push-only: last rollout write, can be stale
        session: null,
        weekly: { pctUsed: 8, resetsAt: iso(now + 5 * 86_400_000), models: [] },
      },
    };
  });

  // /status — { claude, openai }, each a normalized Statuspage payload
  // (status.mjs getStatus). Mirrors the e2e STATUS_STUB so the view renders
  // the same cards: Claude operational, OpenAI degraded with one incident.
  server.get('/status', () => {
    const now = iso(Date.now());
    return {
      claude: {
        ok: true, key: 'claude', label: 'Claude', pageUrl: 'https://status.claude.com',
        updatedAt: now, indicator: 'none', description: 'All Systems Operational',
        components: [{ name: 'Claude on the web', status: 'operational' }, { name: 'API', status: 'operational' }],
        incidents: [], maintenances: [], fetchedAt: now,
      },
      openai: {
        ok: true, key: 'openai', label: 'OpenAI', pageUrl: 'https://status.openai.com',
        updatedAt: now, indicator: 'minor', description: 'Partially Degraded Service',
        components: [{ name: 'API', status: 'degraded_performance' }],
        incidents: [{ name: 'Elevated error rates', status: 'monitoring', impact: 'minor', shortlink: 'https://status.openai.com', createdAt: now }],
        maintenances: [], fetchedAt: now,
      },
    };
  });

  // /sysstats — { cpu, mem, history } (sysstats.mjs getSysStats). The More menu
  // polls this every 2s; history is a fixed 2-minute sample so the sparkline
  // has points to draw.
  server.get('/sysstats', () => {
    const total = 16 * 1024 ** 3; // 16 GiB
    const used = Math.round(total * 0.47);
    const cpu = Array.from({ length: 60 }, (_, i) => 18 + ((i * 7) % 12));
    const mem = cpu.map((c) => 44 + Math.round(c / 6));
    return {
      cpu: 23,
      mem: { total, used, pct: 47 },
      history: { cpu, mem, stepMs: 2000 },
    };
  });

  // /history — { ok:true, entries, pending, today } (index.mjs GET /history).
  // Entries are seeded for the whole default 7-day window, so pending is empty.
  server.get('/history', (schema, req) => {
    const days = Number(req.queryParams.days) || 7;
    const { from, to } = req.queryParams || {};
    let entries = seedHistoryEntries();
    if (from) entries = entries.filter((e) => e.date >= from);
    if (to) entries = entries.filter((e) => e.date <= to);
    if (!from && !to) entries = entries.slice(-days);
    const have = new Set(entries.map((e) => e.date));
    const pending = [];
    for (let i = 1; i <= days; i++) {
      const d = localDay(Date.now() - i * 86_400_000);
      if (!have.has(d) && (!from || d >= from) && (!to || d <= to)) pending.push(d);
    }
    return { ok: true, entries: entries.slice().reverse(), pending, today: liveToday() };
  });

  // /history/regenerate — { ok:true, entry } or 400 { ok:false, error:'date required' }.
  server.post('/history/regenerate', (schema, req) => {
    const date = parseBody(req).date;
    if (!date) return new Response(400, {}, { ok: false, error: 'date required' });
    return {
      ok: true,
      entry: {
        date,
        projects: [{ path: '/fixture/beta', bullets: ['Regenerated the day summary', 'Re-scanned the day transcripts'] }],
        topics: ['regenerate'],
        repos: ['beta'],
        sessions: [],
        metrics: { sessions: 0, turns: 0, tokens: 0, costUsd: 0, byHarness: {} },
        llm: { ok: true, provider: 'anthropic-oauth', model: 'claude-haiku-4-5-20251001', inputTokens: 5000, outputTokens: 80 },
        builtAt: new Date().toISOString(),
      },
    };
  }, 200);

  // /procs — { procs: [...] } (procs.mjs scanClaude row shape). One row per
  // live agent (kind 'tracked') plus the mock's own 'daemon' row, so the
  // Processes dialog shows a protected daemon row like the real daemon.
  server.get('/procs', () => {
    const procs = db.agents.map((a) => ({
      pid: a.pid, ppid: 1, name: 'claude',
      started: new Date(a.createdAt).toISOString().slice(0, 19),
      session: a.id, kind: 'tracked',
    }));
    procs.push({ pid: 1, ppid: 0, name: 'node', started: null, session: null, kind: 'daemon' });
    return { procs };
  });

  // /procs/kill — 400 { ok:false, error:'bad pid' } on a non-integer; HTTP 200
  // { ok:false, error } on a failed kill (killClaudePid's convention — the
  // daemon does NOT set a 4xx for a failed kill). A known agent pid is removed
  // from db.agents and the `list` frame is broadcast so the dock drops it.
  server.post('/procs/kill', (schema, req) => {
    const pid = Number(parseBody(req).pid);
    if (!Number.isInteger(pid)) return new Response(400, {}, { ok: false, error: 'bad pid' });
    if (pid === 1) return { ok: false, error: 'daemon process — cannot stop from here' };
    const idx = db.agents.findIndex((a) => a.pid === pid);
    if (idx < 0) return { ok: false, error: 'not a tracked process' };
    db.agents.splice(idx, 1);
    broadcast(listFrame());
    return { ok: true };
  }, 200);

  // /usagereport/status — { exists, at } (usagereport.mjs reportStatus). A
  // canned report is always present in mock mode: the Vite mock-assets plugin
  // serves the HTML document, db.ui.usageReportAt stands in for its mtime.
  server.get('/usagereport/status', () => ({
    exists: true,
    at: db.ui.usageReportAt,
  }));

  // /usagereport/refresh — successful mock-only no-op. Advancing `at` mirrors
  // a newly generated report and makes UsageReportView remount its iframe.
  server.post('/usagereport/refresh', () => {
    db.ui.usageReportAt += 1;
    return { ok: true, at: db.ui.usageReportAt };
  }, 200);
}
