// Deterministic adapter coverage using the correlated Rust bridge and fake
// timers/CLI execution. No external provider is invoked.
import { test, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const scratch = mkdtempSync(join(tmpdir(), 'singularity-window-anchor-test-'));
process.env.SINGULARITY_HOME = join(scratch, 'singularity');
process.env.USAGE_REPORT_STATE = join(scratch, 'usage-report-state');
mkdirSync(join(scratch, 'singularity', 'state'), { recursive: true });
mkdirSync(process.env.USAGE_REPORT_STATE, { recursive: true });
const modelStore = await import('./model-store.mjs');
const { createRustBackend } = await import('./rust-backend.mjs');
// Fresh backend per test: window_anchor_init does not clear Rust last_attempt/
// actions/generations, so a shared backend would leak state between tests.
let modelBackend;
beforeEach(async () => {
  modelBackend = createRustBackend();
  await modelBackend.start();
  modelStore.setModelsBackend(modelBackend);
});
afterEach(async () => { await modelBackend.stop(); });
after(() => { rmSync(scratch, { recursive: true, force: true }); });

const { initWindowAnchor, snapshotWindowAnchor, pokeProvider } = await import('./window-anchor.mjs');
const { bus } = await import('./agents.mjs');

const HOUR = 3_600_000;
let fakeNow = 1_900_000_000_000;
let setupId = 0;
const calls = [];
let timerHistory = [];
let activeTimers = new Map();
let nextTimer = 0;

function fakeSpawn(file, args, opts) {
  calls.push({ file, args, opts });
  if (args[0] === 'exec') {
    writeFileSync(args[args.indexOf('-o') + 1], 'ok');
    return Promise.resolve({ stdout: `${JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 12, output_tokens: 1 } })}\n` });
  }
  return Promise.resolve({ stdout: JSON.stringify({ result: 'ok', usage: { input_tokens: 3, output_tokens: 1 } }) });
}

const freshClock = () => {
  activeTimers = new Map();
  timerHistory = [];
  nextTimer = 0;
  return {
    setTimeout(fn, delay) {
      const timer = { id: ++nextTimer, fn, delay };
      activeTimers.set(timer.id, timer);
      timerHistory.push(timer);
      return timer.id;
    },
    clearTimeout(id) { activeTimers.delete(id); },
  };
};

async function init(over = {}) {
  const id = ++setupId;
  const stateDir = join(scratch, `state-${id}`);
  mkdirSync(stateDir, { recursive: true });
  const timers = freshClock();
  return initWindowAnchor({
    log: null, storage: modelBackend, stateDir, usageStateDir: process.env.USAGE_REPORT_STATE,
    spawn: fakeSpawn, usageRefresh: async () => null, now: () => fakeNow,
    enabled: 'claude,codex', ...timers, ...over,
  });
}

const documentFor = (provider, session) => ({
  ollama: null,
  [provider]: { ok: true, source: provider, session },
});

async function emitUsage(provider, session) {
  bus.emit('usage', documentFor(provider, session));
  return snapshotWindowAnchor(); // correlated FIFO read flushes the usage request
}

async function fire(timer) {
  assert.ok(timer, 'timer callback was captured');
  fakeNow += timer.delay;
  return timer.fn();
}

function deferred() {
  let resolve;
  const promise = new Promise((yes) => { resolve = yes; });
  return { promise, resolve };
}

function waitForSave(promise, label) {
  let timeout;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), 1000);
    }),
  ]).finally(() => clearTimeout(timeout));
}

test('Rust owns enabled snapshot and returns generation-tagged timer effects', async () => {
  const state = await init({ enabled: ' Codex , bogus' });
  assert.equal(state.claude.enabled, false);
  assert.equal(state.codex.enabled, true);
  const resetsAt = fakeNow + 10 * HOUR;
  const armed = await emitUsage('codex', { pctUsed: 0, resetsAt: new Date(resetsAt).toISOString() });
  assert.equal(armed.codex.nextAnchorAt, resetsAt + 5000);
  assert.equal(activeTimers.size, 1);
  assert.equal((await snapshotWindowAnchor()).codex.nextAnchorAt, resetsAt + 5000);
});

