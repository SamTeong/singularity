// Source: docs/one-shot/3d/sample-gitlab-3d-scan.html, <main id="scroll"> at
// line 497. Renders the 9 chapters, unconditionally and in ledger order — see
// Spacer.tsx's PANEL DOM CONTRACT (invariants I1/I2) for why.

import type { Ref } from 'react';
import { CHAPTERS } from '../../config/chapters';
import type { ChapterId } from '../../config/chapters';
import { Spacer } from './Spacer';
import { CHAPTER_COMPONENTS } from './index';

interface ChaptersProps {
  /** Stable, created-once ref callbacks keyed by chapter id (see
   *  useElementRegistry). The world adopts the sections as CSS3DObjects and
   *  the conductor measures the spacers. Absent in flat mode. */
  sectionRefs?: Record<ChapterId, Ref<HTMLElement>>;
  spacerRefs?: Record<ChapterId, Ref<HTMLDivElement>>;
}

export function Chapters({ sectionRefs, spacerRefs }: ChaptersProps) {
  return (
    <main id="scroll">
      {CHAPTERS.map((chapter) => {
        const ChapterComponent = CHAPTER_COMPONENTS[chapter.id];
        return (
          <Spacer key={chapter.id} chapter={chapter} spacerRef={spacerRefs?.[chapter.id]}>
            <ChapterComponent sectionRef={sectionRefs?.[chapter.id]} />
          </Spacer>
        );
      })}
    </main>
  );
}
