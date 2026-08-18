// Index-aligned element registries for the 7 chapters.
//
// The world needs `panels: HTMLElement[]` (the <section class="chapter"> nodes
// it adopts as CSS3DObjects) and `spacers: HTMLElement[]` (the wrappers the
// conductor measures), both in CHAPTERS order.

import { useCallback, useMemo, useRef } from 'react';
import { CHAPTERS } from '../config/chapters';
import type { ChapterId } from '../config/chapters';

export interface ElementRegistry {
  /** Stable per chapter id — created once, so React never detaches/reattaches
   *  on re-render (a fresh ref callback each render would null the entry and
   *  re-set it on every commit). */
  refs: Record<ChapterId, (el: HTMLElement | null) => void>;
  /** Index-aligned with CHAPTERS. Throws if the contract was violated. */
  ordered: () => HTMLElement[];
}

export function useElementRegistry(): ElementRegistry {
  const map = useRef<Map<ChapterId, HTMLElement>>(null as unknown as Map<ChapterId, HTMLElement>);
  map.current ??= new Map();

  const refs = useMemo(() => {
    const out = {} as Record<ChapterId, (el: HTMLElement | null) => void>;
    for (const c of CHAPTERS) {
      out[c.id] = (el: HTMLElement | null) => {
        if (el) map.current.set(c.id, el);
        else map.current.delete(c.id);
      };
    }
    return out;
  }, []);

  // NOT safe to call during render, nor from a layout effect that runs before
  // <Chapters/> has committed. React attaches refs and runs layout effects in a
  // single tree-order pass, so a component EARLIER in the tree (which is where
  // <ThreeWorld/> sits, matching the source's body order) has its layout effect
  // invoked before a LATER sibling's refs exist. App therefore defers mounting
  // <ThreeWorld/> by one commit — see the `registriesReady` flag there.
  //
  // Call this ONCE, at world construction, and let the world hold the array.
  // destroy() must never re-read the registry — React 19 detaches refs in the
  // same mutation phase as layout-effect cleanups, and the ordering between an
  // unrelated sibling's cleanup and a child's ref detach is not contractual.
  const ordered = useCallback(
    () =>
      CHAPTERS.map((c) => {
        const el = map.current.get(c.id);
        if (!el) throw new Error(`[registry] chapter "${c.id}" never registered — see Spacer.tsx PANEL DOM CONTRACT`);
        return el;
      }),
    [],
  );

  return { refs, ordered };
}
