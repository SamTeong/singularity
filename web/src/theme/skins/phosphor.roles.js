/**
 * Phosphor → presentation-roles mapping (see `theme/contract.js`'s
 * "Presentation roles" doc comment for the full shape). A pure, plain-JS
 * transform — no JSX, no side effects, no import of the vendored
 * `phosphor-console-theme` package — so it's unit-testable with a
 * same-shaped test double under plain `node --test` (the vendored theme is a
 * raw-TS/JSX-adjacent import that can't load under Node's native test runner).
 *
 * Every value traces to `theme.nerv.*` / `theme.vars.palette.nerv.*` — never a
 * new hex literal.
 */

/**
 * @param {object} phosphorTheme the vendored Phosphor theme (`theme` export
 *   of `phosphor-console-theme/theme`), or a same-shaped test double
 * @returns {import('@/theme/contract.js').SkinRoles}
 */
export function buildPhosphorRoles(phosphorTheme) {
  const n = phosphorTheme.nerv;
  const v = phosphorTheme.vars.palette;
  return {
    // The signature double-frame chrome: 3px orange border + a 1px inset
    // rule, chamfered corners via `nerv.chamfer()`. See
    // docs/one-shot/phosphor-layout-02.html's `.frame`/`.frame::before`.
    shell: {
      surface: v.background.default,
      panel: v.background.paper,
      frameBorder: n.hue.orange,
      frameBorderWidth: 3,
      frameInsetBorder: n.hue.orange,
      chamfer: n.chamfer,
      glow: v.nerv.glowPanel,
    },
    chrome: {
      stroke: v.nerv.stroke,
      stroke2: v.nerv.stroke2,
      divider: v.nerv.stroke,
      track: v.nerv.track,
    },
    // Orange is deliberately absent — chrome-only, never a status color.
    status: {
      nominal: n.hue.mint,
      pending: n.hue.blue,
      caution: n.hue.amber,
      critical: n.hue.redHi,
      idle: n.hue.greenMap, // AA-legible; `greenDim` is chrome-only (below AA for text)
    },
    // The global `:focus-visible` rule (DESIGN.md nav focus / layout-02):
    // 2px dashed amber. Buttons/segmented controls use a different (solid
    // paper) recipe from the vendored `focusRing` util — composition owners
    // needing that variant read `phosphor-console-theme/components`' util
    // directly; this is the app-wide default.
    focus: {
      kind: 'outline',
      color: n.hue.amber,
      width: 2,
      style: 'dashed',
      offset: 2,
    },
    motion: {
      transition: n.motion.linear,
      step: n.motion.step,
      snap: n.motion.snap,
      durations: {
        fast: n.motion.durations.fast,
        standard: n.motion.durations.snap,
        blink: n.motion.durations.blink,
      },
    },
    // Reserved role names (see theme/contract.js) — not yet wired into
    // Terminal.jsx/TranscriptView.jsx's palette resolver (task 6.1). Mirrors
    // design.md D6's Phosphor terminal grammar: void background, amber
    // primary/cursor, AA-safe dim rust, mint/blue/amber/red ANSI states.
    terminal: {
      background: v.background.default,
      foreground: v.nerv.termText,
      dim: v.nerv.termDim,
      cursor: v.nerv.termText,
      success: n.hue.mint,
      info: n.hue.blue,
      caution: n.hue.amber,
      danger: n.hue.redHi,
    },
  };
}
