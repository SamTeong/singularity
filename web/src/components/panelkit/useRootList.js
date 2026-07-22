import { useState, useEffect, useMemo, useCallback } from 'react';
import { tildify } from '@/lib/paths.js';

// Normalized key (tildified, forward-slashed, lowercased) so `~` and its
// expanded home path, or `/` vs `\`, collapse to one entry.
export const normKey = (p) => tildify(p).replace(/\\/g, '/').toLowerCase();

// FS-persisted root-folder list shared by the multi-root panels (Config, Hooks,
// Rules, Skills). Owns the MRU list at `${base}/roots` plus the dedupe+alpha-sort
// for display. `roots` is raw MRU order (what we persist); `shownRoots` is the
// deduped, alphabetically-sorted view the UI renders. `loaded` flips true once
// the initial fetch settles (Skills gates its skills fetch on it).
export function useRootList(base, { initial = [] } = {}) {
  const [roots, setRoots] = useState(initial);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    fetch(`${base}/roots`).then((r) => r.json())
      .then((d) => { if (d.roots?.length) setRoots(d.roots); })
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, [base]);

  const persist = useCallback((next) => {
    fetch(`${base}/roots`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roots: next }),
    }).catch(() => {});
  }, [base]);

  // Merge paths in MRU-first, dedupe, cap 50, persist.
  const remember = useCallback((paths) => setRoots((prev) => {
    const next = [...new Set([...paths, ...prev])].slice(0, 50);
    persist(next);
    return next;
  }), [persist]);

  // Drop a path (matched on normKey so collapsed variants all go), persist.
  const forget = useCallback((p) => setRoots((prev) => {
    const next = prev.filter((x) => normKey(x) !== normKey(p));
    persist(next);
    return next;
  }), [persist]);

  const shownRoots = useMemo(() => [...new Map(
    roots.map((p) => [normKey(p), p]),
  ).values()].sort((a, b) => normKey(a).localeCompare(normKey(b))), [roots]);

  return { roots, shownRoots, remember, forget, loaded };
}
