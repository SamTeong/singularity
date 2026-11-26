// Unit tests for the spawn/encoding logic: encodeCwd + buildSpawn, plus fork()/
// create()/respawnAll()/beginDrain(), which spawn through the real Rust PTY service. A
// cross-platform "keepalive" bin stands in for the claude/ollama binary: an
// interactive process that ignores its argv and stays alive until killed —
// cmd.exe on Windows (an interactive REPL that survives bad commands), a
// sleep-forever shell script on POSIX. Both CLAUDE_BIN and OLLAMA_BIN point at
// it, so every spawn path yields a genuine, cleanly-killable live pty on both
// platforms; spawn-path tests start one and kill+wait before finishing.
// SINGULARITY_HOME is pointed at a scratch temp dir first (create()/fork() persist() to
// APP_DIR/state/agents.json — else it'd clobber the user's real agents.json),
// mirroring crons.test.mjs's convention: env tweaks before a dynamic import of
// the module graph.
// Run: npm test  (node --test server/)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, chmodSync, renameSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';

const scratch = mkdtempSync(join(tmpdir(), 'singularity-agents-test-'));
const isolatedHome = join(scratch, 'home');
mkdirSync(isolatedHome, { recursive: true });
process.env.HOME = isolatedHome;
process.env.USERPROFILE = isolatedHome;
process.env.SINGULARITY_HOME = join(scratch, 'singularity');
// A long-lived process that ignores its argv and blocks until killed, so both
// the claude-model path (CLAUDE_BIN) and the ollama-wrap path (OLLAMA_BIN)
// yield a real, killable pty without needing the actual binaries.
let keepalive;
if (process.platform === 'win32') {
  keepalive = 'C:\\Windows\\System32\\cmd.exe'; // interactive REPL: survives unknown argv, reads the pty until killed
} else {
  keepalive = join(scratch, 'keepalive.sh');
  writeFileSync(keepalive, '#!/bin/sh\nexec sleep 2147483647\n'); // execs sleep → ignores argv, blocks until SIGHUP
  chmodSync(keepalive, 0o755);
}
process.env.CLAUDE_BIN = keepalive;
process.env.OLLAMA_BIN = keepalive;
process.env.CODEX_BIN = keepalive;
// SING_SCOPE_ROOT + skill-manifest.json fixture for the codex scope-config
// test: resolveSkillManifest() derives the path as dirname(SCOPE_ROOT)/skills/
// skill-manifest.json. So SCOPE_ROOT must be a SUBDIR of a parent, and the
// manifest lives at <parent>/skills/skill-manifest.json. Two skills — one
// 'coding', one 'harness' — so the test can assert the 'harness'-scoped skill
// is disabled while 'coding' is kept.
const scopeParent = mkdtempSync(join(tmpdir(), 'sing-scope-parent-'));
const scopeRoot = join(scopeParent, 'skill-scopes');
mkdirSync(scopeRoot, { recursive: true });
mkdirSync(join(scopeParent, 'skills'), { recursive: true });
const manifestDir = join(scopeParent, 'skills');
const codingSkillDir = join(scratch, 'skills', 'coding-skill');
const harnessSkillDir = join(scratch, 'skills', 'harness-skill');
mkdirSync(codingSkillDir, { recursive: true });
mkdirSync(harnessSkillDir, { recursive: true });
writeFileSync(join(codingSkillDir, 'SKILL.md'), '# coding skill');
writeFileSync(join(harnessSkillDir, 'SKILL.md'), '# harness skill');
writeFileSync(join(manifestDir, 'skill-manifest.json'), JSON.stringify({
  scopes: { coding: ['coding-skill'], harness: ['harness-skill'] },
  external: { 'coding-skill': codingSkillDir, 'harness-skill': harnessSkillDir },
}));
process.env.SING_SCOPE_ROOT = scopeRoot;
// codex-thread.mjs's CODEX_HOME (via usage.mjs) is a load-time const too —
// point it at a scratch dir before the dynamic import below, same reason
// SINGULARITY_HOME is set up front.
const codexHome = join(scratch, 'codex-home');
process.env.CODEX_HOME = codexHome;
const modelStore = await import('./model-store.mjs');
const modelBackend = (await import('./rust-backend.mjs')).createRustBackend();
await modelBackend.start();
modelStore.setModelsBackend(modelBackend);
const codexIdentity = await import('./codex-thread.mjs');
codexIdentity.setCodexIdentityBackend(modelBackend);
const ptyBinary = process.env.SINGULARITY_RUST_PTY_BINARY ?? join(process.cwd(), 'rust', 'backend', 'target', 'release', process.platform === 'win32' ? 'singularity-backend.exe' : 'singularity-backend');
const rawPtyBackend = (await import('./rust-pty-backend.mjs')).createRustPtyBackend({ executable: ptyBinary, cwd: process.cwd() });
// cmd.exe scans its whole command line for switches: codex's forward-slashed `-c` skill paths under a CI temp dir
// (C:/Users/RUNNER~1/...) contain `/R` (= /C), so cmd ran `UNNER~1` and exited. The keepalive must ignore argv; drop it.
const ptyBackend = process.platform === 'win32' ? { ...rawPtyBackend, spawn: (opts) => rawPtyBackend.spawn({ ...opts, args: [] }) } : rawPtyBackend;
await ptyBackend.start();
const registry = await import('./agents.mjs');
registry.setPtyBackend(ptyBackend);
after(async () => {
  await ptyBackend.stop();
  await modelBackend.stop();
  rmSync(scopeParent, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
});

const { encodeCwd, untildify, buildSpawn, init, fork, create, reattach, remove, snapshot, respawn, respawnAll, kill, isLive, bus, ensureTrusted, beginDrain, externalLaunch, resolveWt, writeAtomic, spawnEnv, CACHE_DIR, getLaunchConfigForCodexThread, codexThreadFor, getBuf, getWritten, getStatus, input, resize, sweepTmpFiles, codexOwnerForThread, isLiveSession } = registry;

// Kill a live pty and wait for its onExit to settle (status 'exited'), so a
// test never leaks a running child into the next test or file teardown.
function killAndWait(id) {
  return new Promise((resolve) => {
    const onStatus = ({ id: sid, status }) => {
      if (sid === id && status === 'exited') { bus.off('status', onStatus); resolve(); }
    };
    bus.on('status', onStatus);
    kill(id);
  });
}

function waitForOutput(id, pattern) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { bus.off('output', onOutput); reject(new Error(`timed out waiting for output matching ${pattern}`)); }, 10000);
    const onOutput = ({ id: sid, data }) => {
      if (sid === id && pattern.test(data)) { clearTimeout(timer); bus.off('output', onOutput); resolve(data); }
    };
    bus.on('output', onOutput);
  });
}

function waitForRemoval(id) {
  if (!snapshot().some((agent) => agent.id === id)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { bus.off('list', onList); reject(new Error(`timed out waiting for agent ${id} removal`)); }, 10000);
    const onList = () => {
      if (!snapshot().some((agent) => agent.id === id)) { clearTimeout(timer); bus.off('list', onList); resolve(); }
    };
    bus.on('list', onList);
  });
}

// Deterministic pty for the same-id race tests: every spawn parks until the
// test releases it by index (so two callers can be observed mid-flight), and
// the test drives exit explicitly through `exit(index)`.
function manualPtyBackend() {
  const spawns = [];
  const handles = [];
  const waiters = [];
  return {
    spawn(options) {
      const handle = {
        pid: 9000 + handles.length,
        killed: false,
        onData(fn) { handle.dataFn = fn; return handle; },
        onExit(fn) { handle.exitFn = fn; return handle; },
        activate() { return handle; },
        write: async () => {},
        resize: async () => {},
        kill: async () => { handle.killed = true; },
      };
      spawns.push(options);
      handles.push(handle);
      return new Promise((resolve) => waiters.push({ handle, resolve }));
    },
    release(index) { waiters[index].resolve(waiters[index].handle); },
    exit(index, code = 0) { handles[index].exitFn?.(code); },
    // Spawning may pass through an async route/build before it reaches here, so
    // tests wait for the parked spawn instead of assuming a fixed tick count.
    async waitForSpawn(count) { while (spawns.length < count) await new Promise((resolve) => setImmediate(resolve)); },
    spawns,
    handles,
  };
}

function seedDetached(id) {
  writeFileSync(join(scratch, 'singularity', 'state', 'agents.json'), JSON.stringify({
    agents: [{ id, title: 'seeded', cwd: scratch, createdAt: Date.now(), model: 'claude', scopes: [] }],
    recentRepos: [],
  }));
  init(); // loads the record as 'detached' (proc: null)
}

const claudeRoute = { isClaudeModel: true, isCodexModel: false };

test('a live agent is published even when the registry save fails', async () => {
  const id = '10000000-aaaa-bbbb-cccc-100000000005';
  const backend = manualPtyBackend();
  const tempFile = join(process.env.SINGULARITY_HOME, 'state', `agents.json.${process.pid}.tmp`);
  const lists = [];
  const onList = (list) => lists.push(list);
  mkdirSync(tempFile);
  registry.setPtyBackend(backend);
  bus.on('list', onList);
  try {
    const pending = create({ cwd: scratch, title: 'unsaved', model: 'claude', sessionId: id, modelRoute: claudeRoute });
    const rejection = assert.rejects(pending, /agents\.json write failed/);
    await backend.waitForSpawn(1);
    backend.release(0);
    await rejection;
    assert.equal(isLive(id), true);
    assert.ok(lists.some((list) => list.some((agent) => agent.id === id)));
  } finally {
    bus.off('list', onList);
    rmSync(tempFile, { recursive: true, force: true });
    if (isLive(id)) {
      remove(id);
      backend.exit(0);
      await waitForRemoval(id);
    }
    registry.setPtyBackend(ptyBackend);
  }
});

test('registry activates early output after registration and contains async adapter errors', async () => {
  const id = '10000000-aaaa-bbbb-cccc-100000000002';
  let onData;
  let onExit;
  let spawnArgs;
  let unhandled = 0;
  const onUnhandled = () => { unhandled++; };
  const handle = {
    pid: 4242,
    onData(callback) { onData = callback; return handle; },
    onExit(callback) { onExit = callback; return handle; },
    activate() { assert.ok(snapshot().some((agent) => agent.id === id), 'entry registered before callbacks activate'); onData('EARLY'); },
    write: async () => { throw new Error('write rejected'); },
    resize: async () => { throw new Error('resize rejected'); },
    kill: async () => { throw new Error('kill rejected'); },
  };
  registry.setPtyBackend({ spawn: async (options) => { spawnArgs = options; return handle; } });
  process.on('unhandledRejection', onUnhandled);
  try {
    const outputs = [];
    const onOutput = (event) => { if (event.id === id) outputs.push(event); };
    bus.on('output', onOutput);
    const agent = await create({ cwd: scratch, title: 'adapter-test', model: 'claude', sessionId: id, mock: true });
    bus.off('output', onOutput);
    assert.equal(agent.pid, 4242);
    assert.deepEqual({ bin: spawnArgs.bin, args: spawnArgs.args, cwd: spawnArgs.cwd, cols: spawnArgs.cols, rows: spawnArgs.rows }, {
      bin: keepalive, args: (await buildSpawn({ id, title: 'adapter-test', cwd: scratch, model: 'claude' })).args,
      cwd: scratch, cols: 80, rows: 24,
    });
    assert.deepEqual(spawnArgs.env, spawnEnv(true));
    assert.equal(getBuf(id), 'EARLY');
    assert.equal(getWritten(id), 'EARLY'.length);
    assert.equal(getStatus(id), 'running');
    assert.deepEqual(outputs, [{ id, data: 'EARLY' }]);

    const inputs = [];
    const onInput = (event) => inputs.push(event);
    bus.on('input', onInput);
    input(id, 'later');
    input(id, 'wrap up', { userInitiated: false });
    bus.off('input', onInput);
    assert.deepEqual(inputs, [{ id, data: 'later' }], 'only user input is announced on the bus');
    resize(id, 100, 40);
    kill(id);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(unhandled, 0);
    onExit(0);
    await waitForRemoval(id);
  } finally {
    process.off('unhandledRejection', onUnhandled);
    registry.setPtyBackend(ptyBackend);
    if (snapshot().some((agent) => agent.id === id)) onExit?.(0);
  }
});

