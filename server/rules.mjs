// Rules backend: a list of persisted rule roots (default ~/.claude/rules),
// each a recursive .md tree, browsable/searchable/editable. Model on
// wiki.mjs (recursive walk, resolveRoot, mtime line cache) + config.mjs
// (roots persistence) + memory.mjs (write guard).
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve, sep, normalize } from 'node:path';
import { homedir } from 'node:os';
import { STATE_DIR } from './app-dir.mjs';

const RESULT_CAP = 300;
const FILE_CAP = 2000;
// Skip dot-dirs + heavy/vendored dirs during the recursive walk.
const SKIP_DIRS = new Set(['.git', '.obsidian', '.vscode', 'node_modules', '.next', '.cache', 'dist', 'build']);

// Rule root list: FS-persisted (survives browser cache clear) under STATE_DIR.
// Seeded with '~/.claude/rules' when absent/empty.
const ROOTS_FILE = join(STATE_DIR, 'rules-roots.json');
export function getRulesRoots() {
  try {
    const r = JSON.parse(readFileSync(ROOTS_FILE, 'utf8'));
    return Array.isArray(r) && r.length ? r : ['~/.claude/rules'];
  } catch { return ['~/.claude/rules']; }
}
export function setRulesRoots(roots) {
  const clean = [...new Set((roots || []).filter((r) => typeof r === 'string' && r))].slice(0, 50);
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(ROOTS_FILE, JSON.stringify(clean, null, 2));
    return { ok: true, roots: clean };
  } catch (e) { return { ok: false, error: e.message }; }
}

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

// Recursive .md walk under a root. Bounded by FILE_CAP. rel is relative to
// root, forward-slashed (e.g. "sub/foo.md"); file is the basename.
async function walk(root, dir, out) {
  let ents;
  try { ents = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const ent of ents) {
    if (ent.name.startsWith('.')) continue;
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name)) continue;
      await walk(root, full, out);
      if (out.length >= FILE_CAP) return;
    } else if (ent.isFile() && ent.name.toLowerCase().endsWith('.md')) {
      const rel = full.slice(root.length).split(sep).join('/').replace(/^\//, '');
      out.push({ root, path: full, rel, file: ent.name });
      if (out.length >= FILE_CAP) return;
    }
  }
}

// List .md files under each of the given roots. Skips roots that don't exist.
export async function listRuleFiles(roots) {
  const files = [];
  let capped = false;
  for (const raw of roots || []) {
    const r = resolveRoot(raw);
    if (!r || !existsSync(r)) continue;
    await walk(r, r, files);
    if (files.length >= FILE_CAP) { capped = true; break; }
  }
  return { files, capped };
}

// Search .md content across every root.
export async function searchRules(roots, q) {
  const ql = (q || '').toLowerCase();
  if (!ql) return { results: [], capped: false };
  const results = [];
  for (const raw of roots || []) {
    const r = resolveRoot(raw);
    if (!r || !existsSync(r)) continue;
    const files = [];
    await walk(r, r, files);
    for (const f of files) {
      const lines = await readLines(f.path);
      if (!lines) continue;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(ql)) {
          results.push({ root: f.root, path: f.path, rel: f.rel, file: f.file, line: i + 1, text: lines[i].trim().slice(0, 200) });
          if (results.length >= RESULT_CAP) return { results, capped: true };
        }
      }
    }
  }
  return { results, capped: false };
}

// Path guard: must resolve to <root>/<...>.md under ONE of the persisted
// roots — server-derived, never trusts the client's root.
export function isRulePath(p) {
  if (!p) return false;
  const abs = resolve(p);
  if (!abs.toLowerCase().endsWith('.md')) return false;
  return getRulesRoots().some((raw) => {
    const r = resolveRoot(raw);
    return r && (abs === r || abs.startsWith(r + sep));
  });
}

export function readRuleFile(p) {
  if (!isRulePath(p)) return { ok: false, error: 'path outside rule roots' };
  if (!existsSync(p)) return { ok: false, error: 'not found' };
  try { return { ok: true, content: readFileSync(p, 'utf8') }; }
  catch (e) { return { ok: false, error: e.message }; }
}

export function writeRuleFile(p, content) {
  if (!isRulePath(p)) return { ok: false, error: 'path outside rule roots' };
  try { writeFileSync(p, content); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
}
