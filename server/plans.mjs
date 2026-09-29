// Plans backend: read-only browse of the handoff plan tree at
// ~/.agents/.plan/<session-id>/ — one dir per session, holding markdown plans
// (plan.md, phase-N.md, evidence notes) plus a hook-written state.json snapshot.
// External and read-only: this module NEVER writes there (see .claude/rules/server.md).
// Model on rules.mjs (bounded dir listing, path guard, SING_* test override).
import { readdir, readFile, stat, open } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

// The plan tree root comes from SING_PLANS_ROOT — there is no implicit
// ~/.agents/.plan default: the feature stays disabled until the user points
// the daemon at a dir in .env. Read at import time, like rules.mjs's
// SING_RULES_REF, so it must be set before the dynamic import in a test.
export const PLAN_ROOT = process.env.SING_PLANS_ROOT
  ? resolve(process.env.SING_PLANS_ROOT)
  : null;

const DIR_CAP = 300;               // session dirs scanned per listSessions call
const NOTES_CAP = 200;             // note files returned per session
const FILE_CAP_BYTES = 256 * 1024; // per-file read cap (plans are ~2KB; guard the rare outlier)
const SID_RE = /^[0-9a-f-]{8,64}$/i;
const BUCKETS = ['active', 'done', 'blocked', 'superseded', 'other'];

// Read a file, capped at FILE_CAP_BYTES (a 1MB plan must not be slurped whole).
async function readCapped(p) {
  let size;
  try { size = (await stat(p)).size; } catch { return null; }
  try {
    if (size <= FILE_CAP_BYTES) return await readFile(p, 'utf8');
    const fh = await open(p, 'r');
    try {
      const buf = Buffer.alloc(FILE_CAP_BYTES);
      const { bytesRead } = await fh.read(buf, 0, FILE_CAP_BYTES, 0);
      return buf.toString('utf8', 0, bytesRead);
    } finally { await fh.close(); }
  } catch { return null; }
}

// Top-level .md names of a dir (subdirs skipped); null when the dir is unreadable.
async function mdNames(dir) {
  let ents;
  try { ents = await readdir(dir, { withFileTypes: true }); } catch { return null; }
  return ents.filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.md')).map((e) => e.name);
}

const stripEm = (s) => (s || '').replace(/\*\*/g, '').trim();

// Status is a free string, not an enum — collapse it to a UI bucket.
function normalizeStatus(raw) {
  const s = stripEm(raw);
  if (/^(active|in.?progress)/i.test(s)) return 'active';
  if (/(done|complete)/i.test(s)) return 'done';
  if (/^blocked/i.test(s)) return 'blocked';
  if (/superseded/i.test(s)) return 'superseded';
  return 'other';
}

const statusOf = (md) => normalizeStatus((md.match(/^Status:\s*(.*)$/im) || [])[1] || '');

// A .md counts as a plan on any of: a Status: line in the first 15 lines, a
// `# Plan` heading, or an `## Objective` / `## Next steps` heading. Everything
// else in the folder is a note.
function isPlan(md) {
  const head = md.split('\n', 15).join('\n');
  return /^\s*Status:/im.test(head)
    || /^#\s+Plan\b/im.test(md)
    || /^##\s+(Objective|Next steps)\b/im.test(md);
}

