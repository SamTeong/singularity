// Skills viewer backend: list skills under a client-chosen root + read a skill's
// SKILL.md. Write-only side effect: the guarded writes (writeSkill/writeSkillFile
// + backup) stay Node. Two root layouts, auto-detected:
//   grouped — <root>/<scope>/.claude/skills/<skill>/SKILL.md (skill-scopes dir)
//   flat    — <root>/<skill>/SKILL.md                        (a .claude/skills dir)
// All paths server-derived from (root, scope, skill) + layout flag; the client
// never supplies a path. Roots persist on the daemon FS (survives cache clear).
// Reads and roots persistence run in Rust over the private stdio bridge:
// Node supplies root paths/defaults and keeps NAME_RE validation (its negative
// lookahead is unsupported by the Rust regex crate, so names are checked before dispatch and
// Rust trusts them), the localeCompare sort + caps (Rust emits readdir order —
// a Rust sort cannot match locale order byte for byte), and the guarded writes.
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { STATE_DIR } from './app-dir.mjs';
import { backupFile } from './backups.mjs';

const SKILLS_CAP = 200; // backstop per scope — no silent truncation
// Bare skill/scope names only — no path separators, no all-dots names ('.',
// '..', '...') which join()/resolve() would collapse into a parent traversal.
// Checked Node-side on every read/write; Rust trusts the checked names.
const NAME_RE = /^(?!\.+$)[A-Za-z0-9._-]+$/;

// Supporting files (scripts/, references/, agents/, assets/) listed as a
// subtree beneath each skill in the rail. Rust walks the skill dir FOLLOWING
// symlinked dirs (depth-bounded — a cycle re-lists reachable files, duplicates
// included) and ships the entry tree in readdir order; the flatten below
// re-sorts each directory (localeCompare) and applies FILES_CAP, matching the
// old Node walk byte for byte.
const FILES_CAP = 100;
const IMG_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico']);

// Skills root list, FS-persisted. Falls back to the old single-root file
// (migration) then `~/.claude/skills` (a flat skills dir) when unset.
const ROOTS_FILE = join(STATE_DIR, 'skills-roots.json');
const LEGACY_ROOTS_FILE = join(STATE_DIR, 'skills-root.json');
const DEFAULT_SKILLS_ROOT = join(homedir(), '.claude', 'skills');
export async function getSkillsRoots(b = backend) {
  return b.skillsRootsGet(ROOTS_FILE, LEGACY_ROOTS_FILE, DEFAULT_SKILLS_ROOT);
}
export async function setSkillsRoots(roots, b = backend) {
  return b.skillsRootsSet(ROOTS_FILE, LEGACY_ROOTS_FILE, DEFAULT_SKILLS_ROOT, roots);
}

export function createSkillsRootsGetHandler(backend_) {
  return async () => ({ roots: await getSkillsRoots(backend_) });
}

export function createSkillsRootsSetHandler(backend_) {
  return async (req) => setSkillsRoots(req.body?.roots, backend_);
}

// Bridge wiring: index.mjs injects the shared backend instance (it owns the
// child); tests inject their own. Route handlers take theirs as a parameter.
let backend = null;
export function setSkillsBackend(b) { backend = b; }

// Per-directory sort (Rust ships readdir order) + DFS flatten with the
// FILES_CAP backstop. Rel paths POSIX-normalized both separators.
function flattenEntries(entries, prefix, out) {
  for (const e of [...entries].sort((a, b) => a.n.localeCompare(b.n))) {
    if (out.length >= FILES_CAP) return;
    const rel = prefix ? `${prefix}/${e.n}` : e.n;
    if (e.f) out.push(rel.split(/[\\/]/).join('/'));
    else flattenEntries(e.c || [], rel, out);
  }
}

// SKILL.md is skipped at the top level only — a nested references/SKILL.md IS
// listed. Returns an array of relative POSIX paths (empty if unreadable).
function skillFiles(tree) {
  const out = [];
  for (const e of [...(tree || [])].sort((a, b) => a.n.localeCompare(b.n))) {
    if (out.length >= FILES_CAP) break;
    if (e.n === 'SKILL.md') continue;
    if (e.f) out.push(e.n.split(/[\\/]/).join('/'));
    else flattenEntries(e.c || [], e.n, out);
  }
  return out;
}

