// Mock e2e config. The suite drives the production-mode mock bundle through
// Vite preview; each browser page owns an isolated in-memory Mirage database.
import { defineConfig } from '@playwright/test';
import { join } from 'node:path';

const port = Number(process.env.E2E_MOCK_PORT) || 4173;
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: 'e2e-mock',
  fullyParallel: true,
  // CI runner shares one box; workers:2 + tight timeouts turned into a steady
  // drip of unrelated tests tipping over 30s (same failure mode the e2e
  // daemon suite hit — see playwright.config.mjs). Serial + generous budget
  // fixes it. Even serial, a 2-core runner leaves the heaviest tests over
  // 60s, and a rotating second test tips with them — so CI gets a doubled
  // per-test budget plus one retry for the load-induced stragglers.
  workers: process.env.CI ? 1 : 4,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [
    ['list'],
    ['html', { outputFolder: join('playwright-report', 'mock'), open: 'never' }],
  ],
  outputDir: join('test-results', 'mock'),
  timeout: process.env.CI ? 120_000 : 60_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL,
    viewport: { width: 1600, height: 900 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: {
    // Both --config and --mode are load-bearing: mock mode selects dist-mock
    // and registers the preview middleware for mock-only subresources.
    command: `vite preview --config web/vite.config.mjs --mode mock --host 127.0.0.1 --port ${port} --strictPort`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
