import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRustBackend } from './rust-backend.mjs';

test('spawned Rust bridge handles explicit usage report status, read, and generation requests', async () => {
  const fixture = mkdtempSync(join(tmpdir(), 'singularity-usage-report-bridge-'));
  const reportsDir = join(fixture, 'reports');
  const reportPath = join(reportsDir, 'report-é.html');
  const skillPath = join(fixture, '技能 report fixture.mjs');
  mkdirSync(reportsDir);
  writeFileSync(reportPath, '<html>before</html>');
  writeFileSync(skillPath, [
    "import { writeFileSync } from 'node:fs';",
    `const report = ${JSON.stringify(reportPath)};`,
    "if (process.env.USAGE_REPORT_BROWSER !== 'node') throw new Error('browser env missing');",
    "writeFileSync(report, '<html>generated</html>');",
    'console.log(report);',
  ].join('\n'));

  const backend = createRustBackend({ binaryPath: process.env.SINGULARITY_RUST_BACKEND_BINARY });
  try {
    await backend.start();
    const status = await backend.usageReportStatus(reportsDir, skillPath);
    assert.equal(status.exists, true);
    assert.equal(typeof status.at, 'number');
    assert.deepEqual(await backend.usageReportRead(reportsDir, skillPath), { html: '<html>before</html>' });

    const generated = await backend.usageReportGenerate(reportsDir, skillPath);
    assert.equal(generated.ok, true);
    assert.equal(typeof generated.at, 'number');
    assert.equal(readFileSync(reportPath, 'utf8'), '<html>generated</html>');
    assert.deepEqual(await backend.usageReportRead(reportsDir, skillPath), { html: '<html>generated</html>' });

    const missing = await backend.usageReportGenerate(reportsDir, join(fixture, 'missing skill.mjs'));
    assert.deepEqual(missing, { ok: false, error: `usage-report skill not found: ${join(fixture, 'missing skill.mjs')}` });
  } finally {
    await backend.stop();
    rmSync(fixture, { recursive: true, force: true });
  }
});
