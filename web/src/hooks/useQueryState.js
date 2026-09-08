import { useCallback, useEffect, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';

/**
 * Apply a patch object to a URLSearchParams, returning a new one.
 * `null`/`undefined`/`''` deletes the key (a param equal to its default is
 * absent, not `?tags=`); an array writes repeated params — never CSV, since
 * task tags and cwd paths can both contain commas — sorted, so the same filter
 * set always produces byte-identical URLs.
 * Exported for its unit test; components go through the hooks below.
 */
export function queryPatch(params, patch) {
  const next = new URLSearchParams(params);
  for (const [k, v] of Object.entries(patch)) {
    next.delete(k);
    if (v == null || v === '') continue;
    if (Array.isArray(v)) [...v].sort().forEach((x) => next.append(k, x));
    else next.set(k, String(v));
  }
  return next;
}

// Shared across every useUpdateQuery instance in the app (module scope, not a
// React ref — the whole point is that it survives across independent hook
// instances/components within one synchronous tick). React Router's own
// `setSearchParams((prev) => ...)` computes `prev` from the router's location
// state, which only refreshes on render — so two patches issued in the same
// tick (even from two different useQueryState/useQueryList call sites) both
// read the same pre-tick snapshot and the first write is lost. This is the
// project's documented gotcha (e.g. transcripts.spec.mjs's intermittent
// `setScope('one')` loss). Every write updates this immediately, before
// React Router's own state has caught up; an effect refreshes it from the
// live params on every render, so back/forward navigation and updates from
// elsewhere can't leave it stale (a plain module reassignment during render
// is a side effect React's rules disallow — the effect is the correct seam).
// Keyed by pathname: that effect only resyncs after the render commits, so a
// patch issued before it runs on a freshly navigated route would otherwise
// base itself on the PREVIOUS route's params and copy them into the new URL.
// No consumer patches from a mount effect today, but nothing stops one, and
// the batching this exists for is always same-route — so the key costs nothing.
let lastWritten = null; // { path, params }

/**
 * The param set a patch should build on: the last written one when it belongs
 * to this route, else the live URL. Never an empty set built from `null` —
 * that would silently drop every unrelated param already in the URL.
 * Exported for its unit test.
 */
export function patchBase(stored, path, search) {
  return stored?.path === path ? stored.params : new URLSearchParams(search);
}

/**
 * Write many params in ONE setSearchParams call, based on the most recently
 * written params rather than react-router's own stale-within-a-tick `prev`.
 * Anything that changes more than one key (a preset plus its date range)
 * still must patch, not chain setters — two separate `update()` calls
 * compose correctly now, but still cost two history entries.
 */
export function useUpdateQuery({ replace = true } = {}) {
  const [searchParams, setSearchParams] = useSearchParams();
  useEffect(() => { lastWritten = { path: window.location.pathname, params: searchParams }; }, [searchParams]);
  return useCallback(
    (patch) => {
      const path = window.location.pathname;
      const next = queryPatch(patchBase(lastWritten, path, window.location.search), patch);
      lastWritten = { path, params: next };
      setSearchParams(next, { replace });
    },
    [setSearchParams, replace],
  );
}

/** One independent string param, absent from the URL while it equals `def`. */
export function useQueryState(key, def = '', { replace = true } = {}) {
  const [params] = useSearchParams();
  const update = useUpdateQuery({ replace });
  const value = params.get(key) ?? def;
  const set = useCallback((v) => update({ [key]: v === def ? null : v }), [update, key, def]);
  return [value, set];
}

/** One independent multi-value param <-> array (repeated params). */
export function useQueryList(key, { replace = true } = {}) {
  const [params] = useSearchParams();
  const update = useUpdateQuery({ replace });
  const value = useMemo(() => params.getAll(key), [params, key]);
  const set = useCallback((list) => update({ [key]: list.length ? list : null }), [update, key]);
  return [value, set];
}
