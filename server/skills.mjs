// Skills viewer backend: list skills under a client-chosen root + read a skill's
// SKILL.md. Read-only — no write. Two root layouts, auto-detected:
//   grouped — <root>/<scope>/.claude/skills/<skill>/SKILL.md (skill-scopes dir)
//   flat    — <root>/<skill>/SKILL.md                        (a .claude/skills dir)
// All paths server-derived from (root, scope, skill) + layout flag; the client
// never supplies a path. Root persists on the daemon FS (survives cache clear).
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { STATE_DIR } from './app-dir.mjs';
import * as reg from './agents.mjs';

const SKILLS_CAP = 200; // backstop per scope — no silent truncation
// Bare skill/scope names only — no path separators, no all-dots names ('.',
// '..', '...') which join()/resolve() would collapse into a parent traversal.
const NAME_RE = /^(?!\.+$)[A-Za-z0-9._-]+$/;

// Skills root choice, FS-persisted. Defaults to SING_SCOPE_ROOT (the grouped
// skill-scopes dir) when unset.
const ROOT_FILE = join(STATE_DIR, 'skills-root.json');
export function getSkillsRoot() {
  try { const r = JSON.parse(readFileSync(ROOT_FILE, 'utf8')).root; if (typeof r === 'string' && r) return r; }
  catch {}
  return reg.SCOPE_ROOT || '';
}
export function setSkillsRoot(root) {
  if (typeof root !== 'string' || !root) return { ok: false, error: 'bad root' };
  try { mkdirSync(STATE_DIR, { recursive: true }); writeFileSync(ROOT_FILE, JSON.stringify({ root })); return { ok: true, root }; }
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
function readSkillsDir(dir) {
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
    skills.push({ name, description });
    if (skills.length >= SKILLS_CAP) { capped = true; break; }
  }
  return { skills, capped };
}

// List skills under `root`, auto-detecting layout. `root` is a full path (the
// client untildifies); falls back to the persisted/scope root when omitted.
// Grouped: each subdir with a .claude/skills becomes a scope. Flat: the root
// itself is a skills dir → one scope (basename of root). Grouped wins if both.
export function listSkills(root) {
  root = root || getSkillsRoot();
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
  root = root || getSkillsRoot();
  if (!root) return { ok: false, error: 'skills root not configured' };
  if (typeof skill !== 'string' || !NAME_RE.test(skill)) return { ok: false, error: 'bad name' };
  if (!flat && (typeof scope !== 'string' || !NAME_RE.test(scope))) return { ok: false, error: 'bad name' };
  const p = flat
    ? join(root, skill, 'SKILL.md')
    : join(root, scope, '.claude', 'skills', skill, 'SKILL.md');
  if (!existsSync(p)) return { ok: false, error: 'not found' };
  try {
    const parsed = parseSkill(readFileSync(p, 'utf8'));
    return { ok: true, path: p, name: parsed.name, description: parsed.description, triggers: parsed.triggers, body: parsed.body };
  } catch (e) { return { ok: false, error: e.message }; }
}
