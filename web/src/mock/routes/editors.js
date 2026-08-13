// Editor routes: the six file-editing panels — Config (claude settings.json),
// Codex config.toml, Hooks, Rules, Memory, Skills. These mirror server/index.mjs
// exactly (design.md D8): bare keyed objects with no `ok` for /config and
// /codex-config GETs, `{ path, exists, content, mtime }` with no `ok` for
// GET /hooks/file, error keys inside a 200 where the daemon reports failure that
// way, and real 409s on stale-mtime writes. The mock's filesystem is db.files
// (flat `path -> { content, mtime }`), so every read/write resolves a path and
// hits that map; the mtime guard is shared via helpers.guardedWrite.
import { Response } from 'miragejs';
import { db } from '../db.js';
import { FAKE_HOME } from '../fixtures.js';
import { rootsRoutes, guardedWrite, conflict, parseBody } from '../helpers.js';

// ---------------------------------------------------------------- path utils

const join = (...parts) => parts.join('/').replace(/\/+/g, '/');

// Expand a ~-prefixed path to FAKE_HOME (mirrors web/src/lib/paths.js untildify).
function untildify(p) {
  if (!p) return p;
  if (p === '~') return FAKE_HOME;
  if (p[0] === '~' && (p[1] === '/' || p[1] === '\\')) return FAKE_HOME + p.slice(1);
  return p;
}

// Read a db.files entry as the daemon's `{ path, exists, content, mtime }` shape
// (content '' and mtime 0 when absent — the daemon's readConfig/readHook shape).
function fileEntry(path) {
  const f = db.files[path];
  return { path, exists: !!f, content: f ? f.content : '', mtime: f ? f.mtime : 0 };
}

// Is `path` under `<root>/<sub>` (or equal to it)? Both untildified — the mock's
// paths are already absolute, so a prefix check stands in for the daemon's
// resolve-then-containment guard.
function underRoot(path, root, sub) {
  const base = join(untildify(root), sub);
  return path === base || path.startsWith(base + '/');
}

// First line of `content` containing `q` (case-insensitive) → { line, text } with
// a trimmed 200-char snippet, or null (mirrors the daemon's search helpers).
function firstHit(content, q) {
  const needle = String(q || '').toLowerCase();
  if (!needle) return null;
  const lines = String(content || '').split('\n');
  const i = lines.findIndex((l) => l.toLowerCase().includes(needle));
  if (i < 0) return null;
  return { line: i + 1, text: lines[i].trim().slice(0, 200) };
}

// A guarded write that augments the success shape with `backup` + `path` — the
// config/codex/hooks write result. The daemon backs up an existing file and
// returns null for a first write; the mock fakes the backup path (no real FS).
function guardedWriteWithBackup(path, content, mtime, force) {
  const existing = db.files[path];
  const r = guardedWrite(path, content, mtime, force);
  if (!r.ok) return r;
  return { ok: true, backup: existing ? path + '.bak' : null, path, mtime: r.mtime };
}

// A write-failure Response: 409 for a stale-mtime conflict, 400 otherwise
// (mirrors the daemon's `reply.code(r.error === 'changed on disk' ? 409 : 400)`).
function writeError(r) {
  return r.error === 'changed on disk' ? conflict(r) : new Response(400, {}, r);
}

// ------------------------------------------------------------- config (claude)

// Claude settings.json scopes for a cwd (mirrors server/config.mjs scopePaths).
// Only project + local are editable; user settings.json is shared/versioned.
function configPaths(cwd) {
  const c = untildify(cwd);
  return {
    project: join(c, '.claude', 'settings.json'),
    local: join(c, '.claude', 'settings.local.json'),
  };
}

function readConfig(cwd) {
  const paths = configPaths(cwd);
  return { project: fileEntry(paths.project), local: fileEntry(paths.local) };
}

// The daemon's writeConfig rejects a cwd outside the pinned roots
// (server/config.mjs isKnownConfigRoot). Mirror it so a write to an unpicked
// root fails the same way instead of silently creating a file.
function isKnownRoot(cwd, roots) {
  const abs = untildify(cwd);
  if (!abs) return false;
  return (roots || []).some((raw) => {
    const root = untildify(raw);
    return root && (abs === root || abs.startsWith(root + '/'));
  });
}

