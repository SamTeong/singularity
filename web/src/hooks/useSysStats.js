import { useEffect, useState } from 'react';

/**
 * Machine CPU/RAM readout. Polls `/sysstats` every 2s only while `enabled`
 * (the More menu is open) so the daemon isn't sampling the host continuously.
 *
 * @param {boolean} enabled poll only while true
 * @returns {object|null} latest `{ cpu, mem, history }` snapshot, or null
 */
export function useSysStats(enabled) {
  const [sysStats, setSysStats] = useState(null);
  useEffect(() => {
    if (!enabled) return undefined;
    const pull = () => fetch('/sysstats').then((r) => r.json()).then(setSysStats).catch(() => {});
    pull();
    const id = setInterval(pull, 2000);
    return () => clearInterval(id);
  }, [enabled]);
  return sysStats;
}
