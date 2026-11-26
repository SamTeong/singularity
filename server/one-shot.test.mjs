// Unit tests for one-shot.mjs: argv building per group, answer channels
// (claude stdout JSON envelope, codex -o file, ollama stdout), the claude
// failure-reason extraction from e.stdout, timeout pass-through, and the
// default backend executor (setOneShotBackend) that history.mjs's caller
// parses through. SINGULARITY_HOME + dummy CLAUDE_BIN/CODEX_BIN/OLLAMA_BIN
// are set before the module graph is imported (agents.mjs throws without
// them); no provider CLI runs. Run: pnpm test
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const scratch = mkdtempSync(join(tmpdir(), 'singularity-one-shot-test-'));
process.env.SINGULARITY_HOME = join(scratch, 'singularity');
process.env.USAGE_REPORT_STATE = join(scratch, 'usage-report-state');
for (const [name, bin] of [['CLAUDE_BIN', 'fake-claude'], ['CODEX_BIN', 'fake-codex'], ['OLLAMA_BIN', 'fake-ollama']]) {
  process.env[name] = join(scratch, bin);
  writeFileSync(process.env[name], '');
}
mkdirSync(join(scratch, 'singularity', 'state'), { recursive: true });
after(() => rmSync(scratch, { recursive: true, force: true }));

const { oneShotSpawn, runOneShotPrompt, setOneShotBackend } = await import('./one-shot.mjs');
const { STATE_DIR, CLAUDE_BIN, CODEX_BIN, OLLAMA_BIN } = await import('./agents.mjs');

const calls = [];
function fakeSpawn(stdout) {
  return (file, args, opts) => {
    calls.push({ file, args, opts });
    if (args[0] === 'exec') writeFileSync(args[args.indexOf('-o') + 1], 'ok');
    return Promise.resolve({ stdout });
  };
}

test('claude branch builds read-only argv and returns the stdout envelope', async () => {
  const envelope = JSON.stringify({ result: 'answer text', usage: { input_tokens: 3, output_tokens: 5 } });
  const out = await runOneShotPrompt('claude', 'haiku', 'summarise day', { spawn: fakeSpawn(envelope) });
  assert.equal(out, envelope);
  assert.equal(calls.at(-1).file, CLAUDE_BIN);
  // The prompt rides stdin (opts.input), never argv.
  assert.deepEqual(calls.at(-1).args, ['-p', '--model', 'haiku', '--output-format', 'json', '--no-session-persistence']);
  assert.equal(calls.at(-1).opts.input, 'summarise day');
  assert.equal(calls.at(-1).opts.timeout, 120_000);
  const meta = await runOneShotPrompt('claude', 'haiku', 'p', { spawn: fakeSpawn(envelope), includeMetadata: true });
  assert.deepEqual(meta, { answer: envelope, usage: { input_tokens: 3, output_tokens: 5 } });
});

test('claude branch extracts the failure reason from the error stdout envelope', async () => {
  const fail = () => {
    const e = new Error('Command failed: claude');
    e.stdout = JSON.stringify({ result: 'Not logged in · run /login' });
    return Promise.reject(e);
  };
  await assert.rejects(runOneShotPrompt('claude', 'haiku', 'p', { spawn: fail }), /Not logged in · run \/login/);
});

test('claude branch rejects an is_error envelope on exit 0', async () => {
  const limited = JSON.stringify({ is_error: true, subtype: 'success', result: 'usage limit reached' });
  await assert.rejects(runOneShotPrompt('claude', 'haiku', 'p', { spawn: fakeSpawn(limited) }), /^Error: usage limit reached$/);
  const bare = JSON.stringify({ is_error: true, subtype: 'error_max_turns' });
  await assert.rejects(runOneShotPrompt('claude', 'haiku', 'p', { spawn: fakeSpawn(bare), includeMetadata: true }), /^Error: error_max_turns$/);
  const misleading = JSON.stringify({ is_error: true, subtype: 'success', result: '' });
  await assert.rejects(runOneShotPrompt('claude', 'haiku', 'p', { spawn: fakeSpawn(misleading) }), /^Error: claude one-shot failed$/);
});

test('the fallback execFile path writes the prompt to stdin and closes it', async () => {
  const ended = [];
  const spawn = () => Object.assign(Promise.resolve({ stdout: 'raw' }), {
    child: { stdin: { end: (data) => ended.push(data) } },
  });
  await runOneShotPrompt('ollama', 'llama', 'long prompt', { spawn });
  assert.deepEqual(ended, ['long prompt']);
});

test('the standalone executor delivers the full prompt to a real child', async () => {
  const script = join(scratch, 'echo-stdin.cjs');
  writeFileSync(script, 'process.stdin.pipe(process.stdout);');
  const input = 'multiline prompt\n'.repeat(5_000);
  const { stdout } = await oneShotSpawn(process.execPath, [script], { input, timeout: 10_000 });
  assert.equal(stdout, input);
});

