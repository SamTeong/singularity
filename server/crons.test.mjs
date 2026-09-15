// Unit tests for cron job CRUD (createCron/updateCron/deleteCron/snapshotCrons)
// — pure state, no reg.create spawns (fire/runCron are never called). crons.mjs
// persists to APP_DIR/crons.json (APP_DIR derives from process.env.SINGULARITY_HOME
// via agents.mjs), so SINGULARITY_HOME is pointed at a scratch temp dir *before* the
// module graph is imported (dynamic import after the env tweak) to avoid touching
// the user's real crons.json. Run: npm test  (node --test server/)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, renameSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const scratch = mkdtempSync(join(tmpdir(), 'singularity-crons-test-'));
process.env.SINGULARITY_HOME = join(scratch, 'singularity');
after(() => rmSync(scratch, { recursive: true, force: true }));

const { createCron, updateCron, deleteCron, runCron, snapshotCrons } = await import('./crons.mjs');
const { bus, STATE_DIR } = await import('./agents.mjs');

function findJob(id) {
  return snapshotCrons().find((j) => j.id === id);
}

async function isolatedScheduledCron() {
  const fixture = { events: [], failWrite: false, spawns: 0, tick: null };
  const key = `cronFixture${Date.now()}${Math.random()}`;
  globalThis[key] = fixture;
  const data = (source) => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  const access = `const f = globalThis[${JSON.stringify(key)}];`;
  const agents = data(`${access}
    export const STATE_DIR = ${JSON.stringify(STATE_DIR)};
    export const bus = { emit: (...args) => f.events.push(args), on: () => {} };
    export function writeAtomic() { if (f.failWrite) throw new Error('disk full'); }
    export const isLive = () => false;
    export const create = () => { f.spawns++; return { id: 'spawned' }; };
    export const findByRunId = () => null;
    export const getStatus = () => null;
    export const kill = () => {};
  `);
  const source = readFileSync(new URL('./crons.mjs', import.meta.url), 'utf8')
    .replace("import { existsSync, readFileSync } from 'node:fs';", 'const existsSync = () => false;')
    .replace("import { CronExpressionParser } from 'cron-parser';", "const CronExpressionParser = { parse: () => ({ next: () => ({ getTime: () => 0, toISOString: () => '1970-01-01T00:00:00.000Z' }) }) };")
    .replace("import * as reg from './agents.mjs';", `import * as reg from '${agents}';`)
    .replace('let logger = null;', `${access} const setInterval = (fn) => { f.tick = fn; return { unref() {} }; }; let logger = null;`);
  const crons = await import(data(source));
  delete globalThis[key];
  return { fixture, crons };
}

test('createCron: throws on missing required fields', () => {
  assert.throws(() => createCron({ cronExpr: '* * * * *', description: 'p', cwd: 'C:\\x' })); // no title
  assert.throws(() => createCron({ title: 'n', description: 'p', cwd: 'C:\\x' })); // no cronExpr
});

test('createCron: throws on invalid cron expr and the job is NOT added', () => {
  const before = snapshotCrons().length;
  assert.throws(() => createCron({ title: 'bad-expr', cronExpr: 'not a cron', description: 'p', cwd: 'C:\\x' }));
  assert.equal(snapshotCrons().length, before);
});

test('createCron: retries an identical Idempotency-Key without another record, but rejects a changed payload', () => {
  const key = 'cron-lost-response';
  const body = { title: 'idempotent cron', cronExpr: '0 0 * * *', description: 'p', cwd: 'C:\\x', idempotencyKey: key };
  const first = createCron(body);
  const retry = createCron(body);
  assert.equal(retry.id, first.id);
  assert.equal(snapshotCrons().filter((job) => job.idempotencyKey === key).length, 1);
  assert.throws(() => createCron({ ...body, title: 'changed' }), (err) => err.statusCode === 409);
});

test('createCron: idempotency compares the original payload after an update', () => {
  const key = 'cron-original-payload';
  const body = { title: 'original cron', cronExpr: '0 0 * * *', description: 'p', cwd: 'C:\\x', idempotencyKey: key };
  const first = createCron(body);
  updateCron(first.id, { title: 'edited' });
  assert.equal(createCron(body).id, first.id);
  assert.throws(() => createCron({ ...body, title: 'edited' }), (err) => err.statusCode === 409);
});

