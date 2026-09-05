import { useCallback, useEffect, useState } from 'react';

// Fetch the user-managed model list (GET /api/models — the whole store document:
// { models, defaultModel, summariserModel }). Returns it plus `error` (the last
// failed fetch's message, null otherwise — a failed GET must not silently render
// a blank Models tab or a silently empty picker; callers decide how to surface
// it) and `reload()`. Bare fetch — the token is a global window.fetch patch
// (main.jsx), so no wrapper is needed.
export function useModels() {
  const [doc, setDoc] = useState(null);
  const [error, setError] = useState(null);
  const reload = useCallback(() => {
    fetch('/api/models')
      .then((r) => r.json())
      .then((d) => { setDoc(d); setError(null); })
      .catch((e) => setError(e.message || 'could not load models'));
  }, []);
  useEffect(() => { reload(); }, [reload]);
  return { ...doc, error, reload };
}