// List skills under `root`, auto-detecting layout (grouped wins if both).
// `root` is a full path (the client untildifies); falls back to the persisted
// root when omitted. Rust does layout detection + SKILL.md reads + the walk;
// Node sorts scopes/skills and applies SKILLS_CAP (the old walk broke at
// exactly SKILLS_CAP after a push, so the flag is set at >= cap).
async function listSkillsOn(b, root) {
  root = root || ((await getSkillsRoots(b))[0] || '');
  if (!root) return { scopes: [], flat: false, error: 'skills root not configured' };
  const payload = await b.skillsList(root);
  if (payload.error) return { scopes: [], flat: false, error: payload.error };
  const scopes = (payload.scopes || []).sort((a, c) => a.name.localeCompare(c.name));
  for (const scope of scopes) {
    const sorted = [...scope.skills].sort((a, c) => a.name.localeCompare(c.name));
    // ponytail: ship full raw (frontmatter + body) per skill so the client
    // filter can match anywhere in SKILL.md. Payload grows with skill count ×
    // SKILL.md size; if that bites, move search server-side with a query param.
    scope.capped = sorted.length >= SKILLS_CAP;
    scope.skills = sorted.slice(0, SKILLS_CAP).map((s) => ({
      name: s.name, description: s.description, raw: s.raw, files: skillFiles(s.tree),
    }));
  }
  return { scopes, flat: payload.flat === true };
}

export async function listSkills(root) { return listSkillsOn(backend, root); }

// Read a `.claude/skills`-style dir (subfolder-per-skill, each with SKILL.md).
// Returns { skills, capped } or null when the dir is missing/unreadable
// (callers treat that as "no skills here").
export async function readSkillsDir(dir) {
  const r = await listSkillsOn(backend, dir);
  const scope = r.scopes?.[0];
  return scope ? { skills: scope.skills, capped: !!scope.capped } : null;
}

// Read a skill's SKILL.md. Path fully server-derived from validated bare names +
// the client-chosen root; `flat` selects the layout: flat → <root>/<skill>, else
// grouped → <root>/<scope>/.claude/skills/<skill>.
async function readSkillOn(b, root, scope, skill, flat) {
  root = root || ((await getSkillsRoots(b))[0] || '');
  if (!root) return { ok: false, error: 'skills root not configured' };
  if (typeof skill !== 'string' || !NAME_RE.test(skill)) return { ok: false, error: 'bad name' };
  if (!flat && (typeof scope !== 'string' || !NAME_RE.test(scope))) return { ok: false, error: 'bad name' };
  return b.skillRead(root, scope, skill, flat === true);
}
export async function readSkill(root, scope, skill, flat) { return readSkillOn(backend, root, scope, skill, flat); }

// Read a supporting file inside a skill dir. `file` is a relative POSIX path
// (from the listing); each segment must pass NAME_RE so `..`/separators can't
// traverse above the skill dir. `type` tells the client how to render:
// 'markdown' (MarkdownBody), 'code' (raw <pre>), 'image' (preview note — binary
// not shipped over JSON).
async function readSkillFileOn(b, root, scope, skill, file, flat) {
  root = root || ((await getSkillsRoots(b))[0] || '');
  if (!root) return { ok: false, error: 'skills root not configured' };
  if (typeof skill !== 'string' || !NAME_RE.test(skill)) return { ok: false, error: 'bad name' };
  if (!flat && (typeof scope !== 'string' || !NAME_RE.test(scope))) return { ok: false, error: 'bad name' };
  if (typeof file !== 'string' || !file) return { ok: false, error: 'bad file' };
  const segs = file.split('/');
  if (segs.some((s) => !s || !NAME_RE.test(s))) return { ok: false, error: 'bad file' };
  return b.skillFileRead(root, scope, skill, file, flat === true);
}
export async function readSkillFile(root, scope, skill, file, flat) {
  return readSkillFileOn(backend, root, scope, skill, file, flat);
}

async function writeSkillContent(b, p, content, mtime, force, logger) {
  try {
    if (mtime != null && !force && existsSync(p) && Math.abs(statSync(p).mtimeMs - mtime) > 1) {
      return { ok: false, error: 'changed on disk' };
    }
    await backupFile(p);
    // Re-check after the backup await, then Rust checks again when this queued
    // request reaches the child so the final guard is adjacent to the write.
    if (mtime != null && !force && existsSync(p) && Math.abs(statSync(p).mtimeMs - mtime) > 1) {
      return { ok: false, error: 'changed on disk' };
    }
    try { return await b.skillWrite(p, content, mtime, force); }
    catch (error) {
      logger?.error({ err: error.message }, 'Rust Skills write backend failed');
      return { ok: false, error: 'skills write backend unavailable' };
    }
  }
  catch (e) { return { ok: false, error: e.message }; }
}