test('stale timer generations skip preflight; accepted firing survives replacement and admits', async () => {
  let refreshes = 0;
  const refreshStarted = deferred();
  const refreshGate = deferred();
  await init({ usageRefresh: async ({ sources }) => {
    refreshes++;
    assert.deepEqual(sources, ['claude']);
    assert.equal((await snapshotWindowAnchor()).claude.nextAnchorAt, null);
    refreshStarted.resolve();
    return refreshGate.promise;
  } });
  const firstReset = fakeNow + HOUR;
  await emitUsage('claude', { pctUsed: 0, started: true, resetsAt: new Date(firstReset).toISOString() });
  const oldTimer = timerHistory.at(-1);
  await emitUsage('claude', { pctUsed: 0, started: true, resetsAt: new Date(firstReset + HOUR).toISOString() });
  const currentTimer = timerHistory.at(-1);
  await fire(oldTimer);
  assert.equal(refreshes, 0);
  const firing = fire(currentTimer);
  await refreshStarted.promise;

  // A new usage update can replace the next deadline while this accepted
  // timer event still owns its post-refresh admission.
  await emitUsage('claude', { pctUsed: 0, started: true, resetsAt: new Date(fakeNow + 2 * HOUR).toISOString() });
  const usage = documentFor('claude', { pctUsed: 0, started: true, resetsAt: new Date(fakeNow + HOUR).toISOString() });
  bus.emit('usage', usage);
  refreshGate.resolve(usage);
  await firing;
  assert.equal(refreshes, 1);
  assert.equal((await snapshotWindowAnchor()).claude.lastResult, 'Skipped');
});

test('failed timer preflight admits from the cached expired idle window', async () => {
  const spawnStarted = deferred();
  let refreshes = 0;
  calls.length = 0;
  await init({
    usageRefresh: async () => { refreshes++; throw new Error('synthetic timer refresh failure'); },
    spawn: (file, args, opts) => {
      calls.push({ file, args, opts });
      spawnStarted.resolve();
      return Promise.resolve({ stdout: JSON.stringify({ result: 'ok', usage: {} }) });
    },
  });
  const resetsAt = fakeNow + 100;
  await emitUsage('claude', { pctUsed: 0, started: true, resetsAt: new Date(resetsAt).toISOString() });
  const timer = timerHistory.at(-1);
  await fire(timer);
  await spawnStarted.promise;
  assert.equal(refreshes, 1);
  assert.equal(calls.length, 1);
});

test('manual preflight marker is queued before admission; force bypasses refresh', async () => {
  let refreshes = 0;
  calls.length = 0;
  await init({ usageRefresh: async () => {
    refreshes++;
    const usage = documentFor('codex', { pctUsed: 0, started: false, resetsAt: null });
    bus.emit('usage', usage);
    return usage;
  } });
  assert.deepEqual(await pokeProvider('codex'), { provider: 'codex', result: 'Ok' });
  assert.equal(refreshes, 1);
  assert.equal(calls.length, 1); // the synchronous usage event did not start a second action
  assert.deepEqual(await pokeProvider('codex', { force: true }), { provider: 'codex', result: 'Ok' });
  assert.equal(refreshes, 1);
  assert.equal(calls.length, 1, 'immediate force still obeys successful-attempt dedupe');
  fakeNow += 5 * HOUR;
  assert.deepEqual(await pokeProvider('codex', { force: true }), { provider: 'codex', result: 'Ok' });
  assert.equal(refreshes, 1, 'eligible force still bypasses preflight refresh');
  assert.equal(calls.length, 2);
});

test('failed manual preflight continues from Rust cached usage and force makes no refresh', async () => {
  let refreshes = 0;
  calls.length = 0;
  await init({ usageRefresh: async () => {
    refreshes++;
    if (refreshes === 1) throw new Error('synthetic refresh failure');
    return null;
  } });
  assert.deepEqual(await pokeProvider('claude'), { provider: 'claude', result: 'Ok' });
  assert.equal(refreshes, 1);
  assert.deepEqual(await pokeProvider('codex', { force: true }), { provider: 'codex', result: 'Ok' });
  assert.equal(refreshes, 1);
  assert.equal(calls.length, 2);
});

test('ordered telemetry/save/event effects continue after both persistence failures', async () => {
  const localBus = new EventEmitter();
  const order = [];
  localBus.on('window-anchor', () => order.push('emit_snapshot'));
  const storage = {
    ...modelBackend,
    windowAnchorTelemetry: async () => { order.push('append_telemetry'); throw new Error('telemetry denied'); },
    windowAnchorSave: async () => { order.push('save_state'); throw new Error('state denied'); },
  };
  await init({ bus: localBus, storage, usageRefresh: async () => {
    const usage = documentFor('claude', { pctUsed: 1, started: true, resetsAt: new Date(fakeNow + HOUR).toISOString() });
    localBus.emit('usage', usage);
    return usage;
  } });
  assert.deepEqual(await pokeProvider('claude'), { provider: 'claude', result: 'Skipped' });
  assert.deepEqual(order.slice(-3), ['append_telemetry', 'save_state', 'emit_snapshot']);
});

