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
import { liveProcessSnapshot } from './agents.mjs';

const execFileP = promisify(execFile);

// The queued Rust backend owns the child-process execution once index.mjs
// wires this in (oneshot op: argv-only spawn, windowsHide, 8MB maxBuffer,
// timeout 0 = no deadline — parity with the scan's optionless execFile).
// Legacy in-process execFile otherwise, so standalone imports keep working.
let procsBackend;
export function setProcsBackend(backend) { procsBackend = backend; }

async function procsExecFile(bin, args, opts) {
  if (!procsBackend) return execFileP(bin, args, opts);
  return procsBackend.oneShot(bin, args, { timeout: 0 });
}

// The terminate itself runs on the Rust backend (procs_kill op — no signal
// primitive left in Node); legacy process.kill keeps standalone imports working.
async function killPid(pid) {
  if (procsBackend) return procsBackend.procsKill(pid);
  try { process.kill(pid); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
}

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..');
const IS_DARWIN = process.platform === 'darwin';
const SELF_PID = process.pid; // this daemon — its own row is always 'daemon', never killable

export async function scanClaude() {
  if (!procsBackend) return [];
  let snapshot;
  try {
    snapshot = await procsBackend.procsScanRaw();
  } catch {
    return [];
  }
  // Preserve the post-query sampling point: Rust has completed the OS query
  // and parsing before this synchronous registry snapshot is taken.
  const live = liveProcessSnapshot();
  try {
    return await procsBackend.procsClassify(snapshot, live.pids, live.sessions, REPO_ROOT, SELF_PID);
  } catch {
    return [];
  }
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
    // the small TOCTOU gap before the kill is unavoidable on darwin too.
    return killPid(pid);
  }
  try {
    const { stdout } = await procsExecFile('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `[bool](Get-CimInstance Win32_Process -Filter "ProcessId=${pid} AND Name='${target.name}'")`,
    ], { windowsHide: true });
    if (stdout.trim() !== 'True') return { ok: false, error: 'process changed before kill' };
  } catch (e) { return { ok: false, error: e.message }; }
  return killPid(pid);
}
