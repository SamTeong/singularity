// One-shot daemon-startup migration: flattens the old ~/.singularity layout into
// state/ + cache/. Idempotent + best-effort — skips entries already at the new
// path, ignores missing old entries. worktrees/ + tickets/ live at the repo
// root (trusted); tickets/ relocates there below, worktrees/ is git-registered
// and not auto-moved. Imported for its side effect from index.mjs only — NOT
// pulled into tests or the statusline script.
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { APP_DIR, STATE_DIR, CACHE_DIR, TICKETS_DIR } from './app-dir.mjs';

mkdirSync(STATE_DIR, { recursive: true });
mkdirSync(CACHE_DIR, { recursive: true });

// [name, destination dir] — old flat entry → new subdir.
const moves = [
  ['agents.json', STATE_DIR],
  ['tasks.json', STATE_DIR],
  ['crons.json', STATE_DIR],
  ['ollama.json', STATE_DIR],
  ['tickets', STATE_DIR],
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

// tickets/ + worktrees/ moved to the repo root (trusted). Tickets relocate
// here from the previous state/tickets location (plain files → safe rename).
// Worktrees are git-registered: not auto-moved (renameSync would break the
// gitdir link) — new tasks create them at the new path; stale ones self-clean.
{
  const oldTickets = join(STATE_DIR, 'tickets');
  if (existsSync(oldTickets) && !existsSync(TICKETS_DIR)) {
    try { renameSync(oldTickets, TICKETS_DIR); } catch { /* best-effort */ }
  }
}