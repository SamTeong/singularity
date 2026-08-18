// Scroll-driven in-chapter steps.
//
// Two chapters hold several sub-views behind their own controls — the
// fleet-control console's four tabs and the tasks flow's five stages. In 3D
// mode the reader's scroll already carries a fractional story position
// (ConductorState.exact = chapter index + local 0..1), so the sub-views are
// bands of that local progress rather than a second, competing interaction.
//
// The band maths lives here, on both sides of the loop: App's onFrame calls
// stepAt() to publish the current band, and the steppers call seekStep() so a
// click moves the scroll position that drives them instead of fighting it.
//
// Flat mode has no conductor: stepAt() is never called, useScrollStep()
// returns null, seekStep() returns false, and each stepper stays self-driven
// exactly as before.

import { CHAPTERS, STEPS_BY_INDEX, STEP_BAND_SPAN } from '../config/chapters';
import type { ChapterId } from '../config/chapters';
import { getConductor, useChapterStep } from '../state/appStore';

// Bands cover only the first STEP_BAND_SPAN of each segment — the same stretch
// the camera parks for (createWorld's dwellProgress), so the panel being
// stepped through holds still and at full opacity while its bands are read.
// Everything after it stays on the last step while the camera flies out to the
// next chapter.
const BAND_SPAN = STEP_BAND_SPAN;

const COUNT_BY_INDEX = STEPS_BY_INDEX;

/** How many steps a chapter has; 0 for the chapters that have none. */
export function stepCount(chapter: number): number {
  return COUNT_BY_INDEX[chapter] ?? 0;
}

/** The band `local` falls in for that chapter, or null if it has no steps. */
export function stepAt(chapter: number, local: number): number | null {
  const count = COUNT_BY_INDEX[chapter] ?? 0;
  if (!count) return null;
  const i = Math.floor(local / (BAND_SPAN / count));
  return i < 0 ? 0 : i > count - 1 ? count - 1 : i;
}

/** The chapter's current scroll-driven step, or null when scroll is not
 *  driving it (flat mode, or another chapter is on screen). */
export function useScrollStep(id: ChapterId): number | null {
  const current = useChapterStep();
  const index = CHAPTERS.findIndex((c) => c.id === id);
  return current && current.chapter === index ? current.step : null;
}

/** The story position at the middle of a step's band — where that step is
 *  fully "on". Falls back to the chapter itself for a chapter with no steps. */
export function stepProgress(chapter: number, step: number): number {
  const count = COUNT_BY_INDEX[chapter] ?? 0;
  return count ? chapter + ((step + 0.5) * BAND_SPAN) / count : chapter;
}

/** Scrolls to the middle of `step`'s band. Returns false in flat mode, where
 *  there is nothing to scroll and the caller must set its own state. */
export function seekStep(id: ChapterId, step: number): boolean {
  const conductor = getConductor();
  if (!conductor) return false;
  const index = CHAPTERS.findIndex((c) => c.id === id);
  if (index < 0 || !COUNT_BY_INDEX[index]) return false;
  conductor.seek(stepProgress(index, step));
  return true;
}
