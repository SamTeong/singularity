const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_TIMEOUT_MS = 10_000;
const BASE_DELAY_MS = 250;
const MAX_DELAY_MS = 5_000;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function retryAfterMs(value, now = Date.now()) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

export function isRetryableResponse(response) {
  return RETRYABLE_STATUS.has(response.status);
}

export async function fetchExternal(url, options = {}, policy = {}) {
  const {
    retry = true,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    sleep = delay,
    random = Math.random,
  } = policy;
  const attempts = retry ? maxAttempts : 1;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const ctrl = new AbortController();
    const timer = timeoutMs == null ? null : setTimeout(() => ctrl.abort(), timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, ctrl.signal]) : ctrl.signal;
    let response;
    try {
      response = await fetch(url, { ...options, signal });
    } catch (error) {
      if (options.signal?.aborted || attempt === attempts) throw error;
      await sleep(Math.floor(Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (attempt - 1)) * random()));
      continue;
    } finally {
      clearTimeout(timer);
    }

    if (!isRetryableResponse(response) || attempt === attempts) return response;
    const retryAfter = response.status === 429 ? retryAfterMs(response.headers?.get?.('retry-after')) : null;
    await sleep(retryAfter ?? Math.floor(Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (attempt - 1)) * random()));
  }
}
