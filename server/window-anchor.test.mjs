// Unit tests for window-anchor.mjs: arms a poke timer at a 5h window's
// resetsAt+5000, pokes the cheap route when a window expires with pctUsed===0,
// stands down when real work anchored it (pctUsed>0), never pokes twice for
// the same window, persists to APP_DIR/window-anchor.json (APP_DIR derives from
// process.env.SINGULARITY_HOME via agents.mjs), so SINGULARITY_HOME is pointed
// at a scratch temp dir *before* the module graph is imported (dynamic import
// after the env tweak). `now` and `spawn` are injected — no real CLI is ever
// run. Run: pnpm test  (node --test server/)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const scratch = mkdtempSync(join(tmpdir(), 'singularity-window-anchor-test-'));
process.env.SINGULARITY_HOME = join(scratch, 'singularity');
mkdirSync(join(scratch, 'singularity', 'state'), { recursive: true });
after(() => rmSync(scratch, { recursive: true, force: true }));

const { initWindowAnchor, snapshotWindowAnchor, setWindowAnchorEnabled, pokeProvider } = await import('./window-anchor.mjs');
const { bus, STATE_DIR, CLAUDE_BIN, CODEX_BIN } = await import('./agents.mjs');

const HOUR = 3_600_000;
let fakeNow = 1_700_000_000_000;
const calls = []; // one entry per spawn: { file, args, opts }

// execFile-shaped fake: records argv, resolves on demand. Codex's answer
// channel is the -o file, so the fake writes it; claude's is stdout JSON.
function fakeSpawn(file, args, opts) {
  calls.push({ file, args, opts });
  if (args[0] === 'exec') writeFileSync(args[args.indexOf('-o') + 1], 'ok');
  return Promise.resolve({ stdout: JSON.stringify({ result: 'ok', usage: {} }) });
}

const init = (over = {}) => initWindowAnchor({ log: null, spawn: fakeSpawn, now: () => fakeNow, ...over });

// Push a usage document the way usage.mjs's getUsage does.
function emitUsage(group, { pctUsed, resetsAt }) {
  bus.emit('usage', {
    ollama: null,
    [group]: { ok: true, source: group, session: { pctUsed, resetsAt: new Date(resetsAt).toISOString() } },
  });
}

