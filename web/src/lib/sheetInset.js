// Shared rule for right-hand sheets that push the shell aside instead of
// overlaying it behind a dimming scrim.
//
// A sheet reports its width to AppShell (`sheetInset`), which vacates that strip
// with `padding-right` so the view pane and the session dock keep their full
// rounded borders beside the sheet and the scrim can go fully invisible. That
// only makes sense while enough shell is left to be usable — and "enough" can't
// be one fixed breakpoint, because the sheets differ wildly in width (the task
// dossier is 400px, the transcript sheet 860px). So the threshold is derived
// from the sheet's own width instead: shift only once the viewport can still
// give the shell SHELL_MIN_W after the sheet takes its cut.
//
// Both sides — AppShell's padding and the sheet's own backdrop (which must stop
// tinting/blurring at exactly the point the shell starts moving) — build their
// media query from this one helper, so the two can't drift apart.

// Width (px) the shell must keep for itself before a sheet may push it aside.
// ~720 leaves the nav rail plus a still-workable view pane, and puts the wide
// transcript sheet's threshold at 1580 — under a 1600px window, so the common
// desktop case gets the shift for both sheets rather than only the narrow one.
export const SHELL_MIN_W = 720;

/**
 * Media query under which a sheet of `width` px is allowed to inset the shell.
 * @param {number} width Sheet width in px.
 * @returns {string} e.g. `@media (min-width: 1120px)` for a 400px sheet.
 */
export const insetQuery = (width) => `@media (min-width: ${width + SHELL_MIN_W}px)`;
