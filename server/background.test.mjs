// Unit tests for the background-task pure functions (inWindow / evalGate /
// pickJob / pickRunnableJob / watchdogDecision / migrateLegacyConfig) +
// createTask tag normalization. background.mjs pulls in agents.mjs ->
// app-dir.mjs, which throws without SINGULARITY_HOME, so point it at a scratch
// temp dir *before* the dynamic import (same pattern as crons.test.mjs). No
// agent is ever spawned: the pure fns take a job argument, and the tags test
// exercises the exported normalizeTags helper directly rather than createTask
// (which would try to spawn a real claude). Run: npm test
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const scratch = mkdtempSync(join(tmpdir(), 'singularity-background-test-'));
process.env.SINGULARITY_HOME = join(scratch, 'singularity');
// Cleared so a non-claude model makes reg.create's buildSpawn throw
// synchronously ("ollama not found") instead of spawning a real process — the
// deterministic-failure trick tasks.test.mjs uses for its "failed spawn cleans
// up" tests, reused below for the healLiveBgTask regression test.
delete process.env.OLLAMA_BIN;
delete process.env.CODEX_BIN;
after(() => rmSync(scratch, { recursive: true, force: true }));

const { inWindow, evalGate, pickJob, pickRunnableJob, watchdogDecision, migrateLegacyConfig, createJob, updateJob, reorderJobs, snapshotBackground, listReports, getReport, setReportFlag, runBackgroundNow } = await import('./background.mjs');
const { normalizeTags, initTasks, snapshotTasks } = await import('./tasks.mjs');
const { STATE_DIR } = await import('./agents.mjs');

// Full per-job config shape (window/thresholds/tokenCaps) — same values the old
// global DEFAULT_CONFIG shipped, now owned by each job.
const job = (over = {}) => ({
  id: 'a', title: 'a', enabled: true, cooldownHours: 24, lastRunAt: null,
  window: { startHour: 9, endHour: 18, days: [1, 2, 3, 4, 5] },
  thresholds: {
    claude: { start: 50, stop: 75, weeklyMax: 75 },
    codex: { start: 50, stop: 75, weeklyMax: 75 },
    ollama: { start: 50, stop: 75, weeklyMax: 75 },
  },
  tokenCaps: { claude: 15_000_000, codex: 2_000_000, ollama: 2_000_000 },
  ...over,
});
const src = (over = {}) => ({ ok: true, session: { pctUsed: 10 }, weekly: { pctUsed: 10 }, ...over });

// Import an isolated scheduler with deterministic I/O; no task process is spawned.
async function isolatedBackground() {
  const fixture = { tasks: [], events: [], failWrite: false, failCreate: false, usage: async () => ({ claude: src() }) };
  const key = `backgroundFixture${Date.now()}${Math.random()}`;
  globalThis[key] = fixture;
  const data = (source) => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  const access = `const f = globalThis[${JSON.stringify(key)}];`;
  const mocks = {
    './agents.mjs': data(`${access} export const STATE_DIR = ${JSON.stringify(STATE_DIR)}; export const bus = { emit: (...args) => f.events.push(args) }; export const isLive = () => true; export function writeAtomic() { if (f.failWrite) throw new Error('disk full'); }`),
    './tasks.mjs': data(`${access} export const snapshotTasks = () => ({ tasks: f.tasks }); export const updateTask = async () => {}; export const createTask = (options) => { const task = { ...options, id: String(f.tasks.length), column: 'todo' }; f.tasks.push(task); if (f.failCreate) throw new Error('unknown create outcome'); return task; };`),
    './usage.mjs': data(`${access} export const getUsage = () => f.usage();`),
  };
  const source = readFileSync(new URL('./background.mjs', import.meta.url), 'utf8')
    .replace(/from '(\.\/[^']+)'/g, (_, path) => `from '${mocks[path] || new URL(path, import.meta.url).href}'`);
  const background = await import(data(source));
  delete globalThis[key];
  return { fixture, background };
}

