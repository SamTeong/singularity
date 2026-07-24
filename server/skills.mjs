// Skills viewer backend: list skills under a client-chosen root + read a skill's
// SKILL.md. Read-only — no write. Two root layouts, auto-detected:
//   grouped — <root>/<scope>/.claude/skills/<skill>/SKILL.md (skill-scopes dir)
//   flat    — <root>/<skill>/SKILL.md                        (a .claude/skills dir)
// All paths server-derived from (root, scope, skill) + layout flag; the client
// never supplies a path. Roots persist on the daemon FS (survives cache clear).
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import { STATE_DIR } from './app-dir.mjs';

const SKILLS_CAP = 200; // backstop per scope — no silent truncation
// Bare skill/scope names only — no path separators, no all-dots names ('.',
// '..', '...') which join()/resolve() would collapse into a parent traversal.
const NAME_RE = /^(?!\.+$)[A-Za-z0-9._-]+$/;

// Supporting files (scripts/, references/, agents/, assets/) listed as a
// subtree beneath each skill in the rail. Recursively walked, relative paths
// (POSIX '/') returned flat — the client indents by depth. Bound to avoid
// runaway trees on weird skills.
const FILES_CAP = 100;
const FILE_DEPTH = 6;
const MD_EXT = new Set(['md', 'markdown']);
const IMG_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico']);

// Skills root list, FS-persisted. Falls back to the old single-root file
// (migration) then `~/.claude/skills` (a flat skills dir) when unset.
const ROOTS_FILE = join(STATE_DIR, 'skills-roots.json');
export function getSkillsRoots() {
  try {
    const r = JSON.parse(readFileSync(ROOTS_FILE, 'utf8')).roots;
    if (Array.isArray(r) && r.length && r.every((x) => typeof x === 'string')) return r;
  } catch {}
  try {
    const r = JSON.parse(readFileSync(join(STATE_DIR, 'skills-root.json'), 'utf8')).root;
    if (typeof r === 'string' && r) return [r];
  } catch {}
  return [join(homedir(), '.claude', 'skills')];
}
export function setSkillsRoots(roots) {
  if (!Array.isArray(roots)) return { ok: false, error: 'bad roots' };
  const clean = [...new Set(roots.filter((r) => typeof r === 'string' && r))].slice(0, 50);
  try { mkdirSync(STATE_DIR, { recursive: true }); writeFileSync(ROOTS_FILE, JSON.stringify({ roots: clean })); return { ok: true, roots: clean }; }
  catch (e) { return { ok: false, error: e.message }; }
}

// Parse a SKILL.md's leading YAML frontmatter (---\n...\n---) into structured
// meta + body. Skill frontmatter uses block YAML lists for `triggers`:
//   triggers:
//     - some trigger
//     - another
// which the generic inline-array parser can't handle, so this walks indented
// `- ` lines under a `key:` with an empty value. Returns { name, description, triggers, body }.
function parseSkill(src) {
  const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { name: '', description: '', triggers: [], body: src };
  const lines = m[1].split(/\r?\n/);
  const out = { name: '', description: '', triggers: [] };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const j = line.indexOf(':');
    if (j < 0) continue;
    const k = line.slice(0, j).trim();
    const v = line.slice(j + 1).trim();
    if (k === 'name') out.name = v;
    else if (k === 'description') out.description = v;
    else if (k === 'triggers' && !v) {
      // collect following indented `- ` lines
      while (i + 1 < lines.length && /^\s+-\s/.test(lines[i + 1])) {
        i++;
        out.triggers.push(lines[i].replace(/^\s+-\s/, '').trim());
      }
    }
  }
  return { ...out, body: src.slice(m[0].length) };
}

