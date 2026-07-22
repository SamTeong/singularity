import { useEffect, useState } from 'react';

// Singleton /capabilities fetch shared by all panels. Module-level cache so
// the endpoint is hit once per page load; later mounts reuse the result.
// Returns null while loading / on failure (panels treat null as "available"
// so a fetch glitch never hides a working feature — only an explicit
// available:false surfaces a hint).
let cache = null;
let promise = null;

export function useCapabilities() {
  const [caps, setCaps] = useState(cache);
  useEffect(() => {
    if (cache) { setCaps(cache); return; }
    if (!promise) {
      promise = fetch('/capabilities')
        .then((r) => r.json())
        .then((d) => { cache = d; return d; })
        .catch(() => null);
    }
    promise.then(setCaps);
  }, []);
  return caps;
}