test('updateCron: invalid cronExpr throws and leaves job.cronExpr unchanged', () => {
  const job = createCron({ title: 'update-me', cronExpr: '0 0 * * *', description: 'p', cwd: 'C:\\x', enabled: false });
  const before = snapshotCrons();
  assert.throws(() => updateCron(job.id, { title: 'changed', cronExpr: 'nonsense' }));
  assert.deepEqual(snapshotCrons(), before);
});

test('updateCron: blank required fields leave the entire snapshot unchanged', () => {
  const job = createCron({ title: 'required', cronExpr: '0 0 * * *', description: 'p', cwd: 'C:\\x' });
  const before = snapshotCrons();
  for (const field of ['title', 'description', 'cwd']) {
    for (const value of ['', '   ']) {
      assert.throws(() => updateCron(job.id, { enabled: false, [field]: value }), /required/);
      assert.deepEqual(snapshotCrons(), before);
    }
  }
});

test('CRUD: failed persistence preserves snapshot and emits no cron state', () => {
  const job = createCron({ title: 'failure', cronExpr: '0 0 * * *', description: 'p', cwd: 'C:\\x' });
  const before = snapshotCrons();
  const file = join(STATE_DIR, 'crons.json');
  const backup = `${file}.backup`;
  const events = [];
  const onCrons = (state) => events.push(state);
  renameSync(file, backup);
  mkdirSync(file); // Atomic rename cannot replace a directory with the new JSON file.
  bus.on('crons', onCrons);
  try {
    for (const mutate of [
      () => createCron({ title: 'new', cronExpr: '* * * * *', description: 'p', cwd: 'C:\\x' }),
      () => updateCron(job.id, { title: 'changed', enabled: false }),
      () => deleteCron(job.id),
    ]) {
      assert.throws(mutate, (err) => err.persistFailure === true);
      assert.deepEqual(snapshotCrons(), before);
      assert.deepEqual(events, []);
    }
  } finally {
    bus.off('crons', onCrons);
    rmSync(file, { recursive: true });
    renameSync(backup, file);
  }
});

test('deleteCron: throws on unknown id', () => {
  assert.throws(() => deleteCron('no-such-id'));
});

test('snapshotCrons: ISO nextFire for an enabled job, null after disabling via updateCron', () => {
  const job = createCron({ title: 'fires', cronExpr: '* * * * *', description: 'p', cwd: 'C:\\x', enabled: true });
  const nextFire = findJob(job.id).nextFire;
  assert.equal(typeof nextFire, 'string');
  assert.equal(new Date(nextFire).toISOString(), nextFire);

  updateCron(job.id, { enabled: false });
  assert.equal(findJob(job.id).nextFire, null);

  deleteCron(job.id);
});

test('runCron: durable pending intent blocks a duplicate after an unknown spawn outcome', () => {
  const job = createCron({ title: 'pending', cronExpr: '0 0 * * *', description: 'p', cwd: 'C:\\x', model: 'not-a-model', enabled: false });
  assert.throws(() => runCron(job.id), /working directory does not exist/);
  assert.ok(findJob(job.id).pendingRunId, 'intent survives the failed post-intent spawn path');
  assert.throws(() => runCron(job.id), /previous run still active/);
});

test('scheduled tick: begin-run disk failure is contained without spawning or publishing an in-memory error', async () => {
  const { fixture, crons } = await isolatedScheduledCron();
  crons.initCrons(null);
  const job = crons.createCron({ title: 'scheduled disk failure', cronExpr: '* * * * *', description: 'p', cwd: 'C:\\x', enabled: true });
  fixture.events.length = 0;
  fixture.failWrite = true;
  assert.doesNotThrow(() => fixture.tick());
  const after = crons.snapshotCrons().find((entry) => entry.id === job.id);
  assert.equal(fixture.spawns, 0);
  assert.equal(after.lastError, undefined);
  assert.equal(after.pendingRunId, undefined);
  assert.deepEqual(fixture.events, []);
});
