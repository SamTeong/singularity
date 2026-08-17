// e2e config. The suite always runs against the sandbox daemon booted by
// e2e/serve.mjs (own port, own state root, stub claude binary) — never the
// user's real :4317 instance. `pnpm test:e2e` builds web/dist first, because the
// daemon serves the built shell; `playwright test` alone reuses whatever dist is
// on disk.
import { defineConfig } from '@playwright/test';
import { join } from 'node:path';
import { BASE_URL, TMP } from './e2e/fixtures/paths.mjs';

// A run with E2E_PORT set is a parallel side-run (one spec under development).
// Keep its artifacts inside its own sandbox dir and off the shared html report.
const sideRun = !!process.env.E2E_PORT;

export default defineConfig({
  testDir: 'e2e',
  // One daemon, one mutable state dir, and terminals blank while a tab is
  // backgrounded (AgentsProvider drops output for hidden tabs) — serial only.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: sideRun ? [['line']] : [['list'], ['html', { open: 'never' }]],
  outputDir: sideRun ? join(TMP, 'test-results') : undefined,
  // Generous, because every wait here is a fetch + a React remount, and the
  // suite shares one box with whatever else is building. Tight timeouts turned
  // into a steady drip of false failures that moved between runs.
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: BASE_URL,
    viewport: { width: 1600, height: 1000 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  // Bundled chromium (pnpm exec playwright install chromium) — deliberately not
  // devices['Desktop Chrome'], which pins channel:'chrome' and would drive the
  // locally installed browser instead.
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: {
    command: 'node e2e/serve.mjs',
    url: `${BASE_URL}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    // The daemon logs every request at info level — piping it buries the
    // reporter. Errors still surface via stderr.
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
