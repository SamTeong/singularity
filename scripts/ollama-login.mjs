// One-time interactive login for the Ollama usage scraper's browser mode.
// Opens a real (headful) Edge window against a persistent profile; you sign in
// to ollama.com manually (magic-link / OAuth can't be automated). The profile
// then persists, so server/usage.mjs can reuse it headlessly with no cookies.
//   Run: npm run ollama-login
import { chromium } from 'playwright-core';
import { OLLAMA_PROFILE_DIR, PW_STEALTH, pwHideWebdriver } from '../server/usage.mjs';

const PROFILE_DIR = OLLAMA_PROFILE_DIR;

// Headful + the same anti-automation flags the runtime uses, so Cloudflare
// Turnstile lets you (a real human) solve the challenge during login.
const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
  ...PW_STEALTH,
  headless: false,
});
await pwHideWebdriver(ctx);

try {
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.goto('https://ollama.com/settings', { waitUntil: 'domcontentloaded' });

  console.log(`\nProfile: ${PROFILE_DIR}`);
  console.log('Sign in to ollama.com in the browser window that opened.');
  console.log('When the Settings > Usage page shows your limits, press Enter here…\n');
  await new Promise((r) => process.stdin.once('data', r));

  await page.goto('https://ollama.com/settings', { waitUntil: 'domcontentloaded' });
  const ok = await page.waitForSelector('[data-usage-meter]', { timeout: 5000 }).then(() => true).catch(() => false);
  console.log(ok
    ? '\n✓ Logged in — profile saved. Set ~/.singularity/state/ollama.json to {"mode":"browser"}.'
    : '\n⚠ No usage meter detected — login may not have completed. Re-run and finish sign-in first.');
} finally {
  await ctx.close();
}
process.exit(0);
