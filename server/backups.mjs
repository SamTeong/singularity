// Backup writes into BACKUPS_DIR instead of a sibling `${p}.bak` — sibling
// backups collide with other tools (e.g. ~/.harness/app/generate.mjs) that
// write a write-once .bak to the same path and get silently clobbered.
import { existsSync, copyFileSync, mkdirSync, writeFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { BACKUPS_DIR } from './app-dir.mjs';

const KEEP = 5;

// Back up `absPath` into BACKUPS_DIR/<hash>/<epochMillis>.bak, pruning to the
// KEEP newest. Returns the backup path written, or null if the source is
// missing or the backup fails — saving the user's file matters more than this.
export function backupFile(absPath) {
  try {
    if (!existsSync(absPath)) return null;
    const key = createHash('sha256').update(absPath).digest('hex').slice(0, 16);
    const dir = join(BACKUPS_DIR, key);
    mkdirSync(dir, { recursive: true });
    const sourceFile = join(dir, 'source.txt');
    if (!existsSync(sourceFile)) writeFileSync(sourceFile, absPath);
    let stamp = Date.now();
    // eslint-disable-next-line no-constant-condition -- guard against successive
    // calls landing in the same millisecond (real on Windows).
    while (existsSync(join(dir, `${stamp}.bak`))) stamp++;
    const dest = join(dir, `${stamp}.bak`);
    copyFileSync(absPath, dest);
    const baks = readdirSync(dir)
      .filter((f) => f.endsWith('.bak'))
      .sort((a, b) => Number(b.slice(0, -4)) - Number(a.slice(0, -4)));
    for (const stale of baks.slice(KEEP)) unlinkSync(join(dir, stale));
    return dest;
  } catch { return null; }
}
