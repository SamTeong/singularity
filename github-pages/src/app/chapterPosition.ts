// Which chapter the reader is on, read off the flat document.
//
// In 3D the world owns that answer (appStore's chapterIndex signal, written by
// the conductor). In flat mode nothing tracks it — the deck is a plain
// document there — so it is measured: the chapter whose section straddles the
// middle of the viewport.

import { CHAPTERS } from '../config/chapters';

export function visibleChapter(): number {
  const mid = window.innerHeight / 2;
  const i = CHAPTERS.findIndex((c) => {
    const rect = document.getElementById(c.id)?.getBoundingClientRect();
    return !!rect && rect.top <= mid && rect.bottom >= mid;
  });
  return i < 0 ? 0 : i;
}
