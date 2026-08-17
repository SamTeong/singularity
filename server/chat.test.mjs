// Unit tests for consumeStream: the SSE parser for the Messages API stream.
// A fake fetch-Response-shaped body (getReader().read() yielding queued
// Uint8Array chunks then {done:true}) drives the parser without any network.
// chat.mjs imports usage.mjs → app-dir.mjs (requires SINGULARITY_HOME) — point
// it at a scratch temp dir before the dynamic import. Run: npm test
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const scratch = mkdtempSync(join(tmpdir(), 'singularity-chat-test-'));
process.env.SINGULARITY_HOME = join(scratch, 'sing');
// claudeOauthToken() (usage.mjs) reads <homedir>/.claude/.credentials.json, not
// SINGULARITY_HOME — redirect homedir() (checked live, not at import time) at a
// fake one so callMessages/streamChat see a token without touching real creds.
process.env.HOME = scratch;
process.env.USERPROFILE = scratch;
mkdirSync(join(scratch, '.claude'), { recursive: true });
writeFileSync(join(scratch, '.claude', '.credentials.json'), JSON.stringify({
  claudeAiOauth: { accessToken: 'fake-token', expiresAt: Date.now() + 3600_000 },
}));
after(() => { rmSync(scratch, { recursive: true, force: true }); });

const { consumeStream, callMessages } = await import('./chat.mjs');

// Queues each entry as one reader.read() resolution (string entries are
// UTF-8 encoded), then returns {done:true} forever.
function makeBody(chunks) {
  let i = 0;
  return {
    getReader() {
      return {
        async read() {
          if (i < chunks.length) {
            const raw = chunks[i++];
            return { value: typeof raw === 'string' ? new TextEncoder().encode(raw) : raw, done: false };
          }
          return { value: undefined, done: true };
        },
        async cancel() {},
      };
    },
  };
}

test('consumeStream: an SSE data event split across two read() chunks yields exactly one chat:delta with the full text', async () => {
  const block = 'data: ' + JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'hello world' } }) + '\n\n';
  const mid = Math.floor(block.length / 2);
  const body = makeBody([block.slice(0, mid), block.slice(mid)]);
  const calls = [];
  await consumeStream(body, (m) => calls.push(m), 'c1', undefined);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { t: 'chat:delta', chatId: 'c1', text: 'hello world' });
});

test('consumeStream: message_stop sends chat:done and returns true', async () => {
  const block = 'data: ' + JSON.stringify({ type: 'message_stop' }) + '\n\n';
  const calls = [];
  const result = await consumeStream(makeBody([block]), (m) => calls.push(m), 'c2', undefined);
  assert.equal(result, true);
  assert.deepEqual(calls, [{ t: 'chat:done', chatId: 'c2' }]);
});

test('consumeStream: an error payload sends chat:error and returns true', async () => {
  const block = 'data: ' + JSON.stringify({ type: 'error', error: { message: 'boom' } }) + '\n\n';
  const calls = [];
  const result = await consumeStream(makeBody([block]), (m) => calls.push(m), 'c3', undefined);
  assert.equal(result, true);
  assert.deepEqual(calls, [{ t: 'chat:error', chatId: 'c3', msg: 'boom' }]);
});

test('consumeStream: quiet stream end with no terminal event returns false and sends nothing', async () => {
  const calls = [];
  const result = await consumeStream(makeBody([]), (m) => calls.push(m), 'c4', undefined);
  assert.equal(result, false);
  assert.deepEqual(calls, []);
});

// Regression: the Messages fetch has no timeout, so a hung connection (e.g. a
// stalled TLS handshake) never settles. callMessages must (a) bound the fetch
// with a signal and (b) turn a resulting abort/error into a clean {ok:false}
// result rather than hanging or rejecting — and a second call afterward must
// still go through, not join a promise wedged by the first failure.
test('callMessages: an aborting fetch resolves cleanly, and a second call still goes through', async () => {
  const realFetch = global.fetch;
  let calls = 0;
  global.fetch = async (_url, opts) => {
    calls++;
    assert.ok(opts.signal instanceof AbortSignal, 'fetch must be bounded by an AbortSignal');
    throw new DOMException('The operation was aborted.', 'AbortError');
  };
  try {
    for (let i = 0; i < 2; i++) {
      const r = await callMessages({ system: 's', messages: [{ role: 'user', content: 'hi' }] });
      assert.equal(r.ok, false);
      assert.match(r.error, /request failed/);
    }
    assert.equal(calls, 2);
  } finally {
    global.fetch = realFetch;
  }
});
