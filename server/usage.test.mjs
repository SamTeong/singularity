// Unit tests for usage normalization: the ollama HTML scraper parser and the
// claude OAuth-response mapper. No network — both operate on captured fixtures.
// usage.mjs pulls in app-dir.mjs (STATE_DIR/CACHE_DIR), which requires
// SINGULARITY_HOME — point it at a scratch temp dir before the dynamic import.
// Run: npm test  (node --test server/)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const scratch = mkdtempSync(join(tmpdir(), 'singularity-usage-test-'));
process.env.SINGULARITY_HOME = join(scratch, 'sing');
after(() => { rmSync(scratch, { recursive: true, force: true }); });

const { parseOllamaHtml, normalizeClaude } = await import('./usage.mjs');

// Trimmed to the parser-relevant markup from a real logged-in ollama.com/settings
// response: plan badge, Session then Weekly meter (aria-label + segment buttons),
// each followed by its reset data-time.
const OLLAMA_HTML = `
  <h2><span>Cloud usage</span>
    <span class="text-xs font-normal px-2 py-0.5 rounded-full bg-neutral-100 text-neutral-600 capitalize"
      >pro</span></h2>
  <div>
    <div class="flex justify-between mb-2"><span>Session usage</span><span>27.4% used</span></div>
    <div class="relative group" data-usage-meter>
      <div class="relative h-3" data-usage-track aria-label="Session usage 27.4% used">
        <div style="width: 27.4%;">
          <button data-usage-segment data-model="glm-5.2" data-requests="218" aria-label="glm-5.2: 218 requests"></button>
          <button data-usage-segment data-model="web search" data-requests="8" aria-label="web search: 8 requests"></button>
        </div>
      </div>
    </div>
    <div class="text-xs local-time" data-time="2026-07-14T08:00:00Z">Resets in 2 hours.</div>
  </div>
  <div>
    <div class="flex justify-between mb-2"><span>Weekly usage</span><span>27.4% used</span></div>
    <div class="relative group" data-usage-meter>
      <div class="relative h-3" data-usage-track aria-label="Weekly usage 27.4% used">
        <div style="width: 27.4%">
          <button data-usage-segment data-model="glm-5.2" data-requests="1029" aria-label="glm-5.2: 1029 requests"></button>
          <button data-usage-segment data-model="web search" data-requests="96" aria-label="web search: 96 requests"></button>
        </div>
      </div>
    </div>
    <div class="text-xs local-time" data-time="2026-07-20T00:00:00Z">Resets in 5 days.</div>
  </div>`;

test('parseOllamaHtml: plan, both windows, resets, per-model breakdown', () => {
  const u = parseOllamaHtml(OLLAMA_HTML);
  assert.equal(u.ok, true);
  assert.equal(u.source, 'ollama');
  assert.equal(u.plan, 'pro');

  assert.equal(u.session.pctUsed, 27.4);
  assert.equal(u.session.resetsAt, '2026-07-14T08:00:00Z');
  assert.deepEqual(u.session.models, [
    { model: 'glm-5.2', requests: 218 },
    { model: 'web search', requests: 8 },
  ]);

  assert.equal(u.weekly.pctUsed, 27.4);
  assert.equal(u.weekly.resetsAt, '2026-07-20T00:00:00Z');
  assert.deepEqual(u.weekly.models, [
    { model: 'glm-5.2', requests: 1029 },
    { model: 'web search', requests: 96 },
  ]);
});

test('parseOllamaHtml: login page (no meters) → null', () => {
  assert.equal(parseOllamaHtml('<html><body>Sign in</body></html>'), null);
});

// Sample shaped after the OAuth usage API (stats.mjs normalizer L1795-1812).
const CLAUDE_RAW = {
  five_hour: { utilization: 42, resets_at: '2026-07-14T13:00:00Z' },
  seven_day: { utilization: 63.5, resets_at: '2026-07-19T00:00:00Z' },
  seven_day_sonnet: { utilization: 30, resets_at: '2026-07-19T00:00:00Z' },
  seven_day_opus: { utilization: 71, resets_at: '2026-07-19T00:00:00Z' },
  seven_day_omelette: { utilization: 5, resets_at: '2026-07-19T00:00:00Z' },
  extra_usage: { is_enabled: true, used_credits: 12, monthly_limit: 40, utilization: 30 },
};

test('normalizeClaude: five_hour→session, seven_day→weekly, per-model + extra', () => {
  const u = normalizeClaude(CLAUDE_RAW, 'max');
  assert.equal(u.ok, true);
  assert.equal(u.source, 'claude');
  assert.equal(u.plan, 'max');

  assert.deepEqual(u.session, { pctUsed: 42, resetsAt: '2026-07-14T13:00:00Z', models: [] });
  assert.equal(u.weekly.pctUsed, 63.5);
  assert.equal(u.weekly.resetsAt, '2026-07-19T00:00:00Z');
  assert.deepEqual(u.weekly.models, [
    { model: 'sonnet', pctUsed: 30 },
    { model: 'opus', pctUsed: 71 },
    { model: 'design', pctUsed: 5 },
  ]);
  assert.deepEqual(u.extra, {
    enabled: true, used: 12, monthlyLimit: 40, pctUsed: 30, resetsAt: null,
  });
});

test('normalizeClaude: missing windows/extra → nulls, no throw', () => {
  const u = normalizeClaude({ five_hour: null, seven_day: null }, undefined);
  assert.equal(u.session, null);
  assert.equal(u.weekly, null);
  assert.equal(u.extra, null);
  assert.equal(u.plan, null);
});
