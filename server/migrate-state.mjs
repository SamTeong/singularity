// One-shot daemon-startup migration: flattens the old ~/.singularity layout into
// state/ + cache/. Idempotent + best-effort — skips entries already at the new
// path, ignores missing old entries. worktrees/ + tickets/ live at the repo
// root (trusted); tickets/ relocates there below, worktrees/ is git-registered
// and not auto-moved. Imported for its side effect from index.mjs only — NOT
// pulled into tests or the statusline script.
import { existsSync, mkdirSync, renameSync, cpSync, rmSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { APP_DIR, STATE_DIR, CACHE_DIR, TICKETS_DIR, REPORTS_DIR } from './app-dir.mjs';

// renameSync across volumes throws EXDEV — fall back to recursive copy + unlink
// so state on a different volume than TRUSTED_ROOT (e.g. macOS external state)
// doesn't strand tickets. Best-effort: swallow non-EXDEV as before; for EXDEV,
// do the copy+unlink and only swallow if THAT fails.
function renameAcrossVolume(old, neu) {
  try {
    renameSync(old, neu);
  } catch (err) {
    if (err && err.code === 'EXDEV') {
      cpSync(old, neu, { recursive: true });
      rmSync(old, { recursive: true, force: true });
    } else {
      throw err;
    }
  }
}

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
    try { renameAcrossVolume(old, neu); } catch { /* best-effort — leave in place */ }
  }
}

// tickets/ + worktrees/ moved to the repo root (trusted). Tickets relocate
// here from the previous state/tickets location (plain files → safe rename).
// Worktrees are git-registered: not auto-moved (renameSync would break the
// gitdir link) — new tasks create them at the new path; stale ones self-clean.
{
  const oldTickets = join(STATE_DIR, 'tickets');
  if (existsSync(oldTickets) && !existsSync(TICKETS_DIR)) {
    try { renameAcrossVolume(oldTickets, TICKETS_DIR); } catch { /* best-effort */ }
  }
}

// Background Report.md relocates from the transient .tickets/<short>/ to the
// persistent .reports/<short>/. Move any Report.md already written by a past
// background run, and stamp `reportDir` onto the stored task/history records so
// background.mjs reads from the new path (no fallback). Idempotent + best-effort.
{
  mkdirSync(REPORTS_DIR, { recursive: true });
  // 1. Move Report.md files left in ticket dirs into .reports/<short>/.
  if (existsSync(TICKETS_DIR)) {
    for (const entry of readdirSync(TICKETS_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const src = join(TICKETS_DIR, entry.name, 'Report.md');
      if (!existsSync(src)) continue;
      const dstDir = join(REPORTS_DIR, entry.name);
      const dst = join(dstDir, 'Report.md');
      if (existsSync(dst)) continue; // already migrated
      try { mkdirSync(dstDir, { recursive: true }); renameSync(src, dst); }
      catch { /* best-effort — leave in place */ }
    }
  }
  // 2. Stamp reportDir on background-tagged records still pointing at ticketDir.
  const tasksFile = join(STATE_DIR, 'tasks.json');
  if (existsSync(tasksFile)) {
    let raw;
    try { raw = JSON.parse(readFileSync(tasksFile, 'utf8')); } catch { raw = null; }
    if (raw) {
      const records = [...(raw.tasks || []), ...(raw.history || [])];
      let changed = false;
      for (const t of records) {
        if (!t || (t.tags || []).includes('background') !== true) continue;
        if (t.reportDir) continue;
        const short = typeof t.id === 'string' ? t.id.slice(0, 8) : null;
        if (!short) continue;
        t.reportDir = join(REPORTS_DIR, short);
        changed = true;
      }
      if (changed) {
        try { writeFileSync(tasksFile, JSON.stringify(raw, null, 2)); } catch { /* best-effort */ }
      }
    }
  }
}