test('background CRUD: failed persist leaves snapshots and events unchanged', async () => {
  const { fixture, background: b } = await isolatedBackground();
  const a = b.createJob({ title: 'a', description: 'd', cwd: 'x' });
  const other = b.createJob({ title: 'b', description: 'd', cwd: 'x' });
  const before = JSON.stringify(b.snapshotBackground());
  const held = b.snapshotBackground().config;
  fixture.events.length = 0;
  fixture.failWrite = true;
  for (const mutate of [
    () => b.createJob({ title: 'c', description: 'd', cwd: 'x' }),
    () => b.updateJob(a.id, { title: 'changed', thresholds: { claude: { start: 1 } }, window: { startHour: 0 } }),
    () => b.deleteJob(a.id),
    () => b.reorderJobs([other.id, a.id]),
  ]) {
    assert.throws(mutate, (e) => e.persistFailure === true);
    assert.equal(JSON.stringify(b.snapshotBackground()), before);
    assert.equal(JSON.stringify(held), JSON.stringify(b.snapshotBackground().config));
    assert.deepEqual(fixture.events, []);
  }
});

test('createJob: retries an identical Idempotency-Key without another record, but rejects a changed payload', () => {
  const key = 'background-lost-response';
  const body = { title: 'idempotent background', description: 'd', cwd: 'C:\\x', idempotencyKey: key };
  const first = createJob(body);
  const retry = createJob(body);
  assert.equal(retry.id, first.id);
  assert.equal(snapshotBackground().config.jobs.filter((job) => job.idempotencyKey === key).length, 1);
  assert.throws(() => createJob({ ...body, title: 'changed' }), (err) => err.statusCode === 409);
});

test('createJob: idempotency compares the original payload after an update', () => {
  const key = 'background-original-payload';
  const body = { title: 'original background', description: 'd', cwd: 'C:\\x', idempotencyKey: key };
  const first = createJob(body);
  updateJob(first.id, { title: 'edited' });
  assert.equal(createJob(body).id, first.id);
  assert.throws(() => createJob({ ...body, title: 'edited' }), (err) => err.statusCode === 409);
});

test('background attempts: reserve before healing and throughout usage await; release on failure', async () => {
  const { fixture, background: b } = await isolatedBackground();
  b.createJob({ title: 'a', description: 'd', cwd: 'x' });
  let release;
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  fixture.usage = () => { entered(); return new Promise((resolve) => { release = resolve; }); };
  const first = b.runBackgroundNow({ bypassWindow: true });
  await assert.rejects(b.runBackgroundNow({ force: true }), /already live/);
  await started;
  await assert.rejects(b.runBackgroundNow({ bypassWindow: true }), /already live/);
  release({ claude: src() });
  await first;
  assert.equal(fixture.tasks.length, 1);
  fixture.tasks.length = 0;
  b.updateJob(b.snapshotBackground().config.jobs[0].id, { lastRunAt: null });
  fixture.usage = async () => { throw new Error('usage failed'); };
  await assert.rejects(b.runBackgroundNow({ bypassWindow: true }), /usage failed/);
  await b.runBackgroundNow({ force: true });
  assert.equal(fixture.tasks.length, 1);
});

test('background attempts: an unknown create outcome retains its intent and blocks every job', async () => {
  const { fixture, background: b } = await isolatedBackground();
  const first = b.createJob({ title: 'a', description: 'd', cwd: 'x' });
  b.createJob({ title: 'b', description: 'd', cwd: 'x' });
  fixture.failCreate = true;
  await assert.rejects(b.runBackgroundNow({ force: true }), /unknown create outcome/);
  const pending = b.snapshotBackground().config.jobs.find((job) => job.id === first.id).pendingRunId;
  assert.ok(pending);
  await assert.rejects(b.runBackgroundNow({ force: true }), /unresolved pending intent/);
  await assert.rejects(b.runBackgroundNow({ bypassWindow: true }), /unresolved pending intent/);
  assert.equal(b.snapshotBackground().config.jobs.find((job) => job.id === first.id).pendingRunId, pending);
  assert.equal(fixture.tasks.length, 1, 'no other job may bypass the unknown single-flight intent');
});

