// Memory backend: search + guarded read/write across per-project memory dirs
// (~/.claude/projects/<encoded-cwd>/memory/*.md). Writes are confined to those
// dirs — a path outside any project's memory/ is rejected.
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';

const PROJECTS = join(homedir(), '.claude', 'projects');
const RESULT_CAP = 300;

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

function memoryDirs() {
  if (!existsSync(PROJECTS)) return [];
  return readdirSync(PROJECTS, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => ({ project: d.name, dir: join(PROJECTS, d.name, 'memory') }))
    .filter((x) => existsSync(x.dir));
}

// Path guard: must resolve to <PROJECTS>/<project>/memory/<...>.md, no escape.
export function isMemoryPath(p) {
  if (!p) return false;
  const abs = resolve(p);
  const root = resolve(PROJECTS);
  if (abs !== root && !abs.startsWith(root + sep)) return false;
  const rel = abs.slice(root.length);
  const re = new RegExp(`^\\${sep}[^\\${sep}]+\\${sep}memory\\${sep}.+\\.md$`, 'i');
  return re.test(rel);
}

export function listFiles() {
  const out = [];
  for (const { project, dir } of memoryDirs()) {
    for (const f of readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.md'))) {
      out.push({ project, file: f, path: join(dir, f) });
    }
  }
  return out;
}

export function searchMemory(q) {
  const ql = (q || '').toLowerCase();
  if (!ql) return { results: [], capped: false };
  const results = [];
  for (const { project, dir } of memoryDirs()) {
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

export function readMemoryFile(p) {
  if (!isMemoryPath(p)) return { ok: false, error: 'path outside memory dirs' };
  if (!existsSync(p)) return { ok: false, error: 'not found' };
  try { return { ok: true, content: readFileSync(p, 'utf8') }; }
  catch (e) { return { ok: false, error: e.message }; }
}

export function writeMemoryFile(p, content) {
  if (!isMemoryPath(p)) return { ok: false, error: 'path outside memory dirs' };
  try { writeFileSync(p, content); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
}
