// Scroll-position restoration across reloads.
//
// The one-shot gets this for free: its deck is inline in the HTML, so at parse
// time the document already has its full height and the browser's own
// restoration lands correctly. `sizeBeats()` running before `boot()` (source
// L1664) is what keeps that true during the 11.5MB download — the engineering
// note calls it "optimistic boot", and without it "the browser cannot restore
// a mid-page reload".
//
// A React SPA cannot inherit that: at parse time the document is an empty
// <div id="root">, so when the browser applies its saved scroll offset there is
// nothing to scroll. By the time React has rendered and the beats are sized,
// the browser has already given up. Measured: a reload at y=5351 lands at 0.
//
// So we take over. `scrollRestoration = 'manual'` stops the browser's own
// (useless here) attempt, and we re-apply the offset ourselves at the one
// moment the document is guaranteed to be its final height — right after
// applyBeatHeights() in 3D, or after first paint in flat mode.

const KEY = 'sx:scroll:' + location.pathname;

let armed = false;

/** Start recording. Idempotent; safe to call from an effect that may re-run. */
export function armScrollRestore(): () => void {
  if (armed) return () => {};
  armed = true;

  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';

  // Cheap: one sessionStorage write per animation frame at most, and only
  // while the user is actually scrolling.
  let pending = false;
  const onScroll = () => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      try {
        sessionStorage.setItem(KEY, String(Math.round(window.scrollY)));
      } catch {
        // Private-mode / quota — restoration is a nicety, never a hard failure.
      }
    });
  };

  addEventListener('scroll', onScroll, { passive: true });
  addEventListener('pagehide', onScroll);

  return () => {
    removeEventListener('scroll', onScroll);
    removeEventListener('pagehide', onScroll);
    armed = false;
  };
}

/**
 * Re-apply the saved offset. Call once the document has its FINAL height —
 * in 3D that means after the beats are sized, not before, or the target is
 * clamped to a short document exactly like the browser's own attempt was.
 *
 * Must also run before the conductor starts: its start() seeds `prevY` and
 * `exact` from the live scrollY (source L1113-1115), so restoring afterwards
 * would leave the camera parked at chapter 0 while the page sits mid-deck.
 */
export function restoreScroll(): void {
  let saved: string | null = null;
  try {
    saved = sessionStorage.getItem(KEY);
  } catch {
    return;
  }
  if (saved === null) return;

  const y = Number(saved);
  if (!Number.isFinite(y) || y <= 0) return;

  const max = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
  window.scrollTo({ top: Math.min(y, max), behavior: 'instant' as ScrollBehavior });
}
