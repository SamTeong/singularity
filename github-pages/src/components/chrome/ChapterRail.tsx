// Transcribed from docs/one-shot/3d/sample-gitlab-3d-scan.html.
// Source markup (L478): `<nav class="sx-rail" id="sxRail" aria-label="Walkthrough
// chapters"></nav>` is empty; the JS at L1026-1035 builds one button per chapter
// from the chapter ledger, and L1449 sets aria-current on chapter change.
import { useEffect } from 'react';
import { CHAPTERS } from '../../config/chapters';
import { useChapterIndex, useConductor } from '../../state/appStore';

export function ChapterRail() {
  const active = useChapterIndex();
  const conductor = useConductor();

  // Arrow-key chapter nav. Mirrors the rail buttons' `conductor?.goTo(i)`
  // guard: inert in flat mode (conductor === null), and bounded to the
  // chapter ledger so the edges are no-ops rather than wrapping.
  useEffect(() => {
    if (!conductor) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const base = active ?? 0;
      const next =
        e.key === 'ArrowLeft' ? base - 1 : base + 1;
      if (next < 0 || next >= CHAPTERS.length) return;
      conductor.goTo(next);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [conductor, active]);

  return (
    <nav className="sx-rail" id="sxRail" aria-label="Walkthrough chapters">
      {CHAPTERS.map((c, i) => (
        <button
          key={c.id}
          type="button"
          aria-label={`${c.title} ${c.num}`}
          // Deliberately three-valued. The source creates these buttons with no
          // aria-current at all (L1028-1033) and only ever sets it inside
          // updateDom via String(i === index) (L1449) — so before enter3D(), and
          // forever in flat mode, the attribute is ABSENT; afterwards every
          // button carries an explicit "true"/"false", including the six that
          // are not current. `undefined` is what makes React omit it.
          // `.sx-rail button[aria-current="true"]` (chrome.css) is a
          // presence-and-value selector, so this is load-bearing, not cosmetic.
          aria-current={active === null ? undefined : (String(i === active) as 'true' | 'false')}
          // Mirrors the source's `conductor && conductor.goTo(i)` guard (L1032):
          // null in flat mode, which is what makes the buttons inert there.
          onClick={() => conductor?.goTo(i)}
        >
          <span className="title">{c.title}</span>
          <span className="num">{c.num}</span>
          <span className="tick" />
        </button>
      ))}
    </nav>
  );
}
