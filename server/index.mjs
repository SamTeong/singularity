// Singularity daemon — Fastify + ws, loopback-only.
// SECURITY: binds 127.0.0.1 ONLY. Spawns claude agents with full FS access.
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { parse as parsePath } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import './migrate-state.mjs';
import { attachPtyWs } from './pty-ws.mjs';
import * as reg from './agents.mjs';
import { scanClaude, killClaudePid } from './procs.mjs';
import { readConfig, writeConfig, searchConfig, claudeTheme, findConfigRoots, getConfigRoots, setConfigRoots } from './config.mjs';
import { listHooks, searchHooks, readHook, writeHook, getHookRoots, setHookRoots } from './hooks.mjs';
import { searchMemory, listFiles, readMemoryFile, writeMemoryFile, getMemoryRoot, setMemoryRoot } from './memory.mjs';
import { getRulesRoots, setRulesRoots, listRuleFiles, searchRules, readRuleFile, writeRuleFile } from './rules.mjs';
import { listFiles as wikiFiles, searchWiki, readWikiFile, wikiGraph, getWikiRoot, setWikiRoot, resolveRoot } from './wiki.mjs';
import { listSessions, readSession, searchSessions, subagentsFor, getSessionsRoot, setSessionsRoot } from './sessions.mjs';
import { listSkills, readSkill, getSkillsRoots, setSkillsRoots } from './skills.mjs';
import { statsFor, sessionStats } from './stats.mjs';
import { getSysStats } from './sysstats.mjs';
import { getUsage, initUsageAutoRefresh } from './usage.mjs';
import { reportStatus, latestReportHtml, generateReport } from './spend.mjs';
import { initTasks, snapshotTasks, createTask, updateTask, concludeTask, deleteHistory, detectMcp } from './tasks.mjs';
import { initCrons, snapshotCrons, createCron, updateCron, deleteCron, runCron } from './crons.mjs';
import { initBackground, snapshotBackground, createDef, updateDef, deleteDef, reorderDefs, runBackgroundNow, listReports, getReport } from './background.mjs';
import { CLAUDE_ALIASES, OLLAMA_PRESETS } from './models.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT);
// Optional loopback token (defense-in-depth on top of the 127.0.0.1 bind).
// Set SING_TOKEN to require it on data endpoints + WS; the shell/assets stay open.
const TOKEN = process.env.SING_TOKEN || null;

// No baked-in machine defaults — all machine-specific config must come from .env
// (loaded via --env-file-if-exists=.env). Fail fast with a clear list if any
// required var is missing. SINGULARITY_HOME is enforced at app-dir.mjs load.
function requireEnv() {
  const missing = [];
  if (!process.env.PORT || !Number(process.env.PORT)) missing.push('PORT (listen port, e.g. 4317)');
  if (!reg.CLAUDE_BIN) missing.push('CLAUDE_BIN (absolute path to claude exe)');
  // OLLAMA_BIN + SING_SCOPE_ROOT are optional: absent OLLAMA_BIN fails only
  // ollama-model spawns (clear buildSpawn error); absent SING_SCOPE_ROOT just
  // means no skill-scopes to pick/add-dir. The daemon boots fine without either.
  // SING_USAGE_SKILL + SING_USAGE_REPORTS are likewise optional (author-specific
  // claude-code-usage-report skill): absent → spend/usage-report degrade silently
  // (spend.mjs existsSync-guards its skill path; stats.mjs has an est-cost
  // fallback). /capabilities reports all of these as available:false.
  if (process.env.SING_TOKEN && !/^[A-Za-z0-9_-]+$/.test(process.env.SING_TOKEN)) missing.push('SING_TOKEN (set but contains characters outside [A-Za-z0-9_-])');
  if (missing.length) {
    throw new Error(`Required env vars missing — copy .env.example → .env and fill them in:\n  - ${missing.join('\n  - ')}`);
  }
}
requireEnv();