function writeConfig(cwd, scope, content, mtime, force) {
  if (scope !== 'project' && scope !== 'local') return { ok: false, error: 'bad scope' };
  if (!isKnownRoot(cwd, db.roots.config)) return { ok: false, error: 'cwd outside config roots' };
  const p = configPaths(cwd)[scope];
  try { JSON.parse(content); } catch (e) { return { ok: false, error: `invalid JSON: ${e.message}` }; }
  return guardedWriteWithBackup(p, content, mtime, force);
}

// Search settings.json/settings.local.json content across roots (mirrors
// searchConfig): first matching line per file, dedup by path, sorted by path.
function searchConfig(roots, q) {
  const needle = String(q || '').toLowerCase();
  if (!needle) return [];
  const seen = new Set();
  const results = [];
  for (const cwd of roots || []) {
    const cfg = readConfig(cwd);
    for (const scope of ['project', 'local']) {
      const { path, content } = cfg[scope];
      if (!content || seen.has(path)) continue;
      seen.add(path);
      const hit = firstHit(content, needle);
      if (!hit) continue;
      results.push({ cwd, scope, path, line: hit.line, text: hit.text });
    }
  }
  return results.sort((a, b) => a.path.localeCompare(b.path));
}

// Find dirs under `root` holding a .claude/settings*.json (mirrors findConfigRoots).
function findConfigRoots(root) {
  const base = untildify(root);
  const hits = new Set();
  for (const path of Object.keys(db.files)) {
    if (!path.startsWith(base + '/')) continue;
    const i = path.indexOf('/.claude/settings');
    if (i < 0) continue;
    const rest = path.slice(i + '/.claude/settings'.length);
    if (rest === '.json' || rest === '.local.json') hits.add(path.slice(0, i));
  }
  return { roots: [...hits].sort((a, b) => a.localeCompare(b)), truncated: false };
}

// ------------------------------------------------------------ codex config

// Codex config.toml scopes (mirrors server/codex-config.mjs scopePaths): project
// under the cwd, user under the (fake) home. No config.local.toml analog.
function codexPaths(cwd) {
  const c = untildify(cwd);
  return {
    project: join(c, '.codex', 'config.toml'),
    user: join(FAKE_HOME, '.codex', 'config.toml'),
  };
}

function readCodexConfig(cwd) {
  const paths = codexPaths(cwd);
  return { project: fileEntry(paths.project), user: fileEntry(paths.user) };
}

function writeCodexConfig(cwd, scope, content, mtime, force) {
  if (scope !== 'project' && scope !== 'user') return { ok: false, error: 'bad scope' };
  if (!isKnownRoot(cwd, db.roots.codexConfig)) return { ok: false, error: 'cwd outside config roots' };
  // Enforce the client's cwd→scope mapping (mirrors writeCodexConfig): 'user'
  // only for cwd ~ (home), 'project' only for a non-home cwd.
  const isHome = untildify(cwd) === FAKE_HOME;
  if (scope === 'user' && !isHome) return { ok: false, error: 'user scope requires cwd ~' };
  if (scope === 'project' && isHome) return { ok: false, error: 'project scope requires a non-home cwd' };
  return guardedWriteWithBackup(codexPaths(cwd)[scope], content, mtime, force);
}

function searchCodexConfig(roots, q) {
  const needle = String(q || '').toLowerCase();
  if (!needle) return [];
  const seen = new Set();
  const results = [];
  for (const cwd of roots || []) {
    const cfg = readCodexConfig(cwd);
    for (const scope of ['project', 'user']) {
      const { path, content } = cfg[scope];
      if (!content || seen.has(path)) continue;
      seen.add(path);
      const hit = firstHit(content, needle);
      if (!hit) continue;
      results.push({ cwd, scope, path, line: hit.line, text: hit.text });
    }
  }
  return results.sort((a, b) => a.path.localeCompare(b.path));
}

function findCodexConfigRoots(root) {
  const base = untildify(root);
  const hits = new Set();
  for (const path of Object.keys(db.files)) {
    if (!path.startsWith(base + '/')) continue;
    const i = path.indexOf('/.codex/config.toml');
    if (i < 0) continue;
    hits.add(path.slice(0, i));
  }
  return { roots: [...hits].sort((a, b) => a.localeCompare(b)), truncated: false };
}

// --------------------------------------------------------------------- hooks

