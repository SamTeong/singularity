// Hands-free tour: scroll the deck on its own, looping back to chapter 01
// after the last one.
//
// It scrolls rather than jumps. The reader is watching a camera on rails, and
// a teleport between stops throws away the part of the story that happens
// between them — so each hop is animated frame by frame, and the world sees
// exactly the scroll it would have seen from a hand on the wheel.
//
// The stops are the same positions a reader reaches by scrolling — in 3D that
// includes the in-chapter steps (the fleet-control tabs, the tasks flow), each
// of which is a band of its chapter's scroll (see deck/useScrollStep.ts), so
// autoplay never skips content the scroll would have shown. Flat mode has no
// conductor and therefore no bands: there a stop is a whole chapter.
//
// The two durations are independent by design: the pause is a fixed beat, and
// the travel takes exactly as long as covering the distance smoothly takes.
// Nothing budgets one against the other — a ceiling on the travel would just
// become its speed, and a rushed glide is what "it jumps" looks like.

import { useEffect } from 'react';
import { CHAPTERS } from '../config/chapters';
import { stepCount, stepProgress } from '../deck/useScrollStep';
import { REDUCED_MOTION } from '../lib/env';
import { getChapterIndex, getChapterStep, getConductor } from '../state/appStore';
import { chapterTop, visibleChapter } from './chapterPosition';

/** How long the tour stands still at a stop, every stop. */
const DWELL_MS = 5000;

/** Travel speed between stops. Deliberately unhurried: the chapters with a
 *  camera dwell (config's `steps`) pack their whole flight to the next chapter
 *  into the back 45% of their scroll, so a fast glide crosses that flight in
 *  barely a second and reads as a lurch rather than a journey. */
const GLIDE_PX_PER_SECOND = 420;
/** The loop back from the last chapter to the first crosses the entire deck.
 *  It is a rewind, not a hop, and runs at its own speed — but still scrolls,
 *  so the reader sees where the tour is taking them. */
const REWIND_PX_PER_SECOND = 1800;
/** A floor only, for hops of a few dozen pixels. There is deliberately no
 *  ceiling: a capped glide is a rushed glide. */
const MIN_GLIDE_MS = 350;
/** How far the page may drift from where the glide put it before the glide
 *  concedes — the reader grabbing the scroll wins over the tour. */
const HANDOVER_PX = 40;

interface Stop {
  chapter: number;
  /** null when the whole chapter is one stop. */
  step: number | null;
}

export function useAutoplay(enabled: boolean, is3D: boolean): void {
  useEffect(() => {
    if (!enabled) return;

    const stops: Stop[] = [];
    CHAPTERS.forEach((_chapter, i) => {
      const steps = is3D ? stepCount(i) : 0;
      if (steps) for (let s = 0; s < steps; s++) stops.push({ chapter: i, step: s });
      else stops.push({ chapter: i, step: null });
    });

    let timer = 0;
    let frame = 0;

    // Read live rather than kept as a cursor, so a reader who scrolls or clicks
    // mid-tour resumes from where they actually are, not from where the tour
    // last left them.
    function currentStop(): number {
      const chapter = is3D ? (getChapterIndex() ?? 0) : visibleChapter();
      const stepState = getChapterStep();
      const step = is3D && stepState?.chapter === chapter ? stepState.step : null;
      const at = stops.findIndex((s) => s.chapter === chapter && (step === null || s.step === step));
      return at < 0 ? 0 : at;
    }

    function targetTop(stop: Stop): number {
      const conductor = getConductor();
      if (conductor) {
        const at = stop.step === null ? stop.chapter : stepProgress(stop.chapter, stop.step);
        return conductor.topAt(at);
      }
      return chapterTop(stop.chapter);
    }

    function glide(to: number, rate: number, done: () => void): void {
      const from = window.scrollY;
      const distance = Math.abs(to - from);
      if (REDUCED_MOTION || distance < 4) {
        window.scrollTo({ top: to, behavior: 'instant' });
        done();
        return;
      }
      const ms = Math.max(MIN_GLIDE_MS, (distance / rate) * 1000);
      const started = performance.now();
      let written = from;
      frame = requestAnimationFrame(function step(now) {
        // Checked before this frame writes, so what it sees is the reader's own
        // scrolling and not the glide's own last write.
        if (Math.abs(window.scrollY - written) > HANDOVER_PX) {
          done();
          return;
        }
        const t = Math.min(1, (now - started) / ms);
        const eased = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
        written = Math.round(from + (to - from) * eased);
        window.scrollTo({ top: written, behavior: 'instant' });
        if (t < 1) frame = requestAnimationFrame(step);
        else done();
      });
    }

    function tick(): void {
      // `% stops.length` is the loop: past the last stop the tour scrolls back
      // to chapter 01 and starts over.
      const at = currentStop();
      const wrapping = at === stops.length - 1;
      const next = stops[(at + 1) % stops.length];
      glide(targetTop(next), wrapping ? REWIND_PX_PER_SECOND : GLIDE_PX_PER_SECOND, () => {
        timer = window.setTimeout(tick, DWELL_MS);
      });
    }

    // The first hop waits out the stop the reader is already on — they turned
    // the tour on where they were standing, so that screen gets its own beat.
    timer = window.setTimeout(tick, DWELL_MS);
    return () => {
      window.clearTimeout(timer);
      cancelAnimationFrame(frame);
    };
  }, [enabled, is3D]);
}
