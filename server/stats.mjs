// Per-agent stats from the session .jsonl (turns + total tokens). Cost in $ is
// deliberately omitted — accurate $ needs per-model pricing that drifts; tokens
// + turns is the stable signal (use codeburn/estimator for spend).
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { encodeCwd } from './agents.mjs';

// Session logs grow to many MB and are polled every few seconds — cache the
// parse result keyed on (mtime, size) so unchanged files are never re-read
// (each full read is sync and stalls the pty relay).
const cache = new Map(); // path -> { mtimeMs, size, result }

export function parseSession(cwd, id) {
  const p = join(homedir(), '.claude', 'projects', encodeCwd(cwd), `${id}.jsonl`);
  let st;
  try { st = statSync(p); } catch { return { turns: 0, tokens: 0, exists: false }; }
  const hit = cache.get(p);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.result;
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
  const result = { turns, tokens, exists: true };
  cache.set(p, { mtimeMs: st.mtimeMs, size: st.size, result });
  return result;
}

// { id: {turns, tokens, exists} } for a list of {id, cwd}.
export function statsFor(agents) {
  const out = {};
  for (const a of agents) out[a.id] = parseSession(a.cwd, a.id);
  return out;
}
