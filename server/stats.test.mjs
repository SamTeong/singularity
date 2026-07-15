// Unit tests for per-agent stats: pricing-table cost estimate from a fake
// session .jsonl (parseSession) and the statusline-capture vs. estimate
// cost-source precedence (statsFor). Fixtures use the agents.test.mjs
// approach: write under the real ~/.claude/projects (and APP_DIR/cost),
// clean up in a finally. Run: npm test  (node --test server/)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { encodeCwd, APP_DIR } from './agents.mjs';
import { parseSession, statsFor } from './stats.mjs';

function writeTranscript(cwd, id, lines) {
  const dir = join(homedir(), '.claude', 'projects', encodeCwd(cwd));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return dir;
}

test('parseSession: turns/tokens/estCostUsd from a known-model usage block', () => {
  const cwd = 'C:\\definitely\\not\\a\\real\\repo\\path\\stats-known';
  const id = randomUUID();
  const dir = writeTranscript(cwd, id, [
    {
      type: 'assistant',
      message: {
        model: 'claude-sonnet-4-5-20250929',
        usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 200, cache_creation_input_tokens: 100 },
      },
    },
  ]);
  try {
    const result = parseSession(cwd, id);
    assert.equal(result.exists, true);
    assert.equal(result.turns, 1);
    assert.equal(result.tokens, 1800); // 1000+500+200+100
    // (1000*3 + 500*15)/1e6 + (200*3*0.1)/1e6 + (100*3*1.25)/1e6 = 0.010935
    assert.ok(Math.abs(result.estCostUsd - 0.010935) < 1e-9, result.estCostUsd);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parseSession: unknown model → estCostUsd stays null (tokens/turns still counted)', () => {
  const cwd = 'C:\\definitely\\not\\a\\real\\repo\\path\\stats-unknown';
  const id = randomUUID();
  const dir = writeTranscript(cwd, id, [
    { type: 'assistant', message: { model: 'gpt-4o', usage: { input_tokens: 10, output_tokens: 20 } } },
  ]);
  try {
    const result = parseSession(cwd, id);
    assert.equal(result.turns, 1);
    assert.equal(result.tokens, 30);
    assert.equal(result.estCostUsd, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('statsFor: statusline capture file present → costSource "statusline" wins over the estimate', () => {
  const cwd = 'C:\\definitely\\not\\a\\real\\repo\\path\\stats-statusline';
  const id = randomUUID();
  const dir = writeTranscript(cwd, id, [
    { type: 'assistant', message: { model: 'claude-sonnet-4-5', usage: { input_tokens: 100, output_tokens: 50 } } },
  ]);
  const costDir = join(APP_DIR, 'cost');
  const costFile = join(costDir, `${id}.json`);
  mkdirSync(costDir, { recursive: true });
  writeFileSync(costFile, JSON.stringify({ costUsd: 1.23, apiMs: 111, wallMs: 222 }));
  try {
    const out = statsFor([{ id, cwd }]);
    assert.equal(out[id].costSource, 'statusline');
    assert.equal(out[id].costUsd, 1.23);
    assert.equal(out[id].apiMs, 111);
    assert.equal(out[id].wallMs, 222);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(costFile, { force: true });
  }
});

test('statsFor: no capture file → costSource "estimate" (falls back to the pricing table)', () => {
  const cwd = 'C:\\definitely\\not\\a\\real\\repo\\path\\stats-estimate';
  const id = randomUUID();
  const dir = writeTranscript(cwd, id, [
    { type: 'assistant', message: { model: 'claude-sonnet-4-5', usage: { input_tokens: 100, output_tokens: 50 } } },
  ]);
  try {
    const out = statsFor([{ id, cwd }]);
    assert.equal(out[id].costSource, 'estimate');
    assert.ok(out[id].costUsd > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
