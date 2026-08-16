// The `.metric` / `.metric-row` / `.segments` triple, source L825-831 (the
// live update path, `setSegments`) plus the markup it targets.

import { Segments } from './Segments';
import { useTelemetryField } from './telemetry';
import type { ToneName } from './data';

export interface MetricProps {
  label: string;
  /** Authored percentage shown before the first tick (and forever, under
   *  reduced motion, since the tick that would otherwise replace it never
   *  runs — source L1550: `if (!RM) setInterval(...)`). */
  pct: number;
  /** Authored lit-segment count. Deliberately NOT derived from `pct` — the
   *  source pairs CONTEXT 42% with 8/16 segments lit (50%, not 42%), and
   *  that mismatch is intentional in the design, not a bug to "fix" by
   *  computing `Math.round(pct / 100 * 16)`. */
  seg: number;
  tone: ToneName;
  /** Ties this metric to the live 260ms tick (telemetry.ts). Omit for
   *  metrics the tick never targets, which stay on their authored `pct`/`seg`
   *  forever (e.g. "5H USAGE", "CLAUDE · 5H", "OLLAMA · 7D"). */
  liveKey?: 'cpu' | 'mem' | 'ctx';
  /** Authored `data-live` attribute on the `.segments` host, for DOM parity.
   *  Defaults to `liveKey` when omitted; pass explicitly (e.g. `"use"`) for
   *  a metric whose markup carries `data-live` but that the tick never
   *  actually targets. */
  dataLive?: string;
}

export function Metric({ label, pct, seg, tone, liveKey, dataLive }: MetricProps) {
  const live = useTelemetryField(liveKey);
  const displayPct = live !== null ? Math.round(live) : pct;
  // Once the tick has run at least once, `lit` IS derived from the live
  // percentage (source L827: `Math.round(pct / 100 * n)`) — only the
  // pre-tick / reduced-motion fallback keeps the authored, non-derived `seg`.
  const lit = live !== null ? Math.round((live / 100) * 16) : seg;

  return (
    <div className="metric">
      <div className="metric-row">
        <span>{label}</span>
        <b>{displayPct}%</b>
      </div>
      <Segments value={seg} lit={lit} tone={tone} dataLive={dataLive ?? liveKey} />
    </div>
  );
}
