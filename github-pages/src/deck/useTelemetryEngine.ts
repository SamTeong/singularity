// Source L1538-1579 — the 4Hz (260ms) mechanical pulse that makes the
// cockpit read as a live console instead of a screenshot.

import { useEffect } from 'react';
import type { RefObject } from 'react';
import { REDUCED_MOTION } from '../lib/env';
import { clamp } from '../lib/math';
import { useLatest } from '../hooks/useLatest';
import { setTelemetry } from './telemetry';
import { pushTerm } from './useTerminal';
import { pushChartSample } from './chartData';
import { liveRows } from './data';
import type { CockpitView } from './useTabs';

interface TelemetryEngineOptions {
  /** Ref to the `<section id="control">` DOM node — see the guard below. */
  sectionRef: RefObject<HTMLElement | null>;
  /** Currently active console tab; read through a ref so it never restarts
   *  this effect (see the dependency-array note below). */
  view: CockpitView;
}

export function useTelemetryEngine({ sectionRef, view }: TelemetryEngineOptions): void {
  // `view` (and, before this existed, `sessionsVisible`/`usageVisible`)
  // must NOT be a dependency of the interval effect below: restarting the
  // interval on every tab click would reset both its 260ms phase and
  // `tickN`, and `tickN` drives the sin() waveforms and the `% 3` terminal
  // cadence. useLatest lets the tick read the current tab without the
  // effect depending on it.
  const viewRef = useLatest(view);

  useEffect(() => {
    if (REDUCED_MOTION) return; // source L1550: `if (!RM) setInterval(...)`

    let tickN = 0;
    let tokens = 418.2;
    let usd = 4.18;
    let turns = 11;
    let today = 18.42;

    const id = window.setInterval(() => {
      // `#control`'s inline `style.display` is the exact property Phase 4's
      // culling loop writes every frame once the cockpit section is mounted
      // as a CSS3DObject (source L1423, `panel.el.style.display = on ? '' :
      // 'none'`) — reading it here is how the tick learns to stop while the
      // panel is off-screen. Read through a ref to the real node, and via
      // the inline `style` property specifically: getComputedStyle would
      // force a layout 4x/sec and, more importantly, is not the property
      // Phase 4 actually writes. Cross-layer dependency: do not change what
      // Phase 4 writes without updating this read, and vice versa.
      const cockpit = sectionRef.current;
      if (!cockpit || cockpit.style.display === 'none') return;
      tickN++;

      const cpu = clamp(Math.round(34 + Math.sin(tickN / 7) * 15 + (Math.random() - 0.5) * 8), 5, 97);
      const mem = clamp(Math.round(61 + Math.sin(tickN / 11) * 9 + (Math.random() - 0.5) * 4), 12, 96);
      const ctx = clamp(Math.round(42 + Math.sin(tickN / 17) * 11), 8, 99);

      tokens += Math.random() * 1.4;
      usd += Math.random() * 0.012;
      if (Math.random() < 0.07) turns++;
      today += 0.011;
      const tpm = 0.8 + Math.random() * 1.6;

      setTelemetry({ cpu, mem, ctx, tokens, usd, turns, today, tpm });

      // Source: `if (tickN % 3 === 0 && !$('#view-sessions').hidden)`.
      if (tickN % 3 === 0 && viewRef.current === 'sessions') {
        const [kind, text] = liveRows[(Math.random() * liveRows.length) | 0];
        pushTerm(kind, text);
      }

      // Unconditional every tick, exactly like the source (L1576-1577) —
      // only the draw is gated on visibility, inside useUsageChart.
      pushChartSample();
    }, 260);

    return () => window.clearInterval(id);
    // Dependency array is `[REDUCED_MOTION]` ONLY — not `sectionRef`, not
    // `view`/`viewRef`. `sectionRef` and `viewRef` are ref objects with
    // stable identity across renders (read only via `.current` inside the
    // interval callback), so they need no entry; REDUCED_MOTION is a
    // load-time constant that never changes after mount, so listing it never
    // actually re-runs this effect — it exists only so a future edit that
    // makes reduced-motion reactive doesn't silently leave a stale interval
    // running. Adding `sessionsVisible`/`usageVisible`-style values here
    // would tear down and recreate the timer on every tab click, resetting
    // both its 260ms phase and `tickN` — which drives the sin() waveforms
    // and the `% 3` terminal cadence. sectionRef/viewRef are refs read only
    // via `.current`; listing them would suggest they belong in the "things
    // that restart this effect" category, which is exactly what must never
    // happen here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [REDUCED_MOTION]);
}
