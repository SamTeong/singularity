// Unit tests for the spawn/encoding logic: encodeCwd + buildSpawn, plus fork()/
// create()/respawnAll()/beginDrain(), which spawn a real pty (node-pty). A
// cross-platform "keepalive" bin stands in for the claude/ollama binary: an
// interactive process that ignores its argv and stays alive until killed —
// cmd.exe on Windows (an interactive REPL that survives bad commands), a
// sleep-forever shell script on POSIX. Both CLAUDE_BIN and OLLAMA_BIN point at
// it, so every spawn path yields a genuine, cleanly-killable live pty on both
// platforms; spawn-path tests start one and kill+wait before finishing.
// (An invalid bin can't be used as a "spawn throws synchronously" trick here:
// node-pty on POSIX forkpty()s and the child execvp-fails ASYNCHRONOUSLY — it
// never throws synchronously, unlike Windows ConPTY.) SINGULARITY_HOME is
// pointed at a scratch temp dir first (create()/fork() persist() to
// APP_DIR/state/agents.json — else it'd clobber the user's real agents.json),
// mirroring crons.test.mjs's convention: env tweaks before a dynamic import of
// the module graph.
// Run: npm test  (node --test server/)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, chmodSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';

const scratch = mkdtempSync(join(tmpdir(), 'singularity-agents-test-'));
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
writeFileSync(join(manifestDir, 'skill-manifest.json'), JSON.stringify([
  { skillName: 'coding-skill', refs: [{ path: codingSkillDir, version: '1.0.0' }], scopes: ['coding'] },
  { skillName: 'harness-skill', refs: [{ path: harnessSkillDir, version: '1.0.0' }], scopes: ['harness'] },
]));
process.env.SING_SCOPE_ROOT = scopeRoot;
// codex-thread.mjs's CODEX_HOME (via usage.mjs) is a load-time const too —
// point it at a scratch dir before the dynamic import below, same reason
// SINGULARITY_HOME is set up front.
const codexHome = join(scratch, 'codex-home');
process.env.CODEX_HOME = codexHome;
after(() => {
  rmSync(scopeParent, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
  // node-pty's spawn() (even the failed attempt inside the fork test below)
  // leaves a ConPTY handle that never releases on its own — force this file's
  // isolated test-runner process (node:test's default --test-isolation=process
  // spawns one node process per file) to exit rather than hang. Deferred a
  // tick so node:test's own result reporting flushes first.
  setImmediate(() => process.exit(0));
});

const { encodeCwd, buildSpawn, init, fork, create, remove, snapshot, respawnAll, kill, bus, ensureTrusted, beginDrain, externalLaunch, writeAtomic, spawnEnv, CACHE_DIR, getLaunchConfigForCodexThread, codexThreadFor } = await import('./agents.mjs');

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

test('encodeCwd replaces every non-alphanumeric (incl. dots) with "-"', () => {
  assert.equal(encodeCwd('C:\\git\\singularity'), 'C--git-singularity');
  assert.equal(encodeCwd('C:\\Users\\x\\.claude'), 'C--Users-x--claude');
  assert.equal(encodeCwd('/home/u/proj'), '-home-u-proj');
});

// A random id has no session log on disk → fresh --session-id branch.
const freshId = '00000000-1111-2222-3333-444444444444';
const cwd = 'C:\\definitely\\not\\a\\real\\repo\\path\\xyz';

test('buildSpawn: fresh claude session uses --session-id, --name, no --model', () => {
  const { bin, args } = buildSpawn({ id: freshId, title: 'demo', cwd, model: 'claude', scopes: [] });
  assert.equal(typeof bin, 'string');
  assert.ok(args.includes('--session-id'));
  assert.equal(args[args.indexOf('--session-id') + 1], freshId);
  assert.ok(args.includes('--name'));
  assert.equal(args[args.indexOf('--name') + 1], 'demo');
  assert.ok(!args.includes('--resume'));
  assert.ok(!args.includes('--model'));
});

test('buildSpawn: non-existent skill-scope is not added as --add-dir', () => {
  const { args } = buildSpawn({ id: freshId, title: 'demo', cwd, model: 'claude', scopes: ['__no_such_scope__'] });
  assert.ok(!args.includes('--add-dir'));
});

test('buildSpawn: claude alias (opus) runs via claude bin with --model', () => {
  const { args } = buildSpawn({ id: freshId, title: 'demo', cwd, model: 'opus', scopes: [] });
  assert.ok(!args.includes('launch'));
  assert.ok(args.includes('--model'));
  assert.equal(args[args.indexOf('--model') + 1], 'opus');
  assert.ok(args.includes('--session-id'));
});

test('buildSpawn: typed full claude id runs via claude bin with --model', () => {
  const { args } = buildSpawn({ id: freshId, title: 'demo', cwd, model: 'claude-opus-4-8', scopes: [] });
  assert.ok(!args.includes('launch'));
  assert.equal(args[args.indexOf('--model') + 1], 'claude-opus-4-8');
});

// mock demo sessions (tasks.mjs's mock:true) must not write cost-state into the
// user's real ~/.agents/.harness-usage-report store — spawnEnv redirects
// USAGE_REPORT_STATE into the disposable CACHE_DIR for mock spawns only.
test('spawnEnv: mock spawn gets USAGE_REPORT_STATE under CACHE_DIR; normal spawn is untouched', () => {
  const mockEnv = spawnEnv(true);
  assert.equal(mockEnv.USAGE_REPORT_STATE, join(CACHE_DIR, 'mock-usage-state'));
  assert.equal(spawnEnv(false), process.env);
});

test('buildSpawn: existing session log switches to --resume', () => {
  const dir = join(homedir(), '.claude', 'projects', encodeCwd(cwd));
  const log = join(dir, `${freshId}.jsonl`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(log, '{}\n');
  try {
    const { args } = buildSpawn({ id: freshId, title: 'demo', cwd, model: 'claude', scopes: [] });
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
    const forked = fork(srcId, 'copyname'); // copies+rewrites the transcript, then spawns a real pty over it
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
  const a = create({ sessionId: deadId, cwd: deadCwd, model: 'claude' });
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
test('create: rejects tool "codex" paired with a claude model alias', () => {
  const id = '25000000-bbbb-cccc-dddd-250000000002';
  assert.throws(
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
test('remove: dead (detached) agent is dropped from the registry', () => {
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
test('respawnAll: kills a live agent and resumes it with the same id + new pid', async () => {
  const respawnCwd = scratch;
  const id = '40000000-dddd-eeee-ffff-400000000004';
  const a = create({ cwd: respawnCwd, title: 'resp-test', model: 'glm-5.2:cloud', sessionId: id });
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
  const a = create({ cwd: scratch, title: 'drain-test', model: 'glm-5.2:cloud', sessionId: id });
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

// externalLaunch: pure builder for the "open in external terminal" route. Seeded
// via init()+fake agents.json (no spawn) like the fork/remove tests. Random id
// has no session log → buildSpawn yields --session-id. Platform param exercises
// both branches on any host.
test('externalLaunch: win32 wraps wt.exe with -d <cwd> + resume argv', () => {
  const id = '60000000-eeee-ffff-0000-600000000006';
  const stateFile = join(scratch, 'singularity', 'state', 'agents.json');
  writeFileSync(stateFile, JSON.stringify({
    agents: [{ id, title: 'extwin', cwd: scratch, createdAt: Date.now(), model: 'claude', scopes: [] }],
    recentRepos: [],
  }));
  init();
  const r = externalLaunch(id, 'win32');
  assert.equal(r.ok, true);
  assert.equal(r.launcher, 'wt.exe');
  assert.equal(r.launcherArgs[0], '-d');
  assert.equal(r.launcherArgs[1], scratch);
  assert.ok(r.launcherArgs.includes('--session-id'), 'resume argv present');
  assert.equal(r.launcherArgs[r.launcherArgs.indexOf('--session-id') + 1], id);
  assert.equal(r.cwd, scratch);
});

test('externalLaunch: darwin wraps osascript do-script with cd + exec', () => {
  const id = '70000000-eeee-ffff-0000-700000000007';
  const stateFile = join(scratch, 'singularity', 'state', 'agents.json');
  writeFileSync(stateFile, JSON.stringify({
    agents: [{ id, title: 'extmac', cwd: scratch, createdAt: Date.now(), model: 'claude', scopes: [] }],
    recentRepos: [],
  }));
  init();
  const r = externalLaunch(id, 'darwin');
  assert.equal(r.ok, true);
  assert.equal(r.launcher, 'osascript');
  const script = r.launcherArgs[r.launcherArgs.indexOf('-e') + 1];
  assert.match(script, /tell application "Terminal" to do script/);
  assert.match(script, new RegExp(`cd '.*'`));
  assert.match(script, /exec '/);
  assert.ok(script.includes(id), 'session id embedded in the shell string');
});

test('externalLaunch: unknown id + unsupported platform error cleanly', () => {
  assert.equal(externalLaunch('no-such-id').ok, false);
  // unsupported platform with a real agent still errors (use a seeded one)
  const id = '80000000-eeee-ffff-0000-800000000008';
  const stateFile = join(scratch, 'singularity', 'state', 'agents.json');
  writeFileSync(stateFile, JSON.stringify({
    agents: [{ id, title: 'extlinux', cwd: scratch, createdAt: Date.now(), model: 'claude', scopes: [] }],
    recentRepos: [],
  }));
  init();
  const r = externalLaunch(id, 'linux');
  assert.equal(r.ok, false);
  assert.match(r.error, /Windows\/macOS only/);
});

test('buildSpawn: ollama model on resume injects --model to override stripped transcript model', () => {
  const dir = join(homedir(), '.claude', 'projects', encodeCwd(cwd));
  const log = join(dir, `${freshId}.jsonl`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(log, '{}\n');
  try {
    const { args } = buildSpawn({ id: freshId, title: 'demo', cwd, model: 'glm-5.2:cloud', scopes: [] });
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
test('buildSpawn: codex fresh spawn uses -C, -s workspace-write, -a on-request, -m, prompt; no --resume/--session-id/launch', () => {
  const { bin, args } = buildSpawn({ id: freshId, title: 'demo', cwd, model: 'gpt-5.3-codex-spark', scopes: [], tool: 'codex' }, 'do the work');
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

test('buildSpawn: codex with permissionMode set → -a never', () => {
  const { args } = buildSpawn({ id: freshId, title: 'demo', cwd, model: 'gpt-5.3-codex-spark', scopes: [], tool: 'codex', permissionMode: 'acceptEdits' }, 'do the work');
  assert.equal(args[args.indexOf('-a') + 1], 'never');
});

test('buildSpawn: codex with no model → no -m flag', () => {
  const { args } = buildSpawn({ id: freshId, title: 'demo', cwd, model: '', scopes: [], tool: 'codex' }, 'work');
  assert.ok(!args.includes('-m'));
});

test('buildSpawn: gpt-* model with tool="claude" routes to codex bin (model-driven)', () => {
  const { bin, args } = buildSpawn({ id: freshId, title: 'demo', cwd, model: 'gpt-5.6-luna', scopes: [], tool: 'claude' }, 'do the work');
  assert.equal(bin, process.env.CODEX_BIN);
  assert.equal(args[args.indexOf('-m') + 1], 'gpt-5.6-luna');
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

test('buildSpawn: codex resume — matching rollout found → argv starts with resume <uuid>, keeps -C/-s/-m', () => {
  const createdAt = Date.now();
  const threadId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  writeCodexRollout(cwd, new Date(createdAt + 1000).toISOString(), threadId);
  const { args } = buildSpawn({ id: freshId, title: 'demo', cwd, model: 'gpt-5.3-codex-spark', scopes: [], tool: 'codex', createdAt });
  assert.deepEqual(args.slice(0, 2), ['resume', threadId]);
  assert.equal(args[args.indexOf('-C') + 1], cwd);
  assert.equal(args[args.indexOf('-s') + 1], 'workspace-write');
  assert.equal(args[args.indexOf('-m') + 1], 'gpt-5.3-codex-spark');
});

test('buildSpawn: codex resume suppresses the initial prompt (would re-submit as a new turn)', () => {
  const createdAt = Date.now();
  const threadId = 'aaaaaaaa-bbbb-cccc-dddd-ffffffffffff';
  writeCodexRollout(cwd, new Date(createdAt + 1000).toISOString(), threadId);
  const { args } = buildSpawn({ id: freshId, title: 'demo', cwd, model: 'gpt-5.3-codex-spark', scopes: [], tool: 'codex', createdAt }, 'do the work');
  assert.ok(args.includes('resume'));
  assert.ok(!args.includes('do the work'), 'prompt not resent on resume');
});

test('buildSpawn: codex — no matching rollout (different cwd, or no createdAt) → today\'s fresh-spawn argv, unchanged', () => {
  const createdAt = Date.now();
  // A fixture exists, but for a cwd that's neither this call's cwd nor any
  // other test's — the rollout is on disk yet must not match.
  const rolloutCwd = 'C:\\some\\other\\cwd\\not-matching';
  const callCwd = 'C:\\yet\\another\\cwd\\never-fixtured';
  writeCodexRollout(rolloutCwd, new Date(createdAt + 1000).toISOString(), 'zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz');

  const { args: mismatchedCwd } = buildSpawn({ id: freshId, title: 'demo', cwd: callCwd, model: 'gpt-5.3-codex-spark', scopes: [], tool: 'codex', createdAt }, 'work');
  assert.ok(!mismatchedCwd.includes('resume'));
  assert.ok(mismatchedCwd.includes('work'));

  const { args: noCreatedAt } = buildSpawn({ id: freshId, title: 'demo', cwd, model: 'gpt-5.3-codex-spark', scopes: [], tool: 'codex' }, 'work');
  assert.ok(!noCreatedAt.includes('resume'));
  assert.ok(noCreatedAt.includes('work'));
});

// ---- buildSpawn: codex resume by caller-supplied id (no createdAt) ----
// create({ sessionId: <codex thread uuid>, tool:'codex' }) from the
// Transcripts view (or a uuid typed into the New-session dialog) passes no
// createdAt — findCodexThread has nothing to discover by, so buildSpawn must
// fall back to confirming `id` is itself a known codex thread for this cwd.
test('buildSpawn: codex resume by caller id, no createdAt — matching rollout for this cwd → argv starts with resume <uuid>', () => {
  const threadId = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
  writeCodexRollout(cwd, new Date().toISOString(), threadId);
  const { args } = buildSpawn({ id: threadId, title: 'demo', cwd, model: 'gpt-5.3-codex-spark', scopes: [], tool: 'codex' });
  assert.deepEqual(args.slice(0, 2), ['resume', threadId]);
});

test('buildSpawn: codex resume by caller id, no createdAt — rollout is for a different cwd → no resume', () => {
  const threadId = 'cccccccc-dddd-eeee-ffff-000000000000';
  const otherCwd = 'C:\\some\\unrelated\\cwd\\for-this-thread';
  writeCodexRollout(otherCwd, new Date().toISOString(), threadId);
  const { args } = buildSpawn({ id: threadId, title: 'demo', cwd, model: 'gpt-5.3-codex-spark', scopes: [], tool: 'codex' });
  assert.ok(!args.includes('resume'));
});

test('buildSpawn: codex resume by caller id, no createdAt — random id with no rollout → no resume, prompt still passed', () => {
  const { args } = buildSpawn({ id: '11111111-2222-3333-4444-555555555555', title: 'demo', cwd, model: 'gpt-5.3-codex-spark', scopes: [], tool: 'codex' }, 'do the work');
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
    assert.throws(
      () => fresh.buildSpawn({ id: freshId, title: 'demo', cwd, model: 'gpt-5.3-codex-spark', scopes: [], tool: 'codex' }, 'do the work'),
      /codex not found/,
    );
  } finally {
    process.env.CODEX_BIN = saved;
  }
});

test('buildSpawn: codex scopes → -c skills.config=[...] disables non-chosen skills, no --add-dir', () => {
  const { args } = buildSpawn({ id: freshId, title: 'demo', cwd, model: 'gpt-5.3-codex-spark', scopes: ['coding'], tool: 'codex' }, 'work');
  const cfgIdx = args.indexOf('-c');
  assert.ok(cfgIdx !== -1, '-c flag present');
  const cfg = args[cfgIdx + 1];
  assert.ok(cfg.startsWith('skills.config=['), 'config value starts with skills.config=[');
  assert.ok(cfg.endsWith(']'), 'config value ends with ]');
  // harness-skill is disabled (its scope 'harness' is not in the chosen ['coding']);
  // coding-skill is NOT disabled (its scope 'coding' is chosen).
  const harnessMd = join(harnessSkillDir, 'SKILL.md').replace(/\\/g, '/');
  const codingMd = join(codingSkillDir, 'SKILL.md').replace(/\\/g, '/');
  // Single-quoted TOML literal strings: a double-quoted path is destroyed by the
  // cmd.exe pass in externalLaunch's spawn({shell:true}) — see codexScopeConfig.
  assert.ok(cfg.includes(`{path='${harnessMd}',enabled=false}`), 'harness-skill disabled');
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
test('getLaunchConfigForCodexThread: registered codex agent + matching rollout → scopes + tool "codex"', () => {
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
  const cfg = getLaunchConfigForCodexThread(threadId, lookupCwd);
  assert.deepEqual(cfg?.scopes, ['coding', 'harness']);
  assert.equal(cfg?.tool, 'codex');
});

test('getLaunchConfigForCodexThread: same thread, queried with a different cwd → null', () => {
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
  assert.equal(getLaunchConfigForCodexThread(threadId, join(scratch, 'codex-lookup-other')), null);
});

test('getLaunchConfigForCodexThread: unknown thread uuid → null', () => {
  // Reuses the codex agent seeded by the first test above (cwd 'codex-lookup-a',
  // still in the registry) — proves a real candidate surviving the cwd/tool
  // prefilter still yields null when its actual thread doesn't match.
  assert.equal(getLaunchConfigForCodexThread('99999999-9999-9999-9999-999999999999', join(scratch, 'codex-lookup-a')), null);
});

test('getLaunchConfigForCodexThread: registered claude agent in the same cwd, queried by its own id → null (codex-agent filter holds)', () => {
  const claudeId = '90000000-aaaa-bbbb-cccc-900000000003';
  const lookupCwd = join(scratch, 'codex-lookup-c');
  const stateFile = join(scratch, 'singularity', 'state', 'agents.json');
  writeFileSync(stateFile, JSON.stringify({
    agents: [{ id: claudeId, title: 'claude-agent', cwd: lookupCwd, createdAt: Date.now(), model: 'claude', scopes: ['coding'], tool: 'claude' }],
    recentRepos: [],
  }));
  init();
  assert.equal(getLaunchConfigForCodexThread(claudeId, lookupCwd), null);
});

test('getLaunchConfigForCodexThread: falsy args → null, no throw', () => {
  assert.equal(getLaunchConfigForCodexThread(null, scratch), null);
  assert.equal(getLaunchConfigForCodexThread('some-id', null), null);
  assert.equal(getLaunchConfigForCodexThread('', ''), null);
});

// ---- codexThreadFor ----
// getLaunchConfigForCodexThread's inverse: resolves a registered codex agent's
// id (a randomUUID create() minted) to the codex-minted thread uuid its
// transcript is actually filed under — same discovery buildSpawn uses to
// resume it (time-based cwd+createdAt match against the rollout).
test('codexThreadFor: registered codex agent + matching rollout → thread uuid', () => {
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
  assert.equal(codexThreadFor(agentId), threadId);
});

// ---- writeAtomic (server/background.test.mjs:214 flake regression) ------------
// Windows rename-over-existing-file can transiently EPERM/EACCES/EBUSY (AV/
// Search/a brief reader). Inject a fake `rename` that throws those codes N
// times, then delegates to the real renameSync — writeAtomic must retry past
// them and still land the file, but must not retry (or swallow) an unrelated
// error code.
test('writeAtomic: retries past transient EPERM, then succeeds', () => {
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
test('writeAtomic: non-retryable error rethrows immediately, no retry', () => {
  const file = join(scratch, 'retry-fatal.json');
  let calls = 0;
  const fakeRename = () => { calls++; const e = new Error('gone'); e.code = 'ENOENT'; throw e; };
  assert.throws(() => writeAtomic(file, 'x', fakeRename), /gone/);
  assert.equal(calls, 1);
});
