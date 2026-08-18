// Wiki backend: a wiki root (default ~/wiki) holds one dir per wiki
// (claude-code, dotnet, myapp, …); each wiki is a recursive .md tree. Loose .md
// files at the root are ignored — only top-level directories are wikis.
// Read-only — no write/create: wikis are authored by the LLM, not the user.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve, sep, normalize } from 'node:path';
import { homedir } from 'node:os';
import { STATE_DIR } from './app-dir.mjs';
import { norm, contains } from './path-containment.mjs';

// Wiki root choice, FS-persisted (survives browser cache clear). Single value —
// the root holds one dir per wiki. Defaults to ~/wiki.
const ROOT_FILE = join(STATE_DIR, 'wiki-root.json');
export function getWikiRoot() {
  try { const r = JSON.parse(readFileSync(ROOT_FILE, 'utf8')).root; return typeof r === 'string' && r ? r : '~/wiki'; }
  catch { return '~/wiki'; }
}
export function setWikiRoot(root) {
  if (typeof root !== 'string' || !root) return { ok: false, error: 'bad root' };
  try { mkdirSync(STATE_DIR, { recursive: true }); writeFileSync(ROOT_FILE, JSON.stringify({ root })); return { ok: true, root }; }
  catch (e) { return { ok: false, error: e.message }; }
}

const RESULT_CAP = 300;
const FILE_CAP = 2000;
// Skip dot-dirs + heavy/vendored dirs during the recursive walk.
const SKIP_DIRS = new Set(['.git', '.obsidian', '.vscode', 'node_modules', '.next', '.cache', 'dist', 'build']);

// Resolve a ~-prefixed client path to an absolute one (mirror /fs/browse).
export function resolveRoot(raw) {
  if (!raw) return null;
  let p = raw;
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) p = normalize(homedir() + p.slice(1));
  try { return resolve(p); } catch { return null; }
}

// Search runs per keystroke (250ms debounce); cache file lines by mtime so only
// changed files are re-read from disk. stat-per-file is cheap; the read isn't.
const lineCache = new Map(); // path -> { mtimeMs, lines }
async function readLines(p) {
  let mtimeMs;
  try { mtimeMs = (await stat(p)).mtimeMs; } catch { return null; }
  const hit = lineCache.get(p);
  if (hit && hit.mtimeMs === mtimeMs) return hit.lines;
  let lines;
  try { lines = (await readFile(p, 'utf8')).split(/\r?\n/); } catch { return null; }
  lineCache.set(p, { mtimeMs, lines });
  return lines;
}

