// Restore the execute bit on node-pty's macOS/Linux spawn-helper.
//
// node-pty execs every child through prebuilds/<platform>/spawn-helper. pnpm's
// content-addressed store can extract that prebuilt binary as 0644 (no +x),
// after which posix_spawnp fails for EVERY spawn — surfacing as
// "spawn failed: posix_spawnp failed" when the daemon starts a claude agent.
// A fresh `pnpm install` can reintroduce it, so this runs on postinstall.
import { chmodSync, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

if (process.platform === 'win32') process.exit(0); // conpty, no spawn-helper

try {
  const require = createRequire(import.meta.url);
  // node-pty/lib/index.js -> package root is two dirs up
  const root = dirname(dirname(require.resolve('node-pty')));
  for (const plat of ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64']) {
    const helper = join(root, 'prebuilds', plat, 'spawn-helper');
    if (!existsSync(helper)) continue;
    if (statSync(helper).mode & 0o111) continue; // already executable
    chmodSync(helper, 0o755);
    console.log(`fix-pty-helper: chmod +x ${plat}/spawn-helper`);
  }
} catch (e) {
  // Never fail the install over this best-effort guard.
  console.warn(`fix-pty-helper: skipped (${e.message})`);
}
