// 5h/7d history for the Usage view's history panel: the current window's
// account-level % readings per provider, plus an ESTIMATED per-session split
// (5h, Claude and Codex). The Rust backend computes the doc
// (rust/backend/src/usage_history.rs); this module resolves its roots.
// Read-only: USAGE_SKILL_STATE history files, ~/.claude/projects, ~/.codex/sessions.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { USAGE_SKILL_STATE } from './app-dir.mjs';
import { getModelPricesPath } from './model-prices.mjs';

export const HISTORY_PROVIDERS = ['claude', 'codex', 'ollama'];
// 7d = each provider's weekly account % only, no per-session split (TASK-10 option A).
export const HISTORY_WINDOWS = ['5h', '7d'];

// usage.mjs rotates usage-snapshots.jsonl into usage-snapshots-YYYY-MM.jsonl monthly.
export function newestSnapshotArchive() {
  let names; try { names = readdirSync(USAGE_SKILL_STATE); } catch { names = []; }
  const f = names.filter((n) => /^usage-snapshots-\d{4}-\d{2}\.jsonl$/.test(n)).sort().at(-1);
  return f ? join(USAGE_SKILL_STATE, f) : null;
}

// GET /api/usage/history?provider=&window= — null for an unknown provider or
// window (route 400s).
export async function getUsageHistory(backend, provider, now = Date.now(), windowKey = '5h') {
  if (!HISTORY_PROVIDERS.includes(provider) || !HISTORY_WINDOWS.includes(windowKey)) return null;
  return backend.usageHistory(provider, now, windowKey, {
    state_dir: USAGE_SKILL_STATE,
    pricing_path: getModelPricesPath(),
    claude_projects: join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects'),
    codex_sessions: join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'sessions'),
  });
}
