// Skills viewer backend: list skill scopes + their skills, read a skill's
// SKILL.md. Read-only — no write (skills are versioned, symlinked into
// ~/.agents/skills). All paths server-derived from (scope, skill); the client
// never supplies a path.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import * as reg from './agents.mjs';

const SKILLS_CAP = 200; // backstop per scope — no silent truncation
// Bare skill/scope names only — no path separators, no '..', no empties.
const NAME_RE = /^[A-Za-z0-9._-]+$/;

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

// List scopes (exclude 'common', matching /skill-scopes) with nested skills.
export function listSkills() {
  const root = reg.SCOPE_ROOT;
  if (!root || !existsSync(root)) return { scopes: [], error: root ? 'scope root not found' : 'scope root not configured' };
  let scopes;
  try {
    scopes = readdirSync(root, { withFileTypes: true })
      .filter((d) => { try { return d.isDirectory() && d.name !== 'common'; } catch { return false; } })
      .map((d) => d.name)
      .sort((a, b) => a.localeCompare(b));
  } catch { return { scopes: [], error: 'scope root unreadable' }; }

  const out = [];
  for (const scope of scopes) {
    const skillsDir = join(root, scope, '.claude', 'skills');
    let skillNames;
    try { skillNames = readdirSync(skillsDir, { withFileTypes: true }).filter((d) => d.isDirectory() || d.isSymbolicLink()).map((d) => d.name); }
    catch { continue; } // scope without a skills dir — skip silently
    let capped = false;
    const skills = [];
    for (const name of skillNames.sort((a, b) => a.localeCompare(b))) {
      const md = join(skillsDir, name, 'SKILL.md');
      if (!existsSync(md)) continue;
      let description = '';
      try { description = parseSkill(readFileSync(md, 'utf8')).description; } catch {}
      skills.push({ name, description });
      if (skills.length >= SKILLS_CAP) { capped = true; break; }
    }
    if (skills.length) out.push({ name: scope, skills, capped });
  }
  return { scopes: out };
}

// Read a skill's SKILL.md. Path fully server-derived; scope+skill are bare
// names. Returns structured meta (name/description/triggers) + body so the
// client renders without re-parsing block YAML lists.
export function readSkill(scope, skill) {
  if (!reg.SCOPE_ROOT) return { ok: false, error: 'scope root not configured' };
  if (typeof scope !== 'string' || !NAME_RE.test(scope) || typeof skill !== 'string' || !NAME_RE.test(skill)) {
    return { ok: false, error: 'bad name' };
  }
  const p = join(reg.SCOPE_ROOT, scope, '.claude', 'skills', skill, 'SKILL.md');
  if (!existsSync(p)) return { ok: false, error: 'not found' };
  try {
    const parsed = parseSkill(readFileSync(p, 'utf8'));
    return { ok: true, path: p, name: parsed.name, description: parsed.description, triggers: parsed.triggers, body: parsed.body };
  } catch (e) { return { ok: false, error: e.message }; }
}