// Hook files under a cwd's .claude/hooks (mirrors server/hooks.mjs listHooks).
function listHooks(cwd) {
  const dir = join(untildify(cwd), '.claude', 'hooks');
  const out = [];
  for (const path of Object.keys(db.files)) {
    if (!path.startsWith(dir + '/')) continue;
    const rel = path.slice(dir.length + 1);
    out.push({ path, rel, name: rel.split('/').pop() });
  }
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

// A client path must resolve under one hook root's .claude/hooks (mirrors guard).
function guardHookPath(path) {
  if (typeof path !== 'string' || !path) return null;
  const abs = untildify(path);
  for (const raw of db.roots.hooks || []) {
    if (underRoot(abs, raw, '.claude/hooks')) return abs;
  }
  return null;
}

function readHook(path) {
  const abs = guardHookPath(path);
  if (!abs) return { path, exists: false, error: 'bad path' };
  return fileEntry(abs);
}

function writeHook(path, content, mtime, force) {
  const abs = guardHookPath(path);
  if (!abs) return { ok: false, error: 'bad path' };
  return guardedWriteWithBackup(abs, content, mtime, force);
}

function searchHooks(roots, q) {
  const needle = String(q || '').toLowerCase();
  if (!needle) return [];
  const seen = new Set();
  const results = [];
  for (const cwd of roots || []) {
    for (const { path, rel } of listHooks(cwd)) {
      if (seen.has(path)) continue;
      seen.add(path);
      const f = db.files[path];
      if (!f) continue;
      const hit = firstHit(f.content, needle);
      if (!hit) continue;
      results.push({ cwd, path, rel, line: hit.line, text: hit.text });
    }
  }
  return results.sort((a, b) => a.path.localeCompare(b.path));
}

// --------------------------------------------------------------------- rules

// .md files under each base's <base>/.claude/rules (mirrors listRuleFiles).
function listRuleFiles(roots) {
  const files = [];
  for (const raw of roots || []) {
    const dir = join(untildify(raw), '.claude', 'rules');
    for (const path of Object.keys(db.files)) {
      if (!path.startsWith(dir + '/') || !path.toLowerCase().endsWith('.md')) continue;
      const rel = path.slice(dir.length + 1);
      files.push({ root: raw, path, rel, file: rel.split('/').pop() });
    }
  }
  return { files: files.sort((a, b) => a.path.localeCompare(b.path)), capped: false };
}

// A path must resolve to a .md under one rule root's .claude/rules (isRulePath).
function isRulePath(p) {
  if (typeof p !== 'string' || !p) return false;
  const abs = untildify(p);
  if (!abs.toLowerCase().endsWith('.md')) return false;
  return (db.roots.rules || []).some((raw) => underRoot(abs, raw, '.claude/rules'));
}

function readRuleFile(p) {
  if (!isRulePath(p)) return { ok: false, error: 'path outside rule roots' };
  const f = db.files[p];
  if (!f) return { ok: false, error: 'not found' };
  return { ok: true, content: f.content, mtime: f.mtime };
}

function writeRuleFile(p, content, mtime, force) {
  if (!isRulePath(p)) return { ok: false, error: 'path outside rule roots' };
  return guardedWrite(p, content, mtime, force);
}

function searchRules(roots, q) {
  const ql = String(q || '').toLowerCase();
  if (!ql) return { results: [], capped: false };
  const results = [];
  for (const raw of roots || []) {
    const dir = join(untildify(raw), '.claude', 'rules');
    for (const path of Object.keys(db.files)) {
      if (!path.startsWith(dir + '/') || !path.toLowerCase().endsWith('.md')) continue;
      const f = db.files[path];
      if (!f) continue;
      const hit = firstHit(f.content, ql);
      if (!hit) continue;
      const rel = path.slice(dir.length + 1);
      results.push({ root: raw, path, rel, file: rel.split('/').pop(), line: hit.line, text: hit.text });
    }
  }
  return { results: results.sort((a, b) => a.path.localeCompare(b.path)), capped: false };
}

// Companion <stem>-reference.md for a rule file (read-only, separate tree).
// The mock's corpus seeds no references, so this 404s unless one is written.
function findRuleReference(rulePath) {
  if (!rulePath) return { ok: false, error: 'no path' };
  const stem = String(rulePath).split('/').pop().replace(/\.md$/i, '');
  if (!stem) return { ok: false, error: 'no stem' };
  const ref = join(FAKE_HOME, '.agents', 'rules-reference', `${stem}-reference.md`);
  const f = db.files[ref];
  if (!f) return { ok: false, error: 'no reference' };
  return { ok: true, path: ref, content: f.content };
}

// -------------------------------------------------------------------- memory

function getMemoryRoot() {
  return db.roots.memory || '~/.claude/projects';
}

// Memory files under <root>/<project>/memory/*.md (mirrors listFiles).
function listMemoryFiles(rootRaw) {
  const root = untildify(rootRaw || getMemoryRoot());
  const out = [];
  for (const path of Object.keys(db.files)) {
    if (!path.startsWith(root + '/') || !path.toLowerCase().endsWith('.md')) continue;
    const rel = path.slice(root.length + 1);
    const m = rel.match(/^([^/]+)\/memory\/(.+)$/);
    if (!m) continue;
    out.push({ project: m[1], file: m[2].split('/').pop(), path });
  }
  return out.sort((a, b) => a.project.localeCompare(b.project) || a.file.localeCompare(b.file));
}

// A path must resolve to <root>/<project>/memory/<...>.md (isMemoryPath).
function isMemoryPath(p, rootRaw) {
  if (typeof p !== 'string' || !p) return false;
  const abs = untildify(p);
  const root = untildify(rootRaw || getMemoryRoot());
  if (abs !== root && !abs.startsWith(root + '/')) return false;
  const rel = abs.slice(root.length);
  return /^\/[^/]+\/memory\/.+\.md$/i.test(rel);
}

function readMemoryFile(p, rootRaw) {
  if (!isMemoryPath(p, rootRaw)) return { ok: false, error: 'path outside memory dirs' };
  const f = db.files[p];
  if (!f) return { ok: false, error: 'not found' };
  return { ok: true, content: f.content, mtime: f.mtime };
}

function writeMemoryFile(p, content, rootRaw, mtime, force) {
  if (!isMemoryPath(p, rootRaw)) return { ok: false, error: 'path outside memory dirs' };
  return guardedWrite(p, content, mtime, force);
}

function searchMemory(q, rootRaw) {
  const ql = String(q || '').toLowerCase();
  if (!ql) return { results: [], capped: false };
  const results = [];
  for (const { project, file, path } of listMemoryFiles(rootRaw)) {
    const f = db.files[path];
    if (!f) continue;
    const hit = firstHit(f.content, ql);
    if (!hit) continue;
    results.push({ project, file, path, line: hit.line, text: hit.text });
  }
  return { results: results.sort((a, b) => a.path.localeCompare(b.path)), capped: false };
}

// -------------------------------------------------------------------- skills

// Bare skill/scope/file-segment names only (mirrors server/skills.mjs NAME_RE).
const NAME_RE = /^(?!\.+$)[A-Za-z0-9._-]+$/;
const MD_EXT = new Set(['md', 'markdown']);
const IMG_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico']);

// Parse a SKILL.md's leading YAML frontmatter (mirrors parseSkill).
function parseSkill(src) {
  const m = String(src || '').match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
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
      while (i + 1 < lines.length && /^\s+-\s/.test(lines[i + 1])) {
        i++;
        out.triggers.push(lines[i].replace(/^\s+-\s/, '').trim());
      }
    }
  }
  return { ...out, body: src.slice(m[0].length) };
}

