// The pipeline gallery's artefact viewer.
//
// This is a store, and the viewer itself is app-level chrome (see
// components/chrome/Lightbox.tsx), for one hard reason: the source renders the
// lightbox inside the chapter, as `position:fixed`. A fixed element inside a
// CSS3D-transformed subtree does NOT resolve against the viewport — any
// ancestor with a transform becomes its containing block — so an in-chapter
// lightbox would be painted into the 3D panel, scaled to ~0.004 and rotated
// with it. Mounting it as a sibling of <Deck/> keeps it a real viewport modal
// in both flat and 3D mode, and the in-panel cards only ever dispatch to here.

import { useSyncExternalStore } from 'react';
import { PIPELINE_STEPS } from './pipelineData';

export interface LightboxState {
  open: boolean;
  step: number;
  item: number;
}

const CLOSED: LightboxState = { open: false, step: 0, item: 0 };

let state: LightboxState = CLOSED;
const listeners = new Set<() => void>();

function set(next: LightboxState): void {
  state = next;
  listeners.forEach((cb) => cb());
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

const getState = (): LightboxState => state;

/** Scroll lock while the viewer is up. In 3D that also parks the camera, which
 *  is the intent — the reader is inspecting an artefact, not touring. */
function lockScroll(locked: boolean): void {
  document.body.style.overflow = locked ? 'hidden' : '';
}

export function openLightbox(step: number, item: number): void {
  if (!PIPELINE_STEPS[step]?.items[item]) return;
  lockScroll(true);
  set({ open: true, step, item });
}

export function closeLightbox(): void {
  if (!state.open) return;
  lockScroll(false);
  set(CLOSED);
}

/** Wraps within the current stage's items, like the source's stepLightbox(). */
export function stepLightbox(delta: number): void {
  if (!state.open) return;
  const items = PIPELINE_STEPS[state.step]?.items ?? [];
  if (!items.length) return;
  const next = ((state.item + delta) % items.length + items.length) % items.length;
  set({ ...state, item: next });
}

export function useLightbox(): LightboxState {
  return useSyncExternalStore(subscribe, getState, getState);
}
