// Dev-only tripwire for the PANEL DOM CONTRACT (see Spacer.tsx).
//
// Once a <section class="chapter"> has been adopted by a CSS3DObject it lives
// under #css3d, not under <main id="scroll">. React still holds a stateNode
// pointer to it and never re-checks parentage, so subtree updates keep working
// — but any STRUCTURAL change (remove, reorder, insert-a-sibling-before) calls
// removeChild/insertBefore on the OLD parent and either throws NotFoundError or
// silently yanks the node back into #scroll.
//
// The silent case is the dangerous one, and it is exactly what a fast-refresh
// remount or a stray `{cond && <Chapter/>}` produces. This observer turns it
// into a console error naming the chapter.

/**
 * @param panels    the 7 chapter sections
 * @param isMoving  ref that the world sets true around its own DOM surgery, so
 *                  legitimate reparenting/restoration is not reported
 * @returns disposer
 */
export function guardPanelContract(panels: HTMLElement[], isMoving: { current: boolean }): () => void {
  if (!import.meta.env.DEV) return () => {};

  const watched = new Set(panels);
  const observer = new MutationObserver((records) => {
    if (isMoving.current) return;
    for (const record of records) {
      for (const node of record.removedNodes) {
        // A REPARENT is a removal immediately followed by an insertion, and
        // MutationObserver callbacks are delivered as microtasks once the DOM
        // has settled — so a moved node is still `isConnected`. That is what
        // buildPanels() does when it hands each section to a CSS3DObject, and
        // what restoreDom() does on the way back; neither is a violation.
        // Only a node that ends up detached is a genuine React removal.
        if (node instanceof HTMLElement && node.isConnected) continue;
        if (node instanceof HTMLElement && watched.has(node)) {
          console.error(
            `[panel-contract] chapter #${node.id} was removed by React, not by the world. ` +
              'This breaks the CSS3D adoption contract — see Spacer.tsx invariants I1-I5.',
            record,
          );
        }
      }
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });
  return () => observer.disconnect();
}