// The ?token= form of the auth gate (below) puts SING_TOKEN in the request URL —
// redact it from the default req serializer so it never lands in log output.
// Shape mirrors Fastify's own default (lib/logger-pino.js `serializers.req`);
// only `url` is transformed.
function redactTokenParam(url) {
  return url.replace(/([?&]token=)[^&]*/i, '$1[redacted]');
}
const app = Fastify({
  logger: {
    level: 'info',
    serializers: {
      req(req) {
        return {
          method: req.method,
          url: redactTokenParam(req.url),
          version: req.headers && req.headers['accept-version'],
          host: req.host,
          remoteAddress: req.ip,
          remotePort: req.socket ? req.socket.remotePort : undefined,
        };
      },
    },
  },
});

// Safety net: the daemon hosts live PTY agents — an unhandled rejection must be
// logged and survive, never crash the process.
process.on('unhandledRejection', (e) => app.log.error({ err: e?.message ?? String(e) }, 'unhandled rejection'));
// Same net for a synchronous throw (a setInterval tick, a bus listener, a
// setTimeout callback) — without this, any of those crashes the whole daemon
// and orphans every live agent pty.
process.on('uncaughtException', (e) => app.log.error({ err: e?.message ?? String(e) }, 'uncaught exception'));

// Graceful shutdown: kill every live agent pty first (each kill's onExit fully
// persists its own final state — activeMs, registry entry — before this
// returns), bounded so one hung pty can't wedge shutdown forever. Shared by
// SIGTERM/SIGINT and /restart so a restart never orphans a running claude.
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  const live = reg.snapshot().filter((a) => reg.isLive(a.id));
  app.log.info({ count: live.length }, 'shutting down — killing live agents');
  for (const a of live) reg.kill(a.id);
  const deadline = Date.now() + 5000;
  while (live.some((a) => reg.isLive(a.id)) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  try { await app.close(); } catch {}
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// web/dist absent → running via `pnpm dev` (daemon on PORT, Vite dev server on
// :5317 proxying to it); present → `pnpm start` serves the built shell straight
// from this daemon and Vite never runs. Same signal the static-serving branch
// below already uses to tell dev from prod.
const webDist = join(__dirname, '..', 'web', 'dist');

// Browser cross-origin guard (DNS rebinding / drive-by pages hitting loopback).
// The 127.0.0.1 bind does not stop the user's own browser acting as a confused
// deputy: a malicious page can fetch/WS straight to localhost. Allow only our
// own origins (daemon + Vite dev); requests without Origin (curl, same-origin
// GET navigations) pass — this blocks browsers, not local tools. The Vite dev
// origin (:5317) is always trusted: DEV is inferred from dist presence, but
// `pnpm dev` can leave a stale dist around → DEV=false → the proxied :5317 WS
// Origin would 403 and the shell shows "disconnected". Loopback-only bind makes
// trusting the dev port unconditionally free.
const SELF_HOSTS = new Set(
  [PORT, 5317].flatMap((p) => [`127.0.0.1:${p}`, `localhost:${p}`, `[::1]:${p}`]),
);
function originAllowed(origin) {
  if (!origin) return true;
  try { return SELF_HOSTS.has(new URL(origin).host); } catch { return false; }
}
app.addHook('onRequest', async (req, reply) => {
  if (req.headers.host && !SELF_HOSTS.has(req.headers.host)) {
    return reply.code(403).send({ error: 'forbidden host' });
  }
  if (!originAllowed(req.headers.origin)) {
    return reply.code(403).send({ error: 'forbidden origin' });
  }
});

// Token gate: allow the app shell + assets + health through; guard everything else.
if (TOKEN) {
  app.addHook('onRequest', async (req, reply) => {
    const url = req.raw.url.split('?')[0];
    if (url === '/' || url === '/health' || url === '/capabilities' || url.startsWith('/assets')) return;
    const t = req.headers['x-sing-token'] || req.query?.token;
    if (t !== TOKEN) reply.code(401).send({ error: 'unauthorized' });
  });
}

// createTask/updateTask/createCron/... funnel their state changes through a
// persist() that now throws (flagged `.persistFailure`) on a genuine disk
// write failure instead of silently swallowing it — surface that as 500 (the
// request succeeded but state wasn't durably saved), vs. 400 for a plain
// validation error.
const errStatus = (e) => (e.persistFailure ? 500 : 400);

// Recursively collect file mtimes under `dir` (used by the dist-staleness check below).
function walkMtimes(dir) {
  const out = [];
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, d.name);
    if (d.isDirectory()) out.push(...walkMtimes(p));
    else out.push(statSync(p).mtimeMs);
  }
  return out;
}

