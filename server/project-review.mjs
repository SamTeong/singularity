// Project review status: reads the shared project-review skill's ledger
// (PROJECT_REVIEW_DIR/project-review-log.md) to surface a tracked project's
// review runs + open/resolved finding counts on its card. Read-only — this
// module never writes the ledger or any run artifact (that's the skill's job,
// run by a separate agent/harness).
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { git } from './tasks.mjs';
import { contains } from './path-containment.mjs';

const PROJECT_REVIEW_DIR = process.env.PROJECT_REVIEW_DIR;
const IS_WIN = process.platform === 'win32';

// Ledger worktree paths are forward-slash-normalized per the skill's own
// contract ("normalize its absolute path with forward slashes"); a tracked
// project path here is whatever projects.json stored (native separators on
// win32). Fold both to the same shape before comparing.
const slashKey = (p) => {
  const s = String(p).replace(/\\/g, '/');
  return IS_WIN ? s.toLowerCase() : s;
};

function matchesWorktree(worktree, projectPath) {
  const w = slashKey(worktree);
  const p = slashKey(projectPath);
  return w === p || w.startsWith(`${p}/`);
}

// Markdown table row -> [Session ID, Worktree, Baseline SHA, Target SHA,
// Started at, Completed at, Harness, Model, Effort, Status, Artifacts].
// Skips the header row and the `| --- | ... |` separator row.
function parseLedgerRows(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('|')) continue;
    if (/^\|\s*-+\s*\|/.test(t)) continue;
    const cells = t.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length < 11 || cells[0] === 'Session ID') continue;
    rows.push(cells);
  }
  return rows;
}

function parseArtifacts(cell) {
  const links = [];
  const re = /\[([^\]]+)\]\(([^)]+)\)/g;
  let m;
  while ((m = re.exec(cell))) links.push({ label: m[1], rel: m[2] });
  return links;
}

const CATEGORY_SEV = { Blocker: 'P0', Major: 'P1', Minor: 'P2', Nit: 'P3' };

// Legacy Codex format: '#'/'##'/'### P<n> — title' (H1-H3, any of runs 1-3).
// New format (Phase 1 SKILL.md): '## P<n> — title'. Both match this one regex.
const P_HEADING_RE = /^#{1,3}\s+P([0-3])\s+—\s+(.+)$/;
// Legacy Claude Code category format: '## Blocker|Major|Minor|Nit' then
// '### F<n>. title' per finding, severity implied by the category.
const CATEGORY_RE = /^##\s+(Blocker|Major|Minor|Nit)\s*$/;
const F_HEADING_RE = /^###\s+F\d+\.\s+(.+)$/;
const STATUS_RE = /^Status:\s*(open|fixed|wontfix)\b/i;

