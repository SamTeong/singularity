// Unit tests for cron job CRUD (createCron/updateCron/deleteCron/snapshotCrons)
// — pure state, no reg.create spawns (fire/runCron are never called). crons.mjs
// persists to APP_DIR/crons.json (APP_DIR derives from process.env.APPDATA via
// agents.mjs), so APPDATA is pointed at a scratch temp dir *before* the module
// graph is imported (dynamic import after the env tweak) to avoid touching the
// user's real crons.json. Run: npm test  (node --test server/)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const scratch = mkdtempSync(join(tmpdir(), 'singularity-crons-test-'));
process.env.APPDATA = scratch;
after(() => rmSync(scratch, { recursive: true, force: true }));

const { createCron, updateCron, deleteCron, snapshotCrons } = await import('./crons.mjs');

function findJob(id) {
  return snapshotCrons().find((j) => j.id === id);
}

test('createCron: throws on missing required fields', () => {
  assert.throws(() => createCron({ cronExpr: '* * * * *', prompt: 'p', cwd: 'C:\\x' })); // no name
  assert.throws(() => createCron({ name: 'n', prompt: 'p', cwd: 'C:\\x' })); // no cronExpr
});

test('createCron: throws on invalid cron expr and the job is NOT added', () => {
  const before = snapshotCrons().length;
  assert.throws(() => createCron({ name: 'bad-expr', cronExpr: 'not a cron', prompt: 'p', cwd: 'C:\\x' }));
  assert.equal(snapshotCrons().length, before);
});

test('updateCron: invalid cronExpr throws and leaves job.cronExpr unchanged', () => {
  const job = createCron({ name: 'update-me', cronExpr: '0 0 * * *', prompt: 'p', cwd: 'C:\\x', enabled: false });
  assert.throws(() => updateCron(job.id, { cronExpr: 'nonsense' }));
  assert.equal(findJob(job.id).cronExpr, '0 0 * * *');
});

test('deleteCron: throws on unknown id', () => {
  assert.throws(() => deleteCron('no-such-id'));
});

test('snapshotCrons: ISO nextFire for an enabled job, null after disabling via updateCron', () => {
  const job = createCron({ name: 'fires', cronExpr: '* * * * *', prompt: 'p', cwd: 'C:\\x', enabled: true });
  const nextFire = findJob(job.id).nextFire;
  assert.equal(typeof nextFire, 'string');
  assert.equal(new Date(nextFire).toISOString(), nextFire);

  updateCron(job.id, { enabled: false });
  assert.equal(findJob(job.id).nextFire, null);

  deleteCron(job.id);
});