if (existsSync(webDist)) {
  app.register(fastifyStatic, { root: webDist, index: false });
  // Serve the shell via a route so the token can be injected for the client.
  app.get('/', async (req, reply) => {
    let html = readFileSync(join(webDist, 'index.html'), 'utf8');
    if (TOKEN) html = html.replace('</head>', `<script>window.__SING_TOKEN__=${JSON.stringify(TOKEN)};</script></head>`);
    reply.type('text/html').send(html);
  });
  // Best-effort staleness check: warn if dist predates the web source it was built from.
  try {
    const distMtime = statSync(join(webDist, 'index.html')).mtimeMs;
    const srcRoot = join(__dirname, '..', 'web', 'src');
    const newestSrc = Math.max(...walkMtimes(srcRoot));
    if (newestSrc > distMtime) app.log.warn('web/dist is older than web/src — run npm run build');
  } catch {}
} else {
  app.log.warn('web/dist not built — run `npm run web` (Vite dev) separately for Phase 1');
}

let wss; // assigned after listen; /health reports live WS client count for dev smart-open
app.get('/health', async () => ({ ok: true, pid: process.pid, clients: wss?.clients.size ?? 0 }));

// Per-agent stats (turns + tokens) parsed from each session .jsonl.
app.get('/agent-stats', async () => ({ stats: await statsFor(reg.snapshot()) }));

// Machine-wide CPU% + RAM readout (More menu, below Processes).
app.get('/sysstats', async () => getSysStats());

// Ollama Cloud + Claude subscription usage (5h/7d). Cached; ?force=1 bypasses.
app.get('/usage', async (req) => getUsage({ force: req.query.force === '1' }));

// Spend report: newest self-contained HTML from the claude-code-usage-report
// skill (rendered on demand by /spend/refresh, served whole to a sandboxed iframe).
app.get('/spend/status', async () => reportStatus());
app.get('/spend/report', async (req, reply) => {
  const html = latestReportHtml();
  if (html == null) return reply.code(404).send({ ok: false, error: 'no report' });
  return reply.type('text/html').send(html);
});
app.post('/spend/refresh', async (req, reply) => {
  const r = await generateReport();
  if (!r.ok) reply.code(400);
  return r;
});

// Dir picker: list subdirectories of `path` (browser can't read the FS). No file listing.
app.get('/fs/browse', async (req, reply) => {
  let p = req.query.path;
  if (!p) return reply.code(400).send({ error: 'bad path' });
  if (!existsSync(p)) return reply.code(400).send({ error: 'bad path' });
  try {
    const dirs = readdirSync(p, { withFileTypes: true })
      .filter((d) => { try { return d.isDirectory() && !d.name.startsWith('.'); } catch { return false; } })
      .map((d) => d.name)
      .sort((a, b) => a.localeCompare(b));
    const { dir: parent, root } = parsePath(p);
    return { path: p, parent: p === root ? null : parent, dirs };
  } catch (e) {
    return reply.code(400).send({ error: e.message });
  }
});

// Task manager: list claude.exe + this repo's dev-tooling processes, kill a stale/orphaned one by PID.
app.get('/procs', async () => ({ procs: await scanClaude() }));

// Model picker source: claude aliases (mirror /model) + ollama presets. Free-text
// in the UI — these are suggestions; any typed value is passed through verbatim.
app.get('/models', async () => ({ claude: CLAUDE_ALIASES, ollama: OLLAMA_PRESETS }));