test('codex branch reads the -o answer file, parses usage from stdout, and cleans up', async () => {
  const jsonl = `${JSON.stringify({ type: 'turn.started' })}\n${JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 12, output_tokens: 1 } })}\n`;
  const answer = await runOneShotPrompt('codex', 'gpt-6', 'p', { spawn: fakeSpawn(jsonl) });
  assert.equal(answer, 'ok');
  const call = calls.at(-1);
  assert.equal(call.file, CODEX_BIN);
  assert.equal(call.opts.timeout, 120_000);
  for (const flag of ['exec', '-s', 'read-only', '--skip-git-repo-check', '--ephemeral', '-C', STATE_DIR]) {
    assert.ok(call.args.includes(flag), `argv missing ${flag}: ${call.args}`);
  }
  assert.equal(call.args.at(-1), '-', 'codex reads the prompt from stdin');
  assert.ok(!call.args.includes('p'), 'prompt not in argv');
  assert.equal(call.opts.input, 'p');
  const tmp = call.args[call.args.indexOf('-o') + 1];
  assert.ok(tmp.startsWith(STATE_DIR), 'answer file under STATE_DIR');
  assert.equal(existsSync(tmp), false, 'temp answer file removed');
  const meta = await runOneShotPrompt('codex', 'gpt-6', 'p', { spawn: fakeSpawn(jsonl), includeMetadata: true });
  assert.deepEqual(meta, { answer: 'ok', usage: { input_tokens: 12, output_tokens: 1 } });
});

test('ollama branch passes prompt and flags through and returns stdout', async () => {
  const out = await runOneShotPrompt('ollama', 'llama', 'p', { spawn: fakeSpawn('raw answer') });
  assert.equal(out, 'raw answer');
  assert.equal(calls.at(-1).file, OLLAMA_BIN);
  assert.deepEqual(calls.at(-1).args, ['run', '--hidethinking', '--nowordwrap', 'llama']);
  assert.equal(calls.at(-1).opts.input, 'p');
  const meta = await runOneShotPrompt('ollama', 'llama', 'p', { spawn: fakeSpawn('raw answer'), includeMetadata: true });
  assert.deepEqual(meta, { answer: 'raw answer', usage: null });
});

test('timeoutMs reaches the executor and a killed spawn propagates', async () => {
  const fail = (file, args, opts) => {
    calls.push({ file, args, opts });
    const e = new Error(`Command timed out after ${opts.timeout}ms: ${file}`);
    e.killed = true;
    return Promise.reject(e);
  };
  await assert.rejects(runOneShotPrompt('claude', 'haiku', 'p', { timeoutMs: 90_000, spawn: fail }), /timed out after 90000ms/);
  assert.equal(calls.at(-1).opts.timeout, 90_000);
  await assert.rejects(runOneShotPrompt('ollama', 'llama', 'p', { spawn: fail }), /timed out/);
  await assert.rejects(runOneShotPrompt('unknown', 'm', 'p'), /unknown group 'unknown'/);
});

test('default executor routes through the wired Rust backend', async () => {
  const seen = [];
  setOneShotBackend({
    oneShot(bin, args, opts) {
      seen.push({ bin, args, opts });
      if (args.includes('--boom')) {
        const e = new Error('Command failed: claude');
        e.stdout = JSON.stringify({ result: 'claude down' });
        throw e;
      }
      return Promise.resolve({ stdout: JSON.stringify({ result: 'ok', usage: { input_tokens: 1, output_tokens: 2 } }) });
    },
  });
  try {
    const stdout = await runOneShotPrompt('claude', 'haiku', 'p', { timeoutMs: 90_000 });
    assert.deepEqual(JSON.parse(stdout), { result: 'ok', usage: { input_tokens: 1, output_tokens: 2 } });
    assert.equal(seen.at(-1).bin, CLAUDE_BIN);
    assert.equal(seen.at(-1).opts.timeout, 90_000);
    assert.deepEqual(seen.at(-1).args, ['-p', '--model', 'haiku', '--output-format', 'json', '--no-session-persistence']);
    assert.equal(seen.at(-1).opts.input, 'p');
    await assert.rejects(runOneShotPrompt('claude', 'haiku', 'p', { extraArgs: ['--boom'] }), /claude down/);
  } finally {
    setOneShotBackend(undefined);
  }
});

test('history.mjs summariser callers parse the backend envelope unchanged', async () => {
  const envelope = JSON.stringify({ result: 'summary text', usage: { input_tokens: 7, output_tokens: 9 } });
  setOneShotBackend({ oneShot: () => Promise.resolve({ stdout: envelope }) });
  try {
    const { defaultCallSummariser } = await import('./history.mjs');
    const out = await defaultCallSummariser('digest', { id: 'haiku', group: 'claude' }, { system: null });
    assert.deepEqual(out, { text: 'summary text', inputTokens: 7, outputTokens: 9 });
    const ollama = await defaultCallSummariser('digest', { id: 'llama', group: 'ollama' }, { system: null });
    assert.equal(ollama.text, envelope);
  } finally {
    setOneShotBackend(undefined);
  }
});
