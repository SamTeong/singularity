// Singularity daemon — Fastify + ws, loopback-only.
// SECURITY: binds 127.0.0.1 ONLY. Spawns claude agents with full FS access.
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { parse as parsePath, normalize as normalizePath } from 'node:path';
import { homedir } from 'node:os';
import { attachPtyWs } from './pty-ws.mjs';
import * as reg from './agents.mjs';
import { scanClaude, killClaudePid } from './procs.mjs';
import { readConfig, writeConfig } from './config.mjs';
import { searchMemory, listFiles, readMemoryFile, writeMemoryFile } from './memory.mjs';
import { statsFor } from './stats.mjs';
import { getUsage } from './usage.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT ?? 4317);
// Optional loopback token (defense-in-depth on top of the 127.0.0.1 bind).
// Set SING_TOKEN to require it on data endpoints + WS; the shell/assets stay open.
const TOKEN = process.env.SING_TOKEN || null;

const app = Fastify({ logger: { level: 'info' } });

// Browser cross-origin guard (DNS rebinding / drive-by pages hitting loopback).
// The 127.0.0.1 bind does not stop the user's own browser acting as a confused
// deputy: a malicious page can fetch/WS straight to localhost. Allow only our
// own origins (daemon + Vite dev); requests without Origin (curl, same-origin
// GET navigations) pass — this blocks browsers, not local tools.
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
    if (url === '/' || url === '/health' || url.startsWith('/assets')) return;
    const t = req.headers['x-sing-token'] || req.query?.token;
    if (t !== TOKEN) reply.code(401).send({ error: 'unauthorized' });
  });
}

const webDist = join(__dirname, '..', 'web', 'dist');
if (existsSync(webDist)) {
  app.register(fastifyStatic, { root: webDist, index: false });
  // Serve the shell via a route so the token can be injected for the client.
  app.get('/', async (req, reply) => {
    let html = readFileSync(join(webDist, 'index.html'), 'utf8');
    if (TOKEN) html = html.replace('</head>', `<script>window.__SING_TOKEN__=${JSON.stringify(TOKEN)};</script></head>`);
    reply.type('text/html').send(html);
  });
} else {
  app.log.warn('web/dist not built — run `npm run web` (Vite dev) separately for Phase 1');
}

app.get('/health', async () => ({ ok: true, pid: process.pid }));

// Per-agent stats (turns + tokens) parsed from each session .jsonl.
app.get('/agent-stats', async () => ({ stats: statsFor(reg.snapshot()) }));

// Ollama Cloud + Claude subscription usage (5h/7d). Cached; ?force=1 bypasses.
app.get('/usage', async (req) => getUsage({ force: req.query.force === '1' }));

// Dir picker: list subdirectories of `path` (browser can't read the FS). No file listing.
app.get('/fs/browse', async (req, reply) => {
  let p = req.query.path;
  if (!p) return reply.code(400).send({ error: 'bad path' });
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) p = normalizePath(homedir() + p.slice(1));
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

// Task manager: list claude.exe processes + kill a stale/orphaned one by PID.
app.get('/procs', async () => ({ procs: await scanClaude() }));

// Skill-scope picker source: directories under ~/.agents/skill-scopes (excludes 'common').
app.get('/skill-scopes', async () => {
  const root = join(homedir(), '.agents', 'skill-scopes');
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

// Config editor: 3-scope resolver + backup-then-write.
app.get('/config', async (req, reply) => {
  const cwd = req.query.cwd;
  if (!cwd) return reply.code(400).send({ error: 'cwd required' });
  return readConfig(cwd);
});
app.put('/config/:scope', async (req, reply) => {
  const { cwd, content } = req.body || {};
  if (!cwd || content == null) return reply.code(400).send({ ok: false, error: 'cwd + content required' });
  const r = writeConfig(cwd, req.params.scope, content);
  if (!r.ok) reply.code(400);
  return r;
});

// Memory: cross-project search + guarded read/write.
app.get('/memory/search', async (req) => searchMemory(req.query.q));
app.get('/memory/files', async () => ({ files: listFiles() }));
app.get('/memory/file', async (req, reply) => {
  const r = readMemoryFile(req.query.path);
  if (!r.ok) reply.code(r.error === 'not found' ? 404 : 400);
  return r;
});
app.put('/memory/file', async (req, reply) => {
  const { path, content } = req.body || {};
  if (path == null || content == null) return reply.code(400).send({ ok: false, error: 'path + content required' });
  const r = writeMemoryFile(path, content);
  if (!r.ok) reply.code(400);
  return r;
});

reg.init(app.log);

const server = await app.listen({ host: HOST, port: PORT });
app.log.info(`daemon on ${server} (loopback only)${TOKEN ? ' [token required]' : ''}`);

// WS shares the Fastify HTTP server.
const wss = new WebSocketServer({ server: app.server, path: '/ws' });
attachPtyWs(wss, app.log, TOKEN, originAllowed);
