import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.SING_USAGE_SKILL = 'C:/reports/skill.mjs';
process.env.SING_USAGE_REPORTS = 'C:/reports/html';

const { reportStatus, latestReportHtml, generateReport, setUsageReportBackend, createUsageReportHandlers } = await import('./usagereport.mjs');

test('report adapter delegates each complete operation with configured paths', async () => {
  const calls = [];
  setUsageReportBackend({
    async usageReportStatus(...args) { calls.push(['status', ...args]); return { exists: true, at: 1234.5 }; },
    async usageReportRead(...args) { calls.push(['read', ...args]); return { html: '<html>✓</html>' }; },
    async usageReportGenerate(...args) { calls.push(['generate', ...args]); return { ok: true, at: null }; },
  });

  assert.deepEqual(await reportStatus(), { exists: true, at: 1234.5 });
  assert.equal(await latestReportHtml(), '<html>✓</html>');
  assert.deepEqual(await generateReport(), { ok: true, at: null });
  assert.deepEqual(calls, [
    ['status', 'C:/reports/html', 'C:/reports/skill.mjs'],
    ['read', 'C:/reports/html', 'C:/reports/skill.mjs'],
    ['generate', 'C:/reports/html', 'C:/reports/skill.mjs'],
  ]);
  setUsageReportBackend(undefined);
});

test('report adapter returns null HTML and propagates backend failures', async () => {
  setUsageReportBackend({
    async usageReportStatus() { throw new Error('bridge unavailable'); },
    async usageReportRead() { return { html: null }; },
    async usageReportGenerate() { return { ok: false, error: 'failed' }; },
  });
  assert.equal(await latestReportHtml(), null);
  await assert.rejects(reportStatus(), /bridge unavailable/);
  assert.deepEqual(await generateReport(), { ok: false, error: 'failed' });
  setUsageReportBackend(undefined);
});

test('report adapter requires the Rust backend', async () => {
  setUsageReportBackend(undefined);
  await assert.rejects(reportStatus(), /Usage report Rust backend is not configured/);
});

test('usage report route handlers preserve status, HTML, missing, and refresh contracts', async () => {
  setUsageReportBackend({
    async usageReportStatus() { return { exists: true, at: 1234.5 }; },
    async usageReportRead() { return { html: '<html>report</html>' }; },
    async usageReportGenerate() { return { ok: false, error: 'render failed' }; },
  });
  const handlers = createUsageReportHandlers();
  const reply = () => ({
    status: 200,
    contentType: null,
    body: undefined,
    code(status) { this.status = status; return this; },
    type(contentType) { this.contentType = contentType; return this; },
    send(body) { this.body = body; return body; },
  });

  assert.deepEqual(await handlers.status(), { exists: true, at: 1234.5 });
  const htmlReply = reply();
  assert.equal(await handlers.report({}, htmlReply), '<html>report</html>');
  assert.equal(htmlReply.contentType, 'text/html');
  const refreshReply = reply();
  assert.deepEqual(await handlers.refresh({}, refreshReply), { ok: false, error: 'render failed' });
  assert.equal(refreshReply.status, 400);

  setUsageReportBackend({
    async usageReportStatus() { return { exists: false, at: null }; },
    async usageReportRead() { return { html: null }; },
    async usageReportGenerate() { return { ok: true, at: null }; },
  });
  const missingReply = reply();
  assert.deepEqual(await handlers.report({}, missingReply), { ok: false, error: 'no report' });
  assert.equal(missingReply.status, 404);
  assert.deepEqual(await handlers.status(), { exists: false, at: null });
  const successReply = reply();
  assert.deepEqual(await handlers.refresh({}, successReply), { ok: true, at: null });
  assert.equal(successReply.status, 200);
  setUsageReportBackend(undefined);
});