// Supporting files inside a skill dir, relative POSIX paths, SKILL.md excluded.
function listSkillFiles(dir) {
  const out = [];
  for (const path of Object.keys(db.files)) {
    if (!path.startsWith(dir + '/')) continue;
    const rel = path.slice(dir.length + 1).split('/').join('/');
    if (rel === 'SKILL.md') continue;
    out.push(rel);
  }
  return out.sort((a, b) => a.localeCompare(b));
}

// Read a `.claude/skills`-style dir (mirrors readSkillsDir).
function readSkillsDir(dir) {
  const names = new Set();
  for (const path of Object.keys(db.files)) {
    if (!path.startsWith(dir + '/')) continue;
    const seg = path.slice(dir.length + 1).split('/')[0];
    if (seg) names.add(seg);
  }
  const skills = [];
  for (const name of [...names].sort((a, b) => a.localeCompare(b))) {
    const md = join(dir, name, 'SKILL.md');
    const f = db.files[md];
    if (!f) continue;
    const parsed = parseSkill(f.content);
    skills.push({ name, description: parsed.description, raw: f.content, files: listSkillFiles(join(dir, name)) });
  }
  return { skills, capped: false };
}

// List skills under `root`, auto-detecting grouped vs flat (mirrors listSkills).
function listSkills(root) {
  root = untildify(root || (db.roots.skills || [])[0] || '');
  if (!root) return { scopes: [], flat: false, error: 'skills root not configured' };
  const under = Object.keys(db.files).filter((p) => p.startsWith(root + '/'));
  // No files under the root → the virtual root doesn't exist (listSkills's
  // `skills root not found`). A root with files but no skills returns no error.
  if (!under.length) return { scopes: [], flat: false, error: 'skills root not found' };
  const subdirs = new Set();
  for (const path of under) {
    const seg = path.slice(root.length + 1).split('/')[0];
    if (seg) subdirs.add(seg);
  }
  const grouped = [];
  for (const scope of [...subdirs].sort((a, b) => a.localeCompare(b))) {
    const r = readSkillsDir(join(root, scope, '.claude', 'skills'));
    if (r.skills.length) grouped.push({ name: scope, skills: r.skills, capped: r.capped });
  }
  if (grouped.length) return { scopes: grouped, flat: false };
  const r = readSkillsDir(root);
  if (r.skills.length) return { scopes: [{ name: root.split('/').pop() || root, skills: r.skills, capped: r.capped }], flat: true };
  return { scopes: [], flat: false };
}

