// Animated `scrollTo` with a pronounced ease-in/out. Both the autoplay tour
// (app/useAutoplay) and manual "go to slide" (world/conductor.goTo) route
// through here so the camera leaves and arrives at near-zero velocity on every
// hop — a smootherstep curve, not the browser's native smooth-scroll, which
// decelerates INTO a target but accelerates OUT of one instantly (a lurch on
// departure).
//
// The reader grabbing the scroll wins: if the page drifts past `handoverPx`
// from this animation's last write, the glide concedes and `onDone` fires so a
// caller chaining stops (the tour) resumes from where the reader actually is.
// An explicit cancel (the returned function) does NOT fire `onDone` — it is a
// teardown, not a completion.

import { easeInOut } from './math';

export interface ScrollGlideOptions {
  /** Travel speed in px/s. */
  rate: number;
  /** Floor on duration, for hops of a few dozen px. */
  minMs: number;
  /** Optional ceiling on duration. Omitted for the autoplay tour (a capped
   *  glide is a rushed glide); applied to manual nav so a cross-deck click
   *  doesn't take whole seconds. */
  maxMs?: number;
  /** Concede if the page drifts this far from the last write (reader scroll). */
  handoverPx?: number;
  /** Fired on completion or handover — NOT on explicit cancel. */
  onDone?: () => void;
}

/** Ease the page from its current scroll position to `to`. Returns a cancel
 *  function (safe to call repeatedly). */
export function scrollGlide(to: number, opts: ScrollGlideOptions): () => void {
  const { rate, minMs, maxMs, handoverPx = 40, onDone } = opts;
  const from = window.scrollY;
  const distance = Math.abs(to - from);
  if (distance < 4) {
    window.scrollTo({ top: to, behavior: 'instant' });
    onDone?.();
    return () => {};
  }
  let ms = Math.max(minMs, (distance / rate) * 1000);
  if (maxMs !== undefined) ms = Math.min(ms, maxMs);
  const started = performance.now();
  let written = from;
  let frame = 0;
  frame = window.requestAnimationFrame(function step(now: number): void {
    // Checked before this frame writes, so what it sees is the reader's own
    // scrolling and not the glide's last write.
    if (Math.abs(window.scrollY - written) > handoverPx) {
      frame = 0;
      onDone?.();
      return;
    }
    const t = Math.min(1, (now - started) / ms);
    const eased = easeInOut(t);
    written = Math.round(from + (to - from) * eased);
    window.scrollTo({ top: written, behavior: 'instant' });
    if (t < 1) {
      frame = window.requestAnimationFrame(step);
    } else {
      frame = 0;
      onDone?.();
    }
  });
  return () => {
    if (frame) window.cancelAnimationFrame(frame);
    frame = 0;
  };
}