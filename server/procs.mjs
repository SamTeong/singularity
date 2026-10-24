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
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { liveProcessSnapshot } from './agents.mjs';

let procsBackend;
export function setProcsBackend(backend) { procsBackend = backend; }

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
  try {
    return await procsBackend.procsKillGuarded(pid, target.name, target.kind, IS_DARWIN);
  } catch (e) { return { ok: false, error: e.message }; }
}
