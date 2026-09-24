// Projects: an ordered list of git repo toplevels, persisted at
// STATE_DIR/projects.json (wiki-root.json pattern — see wiki.mjs). Each entry
// gets an on-demand git status readout (branch, ahead/behind, working-tree
// counts, stash, last commit). Status never runs `git fetch` — ahead/behind are
// "as of last fetch"; fetch/rebase run only on explicit request (gitOp).
import { existsSync, readFileSync, statSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import * as reg from './agents.mjs';
import { git } from './tasks.mjs';
import { getSummariser } from './model-store.mjs';
import { defaultCallSummariser, binFor } from './history.mjs';

const SUMMARY_CACHE_DIR = join(reg.CACHE_DIR, 'projects-summary');
const RECENT_COMMIT_COUNT = 10;
const DIFF_CAP = 20_000; // ~20 KB — LLM input only, never the deterministic fallback
const sha1 = (s) => createHash('sha1').update(s).digest('hex');

const PROJECTS_FILE = join(reg.STATE_DIR, 'projects.json');
const IS_WIN = process.platform === 'win32';
// Comparison key: resolved absolute path, case-folded on win32 (NTFS is
// case-insensitive) so a repo can't be added/removed/reordered twice under two
// spellings of the same path.
const key = (p) => { const r = resolve(p); return IS_WIN ? r.toLowerCase() : r; };

function readList() {
  try {
    const arr = JSON.parse(readFileSync(PROJECTS_FILE, 'utf8'));
    return Array.isArray(arr) ? arr.filter((p) => typeof p === 'string') : [];
  } catch { return []; }
}
function writeList(list) {
  reg.writeAtomic(PROJECTS_FILE, JSON.stringify(list, null, 2));
}

// Still a git repo on disk right now?
async function isLiveRepo(p) {
  if (!existsSync(p)) return false;
  try { await git(p, 'rev-parse', '--show-toplevel'); return true; }
  catch { return false; }
}

// Is `p` in the stored list? Used to gate the status route (a caller can't
// probe an arbitrary directory's git status via /projects/status).
export function has(p) {
  const k = key(p);
  return readList().some((s) => key(s) === k);
}

export async function list() {
  const stored = readList();
  const kept = [];
  for (const p of stored) if (await isLiveRepo(p)) kept.push(p);
  if (kept.length !== stored.length) writeList(kept);
  return kept;
}

export async function add(rawPath) {
  if (typeof rawPath !== 'string' || !rawPath) return { ok: false, error: 'not a git repository' };
  const resolved = resolve(rawPath);
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) return { ok: false, error: 'not a git repository' };
  let toplevel;
  try { toplevel = resolve(await git(resolved, 'rev-parse', '--show-toplevel')); }
  catch { return { ok: false, error: 'not a git repository' }; }
  const stored = readList();
  const k = key(toplevel);
  if (stored.some((p) => key(p) === k)) return { ok: true, projects: stored };
  const next = [...stored, toplevel];
  writeList(next);
  return { ok: true, projects: next };
}

export function remove(rawPath) {
  const k = key(rawPath);
  const stored = readList();
  const next = stored.filter((p) => key(p) !== k);
  if (next.length !== stored.length) writeList(next);
  return { ok: true, projects: next };
}

export function reorder(paths) {
  if (!Array.isArray(paths)) return { ok: false, error: 'not a permutation' };
  const stored = readList();
  if (paths.length !== stored.length) return { ok: false, error: 'not a permutation' };
  const storedKeys = new Set(stored.map(key));
  const seen = new Set();
  for (const p of paths) {
    if (typeof p !== 'string') return { ok: false, error: 'not a permutation' };
    const k = key(p);
    if (!storedKeys.has(k) || seen.has(k)) return { ok: false, error: 'not a permutation' };
    seen.add(k);
  }
  const byKey = new Map(stored.map((p) => [key(p), p]));
  const next = paths.map((p) => byKey.get(key(p)));
  writeList(next);
  return { ok: true, projects: next };
}

