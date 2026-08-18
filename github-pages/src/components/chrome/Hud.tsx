// Transcribed from docs/one-shot/3d/sample-gitlab-3d-scan.html, source lines
// 460-468 (Hud) and line 479 (ScrollHint).
//
// The beat caption is the one piece of chrome that changes at human rate (~7x
// per session), so it is React state rather than a per-frame ref write. The
// source does the same writes imperatively in updateDom() at L1444-1448.
import { useEffect, useRef } from 'react';
import { CHAPTERS, type ChapterEntry } from '../../config/chapters';
import { useConductor } from '../../state/appStore';

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
      <div className="sx-beat">
        <div className="idx">
          <b id="sxBeatNum">{chapter ? chapter.num : '01'}</b>
          <span className="jp" id="sxBeatJp">
            {chapter ? chapter.jp : '到着'}
          </span>
          <span id="sxBeatCode">{chapter ? chapter.code : 'SCR·01'}</span>
        </div>
        <h2 id="sxBeatTitle">{chapter ? chapter.title : 'ORIENTATION'}</h2>
        <p id="sxBeatSub">{chapter ? chapter.sub : 'SCROLL TO ADVANCE THE WALKTHROUGH'}</p>
      </div>
    </div>
  );
}

/** Chromium's hit-testing of the CSS3D panels is per-panel, not all-or-nothing:
 *  measured with `elementFromPoint` over each button's screen rect, the CTA
 *  panel's anchor is hit 49/49 while the hero's is hit 0/49 (the canvas comes
 *  back on top instead). So every other in-panel control just needs a real
 *  handler — only the hero's GET STARTED needs help, and this is it: a
 *  transparent, fixed hit proxy parked directly over it, driving the same jump
 *  the chapter rail does. The real button keeps rendering underneath and
 *  supplies all the styling, so nothing new appears in the composition.
 *
 *  The rect has to be re-read every frame, not per chapter change: pointer
 *  parallax keeps moving the camera in the world's own loop long after the
 *  conductor has stopped emitting scroll updates, so anything driven off a
 *  chapter/scroll callback freezes ~8px off its button and stays there. Hence a
 *  ref write in an rAF of its own — refs only, no state, per the 60fps rule.
 *  Recomputing visibility on the same tick is what keeps it self-healing: there
 *  is no state to get stuck in, so it cannot end up stranded until a reload.
 *
 *  `body.mode-3d` is the gate rather than the conductor being non-null, so a
 *  webglcontextlost demotion can never leave a transparent button sitting on
 *  top of the flat page's real anchor. */
export const CTA_TWIN_ID = 'heroCta';

export function HudCta() {
  const conductor = useConductor();
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let frame = 0;
    const track = (): void => {
      frame = requestAnimationFrame(track);
      const box = boxRef.current;
      if (!box) return;
      const r = document.body.classList.contains('mode-3d')
        ? document.getElementById(CTA_TWIN_ID)?.getBoundingClientRect()
        : undefined;
      if (r && r.width > 0 && r.height > 0) {
        box.style.display = 'block';
        box.style.transform = `translate(${r.left}px,${r.top}px)`;
        box.style.width = r.width + 'px';
        box.style.height = r.height + 'px';
      } else {
        box.style.display = 'none';
      }
    };
    frame = requestAnimationFrame(track);
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <div className="sx-cta" ref={boxRef}>
      <button type="button" aria-label="Get started" onClick={() => conductor?.goTo(CHAPTERS.length - 1)}>
        GET STARTED
      </button>
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
