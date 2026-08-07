/**
 * KeysProvider — rebindable keyboard shortcuts state.
 *
 * Renders children immediately with {@link DEFAULTS}; a mount-time fetch of
 * `/keys` layers the daemon's persisted overrides on top. Mutations are
 * optimistic (local state updates before the PUT resolves) and swallow
 * network failure — the daemon is the store of record but the UI never blocks
 * on it.
 */
import { createContext, use, useCallback, useEffect, useMemo, useState } from 'react';
import { DEFAULTS } from '@/lib/keys.js';

/** @type {React.Context<any>} */
const KeysContext = createContext(null);

const putOverrides = (patch) => fetch('/keys', {
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(patch),
}).catch(() => {});

export function KeysProvider({ children }) {
  const [overrides, setOverrides] = useState({});

  useEffect(() => {
    fetch('/keys').then((r) => r.json()).then((d) => setOverrides(d.keys || {})).catch(() => {});
  }, []);

  const setKey = useCallback((id, binding) => {
    setOverrides((o) => ({ ...o, [id]: binding }));
    putOverrides({ [id]: binding });
  }, []);

  const resetKey = useCallback((id) => {
    setOverrides((o) => {
      const { [id]: _drop, ...rest } = o;
      return rest;
    });
    putOverrides({ [id]: null });
  }, []);

  const resetAll = useCallback(() => {
    setOverrides((o) => {
      putOverrides(Object.fromEntries(Object.keys(o).map((id) => [id, null])));
      return {};
    });
  }, []);

  // Stable identity: consumers put `keys` in effect dep arrays, and AppShell
  // re-renders on every WS frame — an inline object would rebind their window
  // listeners dozens of times a second.
  const keys = useMemo(() => ({ ...DEFAULTS, ...overrides }), [overrides]);
  const value = useMemo(() => ({ keys, setKey, resetKey, resetAll }), [keys, setKey, resetKey, resetAll]);
  return <KeysContext value={value}>{children}</KeysContext>;
}

/**
 * Read shortcut bindings + mutators from {@link KeysProvider}.
 * @returns {{keys: object, setKey: Function, resetKey: Function, resetAll: Function}}
 */
export function useKeys() {
  const ctx = use(KeysContext);
  if (!ctx) throw new Error('useKeys must be used within <KeysProvider>');
  return ctx;
}