// git status --porcelain=v2 --branch: '# branch.*' header lines, then one
// entry line per changed/untracked/conflicted path. XY column meanings for
// entry types '1'/'2': X (index) != '.' => staged, Y (worktree) != '.' =>
// modified. Type 'u' is an unmerged/conflicted path; '?' is untracked.
export async function gitStatus(path) {
  const out = await git(path, 'status', '--porcelain=v2', '--branch');
  let branch = null, upstream = null, ahead = 0, behind = 0;
  let staged = 0, modified = 0, untracked = 0, conflicted = 0;
  for (const line of out.split('\n')) {
    if (line.startsWith('# branch.head ')) {
      const h = line.slice('# branch.head '.length);
      branch = h === '(detached)' ? null : h;
    } else if (line.startsWith('# branch.upstream ')) {
      upstream = line.slice('# branch.upstream '.length);
    } else if (line.startsWith('# branch.ab ')) {
      const m = line.match(/\+(\d+) -(\d+)/);
      if (m) { ahead = Number(m[1]); behind = Number(m[2]); }
    } else if (line.startsWith('1 ') || line.startsWith('2 ')) {
      const xy = line.split(' ')[1];
      if (xy[0] !== '.') staged++;
      if (xy[1] !== '.') modified++;
    } else if (line.startsWith('u ')) conflicted++;
    else if (line.startsWith('? ')) untracked++;
  }
  const stashOut = await git(path, 'stash', 'list');
  const stash = stashOut ? stashOut.split('\n').filter(Boolean).length : 0;
  let lastCommit = null;
  try {
    const [sha, subject, date] = (await git(path, 'log', '-1', '--format=%H%x00%s%x00%cI')).split('\0');
    lastCommit = { sha, subject, date };
  } catch { /* empty repo — no commits yet */ }
  return { path, branch, upstream, ahead, behind, staged, modified, untracked, conflicted, stash, lastCommit };
}

// Card buttons: plain `git fetch` / `git rebase` (onto upstream) / both
// ('sync'), shelled out directly — no agent. A rebase that stops (conflicts)
// is aborted so the repo is never left mid-rebase; git's own refusal (dirty
// tree, no upstream) comes back as the error.
export const GIT_OPS = { fetch: ['fetch'], rebase: ['rebase'], sync: ['fetch', 'rebase'] };
export async function gitOp(path, op) {
  for (const cmd of GIT_OPS[op]) {
    try { await git(path, cmd); }
    catch (e) {
      if (cmd === 'rebase') await git(path, 'rebase', '--abort').catch(() => {});
      return { ok: false, error: e.message };
    }
  }
  return { ok: true };
}

// Unpushed commits (@{u}..HEAD) when there's an upstream, else the last
// RECENT_COMMIT_COUNT. An empty repo (no HEAD yet) has no commits either way.
async function commitScope(path) {
  let hasUpstream = true;
  try { await git(path, 'rev-parse', '--abbrev-ref', '@{u}'); }
  catch { hasUpstream = false; }
  const scope = hasUpstream ? 'unpushed' : 'recent';
  const args = hasUpstream ? ['log', '@{u}..HEAD', '--format=%h%x00%s'] : ['log', '-n', String(RECENT_COMMIT_COUNT), '--format=%h%x00%s'];
  let out = '';
  try { out = await git(path, ...args); } catch { /* empty repo — no commits */ }
  const subjects = out.split('\n').filter(Boolean).map((line) => line.split('\0')[1] ?? '');
  return { subjects, scope };
}

// git diff HEAD --stat misses untracked files entirely (they have nothing in
// HEAD to diff against) — status --porcelain covers those, so it feeds the
// cache key even though the deterministic bullets below are stat-only (spec).
async function uncommittedChanges(path) {
  let stat = '', porcelain = '', diff = '';
  try { stat = await git(path, 'diff', 'HEAD', '--stat'); } catch { /* empty repo — no HEAD */ }
  try { porcelain = await git(path, 'status', '--porcelain'); } catch { /* unreadable tree */ }
  try { diff = await git(path, 'diff', 'HEAD'); } catch { /* empty repo — no HEAD */ }
  return { stat, porcelain, diff };
}

function truncatedDiff(diff) {
  if (diff.length <= DIFF_CAP) return diff;
  return `${diff.slice(0, DIFF_CAP)}\n… (truncated)`;
}

