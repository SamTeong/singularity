import { useCallback, useEffect, useState } from 'react';

// Fetch the user-managed model list (GET /api/models — the whole store document:
// { models, defaultModel, summariserModel }). Returns it plus `reload()`; null
// while loading / on failure. Bare fetch — the token is a global window.fetch
// patch (main.jsx), so no wrapper is needed.
export function useModels() {
  const [doc, setDoc] = useState(null);
  const reload = useCallback(() => {
    fetch('/api/models').then((r) => r.json()).then(setDoc).catch(() => {});
  }, []);
  useEffect(() => { reload(); }, [reload]);
  return { ...doc, reload };
}