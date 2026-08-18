// Which of the five pipeline stages is selected.
//
// A module-level store rather than component state, for the same reason
// useTerminal.ts is one: the writer that matters most is NOT in the React tree.
// The scroll conductor drives this. App.tsx's onFrame — which runs at 60fps and
// may never call setState — feeds `driveFromScroll(smooth)` every frame, and
// this module notifies subscribers only when the integer stage actually
// changes. That is roughly five notifications per traversal, not sixty a
// second.
//
// Why scroll-drive it at all: the source one-shot is a flat page where clicking
// a stage is the only interaction. Here the chapter is a CSS3D panel, and
// Chromium hit-tests scaled CSS3D subtrees inconsistently (see the note in
// styles/chrome.css) — so a click-only control can be dead on arrival in 3D.
// Scroll is the one input that always works, so scroll owns the stage and
// clicking is an override. A click stands until the reader scrolls into a
// different bucket, at which point the conductor takes it back.

import { useSyncExternalStore } from 'react';
import { clamp } from '../lib/math';
import { PIPELINE_STEPS } from './pipelineData';

const COUNT = PIPELINE_STEPS.length;

/** Half-width, in chapters, of the scroll window mapped onto the five stages.
 *  0.45 means the sweep runs from 0.45 chapters before the pipeline waypoint
 *  to 0.45 after it, so stage 03 — the middle one — is showing exactly when
 *  the camera is parked square-on and the panel is at full opacity. */
const WINDOW = 0.45;

let stage = 0;
let bucket = -1;
const listeners = new Set<() => void>();

function notify(): void {
  listeners.forEach((cb) => cb());
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

const getStage = (): number => stage;

/** Called from the render loop with the conductor's smoothed progress and the
 *  pipeline chapter's index. No-op unless the bucket changed. */
export function driveFromScroll(smooth: number, chapterIndex: number): void {
  const t = clamp((smooth - (chapterIndex - WINDOW)) / (WINDOW * 2), 0, 1);
  const next = Math.min(COUNT - 1, Math.floor(t * COUNT));
  if (next === bucket) return;
  bucket = next;
  if (next === stage) return;
  stage = next;
  notify();
}

/** Click / keyboard override. Deliberately does NOT touch `bucket`, so the
 *  next bucket the reader scrolls into hands control back to the conductor. */
export function selectStage(next: number): void {
  const clamped = clamp(Math.round(next), 0, COUNT - 1);
  if (clamped === stage) return;
  stage = clamped;
  notify();
}

/** Flat mode and teardown: nothing is driving scroll any more. */
export function resetStage(): void {
  bucket = -1;
  if (stage === 0) return;
  stage = 0;
  notify();
}

export function usePipelineStage(): number {
  return useSyncExternalStore(subscribe, getStage, getStage);
}