function skillBaseDir(root, scope, skill, flat) {
  return flat ? join(root, skill) : join(root, scope, '.claude', 'skills', skill);
}

function readSkill(root, scope, skill, flat) {
  root = untildify(root || (db.roots.skills || [])[0] || '');
  if (!root) return { ok: false, error: 'skills root not configured' };
  if (typeof skill !== 'string' || !NAME_RE.test(skill)) return { ok: false, error: 'bad name' };
  if (!flat && (typeof scope !== 'string' || !NAME_RE.test(scope))) return { ok: false, error: 'bad name' };
  const p = join(skillBaseDir(root, scope, skill, flat), 'SKILL.md');
  const f = db.files[p];
  if (!f) return { ok: false, error: 'not found' };
  const parsed = parseSkill(f.content);
  return { ok: true, path: p, name: parsed.name, description: parsed.description, triggers: parsed.triggers, body: parsed.body, raw: f.content, mtime: f.mtime };
}

function readSkillFile(root, scope, skill, file, flat) {
  root = untildify(root || (db.roots.skills || [])[0] || '');
  if (!root) return { ok: false, error: 'skills root not configured' };
  if (typeof skill !== 'string' || !NAME_RE.test(skill)) return { ok: false, error: 'bad name' };
  if (!flat && (typeof scope !== 'string' || !NAME_RE.test(scope))) return { ok: false, error: 'bad name' };
  if (typeof file !== 'string' || !file) return { ok: false, error: 'bad file' };
  const segs = file.split('/');
  if (segs.some((s) => !s || !NAME_RE.test(s))) return { ok: false, error: 'bad file' };
  const p = join(skillBaseDir(root, scope, skill, flat), ...segs);
  const f = db.files[p];
  if (!f) return { ok: false, error: 'not found' };
  const ext = p.slice(p.lastIndexOf('.') + 1).toLowerCase();
  const type = MD_EXT.has(ext) ? 'markdown' : IMG_EXT.has(ext) ? 'image' : 'code';
  const name = p.split('/').pop();
  if (type === 'image') return { ok: true, type, name, path: p, mtime: f.mtime };
  return { ok: true, type, name, path: p, content: f.content, mtime: f.mtime };
}

function writeSkill(root, scope, skill, content, flat, mtime, force) {
  root = untildify(root || (db.roots.skills || [])[0] || '');
  if (!root) return { ok: false, error: 'skills root not configured' };
  if (typeof skill !== 'string' || !NAME_RE.test(skill)) return { ok: false, error: 'bad name' };
  if (!flat && (typeof scope !== 'string' || !NAME_RE.test(scope))) return { ok: false, error: 'bad name' };
  if (typeof content !== 'string') return { ok: false, error: 'bad content' };
  return guardedWrite(join(skillBaseDir(root, scope, skill, flat), 'SKILL.md'), content, mtime, force);
}

