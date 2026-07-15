// Unit tests for consumeStream: the SSE parser for the Messages API stream.
// A fake fetch-Response-shaped body (getReader().read() yielding queued
// Uint8Array chunks then {done:true}) drives the parser without any network.
// chat.mjs imports usage.mjs → app-dir.mjs (requires SINGULARITY_HOME) — point
// it at a scratch temp dir before the dynamic import. Run: npm test
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const scratch = mkdtempSync(join(tmpdir(), 'singularity-chat-test-'));
process.env.SINGULARITY_HOME = join(scratch, 'sing');
after(() => { rmSync(scratch, { recursive: true, force: true }); });

const { consumeStream } = await import('./chat.mjs');

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