// ---- inWindow ------------------------------------------------------------------
// 2026-07-15 = Wednesday (getDay 3), 2026-07-18 = Saturday (getDay 6).
test('inWindow: weekday inside hours is true', () => {
  assert.equal(inWindow(job(), new Date(2026, 6, 15, 10)), true);
});
test('inWindow: weekend is false', () => {
  assert.equal(inWindow(job(), new Date(2026, 6, 18, 10)), false);
});
test('inWindow: startHour inclusive, endHour exclusive', () => {
  assert.equal(inWindow(job(), new Date(2026, 6, 15, 9)), true);
  assert.equal(inWindow(job(), new Date(2026, 6, 15, 18)), false);
  assert.equal(inWindow(job(), new Date(2026, 6, 15, 8)), false);
});

// ---- evalGate ------------------------------------------------------------------
test('evalGate: claude within budget → claude', () => {
  const g = evalGate({ claude: src(), ollama: src() }, job());
  assert.equal(g.backend, 'claude');
});
test('evalGate: claude over start → ollama', () => {
  const g = evalGate({ claude: src({ session: { pctUsed: 60 } }), ollama: src() }, job());
  assert.equal(g.backend, 'ollama');
});
test('evalGate: both over → null with reason', () => {
  const g = evalGate({
    claude: src({ session: { pctUsed: 60 } }),
    ollama: src({ weekly: { pctUsed: 80 } }),
  }, job());
  assert.equal(g.backend, null);
  assert.equal(typeof g.reason, 'string');
  assert.ok(g.reason.length > 0);
});
test('evalGate: claude ok:false fails closed → ollama evaluated', () => {
  const g = evalGate({ claude: { ok: false, error: 'auth' }, ollama: src() }, job());
  assert.equal(g.backend, 'ollama');
});
test('evalGate: codex usage unavailable fails closed → falls through to ollama', () => {
  const g = evalGate({
    claude: src({ session: { pctUsed: 60 } }),
    codex: { ok: false, error: 'no Codex sessions found' },
    ollama: src(),
  }, job());
  assert.equal(g.backend, 'ollama');
});
test('evalGate: realistic codex shape (session:null, weekly under weeklyMax) passes its gate → codex', () => {
  const g = evalGate({
    claude: src({ session: { pctUsed: 60 } }),
    codex: { ok: true, source: 'codex', session: null, weekly: { pctUsed: 10 } },
    ollama: src(),
  }, job());
  assert.equal(g.backend, 'codex');
});
test('evalGate: realistic codex shape (session:null, weekly over weeklyMax) fails its gate → falls through to ollama', () => {
  const g = evalGate({
    claude: src({ session: { pctUsed: 60 } }),
    codex: { ok: true, source: 'codex', session: null, weekly: { pctUsed: 90 } },
    ollama: src(),
  }, job());
  assert.equal(g.backend, 'ollama');
});
test('evalGate: both windows null still fails closed with "usage incomplete"', () => {
  const g = evalGate({
    claude: { ok: true, session: null, weekly: null },
    codex: { ok: false, error: 'no Codex sessions found' },
    ollama: src({ session: { pctUsed: 90 } }),
  }, job());
  assert.equal(g.backend, null);
  assert.ok(g.reason.includes('claude usage incomplete'), 'reason names the incomplete backend');
});

// ---- pickJob (forced-bypass: ignores window+gate) -------------------------------
const now = 1_000_000_000_000;
const hr = 3_600_000;
test('pickJob: cooldown excludes a recently-run job', () => {
  const jobs = [job({ lastRunAt: now - hr })];
  assert.equal(pickJob(jobs, now), null);
});
test('pickJob: round-robin picks the oldest lastRunAt', () => {
  const jobs = [
    job({ id: 'new', cooldownHours: 1, lastRunAt: now - 2 * hr }),
    job({ id: 'old', cooldownHours: 1, lastRunAt: now - 10 * hr }),
  ];
  assert.equal(pickJob(jobs, now).id, 'old');
});
test('pickJob: null lastRunAt wins (never run)', () => {
  const jobs = [
    job({ id: 'ran', cooldownHours: 1, lastRunAt: now - 10 * hr }),
    job({ id: 'fresh', cooldownHours: 1, lastRunAt: null }),
  ];
  assert.equal(pickJob(jobs, now).id, 'fresh');
});
test('pickJob: disabled jobs are skipped', () => {
  const jobs = [job({ enabled: false, cooldownHours: 1, lastRunAt: null })];
  assert.equal(pickJob(jobs, now), null);
});
test('pickJob: pending intents are skipped', () => {
  assert.equal(pickJob([job({ pendingRunId: 'unknown' })], now), null);
});