// Write a skill's SKILL.md (raw content, frontmatter preserved as edited).
async function writeSkillOn(b, root, scope, skill, content, flat, mtime, force, logger) {
  root = root || ((await getSkillsRoots(b))[0] || '');
  if (!root) return { ok: false, error: 'skills root not configured' };
  if (typeof skill !== 'string' || !NAME_RE.test(skill)) return { ok: false, error: 'bad name' };
  if (!flat && (typeof scope !== 'string' || !NAME_RE.test(scope))) return { ok: false, error: 'bad name' };
  if (typeof content !== 'string') return { ok: false, error: 'bad content' };
  const p = flat ? join(root, skill, 'SKILL.md') : join(root, scope, '.claude', 'skills', skill, 'SKILL.md');
  return writeSkillContent(b, p, content, mtime, force, logger);
}
export async function writeSkill(root, scope, skill, content, flat, mtime, force) {
  return writeSkillOn(backend, root, scope, skill, content, flat, mtime, force);
}

// Write a supporting file inside a skill dir. Same validation as readSkillFile;
// image type is not writable (binary). Server-derived path, segment-validated.
async function writeSkillFileOn(b, root, scope, skill, file, content, flat, mtime, force, logger) {
  root = root || ((await getSkillsRoots(b))[0] || '');
  if (!root) return { ok: false, error: 'skills root not configured' };
  if (typeof skill !== 'string' || !NAME_RE.test(skill)) return { ok: false, error: 'bad name' };
  if (!flat && (typeof scope !== 'string' || !NAME_RE.test(scope))) return { ok: false, error: 'bad name' };
  if (typeof file !== 'string' || !file) return { ok: false, error: 'bad file' };
  if (typeof content !== 'string') return { ok: false, error: 'bad content' };
  const segs = file.split('/');
  if (segs.some((s) => !s || !NAME_RE.test(s))) return { ok: false, error: 'bad file' };
  const p = flat ? join(root, skill, ...segs) : join(root, scope, '.claude', 'skills', skill, ...segs);
  const ext = p.slice(p.lastIndexOf('.') + 1).toLowerCase();
  if (IMG_EXT.has(ext)) return { ok: false, error: 'cannot edit image' };
  return writeSkillContent(b, p, content, mtime, force, logger);
}
export async function writeSkillFile(root, scope, skill, file, content, flat, mtime, force) {
  return writeSkillFileOn(backend, root, scope, skill, file, content, flat, mtime, force);
}

export function createSkillWriteHandler(backend_, logger) {
  return async (req, reply) => {
    const b = req.body || {};
    const flat = b.flat === true || b.flat === '1';
    const result = b.file
      ? await writeSkillFileOn(backend_, b.root, b.scope, b.skill, b.file, b.content, flat, b.mtime, b.force, logger)
      : await writeSkillOn(backend_, b.root, b.scope, b.skill, b.content, flat, b.mtime, b.force, logger);
    if (!result.ok) reply.code(result.error === 'skills write backend unavailable' ? 500 : result.error === 'changed on disk' ? 409 : 400);
    return result;
  };
}

// The Rust-backed read routes have no other 500 path — a bridge crash is the
// only one (rule-handler shape). GET /skills payloads carry in-body `error`
// strings (always 200); GET /skill maps `not found` to 404, else 400.
export function createSkillsListHandler(backend_, logger) {
  return async (req, reply) => {
    try { return await listSkillsOn(backend_, req.query.root); }
    catch (error) {
      logger.error({ err: error.message }, 'Rust Skills list backend failed');
      reply.code(500);
      return { error: 'skills list backend unavailable' };
    }
  };
}

export function createSkillReadHandler(backend_, logger) {
  return async (req, reply) => {
    const flat = req.query.flat === '1';
    try {
      if (req.query.file) {
        const r = await readSkillFileOn(backend_, req.query.root, req.query.scope, req.query.skill, req.query.file, flat);
        if (!r.ok) reply.code(r.error === 'not found' ? 404 : 400);
        return r;
      }
      const r = await readSkillOn(backend_, req.query.root, req.query.scope, req.query.skill, flat);
      if (!r.ok) reply.code(r.error === 'not found' ? 404 : 400);
      return r;
    }
    catch (error) {
      logger.error({ err: error.message }, 'Rust Skills read backend failed');
      reply.code(500);
      return { ok: false, error: 'skills read backend unavailable' };
    }
  };
}
