// Cross-layer contract between the flat React deck (src/deck/) and the
// Three.js world (src/world/, Phase 4) + the mode state machine (Phase 5).
//
// Intentionally tiny: a few module-level values with useSyncExternalStore
// subscribers, written from outside React entirely (the world's render loop,
// its resize handler, the conductor's chapter-change callback) and read by
// React components that need to react to them. No Redux, no context
// provider — a context provider would require the writers to be inside the
// React tree, and the world's render loop is not.

import { useSyncExternalStore } from 'react';

export interface Conductor {
  goTo(index: number): void;
}

type Listener = () => void;

function createSignal<T>(initial: T) {
  let value = initial;
  const listeners = new Set<Listener>();
  return {
    get: (): T => value,
    set: (next: T): void => {
      value = next;
      listeners.forEach((cb) => cb());
    },
    subscribe: (cb: Listener): (() => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}

// Set by the world on chapter change (its onChapterChange callback, source
// updateDom()). `null` before the world starts and forever in flat mode.
const chapterIndexSignal = createSignal<number | null>(null);
export const setChapterIndex = chapterIndexSignal.set;
export const getChapterIndex = chapterIndexSignal.get;
export const subscribeChapterIndex = chapterIndexSignal.subscribe;
export function useChapterIndex(): number | null {
  return useSyncExternalStore(subscribeChapterIndex, getChapterIndex);
}

// Registered by the world once the scroll conductor is running. `null` in
// flat mode, which is exactly what makes rail buttons inert there — callers
// mirror the source's `conductor && conductor.goTo(i)` guard (L1032).
const conductorSignal = createSignal<Conductor | null>(null);
export const setConductor = conductorSignal.set;
export const getConductor = conductorSignal.get;
export const subscribeConductor = conductorSignal.subscribe;
export function useConductor(): Conductor | null {
  return useSyncExternalStore(subscribeConductor, getConductor);
}

// Fired by the world at the end of buildPanels() and onResize() — the two
// places the source calls drawChart() directly (L1487, L1599). Required,
// not belt-and-braces: buildPanels() resizes the fleet control section from
// viewport-wide to a fixed 1460px panel with no window `resize` event, so
// without this signal the usage chart would size itself for the flat layout
// forever. `useUsageChart` subscribes to this AND to window `resize` — the
// latter is what covers flat mode, where nothing ever calls emitRelayout().
const relayoutListeners = new Set<Listener>();
export function emitRelayout(): void {
  relayoutListeners.forEach((cb) => cb());
}
export function onRelayout(cb: Listener): () => void {
  relayoutListeners.add(cb);
  return () => relayoutListeners.delete(cb);
}
