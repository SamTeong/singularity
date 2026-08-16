// Source: docs/one-shot/3d/sample-gitlab-3d-scan.html, <main id="scroll"> at
// line 497. Renders the 7 chapters, unconditionally and in ledger order — see
// Beat.tsx's PANEL DOM CONTRACT (invariants I1/I2) for why.

import type { Ref } from 'react';
import { CHAPTERS } from '../../config/chapters';
import type { ChapterId } from '../../config/chapters';
import { Beat } from './Beat';
import { CHAPTER_COMPONENTS } from './index';

interface DeckProps {
  /** Stable, created-once ref callbacks keyed by chapter id (see
   *  useElementRegistry). The world adopts the sections as CSS3DObjects and
   *  the conductor measures the beats. Absent in flat mode. */
  sectionRefs?: Record<ChapterId, Ref<HTMLElement>>;
  beatRefs?: Record<ChapterId, Ref<HTMLDivElement>>;
}

export function Deck({ sectionRefs, beatRefs }: DeckProps) {
  return (
    <main id="scroll">
      {CHAPTERS.map((chapter) => {
        const ChapterComponent = CHAPTER_COMPONENTS[chapter.id];
        return (
          <Beat key={chapter.id} chapter={chapter} beatRef={beatRefs?.[chapter.id]}>
            <ChapterComponent sectionRef={sectionRefs?.[chapter.id]} />
          </Beat>
        );
      })}
    </main>
  );
}
