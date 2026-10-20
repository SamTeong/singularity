// generateReport: report exec goes through the injected Rust backend
// (setOneShotBackend, same injection point as one-shot.mjs's callers) with the
// 16MB buffer, 180s timeout and USAGE_REPORT_BROWSER env redirect intact; the
// legacy execFile fallback keeps standalone imports working.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'singularity-usagereport-'));
process.env.SINGULARITY_HOME = home;
const reportsDir = join(home, 'reports');
mkdirSync(reportsDir);

// A stand-in skill script: creates a report html and prints its path (the
// skill's stdout contract), so the legacy execFile branch is exercised too.
const skillStats = join(home, 'stats.mjs');
const reportPath = join(reportsDir, 'report-test.html');
process.env.SING_USAGE_SKILL = skillStats;
process.env.SING_USAGE_REPORTS = reportsDir;
writeFileSync(reportPath, '<html>ok</html>');
writeFileSync(skillStats, [
  `import { writeFileSync } from 'node:fs';`,
  `const p = ${JSON.stringify(reportPath)};`,
  `writeFileSync(p, '<html>ok</html>');`,
  `console.log(p);`,
].join('\n'));

const { generateReport } = await import('./usagereport.mjs');
const { setOneShotBackend } = await import('./one-shot.mjs');

function mockBackend(handler) {
  const calls = [];
  setOneShotBackend({
    async oneShot(bin, args, opts) {
      calls.push({ bin, args, opts });
      return handler({ bin, args, opts });
    },
  });
  return calls;
}

test('generateReport execs the skill through the Rust backend and resolves the report mtime', async () => {
  const calls = mockBackend(async () => ({ stdout: `${reportPath}\n` }));
  try {
    const r = await generateReport();
    assert.equal(r.ok, true);
    assert.equal(typeof r.at, 'number');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].bin, 'node');
    assert.deepEqual(calls[0].args, [skillStats, 'report']);
    assert.equal(calls[0].opts.maxBuffer, 16 * 1024 * 1024);
    assert.equal(calls[0].opts.timeout, 180_000);
    assert.equal(calls[0].opts.env.USAGE_REPORT_BROWSER, 'node');
  } finally { setOneShotBackend(undefined); }
});

test('generateReport surfaces a backend timeout as ok:false', async () => {
  mockBackend(async () => { throw new Error('Command timed out after 180000ms: node stats.mjs report'); });
  try {
    const r = await generateReport();
    assert.equal(r.ok, false);
    assert.match(r.error, /timed out/);
  } finally { setOneShotBackend(undefined); }
});

test('generateReport fails when skill stdout has no html path', async () => {
  mockBackend(async () => ({ stdout: 'no report here' }));
  try {
    assert.deepEqual(await generateReport(), { ok: false, error: 'report path not found in skill output' });
  } finally { setOneShotBackend(undefined); }
});

test('generateReport falls back to legacy execFile when no backend is wired', async () => {
  setOneShotBackend(undefined);
  const r = await generateReport();
  assert.equal(r.ok, true);
  assert.equal(typeof r.at, 'number');
});

// Fresh module instance (?query = separate ESM instance) with a missing
// SING_USAGE_SKILL for the not-found guard; restored afterwards.
test('generateReport reports a missing usage-report skill', async () => {
  const previous = process.env.SING_USAGE_SKILL;
  process.env.SING_USAGE_SKILL = join(home, 'no-such-skill.mjs');
  try {
    const fresh = await import('./usagereport.mjs?missing-skill');
    const r = await fresh.generateReport();
    assert.equal(r.ok, false);
    assert.match(r.error, /usage-report skill not found/);
  } finally {
    process.env.SING_USAGE_SKILL = previous;
  }
});