// Claude process scanner + guarded killer — powers the in-app task manager.
// Windows: query Win32_Process via built-in powershell.exe (CIM). Classifies
// each claude.exe as tracked / stale / external so the UI can safely target orphans.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { livePids } from './agents.mjs';

const execFileP = promisify(execFile);

// PS projects only the fields we need; DateTime formatted to avoid /Date()/ JSON noise.
const PS = [
  '-NoProfile', '-NonInteractive', '-Command',
  "Get-CimInstance Win32_Process -Filter \"Name='claude.exe'\" | " +
    "ForEach-Object { [PSCustomObject]@{ pid=$_.ProcessId; ppid=$_.ParentProcessId; " +
    "started=$_.CreationDate.ToString('yyyy-MM-ddTHH:mm:ss'); cmd=$_.CommandLine } } | ConvertTo-Json -Compress",
];

function extractSession(cmd) {
  const m = cmd && cmd.match(/--(?:session-id|resume)\s+(\S+)/);
  return m ? m[1].replace(/["']/g, '') : null;
}

export async function scanClaude() {
  let out;
  try {
    ({ stdout: out } = await execFileP('powershell.exe', PS, { windowsHide: true, maxBuffer: 4 * 1024 * 1024 }));
  } catch {
    return []; // no powershell / no matches
  }
  let rows;
  try { rows = JSON.parse(out.trim() || '[]'); } catch { return []; }
  if (!Array.isArray(rows)) rows = [rows]; // ConvertTo-Json emits a bare object for a single row
  const live = livePids();
  return rows.map((r) => {
    const session = extractSession(r.cmd);
    const kind = live.has(r.pid) ? 'tracked' : session ? 'stale' : 'external';
    return { pid: r.pid, ppid: r.ppid, started: r.started, session, kind };
  });
}

// Kill a PID only after re-verifying it is currently a claude.exe (loopback API guard).
export async function killClaudePid(pid) {
  const procs = await scanClaude();
  if (!procs.some((p) => p.pid === pid)) return { ok: false, error: 'not a claude.exe pid' };
  try { process.kill(pid); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
}
