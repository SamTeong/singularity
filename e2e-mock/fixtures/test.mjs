// Extended test for mock e2e. Every test fails on unexpected browser console
// output; unlike the daemon suite, the mock owns all network endpoints.
import { test as base, expect } from '@playwright/test';

// Noise that is environmental, not a defect under test.
const IGNORE = [
  /favicon/i,
  /ResizeObserver loop/,
  // The WS reconnects during teardown/reload; a closing socket logs from the browser.
  /WebSocket (connection|is closed)/i,
  // xterm's WebGL renderer reports GPU driver perf messages under headless
  // chromium's software GL. Machine-dependent noise, not an app defect.
  /GL Driver Message|WebGL|GPU stall/i,
];

export const test = base.extend({
  consoleGuard: [async ({ page }, use) => {
    const logs = [];
    const allowed = [...IGNORE];
    page.on('console', (m) => {
      const t = m.type();
      if (t === 'error' || t === 'warning') logs.push(`${t}: ${m.text()}`);
    });
    page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`));

    await use({ logs, allow: (...res) => allowed.push(...res) });

    const left = logs.filter((l) => !allowed.some((re) => re.test(l)));
    expect(left, 'browser console should be clean').toEqual([]);
  }, { auto: true }],
});

export { expect };

// Answer the next native window.confirm. Must be registered before the click
// that raises it.
export function onceConfirm(page, accept = true) {
  return new Promise((resolve) => {
    page.once('dialog', async (d) => {
      const message = d.message();
      await (accept ? d.accept() : d.dismiss());
      resolve(message);
    });
  });
}

// Mirage handles fetches inside the page, below Playwright's network layer.
// Record method + path + query so specs can still prove the intended request
// was made without coupling themselves to the mock response body.
export async function recordFetchCalls(page) {
  await page.evaluate(() => {
    window.__e2eFetchCalls = [];
    const originalFetch = window.fetch;
    window.fetch = async (...args) => {
      const [input, init] = args;
      const rawUrl = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
      const method = (init?.method || input?.method || 'GET').toUpperCase();
      const url = new URL(rawUrl, location.origin);
      window.__e2eFetchCalls.push(`${method} ${url.pathname}${url.search}`);
      return originalFetch(...args);
    };
  });
}

export const fetchCalls = (page) => page.evaluate(() => window.__e2eFetchCalls || []);
