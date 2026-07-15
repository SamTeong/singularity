// Wiki backend: a wiki root (default ~/wiki) holds one dir per wiki
// (claude-code, dotnet, myapp, …); each wiki is a recursive .md tree. Loose .md
// files at the root are ignored — only top-level directories are wikis.
// Read-only — no write/create: wikis are authored by the LLM, not the user.
import { existsSync, readFileSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve, sep, normalize } from 'node:path';
import { homedir } from 'node:os';

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
// root may arrive in ~ form — expand it the same way resolveRoot does.
export function isWikiPath(p, root) {
  if (!p || !root) return false;
  const abs = resolve(p);
  const r = resolveRoot(root);
  if (!r) return false;
  if (abs !== r && !abs.startsWith(r + sep)) return false;
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

export function readWikiFile(p, root) {
  if (!isWikiPath(p, root)) return { ok: false, error: 'path outside wiki root' };
  if (!existsSync(p)) return { ok: false, error: 'not found' };
  try { return { ok: true, content: readFileSync(p, 'utf8') }; }
  catch (e) { return { ok: false, error: e.message }; }
}