// ---- pickRunnableJob (normal path: window + per-job gate folded together) ------
// Fixed instant inside the default window (Wed 2026-07-15 10:00 local).
const inWin = new Date(2026, 6, 15, 10).getTime();
const outWin = new Date(2026, 6, 18, 10).getTime(); // Saturday

test('pickRunnableJob: out-of-window job is skipped → did not find eligible task to run', () => {
  const jobs = [job({ lastRunAt: null })];
  const r = pickRunnableJob(jobs, { claude: src(), ollama: src() }, outWin);
  assert.equal(r.job, null);
  assert.equal(r.backend, null);
  assert.equal(r.reason, 'did not find eligible task to run');
});
test('pickRunnableJob: bypassWindow picks an out-of-window job if its gate passes', () => {
  const jobs = [job({ lastRunAt: null })];
  const r = pickRunnableJob(jobs, { claude: src(), ollama: src() }, outWin, { bypassWindow: true });
  assert.equal(r.job.id, 'a');
  assert.equal(r.backend, 'claude');
});
test('pickRunnableJob: pending intents are skipped', () => {
  assert.equal(pickRunnableJob([job({ pendingRunId: 'unknown' })], { claude: src() }, inWin).job, null);
});
test('pickRunnableJob: all in-window candidates fail their own gate → joined reasons', () => {
  const jobs = [job({ id: 'x', title: 'x', lastRunAt: null })];
  const usage = { claude: src({ session: { pctUsed: 90 } }), ollama: src({ session: { pctUsed: 90 } }) };
  const r = pickRunnableJob(jobs, usage, inWin);
  assert.equal(r.job, null);
  assert.ok(r.reason.includes('x:'), 'reason names the failing job');
});
test('pickRunnableJob: oldest passing candidate wins, skipping a younger passer', () => {
  const jobs = [
    job({ id: 'new', cooldownHours: 1, lastRunAt: inWin - 2 * hr }),
    job({ id: 'old', cooldownHours: 1, lastRunAt: inWin - 10 * hr }),
  ];
  const r = pickRunnableJob(jobs, { claude: src(), ollama: src() }, inWin);
  assert.equal(r.job.id, 'old');
  assert.equal(r.backend, 'claude');
});

// ---- watchdogDecision ----------------------------------------------------------
test('watchdogDecision: session pct at/over stop → stop', () => {
  assert.equal(watchdogDecision({ claude: src({ session: { pctUsed: 75 } }) }, 'claude', job(), 0), 'stop');
});
test('watchdogDecision: weekly at/over weeklyMax → stop', () => {
  assert.equal(watchdogDecision({ claude: src({ weekly: { pctUsed: 90 } }) }, 'claude', job(), 0), 'stop');
});
test('watchdogDecision: token cap reached → stop', () => {
  assert.equal(watchdogDecision({ claude: src() }, 'claude', job(), 15_000_000), 'stop');
});
test('watchdogDecision: ok:false fails closed → stop', () => {
  assert.equal(watchdogDecision({ claude: { ok: false } }, 'claude', job(), 0), 'stop');
});
test('watchdogDecision: within budget → continue', () => {
  assert.equal(watchdogDecision({ claude: src() }, 'claude', job(), 100), 'continue');
});

