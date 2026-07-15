// One-shot daemon-startup migration: flattens the old ~/.singularity layout into
// state/ + cache/. Idempotent + best-effort — skips entries already at the new
// path, ignores missing old entries. worktrees/ stays at root (git-registered).
// Imported for its side effect from index.mjs only — NOT pulled into tests or
// the statusline script.
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { APP_DIR, STATE_DIR, CACHE_DIR } from './app-dir.mjs';

mkdirSync(STATE_DIR, { recursive: true });
mkdirSync(CACHE_DIR, { recursive: true });

// [name, destination dir] — old flat entry → new subdir.
const moves = [
  ['agents.json', STATE_DIR],
  ['tasks.json', STATE_DIR],
  ['crons.json', STATE_DIR],
  ['ollama.json', STATE_DIR],
  ['tickets', STATE_DIR],
  ['cost', STATE_DIR],
  ['usage-cache.json', CACHE_DIR],
  ['pw-ollama-profile', CACHE_DIR],
];
for (const [name, dir] of moves) {
  const old = join(APP_DIR, name);
  const neu = join(dir, name);
  if (existsSync(old) && !existsSync(neu)) {
    try { renameSync(old, neu); } catch { /* best-effort — leave in place */ }
  }
}