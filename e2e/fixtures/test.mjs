// Extended `test` for the suite. Import from here, never from @playwright/test
// directly — two auto fixtures ride along:
//
//  * consoleGuard — fails any test that logged a console error/warning or threw.
//    This is what the standalone console scanner used to do for the nav walk
//    only; here every spec gets it, so a React "unknown prop" or MUI deprecation
//    warning surfaces from whichever flow triggers it. Opt out per-assertion with
//    consoleGuard.allow(/regex/).
//
//  * stubNetwork — /status and /usage reach the live internet (statuspage APIs,
//    the Anthropic usage API, and a headless-chromium scrape for Ollama). They
//    are stubbed to fixed payloads so those views are deterministic and fast.
//    Drop the stub for one test with stubNetwork.passthrough().
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

export const STATUS_STUB = {
  claude: {
    ok: true, key: 'claude', label: 'Claude', pageUrl: 'https://status.claude.com',
    indicator: 'none', description: 'All Systems Operational',
    fetchedAt: new Date().toISOString(),
    components: [
      { name: 'Claude on the web', status: 'operational' },
      { name: 'API', status: 'operational' },
    ],
    incidents: [],
    maintenances: [],
  },
  openai: {
    ok: true, key: 'openai', label: 'OpenAI', pageUrl: 'https://status.openai.com',
    indicator: 'minor', description: 'Partially Degraded Service',
    fetchedAt: new Date().toISOString(),
    components: [{ name: 'API', status: 'degraded_performance' }],
    incidents: [{ name: 'Elevated error rates', status: 'monitoring', impact: 'minor', shortlink: 'https://status.openai.com' }],
    maintenances: [],
  },
};

export const USAGE_STUB = {
  claude: {
    ok: true, source: 'claude',
    session: { pctUsed: 42, used: 42, limit: 100, resetsAt: new Date(Date.now() + 3600_000).toISOString() },
    weekly: { pctUsed: 61, used: 61, limit: 100, resetsAt: new Date(Date.now() + 4 * 86400_000).toISOString() },
    fetchedAt: new Date().toISOString(),
  },
  ollama: {
    ok: false, source: 'ollama', needsAuth: true, error: 'not signed in',
    fetchedAt: new Date().toISOString(),
  },
};

const isPath = (p) => (url) => new URL(url).pathname === p;

export const test = base.extend({
  stubNetwork: [async ({ page }, use) => {
    let on = true;
    await page.route(isPath('/status'), async (route) => {
      if (!on) return route.fallback();
      await route.fulfill({ json: STATUS_STUB });
    });
    await page.route(isPath('/usage'), async (route) => {
      if (!on) return route.fallback();
      await route.fulfill({ json: USAGE_STUB });
    });
    await use({ passthrough: () => { on = false; } });
  }, { auto: true }],

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

// Answer the next native window.confirm — a lot of destructive flows are gated
// on one (task conclude/delete, cron delete, "Discard unsaved changes?"). Must be
// registered BEFORE the click that raises it.
export function onceConfirm(page, accept = true) {
  return new Promise((resolve) => {
    page.once('dialog', async (d) => {
      const message = d.message();
      await (accept ? d.accept() : d.dismiss());
      resolve(message);
    });
  });
}
