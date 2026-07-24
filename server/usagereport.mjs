// Usage report: reuse the claude-code-usage-report skill as a black-box CLI.
// `stats.mjs report` renders a fully self-contained HTML report (zero external
// requests) into the skill's reports dir and prints the path to stdout. We spawn
// it on demand and serve the newest file to a sandboxed iframe — no render logic
// is duplicated here; the skill owns compute + render.
import { execFile } from 'node:child_process';
import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Skill CLI + report output dir — no defaults; both must be set in .env
// (index.mjs requireEnv fails the daemon fast if missing).
const SKILL_STATS = process.env.SING_USAGE_SKILL;
const REPORTS_DIR = process.env.SING_USAGE_REPORTS;

const REPORT_RE = /^report-.*\.html$/;

// Absolute path of the newest report-*.html (timestamped names sort lexically), or null.
function latestFile() {
  let names;
  try { names = readdirSync(REPORTS_DIR).filter((n) => REPORT_RE.test(n)); }
  catch { return null; }
  if (!names.length) return null;
  names.sort((a, b) => b.localeCompare(a));
  return join(REPORTS_DIR, names[0]);
}

export function reportStatus() {
  const f = latestFile();
  if (!f) return { exists: false, at: null };
  try { return { exists: true, at: statSync(f).mtimeMs }; }
  catch { return { exists: false, at: null }; }
}

// Newest report HTML, or null if none exists.
export function latestReportHtml() {
  const f = latestFile();
  if (!f) return null;
  try { return readFileSync(f, 'utf8'); } catch { return null; }
}

// Regenerate by spawning the skill's `report` command. USAGE_REPORT_BROWSER=node
// neutralizes the skill's auto-open on win32: node runs the .html, errors, and
// exits — so no browser window pops for a daemon-triggered refresh. Resolves
// { ok, at } (mtime, for client cache-busting) or { ok:false, error }.
export function generateReport() {
  if (!existsSync(SKILL_STATS)) {
    return Promise.resolve({ ok: false, error: `usage-report skill not found: ${SKILL_STATS}` });
  }
  return new Promise((resolve) => {
    execFile(
      'node', [SKILL_STATS, 'report'],
      { env: { ...process.env, USAGE_REPORT_BROWSER: 'node' }, maxBuffer: 16 * 1024 * 1024, timeout: 180_000 },
      (err, stdout) => {
        if (err) return resolve({ ok: false, error: err.message });
        const last = String(stdout).trim().split('\n').pop().trim();
        if (!last.endsWith('.html') || !existsSync(last)) {
          return resolve({ ok: false, error: 'report path not found in skill output' });
        }
        let at = null;
        try { at = statSync(last).mtimeMs; } catch {}
        resolve({ ok: true, at });
      },
    );
  });
}
