// Transcript liveness indicators (SessionHistory). The daemon's list row
// carries processLive (a dock agent owns the session) and activityRecent
// (mtime inside the recency window), and they are independent: a session
// touched recently is labelled "recent activity" only while no process is live.
// The mock answers /transcripts through Mirage inside the page, so this seeds
// two rows at the fetch layer instead of the corpus (whose mtimes are old).
import { test, expect } from './fixtures/test.mjs';
import { gotoView } from '../e2e/helpers/nav.mjs';

test('recent-but-not-live rows are labelled "recent activity"; live rows are not', async ({ page }) => {
  await page.addInitScript(() => {
    const rows = () => {
      const now = Date.now();
      const base = { project: 'workspace-alpha', cwd: '/fixture/alpha', blurb: '', mtime: now, size: 10, source: 'claude' };
      return [
        { ...base, id: 'recent-only', title: 'Recent only', processLive: false, activityRecent: true, processState: 'unknown', running: false },
        { ...base, id: 'live-now', title: 'Live now', processLive: true, activityRecent: true, processState: 'live', running: true },
      ];
    };
    const wrap = (originalFetch) => (input, init) => {
      const rawUrl = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
      const url = new URL(rawUrl, location.origin);
      if (url.pathname === '/api/transcripts') {
        return Promise.resolve(new Response(JSON.stringify({ sessions: rows() }), {
          headers: { 'content-type': 'application/json' },
        }));
      }
      return originalFetch(input, init);
    };
    let current = wrap(window.fetch);
    Object.defineProperty(window, 'fetch', { configurable: true, get: () => current, set: (v) => { current = wrap(v); } });
  });

  await page.goto('/tasks');
  await gotoView(page, 'Transcripts');

  const recent = page.getByRole('button', { name: /Recent only/ });
  const live = page.getByRole('button', { name: /Live now/ });
  await expect(recent).toBeVisible();
  await expect(recent.getByText('recent activity')).toBeVisible();
  // Same fresh mtime, but a live process: the label is suppressed.
  await expect(live).toBeVisible();
  await expect(live.getByText('recent activity')).toHaveCount(0);
});
