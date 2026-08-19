// Hands-free tour: scroll the deck on its own, and STOP at the last slide
// rather than looping — a teleport back to chapter 01 reads as a glitch, and
// a reverse glide through the whole deck is worse.
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
import { useLatest } from '../hooks/useLatest';
import { scrollGlide } from '../lib/scrollGlide';
import { getChapterIndex, getChapterStep, getConductor } from '../state/appStore';
import { chapterTop, visibleChapter } from './chapterPosition';

export const AUTOPLAY_DEFAULT_DWELL_MS = 2000;
export const AUTOPLAY_MIN_DWELL_MS = 500;
export const AUTOPLAY_MAX_DWELL_MS = 10000;
export const AUTOPLAY_DWELL_STEP_MS = 500;

/** Travel speed between stops. Deliberately unhurried: the chapters with a
 *  camera dwell (config's `steps`) pack their whole flight to the next chapter
 *  into the back 45% of their scroll, so a fast glide crosses that flight in
 *  barely a second and reads as a lurch rather than a journey. The glide is
 *  shaped by `easeInOut` (smootherstep), so the camera leaves and arrives at
 *  near-zero velocity — the lurch is gone without any ceiling on the travel. */
const GLIDE_PX_PER_SECOND = 360;
/** A floor only, for hops of a few dozen pixels. There is deliberately no
 *  ceiling: a capped glide is a rushed glide. */
const MIN_GLIDE_MS = 450;
/** How far the page may drift from where the glide put it before the glide
 *  concedes — the reader grabbing the scroll wins over the tour. */
const HANDOVER_PX = 40;

interface Stop {
  chapter: number;
  /** null when the whole chapter is one stop. */
  step: number | null;
}

export function useAutoplay(
  enabled: boolean,
  is3D: boolean,
  dwellMs: number,
  onComplete?: () => void,
): void {
  const dwellMsRef = useLatest(dwellMs);
  const onCompleteRef = useLatest(onComplete);

  useEffect(() => {
    if (!enabled) return;

    const stops: Stop[] = [];
    CHAPTERS.forEach((_chapter, i) => {
      const steps = is3D ? stepCount(i) : 0;
      if (steps) for (let s = 0; s < steps; s++) stops.push({ chapter: i, step: s });
      else stops.push({ chapter: i, step: null });
    });

    let timer = 0;
    let cancelGlide: (() => void) | null = null;

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

    function glide(to: number, done: () => void): void {
      // smootherstep easing (see lib/scrollGlide) leaves and arrives at
      // near-zero velocity, so the tour eases away from a slide and settles
      // onto the next instead of lurching into motion the moment the dwell
      // ends. Starting AUTOPLAY explicitly opts into its motion; collapsing
      // the glide under reduced motion turns every transition into a
      // disorienting jump, so the glide runs regardless of that preference.
      cancelGlide = scrollGlide(to, {
        rate: GLIDE_PX_PER_SECOND,
        minMs: MIN_GLIDE_MS,
        handoverPx: HANDOVER_PX,
        onDone: done,
      });
    }

    function tick(): void {
      // Past the last stop the tour ENDS. The reader has already dwelled on
      // the final slide (the dwell runs before tick fires), so hand control
      // back instead of teleporting to chapter 01.
      const at = currentStop();
      if (at >= stops.length - 1) {
        onCompleteRef.current?.();
        return;
      }
      const next = stops[at + 1];
      const to = targetTop(next);
      glide(to, () => {
        timer = window.setTimeout(tick, dwellMsRef.current);
      });
    }

    // The first hop waits out the stop the reader is already on — they turned
    // the tour on where they were standing, so that screen gets its own beat.
    timer = window.setTimeout(tick, dwellMsRef.current);
    return () => {
      window.clearTimeout(timer);
      cancelGlide?.();
    };
  }, [dwellMsRef, onCompleteRef, enabled, is3D]);
}
