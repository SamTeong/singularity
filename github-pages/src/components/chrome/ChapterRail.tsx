// Transcribed from docs/one-shot/3d/sample-gitlab-3d-scan.html.
// Source markup (L478): `<nav class="sx-rail" id="sxRail" aria-label="Walkthrough
// chapters"></nav>` is empty; the JS at L1026-1035 builds one button per chapter
// from the CHAPTER_LEDGER (`CHAPTERS` here):
//
//   CHAPTERS.forEach((c, i) => {
//     const b = document.createElement('button');
//     b.type = 'button';
//     b.innerHTML = '<span>' + c.code + '</span><span class="jp">' + c.jp + '</span><span class="tick"></span>';
//     b.setAttribute('aria-label', c.num + ' ' + c.title);
//     b.addEventListener('click', () => conductor && conductor.goTo(i));
//     rail.appendChild(b);
//   });
//
// No `aria-current` here: the original creates these buttons without it and
// only ever sets it later inside `updateDom` (L1449) once the 3D conductor is
// running. Before that — and forever in flat mode — the attribute is simply
// absent. Phase 5 adds it back. Likewise `onClick`/`conductor.goTo` is Phase
// 5's wiring, not Phase 2's.
import { CHAPTERS } from '../../config/chapters';

export function ChapterRail() {
  return (
    <nav className="sx-rail" id="sxRail" aria-label="Walkthrough chapters">
      {CHAPTERS.map((c) => (
        <button key={c.id} type="button" aria-label={`${c.num} ${c.title}`}>
          <span>{c.code}</span>
          <span className="jp">{c.jp}</span>
          <span className="tick" />
        </button>
      ))}
    </nav>
  );
}