// ---- migrateLegacyConfig (global → per-job seeding) ----------------------------
test('migrateLegacyConfig: old flat shape seeds window/thresholds/models/tokenCaps onto every job', () => {
  const legacyWindow = { startHour: 8, endHour: 17, days: [1, 2, 3, 4, 5] };
  const legacyThresholds = { claude: { start: 40, stop: 70, weeklyMax: 70 }, ollama: { start: 40, stop: 70, weeklyMax: 70 } };
  const legacyModels = { claude: 'opus', ollama: 'glm-5.2:cloud' };
  const legacyTokenCaps = { claude: 10_000_000, ollama: 1_000_000 };
  const loaded = {
    enabled: true, tickMinutes: 60,
    window: legacyWindow, thresholds: legacyThresholds, models: legacyModels, tokenCaps: legacyTokenCaps,
    jobs: [{ id: 'a', title: 'A', enabled: true, cooldownHours: 24, lastRunAt: null }],
  };
  const { jobs, migrated } = migrateLegacyConfig(loaded);
  assert.equal(migrated, true);
  assert.deepEqual(jobs[0].window, legacyWindow);
  assert.deepEqual(jobs[0].thresholds, legacyThresholds);
  assert.deepEqual(jobs[0].models, legacyModels);
  assert.deepEqual(jobs[0].tokenCaps, legacyTokenCaps);
});
test('migrateLegacyConfig: a job with its own config is left untouched even when legacy keys are present', () => {
  const ownWindow = { startHour: 7, endHour: 12, days: [6, 0] };
  const loaded = {
    window: { startHour: 8, endHour: 17, days: [1, 2, 3, 4, 5] },
    jobs: [{ id: 'a', window: ownWindow }],
  };
  const { jobs, migrated } = migrateLegacyConfig(loaded);
  assert.equal(migrated, true);
  assert.deepEqual(jobs[0].window, ownWindow, 'own window not clobbered by legacy top-level window');
});
test('migrateLegacyConfig: already-migrated shape (no legacy keys) is a no-op', () => {
  const loaded = { jobs: [{ id: 'a', window: { startHour: 9, endHour: 18, days: [1] } }] };
  const { jobs, migrated } = migrateLegacyConfig(loaded);
  assert.equal(migrated, false);
  assert.deepEqual(jobs, loaded.jobs);
});

// ---- normalizeTags (createTask tag handling) -----------------------------------
test('normalizeTags: trims, lowercases, drops blanks, dedupes', () => {
  assert.deepEqual(normalizeTags(['  Background ', 'BACKGROUND', 'Wiki', '', '  ']), ['background', 'wiki']);
});
test('normalizeTags: undefined/empty → []', () => {
  assert.deepEqual(normalizeTags(undefined), []);
  assert.deepEqual(normalizeTags([]), []);
});

// ---- conclude field (createJob/updateJob) --------------------------------------
test('createJob: conclude defaults to "inreview"', () => {
  const d = createJob({ title: 'conclude-default', description: 'd', cwd: 'C:\\x' });
  assert.equal(d.conclude, 'inreview');
});
test('createJob: seeds codex thresholds/model/tokenCap defaults', () => {
  const d = createJob({ title: 'codex-defaults', description: 'd', cwd: 'C:\\x' });
  assert.deepEqual(d.thresholds.codex, { start: 50, stop: 75, weeklyMax: 50 });
  assert.equal(d.models.codex, 'gpt-5.6-luna');
  assert.equal(d.tokenCaps.codex, 15_000_000);
});
test('createJob: rejects an invalid conclude value', () => {
  assert.throws(() => createJob({ title: 'conclude-bad', description: 'd', cwd: 'C:\\x', conclude: 'garbage' }));
});
test('updateJob: accepts conclude "done"', () => {
  const d = createJob({ title: 'conclude-update', description: 'd', cwd: 'C:\\x' });
  assert.equal(updateJob(d.id, { conclude: 'done' }).conclude, 'done');
});
test('updateJob: rejects a garbage conclude value', () => {
  const d = createJob({ title: 'conclude-update-bad', description: 'd', cwd: 'C:\\x' });
  assert.throws(() => updateJob(d.id, { conclude: 'garbage' }));
});

