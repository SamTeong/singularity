// Claude process scanner + guarded killer — powers the in-app task manager.
// Windows: query Win32_Process via built-in powershell.exe (CIM). Classifies
// each claude.exe as tracked / stale / external so the UI can safely target
// orphans. Repo dev tooling (node/esbuild) is 'daemon' (live stack, protected)
// or 'stale' (orphan, killable) — never offered up as an unowned 'external'.
// macOS: `ps -axo pid=,ppid=,comm=,command=` (no started-time column in that
// format — the UI only shows it informatively, null is fine). Re-parented-to-
// launchd (ppid 0/1) => orphaned for the dev-tooling liveness test.
//
// Also scans this repo's own dev tooling (node.exe/esbuild.exe/OpenConsole.exe
// on Windows; node/esbuild on macOS) scoped to cmdlines under REPO_ROOT —
// these can orphan and hold node_modules file locks open if their parent
// (pnpm dev/test) dies or gets killed.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { livePids } from './agents.mjs';

const execFileP = promisify(execFile);
const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..');
const IS_DARWIN = process.platform === 'darwin';
const SELF_PID = process.pid; // this daemon — its own row is always 'daemon', never killable

// PS projects only the fields we need; DateTime formatted to avoid /Date()/ JSON noise.
// `alive` is the full running-pid set, used to tell a genuinely orphaned
// tooling process (parent gone) from one whose parent is still alive.
const PS = [
  '-NoProfile', '-NonInteractive', '-Command',
  "$rows = Get-CimInstance Win32_Process -Filter \"Name='claude.exe' or Name='node.exe' or Name='esbuild.exe' or Name='OpenConsole.exe'\" | " +
    "ForEach-Object { [PSCustomObject]@{ pid=$_.ProcessId; ppid=$_.ParentProcessId; name=$_.Name; " +
    "started=$_.CreationDate.ToString('yyyy-MM-ddTHH:mm:ss'); cmd=$_.CommandLine } }; " +
  "$alive = Get-Process | Select-Object -ExpandProperty Id; " +
  "[PSCustomObject]@{ rows=$rows; alive=$alive } | ConvertTo-Json -Compress -Depth 4",
];

// `ps` columns: pid, ppid, comm (basename of executable), command (full argv
// joined). `ps` has no reliable started-time column in this format — callers
// tolerate null (UI shows it only informatively).
const PS_ARGS = ['-axo', 'pid=,ppid=,comm=,command='];
// Dev-tooling binaries we care about on macOS (no .exe; OpenConsole is Windows-only).
const DARWIN_DEV_NAMES = new Set(['node', 'esbuild']);

