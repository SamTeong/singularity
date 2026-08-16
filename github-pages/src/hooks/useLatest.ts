import { useRef } from 'react';
import type { RefObject } from 'react';

/**
 * Returns a ref that always holds the most recent `value`, without ever
 * changing identity. Lets an effect with a narrow dependency array (e.g. the
 * 260ms telemetry tick in `src/deck/useTelemetryEngine.ts`, which must only
 * depend on `[REDUCED_MOTION]`) read a value that changes on every render —
 * a tab selection, a prop — without tearing down and restarting the effect
 * whenever that value changes.
 *
 * Mutating `ref.current` during render (not inside an effect) is safe here:
 * refs never trigger re-renders, so this can't cause a render loop, and the
 * ref is guaranteed to be current by the time any effect or event handler
 * reads it.
 */
export function useLatest<T>(value: T): RefObject<T> {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}
