// Source L985-1004 — the 5-step workflow stepper with 4200ms autoplay.

import { useCallback, useEffect, useState } from 'react';
import { REDUCED_MOTION } from '../lib/env';
import { flowData } from './data';
import type { FlowStep } from './data';

const AUTOPLAY_MS = 4200;
const INITIAL_INDEX = 2; // source L986: `let flowIndex = 2`

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

  const show = useCallback((next: number, user = false) => {
    setIndex(next);
    if (user && !REDUCED_MOTION) setArmToken((t) => t + 1);
  }, []);

  useEffect(() => {
    if (REDUCED_MOTION) return; // source L1004: `if (!RM) flowTimer = setInterval(...)`
    const id = window.setInterval(() => {
      setIndex((current) => (current + 1) % flowData.length);
    }, AUTOPLAY_MS);
    return () => window.clearInterval(id);
  }, [armToken]);

  return { index, step: flowData[index], show };
}