function extractSession(cmd) {
  const m = cmd && cmd.match(/--(?:session-id|resume)\s+(\S+)/);
  return m ? m[1].replace(/["']/g, '') : null;
}

// Dev-tooling rows are only ever considered if their cmdline is under this
// repo — never match unrelated node/esbuild processes elsewhere on the box.
function inRepo(cmd) { return !!cmd && cmd.toLowerCase().includes(REPO_ROOT.toLowerCase()); }

// Classify a claude row: tracked if livePids() has it, else stale if a session
// id is recoverable from its cmdline, else external. Shared across platforms.
function classifyClaude(row, live) {
  const session = extractSession(row.cmd);
  const kind = live.has(row.pid) ? 'tracked' : session ? 'stale' : 'external';
  return { pid: row.pid, ppid: row.ppid, name: row.name, started: row.started, session, kind };
}

export async function scanClaude() {
  if (IS_DARWIN) return scanClaudeDarwin();
  return scanClaudeWindows();
}

async function scanClaudeWindows() {
  let out;
  try {
    ({ stdout: out } = await execFileP('powershell.exe', PS, { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }));
  } catch {
    return []; // no powershell / no matches
  }
  let parsed;
  try { parsed = JSON.parse(out.trim() || '{}'); } catch { return []; }
  let rows = parsed.rows || [];
  if (!Array.isArray(rows)) rows = [rows]; // ConvertTo-Json emits a bare object for a single row
  let alivePids = parsed.alive || [];
  if (!Array.isArray(alivePids)) alivePids = [alivePids];
  const alive = new Set(alivePids);
  const live = livePids();

  return rows
    .filter((r) => r.name === 'claude.exe' || inRepo(r.cmd))
    .map((r) => {
      if (r.name === 'claude.exe') return classifyClaude(r, live);
      // Repo dev tooling (already scoped to this clone by inRepo): part of the
      // live dev stack while its parent (pnpm dev/test) is alive => 'daemon',
      // protected. Orphaned (parent gone) => 'stale', safe to stop. The daemon's
      // own row is always 'daemon' even if detached from its launcher.
      const kind = r.pid === SELF_PID || alive.has(r.ppid) ? 'daemon' : 'stale';
      return { pid: r.pid, ppid: r.ppid, name: r.name, started: r.started, session: null, kind };
    });
}

async function scanClaudeDarwin() {
  let out;
  try {
    ({ stdout: out } = await execFileP('ps', PS_ARGS, { maxBuffer: 8 * 1024 * 1024 }));
  } catch {
    return []; // no ps / no matches
  }
  // Build a pid set of all currently-running processes for the orphan test
  // (stand-in for Windows' Get-Process alive set). A ppid of 0/1 means the
  // process was re-parented to launchd after its real parent died => orphaned.
  const allPids = new Set();
  const rows = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    // pid=,ppid=,comm=,command= — the first three columns are whitespace-
    // trimmed (trailing `=` strips padding); command is the rest of the line
    // with spaces preserved.
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    const name = m[3];
    const cmd = m[4] ?? '';
    allPids.add(pid);
    rows.push({ pid, ppid, name, started: null, cmd });
  }
  const live = livePids();
  return rows
    .filter((r) => r.name === 'claude' || (DARWIN_DEV_NAMES.has(r.name) && inRepo(r.cmd)))
    .map((r) => {
      if (r.name === 'claude') return classifyClaude(r, live);
      // Repo dev tooling (scoped to this clone by inRepo): live dev stack while
      // its parent survives => 'daemon', protected; orphaned => 'stale'. On
      // darwin liveness = ppid is a positive pid still in the ps rows; ppid 0/1
      // = re-parented to launchd => orphaned. Own row is always 'daemon'.
      const kind = r.pid === SELF_PID || (r.ppid > 1 && allPids.has(r.ppid)) ? 'daemon' : 'stale';
      return { pid: r.pid, ppid: r.ppid, name: r.name, started: r.started, session: null, kind };
    });
}

// Kill a PID only after re-verifying it is currently the same process name
// (loopback API guard). Two checks: the full scan above (for the caller's
// tracked/stale/external classification), then a single-PID re-query
// immediately before the kill to narrow the TOCTOU gap. A PID-reuse window
// remains between that re-query and the actual kill() call — unavoidable
// without an atomic OS-level primitive.
export async function killClaudePid(pid) {
  const procs = await scanClaude();
  const target = procs.find((p) => p.pid === pid);
  if (!target) return { ok: false, error: 'not a tracked process' };
  if (target.kind === 'daemon') return { ok: false, error: 'daemon process — cannot stop from here' };
  if (IS_DARWIN) {
    // Re-verify by re-scanning: the scan above found the pid only if it's
    // still a claude process. Skip the CIM re-query (Windows-only primitive);
    // the small TOCTOU gap before process.kill is unavoidable on darwin too.
    try { process.kill(pid); return { ok: true }; }
    catch (e) { return { ok: false, error: e.message }; }
  }
  try {
    const { stdout } = await execFileP('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `[bool](Get-CimInstance Win32_Process -Filter "ProcessId=${pid} AND Name='${target.name}'")`,
    ], { windowsHide: true });
    if (stdout.trim() !== 'True') return { ok: false, error: 'process changed before kill' };
  } catch (e) { return { ok: false, error: e.message }; }
  try { process.kill(pid); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
}