async function until(fn, ms = 3000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error('condition not met within timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

test('arming: a future window arms nextAnchorAt at resetsAt+5000 and dedupes', () => {
  init();
  setWindowAnchorEnabled({ claude: true });
  const resetsAt = fakeNow + 10 * HOUR;
  emitUsage('claude', { pctUsed: 0, resetsAt });
  assert.equal(snapshotWindowAnchor().claude.nextAnchorAt, resetsAt + 5000);

  // Same window again: already armed for this resetsAt — no re-arm, no emit.
  const events = [];
  const onState = (s) => events.push(s);
  bus.on('window-anchor', onState);
  try {
    emitUsage('claude', { pctUsed: 0, resetsAt });
    assert.equal(events.length, 0);
    assert.equal(snapshotWindowAnchor().claude.nextAnchorAt, resetsAt + 5000);
  } finally {
    bus.off('window-anchor', onState);
  }
});

test('a successful read with no plan window clears a stale timer but stays enabled', () => {
  init();
  setWindowAnchorEnabled({ claude: true });
  emitUsage('claude', { pctUsed: 0, resetsAt: fakeNow + 10 * HOUR });
  assert.notEqual(snapshotWindowAnchor().claude.nextAnchorAt, null);

  bus.emit('usage', { claude: { ok: true, source: 'claude', session: null } });
  const updated = snapshotWindowAnchor().claude;
  assert.equal(updated.enabled, true);
  assert.equal(updated.nextAnchorAt, null);
});

test('enabling re-evaluates the latest usage and pokes an unstarted window', async () => {
  fakeNow += 24 * HOUR;
  init();
  calls.length = 0;
  setWindowAnchorEnabled({ claude: false, codex: false });
  const resetsAt = fakeNow + 9 * HOUR;
  bus.emit('usage', {
    claude: { ok: true, source: 'claude', session: { pctUsed: 0, resetsAt: new Date(resetsAt).toISOString() } },
    codex: { ok: true, source: 'codex', session: { pctUsed: 0, resetsAt: null, started: false } },
    ollama: null,
  });
  assert.equal(calls.length, 0);

  const updated = setWindowAnchorEnabled({ claude: true, codex: true });
  assert.equal(updated.claude.nextAnchorAt, resetsAt + 5000);
  await until(() => calls.length === 1 && snapshotWindowAnchor().codex.lastResult === 'Ok');
});

test('expiry poke: pctUsed===0 pokes the cheap route with headless + effort flags', async () => {
  setWindowAnchorEnabled({ codex: true });
  const before = calls.length;
  emitUsage('claude', { pctUsed: 0, resetsAt: fakeNow - HOUR });
  await until(() => snapshotWindowAnchor().claude.lastResult === 'Ok');
  emitUsage('codex', { pctUsed: 0, resetsAt: fakeNow - HOUR });
  await until(() => snapshotWindowAnchor().codex.lastResult === 'Ok');

  const cla = calls[before];
  assert.equal(cla.file, CLAUDE_BIN);
  assert.equal(cla.args[0], '-p');
  assert.equal(cla.args[1], 'ok');
  assert.deepEqual(cla.args.slice(2), [
    '--model', 'haiku',
    '--output-format', 'json',
    '--no-session-persistence',
    '--effort', 'low',
  ]);
  assert.equal(cla.opts.timeout, 90_000);

  const codex = calls[before + 1];
  assert.equal(codex.file, CODEX_BIN);
  assert.equal(codex.args[0], 'exec');
  assert.deepEqual(codex.args.slice(1), [
    '-m', 'gpt-5.6-luna',
    '-s', 'read-only',
    '--skip-git-repo-check',
    '--ephemeral',
    '-C', STATE_DIR,
    '-o', codex.args[codex.args.indexOf('-o') + 1],
    '-c', 'model_reasoning_effort=low',
    'ok',
  ]);
  assert.equal(codex.opts.timeout, 90_000);

  const s = snapshotWindowAnchor();
  assert.equal(s.claude.lastAnchorAt, fakeNow);
  assert.equal(s.codex.lastResult, 'Ok');
  assert.equal(s.claude.nextAnchorAt, null);
});

test('skipped: an expired window with pctUsed>0 stands down without a poke', async () => {
  const before = calls.length;
  emitUsage('claude', { pctUsed: 40, resetsAt: fakeNow - HOUR });
  await until(() => snapshotWindowAnchor().claude.lastResult === 'Skipped');
  assert.equal(calls.length, before);
  assert.equal(snapshotWindowAnchor().claude.lastError, null);
});

test('dedupe: a second update for the same expired window does not re-poke', () => {
  const before = calls.length;
  emitUsage('codex', { pctUsed: 0, resetsAt: fakeNow - HOUR }); // same window as the poke test
  assert.equal(calls.length, before);
  assert.equal(snapshotWindowAnchor().codex.lastResult, 'Ok');
});

test('persistence: state file written and reloaded on re-init', async () => {
  const file = join(STATE_DIR, 'window-anchor.json');
  assert.equal(existsSync(file), true);
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(saved.codex.enabled, true);
  assert.equal(saved.codex.lastResult, 'Ok');
  assert.equal(saved.claude.enabled, true);
  assert.equal(saved.claude.lastResult, 'Skipped');

  setWindowAnchorEnabled({ claude: false });
  const freshCalls = [];
  init({ spawn: (file2, args) => { freshCalls.push({ file: file2, args }); return Promise.resolve({ stdout: '{}' }); } });
  const s = snapshotWindowAnchor();
  assert.equal(s.claude.enabled, false);
  assert.equal(s.codex.enabled, true);
  assert.equal(s.codex.lastResult, 'Ok');
});

test('timer fire: an armed timer pokes at resetsAt+5000', async () => {
  init(); // back to the recording fakeSpawn (persistence test's re-init swapped it)
  setWindowAnchorEnabled({ claude: true });
  const before = calls.length;
  emitUsage('claude', { pctUsed: 0, resetsAt: fakeNow + 100 }); // arms a real ~5.1s timer
  assert.equal(snapshotWindowAnchor().claude.nextAnchorAt, fakeNow + 100 + 5000);
  await until(() => calls.length > before, 8000);
  assert.equal(snapshotWindowAnchor().claude.lastResult, 'Ok');
  assert.equal(snapshotWindowAnchor().claude.nextAnchorAt, null);
});

test('routes: GET shape, POST toggle, poke route 400 on bad provider', async () => {
  const Fastify = (await import('fastify')).default;
  const app = Fastify();
  // Same handler shapes as index.mjs's /api/window-anchor routes.
  app.get('/api/window-anchor', async () => snapshotWindowAnchor());
  app.post('/api/window-anchor', async (req) => setWindowAnchorEnabled(req.body?.enabled || {}));
  app.post('/api/window-anchor/poke', async (req, reply) => {
    try { return { ok: true, ...(await pokeProvider(req.body?.provider)) }; }
    catch (e) { return reply.code(e.persistFailure ? 500 : 400).send({ ok: false, error: e.message }); }
  });

  const get = await app.inject({ method: 'GET', url: '/api/window-anchor' });
  assert.equal(get.statusCode, 200);
  const body = JSON.parse(get.body);
  for (const p of ['claude', 'codex']) {
    for (const k of ['enabled', 'nextAnchorAt', 'lastAnchorAt', 'lastResult', 'lastError']) {
      assert.ok(k in body[p], `${p}.${k} present`);
    }
  }

  const toggle = await app.inject({ method: 'POST', url: '/api/window-anchor', payload: { enabled: { claude: false } } });
  assert.equal(toggle.statusCode, 200);
  assert.equal(JSON.parse(toggle.body).claude.enabled, false);
  assert.equal(snapshotWindowAnchor().claude.enabled, false);

  const bad = await app.inject({ method: 'POST', url: '/api/window-anchor/poke', payload: { provider: 'ollama' } });
  assert.equal(bad.statusCode, 400);
  assert.equal(JSON.parse(bad.body).ok, false);

  const poke = await app.inject({ method: 'POST', url: '/api/window-anchor/poke', payload: { provider: 'claude' } });
  assert.equal(poke.statusCode, 200);
  assert.deepEqual(JSON.parse(poke.body), { ok: true, provider: 'claude', result: 'Ok' });
  await app.close();
});

// A Codex window that has not begun: usage.mjs strips the sliding reset
// projection and flags started:false, so there is nothing to arm against. The
// anchor must poke immediately instead of sitting on a timer that never fires,
// and must not poke again until the window it started has lapsed.
test('unstarted: pokes at once, once per window span', async () => {
  fakeNow += 24 * HOUR; // past any anchor an earlier test left on codex
  init();
  calls.length = 0;
  setWindowAnchorEnabled({ codex: true });
  const unstarted = () => bus.emit('usage', {
    ollama: null,
    codex: { ok: true, source: 'codex', session: { pctUsed: 0, resetsAt: null, started: false } },
  });

  unstarted();
  await until(() => calls.length === 1);
  assert.equal(snapshotWindowAnchor().codex.lastResult, 'Ok');
  assert.equal(snapshotWindowAnchor().codex.nextAnchorAt, null);

  // Still unstarted on the next poll (the API lags the turn): no second poke.
  fakeNow += 60_000;
  unstarted();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls.length, 1);

  // A window later the anchor it placed has lapsed — poke again.
  fakeNow += 5 * HOUR;
  unstarted();
  await until(() => calls.length === 2);
});
