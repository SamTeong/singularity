// React lifecycle owner for the imperative Three.js world. Renders a single
// empty, world-owned stage div — createWorld.ts creates the #gl canvas and
// #css3d host inside it (see types.ts's WorldOptions.stage doc).
//
// Three.js is reached only through a dynamic import() so flat mode (no
// <ThreeWorld/> mounted — App gates on NARROW/no-WebGL2 before this component
// ever renders) never downloads ~600 KB of Three.js.
import { useLayoutEffect, useRef } from 'react';
import { CHAPTERS } from '../config/chapters';
import { restoreScroll } from '../app/scrollRestore';
import { guardPanelContract } from '../deck/panelContractGuard';
import { applyBeatHeights, clearBeatHeights } from './beatLayout';
import type { World, WorldOptions } from './types';

export interface ThreeWorldProps extends Omit<WorldOptions, 'stage' | 'beats' | 'panels'> {
  /** Getters, not arrays: the registries are populated by ref callbacks during
   *  the SAME commit that renders this component, so the arrays do not exist
   *  yet at render time. React attaches every ref in a commit before running
   *  any effect in that commit, so calling these from the layout effect below
   *  is safe and has no mount-order coupling with <Deck/>. */
  getBeats: () => HTMLElement[];
  getPanels: () => HTMLElement[];
  /** Fires once the World instance exists, before boot() is called — lets the
   *  owner wire the chapter rail's onClick to world.goTo(). */
  onReady?: (world: World) => void;
}

const WEIGHTS = CHAPTERS.map((c) => c.weight);

export function ThreeWorld(props: ThreeWorldProps) {
  const stageRef = useRef<HTMLDivElement | null>(null);

  // Mount-once bridge to the imperative world. `props` is captured from the
  // closure in scope when this effect body runs (i.e. at mount) and never
  // re-read afterward — re-running on every prop change would tear down and
  // rebuild the whole 3D world for no reason. The owner must pass stable
  // callback references (useCallback / module-level functions), not fresh
  // closures every render.
  //
  // Runs in useLayoutEffect, not useEffect: destroy() must run from the
  // cleanup of a layout effect so it executes in React's mutation phase,
  // before `removeChild` of this stage div — a passive effect's cleanup
  // runs after the DOM is already gone.
  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;

    const beats = props.getBeats();
    const panels = props.getPanels();

    // Captured ONCE, here. destroy() must never re-read the registry: React 19
    // detaches refs in the same mutation phase as layout-effect cleanups, and
    // the ordering between an unrelated sibling's cleanup and a child's ref
    // detach is not contractual.

    // Optimistic boot (source L1664: sizeBeats() runs BEFORE boot()). The
    // document claims its full scroll length while the 11.5MB model downloads,
    // so a mid-page reload can restore the reader's position. Without this the
    // page is at flat height for the whole download and the browser scrolls to
    // the top. fail()/restoreDom() unwind it.
    applyBeatHeights(beats, WEIGHTS, window.innerHeight);
    // The document now has its final height, so a saved offset can actually be
    // applied. Must be here — before boot(), and therefore long before
    // conductor.start() seeds itself from the live scrollY.
    restoreScroll();

    const isMoving = { current: false };
    const unguard = guardPanelContract(panels, isMoving);

    let alive = true;
    let world: World | null = null;

    (async () => {
      try {
        const { createWorld } = await import('./createWorld');
        if (!alive) return;
        world = createWorld({ stage, beats, panels, ...props });
        props.onReady?.(world);
        world.boot();
      } catch (err) {
        console.error('[ThreeWorld] failed to load the world module', err);
        props.onFail('WORLD MODULE FAILED TO LOAD', { showError: true });
      }
    })();

    return () => {
      alive = false;
      isMoving.current = true; // the world's own DOM restoration is legitimate
      world?.destroy();
      world = null;
      unguard();
      // Covers the case where the world was never created (unmounted during
      // the dynamic import) and therefore never ran restoreDom().
      clearBeatHeights(beats);
    };
    // Deliberately empty: this effect is a mount-once bridge (see comment
    // above), not a reaction to `props`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div ref={stageRef} className="sx-stage" />;
}
