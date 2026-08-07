import { useEffect, useRef } from 'react';

// Refresh-on-focus for the non-Explorer CodeMirror panels. Mirrors
// ExplorerPanel's focus listener (L139-149): on window focus, re-read the open
// file; if mtime is unchanged no-op; if the editor is dirty warn ("Changed on
// disk — saving will ask before overwriting"); else reload content + mtime and
// announce "Reloaded from disk".
//
// `refetch`/`onChanged`/`onWarn` close over panel state at the call site, so a
// ref holds the latest snapshot and the listener registers ONCE per `enabled`
// transition (effect keyed on `enabled`) — the closure never goes stale the
// way a fresh add-remove-every-render handler would.
//
// Back-compat: a read response missing `mtime` (old daemon) is null, and
// `null === null` short-circuits the reload, so the hook no-ops safely.
export function useRefreshOnFocus({ enabled, mtime, dirty, refetch, onChanged, onWarn }) {
  const ref = useRef({ enabled, mtime, dirty, refetch, onChanged, onWarn });
  useEffect(() => { ref.current = { enabled, mtime, dirty, refetch, onChanged, onWarn }; });
  useEffect(() => {
    if (!enabled) return undefined;
    const onFocus = async () => {
      const s = ref.current;
      if (!s.enabled) return;
      let d;
      try { d = await s.refetch(); } catch { return; }
      if (!d || !d.ok) return;
      if (d.mtime === s.mtime) return;
      if (s.dirty) { s.onWarn(); return; }
      s.onChanged(d.content, d.mtime);
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [enabled]);
}