async function customModelGroup(group) {
  const doc = await modelStore.getModels();
  doc.models = doc.models.filter((model) => model.id !== 'gpt-custom');
  doc.models.push({ id: 'gpt-custom', group, label: 'Custom', enabled: true });
  await modelStore.setModels(doc);
  return doc;
}

test('encodeCwd replaces every non-alphanumeric (incl. dots) with "-"', async () => {
  assert.equal(encodeCwd('C:\\git\\singularity'), 'C--git-singularity');
  assert.equal(encodeCwd('C:\\Users\\x\\.claude'), 'C--Users-x--claude');
  assert.equal(encodeCwd('/home/u/proj'), '-home-u-proj');
});

test('untildify expands `~` and `~/x` (a raw client cwd must not spawn into a literal "~")', async () => {
  assert.equal(untildify('~'), homedir());
  assert.equal(untildify('~/proj'), join(homedir(), 'proj'));
  assert.equal(untildify('C:\\git\\x'), 'C:\\git\\x'); // no leading ~ → untouched
  assert.equal(untildify('~notahome'), '~notahome');
});

// A random id has no session log on disk → fresh --session-id branch.
const freshId = '00000000-1111-2222-3333-444444444444';
const cwd = 'C:\\definitely\\not\\a\\real\\repo\\path\\xyz';

test('buildSpawn: fresh claude session uses --session-id, --name, no --model', async () => {
  const { bin, args } = await buildSpawn({ id: freshId, title: 'demo', cwd, model: 'claude', scopes: [] });
  assert.equal(typeof bin, 'string');
  assert.ok(args.includes('--session-id'));
  assert.equal(args[args.indexOf('--session-id') + 1], freshId);
  assert.ok(args.includes('--name'));
  assert.equal(args[args.indexOf('--name') + 1], 'demo');
  assert.ok(!args.includes('--resume'));
  assert.ok(!args.includes('--model'));
});

test('buildSpawn: non-existent skill-scope is not added as --add-dir', async () => {
  const { args } = await buildSpawn({ id: freshId, title: 'demo', cwd, model: 'claude', scopes: ['__no_such_scope__'] });
  assert.ok(!args.includes('--add-dir'));
});

test('buildSpawn: claude alias (opus) runs via claude bin with --model', async () => {
  const { args } = await buildSpawn({ id: freshId, title: 'demo', cwd, model: 'opus', scopes: [] });
  assert.ok(!args.includes('launch'));
  assert.ok(args.includes('--model'));
  assert.equal(args[args.indexOf('--model') + 1], 'opus');
  assert.ok(args.includes('--session-id'));
});

test('buildSpawn: typed full claude id runs via claude bin with --model', async () => {
  const { args } = await buildSpawn({ id: freshId, title: 'demo', cwd, model: 'claude-opus-4-8', scopes: [] });
  assert.ok(!args.includes('launch'));
  assert.equal(args[args.indexOf('--model') + 1], 'claude-opus-4-8');
});

// mock demo sessions (tasks.mjs's mock:true) must not write cost-state into the
// user's real ~/.agents/.harness-usage-report store — spawnEnv redirects
// USAGE_REPORT_STATE into the disposable CACHE_DIR for mock spawns only.
// All spawns (mock and normal) carry HARNESS_LAUNCH_SOURCE: 'singularity'.
test('spawnEnv: mock spawn gets USAGE_REPORT_STATE under CACHE_DIR; all spawns get HARNESS_LAUNCH_SOURCE', async () => {
  const mockEnv = spawnEnv(true);
  assert.equal(mockEnv.USAGE_REPORT_STATE, join(CACHE_DIR, 'mock-usage-state'));
  assert.equal(mockEnv.HARNESS_LAUNCH_SOURCE, 'singularity');
  const normalEnv = spawnEnv(false);
  assert.equal(normalEnv.HARNESS_LAUNCH_SOURCE, 'singularity');
  assert(!normalEnv.USAGE_REPORT_STATE);
});

