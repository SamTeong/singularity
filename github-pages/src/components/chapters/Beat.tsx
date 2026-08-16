// PANEL DOM CONTRACT
//
// The 7 <section class="chapter"> nodes are reparented out of <main id="scroll">
// into the world-owned #css3d container by CSS3DObject. React keeps a pointer to
// each node but no longer knows its parent. Updates (text, attributes, subtree
// reconciliation) keep working. Structural changes do not — React would call
// removeChild/insertBefore on the OLD parent and throw NotFoundError, or silently
// yank the node back into #scroll. Therefore:
//
//  I1  Rendered unconditionally. No `{cond && <Chapter/>}`, no early return, no
//      React.lazy/Suspense between <main> and a chapter.
//  I2  Fixed order, stable keys (chapter.id), from the frozen CHAPTERS constant.
//      Never filtered, sorted, or sliced.
//  I3  Element type is always <section>. Never conditionally swapped.
//  I4  className and style on the <section> are CONSTANT LITERALS. Any dynamic
//      state goes on a descendant or a data-* attribute. React rewrites the whole
//      className string on change and would silently delete `.as-panel`,
//      collapsing the panel's layout mid-scroll with no error.
//  I5  No sibling may be inserted into <main> adjacent to a .beat after mount.
//  I6  World-owned mutations on the <section>, exclusively:
//          classList: 'as-panel'
//          style:     width, height, display, opacity
//      React must never touch these. world.destroy() restores all of them.
//  I7  Descendants of a chapter are fully React-owned and may change freely.

import type { ReactNode, Ref } from 'react';
import type { ChapterEntry } from '../../config/chapters';

interface BeatProps {
  chapter: ChapterEntry;
  children: ReactNode;
  /** The conductor measures these wrappers and owns their inline height. */
  beatRef?: Ref<HTMLDivElement>;
}

export function Beat({ chapter, children, beatRef }: BeatProps) {
  // data-weight={chapter.weight} renders as e.g. "1.3" for a weight of 1.30 —
  // that's fine, parseFloat is identical either way, and the DOM attribute is
  // decorative. The conductor reads CHAPTERS[i].weight, not the attribute.
  // Do not "fix" this by stringifying with trailing zeros.
  return (
    <div className="beat" data-chapter={chapter.id} data-weight={chapter.weight} ref={beatRef}>
      {children}
    </div>
  );
}
