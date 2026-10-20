// Rules backend: a list of persisted rule *base* roots (default ~), each
// scanned at <base>/.claude/rules — the Claude Code project convention. Pick a
// project (or home) dir; its .claude/rules tree is browsable/searchable/editable.
// Model on wiki.mjs (recursive walk, resolveRoot, mtime line cache) + config.mjs
// (roots persistence) + memory.mjs (write guard). The recursive .md walk and
// content search run in Rust (rust/backend/src/rules.rs); Node keeps roots
// persistence, the path guard and the guarded read/write.
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join, resolve, sep, normalize } from 'node:path';
import { homedir } from 'node:os';
import { STATE_DIR } from './app-dir.mjs';
import { backupFile } from './backups.mjs';

// Rule root list: FS-persisted (survives browser cache clear) under STATE_DIR.
// Seeded with '~' (→ ~/.claude/rules) when absent/empty.
const ROOTS_FILE = join(STATE_DIR, 'rules-roots.json');
export function getRulesRoots() {
  try {
    const r = JSON.parse(readFileSync(ROOTS_FILE, 'utf8'));
    return Array.isArray(r) && r.length ? r : ['~'];
  } catch { return ['~']; }
}

// The rules dir for a picked base root: <base>/.claude/rules (absolute).
function rulesDir(base) {
  const r = resolveRoot(base);
  return r ? resolve(join(r, '.claude', 'rules')) : null;
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

// Scan pairs handed to Rust per request: Node stays the configured-root
// owner — it resolves each picked base to its <base>/.claude/rules dir, while
// `root` stays the verbatim base string the client sent (the UI groups files
// under it). Unresolvable bases are skipped silently.
function scanRoots(roots) {
  const scans = [];
  for (const raw of roots || []) {
    if (typeof raw !== 'string' || !raw) continue;
    const dir = rulesDir(raw);
    if (dir) scans.push({ root: raw, dir });
  }
  return scans;
}

// The recursive .md walk runs in Rust; these routes have no other non-2xx
// mapping, so a bridge crash is the only 500 path (reference-handler shape).
export function createRuleFilesHandler(backend, logger) {
  return async (req, reply) => {
    try { return await backend.ruleFiles(scanRoots(req.body?.roots)); }
    catch (error) {
      logger.error({ err: error.message }, 'Rust Rules files backend failed');
      reply.code(500);
      return { ok: false, error: 'rules files backend unavailable' };
    }
  };
}

// Content search with the Rust mtime line cache; empty q yields no results.
export function createRuleSearchHandler(backend, logger) {
  return async (req, reply) => {
    const { roots, q } = req.body || {};
    try { return await backend.ruleSearch(scanRoots(roots), q); }
    catch (error) {
      logger.error({ err: error.message }, 'Rust Rules search backend failed');
      reply.code(500);
      return { ok: false, error: 'rules search backend unavailable' };
    }
  };
}

// Path guard: must resolve to a .md under ONE base's <base>/.claude/rules —
// server-derived, never trusts the client's root.
export function isRulePath(p) {
  if (!p) return false;
  const abs = resolve(p);
  if (!abs.toLowerCase().endsWith('.md')) return false;
  return getRulesRoots().some((raw) => {
    const dir = rulesDir(raw);
    return dir && (abs === dir || abs.startsWith(dir + sep));
  });
}

export function readRuleFile(p) {
  if (!isRulePath(p)) return { ok: false, error: 'path outside rule roots' };
  if (!existsSync(p)) return { ok: false, error: 'not found' };
  try { return { ok: true, content: readFileSync(p, 'utf8'), mtime: statSync(p).mtimeMs }; }
  catch (e) { return { ok: false, error: e.message }; }
}

export async function writeRuleFile(p, content, mtime, force) {
  if (!isRulePath(p)) return { ok: false, error: 'path outside rule roots' };
  try {
    if (mtime != null && !force && existsSync(p) && Math.abs(statSync(p).mtimeMs - mtime) > 1) {
      return { ok: false, error: 'changed on disk' };
    }
    await backupFile(p);
    // Re-check: backupFile's await can yield to a concurrent save of this
    // same path landing in between, which the first check (above) can't see.
    if (mtime != null && !force && existsSync(p) && Math.abs(statSync(p).mtimeMs - mtime) > 1) {
      return { ok: false, error: 'changed on disk' };
    }
    await writeFile(p, content);
    return { ok: true, mtime: statSync(p).mtimeMs };
  }
  catch (e) { return { ok: false, error: e.message }; }
}

// Companion reference for a rule file. Convention (see global CLAUDE.md): a rule
// `<stem>.md` pairs with `<stem>-reference.md` under the rules-reference dir.
// Reference is read-only and lives in a separate tree (not a rule root), so it
// is NOT writable via /rules/file (isRulePath guards writes to rule roots only).
// Node owns the configured root: RULES_REF_DIR defaults to the global
// ~/.agents/rules-reference convention; SING_RULES_REF overrides it (used by
// tests to isolate from real FS). The lookup itself runs in Rust.
const RULES_REF_DIR = process.env.SING_RULES_REF ? resolve(process.env.SING_RULES_REF)
  : join(homedir(), '.agents', 'rules-reference');
export function createRuleReferenceHandler(backend, logger) {
  return async (req, reply) => {
    let r;
    try { r = await backend.ruleReference(req.query.path, RULES_REF_DIR); }
    catch (error) {
      logger.error({ err: error.message }, 'Rust Rules reference backend failed');
      reply.code(500);
      return { ok: false, error: 'rules reference backend unavailable' };
    }
    if (!r.ok) reply.code(r.error === 'no reference' ? 404 : 400);
    return r;
  };
}
