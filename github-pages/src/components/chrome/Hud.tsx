// Transcribed from docs/one-shot/3d/sample-gitlab-3d-scan.html, source lines
// 460-468 (Hud) and line 479 (ScrollHint).
//
// The chapter caption is the one piece of chrome that changes at human rate (~7x
// per session), so it is React state rather than a per-frame ref write. The
// source does the same writes imperatively in updateDom() at L1444-1448.
import type { ChapterEntry } from '../../config/chapters';

interface HudProps {
  /** null before the 3D conductor starts, and forever in flat mode — the
   *  source never calls updateDom() on those paths, so the markup's authored
   *  values stand. Reproduced exactly rather than defaulting to CHAPTERS[0]:
   *  the authored sub-line ("SCROLL TO ADVANCE THE WALKTHROUGH") differs from
   *  chapter 1's ledger `sub`, so the two states are genuinely distinct. */
  chapter: ChapterEntry | null;
}

export function Hud({ chapter }: HudProps) {
  return (
    <div className="sx-hud" aria-hidden="true">
      <span className="sx-corner tl" />
      <span className="sx-corner tr" />
      <span className="sx-corner bl" />
      <span className="sx-corner br" />
      <span className="sx-scan" />
      <div className="sx-chapter">
        <div className="idx">
          <b id="sxChapterNum">{chapter ? chapter.num : '01'}</b>
          <span className="jp" id="sxChapterJp">
            {chapter ? chapter.jp : '到着'}
          </span>
          <span id="sxChapterCode">{chapter ? chapter.code : 'SCR·01'}</span>
        </div>
        <h2 id="sxChapterTitle">{chapter ? chapter.title : 'ORIENTATION'}</h2>
        <p id="sxChapterSub">{chapter ? chapter.sub : 'SCROLL TO ADVANCE THE WALKTHROUGH'}</p>
      </div>
    </div>
  );
}

export function ScrollHint() {
  return (
    <p className="sx-hint" aria-hidden="true">
      SCROLL TO TRAVEL · CAMERA ON RAILS
    </p>
  );
}