// ---- reorderJobs (cosmetic row order) ------------------------------------------
test('reorderJobs: reorders config.jobs by id list; omitted ids sink to the tail', () => {
  const a = createJob({ title: 'ro-a', description: 'd', cwd: 'C:\\x' });
  const b = createJob({ title: 'ro-b', description: 'd', cwd: 'C:\\x' });
  const c = createJob({ title: 'ro-c', description: 'd', cwd: 'C:\\x' });
  reorderJobs([c.id, b.id, a.id]);
  const pos = (id) => snapshotBackground().config.jobs.findIndex((x) => x.id === id);
  assert.ok(pos(c.id) < pos(b.id) && pos(b.id) < pos(a.id), 'listed ids follow the given order');
  reorderJobs([a.id]); // b, c omitted → keep their relative order after a
  assert.ok(pos(a.id) < pos(b.id) && pos(a.id) < pos(c.id) && pos(c.id) < pos(b.id), 'omitted ids sink to tail, relative order kept');
});
test('reorderJobs: rejects a non-array', () => assert.throws(() => reorderJobs('nope')));

// ---- reports (listReports / getReport) -----------------------------------------
test('listReports/getReport: background-tagged entries with correct hasReport, non-background excluded, content read/missing', () => {
  const ticketA = join(scratch, 'ticket-a'); // has a Report.md
  const ticketB = join(scratch, 'ticket-b'); // no Report.md
  const reportC = join(scratch, 'report-c'); // persistent reportDir with a Report.md
  mkdirSync(ticketA, { recursive: true });
  mkdirSync(ticketB, { recursive: true });
  mkdirSync(reportC, { recursive: true });
  writeFileSync(join(ticketA, 'Report.md'), '# report a\n');
  writeFileSync(join(reportC, 'Report.md'), '# report c\n');
  writeFileSync(join(STATE_DIR, 'tasks.json'), JSON.stringify({
    tasks: [
      { id: 'live1', title: 'Live BG', tags: ['background'], ticketDir: ticketA, reportDir: ticketA, column: 'inprogress', createdAt: 1000 },
      { id: 'live2', title: 'Not BG', tags: [], ticketDir: ticketB, column: 'todo', createdAt: 2000 },
      // reportDir distinct from ticketDir (no Report.md in ticketDir) → read from reportDir
      { id: 'live3', title: 'Live BG w/ reportDir', tags: ['background'], ticketDir: ticketB, reportDir: reportC, column: 'inprogress', createdAt: 1500 },
    ],
    history: [
      { id: 'hist1', title: 'Hist BG', tags: ['background'], ticketDir: ticketB, reportDir: ticketB, outcome: 'completed', concludedAt: 3000, createdAt: 500 },
    ],
  }));
  initTasks();

  const reports = listReports();
  const ids = reports.map((r) => r.taskId);
  assert.ok(ids.includes('live1'));
  assert.ok(ids.includes('hist1'));
  assert.ok(!ids.includes('live2'), 'non-background task excluded');
  assert.equal(reports[0].taskId, 'hist1', 'newest first (concludedAt 3000 beats live1 createdAt 1000)');

  const live1 = reports.find((r) => r.taskId === 'live1');
  assert.equal(live1.hasReport, true);
  assert.equal(live1.status, 'inprogress');

  const hist1 = reports.find((r) => r.taskId === 'hist1');
  assert.equal(hist1.hasReport, false);
  assert.equal(hist1.status, 'completed');
  assert.equal(hist1.concludedAt, 3000);

  const live3 = reports.find((r) => r.taskId === 'live3');
  assert.equal(live3.hasReport, true, 'reportDir Report.md found (ticketDir has none)');

  assert.equal(getReport('live1').content, '# report a\n');
  assert.equal(getReport('live3').content, '# report c\n', 'reportDir read when distinct from ticketDir');
  assert.equal(getReport('hist1'), null, 'no Report.md written for this one');
  assert.equal(getReport('live2'), null, 'not background-tagged');
  assert.equal(getReport('nope'), null, 'unknown id');
});

