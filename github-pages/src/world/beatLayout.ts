// Beat height sizing, factored out of the one-shot's standalone `sizeBeats()`
// (L1490-1494) and its inverse in `fail()` (L809) so conductor.ts's measure()
// can fold height-setting and anchor measurement into a single innerHeight
// snapshot — see conductor.ts's measure() for why splitting them is unsafe.

/** Sets each beat's CSS height from its chapter weight, using ONE viewport-
 *  height snapshot (`vh`) for every beat — the caller (conductor.ts measure())
 *  must reuse that same `vh` for the anchor maths that follows, or the two
 *  disagree about what "the viewport" was for this measurement pass. */
export function applyBeatHeights(beats: HTMLElement[], weights: number[], vh: number): void {
  beats.forEach((beat, i) => {
    beat.style.height = weights[i] * vh + 'px';
  });
}

/** Inverse of applyBeatHeights — restores the beats to their natural
 *  (CSS-driven) flat-mode height. Ported from the source's fail() at L809. */
export function clearBeatHeights(beats: HTMLElement[]): void {
  beats.forEach((beat) => {
    beat.style.height = '';
  });
}
