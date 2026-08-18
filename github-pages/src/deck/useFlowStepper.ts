// Source L985-1004 — the 5-step workflow stepper with 4200ms autoplay.

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { REDUCED_MOTION } from '../lib/env';
import { useConductor } from '../state/appStore';
import { seekStep, useScrollStep } from './useScrollStep';
import { flowData } from './data';
import type { FlowStep } from './data';

const AUTOPLAY_MS = 4200;
const INITIAL_INDEX = 2; // source L986: `let flowIndex = 2`

// Module-level seam for the source's `updateDom` side effect at L1451:
//   if (c.id === 'tasks' && !RM) { showFlow(0, true); }
// The world calls onChapter(index); App translates that into requestFlowReset()
// so src/world/ never has to import deck code. Mirrors renderTerminal(), which
// is module-level imperative for the same reason (L1450).
let resetToken = 0;
const resetListeners = new Set<() => void>();
export function requestFlowReset(): void {
  if (REDUCED_MOTION) return; // source L1451 gates on `&& !RM`
  resetToken += 1;
  resetListeners.forEach((cb) => cb());
}
function subscribeFlowReset(cb: () => void): () => void {
  resetListeners.add(cb);
  return () => resetListeners.delete(cb);
}

export interface UseFlowStepperResult {
  index: number;
  step: FlowStep;
  show: (index: number, user?: boolean) => void;
}

export function useFlowStepper(): UseFlowStepperResult {
  const [index, setIndex] = useState(INITIAL_INDEX);
  // Bumped only by a *user* click (source L998-1001: `clearInterval(flowTimer);
  // flowTimer = setInterval(...)`) so the effect below re-arms the autoplay
  // timer on a click but NOT when autoplay advances itself.
  const [armToken, setArmToken] = useState(0);

  // In 3D the reader's scroll position picks the step (see useScrollStep):
  // one band of the tasks chapter's local progress per stage. A live
  // conductor is exactly the "scroll is driving this" test.
  const scrollDriven = useConductor() !== null;
  const scrollStep = useScrollStep('tasks');
  useEffect(() => {
    if (scrollStep !== null) setIndex(scrollStep);
  }, [scrollStep]);

  const show = useCallback((next: number, user = false) => {
    // Scroll owns the step in 3D, so a click scrolls to that stage's band and
    // the effect above applies it. seekStep is false in flat mode.
    if (!seekStep('tasks', next)) setIndex(next);
    if (user && !REDUCED_MOTION) setArmToken((t) => t + 1);
  }, []);

  // Chapter-change reset: the source's showFlow(0, true) — index 0, and `true`
  // means it re-arms the autoplay window from this moment, same as a click.
  const externalReset = useSyncExternalStore(
    subscribeFlowReset,
    () => resetToken,
    () => 0,
  );
  useEffect(() => {
    if (externalReset === 0) return; // no reset requested yet
    // Scroll-driven: entering the chapter already puts the reader in band 0,
    // and calling show() here would scroll the page out from under them.
    if (scrollDriven) return;
    show(0, true);
  }, [externalReset, scrollDriven, show]);

  useEffect(() => {
    // Autoplay is the flat-mode driver only — under scroll it would advance
    // past the reader's band and get yanked back at the next crossing.
    if (REDUCED_MOTION || scrollDriven) return; // source L1004: `if (!RM) flowTimer = setInterval(...)`
    const id = window.setInterval(() => {
      setIndex((current) => (current + 1) % flowData.length);
    }, AUTOPLAY_MS);
    return () => window.clearInterval(id);
  }, [armToken, scrollDriven]);

  return { index, step: flowData[index], show };
}
