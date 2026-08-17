import { useCallback, useMemo } from 'react';
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

/**
 * Write many params in ONE setSearchParams call. Two calls in the same tick do
 * not queue — the second computes from the same snapshot and the first write is
 * lost — so anything that changes more than one key (a preset plus its date
 * range) must patch, not chain setters.
 */
export function useUpdateQuery({ replace = true } = {}) {
  const [, setSearchParams] = useSearchParams();
  return useCallback(
    (patch) => setSearchParams((prev) => queryPatch(prev, patch), { replace }),
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