test('ordinary snapshot and policy requests progress while manual one-shot is pending', async () => {
  const spawnStarted = deferred();
  const spawnResult = deferred();
  calls.length = 0;
  await init({ spawn: (file, args, opts) => {
    calls.push({ file, args, opts });
    spawnStarted.resolve();
    return spawnResult.promise;
  } });
  const manual = pokeProvider('claude', { force: true });
  try {
    await waitForSave(spawnStarted.promise, 'manual one-shot spawn');
    const resetsAt = fakeNow + HOUR;
    await emitUsage('codex', { pctUsed: 0, started: true, resetsAt: new Date(resetsAt).toISOString() });
    assert.equal((await snapshotWindowAnchor()).codex.nextAnchorAt, resetsAt + 5000);
    spawnResult.resolve({ stdout: JSON.stringify({ result: 'ok', usage: { input_tokens: 1, output_tokens: 1 } }) });
    assert.deepEqual(await waitForSave(manual, 'manual poke completion'), { provider: 'claude', result: 'Ok' });
  } finally {
    spawnResult.resolve({ stdout: JSON.stringify({ result: 'ok', usage: {} }) });
    await init({ enabled: '' });
  }
});

test('test-only /api route retains its known prefix mismatch and snapshot body', async () => {
  await init({ enabled: '' });
  const Fastify = (await import('fastify')).default;
  const app = Fastify();
  app.get('/api/window-anchor', async () => snapshotWindowAnchor());
  app.post('/api/window-anchor/poke', async (request, reply) => {
    try { return { ok: true, ...(await pokeProvider(request.body?.provider, { force: request.body?.force === true })) }; }
    catch (error) { return reply.code(400).send({ ok: false, error: error.message }); }
  });
  const response = await app.inject({ method: 'GET', url: '/api/window-anchor' });
  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body);
  for (const provider of ['claude', 'codex']) {
    for (const field of ['enabled', 'nextAnchorAt', 'lastAnchorAt', 'lastResult', 'lastError']) assert.ok(field in body[provider]);
  }
  const invalid = await app.inject({ method: 'POST', url: '/api/window-anchor/poke', payload: { provider: 'ollama' } });
  assert.equal(invalid.statusCode, 400);
  assert.equal(JSON.parse(invalid.body).ok, false);
  await app.close();
});

test('WebSocket waits for the Rust snapshot and flushes live and direct frames in order', async () => {
  const { attachPtyWs } = await import('./pty-ws.mjs');
  const pendingSnapshots = [];
  const snapshot = { claude: { enabled: true }, codex: { enabled: false } };
  const storage = {
    windowAnchorRequest: async (op) => {
      if (op === 'window_anchor_init') return { snapshot, effects: [] };
      if (op === 'window_anchor_snapshot') return new Promise((resolve) => pendingSnapshots.push(() => resolve({ snapshot })));
      throw new Error(`unexpected window-anchor operation: ${op}`);
    },
  };
  await init({ storage, enabled: 'claude,codex' });

  const wss = new EventEmitter();
  wss.clients = new Set();
  const sockets = [];
  const makeSocket = () => {
    const ws = new EventEmitter();
    ws.OPEN = 1;
    ws.readyState = ws.OPEN;
    ws.sent = [];
    ws.closed = [];
    ws.send = (payload) => ws.sent.push(JSON.parse(payload));
    ws.close = (code, reason) => {
      ws.closed.push({ code, reason });
      ws.readyState = 3;
      ws.emit('close');
    };
    sockets.push(ws);
    wss.clients.add(ws);
    wss.emit('connection', ws, { headers: { origin: 'http://localhost' }, url: '/ws' });
    return ws;
  };
  attachPtyWs(wss, null);

  const ws = makeSocket();
  const sevenFramesSent = deferred();
  ws.send = (payload) => {
    ws.sent.push(JSON.parse(payload));
    if (ws.sent.length === 7) sevenFramesSent.resolve();
  };
  assert.equal(ws.sent.length, 0, 'initial frames wait for the correlated Rust snapshot');
  ws.emit('message', Buffer.from(JSON.stringify({ t: 'txmeta', id: 'missing-session' })));
  bus.emit('status', { id: 'live-session', status: 'running' });
  assert.equal(ws.sent.length, 0, 'direct replies and bus events are both buffered');
  pendingSnapshots[0]();
  await waitForSave(sevenFramesSent.promise, 'five initial and two queued WebSocket frames');
  assert.deepEqual(ws.sent.slice(0, 5).map((frame) => frame.t), ['list', 'tasks', 'crons', 'background', 'window-anchor']);
  assert.deepEqual(ws.sent.slice(5).map((frame) => frame.t), ['txmeta', 'status']);
  assert.deepEqual(ws.sent[4], { t: 'window-anchor', anchor: snapshot });

  const frameLimited = makeSocket();
  for (let i = 0; i < 257; i++) bus.emit('usage', { i });
  assert.deepEqual(frameLimited.closed, [{ code: 1013, reason: 'initial snapshot backlog exceeded' }]);
  assert.equal(frameLimited.initialFrames.length, 0, 'overflow clears the queued frames');
  pendingSnapshots[1]();
  await Promise.resolve();
  assert.equal(frameLimited.sent.length, 0);

  const byteLimited = makeSocket();
  bus.emit('usage', 'é'.repeat(524300));
  assert.deepEqual(byteLimited.closed, [{ code: 1013, reason: 'initial snapshot backlog exceeded' }]);
  pendingSnapshots[2]();
  await Promise.resolve();
  assert.equal(byteLimited.sent.length, 0);

  const closed = makeSocket();
  bus.emit('usage', { queued: true });
  closed.close(1000, 'client closed');
  assert.equal(closed.initialFrames.length, 0, 'close clears pending frames');
  pendingSnapshots[3]();
  await Promise.resolve();
  assert.equal(closed.sent.length, 0, 'a closed socket receives no initial frames');
  for (const socket of sockets) if (socket.readyState === socket.OPEN) socket.close(1000, 'test complete');
  await init({ enabled: '' });
});