// Bottom rung: no LLM, so committed = commit subjects, uncommitted = the
// `--stat` file lines plus its trailing summary line, plus an untracked count
// from porcelain (`diff HEAD` never sees untracked files). Each empty ⇒ [].
function deterministicSummary(subjects, stat, porcelain) {
  const lines = stat.split('\n').filter(Boolean);
  const uncommitted = lines.length ? [...lines.slice(0, -1).slice(0, 10), lines[lines.length - 1]] : [];
  const untracked = porcelain.split('\n').filter((l) => l.startsWith('?? ')).length;
  if (untracked) uncommitted.push(`${untracked} untracked file${untracked === 1 ? '' : 's'}`);
  return { committed: subjects.slice(0, 10), uncommitted };
}

function parseJsonSummary(text) {
  const m = typeof text === 'string' && text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]);
    if (!Array.isArray(o.committed) && !Array.isArray(o.uncommitted)) return null;
    const bullets = (arr) => (Array.isArray(arr) ? arr.filter((b) => b && String(b).trim()).slice(0, 5).map((b) => String(b).trim()) : []);
    return { committed: bullets(o.committed), uncommitted: bullets(o.uncommitted) };
  } catch { return null; }
}

function cacheFileFor(path, headSha, diff, porcelain) {
  const key = sha1(`${path}\0${headSha}\0${sha1(diff + porcelain)}`);
  return join(SUMMARY_CACHE_DIR, `${key}.json`);
}

// Summarizes unpushed (or recent) commits + the uncommitted diff, LLM-first
// with a deterministic fallback — same no-summariser/no-binary gate as
// history.mjs's summarizeDay, so there's no implicit fallback LLM here either.
// LLM results are cached by path + HEAD sha + a hash of the working tree, so
// reopening the Projects view doesn't re-bill the model; the deterministic
// path is cheap enough that it's never cached.
const callProjectSummariser = (prompt, m) => defaultCallSummariser(prompt, m, { system: null });

export async function summary(path, { callSummariser = callProjectSummariser } = {}) {
  const [{ subjects, scope }, { stat, porcelain, diff }] = await Promise.all([commitScope(path), uncommittedChanges(path)]);
  let headSha = 'none';
  try { headSha = await git(path, 'rev-parse', 'HEAD'); } catch { /* empty repo */ }

  const summariser = getSummariser();
  if (!summariser || !binFor(summariser.group)) {
    return { path, scope, ...deterministicSummary(subjects, stat, porcelain), source: 'deterministic', llm: { ok: false, reason: 'no-summariser' } };
  }

  const cacheFile = cacheFileFor(path, headSha, diff, porcelain);
  try {
    const cached = JSON.parse(readFileSync(cacheFile, 'utf8'));
    return { ...cached, cached: true };
  } catch { /* no cache entry yet */ }

  const prompt = 'Summarize a git repo\'s committed and uncommitted changes into strict JSON '
    + '{"committed":string[],"uncommitted":string[]}. Max 5 terse bullets each, no prose, no markdown fence.\n\n'
    + `## Commits (${scope})\n${subjects.join('\n') || '(none)'}\n\n`
    + `## Uncommitted --stat\n${stat || '(none)'}\n\n## Uncommitted status --porcelain\n${porcelain || '(none)'}\n\n`
    + `## Uncommitted diff\n${truncatedDiff(diff) || '(none)'}`;

  let out = null, err = null;
  try { out = await callSummariser(prompt, summariser); } catch (e) { err = e.message; }
  const parsed = parseJsonSummary(out?.text);
  if (!parsed) {
    return { path, scope, ...deterministicSummary(subjects, stat, porcelain), source: 'deterministic', llm: { ok: false, error: err } };
  }
  const result = { path, scope, committed: parsed.committed, uncommitted: parsed.uncommitted, source: 'llm', model: summariser.id };
  try {
    mkdirSync(SUMMARY_CACHE_DIR, { recursive: true });
    reg.writeAtomic(cacheFile, JSON.stringify(result));
  } catch { /* cache write failure — still return the fresh result */ }
  return result;
}