// Lines under the first `## <heading>` match, up to the next heading of any level.
function section(ls, re) {
  const start = ls.findIndex((l) => re.test(l));
  if (start < 0) return [];
  const out = [];
  for (let i = start + 1; i < ls.length; i++) {
    if (/^#{1,6}\s/.test(ls[i])) break;
    out.push(ls[i]);
  }
  return out;
}

// Text of a `- ` / `* ` list item, or null for a non-item line.
const bullet = (l) => {
  const m = /^\s*[-*]\s+(.*)$/.exec(l);
  return m ? m[1].trim() : null;
};

function parsePlan(file, md) {
  const ls = md.split(/\r?\n/);
  const title = ((md.match(/^#\s+(.*)$/m) || [])[1] || '').trim() || file.replace(/\.md$/i, '');
  const statusRaw = stripEm((md.match(/^Status:\s*(.*)$/im) || [])[1] || '');
  const objective = (section(ls, /^##\s+(Objective|Goal)\b/i).find((l) => l.trim()) || '').trim();
  const currentPhase = ((md.match(/^\s*Current phase:\s*(.*)$/im) || [])[1] || '').trim();

  const phases = [];
  for (const l of section(ls, /^##\s+Phases\b/i)) {
    const t = bullet(l);
    if (t == null) continue;
    const cb = /^\[( |x|X|-)\]\s*(.*)$/.exec(t);
    if (cb) {
      phases.push({
        text: cb[2].trim(),
        state: cb[1].toLowerCase() === 'x' ? 'done' : cb[1] === '-' ? 'skipped' : 'open',
      });
    } else phases.push({ text: t, state: 'plain' });
  }

  const nextSteps = [];
  for (const l of section(ls, /^##\s+Next steps\b/i)) {
    const t = bullet(l);
    if (t == null) continue;
    nextSteps.push(t);
    if (nextSteps.length >= 2) break;
  }

  // "Required before acting: <path>" is the machine-readable dependency line
  // (often suffixed with a parenthetical note, which is dropped here).
  const required = [];
  for (const l of ls) {
    const m = /^\s*[-*]?\s*Required before acting:\s*(.+)$/i.exec(l);
    if (m) required.push(m[1].replace(/\s*\(.*$/, '').trim());
  }

  const completed = ((md.match(/^\s*Completed:\s*(.*)$/im) || [])[1] || '').trim();
  return {
    file, title, status: normalizeStatus(statusRaw), statusRaw,
    objective, currentPhase, phases, nextSteps, required,
    completed: completed || null,
  };
}

// Session dirs with at least one plan-like .md. Folders holding only notes or
// only state.json are hidden. Skips origins/ and any non-UUID-shaped sibling by
// the shape test. mtime is the *folder* mtime.
// VERIFY: plans.mjs-routes  (both exports below back /plans/sessions + /plans/session)
export async function listSessions() {
  const out = [];
  if (PLAN_ROOT == null) return out; // disabled: no SING_PLANS_ROOT in .env
  let ents;
  try { ents = await readdir(PLAN_ROOT, { withFileTypes: true }); } catch { return out; }
  let scanned = 0;
  for (const e of ents) {
    if (!e.isDirectory() || !SID_RE.test(e.name)) continue;
    if (++scanned > DIR_CAP) break;
    const dir = join(PLAN_ROOT, e.name);
    const names = await mdNames(dir);
    if (!names) continue;
    const buckets = Object.fromEntries(BUCKETS.map((b) => [b, 0]));
    let planCount = 0;
    for (const n of names) {
      const md = await readCapped(join(dir, n));
      if (md && isPlan(md)) { planCount++; buckets[statusOf(md)]++; }
    }
    if (planCount < 1) continue;
    let mtime = 0;
    try { mtime = (await stat(dir)).mtimeMs; } catch { /* keep 0 */ }
    // state.json summary for the list card (same snapshot getSession reads):
    // branch + context tokens, null when the file is absent or malformed.
    // VERIFY: refine-server-fields
    let branch = null;
    let contextTokens = null;
    const raw = await readCapped(join(dir, 'state.json'));
    if (raw) {
      try {
        const j = JSON.parse(raw);
        branch = j.branch ?? null;
        contextTokens = j.context_tokens ?? null;
      } catch { /* malformed snapshot → keep nulls */ }
    }
    out.push({ sid: e.name, mtime, planCount, statusBuckets: buckets, branch, contextTokens });
  }
  return out;
}

// One session dir: its plans, its notes (grouped to the plan that mentions them
// by basename — `## Evidence` lists them, `## Phases` links the phase-N.md files),
// and the picked state.json fields. An existing dir always resolves ok, even
// with no plan files (notes are still browsable); only a missing/unreadable dir
// is 'not found'.
export async function getSession(sid) {
  if (PLAN_ROOT == null) return { ok: false, error: 'plans disabled' }; // no SING_PLANS_ROOT in .env
  if (typeof sid !== 'string' || !SID_RE.test(sid)) return { ok: false, error: 'bad sid' };
  const root = resolve(PLAN_ROOT);
  const dir = resolve(join(root, sid));
  if (dir !== root && !dir.startsWith(root + sep)) return { ok: false, error: 'bad sid' };

  const names = await mdNames(dir);
  if (!names) return { ok: false, error: 'not found' };

  const texts = new Map();
  for (const n of names) texts.set(n, await readCapped(join(dir, n)));

  const plans = [];
  const notes = [];
  for (const n of names) {
    const md = texts.get(n);
    if (md == null) continue;
    if (isPlan(md)) plans.push(parsePlan(n, md));
    else notes.push({ file: n, title: ((md.match(/^#\s+(.*)$/m) || [])[1] || '').trim() || n, plan: null });
  }
  for (const note of notes) {
    const owner = plans.find((p) => (texts.get(p.file) || '').includes(note.file));
    if (owner) note.plan = owner.file;
  }

  let state = null;
  const raw = await readCapped(join(dir, 'state.json'));
  if (raw) {
    try {
      const j = JSON.parse(raw);
      state = {
        generatedAt: j.generated_at ?? null,
        cwd: j.cwd ?? null,
        branch: j.branch ?? null,
        contextTokens: j.context_tokens ?? null,
      };
    } catch { /* malformed snapshot → null */ }
  }

  let mtime = 0;
  try { mtime = (await stat(dir)).mtimeMs; } catch { /* keep 0 */ }
  return { ok: true, sid, mtime, plans, notes: notes.slice(0, NOTES_CAP), state };
}
