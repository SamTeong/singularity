// Unit tests for the spawn/encoding logic: encodeCwd + buildSpawn, plus fork().
// fork() ends with a real create() call, which spawns a real pty (node-pty) —
// undesirable in a unit test (launches a real, live child process). CLAUDE_BIN
// is pointed at a file that exists but isn't a valid executable, so node-pty's
// spawn() fails fast with a synchronous throw instead of launching anything
// (confirmed: even a spawn that exits immediately leaves a ConPTY handle that
// doesn't release on kill() and hangs `node --test`). That lets the test
// verify fork()'s transcript copy/rewrite (which runs before create() is
// called) but not the returned-agent fields, since fork() throws before
// returning. SINGULARITY_HOME is pointed at a scratch temp dir first (create()/
// fork() persist() to APP_DIR/state/agents.json — else it'd clobber the user's
// real agents.json), mirroring crons.test.mjs's convention: env tweaks before a
// dynamic import of the module graph.
// Run: npm test  (node --test server/)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';

const scratch = mkdtempSync(join(tmpdir(), 'singularity-agents-test-'));
process.env.SINGULARITY_HOME = join(scratch, 'singularity');
process.env.CLAUDE_BIN = join(scratch, 'not-an-exe'); // exists, not a valid executable → spawn throws synchronously
writeFileSync(process.env.CLAUDE_BIN, 'not a real executable');
// OLLAMA_BIN points at the real system shell: a harmless, long-lived process
// that ignores claude's argv and stays alive until killed. buildSpawn's
// ollama-wrap branch (model outside CLAUDE_ALIASES) routes spawn() through
// this bin, so the respawnAll test below gets a genuine live pty without
// needing a real `claude` binary — CLAUDE_BIN stays invalid (spawn throws
// synchronously) for every other test, which spawns via the claude-model path.
process.env.OLLAMA_BIN = 'C:\\Windows\\System32\\cmd.exe';
after(() => {
  rmSync(scratch, { recursive: true, force: true });
  // node-pty's spawn() (even the failed attempt inside the fork test below)
  // leaves a ConPTY handle that never releases on its own — force this file's
  // isolated test-runner process (node:test's default --test-isolation=process
  // spawns one node process per file) to exit rather than hang. Deferred a
  // tick so node:test's own result reporting flushes first.
  setImmediate(() => process.exit(0));
});

const { encodeCwd, buildSpawn, init, fork, create, remove, snapshot, respawnAll, kill, bus, ensureTrusted, beginDrain } = await import('./agents.mjs');

test('encodeCwd replaces every non-alphanumeric (incl. dots) with "-"', () => {
  assert.equal(encodeCwd('C:\\git\\singularity'), 'C--git-singularity');
  assert.equal(encodeCwd('C:\\Users\\x\\.claude'), 'C--Users-x--claude');
  assert.equal(encodeCwd('/home/u/proj'), '-home-u-proj');
});

// A random id has no session log on disk → fresh --session-id branch.
const freshId = '00000000-1111-2222-3333-444444444444';
const cwd = 'C:\\definitely\\not\\a\\real\\repo\\path\\xyz';

test('buildSpawn: fresh claude session uses --session-id, --name, no --model', () => {
  const { bin, args } = buildSpawn({ id: freshId, name: 'demo', cwd, model: 'claude', scopes: [] });
  assert.equal(typeof bin, 'string');
  assert.ok(args.includes('--session-id'));
  assert.equal(args[args.indexOf('--session-id') + 1], freshId);
  assert.ok(args.includes('--name'));
  assert.equal(args[args.indexOf('--name') + 1], 'demo');
  assert.ok(!args.includes('--resume'));
  assert.ok(!args.includes('--model'));
});

test('buildSpawn: non-existent skill-scope is not added as --add-dir', () => {
  const { args } = buildSpawn({ id: freshId, name: 'demo', cwd, model: 'claude', scopes: ['__no_such_scope__'] });
  assert.ok(!args.includes('--add-dir'));
});

test('buildSpawn: claude alias (opus) runs via claude bin with --model', () => {
  const { args } = buildSpawn({ id: freshId, name: 'demo', cwd, model: 'opus', scopes: [] });
  assert.ok(!args.includes('launch'));
  assert.ok(args.includes('--model'));
  assert.equal(args[args.indexOf('--model') + 1], 'opus');
  assert.ok(args.includes('--session-id'));
});

