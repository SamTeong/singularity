// Mock e2e config. The suite drives the production-mode mock bundle through
// Vite preview; each browser page owns an isolated in-memory Mirage database.
import { defineConfig } from '@playwright/test';
import { join } from 'node:path';
import { RESPONSIVE_VIEWPORTS } from './e2e-mock/helpers/responsive.mjs';

const port = Number(process.env.E2E_MOCK_PORT) || 4173;
const baseURL = `http://127.0.0.1:${port}`;
const { narrowest, phone, tablet, compactDesktop, desktop } = RESPONSIVE_VIEWPORTS;

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
  projects: [
    // Keep existing behavioural specs at their established desktop viewport.
    { name: 'chromium', testIgnore: 'responsive.spec.mjs', use: { browserName: 'chromium' } },
    // The responsive smoke contract runs only its matrix, so normal mock flows
    // do not become five times slower.
    { name: 'responsive-narrowest', testMatch: 'responsive.spec.mjs', use: { browserName: 'chromium', viewport: narrowest } },
    { name: 'responsive-phone', testMatch: 'responsive.spec.mjs', use: { browserName: 'chromium', viewport: phone } },
    { name: 'responsive-tablet', testMatch: 'responsive.spec.mjs', use: { browserName: 'chromium', viewport: tablet } },
    { name: 'responsive-compact-desktop', testMatch: 'responsive.spec.mjs', use: { browserName: 'chromium', viewport: compactDesktop } },
    { name: 'responsive-desktop', testMatch: 'responsive.spec.mjs', use: { browserName: 'chromium', viewport: desktop } },
  ],
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
