import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchExternal, isRetryableResponse, retryAfterMs } from './external-fetch.mjs';

test('retry classification covers transient responses only', () => {
  for (const status of [408, 429, 500, 502, 503, 504]) assert.equal(isRetryableResponse({ status }), true);
  for (const status of [200, 400, 401, 403, 404, 501]) assert.equal(isRetryableResponse({ status }), false);
});

test('Retry-After accepts delta seconds and HTTP dates', () => {
  assert.equal(retryAfterMs('2'), 2_000);
  assert.equal(retryAfterMs('0x10'), 16_000);
  assert.equal(retryAfterMs('Wed, 21 Oct 2015 07:28:00 GMT', Date.parse('Wed, 21 Oct 2015 07:27:58 GMT')), 2_000);
  assert.equal(retryAfterMs('March 1, 2030', Date.parse('March 1, 2030') - 2_000), 2_000);
  assert.equal(retryAfterMs('invalid'), null);
});

test('fetchExternal anchors Retry-After to response time and preserves JavaScript parsing', async () => {
  const originalNow = Date.now;
  let now = Date.parse('Wed, 21 Oct 2015 07:27:50 GMT');
  Date.now = () => now;
  try {
    for (const [header, arrival, expectedWait, expectedCalls, expectedStatus] of [
      ['Wed, 21 Oct 2015 07:28:00 GMT', Date.parse('Wed, 21 Oct 2015 07:27:58 GMT'), 2_000, 2, 200],
      ['March 1, 2030', Date.parse('March 1, 2030') - 2_000, 2_000, 2, 200],
      ['0x10', now, null, 1, 429],
      ['invalid', now, 125, 2, 200],
    ]) {
      let calls = 0;
      const slept = [];
      const result = await fetchExternal('https://example.test/usage', {}, {
        random: () => 0.5,
        sleep: async (ms) => slept.push(ms),
        fetcher: async () => {
          calls += 1;
          now = arrival;
          return { status: calls === 1 ? 429 : 200, headers: { get: () => header } };
        },
      });
      assert.equal(result.status, expectedStatus);
      assert.equal(calls, expectedCalls);
      assert.deepEqual(slept, expectedWait == null ? [] : Array(expectedCalls - 1).fill(expectedWait));
    }
  } finally { Date.now = originalNow; }
});

test('retries a transient response with exponential backoff', async () => {
  const originalFetch = globalThis.fetch;
  const waits = [];
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return { status: calls === 1 ? 503 : 200, headers: new Headers() };
  };
  try {
    const response = await fetchExternal('https://example.test', {}, { sleep: async (ms) => waits.push(ms), random: () => 0.5 });
    assert.equal(response.status, 200);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(calls, 2);
  assert.deepEqual(waits, [125]);
});

test('retry opt-out makes one attempt', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return { status: 503, headers: new Headers() };
  };
  try {
    const response = await fetchExternal('https://example.test', {}, { retry: false });
    assert.equal(response.status, 503);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(calls, 1);
});

// A 429 whose Retry-After exceeds our backoff ceiling must end the attempt loop:
// sleeping it out blocks the caller for a minute-plus and burns another quota
// unit on the retry. (Claude's usage endpoint answers with Retry-After: 66.)
test('fetchExternal: long Retry-After returns the 429 instead of sleeping it out', async () => {
  let calls = 0;
  const slept = [];
  global.fetch = async () => { calls += 1; return { status: 429, headers: { get: () => '66' } }; };
  const resp = await fetchExternal('https://example.test/usage', {}, { sleep: async (ms) => slept.push(ms) });
  assert.equal(resp.status, 429);
  assert.equal(calls, 1);
  assert.deepEqual(slept, []);
});

test('fetchExternal: short Retry-After still retries', async () => {
  let calls = 0;
  const slept = [];
  global.fetch = async () => { calls += 1; return { status: 429, headers: { get: () => '1' } }; };
  await fetchExternal('https://example.test/usage', {}, { sleep: async (ms) => slept.push(ms) });
  assert.equal(calls, 3);
  assert.deepEqual(slept, [1000, 1000]);
});