// ---- setReportFlag (flag-state, depends on tasks.json set up above) ------------
test('setReportFlag: new reports default flagged; unflag/flag persists across listReports', () => {
  assert.equal(listReports().find((r) => r.taskId === 'live1').flagged, true, 'flagged by default');
  setReportFlag('live1', false);
  assert.equal(listReports().find((r) => r.taskId === 'live1').flagged, false, 'unflagged');
  setReportFlag('live1', true);
  assert.equal(listReports().find((r) => r.taskId === 'live1').flagged, true, 'flagged again');
});
test('setReportFlag: rejects an unknown report id', () => {
  assert.throws(() => setReportFlag('nope', true));
});

// ---- healLiveBgTask (dead-session single-flight escape hatch) -----------------
// A background run's session can die (crash, kill, pty exit) without the
// agent ever curl-ing itself off todo/inprogress, which used to leave
// liveBgTask() latched forever. Seed a task stuck in 'inprogress' with a
// sessionId that was never reg.create'd (so reg.isLive() is false for it) —
// no real createTask/spawn involved — and confirm it gets released, and that
// a subsequent run attempt is no longer refused by the single-flight guard.
function initGitRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'sing-bg-repo-'));
  execFileSync('git', ['-C', repo, 'init', '-q']);
  execFileSync('git', ['-C', repo, 'config', 'user.email', 'x@x.com']);
  execFileSync('git', ['-C', repo, 'config', 'user.name', 'x']);
  writeFileSync(join(repo, 'f.txt'), 'x');
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'init']);
  return repo;
}

test('healLiveBgTask releases a task whose session is dead, unblocking the next run', async () => {
  const deadSessionId = 'dead-session-does-not-exist';
  writeFileSync(join(STATE_DIR, 'tasks.json'), JSON.stringify({
    tasks: [
      // live1/live3 are the background-tagged, still-'inprogress' fixtures the
      // listReports test above seeded (initTasks only ever adds/overwrites by
      // id, never clears) — untag them here so they don't also latch the
      // single-flight guard and mask what this test is actually checking.
      { id: 'live1', title: 'Live BG', tags: [], column: 'inprogress', createdAt: 1000 },
      { id: 'live3', title: 'Live BG w/ reportDir', tags: [], column: 'inprogress', createdAt: 1500 },
      {
        id: 'bg-dead', title: 'Bg Job Run', tags: ['background'], column: 'inprogress',
        state: 'working', sessionId: deadSessionId, createdAt: Date.now(),
      },
    ],
    history: [],
  }));
  initTasks();
  assert.equal(snapshotBackground().liveTaskId, 'bg-dead', 'sanity: latches the single-flight guard');

  const repo = initGitRepo();
  try {
    const myJob = createJob({
      title: 'heal-test', description: 'd', cwd: repo, enabled: true,
      models: { claude: 'not-a-claude-model' }, // routes through the ollama branch → deterministic throw, no real spawn
    });
    // force:true's bypassGate path (pickJob) ignores window/gate and just
    // takes the oldest ready job across ALL jobs — including every job the
    // earlier createJob/updateJob/reorderJobs tests above left in config.jobs
    // (cwd: 'C:\\x', which doesn't exist). Disable everything but myJob so
    // pickJob can only select it.
    for (const j of snapshotBackground().config.jobs) if (j.id !== myJob.id) updateJob(j.id, { enabled: false });

    // force:true (bypassGate) skips getUsage() entirely, so the only way this
    // can fail is the single-flight refusal ('a background run is already
    // live') or the deterministic ollama-not-found throw from createTask.
    // Before the fix, the dead-session task would still read as live and the
    // run would be refused with the single-flight message instead.
    await assert.rejects(
      () => runBackgroundNow({ force: true }),
      (err) => {
        assert.doesNotMatch(err.message, /already live/);
        assert.match(err.message, /ollama not found/);
        return true;
      },
    );

    const released = snapshotTasks().tasks.find((t) => t.id === 'bg-dead');
    assert.equal(released.column, 'inreview');
    assert.equal(released.state, 'parked — needs human');
    assert.equal(snapshotBackground().liveTaskId, null);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