// Read a `.claude/skills`-style dir (subfolder-per-skill, each with SKILL.md).
// Returns { skills, capped }.
export function readSkillsDir(dir) {
  let names;
  try { names = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() || d.isSymbolicLink()).map((d) => d.name); }
  catch { return null; } // not a readable dir
  let capped = false;
  const skills = [];
  for (const name of names.sort((a, b) => a.localeCompare(b))) {
    const md = join(dir, name, 'SKILL.md');
    if (!existsSync(md)) continue;
    let description = '';
    try { description = parseSkill(readFileSync(md, 'utf8')).description; } catch {}
    skills.push({ name, description, files: listSkillFiles(join(dir, name)) });
    if (skills.length >= SKILLS_CAP) { capped = true; break; }
  }
  return { skills, capped };
}

// Supporting files inside a skill dir, relative POSIX paths, sorted. SKILL.md
// excluded. Symlink dirs bounded by FILE_DEPTH so a cycle can't exhaust the
// walk. Returns an array of strings (empty if unreadable).
function listSkillFiles(dir) {
  const out = [];
  const walk = (d, depth) => {
    if (depth > FILE_DEPTH || out.length >= FILES_CAP) return;
    let ents;
    try { ents = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents.sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length >= FILES_CAP) return;
      if (e.name === 'SKILL.md' && depth === 0) continue;
      if (e.isDirectory() || e.isSymbolicLink()) { walk(join(d, e.name), depth + 1); continue; }
      if (!e.isFile()) continue;
      out.push(join(d, e.name).slice(dir.length + 1).split(/[\\/]/).join('/'));
    }
  };
  walk(dir, 0);
  return out;
}

// List skills under `root`, auto-detecting layout. `root` is a full path (the
// client untildifies); falls back to the persisted/scope root when omitted.
// Grouped: each subdir with a .claude/skills becomes a scope. Flat: the root
// itself is a skills dir → one scope (basename of root). Grouped wins if both.
export function listSkills(root) {
  root = root || (getSkillsRoots()[0] || '');
  if (!root) return { scopes: [], flat: false, error: 'skills root not configured' };
  if (!existsSync(root)) return { scopes: [], flat: false, error: 'skills root not found' };

  let subdirs;
  try {
    subdirs = readdirSync(root, { withFileTypes: true })
      .filter((d) => { try { return (d.isDirectory() || d.isSymbolicLink()) && d.name !== 'common'; } catch { return false; } })
      .map((d) => d.name)
      .sort((a, b) => a.localeCompare(b));
  } catch { return { scopes: [], flat: false, error: 'skills root unreadable' }; }

  // Grouped: collect scopes that hold a .claude/skills with ≥1 skill.
  const grouped = [];
  for (const scope of subdirs) {
    const r = readSkillsDir(join(root, scope, '.claude', 'skills'));
    if (r && r.skills.length) grouped.push({ name: scope, skills: r.skills, capped: r.capped });
  }
  if (grouped.length) return { scopes: grouped, flat: false };

  // Flat: the root itself is a skills dir.
  const r = readSkillsDir(root);
  if (r && r.skills.length) return { scopes: [{ name: basename(root) || root, skills: r.skills, capped: r.capped }], flat: true };

  return { scopes: [], flat: false };
}

// Read a skill's SKILL.md. Path fully server-derived from validated bare names +
// the client-chosen root. `flat` selects the layout: flat → <root>/<skill>, else
// grouped → <root>/<scope>/.claude/skills/<skill>.
export function readSkill(root, scope, skill, flat) {
  root = root || (getSkillsRoots()[0] || '');
  if (!root) return { ok: false, error: 'skills root not configured' };
  if (typeof skill !== 'string' || !NAME_RE.test(skill)) return { ok: false, error: 'bad name' };
  if (!flat && (typeof scope !== 'string' || !NAME_RE.test(scope))) return { ok: false, error: 'bad name' };
  const p = flat
    ? join(root, skill, 'SKILL.md')
    : join(root, scope, '.claude', 'skills', skill, 'SKILL.md');
  if (!existsSync(p)) return { ok: false, error: 'not found' };
  try {
    const src = readFileSync(p, 'utf8');
    const parsed = parseSkill(src);
    return { ok: true, path: p, name: parsed.name, description: parsed.description, triggers: parsed.triggers, body: parsed.body, raw: src };
  } catch (e) { return { ok: false, error: e.message }; }
}

