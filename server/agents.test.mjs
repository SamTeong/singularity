// Unit tests for the spawn/encoding logic: encodeCwd + buildSpawn, plus fork().
// fork() ends with a real create() call, which spawns a real pty (node-pty) —
// undesirable in a unit test (launches a real, live child process). CLAUDE_BIN
// is pointed at a file that exists but isn't a valid executable, so node-pty's
// spawn() fails fast with a synchronous throw instead of launching anything
// (confirmed: even a spawn that exits immediately leaves a ConPTY handle that
// doesn't release on kill() and hangs `node --test`). That lets the test
// verify fork()'s transcript copy/rewrite (which runs before create() is
// called) but not the returned-agent fields, since fork() throws before
// returning. APPDATA is pointed at a scratch temp dir first (create()/fork()
// persist() to APP_DIR/agents.json — else it'd clobber the user's real
// agents.json), mirroring crons.test.mjs's convention: env tweaks before a
// dynamic import of the module graph.
// Run: npm test  (node --test server/)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';

const scratch = mkdtempSync(join(tmpdir(), 'singularity-agents-test-'));
process.env.APPDATA = scratch;
process.env.CLAUDE_BIN = join(scratch, 'not-an-exe'); // exists, not a valid executable → spawn throws synchronously
writeFileSync(process.env.CLAUDE_BIN, 'not a real executable');
after(() => {
  rmSync(scratch, { recursive: true, force: true });
  // node-pty's spawn() (even the failed attempt inside the fork test below)
  // leaves a ConPTY handle that never releases on its own — force this file's
  // isolated test-runner process (node:test's default --test-isolation=process
  // spawns one node process per file) to exit rather than hang. Deferred a
  // tick so node:test's own result reporting flushes first.
  setImmediate(() => process.exit(0));
});

const { encodeCwd, buildSpawn, init, fork, create } = await import('./agents.mjs');

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
  const stateFile = join(scratch, 'singularity', 'agents.json');
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
  const stateFile = join(scratch, 'singularity', 'agents.json');
  writeFileSync(stateFile, JSON.stringify({
    agents: [{ id: deadId, name: 'deadname', cwd: deadCwd, createdAt: Date.now(), model: 'claude', scopes: [] }],
    recentRepos: [],
  }));
  init(); // loads deadId as 'detached', proc: null
  // reattach → buildSpawn → spawn(CLAUDE_BIN=not-an-exe) throws synchronously,
  // proving we took the resume path, NOT the 'already in use' refusal.
  assert.throws(() => create({ sessionId: deadId, cwd: deadCwd, model: 'claude' }), /Cannot create process/);
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