function writeSkillFile(root, scope, skill, file, content, flat, mtime, force) {
  root = untildify(root || (db.roots.skills || [])[0] || '');
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
  return guardedWrite(p, content, mtime, force);
}

// ------------------------------------------------------------ config UI state

const DEFAULT_STATE = { tabs: [], active: null, autosave: false, expanded: [] };

function getConfigState() {
  return { ...DEFAULT_STATE, ...(db.ui.configState || {}) };
}

function setConfigState(patch) {
  const cur = getConfigState();
  const next = { ...cur };
  const tabs = Array.isArray(patch?.tabs)
    ? patch.tabs
        .filter((t) => t && typeof t.cwd === 'string' && typeof t.tool === 'string' && typeof t.scope === 'string')
        .map((t) => ({ cwd: t.cwd, tool: t.tool, scope: t.scope, path: typeof t.path === 'string' ? t.path : '' }))
        .slice(0, 50)
    : undefined;
  if (tabs) next.tabs = tabs;
  if (patch && (typeof patch.active === 'string' || patch.active === null)) next.active = patch.active;
  if (patch && typeof patch.autosave === 'boolean') next.autosave = patch.autosave;
  const expanded = Array.isArray(patch?.expanded)
    ? patch.expanded.filter((x) => typeof x === 'string').slice(0, 500)
    : undefined;
  if (expanded) next.expanded = expanded;
  db.ui.configState = next;
  return { ok: true, state: next };
}

// ------------------------------------------------------------------ register

