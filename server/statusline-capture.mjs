// Statusline hook invoked by Claude Code (~every 300ms) with a JSON payload on
// stdin. Standalone — imports app-dir.mjs (lightweight) not agents.mjs (pulls
// in node-pty, too heavy for a 300ms-cadence child process).
// Writes APP_DIR/cost/<session_id>.json for stats.mjs to read; prints a short
// line back for the TUI's statusline.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_DIR } from './app-dir.mjs';

function fmtMs(ms) {
  const m = Math.round(ms / 60000);
  return m < 60 ? `${m}m` : `${(m / 60).toFixed(1)}h`;
}

let raw = '';
process.stdin.on('data', (d) => { raw += d; });
process.stdin.on('end', () => {
  let payload;
  try { payload = JSON.parse(raw); } catch { process.exit(0); }
  const sessionId = payload?.session_id;
  if (!sessionId) process.exit(0);
  const cost = payload.cost || {};
  const costUsd = typeof cost.total_cost_usd === 'number' ? cost.total_cost_usd : null;
  const apiMs = typeof cost.total_api_duration_ms === 'number' ? cost.total_api_duration_ms : null;
  const wallMs = typeof cost.total_duration_ms === 'number' ? cost.total_duration_ms : null;
  try {
    mkdirSync(join(STATE_DIR, 'cost'), { recursive: true });
    writeFileSync(join(STATE_DIR, 'cost', `${sessionId}.json`), JSON.stringify({ costUsd, apiMs, wallMs, updatedAt: Date.now() }));
  } catch { /* best-effort — stats.mjs falls back to the pricing estimate */ }
  const parts = [];
  if (costUsd != null) parts.push(`$${costUsd.toFixed(2)}`);
  if (apiMs != null) parts.push(`api ${fmtMs(apiMs)}`);
  process.stdout.write(parts.join(' · '));
  process.exit(0);
});
