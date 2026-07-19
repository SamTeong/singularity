// Memory backend: search + guarded read/write across per-project memory dirs
// (<root>/<encoded-cwd>/memory/*.md, default root ~/.claude/projects). Writes are
// confined to those dirs — a path outside any project's memory/ is rejected.
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { join, resolve, sep, normalize } from 'node:path';
import { homedir } from 'node:os';
import { STATE_DIR } from './app-dir.mjs';

const DEFAULT_ROOT = join(homedir(), '.claude', 'projects');
const RESULT_CAP = 300;

// Memory root choice, FS-persisted (survives browser cache clear). Single value —
// the root holds one dir per project, each with a memory/ subdir. Defaults to
// ~/.claude/projects.
const ROOT_FILE = join(STATE_DIR, 'memory-root.json');
export function getMemoryRoot() {
  try { const r = JSON.parse(readFileSync(ROOT_FILE, 'utf8')).root; return typeof r === 'string' && r ? r : '~/.claude/projects'; }
  catch { return '~/.claude/projects'; }
}
export function setMemoryRoot(root) {
  if (typeof root !== 'string' || !root) return { ok: false, error: 'bad root' };
  try { mkdirSync(STATE_DIR, { recursive: true }); writeFileSync(ROOT_FILE, JSON.stringify({ root })); return { ok: true, root }; }
  catch (e) { return { ok: false, error: e.message }; }
}

// Resolve a ~-prefixed client path to an absolute one. Falls back to the
// FS-persisted root (then the default) when raw is empty.
export function resolveRoot(raw) {
  let p = raw || getMemoryRoot();
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) p = normalize(homedir() + p.slice(1));
  try { return resolve(p); } catch { return DEFAULT_ROOT; }
}

// Search runs per keystroke (250ms debounce); cache file lines by mtime so only
// changed files are re-read from disk. stat-per-file is cheap; the read isn't.
const lineCache = new Map(); // path -> { mtimeMs, lines }
function readLines(p) {
  let mtimeMs;
  try { mtimeMs = statSync(p).mtimeMs; } catch { return null; }
  const hit = lineCache.get(p);
  if (hit && hit.mtimeMs === mtimeMs) return hit.lines;
  let lines;
  try { lines = readFileSync(p, 'utf8').split(/\r?\n/); } catch { return null; }
  lineCache.set(p, { mtimeMs, lines });
  return lines;
}

function memoryDirs(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => ({ project: d.name, dir: join(root, d.name, 'memory') }))
    .filter((x) => existsSync(x.dir));
}

// Path guard: must resolve to <root>/<project>/memory/<...>.md, no escape.
export function isMemoryPath(p, rootRaw) {
  if (!p) return false;
  const abs = resolve(p);
  const root = resolveRoot(rootRaw);
  if (abs !== root && !abs.startsWith(root + sep)) return false;
  const rel = abs.slice(root.length);
  const re = new RegExp(`^\\${sep}[^\\${sep}]+\\${sep}memory\\${sep}.+\\.md$`, 'i');
  return re.test(rel);
}

export function listFiles(rootRaw) {
  const out = [];
  for (const { project, dir } of memoryDirs(resolveRoot(rootRaw))) {
    for (const f of readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.md'))) {
      out.push({ project, file: f, path: join(dir, f) });
    }
  }
  return out;
}

export function searchMemory(q, rootRaw) {
  const ql = (q || '').toLowerCase();
  if (!ql) return { results: [], capped: false };
  const results = [];
  for (const { project, dir } of memoryDirs(resolveRoot(rootRaw))) {
    for (const f of readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.md'))) {
      const p = join(dir, f);
      const lines = readLines(p);
      if (!lines) continue;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(ql)) {
          results.push({ project, file: f, path: p, line: i + 1, text: lines[i].trim().slice(0, 200) });
          if (results.length >= RESULT_CAP) return { results, capped: true };
        }
      }
    }
  }
  return { results, capped: false };
}

export function readMemoryFile(p, rootRaw) {
  if (!isMemoryPath(p, rootRaw)) return { ok: false, error: 'path outside memory dirs' };
  if (!existsSync(p)) return { ok: false, error: 'not found' };
  try { return { ok: true, content: readFileSync(p, 'utf8') }; }
  catch (e) { return { ok: false, error: e.message }; }
}

export function writeMemoryFile(p, content, rootRaw) {
  if (!isMemoryPath(p, rootRaw)) return { ok: false, error: 'path outside memory dirs' };
  try { writeFileSync(p, content); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
}