// Home dir, for the client to collapse full paths to `~` on display (pure
// presentation — the backend itself always deals in full paths).
app.get('/env', async () => ({ home: homedir() }));

// Optional-feature flags for the shell: which features are wired up on this
// machine so the UI can show inline "set X to enable" hints instead of failing
// opaquely. No secrets — just boolean availability + a human hint per feature.
// Not token-gated (mirrors /health) so the shell can render hints pre-auth.
app.get('/capabilities', async () => {
  const wikiRoot = getWikiRoot();
  const wikiAbs = resolveRoot(wikiRoot);
  let wikiAvailable = false;
  if (wikiAbs && existsSync(wikiAbs)) {
    try { wikiAvailable = readdirSync(wikiAbs, { withFileTypes: true }).some((d) => d.isDirectory() && !d.name.startsWith('.')); }
    catch { wikiAvailable = false; }
  }
  const usageReportAvailable = !!(process.env.SING_USAGE_SKILL && existsSync(process.env.SING_USAGE_SKILL));
  return {
    ollama:      { available: !!reg.OLLAMA_BIN, hint: 'Set OLLAMA_BIN in .env to enable Ollama model spawns.' },
    skillScopes: { available: !!(process.env.SING_SCOPE_ROOT && existsSync(process.env.SING_SCOPE_ROOT)), hint: 'Set SING_SCOPE_ROOT in .env to enable skill-scope picking.' },
    usageReport: { available: usageReportAvailable, hint: 'Set SING_USAGE_SKILL + SING_USAGE_REPORTS in .env to enable spend reports.' },
    spend:       { available: usageReportAvailable, hint: 'Set SING_USAGE_SKILL + SING_USAGE_REPORTS in .env to enable the spend view.' },
    wiki:        { available: wikiAvailable, hint: 'Pick a wiki root in the Wiki panel to enable it.' },
    leanCtx:     { available: detectMcp('lean-ctx'), hint: 'Install the lean-ctx MCP server to enable compressed reads in task subagents.' },
    token:       { available: !!process.env.SING_TOKEN, hint: 'Set SING_TOKEN in .env to require an auth token on data endpoints.' },
  };
});

