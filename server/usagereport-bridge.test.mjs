import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRustBackend } from './rust-backend.mjs';

async function withBackend(fn) {
  const backend = createRustBackend({ binaryPath: process.env.SINGULARITY_RUST_BACKEND_BINARY });
  await backend.start();
  try { await fn(backend); } finally { await backend.stop(); }
}

function setEnv(vars) {
  const previous = {};
  for (const [key, value] of Object.entries(vars)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

test('spawned Rust bridge handles explicit usage report status, read, and generation requests', async () => {
  const fixture = mkdtempSync(join(tmpdir(), 'singularity-usage-report-bridge-'));
  const reportsDir = join(fixture, 'reports');
  mkdirSync(reportsDir);
  writeFileSync(join(reportsDir, 'report-1999-01-01_000000.html'), '<html>before</html>');
  const restoreEnv = setEnv({
    USAGE_REPORT_STATE: join(fixture, 'state'), SING_USAGE_REPORTS: undefined,
    HOME: fixture, USERPROFILE: fixture, CLAUDE_CONFIG_DIR: join(fixture, 'claude'),
    CODEX_HOME: join(fixture, 'codex'), SING_USAGE_SKILL: join(fixture, 'missing.mjs'),
  });
  try {
    await withBackend(async (backend) => {
      const status = await backend.usageReportStatus(reportsDir);
      assert.equal(status.exists, true);
      assert.equal(typeof status.at, 'number');
      assert.deepEqual(await backend.usageReportRead(reportsDir), { html: '<html>before</html>' });

      const generated = await backend.usageReportGenerate(reportsDir);
      assert.equal(generated.ok, true, generated.error);
      assert.equal(typeof generated.at, 'number');
      assert.match((await backend.usageReportRead(reportsDir)).html, /<!doctype html>/i);
    });
  } finally {
    restoreEnv();
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('bridge resolves reports dir from SING_USAGE_REPORTS when set', async () => {
  const fixture = mkdtempSync(join(tmpdir(), 'singularity-usage-report-env-'));
  const reportsDir = join(fixture, 'custom-reports');
  mkdirSync(reportsDir);
  writeFileSync(join(reportsDir, 'report-a.html'), '<html>env</html>');
  const restoreEnv = setEnv({ SING_USAGE_REPORTS: reportsDir, USAGE_REPORT_STATE: join(fixture, 'state') });
  try {
    await withBackend(async (backend) => {
      assert.equal((await backend.usageReportStatus()).exists, true);
      assert.deepEqual(await backend.usageReportRead(), { html: '<html>env</html>' });
    });
  } finally {
    restoreEnv();
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('bridge falls back to <dirname(USAGE_REPORT_STATE)>/reports when SING_USAGE_REPORTS is unset', async () => {
  const fixture = mkdtempSync(join(tmpdir(), 'singularity-usage-report-default-'));
  const stateDir = join(fixture, 'state');
  const reportsDir = join(fixture, 'reports');
  mkdirSync(stateDir);
  mkdirSync(reportsDir);
  writeFileSync(join(reportsDir, 'report-default.html'), '<html>default</html>');
  const restoreEnv = setEnv({ SING_USAGE_REPORTS: undefined, USAGE_REPORT_STATE: stateDir });
  try {
    await withBackend(async (backend) => {
      assert.equal((await backend.usageReportStatus()).exists, true);
      assert.deepEqual(await backend.usageReportRead(), { html: '<html>default</html>' });
    });
  } finally {
    restoreEnv();
    rmSync(fixture, { recursive: true, force: true });
  }
});
