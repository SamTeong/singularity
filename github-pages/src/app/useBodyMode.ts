// The three body-level mode classes the stylesheet keys off:
//
//   body.mode-3d   3D walkthrough active. Its ABSENCE is the flat fallback —
//                  `body:not(.mode-3d)` (chrome.css) hides #gl, #css3d, .sx-hud,
//                  .sx-rail, .sx-readout and .sx-hint.
//   body.booting   model still loading; hides `#scroll .chapter` so the deck
//                  does not flash before the panels are mounted.
//   body.dbg       `?debug`; shows .sx-dbg and hides .sx-rail.
//
// Ported from source L808 (fail), L1583-1585 (enter3D) and L1663 (bootstrap).

import { useLayoutEffect } from 'react';
import { DEBUG } from '../lib/env';
import type { Mode } from '../world/types';

export function useBodyMode(mode: Mode): void {
  // A layout effect, so the classes are applied before paint and — critically —
  // before flushSync(setMode) returns to the world. buildPanels() measures
  // offsetHeight immediately after setMode('3d'), and `.chapter.as-panel`
  // changes padding/overflow/flex while `body.booting` changes visibility;
  // measuring under the wrong class state silently corrupts every panel's
  // worldH, which propagates through framingDistance() into every waypoint.
  useLayoutEffect(() => {
    const b = document.body.classList;
    // One atomic commit. The source flips mode-3d on and booting off in two
    // sequential classList calls (L1583-1584); doing both here removes the
    // intermediate frame where neither is correct.
    b.toggle('booting', mode === 'loading');
    b.toggle('mode-3d', mode === '3d');
    b.toggle('dbg', DEBUG && mode === '3d');
    return () => b.remove('booting', 'mode-3d', 'dbg');
  }, [mode]);
}
