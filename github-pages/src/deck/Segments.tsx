// Replaces source L816-824's imperative `.segments` builder (which appends
// 16 `<i>` children, IIFE, once per `.segments` host on load) with a
// declarative 16-bar meter. `data-value`/`data-tone`/`data-live` are kept on
// the host for DOM parity with the source markup even though nothing reads
// them back at runtime here — Phase 6's QA harness diffs against them.

import type { CSSProperties } from 'react';
import { TONES } from './data';
import type { ToneName } from './data';

export interface SegmentsProps {
  /** Authored `data-value` attribute — the source only ever sets this once,
   *  at build time; it is never rewritten by the live tick (setSegments only
   *  ever mutates each `<i>`'s className, L825-831), so it stays a fixed
   *  prop here too. */
  value: number;
  /** How many of the 16 bars render with `className="on"`. */
  lit: number;
  tone: ToneName;
  /** Authored `data-live` attribute. Segments the tick actually drives pass
   *  their store key here; segments the tick never targets (e.g. the "5H
   *  USAGE" metric, whose `data-live="use"` source markup is vestigial —
   *  nothing in the tick reads `[data-live="use"]`) can still carry the
   *  attribute for DOM parity without being wired to the store. */
  dataLive?: string;
}

export function Segments({ value, lit, tone, dataLive }: SegmentsProps) {
  return (
    <div
      className="segments"
      data-value={value}
      data-tone={tone}
      data-live={dataLive}
      style={{ '--tone': TONES[tone] } as CSSProperties}
    >
      {Array.from({ length: 16 }, (_, i) => (
        <i key={i} className={i < lit ? 'on' : undefined} />
      ))}
    </div>
  );
}