// Resolve a skill's base dir (the dir containing SKILL.md) — reused by
// readSkillFile. Server-derived from validated bare names, same rules as readSkill.
function skillBaseDir(root, scope, skill, flat) {
  return flat ? join(root, skill) : join(root, scope, '.claude', 'skills', skill);
}

// Write a skill's SKILL.md (raw content, frontmatter preserved as edited).
export function writeSkill(root, scope, skill, content, flat) {
  root = root || (getSkillsRoots()[0] || '');
  if (!root) return { ok: false, error: 'skills root not configured' };
  if (typeof skill !== 'string' || !NAME_RE.test(skill)) return { ok: false, error: 'bad name' };
  if (!flat && (typeof scope !== 'string' || !NAME_RE.test(scope))) return { ok: false, error: 'bad name' };
  if (typeof content !== 'string') return { ok: false, error: 'bad content' };
  const p = flat ? join(root, skill, 'SKILL.md') : join(root, scope, '.claude', 'skills', skill, 'SKILL.md');
  try { writeFileSync(p, content); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
}

// Read a supporting file inside a skill dir. `file` is a relative POSIX path
// (from listSkillFiles); each segment must pass NAME_RE so `..`/separators can't
// traverse above the skill dir. `type` tells the client how to render:
// 'markdown' (MarkdownBody), 'code' (raw <pre>), 'image' (preview note — binary
// not shipped over JSON). ponytail: image rendering deferred, add <img> when needed.
const EXT_TYPE = (ext) => (MD_EXT.has(ext) ? 'markdown' : IMG_EXT.has(ext) ? 'image' : 'code');

export function readSkillFile(root, scope, skill, file, flat) {
  root = root || (getSkillsRoots()[0] || '');
  if (!root) return { ok: false, error: 'skills root not configured' };
  if (typeof skill !== 'string' || !NAME_RE.test(skill)) return { ok: false, error: 'bad name' };
  if (!flat && (typeof scope !== 'string' || !NAME_RE.test(scope))) return { ok: false, error: 'bad name' };
  if (typeof file !== 'string' || !file) return { ok: false, error: 'bad file' };
  const segs = file.split('/');
  if (segs.some((s) => !s || !NAME_RE.test(s))) return { ok: false, error: 'bad file' };
  const p = join(skillBaseDir(root, scope, skill, flat), ...segs);
  if (!existsSync(p)) return { ok: false, error: 'not found' };
  const ext = p.slice(p.lastIndexOf('.') + 1).toLowerCase();
  const type = EXT_TYPE(ext);
  if (type === 'image') return { ok: true, type, name: basename(p), path: p };
  try { return { ok: true, type, name: basename(p), path: p, content: readFileSync(p, 'utf8') }; }
  catch (e) { return { ok: false, error: e.message }; }
}

// Write a supporting file inside a skill dir. Same validation as readSkillFile;
// image type is not writable (binary). Server-derived path, segment-validated.
export function writeSkillFile(root, scope, skill, file, content, flat) {
  root = root || (getSkillsRoots()[0] || '');
  if (!root) return { ok: false, error: 'skills root not configured' };
  if (typeof skill !== 'string' || !NAME_RE.test(skill)) return { ok: false, error: 'bad name' };
  if (!flat && (typeof scope !== 'string' || !NAME_RE.test(scope))) return { ok: false, error: 'bad name' };
  if (typeof file !== 'string' || !file) return { ok: false, error: 'bad file' };
  if (typeof content !== 'string') return { ok: false, error: 'bad content' };
  const segs = file.split('/');
  if (segs.some((s) => !s || !NAME_RE.test(s))) return { ok: false, error: 'bad file' };
  const p = join(skillBaseDir(root, scope, skill, flat), ...segs);
  const ext = p.slice(p.lastIndexOf('.') + 1).toLowerCase();
  if (IMG_EXT.has(ext)) return { ok: false, error: 'cannot edit image' };
  try { writeFileSync(p, content); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
}
