import { useEffect, useState } from 'react';

// Counter bumped on window focus. Panels add it to their list-loading effect's
// deps so files deleted or added on disk while the tab was away drop out of /
// into the sidebar — useRefreshOnFocus only reloads the OPEN file, leaving the
// list stale until a page reload.
export function useFocusTick() {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const onFocus = () => setTick((t) => t + 1);
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);
  return tick;
}