test('manual poke does not wait for unrelated later persistence effects', async () => {
  const ownSaveStarted = deferred();
  const releaseOwnSave = deferred();
  const unrelatedSaveStarted = deferred();
  const releaseUnrelatedSave = deferred();
  let snapshotReads = 0;
  const snapshot = { claude: { lastResult: 'Ok' }, codex: {} };
  const storage = {
    windowAnchorSave: async (_path, state) => {
      if (state?.kind === 'manual-action') {
        ownSaveStarted.resolve();
        return releaseOwnSave.promise;
      }
      unrelatedSaveStarted.resolve();
      return releaseUnrelatedSave.promise;
    },
    windowAnchorRequest: async (op) => {
      if (op === 'window_anchor_init') return { snapshot, effects: [] };
      if (op === 'window_anchor_poke') return {
        snapshot,
        result: { result: 'Ok' },
        effects: [{ type: 'run_action', action_id: 'manual-action', provider: 'claude', trigger: 'manual', force: true }],
      };
      if (op === 'window_anchor_usage') return { snapshot, effects: [{ type: 'save_state', state: {} }] };
      if (op === 'window_anchor_action_result') {
        return { snapshot, effects: [{ type: 'save_state', state: { kind: 'manual-action' } }] };
      }
      if (op === 'window_anchor_snapshot') {
        snapshotReads++;
        return { snapshot };
      }
      throw new Error(`unexpected window-anchor operation: ${op}`);
    },
  };
  await init({ storage, enabled: 'claude,codex' });

  let manualSettled = false;
  const manual = pokeProvider('claude', { force: true }).then((result) => {
    manualSettled = true;
    return result;
  });
  try {
    await waitForSave(ownSaveStarted.promise, 'manual action-result save');
    assert.equal(manualSettled, false, 'manual poke waits for its own action-result persistence');
    const unrelated = emitUsage('codex', { pctUsed: 25, started: true, resetsAt: new Date(fakeNow - HOUR).toISOString() });
    assert.equal(snapshotReads, 1, 'emitUsage helper FIFO flush read');
    releaseOwnSave.resolve();
    const result = await manual;
    assert.deepEqual(result, { provider: 'claude', result: 'Ok' });
    assert.equal(snapshotReads, 2, 'helper FIFO flush plus manual final snapshot');
    await waitForSave(unrelatedSaveStarted.promise, 'unrelated usage save');
    assert.equal(manualSettled, true, 'manual poke completes while a later usage save is pending');
    releaseUnrelatedSave.resolve();
    await unrelated;
  } finally {
    releaseOwnSave.resolve();
    releaseUnrelatedSave.resolve();
    await init({ enabled: '' });
  }
});
