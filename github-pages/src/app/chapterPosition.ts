// Which chapter the reader is on, read off the flat document, and where the
// document has to sit for a chapter to be the one on screen.
//
// In 3D the world owns both answers (appStore's chapterIndex signal and the
// conductor's anchors). In flat mode nothing tracks them — the deck is a plain
// document there — so they are measured, and they are measured HERE TOGETHER:
// the position is what the autoplay tour scrolls to and what `visibleChapter`
// compares against, and the two silently disagreeing is what makes a tour skip
// a stop.
//
// The position is the chapter's own top, clamped to the end of the document —
// the last chapter's top is usually unreachable, so its stop is the bottom of
// the page and nothing else. The reader is then the chapter whose stop the
// scroll is nearest.
//
// NOT "the chapter straddling the middle of the viewport", which is what this
// used to measure: a flat chapter's height comes from its content, so several
// are shorter than half a tall window, and a chapter that never reaches the
// midline can never be that test's answer. The tour parks such a chapter's top
// at the viewport top, the midpoint test replies with the NEXT chapter, the
// tour reads its own stop as already passed, and the short chapter loses its
// beat.

import { CHAPTERS } from '../config/chapters';

/** Where the document sits when `index` is the chapter on screen. Clamped to
 *  the end of the document, which is as far as the last chapter can get. */
export function chapterTop(index: number): number {
  const rect = document.getElementById(CHAPTERS[index].id)?.getBoundingClientRect();
  if (!rect) return 0;
  const max = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
  return Math.min(Math.round(rect.top + window.scrollY), max);
}

export function visibleChapter(): number {
  let at = 0;
  let best = Infinity;
  CHAPTERS.forEach((_chapter, i) => {
    const distance = Math.abs(chapterTop(i) - window.scrollY);
    if (distance < best) {
      best = distance;
      at = i;
    }
  });
  return at;
}
