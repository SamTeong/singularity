// Transcribed from docs/one-shot/3d/sample-gitlab-3d-scan.html.
// Source markup (L478): `<nav class="sx-rail" id="sxRail" aria-label="Walkthrough
// chapters"></nav>` is empty; the JS at L1026-1035 builds one button per chapter
// from the chapter ledger, and L1449 sets aria-current on chapter change.
import { useEffect, useState, type CSSProperties } from 'react';
import { CHAPTERS } from '../../config/chapters';
import { useChapterIndex, useConductor } from '../../state/appStore';
import { useLightbox } from '../../deck/lightbox';

// How many items either side of the hovered one join the wave. Beyond this the
// boost is 0, so the wave has a finite ripple length rather than perturbing the
// whole rail.
const WAVE_RANGE = 2;

export function ChapterRail() {
  const active = useChapterIndex();
  const conductor = useConductor();
  // Index of the item the pointer is over, or null when the pointer has left
  // the rail. Drives the magnification wave: the hovered tick is tallest, its
  // neighbours decay with distance, and the CSS bounce easing makes the ripple
  // settle like a spring.
  const [hover, setHover] = useState<number | null>(null);

  // 1 at the hovered item, decaying linearly to 0 over WAVE_RANGE neighbours.
  // The active slide also carries a resting boost so its tick stays long even
  // when the pointer is elsewhere; the wave's value wins when it is larger.
  const boostFor = (i: number): number => {
    const d = hover === null ? WAVE_RANGE + 1 : Math.abs(i - hover);
    const wave = d > WAVE_RANGE ? 0 : 1 - d / (WAVE_RANGE + 1);
    const rest = active === i ? 2 / 3 : 0;
    return Math.max(wave, rest);
  };

  // The pipeline slide's lightbox (see Lightbox.tsx) uses the same two keys
  // to browse artefacts within the popup. Without this guard every ← / →
  // there would also page the chapter underneath it.
  const { open: lightboxOpen } = useLightbox();

  // Arrow-key chapter nav. Mirrors the rail buttons' `conductor?.goTo(i)`
  // guard: inert in flat mode (conductor === null), and bounded to the
  // chapter ledger so the edges are no-ops rather than wrapping.
  useEffect(() => {
    if (!conductor || lightboxOpen) return;
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
  }, [conductor, active, lightboxOpen]);

  return (
    <nav className="sx-rail" id="sxRail" aria-label="Walkthrough chapters" onMouseLeave={() => setHover(null)}>
      {CHAPTERS.map((c, i) => (
        <button
          key={c.id}
          type="button"
          aria-label={`${c.title} ${c.num}`}
          onMouseEnter={() => setHover(i)}
          // `--boost` (0..1) is the wave amplitude for this item; the tick's
          // width is derived from it in chrome.css. Cast because React's
          // CSSProperties type does not include custom properties.
          style={{ '--boost': boostFor(i) } as CSSProperties}
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
