// Recover the codex thread uuid for an agent spawned into Codex CLI. Codex
// has no --session-id/--name flag — it mints its own uuid at spawn, only
// discoverable via the rollout file it writes under CODEX_HOME/sessions/. We
// match cwd + start time against session_meta (line 1 of each rollout).
// thread_source:"subagent" rollouts share the parent's session_id and often
// have the newest mtime in a cwd — must exclude, or a subagent fork wins.
import { existsSync, statSync, readdirSync, openSync, readSync, closeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CODEX_HOME } from './usage.mjs';

const HEAD_BYTES = 256 * 1024; // covers line 1's base_instructions blob

function normPath(p) {
  const r = resolve(p).replace(/\\/g, '/');
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

// Bounded recursive walk collecting rollout-*.jsonl, capped at `cap` files.
// archived_sessions is a separate unbounded tree — skip it.
function walk(base, acc, cap) {
  if (acc.length >= cap) return;
  let entries;
  try { entries = readdirSync(base, { withFileTypes: true }); } catch { return; }
  for (const ent of entries) {
    if (acc.length >= cap) return;
    if (ent.name === 'archived_sessions') continue;
    const p = join(base, ent.name);
    if (ent.isDirectory()) walk(p, acc, cap);
    else if (ent.name.startsWith('rollout-') && ent.name.endsWith('.jsonl')) acc.push(p);
  }
}

// Line 1 only — the rest of the file is tens of KB of system prompt we
// never need just to identify the thread.
function readFirstLine(path) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = readSync(fd, buf, 0, HEAD_BYTES, 0);
    const nl = buf.subarray(0, n).indexOf(0x0a);
    return nl < 0 ? null : JSON.parse(buf.subarray(0, nl).toString('utf8'));
  } catch {
    return null;
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch {} }
  }
}

export function findCodexThread(cwd, spawnedAt, { home = CODEX_HOME, skewMs = 5000, cap = 2000 } = {}) {
  try {
    if (!cwd || !spawnedAt) return null;
    const sessionsDir = join(home, 'sessions');
    if (!existsSync(sessionsDir)) return null;
    const files = [];
    walk(sessionsDir, files, cap);

    const wantCwd = normPath(cwd);
    const threshold = spawnedAt - skewMs;
    let best = null; // { ts, id } — greatest payload.timestamp (session start) wins
    for (const p of files) {
      let mtimeMs;
      try { mtimeMs = statSync(p).mtimeMs; } catch { continue; }
      if (mtimeMs < threshold) continue; // cheap prefilter before opening the file

      const meta = readFirstLine(p);
      const payload = meta?.payload;
      if (meta?.type !== 'session_meta' || payload?.thread_source !== 'user') continue;
      if (!payload.cwd || normPath(payload.cwd) !== wantCwd) continue;

      // payload.timestamp is session START time — the filename ts / mtime
      // are LAST-WRITE and not what "predates spawnedAt" should mean.
      const ts = Date.parse(payload.timestamp);
      if (!Number.isFinite(ts) || ts < threshold) continue;
      if (!best || ts > best.ts) best = { ts, id: payload.session_id || payload.id };
    }
    return best?.id || null;
  } catch {
    return null;
  }
}
