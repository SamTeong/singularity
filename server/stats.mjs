// Per-agent stats from the session .jsonl (turns + total tokens). Cost in $ is
// deliberately omitted — accurate $ needs per-model pricing that drifts; tokens
// + turns is the stable signal (use codeburn/estimator for spend).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export function parseSession(cwd, id) {
  const enc = cwd.replace(/[:\\/]/g, '-');
  const p = join(homedir(), '.claude', 'projects', enc, `${id}.jsonl`);
  if (!existsSync(p)) return { turns: 0, tokens: 0, exists: false };
  let turns = 0, tokens = 0;
  try {
    for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
      if (!line) continue;
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      if (o.type === 'assistant') turns++;
      const u = o.message?.usage;
      if (u) tokens += (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    }
  } catch { /* partial/locked file — return what we have */ }
  return { turns, tokens, exists: true };
}

// { id: {turns, tokens, exists} } for a list of {id, cwd}.
export function statsFor(agents) {
  const out = {};
  for (const a of agents) out[a.id] = parseSession(a.cwd, a.id);
  return out;
}
