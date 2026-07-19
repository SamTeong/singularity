// Claude process scanner + guarded killer — powers the in-app task manager.
// Windows: query Win32_Process via built-in powershell.exe (CIM). Classifies
// each claude.exe as tracked / stale / external so the UI can safely target orphans.
//
// Also scans this repo's own dev tooling (node.exe/esbuild.exe/OpenConsole.exe)
// scoped to cmdlines under REPO_ROOT — these can orphan and hold node_modules
// file locks open if their parent (pnpm dev/test) dies or gets killed.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { livePids } from './agents.mjs';

const execFileP = promisify(execFile);
const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..');

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

function extractSession(cmd) {
  const m = cmd && cmd.match(/--(?:session-id|resume)\s+(\S+)/);
  return m ? m[1].replace(/["']/g, '') : null;
}

// Dev-tooling rows are only ever considered if their cmdline is under this
// repo — never match unrelated node/esbuild processes elsewhere on the box.
function inRepo(cmd) { return !!cmd && cmd.toLowerCase().includes(REPO_ROOT.toLowerCase()); }

export async function scanClaude() {
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
      if (r.name === 'claude.exe') {
        const session = extractSession(r.cmd);
        const kind = live.has(r.pid) ? 'tracked' : session ? 'stale' : 'external';
        return { pid: r.pid, ppid: r.ppid, name: r.name, started: r.started, session, kind };
      }
      // Repo dev tooling: stale only if its parent (pnpm dev/test) is gone.
      const kind = alive.has(r.ppid) ? 'external' : 'stale';
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
