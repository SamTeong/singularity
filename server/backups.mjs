// Backup writes into BACKUPS_DIR instead of a sibling `${p}.bak` — sibling
// backups collide with other tools (e.g. ~/.harness/app/generate.mjs) that
// write a write-once .bak to the same path and get silently clobbered.
import { existsSync, mkdirSync, writeFileSync, readdirSync, unlinkSync, copyFileSync } from 'node:fs';
import { access, copyFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { BACKUPS_DIR } from './app-dir.mjs';

const KEEP = 5;

// Shared, allocation-only part: the per-source backup dir + the stamped
// destination name. Cheap (string ops + one exclusive-create probe loop),
// safe to call from either the sync or async path.
function planBackup(absPath) {
  const key = createHash('sha256').update(absPath).digest('hex').slice(0, 16);
  const dir = join(BACKUPS_DIR, key);
  mkdirSync(dir, { recursive: true });
  let stamp = Date.now();
  let dest = join(dir, `${stamp}.bak`);
  // Claim the name with an exclusive create, not just an existsSync probe: two
  // concurrent async backupFile calls for the same path (autosave racing a
  // manual save) can both pass a plain existence check before either has
  // actually written its file, land on the same destination, and one silently
  // clobbers the other's backup. This whole loop is synchronous (no await),
  // so — unlike the two backupFile calls around it — it can't be interleaved
  // by another JS turn: whichever call reaches here first really does claim
  // the name first.
  while (true) {
    try { writeFileSync(dest, '', { flag: 'wx' }); break; }
    catch (e) { if (e.code !== 'EEXIST') throw e; stamp++; dest = join(dir, `${stamp}.bak`); }
  }
  return { dir, dest };
}

function staleBaks(dir) {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.bak'))
    .sort((a, b) => Number(b.slice(0, -4)) - Number(a.slice(0, -4)))
    .slice(KEEP);
}

// Back up `absPath` into BACKUPS_DIR/<hash>/<epochMillis>.bak, pruning to the
// KEEP newest. Returns the backup path written, or null if the source is
// missing or the backup fails — saving the user's file matters more than this.
//
// Async: the request-path writers (memory/rules/skills/explorer/config/hooks)
// await this so the file copy + directory scan never block the event loop —
// the daemon shares it with live PTY streaming and WS fan-out. Every one of
// those writers re-checks its mtime/force guard right after this await
// settles, since a concurrent save of the same path can land while this call
// yields. ponytail: that still leaves the writers' own `await writeFile`
// itself as an unguarded window — two saves that both pass the recheck can
// still race at the OS write, one clobbering the other with no 409. Accepted
// ceiling for a loopback single-user daemon; close with a per-path lock if
// this ever needs to be multi-writer-safe.
export async function backupFile(absPath) {
  try {
    await access(absPath);
    const { dir, dest } = planBackup(absPath);
    const sourceFile = join(dir, 'source.txt');
    if (!existsSync(sourceFile)) await writeFile(sourceFile, absPath);
    await copyFile(absPath, dest);
    const baks = (await readdir(dir))
      .filter((f) => f.endsWith('.bak'))
      .sort((a, b) => Number(b.slice(0, -4)) - Number(a.slice(0, -4)));
    for (const stale of baks.slice(KEEP)) {
      const staleFile = join(dir, stale);
      // Two concurrent backups for the same path can both pick the same file
      // to prune (each read the directory before the other's unlink landed).
      // POSIX reports that lost race as ENOENT; Windows observed here reports
      // EPERM instead — either way, if the file is actually gone the race was
      // harmless, so check existence rather than matching a specific code.
      try { await unlink(staleFile); } catch { if (existsSync(staleFile)) throw new Error(`prune failed: ${stale}`); }
    }
    return dest;
  } catch { return null; }
}

// Sync twin, for migrate-state.mjs only: it runs once at boot, before
// `listen`, imported for its side effect by index.mjs — no top-level await.
// Blocking at boot is fine; this is not on the request path.
export function backupFileSync(absPath) {
  try {
    if (!existsSync(absPath)) return null;
    const { dir, dest } = planBackup(absPath);
    const sourceFile = join(dir, 'source.txt');
    if (!existsSync(sourceFile)) writeFileSync(sourceFile, absPath);
    copyFileSync(absPath, dest);
    for (const stale of staleBaks(dir)) {
      const staleFile = join(dir, stale);
      try { unlinkSync(staleFile); } catch { if (existsSync(staleFile)) throw new Error(`prune failed: ${stale}`); }
    }
    return dest;
  } catch { return null; }
}