export function registerEditors(server) {
  // ---- Config editor (claude) — static siblings before PUT /config/:scope.
  server.get('/config', (schema, req) => {
    const cwd = req.queryParams.cwd;
    if (!cwd) return new Response(400, {}, { error: 'cwd required' });
    return readConfig(cwd);
  });
  server.get('/config/scan', (schema, req) => {
    const root = req.queryParams.root;
    if (!root) return new Response(400, {}, { error: 'bad root' });
    return findConfigRoots(root);
  });
  rootsRoutes(server, 'config');
  server.post('/config/search', (schema, req) => {
    const b = parseBody(req);
    return { results: searchConfig(b.roots, b.q) };
  }, 200);
  server.get('/config/state', () => ({ state: getConfigState() }));
  server.put('/config/state', (schema, req) => setConfigState(parseBody(req)));
  server.put('/config/:scope', (schema, req) => {
    const b = parseBody(req);
    const { cwd, content, mtime, force } = b;
    if (!cwd || content == null) return new Response(400, {}, { ok: false, error: 'cwd + content required' });
    const r = writeConfig(cwd, req.params.scope, content, mtime, force);
    if (!r.ok) return writeError(r);
    return r;
  });

  // ---- Codex config editor (mirrors /config). /codex-config/roots is
  // registered manually rather than via rootsRoutes(server, 'codex-config'):
  // rootsRoutes reads db.roots[key], and the seeded field is db.roots.codexConfig
  // (camelCase) — the URL segment and the db field differ for this one panel.
  server.get('/codex-config', (schema, req) => {
    const cwd = req.queryParams.cwd;
    if (!cwd) return new Response(400, {}, { error: 'cwd required' });
    return readCodexConfig(cwd);
  });
  server.get('/codex-config/scan', (schema, req) => {
    const root = req.queryParams.root;
    if (!root) return new Response(400, {}, { error: 'bad root' });
    return findCodexConfigRoots(root);
  });
  server.get('/codex-config/roots', () => ({ roots: db.roots.codexConfig || [] }));
  server.put('/codex-config/roots', (schema, req) => {
    const body = parseBody(req);
    const roots = Array.isArray(body.roots)
      ? [...new Set(body.roots.filter((r) => typeof r === 'string' && r))].slice(0, 50)
      : (db.roots.codexConfig || []);
    db.roots.codexConfig = roots;
    return { ok: true, roots };
  });
  server.post('/codex-config/search', (schema, req) => {
    const b = parseBody(req);
    return { results: searchCodexConfig(b.roots, b.q) };
  }, 200);
  server.put('/codex-config/:scope', (schema, req) => {
    const b = parseBody(req);
    const { cwd, content, mtime, force } = b;
    if (!cwd || content == null) return new Response(400, {}, { ok: false, error: 'cwd + content required' });
    const r = writeCodexConfig(cwd, req.params.scope, content, mtime, force);
    if (!r.ok) return writeError(r);
    return r;
  });

  // ---- Hooks editor.
  rootsRoutes(server, 'hooks');
  server.post('/hooks/list', (schema, req) => {
    const roots = parseBody(req).roots || [];
    return { groups: roots.map((cwd) => ({ cwd, files: listHooks(cwd) })) };
  }, 200);
  server.post('/hooks/search', (schema, req) => {
    const b = parseBody(req);
    return { results: searchHooks(b.roots, b.q) };
  }, 200);
  server.get('/hooks/file', (schema, req) => {
    const r = readHook(req.queryParams.path);
    if (r.error) return new Response(400, {}, r);
    return r;
  });
  server.put('/hooks/file', (schema, req) => {
    const b = parseBody(req);
    const { path, content, mtime, force } = b;
    if (!path || content == null) return new Response(400, {}, { ok: false, error: 'path + content required' });
    const r = writeHook(path, content, mtime, force);
    if (!r.ok) return writeError(r);
    return r;
  });

  // ---- Rules editor.
  rootsRoutes(server, 'rules');
  server.post('/rules/files', (schema, req) => listRuleFiles(parseBody(req).roots), 200);
  server.post('/rules/search', (schema, req) => {
    const b = parseBody(req);
    return searchRules(b.roots, b.q);
  }, 200);
  server.get('/rules/reference', (schema, req) => {
    const r = findRuleReference(req.queryParams.path);
    if (!r.ok) return new Response(r.error === 'no reference' ? 404 : 400, {}, r);
    return r;
  });
  server.get('/rules/file', (schema, req) => {
    const r = readRuleFile(req.queryParams.path);
    if (!r.ok) return new Response(r.error === 'not found' ? 404 : 400, {}, r);
    return r;
  });
  server.put('/rules/file', (schema, req) => {
    const b = parseBody(req);
    const { path, content, mtime, force } = b;
    if (path == null || content == null) return new Response(400, {}, { ok: false, error: 'path + content required' });
    const r = writeRuleFile(path, content, mtime, force);
    if (!r.ok) return writeError(r);
    return r;
  });

  // ---- Memory panel.
  server.get('/memory/root', () => ({ root: getMemoryRoot() }));
  server.put('/memory/root', (schema, req) => {
    const root = parseBody(req).root;
    if (typeof root !== 'string' || !root) return { ok: false, error: 'bad root' };
    db.roots.memory = root;
    return { ok: true, root };
  });
  server.get('/memory/search', (schema, req) => searchMemory(req.queryParams.q, req.queryParams.root));
  server.get('/memory/files', (schema, req) => ({ files: listMemoryFiles(req.queryParams.root) }));
  server.get('/memory/file', (schema, req) => {
    const r = readMemoryFile(req.queryParams.path, req.queryParams.root);
    if (!r.ok) return new Response(r.error === 'not found' ? 404 : 400, {}, r);
    return r;
  });
  server.put('/memory/file', (schema, req) => {
    const b = parseBody(req);
    const { path, content, root, mtime, force } = b;
    if (path == null || content == null) return new Response(400, {}, { ok: false, error: 'path + content required' });
    const r = writeMemoryFile(path, content, root, mtime, force);
    if (!r.ok) return writeError(r);
    return r;
  });

  // ---- Skills viewer.
  rootsRoutes(server, 'skills');
  server.get('/skills', (schema, req) => listSkills(req.queryParams.root));
  server.get('/skill', (schema, req) => {
    const q = req.queryParams;
    const flat = q.flat === '1';
    if (q.file) {
      const r = readSkillFile(q.root, q.scope, q.skill, q.file, flat);
      if (!r.ok) return new Response(r.error === 'not found' ? 404 : 400, {}, r);
      return r;
    }
    const r = readSkill(q.root, q.scope, q.skill, flat);
    if (!r.ok) return new Response(r.error === 'not found' ? 404 : 400, {}, r);
    return r;
  });
  server.put('/skill', (schema, req) => {
    const b = parseBody(req);
    const flat = b.flat === true || b.flat === '1';
    const r = b.file
      ? writeSkillFile(b.root, b.scope, b.skill, b.file, b.content, flat, b.mtime, b.force)
      : writeSkill(b.root, b.scope, b.skill, b.content, flat, b.mtime, b.force);
    if (!r.ok) return writeError(r);
    return r;
  });
}
