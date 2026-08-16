// Source L1542, L1544-1548. Unconditional 1Hz clock — unlike the 260ms
// telemetry tick, this interval sits outside the `if (!RM)` guard in the
// source, so it must keep running under reduced motion too.

import { useEffect, useState } from 'react';
import { pad } from '../lib/math';

const SEED_SECONDS = 2 * 3600 + 41 * 60 + 9; // matches the authored "02:41:09"

function format(totalSeconds: number): string {
  return pad(Math.floor(totalSeconds / 3600)) + ':' + pad(Math.floor(totalSeconds / 60) % 60) + ':' + pad(totalSeconds % 60);
}

export function useUptime(): string {
  const [display, setDisplay] = useState(() => format(SEED_SECONDS));

  useEffect(() => {
    let up = SEED_SECONDS;
    const id = window.setInterval(() => {
      up++;
      setDisplay(format(up));
    }, 1000);
    return () => window.clearInterval(id);
  }, []);

  return display;
}
