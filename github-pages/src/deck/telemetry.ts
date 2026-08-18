// Shared telemetry store. `useTelemetryEngine` (mounted once, in FleetControl) is
// the sole writer; leaf components (Metric, the three live spans, #usdToday,
// #tpmValue) are readers via `useTelemetryField`, subscribed individually so
// a tick re-renders ~7 tiny components instead of the whole console.
//
// Every field seeds to `null`, not the authored literal. That's deliberate
// (see Metric.tsx): the authored markup pairs CONTEXT 42% with 8/16 lit
// segments, a mismatch that a `pct`-derived seed would silently erase, and
// under reduced motion the tick that would populate these fields never runs
// at all (source L1550: `if (!RM) setInterval(...)`) — so `null` has to be a
// legitimate, permanent value here, not just a transient loading state.

import { useSyncExternalStore } from 'react';

export interface TelemetrySnapshot {
  cpu: number | null;
  mem: number | null;
  ctx: number | null;
  tokens: number | null;
  usd: number | null;
  turns: number | null;
  today: number | null;
  tpm: number | null;
}

const EMPTY: TelemetrySnapshot = {
  cpu: null,
  mem: null,
  ctx: null,
  tokens: null,
  usd: null,
  turns: null,
  today: null,
  tpm: null,
};

let snapshot: TelemetrySnapshot = EMPTY;
const listeners = new Set<() => void>();

export function getTelemetrySnapshot(): TelemetrySnapshot {
  return snapshot;
}

export function subscribeTelemetry(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function setTelemetry(patch: Partial<TelemetrySnapshot>): void {
  snapshot = { ...snapshot, ...patch };
  listeners.forEach((cb) => cb());
}

export function useTelemetryField<K extends keyof TelemetrySnapshot>(key?: K): TelemetrySnapshot[K] | null {
  return useSyncExternalStore(subscribeTelemetry, () => (key ? getTelemetrySnapshot()[key] : null));
}