// One markdown findings file -> [{sev, title, status, kind}]. `kind` is fixed
// per-file (introduced vs preexisting), passed in by the caller.
function parseFindingsFile(content, kind) {
  const withoutH1 = content.replace(/^#[^\n]*\n?/, '');
  if (withoutH1.trim() === 'No findings.') return [];

  const findings = [];
  let categorySev = null;
  let cur = null; // { sev, title, statusLine }
  const flush = () => {
    if (!cur) return;
    const m = cur.statusLine && cur.statusLine.match(STATUS_RE);
    findings.push({ sev: cur.sev, title: cur.title, status: m ? m[1].toLowerCase() : 'open', kind });
    cur = null;
  };

  for (const line of content.split('\n')) {
    let m = line.match(CATEGORY_RE);
    if (m) { categorySev = CATEGORY_SEV[m[1]]; continue; }
    m = line.match(P_HEADING_RE);
    if (m) { flush(); cur = { sev: `P${m[1]}`, title: m[2].trim(), statusLine: null }; continue; }
    m = line.match(F_HEADING_RE);
    if (m) { flush(); cur = { sev: categorySev ?? 'P3', title: m[1].trim(), statusLine: null }; continue; }
    if (cur && cur.statusLine === null && line.trim()) cur.statusLine = line.trim();
  }
  flush();
  return findings;
}

// All findings across every *.md file under <sid>/findings/ — file name
// 'preexisting*' => kind 'preexisting', else 'introduced'. Missing dir => [].
function readRunFindings(sessionId) {
  const dir = join(PROJECT_REVIEW_DIR, sessionId, 'findings');
  let names;
  try { names = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.md')).sort(); }
  catch { return []; }
  const findings = [];
  for (const name of names) {
    const kind = /^preexisting/i.test(name) ? 'preexisting' : 'introduced';
    const rel = `${sessionId}/findings/${name}`;
    let content;
    try { content = readFileSync(join(dir, name), 'utf8'); } catch { continue; }
    for (const f of parseFindingsFile(content, kind)) findings.push({ ...f, rel });
  }
  return findings;
}

function emptyCounts() {
  return { P0: 0, P1: 0, P2: 0, P3: 0, open: 0, resolved: 0 };
}
function addCounts(counts, findings) {
  for (const f of findings) {
    if (counts[f.sev] !== undefined) counts[f.sev]++;
    if (f.status === 'open') counts.open++; else counts.resolved++;
  }
}

// Response: { enabled: false } when PROJECT_REVIEW_DIR is unset. Otherwise
// { enabled: true, runs: [...newest first], latest: {...} | null }. `runs`
// covers every ledger row whose worktree matches `path` (itself, or a subdir
// of it — a ticket worktree reviewed under its own row). `latest` mirrors the
// most recent matching row's identity/status; its `counts` roll up every
// matching run's findings (a resolved finding is edited in place per the
// skill's continuation step, so history — not just the newest run — is the
// current backlog).
export async function reviewStatus(path) {
  if (!PROJECT_REVIEW_DIR) return { enabled: false };
  const ledgerFile = join(PROJECT_REVIEW_DIR, 'project-review-log.md');
  let text;
  try { text = readFileSync(ledgerFile, 'utf8'); } catch { return { enabled: true, runs: [], latest: null }; }

  const rows = parseLedgerRows(text).filter((cells) => matchesWorktree(cells[1], path));
  const runs = rows.map((cells) => {
    const [sessionId, worktree, baseline, target, startedAt, completedAt, harness, model, , status, artifactsCell] = cells;
    return {
      sessionId, worktree, baseline, target, startedAt, completedAt, harness, model, status,
      artifacts: parseArtifacts(artifactsCell),
      findings: readRunFindings(sessionId),
    };
  }).reverse(); // ledger rows are appended chronologically — newest first for the response

  if (!runs.length) return { enabled: true, runs, latest: null };

  const latestRun = runs[0];
  const counts = emptyCounts();
  for (const r of runs) addCounts(counts, r.findings);

  let commitsSince = null;
  if (latestRun.status === 'DONE') {
    try { commitsSince = Number(await git(path, 'rev-list', '--count', `${latestRun.target}..HEAD`)); }
    catch { commitsSince = null; } // target sha unknown to this worktree
  }

  return {
    enabled: true,
    runs,
    latest: { status: latestRun.status, target: latestRun.target, completedAt: latestRun.completedAt, commitsSince, counts },
  };
}

// GET /projects/review/file?rel=<sid>/findings/introduced.md — reads one
// artifact under PROJECT_REVIEW_DIR. Mirrors readMemoryFile's containment
// guard (memory.mjs): resolve, reject escape, .md only.
export function readReviewFile(rel) {
  if (!PROJECT_REVIEW_DIR) return { ok: false, error: 'project review not configured' };
  if (typeof rel !== 'string' || !rel || !rel.toLowerCase().endsWith('.md')) return { ok: false, error: 'bad path' };
  const abs = resolve(PROJECT_REVIEW_DIR, rel);
  if (!contains(PROJECT_REVIEW_DIR, abs)) return { ok: false, error: 'path outside project review dir' };
  if (!existsSync(abs)) return { ok: false, error: 'not found' };
  try { return { ok: true, content: readFileSync(abs, 'utf8') }; }
  catch (e) { return { ok: false, error: e.message }; }
}
