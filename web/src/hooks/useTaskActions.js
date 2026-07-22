import { useMemo } from 'react';

/**
 * Task-board mutations. Each posts to the daemon over REST; the server re-emits
 * the `tasks` frame on the WS, so board state converges from the socket, not the
 * response. Failures are surfaced through `onError`.
 *
 * @param {(msg: string) => void} onError toast/error sink
 * @returns {{ moveTask: Function, concludeTask: Function, deleteHistory: Function }}
 */
export function useTaskActions(onError) {
  return useMemo(() => {
    const report = (p) => p.then((r) => r.json()).then((d) => { if (!d.ok) onError(d.error); }).catch((e) => onError(e.message));
    const json = (body) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return {
      moveTask: (id, column) => report(fetch(`/tasks/${id}/status`, json({ column }))),
      concludeTask: (id, outcome) => report(fetch(`/tasks/${id}/conclude`, json({ outcome }))),
      deleteHistory: (id) => report(fetch(`/tasks/history/${id}`, { method: 'DELETE' })),
    };
  }, [onError]);
}