// Skill-scope picker source: directories under SING_SCOPE_ROOT (excludes 'common').
app.get('/skill-scopes', async () => {
  const root = reg.SCOPE_ROOT;
  if (!root) return { scopes: [] };
  let scopes = [];
  try {
    scopes = readdirSync(root, { withFileTypes: true })
      .filter((d) => { try { return d.isDirectory() && d.name !== 'common'; } catch { return false; } })
      .map((d) => d.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {}
  return { scopes };
});
app.post('/procs/kill', async (req, reply) => {
  const pid = Number(req.body?.pid);
  if (!Number.isInteger(pid)) return reply.code(400).send({ ok: false, error: 'bad pid' });
  return killClaudePid(pid);
});
app.post('/restart', async (req, reply) => {
  reply.send({ ok: true });
  // ponytail: no supervisor — daemon respawns itself detached, then exits via
  // the same graceful shutdown() as SIGTERM/SIGINT (kills all live PTY sessions
  // and waits for them before exiting, instead of a bare process.exit).
  // In dev (concurrently -k) vite won't come back; button is meant for `npm start`.
  setTimeout(() => {
    spawn(process.execPath, [...process.execArgv, process.argv[1]], {
      detached: true, stdio: 'ignore', cwd: process.cwd(), env: process.env,
    }).unref();
    shutdown();
  }, 100);
});

// Config editor: 3-scope resolver + backup-then-write.
app.get('/config', async (req, reply) => {
  const cwd = req.query.cwd;
  if (!cwd) return reply.code(400).send({ error: 'cwd required' });
  return readConfig(cwd);
});
app.get('/claude/theme', async () => ({ theme: claudeTheme() }));
// Recursively find dirs under `root` that hold a .claude/settings*.json.
app.get('/config/scan', async (req, reply) => {
  const root = req.query.root;
  if (!root || !existsSync(root)) return reply.code(400).send({ error: 'bad root' });
  return findConfigRoots(root);
});
// FS-persisted config root list (survives browser cache clear).
app.get('/config/roots', async () => ({ roots: getConfigRoots() }));
app.put('/config/roots', async (req) => setConfigRoots(req.body?.roots));
app.post('/config/search', async (req) => {
  const { roots, q } = req.body || {};
  return { results: searchConfig(roots, q) };
});
app.put('/config/:scope', async (req, reply) => {
  const { cwd, content } = req.body || {};
  if (!cwd || content == null) return reply.code(400).send({ ok: false, error: 'cwd + content required' });
  const r = writeConfig(cwd, req.params.scope, content);
  if (!r.ok) reply.code(400);
  return r;
});

// Hooks editor: list + read + write hook script files under a root's .claude/hooks/.
app.get('/hooks/roots', async () => ({ roots: getHookRoots() }));
app.put('/hooks/roots', async (req) => setHookRoots(req.body?.roots));
app.post('/hooks/list', async (req) => {
  const roots = req.body?.roots || [];
  return { groups: roots.map((cwd) => ({ cwd, files: listHooks(cwd) })) };
});
app.post('/hooks/search', async (req) => {
  const { roots, q } = req.body || {};
  return { results: searchHooks(roots, q) };
});
app.get('/hooks/file', async (req, reply) => {
  const r = readHook(req.query.path);
  if (r.error) return reply.code(400).send(r);
  return r;
});
app.put('/hooks/file', async (req, reply) => {
  const { path, content } = req.body || {};
  if (!path || content == null) return reply.code(400).send({ ok: false, error: 'path + content required' });
  const r = writeHook(path, content);
  if (!r.ok) reply.code(400);
  return r;
});

// Task board: kanban CRUD. /tasks/:id/status is called by each task's own
// agent (curl) as well as UI drags.
app.get('/tasks', async () => snapshotTasks());
app.post('/tasks', async (req, reply) => {
  try { return { ok: true, task: createTask(req.body || {}) }; }
  catch (e) { return reply.code(errStatus(e)).send({ ok: false, error: e.message }); }
});
app.post('/tasks/:id/status', async (req, reply) => {
  try { return { ok: true, task: await updateTask(req.params.id, req.body || {}) }; }
  catch (e) { return reply.code(errStatus(e)).send({ ok: false, error: e.message }); }
});
app.post('/tasks/:id/conclude', async (req, reply) => {
  try { await concludeTask(req.params.id, req.body?.outcome); return { ok: true }; }
  catch (e) { return reply.code(errStatus(e)).send({ ok: false, error: e.message }); }
});
app.delete('/tasks/history/:id', async (req, reply) => {
  try { deleteHistory(req.params.id); return { ok: true }; }
  catch (e) { return reply.code(errStatus(e)).send({ ok: false, error: e.message }); }
});

// Cron jobs: list/create/update/delete + manual run. In-process UTC scheduler;
// missed runs ignored on restart (nextFire recomputed from now).
app.get('/crons', async () => snapshotCrons());
app.post('/crons', async (req, reply) => {
  try { return { ok: true, cron: createCron(req.body || {}) }; }
  catch (e) { return reply.code(errStatus(e)).send({ ok: false, error: e.message }); }
});
app.post('/crons/:id', async (req, reply) => {
  try { return { ok: true, cron: updateCron(req.params.id, req.body || {}) }; }
  catch (e) { return reply.code(errStatus(e)).send({ ok: false, error: e.message }); }
});
app.delete('/crons/:id', async (req, reply) => {
  try { deleteCron(req.params.id); return { ok: true }; }
  catch (e) { return reply.code(errStatus(e)).send({ ok: false, error: e.message }); }
});
app.post('/crons/:id/run', async (req, reply) => {
  try { return { ok: true, cron: runCron(req.params.id) }; }
  catch (e) { return reply.code(errStatus(e)).send({ ok: false, error: e.message }); }
});

// Background tasks: quota-soak runs during working hours. Per-def CRUD (each
// def carries its own window/thresholds/models/tokenCaps) + manual trigger
// (?force=1 bypasses the usage gate). Scheduler lives in-process.
app.get('/background', async () => snapshotBackground());
app.post('/background/defs', async (req, reply) => {
  try { return { ok: true, def: createDef(req.body || {}) }; }
  catch (e) { return reply.code(errStatus(e)).send({ ok: false, error: e.message }); }
});
app.patch('/background/defs/:id', async (req, reply) => {
  try { return { ok: true, def: updateDef(req.params.id, req.body || {}) }; }
  catch (e) { return reply.code(errStatus(e)).send({ ok: false, error: e.message }); }
});
app.delete('/background/defs/:id', async (req, reply) => {
  try { deleteDef(req.params.id); return { ok: true }; }
  catch (e) { return reply.code(errStatus(e)).send({ ok: false, error: e.message }); }
});
app.patch('/background/reorder', async (req, reply) => {
  try { reorderDefs((req.body || {}).ids); return { ok: true }; }
  catch (e) { return reply.code(errStatus(e)).send({ ok: false, error: e.message }); }
});
app.post('/background/run', async (req, reply) => {
  try { const { taskId } = await runBackgroundNow({ force: req.query.force === '1' }); return { ok: true, taskId }; }
  catch (e) { return reply.code(errStatus(e)).send({ ok: false, error: e.message }); }
});
app.get('/background/reports', async () => ({ reports: listReports() }));
app.get('/background/reports/:taskId', async (req, reply) => {
  const r = getReport(req.params.taskId);
  if (!r) return reply.code(404).send({ ok: false, error: 'not found' });
  return { ok: true, ...r };
});

// Memory: cross-project search + guarded read/write under a client-selected root.
app.get('/memory/root', async () => ({ root: getMemoryRoot() }));
app.put('/memory/root', async (req) => setMemoryRoot(req.body?.root));
app.get('/memory/search', async (req) => searchMemory(req.query.q, req.query.root));
app.get('/memory/files', async (req) => ({ files: listFiles(req.query.root) }));
app.get('/memory/file', async (req, reply) => {
  const r = readMemoryFile(req.query.path, req.query.root);
  if (!r.ok) reply.code(r.error === 'not found' ? 404 : 400);
  return r;
});
app.put('/memory/file', async (req, reply) => {
  const { path, content, root } = req.body || {};
  if (path == null || content == null) return reply.code(400).send({ ok: false, error: 'path + content required' });
  const r = writeMemoryFile(path, content, root);
  if (!r.ok) reply.code(400);
  return r;
});

// Rules: persisted list of rule dirs (default ~/.claude/rules), each a
// recursive .md tree — browse + search + guarded read/write.
app.get('/rules/roots', async () => ({ roots: getRulesRoots() }));
app.put('/rules/roots', async (req) => setRulesRoots(req.body?.roots));
app.post('/rules/files', async (req) => listRuleFiles(req.body?.roots));
app.post('/rules/search', async (req) => {
  const { roots, q } = req.body || {};
  return searchRules(roots, q);
});
app.get('/rules/file', async (req, reply) => {
  const r = readRuleFile(req.query.path);
  if (!r.ok) reply.code(r.error === 'not found' ? 404 : 400);
  return r;
});
app.put('/rules/file', async (req, reply) => {
  const { path, content } = req.body || {};
  if (path == null || content == null) return reply.code(400).send({ ok: false, error: 'path + content required' });
  const r = writeRuleFile(path, content);
  if (!r.ok) reply.code(400);
  return r;
});

// Wiki: recursive .md browse + search + read-only file view under a client-
// selected root (default ~/wiki). No write — wikis are LLM-authored.
// FS-persisted wiki root choice (survives browser cache clear).
app.get('/wiki/root', async () => ({ root: getWikiRoot() }));
app.put('/wiki/root', async (req) => setWikiRoot(req.body?.root));
app.get('/wiki/files', async (req) => wikiFiles(req.query.root));
app.get('/wiki/search', async (req) => searchWiki(req.query.q, req.query.root));
app.get('/wiki/graph', async (req) => wikiGraph(req.query.root, req.query.wiki));
app.get('/wiki/file', async (req, reply) => {
  const r = readWikiFile(req.query.path, req.query.root);
  if (!r.ok) reply.code(r.error === 'not found' ? 404 : 400);
  return r;
});

// Skills viewer: tree of skill scopes → skills, read a skill's SKILL.md.
// Read-only — no write. Paths server-derived from (scope, skill).
// FS-persisted skills root choice (survives browser cache clear). Root layout
// (grouped scope dir vs flat .claude/skills) is auto-detected server-side.
app.get('/skills/roots', async () => ({ roots: getSkillsRoots() }));
app.put('/skills/roots', async (req) => setSkillsRoots(req.body?.roots));
app.get('/skills', async (req) => listSkills(req.query.root));
app.get('/skill', async (req, reply) => {
  const r = readSkill(req.query.root, req.query.scope, req.query.skill, req.query.flat === '1');
  if (!r.ok) reply.code(r.error === 'not found' ? 404 : 400);
  return r;
});

// Session history: list transcripts (reverse-chrono), read one, search across
// all or one, under a client-selected root (default ~/.claude/projects).
// FS-persisted root choice (survives browser cache clear). Chat goes over the
// WS (streaming) — see pty-ws.mjs.
app.get('/sessions/root', async () => ({ root: getSessionsRoot() }));
app.put('/sessions/root', async (req) => setSessionsRoot(req.body?.root));
app.get('/sessions', async (req) => ({ sessions: await listSessions({ cap: Number(req.query.cap) || 5000, isLive: reg.isLive, root: req.query.root }) }));
app.get('/session', async (req, reply) => {
  const { project, id, root } = req.query || {};
  if (!project || !id) return reply.code(400).send({ ok: false, error: 'project + id required' });
  const r = await readSession(project, id, root);
  if (!r.ok) reply.code(404);
  return r;
});
app.get('/sessions/search', (req) => searchSessions(req.query.q, { project: req.query.project, id: req.query.id, root: req.query.root }));
// Live subagents nested under the dock's agent rows (indicator only). Scoped to
// live agents so it stays cheap — no full 500-session scan like /sessions.
app.get('/subagents', async () => {
  const out = {};
  for (const a of reg.snapshot()) {
    if (a.status !== 'running' && a.status !== 'idle' && a.status !== 'starting') continue;
    const subs = await subagentsFor(a.cwd, a.id, reg.isLive);
    if (subs.length) out[a.id] = subs;
  }
  return { subagents: out };
});
// Per-session cost + token breakdown for the visible list page (batched so a
// page flip is one request; stats.mjs caches each parse by mtime/size).
app.post('/sessions/stats', async (req) => {
  const items = Array.isArray(req.body?.items) ? req.body.items.slice(0, 200) : [];
  const root = req.body?.root;
  const stats = {};
  for (const it of items) if (it?.project && it?.id) stats[it.id] = await sessionStats(it.project, it.id, root);
  return { stats };
});

reg.init(app.log);
initTasks(app.log);
initCrons(app.log);
initBackground(app.log);
initUsageAutoRefresh(reg.bus);

let server;
// ponytail: retry bind — a /restart child waits for the old daemon to free the port
for (let tries = 20; ; tries--) {
  try {
    server = await app.listen({ host: HOST, port: PORT });
    break;
  } catch (e) {
    if (e.code === 'EADDRINUSE' && tries > 1) {
      await new Promise((r) => setTimeout(r, 250));
      continue;
    }
    if (e.code === 'EADDRINUSE') app.log.error(`port ${PORT} already in use — is Singularity already running?`);
    else app.log.error(e);
    process.exit(1);
  }
}
app.log.info(`daemon on ${server} (loopback only)${TOKEN ? ' [token required]' : ''}`);

// WS shares the Fastify HTTP server.
wss = new WebSocketServer({ server: app.server, path: '/ws' });
attachPtyWs(wss, app.log, TOKEN, originAllowed);