test('buildSpawn: existing session log switches to --resume', async () => {
  const dir = join(homedir(), '.claude', 'projects', encodeCwd(cwd));
  const log = join(dir, `${freshId}.jsonl`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(log, '{}\n');
  try {
    const { args } = await buildSpawn({ id: freshId, title: 'demo', cwd, model: 'claude', scopes: [] });
    assert.ok(args.includes('--resume'));
    assert.ok(!args.includes('--session-id'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// fork() reads the source agent out of the live registry — seeded here via
// init()+a fake agents.json (the pattern init() itself uses to reload
// detached agents after a daemon restart) rather than via create(), so
// seeding the source never spawns anything either.
test('fork: copies+rewrites the source transcript into the new session log', async () => {
  const srcId = '10000000-aaaa-bbbb-cccc-100000000001';
  const forkCwd = scratch;
  const dir = join(homedir(), '.claude', 'projects', encodeCwd(forkCwd));
  mkdirSync(dir, { recursive: true });
  const srcLog = join(dir, `${srcId}.jsonl`);
  writeFileSync(srcLog, `{"sessionId":"${srcId}","type":"user"}\n`);
  const stateFile = join(scratch, 'singularity', 'state', 'agents.json');
  writeFileSync(stateFile, JSON.stringify({
    agents: [{ id: srcId, title: 'srcname', cwd: forkCwd, createdAt: Date.now(), model: 'claude', scopes: ['x'] }],
    recentRepos: [],
  }));
  try {
    init(); // loads srcId into the registry as 'detached', proc: null — no spawn
    const forked = await fork(srcId, 'copyname'); // copies+rewrites the transcript, then spawns a real pty over it
    try {
      // the copied log carries the NEW id everywhere and no trace of the source id.
      const newLog = join(dir, `${forked.id}.jsonl`);
      assert.ok(existsSync(newLog), 'a new session log was written for the fork');
      const content = readFileSync(newLog, 'utf8');
      assert.ok(content.includes(`"sessionId":"${forked.id}"`));
      assert.ok(!content.includes(srcId));
    } finally {
      await killAndWait(forked.id);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// create() refuses a live id ('session id already in use') but resumes a dead
// one — a claude proc that exited (e.g. usage-limit hit) leaves an 'exited'
// entry with proc:null in the registry; re-entering its id must resume the
// conversation, not error. Seeded via init()+fake agents.json (no spawn).
test('create: dead (exited) dup id resumes via reattach instead of "already in use"', async () => {
  const deadId = '20000000-bbbb-cccc-dddd-200000000002';
  const deadCwd = scratch;
  const stateFile = join(scratch, 'singularity', 'state', 'agents.json');
  writeFileSync(stateFile, JSON.stringify({
    agents: [{ id: deadId, title: 'deadname', cwd: deadCwd, createdAt: Date.now(), model: 'claude', scopes: [] }],
    recentRepos: [],
  }));
  init(); // loads deadId as 'detached', proc: null
  // re-entering a dead id takes the resume path (reattach → spawn a live pty),
  // NOT the 'already in use' refusal — a fresh live pid on the same id proves it.
  const a = await create({ sessionId: deadId, cwd: deadCwd, model: 'claude' });
  try {
    assert.equal(a.id, deadId);
    assert.ok(a.pid, 'reattach spawned a live pty (resume path taken, not refused)');
  } finally {
    await killAndWait(deadId);
  }
});

// create() is the choke point both the WS 'create' route and tasks.mjs's
// createTask() spawn through — a mismatched tool/model pairing (e.g. tool
// 'codex' with a claude alias) must be rejected here before a pty is ever
// spawned, rather than reaching `codex -m sonnet`.
test('create: rejects tool "codex" paired with a claude model alias', async () => {
  const id = '25000000-bbbb-cccc-dddd-250000000002';
  await assert.rejects(
    () => create({ sessionId: id, cwd: scratch, model: 'sonnet', tool: 'codex' }),
    /sonnet.*codex/,
  );
  assert.ok(!snapshot().some((a) => a.id === id), 'rejected pairing never entered the registry');
});

// remove() on a dead/detached entry drops it from the registry immediately
// (the task-done path: a completed session leaves the session list rather than
// lingering as 'exited'). Seeded via init()+fake agents.json (no spawn); the
// live-pty branch of remove() can't be exercised here for the same reason
// kill()'s can't (no real pty in a unit test).
test('remove: dead (detached) agent is dropped from the registry', async () => {
  const goneId = '30000000-cccc-dddd-eeee-300000000003';
  const stateFile = join(scratch, 'singularity', 'state', 'agents.json');
  writeFileSync(stateFile, JSON.stringify({
    agents: [{ id: goneId, title: 'gonename', cwd: scratch, createdAt: Date.now(), model: 'claude', scopes: [] }],
    recentRepos: [],
  }));
  init(); // loads goneId as 'detached', proc: null
  assert.ok(snapshot().some((a) => a.id === goneId), 'seeded agent is present');
  remove(goneId);
  assert.ok(!snapshot().some((a) => a.id === goneId), 'agent removed after remove()');
});

// respawnAll() kills every live agent; onExit resumes it with the same config
// (id, cwd, model, scopes...) once the session log makes resume available.
// Uses a real ollama-model agent (spawn routed through OLLAMA_BIN = cmd.exe,
// see the file header) so there's a genuine live proc to kill and a genuine
// onExit/setImmediate/create() cycle to observe — the claude-model path can't
// produce one here since CLAUDE_BIN is deliberately invalid for every other test.
test('respawn: Codex identity lookup completes and pins before the live pty is killed', async () => {
  const id = '40000000-dddd-eeee-ffff-400000000005';
  let beginLookup;
  let finishLookup;
  const lookupStarted = new Promise((resolve) => { beginLookup = resolve; });
  const lookupResult = new Promise((resolve) => { finishLookup = resolve; });
  codexIdentity.setCodexIdentityBackend({
    codexThreadFind: async () => { beginLookup(); return lookupResult; },
    codexThreadExists: async () => false,
  });
  try {
    const agent = await create({ cwd: scratch, title: 'codex-respawn-test', model: 'gpt-5.3-codex-spark', tool: 'codex', sessionId: id });
    const pendingRespawn = respawn(id);
    await lookupStarted;
    assert.equal(isLive(id), true, 'lookup is pending while the original pty remains live');
    finishLookup('pinned-thread-id');
    assert.equal(await pendingRespawn, true);

    const deadline = Date.now() + 8000;
    let resumed;
    while (Date.now() < deadline) {
      resumed = snapshot().find((entry) => entry.id === id);
      if (resumed?.pid && resumed.pid !== agent.pid && isLive(id)) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(resumed?.pid && resumed.pid !== agent.pid, 'onExit respawned the same agent');
    assert.equal(await codexThreadFor(id), 'pinned-thread-id', 'the resolved Codex thread stays pinned across respawn');
    await killAndWait(id);
  } finally {
    codexIdentity.setCodexIdentityBackend(modelBackend);
    if (isLive(id)) await killAndWait(id);
  }
});

test('respawnAll: kills a live agent and resumes it with the same id + new pid', async () => {
  const respawnCwd = scratch;
  const id = '40000000-dddd-eeee-ffff-400000000004';
  const a = await create({ cwd: respawnCwd, title: 'resp-test', model: 'glm-5.2:cloud', sessionId: id });
  const firstPid = a.pid;
  assert.ok(firstPid, 'agent spawned with a real pid');

  // Drop a session log after the fact so the post-kill respawn resolves to
  // --resume (buildSpawn/sessionLogExists) instead of a fresh --session-id.
  const dir = join(homedir(), '.claude', 'projects', encodeCwd(respawnCwd));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.jsonl`), `{"sessionId":"${id}","type":"user"}\n`);

  try {
    await respawnAll();

    // Wait for kill -> onExit -> setImmediate(create) to settle: same id back
    // in the registry with a live proc and a different pid.
    const deadline = Date.now() + 5000;
    let respawned;
    while (Date.now() < deadline) {
      respawned = snapshot().find((x) => x.id === id);
      if (respawned?.pid && respawned.pid !== firstPid) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(respawned, 'agent still present after respawn');
    assert.notEqual(respawned.pid, firstPid, 'respawn produced a new (live) pid');

    // Tidy up the respawned live pty before the next test / file teardown.
    await new Promise((resolve) => {
      const onStatus = ({ id: sid, status }) => { if (sid === id && status === 'exited') { bus.off('status', onStatus); resolve(); } };
      bus.on('status', onStatus);
      kill(id);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A kill/remove landing between a respawn's exit and its replacement create()
// used to see no row and no in-flight spawn, so the replacement published anyway
// and the session reappeared. onExit now reserves the replacement synchronously,
// so the existing pending-spawn cancellation covers this window too.
for (const op of ['kill', 'remove']) {
  test(`${op} during an exit-to-respawn window cancels the replacement spawn`, async () => {
    const id = op === 'kill' ? '41000000-dddd-eeee-ffff-410000000001' : '41000000-dddd-eeee-ffff-410000000002';
    const backend = manualPtyBackend();
    registry.setPtyBackend(backend);
    modelStore.setModelsBackend({ modelRoute: async () => claudeRoute });
    const events = [];
    const onOutput = (event) => { if (event.id === id) events.push(['output', event.data]); };
    const onStatus = (event) => { if (event.id === id) events.push(['status', event.status]); };
    bus.on('output', onOutput);
    bus.on('status', onStatus);
    try {
      const creating = create({ cwd: scratch, title: 'respawn-window', model: 'claude', sessionId: id, modelRoute: claudeRoute });
      await backend.waitForSpawn(1);
      backend.release(0);
      await creating;
      assert.equal(await respawn(id), true);
      backend.exit(0); // onExit drops the row and starts the replacement create
      if (op === 'kill') kill(id); else remove(id);
      // Let the replacement resolve its route and its cancellation settle; a
      // buggy deferred create parks in spawn, so release anything it started.
      for (let tick = 0; tick < 5; tick++) {
        for (let i = 0; i < backend.handles.length; i++) backend.release(i);
        await new Promise((resolve) => setImmediate(resolve));
      }
      assert.equal(snapshot().some((row) => row.id === id), false, 'the canceled replacement never publishes a row');
      assert.deepEqual(events, [], 'the canceled replacement emits no output or status');
      assert.equal(backend.spawns.length, 1, 'the canceled replacement never reaches the backend');
      const retried = create({ cwd: scratch, title: 'retry', model: 'claude', sessionId: id, modelRoute: claudeRoute });
      await backend.waitForSpawn(2);
      backend.release(1);
      assert.equal((await retried).id, id);
      assert.equal(isLive(id), true, 'the cancelled respawn releases the id');
    } finally {
      bus.off('output', onOutput);
      bus.off('status', onStatus);
      for (const handle of backend.handles) handle.exitFn?.(0);
      await waitForRemoval(id);
      modelStore.setModelsBackend(modelBackend);
      registry.setPtyBackend(ptyBackend);
    }
  });
}

// VERIFY: respawn-cancel-before-exit
// A kill/remove landing after respawn() queues the replacement (respawnAfterExit
// set) but before the old pty's onExit has fired. onExit prefers respawnAfterExit
// over removeOnExit, so unless an explicit cancel clears the queue the normal
// user kill/remove still starts a replacement.
for (const op of ['kill', 'remove']) {
  test(`${op} before the respawn exit cancels the queued replacement`, async () => {
    const id = op === 'kill' ? '42000000-dddd-eeee-ffff-420000000001' : '42000000-dddd-eeee-ffff-420000000002';
    const backend = manualPtyBackend();
    registry.setPtyBackend(backend);
    modelStore.setModelsBackend({ modelRoute: async () => claudeRoute });
    try {
      const creating = create({ cwd: scratch, title: 'pre-exit-respawn', model: 'claude', sessionId: id, modelRoute: claudeRoute });
      await backend.waitForSpawn(1);
      backend.release(0);
      await creating;

      // respawn() queues the config and kills the old pty; the manual backend
      // holds onExit back, so the queued replacement is still pending.
      assert.equal(await respawn(id), true);
      assert.equal(isLive(id), true, 'old pty is still registered before its exit');
      if (op === 'kill') kill(id); else remove(id);

      backend.exit(0); // the old pty exits after the explicit cancel
      for (let tick = 0; tick < 5; tick++) {
        for (let i = 0; i < backend.handles.length; i++) backend.release(i);
        await new Promise((resolve) => setImmediate(resolve));
      }
      assert.equal(backend.spawns.length, 1, 'the queued respawn never reaches the backend');
      assert.equal(snapshot().some((row) => row.id === id), false, 'the canceled agent stays gone');
      assert.equal(isLive(id), false);
    } finally {
      for (const handle of backend.handles) handle.exitFn?.(0);
      await waitForRemoval(id);
      modelStore.setModelsBackend(modelBackend);
      registry.setPtyBackend(ptyBackend);
    }
  });
}

// VERIFY: respawn-cancel-during-lookup
// respawn() suspends on the Codex identity lookup BEFORE it arms respawnAfterExit,
// so a kill/remove in that window used to clear a still-null flag and the
// continuation armed the replacement anyway — onExit then respawned the
// "removed" session. The cancel is per attempt: a later respawn on the same id
// must still arm.
for (const op of ['kill', 'remove']) {
  test(`${op} during a gated Codex identity lookup cancels that respawn attempt only`, async () => {
    const id = op === 'kill' ? '43000000-eeee-ffff-0000-430000000001' : '43000000-eeee-ffff-0000-430000000002';
    const backend = manualPtyBackend();
    registry.setPtyBackend(backend);
    try {
      const creating = create({ cwd: scratch, title: 'gated-respawn', model: 'gpt-5.3-codex-spark', tool: 'codex', sessionId: id });
      await backend.waitForSpawn(1);
      backend.release(0);
      await creating;

      // Gate the identity lookup respawn() awaits; the pty stays live until the
      // explicit kill/remove below.
      let beginLookup;
      let finishLookup;
      const lookupStarted = new Promise((resolve) => { beginLookup = resolve; });
      const lookupResult = new Promise((resolve) => { finishLookup = resolve; });
      codexIdentity.setCodexIdentityBackend({
        codexThreadFind: async () => { beginLookup(); return lookupResult; },
        codexThreadExists: async () => false,
      });

      const pending = respawn(id);
      await lookupStarted;
      assert.equal(isLive(id), true, 'the lookup is in flight while the original pty is still live');
      if (op === 'kill') kill(id); else remove(id);
      finishLookup('thread-found-too-late');
      assert.equal(await pending, false, 'the canceled attempt does not arm a replacement');

      backend.exit(0); // the explicitly killed pty exits after the cancel
      await waitForRemoval(id);
      assert.equal(backend.spawns.length, 1, 'the canceled respawn never reaches the backend');
      assert.equal(snapshot().some((row) => row.id === id), false, 'the explicitly killed agent stays gone');

      // The earlier cancel must not poison a later attempt on the same id.
      const later = create({ cwd: scratch, title: 'later-respawn', model: 'gpt-5.3-codex-spark', tool: 'codex', sessionId: id });
      await backend.waitForSpawn(2);
      backend.release(1);
      await later;
      assert.equal(await respawn(id), true, 'a later respawn attempt still arms');
      backend.exit(1); // its pty exits → the armed replacement create runs
      await backend.waitForSpawn(3);
      backend.release(2);
      const deadline = Date.now() + 5000;
      while (!isLive(id) && Date.now() < deadline) await new Promise((resolve) => setImmediate(resolve));
      assert.equal(backend.spawns.length, 3, 'the later respawn publishes its replacement');
      assert.equal(isLive(id), true);
    } finally {
      codexIdentity.setCodexIdentityBackend(modelBackend);
      for (const handle of backend.handles) handle.exitFn?.(0);
      for (let i = 0; i < backend.handles.length; i++) backend.release(i); // settle a buggy parked replacement
      await new Promise((resolve) => setImmediate(resolve));
      if (snapshot().some((row) => row.id === id)) { remove(id); for (const handle of backend.handles) handle.exitFn?.(0); }
      await waitForRemoval(id);
      registry.setPtyBackend(ptyBackend);
    }
  });
}

test('Codex transcript liveness resolves a distinct thread id and blocks duplicate owned resumes', async () => {
  const agentId = '90000000-aaaa-bbbb-cccc-900000000005';
  const threadId = 'dddddddd-eeee-ffff-0000-444444444444';
  // Use the cross-platform keepalive Claude fixture for the owned pty, then
  // model the persisted Codex identity fields that its launcher records.
  const agent = await create({ cwd: scratch, title: 'live-codex-owner', model: 'claude', sessionId: agentId });
  agent.model = 'gpt-5.3-codex-spark';
  agent.tool = 'codex';
  agent.threadId = threadId;
  try {
    assert.notEqual(agent.id, threadId);
    assert.equal(isLive(agentId), true, 'the registry owner has a live child process');
    assert.equal(await codexOwnerForThread(threadId, scratch), agentId);
    assert.equal(await isLiveSession(threadId, { source: 'codex', cwd: scratch }), true);
    await assert.rejects(
      () => create({ cwd: scratch, title: 'duplicate-codex-owner', model: 'gpt-5.3-codex-spark', tool: 'codex', sessionId: threadId }),
      /codex thread already in use/,
    );
  } finally {
    await killAndWait(agentId);
  }
});

// A daemon stop/restart persists live Codex agents as detached records and
// init() reloads them with proc:null. Such a record owns no process, so
// re-entering its thread uuid must resume — the in-lifetime exit path deletes
// entries, making init() the only way to reproduce this. Seeded via init()+fake
// agents.json (no spawn).
test('create: a detached Codex record from a restart does not block resuming its thread', async () => {
  const staleId = '90000000-aaaa-bbbb-cccc-900000000006';
  const threadId = 'dddddddd-eeee-ffff-0000-555555555555';
  const stateFile = join(scratch, 'singularity', 'state', 'agents.json');
  writeFileSync(stateFile, JSON.stringify({
    agents: [{ id: staleId, title: 'stale-codex-owner', cwd: scratch, createdAt: Date.now(), model: 'gpt-5.3-codex-spark', tool: 'codex', threadId }],
    recentRepos: [],
  }));
  init(); // loads staleId as 'detached', proc: null
  assert.equal(isLive(staleId), false);
  assert.equal(await codexOwnerForThread(threadId, scratch), null);
  assert.equal(await isLiveSession(threadId, { source: 'codex', cwd: scratch }), false);
  const resumed = await create({ cwd: scratch, title: 'resumed-codex', model: 'gpt-5.3-codex-spark', tool: 'codex', sessionId: threadId });
  try {
    assert.equal(resumed.id, threadId);
    assert.ok(resumed.pid, 'resumed the detached thread instead of refusing it');
  } finally {
    await killAndWait(threadId);
  }
});

// Detached records must be skipped BEFORE rememberCodexThread's rollout
// discovery: otherwise every Codex transcript row re-walks the rollout tree for
// an agent that can never be live, and pins a threadId as a side effect.
test('codexOwnerForThread: a detached record is skipped before rollout discovery', async () => {
  const staleId = '90000000-aaaa-bbbb-cccc-900000000007';
  const discoveryCwd = join(scratch, 'detached-discovery');
  mkdirSync(discoveryCwd, { recursive: true });
  const createdAt = Date.now();
  const threadId = 'dddddddd-eeee-ffff-0000-666666666666';
  const stateFile = join(scratch, 'singularity', 'state', 'agents.json');
  writeFileSync(stateFile, JSON.stringify({
    agents: [{ id: staleId, title: 'detached-undiscovered', cwd: discoveryCwd, createdAt, model: 'gpt-5.3-codex-spark', tool: 'codex' }],
    recentRepos: [],
  }));
  init(); // loads staleId as 'detached', proc: null
  // A rollout that WOULD match cwd+createdAt sits on disk: without the skip,
  // discovery pins it (and persists) although no process exists.
  writeCodexRollout(discoveryCwd, new Date(createdAt + 1000).toISOString(), threadId);
  assert.equal(await isLiveSession(threadId, { source: 'codex', cwd: discoveryCwd }), false);
  assert.equal(await codexOwnerForThread(threadId, discoveryCwd), null);
  assert.equal(JSON.parse(readFileSync(stateFile, 'utf8')).agents.find((a) => a.id === staleId).threadId, undefined,
    'detached record never entered rollout discovery');
});

// Live entries still discover and pin their thread, and an earlier detached
// record for the same thread never wins ownership.
test('codexOwnerForThread: live discovery still pins, outranking an earlier detached record', async () => {
  const liveCwd = join(scratch, 'live-owner-order');
  mkdirSync(liveCwd, { recursive: true });
  const createdAt = Date.now();
  const threadId = 'dddddddd-eeee-ffff-0000-777777777777';
  const staleId = '90000000-aaaa-bbbb-cccc-900000000008';
  const agentId = '90000000-aaaa-bbbb-cccc-900000000009';
  const stateFile = join(scratch, 'singularity', 'state', 'agents.json');
  writeFileSync(stateFile, JSON.stringify({
    agents: [{ id: staleId, title: 'detached-before-live', cwd: liveCwd, createdAt, model: 'gpt-5.3-codex-spark', tool: 'codex', threadId }],
    recentRepos: [],
  }));
  init(); // the detached record enters the registry first
  writeCodexRollout(liveCwd, new Date(createdAt + 1000).toISOString(), threadId);
  const agent = await create({ cwd: liveCwd, title: 'live-codex-owner', model: 'claude', sessionId: agentId });
  agent.model = 'gpt-5.3-codex-spark';
  agent.tool = 'codex';
  try {
    assert.equal(await codexOwnerForThread(threadId, liveCwd), agentId);
    assert.equal(agent.threadId, threadId, 'discovery pinned the rollout thread');
    assert.equal(await isLiveSession(threadId, { source: 'codex', cwd: liveCwd }), true);
    await assert.rejects(
      () => create({ cwd: liveCwd, title: 'duplicate-live-owner', model: 'gpt-5.3-codex-spark', tool: 'codex', sessionId: threadId }),
      /codex thread already in use/,
    );
  } finally {
    await killAndWait(agentId);
  }
});

// beginDrain(): daemon shutdown snapshots every live session to agents.json as
// detached, and the ensuing pty-exit (onExit) no-ops instead of deleting — so a
// restart reloads the sessions rather than dropping them from the list. Kept
// last: draining is a module-global one-way flag, so it must not affect the
// tests above. Uses the ollama/cmd.exe live-pty trick (see file header).
test('externalLaunch: existing Claude session follows changed Codex route without revalidating tool', async () => {
  const previous = await customModelGroup('claude');
  const id = '70000000-eeee-ffff-0000-700000000017';
  try {
    await create({ sessionId: id, cwd: scratch, title: 'route-change-launch', model: 'gpt-custom', tool: 'claude' });
    await customModelGroup('codex');
    const r = await externalLaunch(id, 'darwin');
    assert.equal(r.ok, true);
    const script = r.launcherArgs[r.launcherArgs.indexOf('-e') + 1];
    assert.ok(script.includes("'-s' 'workspace-write'"), 'the fresh Codex builder is used');
    assert.ok(script.includes('gpt-custom'));
  } finally {
    await killAndWait(id);
    await modelStore.setModels(previous);
  }
});

test('agent exit uses fresh Codex route after catalogue edit', async () => {
  const previous = await customModelGroup('claude');
  const id = '70000000-eeee-ffff-0000-700000000018';
  try {
    await create({ sessionId: id, cwd: scratch, title: 'route-change-exit', model: 'gpt-custom', tool: 'claude' });
    await customModelGroup('codex');
    const output = waitForOutput(id, /resume: codex/);
    const removed = waitForRemoval(id);
    await killAndWait(id);
    assert.match(await output, /resume: codex/);
    await removed;
    assert.equal(snapshot().some((agent) => agent.id === id), false, 'exited agent is removed from lifecycle state');
  } finally {
    if (snapshot().some((agent) => agent.id === id)) await killAndWait(id);
    await modelStore.setModels(previous);
  }
});

test('agent exit bridge failure still cleans up and emits a handled resume status', async () => {
  const previous = await customModelGroup('claude');
  const id = '70000000-eeee-ffff-0000-700000000019';
  try {
    await create({ sessionId: id, cwd: scratch, title: 'route-bridge-failure', model: 'gpt-custom', tool: 'claude' });
    const output = waitForOutput(id, /resume command unavailable/);
    const removed = waitForRemoval(id);
    modelStore.setModelsBackend({ modelRoute: async () => { throw new Error('test bridge failure'); } });
    await killAndWait(id);
    assert.match(await output, /resume command unavailable/);
    await removed;
    assert.equal(snapshot().some((agent) => agent.id === id), false, 'bridge failure does not retain the exited agent');
  } finally {
    modelStore.setModelsBackend(modelBackend);
    await modelStore.setModels(previous);
  }
});

// --- same-id spawn serialization ---
// create() used to check the registry, then await route/build/spawn, then insert:
// two concurrent same-id calls both spawned (Rust replaces the first generation).
// The id must be reserved synchronously before the first await, so one caller
// spawns and the other is rejected/shared deterministically.
test('create: concurrent same-id calls reserve before the first await — one spawn, loser rejected', async () => {
  const id = '81000000-0000-4000-8000-000000000001';
  const backend = manualPtyBackend();
  registry.setPtyBackend(backend);
  try {
    const first = create({ cwd: scratch, title: 'first', model: 'claude', sessionId: id, modelRoute: claudeRoute });
    await new Promise((resolve) => setImmediate(resolve)); // first is parked inside ptyBackend.spawn
    const second = create({ cwd: scratch, title: 'second', model: 'claude', sessionId: id, modelRoute: claudeRoute });
    const secondResult = second.then((value) => ({ value }), (error) => ({ error }));
    await new Promise((resolve) => setImmediate(resolve));
    for (let i = 0; i < backend.handles.length; i++) backend.release(i);
    const firstAgent = await first;
    const settled = await secondResult;
    assert.equal(backend.spawns.length, 1, 'same-id create must not spawn twice');
    assert.ok(settled.error, 'the second caller is rejected while the first owns the id');
    assert.match(settled.error.message, /already in use/);
    assert.equal(firstAgent.id, id);
    assert.equal(isLive(id), true);
  } finally {
    for (const handle of backend.handles) handle.exitFn?.(0);
    await waitForRemoval(id);
    registry.setPtyBackend(ptyBackend);
  }
});

test('create: a slow route lookup in the first caller cannot let a second caller spawn the same id', async () => {
  const id = '81000000-0000-4000-8000-000000000002';
  const backend = manualPtyBackend();
  registry.setPtyBackend(backend);
  let releaseRoute;
  let markRoute;
  const routeStarted = new Promise((resolve) => { markRoute = resolve; });
  const routeGate = new Promise((resolve) => { releaseRoute = resolve; });
  modelStore.setModelsBackend({ modelRoute: async () => { markRoute(); return routeGate; } });
  try {
    const slow = create({ cwd: scratch, title: 'slow', model: 'claude', sessionId: id }); // awaits its route
    const slowResult = slow.then((value) => ({ value }), (error) => ({ error }));
    await routeStarted;
    const fast = create({ cwd: scratch, title: 'fast', model: 'claude', sessionId: id, modelRoute: claudeRoute });
    const fastResult = fast.then((value) => ({ value }), (error) => ({ error }));
    await new Promise((resolve) => setImmediate(resolve));
    releaseRoute(claudeRoute);
    await new Promise((resolve) => setImmediate(resolve)); // slow reaches its spawn
    for (let i = 0; i < backend.handles.length; i++) backend.release(i);
    const [slowSettled, fastSettled] = await Promise.all([slowResult, fastResult]);
    assert.equal(backend.spawns.length, 1, 'slow and fast callers must not both spawn');
    assert.equal(slowSettled.error, undefined, 'the first (slow) caller owns the id');
    assert.ok(fastSettled.error, 'the second caller is rejected while the first owns the id');
    assert.match(fastSettled.error.message, /already in use/);
  } finally {
    for (const handle of backend.handles) handle.exitFn?.(0);
    await waitForRemoval(id);
    registry.setPtyBackend(ptyBackend);
    modelStore.setModelsBackend(modelBackend);
  }
});

test('reattach: concurrent calls share one reserved spawn', async () => {
  const id = '81000000-0000-4000-8000-000000000003';
  seedDetached(id);
  const backend = manualPtyBackend();
  registry.setPtyBackend(backend);
  modelStore.setModelsBackend({ modelRoute: async () => claudeRoute });
  try {
    const first = reattach(id);
    await new Promise((resolve) => setImmediate(resolve)); // parked in spawn
    const second = reattach(id);
    await new Promise((resolve) => setImmediate(resolve));
    for (let i = 0; i < backend.handles.length; i++) backend.release(i);
    const [a1, a2] = await Promise.all([first, second]);
    assert.equal(backend.spawns.length, 1, 'concurrent reattach must not spawn twice');
    assert.equal(a1, a2);
    assert.equal(a1.pid, backend.handles[0].pid, 'no later spawn replaced the first pty');
    assert.equal(isLive(id), true);
  } finally {
    for (const handle of backend.handles) handle.exitFn?.(0);
    await waitForRemoval(id);
    registry.setPtyBackend(ptyBackend);
    modelStore.setModelsBackend(modelBackend);
  }
});

test('create/reattach overlap: reattach joins an in-flight fresh create instead of returning nothing', async () => {
  const id = '81000000-0000-4000-8000-000000000004';
  const backend = manualPtyBackend();
  registry.setPtyBackend(backend);
  try {
    const creating = create({ cwd: scratch, title: 'first', model: 'claude', sessionId: id, modelRoute: claudeRoute });
    await new Promise((resolve) => setImmediate(resolve)); // parked in spawn, not registered yet
    const joining = reattach(id);
    const joiningResult = joining.then((value) => ({ value }), (error) => ({ error }));
    await new Promise((resolve) => setImmediate(resolve));
    for (let i = 0; i < backend.handles.length; i++) backend.release(i);
    const agent = await creating;
    const joined = await joiningResult;
    assert.equal(backend.spawns.length, 1, 'reattach must not race a pending create');
    assert.equal(joined.error, undefined);
    assert.equal(joined.value, agent, 'reattach shares the pending create result');
    assert.equal(isLive(id), true);
  } finally {
    for (const handle of backend.handles) handle.exitFn?.(0);
    await waitForRemoval(id);
    registry.setPtyBackend(ptyBackend);
  }
});

test('create: a failed spawn releases the reservation so the id can be retried', async () => {
  const id = '81000000-0000-4000-8000-000000000005';
  let attempts = 0;
  const handles = [];
  const backend = {
    spawn: async () => {
      if (attempts++ === 0) throw new Error('spawn exploded');
      const handle = { pid: 9500, onData() { return handle; }, onExit(fn) { handle.exitFn = fn; return handle; }, activate() { return handle; }, write: async () => {}, resize: async () => {}, kill: async () => {} };
      handles.push(handle);
      return handle;
    },
  };
  registry.setPtyBackend(backend);
  try {
    await assert.rejects(
      create({ cwd: scratch, title: 'boom', model: 'claude', sessionId: id, modelRoute: claudeRoute }),
      /spawn exploded/,
    );
    assert.equal(snapshot().some((agent) => agent.id === id), false, 'failed create never registers');
    const retried = await create({ cwd: scratch, title: 'retry', model: 'claude', sessionId: id, modelRoute: claudeRoute });
    assert.equal(retried.id, id);
    assert.equal(isLive(id), true);
  } finally {
    for (const handle of handles) handle.exitFn?.(0);
    await waitForRemoval(id);
    registry.setPtyBackend(ptyBackend);
  }
});

// A stale exit's async footer/cleanup must not touch a newer generation: the
// pty service replaced the old generation, but the old exit handler still ran
// route/thread work after clearing proc. Guard by object + generation at every
// await boundary.
test('stale exit after reattach: old cleanup emits no footer and keeps the new pty', async () => {
  const id = '81000000-0000-4000-8000-000000000006';
  const backend = manualPtyBackend();
  registry.setPtyBackend(backend);
  let releaseExitRoute;
  let markExitRoute;
  const exitRouteStarted = new Promise((resolve) => { markExitRoute = resolve; });
  const exitRoute = new Promise((resolve) => { releaseExitRoute = resolve; });
  let routeCalls = 0;
  modelStore.setModelsBackend({ modelRoute: async () => {
    routeCalls++;
    if (routeCalls === 1) { markExitRoute(); return exitRoute; }
    return claudeRoute;
  } });
  const output = [];
  const onOutput = (event) => { if (event.id === id) output.push(event.data); };
  bus.on('output', onOutput);
  try {
    const creating = create({ cwd: scratch, title: 'stale', model: 'claude', sessionId: id, modelRoute: claudeRoute });
    await new Promise((resolve) => setImmediate(resolve)); // create parked in spawn
    backend.release(0);
    const a = await creating;
    backend.exit(0); // old pty dies; its route work parks
    await exitRouteStarted;
    const reattaching = reattach(id); // new generation starts while old cleanup is pending
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(backend.spawns.length, 2, 'reattach reached its own spawn');
    releaseExitRoute({ isClaudeModel: true, isCodexModel: false });
    await new Promise((resolve) => setImmediate(resolve)); // stale cleanup resolves
    assert.ok(snapshot().some((entry) => entry.id === id), 'stale exit must not delete the reattached entry');
    backend.release(1);
    const b = await reattaching;
    assert.equal(b, a);
    assert.equal(b.pid, backend.handles[1].pid);
    assert.equal(isLive(id), true);
    assert.equal(output.some((data) => /agent exited/.test(data)), false, 'no footer for the obsolete generation');
  } finally {
    bus.off('output', onOutput);
    for (const handle of backend.handles) handle.exitFn?.(0);
    await waitForRemoval(id);
    registry.setPtyBackend(ptyBackend);
    modelStore.setModelsBackend(modelBackend);
  }
});

test('stale exit rejection after a fresh create: no fallback footer and no deletion of the new entry', async () => {
  const id = '81000000-0000-4000-8000-000000000007';
  const backend = manualPtyBackend();
  registry.setPtyBackend(backend);
  let rejectExitRoute;
  let markExitRoute;
  const exitRouteStarted = new Promise((resolve) => { markExitRoute = resolve; });
  const exitRoute = new Promise((resolve, reject) => { rejectExitRoute = reject; });
  let routeCalls = 0;
  modelStore.setModelsBackend({ modelRoute: async () => {
    routeCalls++;
    if (routeCalls === 1) { markExitRoute(); return exitRoute; }
    return claudeRoute;
  } });
  const output = [];
  const onOutput = (event) => { if (event.id === id) output.push(event.data); };
  bus.on('output', onOutput);
  try {
    const creating = create({ cwd: scratch, title: 'stale', model: 'claude', sessionId: id, modelRoute: claudeRoute });
    await new Promise((resolve) => setImmediate(resolve)); // create parked in spawn
    backend.release(0);
    await creating;
    backend.exit(0);
    await exitRouteStarted;
    remove(id); // detached entry dropped while the old exit cleanup is pending
    const replacing = create({ cwd: scratch, title: 'replacement', model: 'claude', sessionId: id, modelRoute: claudeRoute });
    await new Promise((resolve) => setImmediate(resolve));
    backend.release(1);
    const b = await replacing;
    rejectExitRoute(new Error('route lookup failed'));
    await new Promise((resolve) => setImmediate(resolve)); // stale rejection settles
    const entry = snapshot().find((e) => e.id === id);
    assert.ok(entry, 'stale rejection must not delete the new entry');
    assert.equal(entry.pid, backend.handles[1].pid);
    assert.equal(b.pid, backend.handles[1].pid);
    assert.equal(output.some((data) => /resume command unavailable/.test(data)), false, 'no fallback footer for the obsolete generation');
  } finally {
    bus.off('output', onOutput);
    for (const handle of backend.handles) handle.exitFn?.(0);
    await waitForRemoval(id);
    registry.setPtyBackend(ptyBackend);
    modelStore.setModelsBackend(modelBackend);
  }
});

// --- kill/remove during a pending spawn ---
// kill()/remove() used to see proc:null while route/build/spawn was in flight and
// drop the row; the spawn then resolved and published (create) or attached
// (reattach) an unowned live pty that no registry drain could kill. Cancellation
// must stop publication, skip a spawn that has not started, and kill a pty that
// arrives after removal — while the id stays reserved until the operation settles.
const pendingKinds = ['create', 'reattach'];
const pendingOps = ['kill', 'remove'];
let pendingCase = 0;
for (const kind of pendingKinds) {
  for (const op of pendingOps) {
    pendingCase++;
    const id = `83000000-0000-4000-8000-00000000000${pendingCase}`;
    test(`${op} during a pending ${kind} spawn: nothing published, arriving pty killed, id reusable after settle`, async () => {
      if (kind === 'reattach') seedDetached(id);
      const backend = manualPtyBackend();
      registry.setPtyBackend(backend);
      const events = [];
      const onOutput = (event) => { if (event.id === id) events.push(['output', event.data]); };
      const onStatus = (event) => { if (event.id === id) events.push(['status', event.status]); };
      bus.on('output', onOutput);
      bus.on('status', onStatus);
      try {
        const pending = kind === 'create'
          ? create({ cwd: scratch, title: 'pending', model: 'claude', sessionId: id, modelRoute: claudeRoute })
          : reattach(id);
        const settled = pending.then((value) => ({ value }), (error) => ({ error }));
        await backend.waitForSpawn(1); // parked in ptyBackend.spawn
        assert.equal(backend.spawns.length, 1, 'the spawn reached the backend before cancellation');
        if (op === 'kill') kill(id); else remove(id);
        assert.equal(snapshot().some((row) => row.id === id), false, 'cancellation publishes no row');
        backend.release(0);
        const result = await settled;
        assert.ok(result.error, 'the canceled spawn rejects');
        assert.equal(result.value, undefined, 'no agent is returned');
        assert.match(result.error.message, /removed/);
        assert.equal(snapshot().some((row) => row.id === id), false, 'the late pty is never published');
        assert.equal(backend.handles[0].killed, true, 'the late pty is killed');
        assert.deepEqual(events, [], 'the canceled spawn emits no output or status');
        const retried = create({ cwd: scratch, title: 'retry', model: 'claude', sessionId: id, modelRoute: claudeRoute });
        await backend.waitForSpawn(2);
        backend.release(1);
        assert.equal((await retried).id, id);
        assert.equal(isLive(id), true, 'the id is reusable after the cancellation settles');
      } finally {
        bus.off('output', onOutput);
        bus.off('status', onStatus);
        for (const handle of backend.handles) handle.exitFn?.(0);
        await waitForRemoval(id);
        registry.setPtyBackend(ptyBackend);
      }
    });

    pendingCase++;
    const earlyId = `84000000-0000-4000-8000-00000000000${pendingCase}`;
    test(`${op} before a pending ${kind} spawn starts: no pty is spawned`, async () => {
      if (kind === 'reattach') seedDetached(earlyId);
      const backend = manualPtyBackend();
      registry.setPtyBackend(backend);
      let releaseRoute;
      let markRoute;
      const routeStarted = new Promise((resolve) => { markRoute = resolve; });
      const routeGate = new Promise((resolve) => { releaseRoute = resolve; });
      modelStore.setModelsBackend({ modelRoute: async () => { markRoute(); return routeGate; } });
      try {
        const pending = kind === 'create'
          ? create({ cwd: scratch, title: 'gated', model: 'claude', sessionId: earlyId }) // parked on its route lookup
          : reattach(earlyId); // reattach always awaits its route
        const settled = pending.then((value) => ({ value }), (error) => ({ error }));
        await routeStarted;
        if (op === 'kill') kill(earlyId); else remove(earlyId);
        assert.equal(snapshot().some((row) => row.id === earlyId), false, 'cancellation publishes no row');
        releaseRoute(claudeRoute);
        await new Promise((resolve) => setImmediate(resolve)); // canceled code rejects here; a buggy one parks in spawn
        for (let i = 0; i < backend.handles.length; i++) backend.release(i); // let a buggy spawn settle so the assertion fails, not hangs
        const result = await settled;
        assert.ok(result.error, 'the canceled spawn rejects');
        assert.match(result.error.message, /removed/);
        assert.equal(backend.spawns.length, 0, 'a canceled spawn must not reach the backend');
        modelStore.setModelsBackend(modelBackend);
        const retried = create({ cwd: scratch, title: 'retry', model: 'claude', sessionId: earlyId, modelRoute: claudeRoute });
        await backend.waitForSpawn(1);
        backend.release(0);
        assert.equal((await retried).id, earlyId);
        assert.equal(isLive(earlyId), true, 'the id is reusable after the cancellation settles');
      } finally {
        modelStore.setModelsBackend(modelBackend);
        for (const handle of backend.handles) handle.exitFn?.(0);
        await waitForRemoval(earlyId);
        registry.setPtyBackend(ptyBackend);
      }
    });
  }
}

// VERIFY: reattach-failure-exit-cleanup
// reattach() bumps a.gen before its awaits, which disarms the concurrently
// exited pty's pending onExit cleanup. A reattach that then fails must finish
// that cleanup for the generation it claimed instead of leaving a dead 'exited'
// row in the registry and agents.json forever.
test('failed reattach of a concurrently exited agent removes the dead exited row', async () => {
  const id = '44000000-ffff-0000-4444-440000000001';
  const backend = manualPtyBackend();
  registry.setPtyBackend(backend);
  let releaseExitRoute;
  let markExitRoute;
  const exitRouteStarted = new Promise((resolve) => { markExitRoute = resolve; });
  const exitRoute = new Promise((resolve) => { releaseExitRoute = resolve; });
  let routeCalls = 0;
  modelStore.setModelsBackend({ modelRoute: async () => {
    routeCalls++;
    if (routeCalls === 1) { markExitRoute(); return exitRoute; } // the exit cleanup parks here
    return claudeRoute;
  } });
  try {
    const creating = create({ cwd: scratch, title: 'failed-reattach', model: 'claude', sessionId: id, modelRoute: claudeRoute });
    await backend.waitForSpawn(1);
    backend.release(0);
    await creating;

    backend.exit(0); // pty dies; its cleanup's current() check is still pending
    await exitRouteStarted;
    // Reattach in that window; its own spawn fails, so nothing re-owns the row.
    backend.spawn = async () => { throw new Error('spawn unavailable'); };
    await assert.rejects(() => reattach(id), /spawn unavailable/);
    assert.equal(snapshot().some((row) => row.id === id), false, 'the failed reattach removes the dead exited row');
    const onDisk = JSON.parse(readFileSync(join(process.env.SINGULARITY_HOME, 'state', 'agents.json'), 'utf8')).agents;
    assert.equal(onDisk.some((row) => row.id === id), false, 'the dead row is not persisted');

    releaseExitRoute(claudeRoute); // the disarmed cleanup must not resurrect a row
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(snapshot().some((row) => row.id === id), false, 'the stale cleanup leaves the registry empty of the id');
  } finally {
    releaseExitRoute(claudeRoute); // unblock the parked cleanup even on a failed assertion
    for (const handle of backend.handles) handle.exitFn?.(0);
    if (snapshot().some((row) => row.id === id)) remove(id); // a buggy run leaves the dead row behind
    await waitForRemoval(id);
    registry.setPtyBackend(ptyBackend);
    modelStore.setModelsBackend(modelBackend);
  }
});

test('failed reattach of an ordinary detached row keeps it for retry', async () => {
  const id = '44000000-ffff-0000-4444-440000000002';
  seedDetached(id);
  registry.setPtyBackend({ spawn: async () => { throw new Error('spawn unavailable'); } });
  try {
    await assert.rejects(() => reattach(id), /spawn unavailable/);
    const row = snapshot().find((entry) => entry.id === id);
    assert.ok(row, 'a detached row is retryable, not cleanup debris');
    assert.equal(row.status, 'detached');
  } finally {
    registry.setPtyBackend(ptyBackend);
    remove(id); // drop the seeded row
  }
});

test('beginDrain: live session persists to agents.json and survives its pty exit', async () => {
  const id = '50000000-aaaa-bbbb-cccc-500000000005';
  const a = await create({ cwd: scratch, title: 'drain-test', model: 'glm-5.2:cloud', sessionId: id });
  assert.ok(a.pid, 'agent spawned live');
  const readAgents = () => JSON.parse(readFileSync(join(process.env.SINGULARITY_HOME, 'state', 'agents.json'), 'utf8')).agents;

  beginDrain(); // snapshots the live fleet to disk as detached
  const onDisk = readAgents().find((x) => x.id === id);
  assert.ok(onDisk, 'live session written to agents.json at drain');
  assert.equal(onDisk.status, 'detached', 'stored as detached (resumable)');

  kill(id); // pty dies → onExit must NOT delete the entry while draining
  const exitDeadline = Date.now() + 5_000;
  while (isLive(id) && Date.now() < exitDeadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(isLive(id), false, 'pty exits after kill while draining');
  assert.ok(snapshot().find((x) => x.id === id), 'entry retained in registry after pty exit (drain guard)');
  assert.ok(readAgents().find((x) => x.id === id), 'entry retained in agents.json after pty exit');
});

test('ensureTrusted: upserts hasTrustDialogAccepted:true keyed on cwd with \\→/', async () => {
  const file = join(scratch, 'trust-upsert.json');
  writeFileSync(file, JSON.stringify({ projects: {} }));
  ensureTrusted('C:\\Users\\user', file);
  const json = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(json.projects['C:/Users/user'].hasTrustDialogAccepted, true);
});

test('ensureTrusted: flips an existing false entry to true, preserves other keys', async () => {
  const file = join(scratch, 'trust-flip.json');
  writeFileSync(file, JSON.stringify({
    projects: { 'C:/Users/user': { hasTrustDialogAccepted: false, other: 1 } },
  }));
  ensureTrusted('C:\\Users\\user', file);
  const json = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(json.projects['C:/Users/user'].hasTrustDialogAccepted, true);
  assert.equal(json.projects['C:/Users/user'].other, 1); // sibling fields untouched
});

test('ensureTrusted: no-op (no write) when already trusted', async () => {
  const file = join(scratch, 'trust-noop.json');
  writeFileSync(file, JSON.stringify({ projects: { 'C:/x': { hasTrustDialogAccepted: true } } }));
  const before = readFileSync(file, 'utf8');
  ensureTrusted('C:\\x', file);
  assert.equal(readFileSync(file, 'utf8'), before); // short-circuit → byte-identical
});

test('ensureTrusted: creates projects map when missing, never throws on bad/missing file', async () => {
  const file = join(scratch, 'trust-empty.json');
  writeFileSync(file, JSON.stringify({}));
  ensureTrusted('C:\\y', file);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).projects['C:/y'].hasTrustDialogAccepted, true);
  // missing file + unparseable file both swallow silently
  assert.doesNotThrow(() => ensureTrusted('C:\\z', join(scratch, 'does-not-exist.json')));
});

// externalLaunch: pure builder for the "open in external terminal" route. Seeded
// via init()+fake agents.json (no spawn) like the fork/remove tests. Random id
// has no session log → buildSpawn yields --session-id. Platform param exercises
// both branches on any host.
test('externalLaunch: win32 wraps wt.exe with -d <cwd> + resume argv', async () => {
  const id = '60000000-eeee-ffff-0000-600000000006';
  const stateFile = join(scratch, 'singularity', 'state', 'agents.json');
  writeFileSync(stateFile, JSON.stringify({
    agents: [{ id, title: 'extwin', cwd: scratch, createdAt: Date.now(), model: 'claude', scopes: [] }],
    recentRepos: [],
  }));
  init();
  const localAppData = mkdtempSync(join(tmpdir(), 'sing-wt-extlaunch-'));
  const aliasDir = join(localAppData, 'Microsoft', 'WindowsApps');
  mkdirSync(aliasDir, { recursive: true });
  writeFileSync(join(aliasDir, 'wt.exe'), '');
  chmodSync(join(aliasDir, 'wt.exe'), 0o755);
  const r = await externalLaunch(id, 'win32', { LOCALAPPDATA: localAppData, PATH: '' });
  assert.equal(r.ok, true);
  assert.match(r.launcher, /WindowsApps[\\/]wt\.exe$/);
  assert.equal(r.launcherArgs[0], '-d');
  assert.equal(r.launcherArgs[1], scratch);
  assert.ok(r.launcherArgs.includes('--session-id'), 'resume argv present');
  assert.equal(r.launcherArgs[r.launcherArgs.indexOf('--session-id') + 1], id);
  assert.equal(r.cwd, scratch);
});

test('externalLaunch: darwin wraps osascript do-script with cd + exec', async () => {
  const id = '70000000-eeee-ffff-0000-700000000007';
  const stateFile = join(scratch, 'singularity', 'state', 'agents.json');
  writeFileSync(stateFile, JSON.stringify({
    agents: [{ id, title: 'extmac', cwd: scratch, createdAt: Date.now(), model: 'claude', scopes: [] }],
    recentRepos: [],
  }));
  init();
  const r = await externalLaunch(id, 'darwin');
  assert.equal(r.ok, true);
  assert.equal(r.launcher, 'osascript');
  const script = r.launcherArgs[r.launcherArgs.indexOf('-e') + 1];
  assert.match(script, /tell application "Terminal" to do script/);
  assert.match(script, new RegExp(`cd '.*'`));
  assert.match(script, /exec '/);
  assert.ok(script.includes(id), 'session id embedded in the shell string');
});

test('externalLaunch: unknown id + unsupported platform error cleanly', async () => {
  assert.equal((await externalLaunch('no-such-id')).ok, false);
  // unsupported platform with a real agent still errors (use a seeded one)
  const id = '80000000-eeee-ffff-0000-800000000008';
  const stateFile = join(scratch, 'singularity', 'state', 'agents.json');
  writeFileSync(stateFile, JSON.stringify({
    agents: [{ id, title: 'extlinux', cwd: scratch, createdAt: Date.now(), model: 'claude', scopes: [] }],
    recentRepos: [],
  }));
  init();
  const r = await externalLaunch(id, 'linux');
  assert.equal(r.ok, false);
  assert.match(r.error, /Windows\/macOS only/);
});

test('buildSpawn: ollama model on resume injects --model to override stripped transcript model', async () => {
  const dir = join(homedir(), '.claude', 'projects', encodeCwd(cwd));
  const log = join(dir, `${freshId}.jsonl`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(log, '{}\n');
  try {
    const { args } = await buildSpawn({ id: freshId, title: 'demo', cwd, model: 'glm-5.2:cloud', scopes: [] });
    // ollama-wrapped: launch claude --model <m> -- ... --resume ... --model <m>
    assert.deepEqual(args.slice(0, 4), ['launch', 'claude', '--model', 'glm-5.2:cloud']);
    assert.ok(args.includes('--resume'));
    // --model appears twice: once for the ollama wrapper, once forwarded to claude.
    assert.equal(args.filter((a) => a === '--model').length, 2);
  } catch (e) {
    // Environments without ollama on PATH throw before wrapping — logic untestable there.
    assert.match(e.message, /ollama not found/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- buildSpawn: codex branch ----
// Codex CLI has no --session-id/--name/--resume; buildSpawn returns a fresh
// invocation with -C/-s/-a/-m + positional prompt. permissionMode set (tasks)
// → -a never (auto-run); unset (foreground) → -a on-request (TUI prompts).
test('buildSpawn: codex fresh spawn uses -C, -s workspace-write, -a on-request, -m, prompt; no --resume/--session-id/launch', async () => {
  const { bin, args } = await buildSpawn({ id: freshId, title: 'demo', cwd, model: 'gpt-5.3-codex-spark', scopes: [], tool: 'codex' }, 'do the work');
  assert.equal(bin, process.env.CODEX_BIN);
  assert.equal(args[args.indexOf('-C') + 1], cwd);
  assert.equal(args[args.indexOf('-s') + 1], 'workspace-write');
  assert.equal(args[args.indexOf('-a') + 1], 'on-request');
  assert.equal(args[args.indexOf('-m') + 1], 'gpt-5.3-codex-spark');
  assert.ok(args.includes('do the work'));
  assert.ok(!args.includes('--resume'));
  assert.ok(!args.includes('--session-id'));
  assert.ok(!args.includes('launch'));
  assert.ok(!args.includes('--name'));
});

test('buildSpawn: codex disables skills outside selected scopes from the current manifest shape', async () => {
  const { args } = await buildSpawn({ id: freshId, title: 'demo', cwd, model: 'gpt-5.3-codex-spark', scopes: ['coding'], tool: 'codex' });
  const config = args[args.indexOf('-c') + 1];
  assert.ok(config.includes(`path="${join(harnessSkillDir, 'SKILL.md').replaceAll('\\', '/')}"`));
  assert.doesNotMatch(config, /coding-skill/);
});

test('buildSpawn: codex with permissionMode set → -a never', async () => {
  const { args } = await buildSpawn({ id: freshId, title: 'demo', cwd, model: 'gpt-5.3-codex-spark', scopes: [], tool: 'codex', permissionMode: 'acceptEdits' }, 'do the work');
  assert.equal(args[args.indexOf('-a') + 1], 'never');
});

test('buildSpawn: codex with no model → no -m flag', async () => {
  const { args } = await buildSpawn({ id: freshId, title: 'demo', cwd, model: '', scopes: [], tool: 'codex' }, 'work');
  assert.ok(!args.includes('-m'));
});

test('buildSpawn: gpt-* model with tool="claude" routes to codex bin (model-driven)', async () => {
  const { bin, args } = await buildSpawn({ id: freshId, title: 'demo', cwd, model: 'gpt-6-luna', scopes: [], tool: 'claude' }, 'do the work');
  assert.equal(bin, process.env.CODEX_BIN);
  assert.equal(args[args.indexOf('-m') + 1], 'gpt-6-luna');
  assert.ok(args.includes('do the work'));
  assert.ok(!args.includes('--session-id'));
  assert.ok(!args.includes('launch'));
});

// ---- buildSpawn: codex resume ----
// Codex has no --session-id pinning, so a reattach resumes by uuid recovered
// from its rollout file (findCodexThread, see codex-thread.mjs) rather than
// spawning fresh. A rollout's first line is a session_meta event; cwd + a
// payload.timestamp at/after createdAt (minus 5s skew) is what makes it match.
function writeCodexRollout(rolloutCwd, timestamp, threadId) {
  const dir = join(codexHome, 'sessions', '2026', '08', '03');
  mkdirSync(dir, { recursive: true });
  const meta = {
    timestamp,
    type: 'session_meta',
    payload: {
      session_id: threadId, id: threadId, timestamp, cwd: rolloutCwd,
      originator: 'codex-tui', source: 'cli', thread_source: 'user', model_provider: 'openai',
    },
  };
  writeFileSync(join(dir, `rollout-${Date.now()}-${threadId}.jsonl`), JSON.stringify(meta) + '\n');
}

test('buildSpawn: codex resume — matching rollout found → argv starts with resume <uuid>, keeps -C/-s/-m', async () => {
  const createdAt = Date.now();
  const threadId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  writeCodexRollout(cwd, new Date(createdAt + 1000).toISOString(), threadId);
  const { args } = await buildSpawn({ id: freshId, title: 'demo', cwd, model: 'gpt-5.3-codex-spark', scopes: [], tool: 'codex', createdAt });
  assert.deepEqual(args.slice(0, 2), ['resume', threadId]);
  assert.equal(args[args.indexOf('-C') + 1], cwd);
  assert.equal(args[args.indexOf('-s') + 1], 'workspace-write');
  assert.equal(args[args.indexOf('-m') + 1], 'gpt-5.3-codex-spark');
});

test('buildSpawn: codex resume suppresses the initial prompt (would re-submit as a new turn)', async () => {
  const createdAt = Date.now();
  const threadId = 'aaaaaaaa-bbbb-cccc-dddd-ffffffffffff';
  writeCodexRollout(cwd, new Date(createdAt + 1000).toISOString(), threadId);
  const { args } = await buildSpawn({ id: freshId, title: 'demo', cwd, model: 'gpt-5.3-codex-spark', scopes: [], tool: 'codex', createdAt }, 'do the work');
  assert.ok(args.includes('resume'));
  assert.ok(!args.includes('do the work'), 'prompt not resent on resume');
});

test('buildSpawn: codex — no matching rollout (different cwd, or no createdAt) → today\'s fresh-spawn argv, unchanged', async () => {
  const createdAt = Date.now();
  // A fixture exists, but for a cwd that's neither this call's cwd nor any
  // other test's — the rollout is on disk yet must not match.
  const rolloutCwd = 'C:\\some\\other\\cwd\\not-matching';
  const callCwd = 'C:\\yet\\another\\cwd\\never-fixtured';
  writeCodexRollout(rolloutCwd, new Date(createdAt + 1000).toISOString(), 'zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz');

  const { args: mismatchedCwd } = await buildSpawn({ id: freshId, title: 'demo', cwd: callCwd, model: 'gpt-5.3-codex-spark', scopes: [], tool: 'codex', createdAt }, 'work');
  assert.ok(!mismatchedCwd.includes('resume'));
  assert.ok(mismatchedCwd.includes('work'));

  const { args: noCreatedAt } = await buildSpawn({ id: freshId, title: 'demo', cwd, model: 'gpt-5.3-codex-spark', scopes: [], tool: 'codex' }, 'work');
  assert.ok(!noCreatedAt.includes('resume'));
  assert.ok(noCreatedAt.includes('work'));
});

// ---- buildSpawn: codex resume by caller-supplied id (no createdAt) ----
// create({ sessionId: <codex thread uuid>, tool:'codex' }) from the
// Transcripts view (or a uuid typed into the New-session dialog) passes no
// createdAt — findCodexThread has nothing to discover by, so buildSpawn must
// fall back to confirming `id` is itself a known codex thread for this cwd.
test('buildSpawn: codex resume by caller id, no createdAt — matching rollout for this cwd → argv starts with resume <uuid>', async () => {
  const threadId = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
  writeCodexRollout(cwd, new Date().toISOString(), threadId);
  const { args } = await buildSpawn({ id: threadId, title: 'demo', cwd, model: 'gpt-5.3-codex-spark', scopes: [], tool: 'codex' });
  assert.deepEqual(args.slice(0, 2), ['resume', threadId]);
});

test('buildSpawn: codex resume by caller id, no createdAt — rollout is for a different cwd → no resume', async () => {
  const threadId = 'cccccccc-dddd-eeee-ffff-000000000000';
  const otherCwd = 'C:\\some\\unrelated\\cwd\\for-this-thread';
  writeCodexRollout(otherCwd, new Date().toISOString(), threadId);
  const { args } = await buildSpawn({ id: threadId, title: 'demo', cwd, model: 'gpt-5.3-codex-spark', scopes: [], tool: 'codex' });
  assert.ok(!args.includes('resume'));
});

test('buildSpawn: codex resume by caller id, no createdAt — random id with no rollout → no resume, prompt still passed', async () => {
  const { args } = await buildSpawn({ id: '11111111-2222-3333-4444-555555555555', title: 'demo', cwd, model: 'gpt-5.3-codex-spark', scopes: [], tool: 'codex' }, 'do the work');
  assert.ok(!args.includes('resume'));
  assert.ok(args.includes('do the work'));
});

test('buildSpawn: codex with !CODEX_BIN → throws /codex not found/', async () => {
  const saved = process.env.CODEX_BIN;
  process.env.CODEX_BIN = join(scratch, 'no-such-codex-bin');
  try {
    // Bust the ES module cache so the fresh import re-resolves CODEX_BIN from
    // the (now non-existent) env path → resolveBin returns null → buildSpawn
    // throws. buildSpawn is a pure function — the fresh module's own Map/bus
    // are never touched.
    const fresh = await import('./agents.mjs?test=nocodex');
    await assert.rejects(
      () => fresh.buildSpawn({ id: freshId, title: 'demo', cwd, model: 'gpt-5.3-codex-spark', scopes: [], tool: 'codex' }, 'do the work'),
      /codex not found/,
    );
  } finally {
    process.env.CODEX_BIN = saved;
  }
});

test('buildSpawn: codex scopes → -c skills.config=[...] disables non-chosen skills, no --add-dir', async () => {
  const { args } = await buildSpawn({ id: freshId, title: 'demo', cwd, model: 'gpt-5.3-codex-spark', scopes: ['coding'], tool: 'codex' }, 'work');
  const cfgIdx = args.indexOf('-c');
  assert.ok(cfgIdx !== -1, '-c flag present');
  const cfg = args[cfgIdx + 1];
  assert.ok(cfg.startsWith('skills.config=['), 'config value starts with skills.config=[');
  assert.ok(cfg.endsWith(']'), 'config value ends with ]');
  // harness-skill is disabled (its scope 'harness' is not in the chosen ['coding']);
  // coding-skill is NOT disabled (its scope 'coding' is chosen).
  const harnessMd = join(harnessSkillDir, 'SKILL.md').replace(/\\/g, '/');
  const codingMd = join(codingSkillDir, 'SKILL.md').replace(/\\/g, '/');
  assert.ok(cfg.includes(`{path="${harnessMd}",enabled=false}`), 'harness-skill disabled');
  assert.ok(!cfg.includes(codingMd), 'coding-skill not in disable list');
  assert.ok(!args.includes('--add-dir'), 'codex never uses --add-dir');
});

// ---- getLaunchConfigForCodexThread ----
// Inverts findCodexThread's forward relation (cwd+createdAt -> codex thread
// uuid) so the Transcripts view can recover a codex agent's registry-only
// scopes from just the thread uuid + cwd — the registry key (agent id) is a
// randomUUID create() minted, unrelated to the codex-minted thread uuid, so a
// direct agents.get(threadId) could never work. Seeded via init()+fake
// agents.json, same pattern as fork/remove/externalLaunch above (no spawn
// needed — the lookup only reads cwd/createdAt/scopes/tool off the entry).
test('getLaunchConfigForCodexThread: registered codex agent + matching rollout → scopes + tool "codex"', async () => {
  const agentId = '90000000-aaaa-bbbb-cccc-900000000001';
  const threadId = 'dddddddd-eeee-ffff-0000-111111111111';
  const lookupCwd = join(scratch, 'codex-lookup-a');
  const createdAt = Date.now();
  writeCodexRollout(lookupCwd, new Date(createdAt + 1000).toISOString(), threadId);
  const stateFile = join(scratch, 'singularity', 'state', 'agents.json');
  writeFileSync(stateFile, JSON.stringify({
    agents: [{ id: agentId, title: 'codex-agent', cwd: lookupCwd, createdAt, model: 'gpt-5.3-codex-spark', scopes: ['coding', 'harness'], tool: 'codex' }],
    recentRepos: [],
  }));
  init();
  const cfg = await getLaunchConfigForCodexThread(threadId, lookupCwd);
  assert.deepEqual(cfg?.scopes, ['coding', 'harness']);
  assert.equal(cfg?.tool, 'codex');
});

test('getLaunchConfigForCodexThread: same thread, queried with a different cwd → null', async () => {
  const agentId = '90000000-aaaa-bbbb-cccc-900000000002';
  const threadId = 'dddddddd-eeee-ffff-0000-222222222222';
  const lookupCwd = join(scratch, 'codex-lookup-b');
  const createdAt = Date.now();
  writeCodexRollout(lookupCwd, new Date(createdAt + 1000).toISOString(), threadId);
  const stateFile = join(scratch, 'singularity', 'state', 'agents.json');
  writeFileSync(stateFile, JSON.stringify({
    agents: [{ id: agentId, title: 'codex-agent-b', cwd: lookupCwd, createdAt, model: 'gpt-5.3-codex-spark', scopes: ['coding'], tool: 'codex' }],
    recentRepos: [],
  }));
  init();
  assert.equal(await getLaunchConfigForCodexThread(threadId, join(scratch, 'codex-lookup-other')), null);
});

test('getLaunchConfigForCodexThread: unknown thread uuid → null', async () => {
  // Reuses the codex agent seeded by the first test above (cwd 'codex-lookup-a',
  // still in the registry) — proves a real candidate surviving the cwd/tool
  // prefilter still yields null when its actual thread doesn't match.
  assert.equal(await getLaunchConfigForCodexThread('99999999-9999-9999-9999-999999999999', join(scratch, 'codex-lookup-a')), null);
});

test('getLaunchConfigForCodexThread: registered claude agent in the same cwd, queried by its own id → null (codex-agent filter holds)', async () => {
  const claudeId = '90000000-aaaa-bbbb-cccc-900000000003';
  const lookupCwd = join(scratch, 'codex-lookup-c');
  const stateFile = join(scratch, 'singularity', 'state', 'agents.json');
  writeFileSync(stateFile, JSON.stringify({
    agents: [{ id: claudeId, title: 'claude-agent', cwd: lookupCwd, createdAt: Date.now(), model: 'claude', scopes: ['coding'], tool: 'claude' }],
    recentRepos: [],
  }));
  init();
  assert.equal(await getLaunchConfigForCodexThread(claudeId, lookupCwd), null);
});

test('getLaunchConfigForCodexThread: falsy args → null, no throw', async () => {
  assert.equal(await getLaunchConfigForCodexThread(null, scratch), null);
  assert.equal(await getLaunchConfigForCodexThread('some-id', null), null);
  assert.equal(await getLaunchConfigForCodexThread('', ''), null);
});

// ---- codexThreadFor ----
// getLaunchConfigForCodexThread's inverse: resolves a registered codex agent's
// id (a randomUUID create() minted) to the codex-minted thread uuid its
// transcript is actually filed under — same discovery buildSpawn uses to
// resume it (time-based cwd+createdAt match against the rollout).
test('codexThreadFor: registered codex agent + matching rollout → thread uuid', async () => {
  const agentId = '90000000-aaaa-bbbb-cccc-900000000004';
  const threadId = 'dddddddd-eeee-ffff-0000-333333333333';
  const lookupCwd = join(scratch, 'codex-lookup-d');
  const createdAt = Date.now();
  writeCodexRollout(lookupCwd, new Date(createdAt + 1000).toISOString(), threadId);
  const stateFile = join(scratch, 'singularity', 'state', 'agents.json');
  writeFileSync(stateFile, JSON.stringify({
    agents: [{ id: agentId, title: 'codex-agent-d', cwd: lookupCwd, createdAt, model: 'gpt-5.3-codex-spark', scopes: [], tool: 'codex' }],
    recentRepos: [],
  }));
  init();
  assert.equal(await codexThreadFor(agentId), threadId);
});

// ---- writeAtomic (server/background.test.mjs:214 flake regression) ------------
// Windows rename-over-existing-file can transiently EPERM/EACCES/EBUSY (AV/
// Search/a brief reader). Inject a fake `rename` that throws those codes N
// times, then delegates to the real renameSync — writeAtomic must retry past
// them and still land the file, but must not retry (or swallow) an unrelated
// error code.
test('writeAtomic: retries past transient EPERM, then succeeds', async () => {
  const file = join(scratch, 'retry-ok.json');
  let calls = 0;
  const fakeRename = (...args) => {
    calls++;
    if (calls < 3) { const e = new Error('busy'); e.code = 'EPERM'; throw e; }
    return renameSync(...args);
  };
  writeAtomic(file, 'hello', fakeRename);
  assert.equal(calls, 3);
  assert.equal(readFileSync(file, 'utf8'), 'hello');
});
test('writeAtomic: non-retryable error rethrows immediately, no retry', async () => {
  const file = join(scratch, 'retry-fatal.json');
  let calls = 0;
  const fakeRename = () => { calls++; const e = new Error('gone'); e.code = 'ENOENT'; throw e; };
  assert.throws(() => writeAtomic(file, 'x', fakeRename), /gone/);
  assert.equal(calls, 1);
});

// ---- sweepTmpFiles (startup debris sweep) -------------------------------------
// A hard kill between writeFileSync and rename leaves `<file>.<pid>.tmp` behind,
// and a pid-scoped name is never reused. The boot sweep must remove only stale
// matching regular files at the top level — never a write in flight, a
// non-matching name, or a subdirectory's contents.
// VERIFY: wave30-sweep-node-1
test('sweepTmpFiles: removes only stale top-level `<name>.<pid>.tmp` files', async () => {
  const dir = join(scratch, 'sweep');
  const nested = join(dir, 'nested');
  mkdirSync(nested, { recursive: true });
  const now = Date.now();
  const old = new Date(now - 120_000);
  const make = (path, mtime) => { writeFileSync(path, 'x'); utimesSync(path, mtime, mtime); return path; };
  const stale = make(join(dir, 'state.json.123.tmp'), old);
  const fresh = make(join(dir, 'agents.json.456.tmp'), new Date(now));
  const kept = [join(dir, 'x.tmp'), join(dir, 'x.abc.tmp'), join(dir, 'state.json')].map((p) => make(p, old));
  const nestedTmp = make(join(nested, 'nested.json.9.tmp'), old);
  const warnings = [];
  const removed = sweepTmpFiles({ dirs: [dir], now, log: { warn: (o, m) => warnings.push(m), info: () => {} } });
  assert.equal(removed, 1);
  assert.equal(existsSync(stale), false);
  assert.equal(existsSync(fresh), true);
  for (const p of kept) assert.equal(existsSync(p), true);
  assert.equal(existsSync(nestedTmp), true);
  assert.deepEqual(warnings, []);
});

// resolveWt: Store App-Execution-Alias path takes priority, PATH is the
// fallback for winget/choco/scoop/portable installs, and a missing
// LOCALAPPDATA must not probe a relative path.
test('resolveWt: Store alias path present → returned, PATH not consulted', async () => {
  const localAppData = mkdtempSync(join(tmpdir(), 'sing-wt-alias-'));
  const aliasDir = join(localAppData, 'Microsoft', 'WindowsApps');
  mkdirSync(aliasDir, { recursive: true });
  const alias = join(aliasDir, 'wt.exe');
  writeFileSync(alias, '');
  chmodSync(alias, 0o755);
  const wt = resolveWt({ LOCALAPPDATA: localAppData, PATH: 'Z:\\nonexistent' });
  assert.equal(wt, alias);
});
test('resolveWt: no alias, wt.exe on PATH (winget/scoop-style install) → PATH hit returned', async () => {
  const pathDir = mkdtempSync(join(tmpdir(), 'sing-wt-path-'));
  writeFileSync(join(pathDir, 'wt.exe'), '');
  chmodSync(join(pathDir, 'wt.exe'), 0o755);
  const wt = resolveWt({ LOCALAPPDATA: join(tmpdir(), 'sing-wt-no-such-dir'), PATH: `Z:\\nonexistent;${pathDir}` });
  assert.equal(wt, join(pathDir, 'wt.exe'));
});
test('resolveWt: neither alias nor PATH has it → null', async () => {
  const wt = resolveWt({ LOCALAPPDATA: join(tmpdir(), 'sing-wt-no-such-dir'), PATH: 'Z:\\nonexistent' });
  assert.equal(wt, null);
});
test('resolveWt: missing LOCALAPPDATA → skips the alias probe (no relative-path lookup), still checks PATH', async () => {
  const pathDir = mkdtempSync(join(tmpdir(), 'sing-wt-path2-'));
  writeFileSync(join(pathDir, 'wt.exe'), '');
  chmodSync(join(pathDir, 'wt.exe'), 0o755);
  const wt = resolveWt({ PATH: pathDir });
  assert.equal(wt, join(pathDir, 'wt.exe'));
});
