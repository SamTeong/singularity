// Reap stale esbuild child processes before a build.
//
// Why: a backgrounded or killed `vite build` never runs vite's
// stopEsbuildService, so its esbuild service child lingers holding the
// inherited stdio pipe. The wrapper shell (cmd/Bash/ctx_shell) then never
// sees EOF → the task "hangs" indefinitely though the build finished in
// ~30s, and the abandoned cmd wrapper stays alive waiting on that pipe.
//
// Default: kill only ORPHAN esbuild (parent process dead). Safe — spares
// esbuild whose parent is a live `pnpm dev` / active build. Closes the pipes
// of killed-build wrappers so they finally exit.
//
// `--all`: kill ALL esbuild + ALL vite (incl. a live `pnpm dev`). Explicit
// opt-in only — no OS signal distinguishes an abandoned-but-alive dev server
// from an active one, so vite killing is always disruptive. Run directly:
//   node scripts/reap-build-orphans.mjs --all
import { execSync } from 'node:child_process';
import { platform } from 'node:os';

const all = process.argv.includes('--all');
const isWin = platform() === 'win32';
const silent = { stdio: 'ignore' };

function sh(cmd) {
  try { execSync(cmd, silent); } catch { /* none, or already gone */ }
}

if (isWin) {
  if (all) {
    sh('taskkill /F /IM esbuild.exe');
    sh(`powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name='node.exe'\\" | ` +
      `Where-Object { $_.CommandLine -like '*vite/bin/vite.js*' } | ` +
      `ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"`);
  } else {
    // Orphan esbuild only: parent PID no longer alive.
    sh(`powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name='esbuild.exe'\\" | ` +
      `Where-Object { -not (Get-Process -Id $_.ParentProcessId -ErrorAction SilentlyContinue) } | ` +
      `ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"`);
  }
} else {
  // Unix: pkill has no parent-alive filter; only the --all path is safe there.
  if (all) {
    sh('pkill -f esbuild');
    sh("pkill -f 'vite/bin/vite.js'");
  }
  // Default unix no-op: orphan detection needs ps ppid walking; this project
  // is Windows-primary, add if needed.
}