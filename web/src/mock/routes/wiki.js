// Wiki routes: read-only markdown browse + search + link graph over the mock's
// virtual filesystem (db.files), mirroring server/wiki.mjs exactly (design.md
// D8). The daemon's wiki root is FS-persisted; the mock keeps it in db.roots.wiki
// for the page lifetime. /wiki/files and /wiki/graph carry their error inside a
// 200 (the client checks d.error); /wiki/file uses real 404/400s.
import { Response } from 'miragejs';
import { db } from '../db.js';
import { FAKE_HOME, ROOTS } from '../fixtures.js';
import { parseBody } from '../helpers.js';

// Resolve a ~-prefixed client path to the mock's absolute form — db.files keys
// are absolute, and the client untildifies before fetching, so this is a
// belt-and-suspenders mirror of web/src/lib/paths.js untildify.
const untildify = (p) => {
  if (!p || typeof p !== 'string') return p;
  if (p === '~') return FAKE_HOME;
  if (p[0] === '~' && (p[1] === '/' || p[1] === '\\')) return FAKE_HOME + p.slice(1);
  return p;
};

// Top-level wiki dirs under `root`, each with its recursive .md pages derived
// from db.files. Mirrors server/wiki.mjs listFiles: pages are { path, rel }
// (rel relative to the wiki dir, forward-slashed); loose .md files at the root
// are ignored — only top-level directories are wikis.
function wikiDirs(root) {
  const prefix = root.endsWith('/') ? root : root + '/';
  const dirs = new Map(); // wiki dir path -> { name, path, pages }
  for (const path of Object.keys(db.files)) {
    if (!path.startsWith(prefix) || !path.toLowerCase().endsWith('.md')) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash < 0) continue; // loose .md at the root — not a wiki page
    const name = rest.slice(0, slash);
    const dirPath = prefix + name;
    if (!dirs.has(dirPath)) dirs.set(dirPath, { name, path: dirPath, pages: [] });
    dirs.get(dirPath).pages.push({ path, rel: rest.slice(slash + 1) });
  }
  const wikis = [...dirs.values()];
  for (const w of wikis) w.pages.sort((a, b) => a.rel.localeCompare(b.rel));
  wikis.sort((a, b) => a.name.localeCompare(b.name));
  return wikis;
}

// Does any db.files key live under `root`? Stands in for the daemon's
// existsSync(root) — an unknown root reads as "not found".
function rootKnown(root) {
  const prefix = root.endsWith('/') ? root : root + '/';
  return Object.keys(db.files).some((p) => p.startsWith(prefix));
}

// readWikiFile mirror: path must be a .md under the wiki root (else 400
// 'path outside wiki root'); missing file → 404 'not found'.
function readWikiFile(p, root) {
  if (!p || !root || typeof p !== 'string' || typeof root !== 'string' || !p.toLowerCase().endsWith('.md')) {
    return { ok: false, error: 'path outside wiki root' };
  }
  const prefix = root.endsWith('/') ? root : root + '/';
  if (!p.startsWith(prefix)) return { ok: false, error: 'path outside wiki root' };
  const f = db.files[p];
  if (!f) return { ok: false, error: 'not found' };
  return { ok: true, content: f.content };
}

// [[wikilink]] matcher — same regex as server/wiki.mjs.
const WIKILINK_RE = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;

export function registerWiki(server) {
  // /wiki/root — the FS-persisted root choice. The mock keeps it in db.roots.wiki
  // (seeded to ROOTS.wiki); PUT validates and stores it for the page lifetime.
  server.get('/wiki/root', () => ({ root: db.roots.wiki || ROOTS.wiki }));
  server.put('/wiki/root', (schema, req) => {
    const root = parseBody(req).root;
    if (typeof root !== 'string' || !root) return { ok: false, error: 'bad root' };
    db.roots.wiki = root;
    return { ok: true, root };
  });

  // /wiki/files — one entry per top-level wiki dir, each with its .md pages.
  // Error rides inside the 200 (client checks d.error), matching listFiles.
  server.get('/wiki/files', (schema, req) => {
    const root = untildify(req.queryParams.root);
    if (!root) return { wikis: [], capped: false, error: 'bad path' };
    if (!rootKnown(root)) return { wikis: [], capped: false, error: 'not found' };
    return { wikis: wikiDirs(root), capped: false };
  });

  // /wiki/search — substring match over page content, one hit per matching
  // line. rel is "<wiki>/<page-rel>" so hits show which wiki they belong to.
  server.get('/wiki/search', (schema, req) => {
    const ql = (req.queryParams.q || '').toLowerCase();
    if (!ql) return { results: [], capped: false };
    const root = untildify(req.queryParams.root);
    if (!root) return { results: [], capped: false };
    const results = [];
    for (const w of wikiDirs(root)) {
      for (const p of w.pages) {
        const f = db.files[p.path];
        if (!f) continue;
        const lines = f.content.split(/\r?\n/);
        const file = p.rel.split('/').pop();
        const rel = `${w.name}/${p.rel}`;
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].toLowerCase().includes(ql)) {
            results.push({ file, path: p.path, rel, line: i + 1, text: lines[i].trim().slice(0, 200) });
          }
        }
      }
    }
    return { results, capped: false };
  });

  // /wiki/graph — nodes = pages, edges = resolved [[wikilinks]]. Unresolved
  // links and self-loops are dropped; error rides inside the 200.
  server.get('/wiki/graph', (schema, req) => {
    const root = untildify(req.queryParams.root);
    const wiki = req.queryParams.wiki;
    if (!root || !rootKnown(root)) return { error: 'not found' };
    const w = wikiDirs(root).find((x) => x.name === wiki);
    if (!w) return { error: 'wiki not found' };
    const norm = (rel) => rel.replace(/\.md$/i, '').toLowerCase();
    const byRel = new Map(w.pages.map((p) => [norm(p.rel), p.rel]));
    const byBase = new Map(w.pages.map((p) => [norm(p.rel).split('/').pop(), p.rel]));
    const nodes = w.pages.map((p) => ({
      id: p.rel,
      label: p.rel.split('/').pop().replace(/\.md$/i, ''),
      category: p.rel.includes('/') ? p.rel.slice(0, p.rel.indexOf('/')) : '',
    }));
    const seen = new Set();
    const edges = [];
    for (const p of w.pages) {
      const f = db.files[p.path];
      if (!f) continue;
      for (const m of f.content.matchAll(WIKILINK_RE)) {
        const want = norm(m[1].trim());
        const target = byRel.get(want) || byBase.get(want.split('/').pop());
        if (!target || target === p.rel) continue;
        const key = `${p.rel}\0${target}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({ source: p.rel, target });
      }
    }
    return { nodes, edges };
  });

  // /wiki/file — read a page. 404 { ok:false, error:'not found' } when missing,
  // 400 for paths outside the wiki root (mirrors readWikiFile + the daemon's
  // reply.code).
  server.get('/wiki/file', (schema, req) => {
    const r = readWikiFile(req.queryParams.path, untildify(req.queryParams.root));
    if (!r.ok) return new Response(r.error === 'not found' ? 404 : 400, {}, r);
    return r;
  });
}
