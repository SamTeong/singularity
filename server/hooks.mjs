// Hooks editor backend: list + read + write hook script files under a root's
// .claude/hooks/ directory (raw file content, not settings.json). Client-supplied
// paths are guarded to contain a .claude/hooks/ segment so this can't read/write
// arbitrary files. Roots are an independent FS-persisted list under STATE_DIR.
import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, sep } from 'node:path';
import { STATE_DIR } from './app-dir.mjs';

// A client path must live under a `.claude/hooks/` segment. Normalize `/`→sep
// (browser may send forward slashes) before testing.
const HOOKS_SEG = `${sep}.claude${sep}hooks${sep}`;
function guard(path) {
  return typeof path === 'string' && path.replace(/\//g, sep).includes(HOOKS_SEG);
}

// Bounded recursive walk of <cwd>/.claude/hooks — files only, sorted by rel.
// Missing dir → []. Cap protects the daemon from a pathological tree.
export function listHooks(cwd, cap = 2000) {
  const dir = join(cwd, '.claude', 'hooks');
  if (!existsSync(dir)) return [];
  const out = [];
  const stack = [dir];
  while (stack.length && out.length < cap) {
    const d = stack.pop();
    let ents;
    try { ents = readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const p = join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) out.push({ path: p, rel: p.slice(dir.length + 1), name: e.name });
    }
  }
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

// Search hook file content across roots. First matching line per file →
// { cwd, path, rel, line, text } (trimmed snippet). Dedup by path, sorted by path.
export function searchHooks(roots, q) {
  const needle = String(q || '').toLowerCase();
  if (!needle) return [];
  const seen = new Set();
  const results = [];
  for (const cwd of roots || []) {
    for (const { path, rel } of listHooks(cwd)) {
      if (seen.has(path)) continue;
      seen.add(path);
      let content;
      try { content = readFileSync(path, 'utf8'); } catch { continue; }
      const lines = content.split('\n');
      const i = lines.findIndex((l) => l.toLowerCase().includes(needle));
      if (i < 0) continue;
      results.push({ cwd, path, rel, line: i + 1, text: lines[i].trim().slice(0, 200) });
    }
  }
  return results.sort((a, b) => a.path.localeCompare(b.path));
}

export function readHook(path) {
  if (!guard(path)) return { path, exists: false, error: 'bad path' };
  const exists = existsSync(path);
  return { path, exists, content: exists ? readFileSync(path, 'utf8') : '' };
}

// Write raw content back with a .bak backup (mirror writeConfig). No JSON
// validation — hook files are scripts, not JSON.
export function writeHook(path, content) {
  if (!guard(path)) return { ok: false, error: 'bad path' };
  try {
    if (existsSync(path)) copyFileSync(path, `${path}.bak`);
    writeFileSync(path, content);
    return { ok: true, backup: existsSync(`${path}.bak`), path };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Hook root list: FS-persisted under STATE_DIR, seeded with '~', capped 50.
const ROOTS_FILE = join(STATE_DIR, 'hook-roots.json');
export function getHookRoots() {
  try {
    const r = JSON.parse(readFileSync(ROOTS_FILE, 'utf8'));
    return Array.isArray(r) && r.length ? r : ['~'];
  } catch { return ['~']; }
}
export function setHookRoots(roots) {
  const clean = [...new Set((roots || []).filter((r) => typeof r === 'string' && r))].slice(0, 50);
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(ROOTS_FILE, JSON.stringify(clean, null, 2));
    return { ok: true, roots: clean };
  } catch (e) { return { ok: false, error: e.message }; }
}
