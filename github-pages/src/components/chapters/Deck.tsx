// Source: docs/one-shot/3d/sample-gitlab-3d-scan.html, <main id="scroll"> at
// line 497. Renders the 7 chapters, unconditionally and in ledger order — see
// Beat.tsx's PANEL DOM CONTRACT (invariants I1/I2) for why.

import { CHAPTERS } from '../../config/chapters';
import { Beat } from './Beat';
import { CHAPTER_COMPONENTS } from './index';

export function Deck() {
  return (
    <main id="scroll">
      {CHAPTERS.map((chapter) => {
        const ChapterComponent = CHAPTER_COMPONENTS[chapter.id];
        return (
          <Beat key={chapter.id} chapter={chapter}>
            <ChapterComponent />
          </Beat>
        );
      })}
    </main>
  );
}
