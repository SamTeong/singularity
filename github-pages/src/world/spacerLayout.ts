// Spacer height sizing, factored out of the one-shot's standalone `sizeBeats()`
// (L1490-1494) and its inverse in `fail()` (L809) so conductor.ts's measure()
// can fold height-setting and anchor measurement into a single innerHeight
// snapshot — see conductor.ts's measure() for why splitting them is unsafe.

/** Sets each spacer's CSS height from its chapter weight, using ONE viewport-
 *  height snapshot (`vh`) for every spacer — the caller (conductor.ts measure())
 *  must reuse that same `vh` for the anchor maths that follows, or the two
 *  disagree about what "the viewport" was for this measurement pass. */
export function applySpacerHeights(spacers: HTMLElement[], weights: number[], vh: number): void {
  spacers.forEach((spacer, i) => {
    spacer.style.height = weights[i] * vh + 'px';
  });
}

/** Inverse of applySpacerHeights — restores the spacers to their natural
 *  (CSS-driven) flat-mode height. Ported from the source's fail() at L809. */
export function clearSpacerHeights(spacers: HTMLElement[]): void {
  spacers.forEach((spacer) => {
    spacer.style.height = '';
  });
}