test('buildSpawn: typed full claude id runs via claude bin with --model', () => {
  const { args } = buildSpawn({ id: freshId, name: 'demo', cwd, model: 'claude-opus-4-8', scopes: [] });
  assert.ok(!args.includes('launch'));
  assert.equal(args[args.indexOf('--model') + 1], 'claude-opus-4-8');
});

test('buildSpawn: existing session log switches to --resume', () => {
  const dir = join(homedir(), '.claude', 'projects', encodeCwd(cwd));
  const log = join(dir, `${freshId}.jsonl`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(log, '{}\n');
  try {
    const { args } = buildSpawn({ id: freshId, name: 'demo', cwd, model: 'claude', scopes: [] });
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
test('fork: copies+rewrites transcript, then throws on create()\'s spawn (see file header)', () => {
  const srcId = '10000000-aaaa-bbbb-cccc-100000000001';
  const forkCwd = scratch;
  const dir = join(homedir(), '.claude', 'projects', encodeCwd(forkCwd));
  mkdirSync(dir, { recursive: true });
  const srcLog = join(dir, `${srcId}.jsonl`);
  writeFileSync(srcLog, `{"sessionId":"${srcId}","type":"user"}\n`);
  const stateFile = join(scratch, 'singularity', 'state', 'agents.json');
  writeFileSync(stateFile, JSON.stringify({
    agents: [{ id: srcId, name: 'srcname', cwd: forkCwd, createdAt: Date.now(), model: 'claude', scopes: ['x'] }],
    recentRepos: [],
  }));
  try {
    init(); // loads srcId into the registry as 'detached', proc: null — no spawn
    assert.throws(() => fork(srcId, 'copyname'), /Cannot create process/);

    // the transcript copy/rewrite ran before create()'s spawn threw.
    const newFile = readdirSync(dir).find((f) => f !== `${srcId}.jsonl`);
    assert.ok(newFile, 'a new session log was written');
    const newId = newFile.replace('.jsonl', '');
    const content = readFileSync(join(dir, newFile), 'utf8');
    assert.ok(content.includes(`"sessionId":"${newId}"`));
    assert.ok(!content.includes(srcId));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// create() refuses a live id ('session id already in use') but resumes a dead
// one — a claude proc that exited (e.g. usage-limit hit) leaves an 'exited'
// entry with proc:null in the registry; re-entering its id must resume the
// conversation, not error. Seeded via init()+fake agents.json (no spawn).
test('create: dead (exited) dup id resumes via reattach instead of "already in use"', () => {
  const deadId = '20000000-bbbb-cccc-dddd-200000000002';
  const deadCwd = scratch;
  const stateFile = join(scratch, 'singularity', 'state', 'agents.json');
  writeFileSync(stateFile, JSON.stringify({
    agents: [{ id: deadId, name: 'deadname', cwd: deadCwd, createdAt: Date.now(), model: 'claude', scopes: [] }],
    recentRepos: [],
  }));
  init(); // loads deadId as 'detached', proc: null
  // reattach → buildSpawn → spawn(CLAUDE_BIN=not-an-exe) throws synchronously,
  // proving we took the resume path, NOT the 'already in use' refusal.
  assert.throws(() => create({ sessionId: deadId, cwd: deadCwd, model: 'claude' }), /Cannot create process/);
});

// remove() on a dead/detached entry drops it from the registry immediately
// (the task-done path: a completed session leaves the session list rather than
// lingering as 'exited'). Seeded via init()+fake agents.json (no spawn); the
// live-pty branch of remove() can't be exercised here for the same reason
// kill()'s can't (no real pty in a unit test).
test('remove: dead (detached) agent is dropped from the registry', () => {
  const goneId = '30000000-cccc-dddd-eeee-300000000003';
  const stateFile = join(scratch, 'singularity', 'state', 'agents.json');
  writeFileSync(stateFile, JSON.stringify({
    agents: [{ id: goneId, name: 'gonename', cwd: scratch, createdAt: Date.now(), model: 'claude', scopes: [] }],
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
test('respawnAll: kills a live agent and resumes it with the same id + new pid', async () => {
  const respawnCwd = scratch;
  const id = '40000000-dddd-eeee-ffff-400000000004';
  const a = create({ cwd: respawnCwd, name: 'resp-test', model: 'glm-5.2:cloud', sessionId: id });
  const firstPid = a.pid;
  assert.ok(firstPid, 'agent spawned with a real pid');

  // Drop a session log after the fact so the post-kill respawn resolves to
  // --resume (buildSpawn/sessionLogExists) instead of a fresh --session-id.
  const dir = join(homedir(), '.claude', 'projects', encodeCwd(respawnCwd));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.jsonl`), `{"sessionId":"${id}","type":"user"}\n`);

  try {
    respawnAll();

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

// beginDrain(): daemon shutdown snapshots every live session to agents.json as
// detached, and the ensuing pty-exit (onExit) no-ops instead of deleting — so a
// restart reloads the sessions rather than dropping them from the list. Kept
// last: draining is a module-global one-way flag, so it must not affect the
// tests above. Uses the ollama/cmd.exe live-pty trick (see file header).
test('beginDrain: live session persists to agents.json and survives its pty exit', async () => {
  const id = '50000000-aaaa-bbbb-cccc-500000000005';
  const a = create({ cwd: scratch, name: 'drain-test', model: 'glm-5.2:cloud', sessionId: id });
  assert.ok(a.pid, 'agent spawned live');
  const readAgents = () => JSON.parse(readFileSync(join(process.env.SINGULARITY_HOME, 'state', 'agents.json'), 'utf8')).agents;

  beginDrain(); // snapshots the live fleet to disk as detached
  const onDisk = readAgents().find((x) => x.id === id);
  assert.ok(onDisk, 'live session written to agents.json at drain');
  assert.equal(onDisk.status, 'detached', 'stored as detached (resumable)');

  kill(id); // pty dies → onExit must NOT delete the entry while draining
  await new Promise((r) => setTimeout(r, 500)); // let onExit fire
  assert.ok(snapshot().find((x) => x.id === id), 'entry retained in registry after pty exit (drain guard)');
  assert.ok(readAgents().find((x) => x.id === id), 'entry retained in agents.json after pty exit');
});

test('ensureTrusted: upserts hasTrustDialogAccepted:true keyed on cwd with \\→/', () => {
  const file = join(scratch, 'trust-upsert.json');
  writeFileSync(file, JSON.stringify({ projects: {} }));
  ensureTrusted('C:\\Users\\user', file);
  const json = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(json.projects['C:/Users/user'].hasTrustDialogAccepted, true);
});

test('ensureTrusted: flips an existing false entry to true, preserves other keys', () => {
  const file = join(scratch, 'trust-flip.json');
  writeFileSync(file, JSON.stringify({
    projects: { 'C:/Users/user': { hasTrustDialogAccepted: false, other: 1 } },
  }));
  ensureTrusted('C:\\Users\\user', file);
  const json = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(json.projects['C:/Users/user'].hasTrustDialogAccepted, true);
  assert.equal(json.projects['C:/Users/user'].other, 1); // sibling fields untouched
});

test('ensureTrusted: no-op (no write) when already trusted', () => {
  const file = join(scratch, 'trust-noop.json');
  writeFileSync(file, JSON.stringify({ projects: { 'C:/x': { hasTrustDialogAccepted: true } } }));
  const before = readFileSync(file, 'utf8');
  ensureTrusted('C:\\x', file);
  assert.equal(readFileSync(file, 'utf8'), before); // short-circuit → byte-identical
});

test('ensureTrusted: creates projects map when missing, never throws on bad/missing file', () => {
  const file = join(scratch, 'trust-empty.json');
  writeFileSync(file, JSON.stringify({}));
  ensureTrusted('C:\\y', file);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).projects['C:/y'].hasTrustDialogAccepted, true);
  // missing file + unparseable file both swallow silently
  assert.doesNotThrow(() => ensureTrusted('C:\\z', join(scratch, 'does-not-exist.json')));
});

test('buildSpawn: ollama model on resume injects --model to override stripped transcript model', () => {
  const dir = join(homedir(), '.claude', 'projects', encodeCwd(cwd));
  const log = join(dir, `${freshId}.jsonl`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(log, '{}\n');
  try {
    const { args } = buildSpawn({ id: freshId, name: 'demo', cwd, model: 'glm-5.2:cloud', scopes: [] });
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