// Top-level wiki directories under root (skip dot-dirs + vendored dirs).
async function wikiDirs(root) {
  let ents;
  try { ents = await readdir(root, { withFileTypes: true }); } catch { return []; }
  return ents
    .filter((d) => d.isDirectory() && !d.name.startsWith('.') && !SKIP_DIRS.has(d.name))
    .map((d) => ({ name: d.name, path: join(root, d.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Recursive .md walk under a wiki dir. Bounded by FILE_CAP. rel is relative to
// the wiki dir, forward-slashed (e.g. "concepts/foo.md").
async function walk(wikiRoot, dir, out) {
  let ents;
  try { ents = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const ent of ents) {
    if (ent.name.startsWith('.')) continue;
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name)) continue;
      await walk(wikiRoot, full, out);
      if (out.length >= FILE_CAP) return;
    } else if (ent.isFile() && ent.name.toLowerCase().endsWith('.md')) {
      out.push({ path: full, rel: full.slice(wikiRoot.length).split(sep).join('/').replace(/^\//, '') });
      if (out.length >= FILE_CAP) return;
    }
  }
}

// Path guard: must resolve to <root>/<...>.md, no escape via .. or symlink abs.
// root may arrive in ~ form — expand it the same way resolveRoot does. root
// must equal the server-persisted wiki root (getWikiRoot): trusting whatever
// root the caller/request supplies would let it invent a root that trivially
// "contains" any path, defeating containment (path-traversal via ?root=).
export function isWikiPath(p, root) {
  if (!p || !root) return false;
  const abs = resolve(p);
  const r = resolveRoot(root);
  const persisted = resolveRoot(getWikiRoot());
  if (!r || !persisted || norm(r) !== norm(persisted)) return false;
  if (!contains(r, abs)) return false;
  return abs.toLowerCase().endsWith('.md');
}

// Tree: one entry per top-level wiki dir, each carrying its recursive .md pages.
export async function listFiles(root) {
  const r = resolveRoot(root);
  if (!r) return { wikis: [], capped: false, error: 'bad path' };
  if (!existsSync(r)) return { wikis: [], capped: false, error: 'not found' };
  const wikis = [];
  let capped = false;
  for (const w of await wikiDirs(r)) {
    const pages = [];
    await walk(w.path, w.path, pages);
    pages.sort((a, b) => a.rel.localeCompare(b.rel));
    if (pages.length >= FILE_CAP) capped = true;
    wikis.push({ name: w.name, path: w.path, pages });
    if (wikis.reduce((n, x) => n + x.pages.length, 0) >= FILE_CAP) { capped = true; break; }
  }
  return { wikis, capped };
}

// Search across every wiki's pages. rel is "<wiki>/<page-rel>" so hits show
// which wiki they belong to.
export async function searchWiki(q, root) {
  const ql = (q || '').toLowerCase();
  if (!ql) return { results: [], capped: false };
  const r = resolveRoot(root);
  if (!r || !existsSync(r)) return { results: [], capped: false };
  const results = [];
  for (const w of await wikiDirs(r)) {
    const pages = [];
    await walk(w.path, w.path, pages);
    for (const f of pages) {
      const lines = await readLines(f.path);
      if (!lines) continue;
      const file = f.rel.split('/').pop();
      const rel = `${w.name}/${f.rel}`;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(ql)) {
          results.push({ file, path: f.path, rel, line: i + 1, text: lines[i].trim().slice(0, 200) });
          if (results.length >= RESULT_CAP) return { results, capped: true };
        }
      }
    }
  }
  return { results, capped: false };
}

// Link graph for one wiki: nodes = pages, edges = resolved [[wikilinks]].
// Target resolution mirrors the client jumpTo — match full rel or basename,
// with/without .md. Unresolved links and self-loops are dropped.
const WIKILINK_RE = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
export async function wikiGraph(root, wiki) {
  const r = resolveRoot(root);
  if (!r || !existsSync(r)) return { error: 'not found' };
  const w = (await wikiDirs(r)).find((x) => x.name === wiki);
  if (!w) return { error: 'wiki not found' };
  const pages = [];
  await walk(w.path, w.path, pages);
  const norm = (rel) => rel.replace(/\.md$/i, '').toLowerCase();
  const byRel = new Map(pages.map((p) => [norm(p.rel), p.rel]));
  const byBase = new Map(pages.map((p) => [norm(p.rel).split('/').pop(), p.rel]));
  const nodes = pages.map((p) => ({
    id: p.rel, label: p.rel.split('/').pop().replace(/\.md$/i, ''),
    category: p.rel.includes('/') ? p.rel.slice(0, p.rel.indexOf('/')) : '',
  }));
  const seen = new Set();
  const edges = [];
  for (const p of pages) {
    let src;
    try { src = await readFile(p.path, 'utf8'); } catch { continue; }
    for (const m of src.matchAll(WIKILINK_RE)) {
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
}

export function readWikiFile(p, root) {
  if (!isWikiPath(p, root)) return { ok: false, error: 'path outside wiki root' };
  if (!existsSync(p)) return { ok: false, error: 'not found' };
  try { return { ok: true, content: readFileSync(p, 'utf8') }; }
  catch (e) { return { ok: false, error: e.message }; }
}