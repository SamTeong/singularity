/**
 * ZAPAC → presentation-roles mapping (see `theme/contract.js`'s "Presentation
 * roles" doc comment for the full shape). A pure, plain-JS transform — no
 * JSX, no side effects, no import of the vendored `@zapac/mui-theme` package
 * — so it's unit-testable with a same-shaped test double under plain
 * `node --test` (the vendored theme is a `.jsx`-adjacent, React-bundled
 * import that can't load under Node's native test runner).
 *
 * Every value is a `theme.vars.palette.*` CSS-var *reference* string (e.g.
 * `var(--mui-palette-glass-chip)`), never a resolved literal — safe to build
 * once and reuse across a live ZAPAC light/dark toggle, since the underlying
 * CSS variable (not this JS string) is what actually switches.
 */

/**
 * @param {object} zapacTheme the vendored ZAPAC theme (`theme`/`zapacTheme`
 *   export of `@zapac/mui-theme`), or a same-shaped test double
 * @returns {import('@/theme/contract.js').SkinRoles}
 */
export function buildZapacRoles(zapacTheme) {
  const v = zapacTheme.vars.palette;
  return {
    // ZAPAC has no command-frame chrome — `frameBorderWidth: 0` / a no-op
    // `chamfer()` tell composition owners (task 3.x) to skip the frame
    // entirely rather than special-case `skinId`.
    shell: {
      surface: v.background.default,
      panel: v.background.paper,
      frameBorder: 'none',
      frameBorderWidth: 0,
      frameInsetBorder: 'none',
      chamfer: () => 'none',
      glow: v.glass.cardShadow,
    },
    chrome: {
      stroke: v.glass.stroke,
      stroke2: v.glass.stroke2,
      divider: v.divider,
      track: v.glass.track,
    },
    status: {
      nominal: v.success.main,
      pending: v.info.main,
      caution: v.warning.main,
      critical: v.error.main,
      idle: v.text.disabled,
    },
    // The soft purple box-shadow ring (DESIGN §5 / layout-02 `:focus-visible`).
    focus: {
      kind: 'shadow',
      color: v.glass.chip,
      width: 3,
      style: 'solid',
      offset: 0,
    },
    motion: {
      transition: zapacTheme.transitions.easing.easeInOut,
      step: null,
      snap: null,
      durations: {
        fast: zapacTheme.transitions.duration.shortest,
        standard: zapacTheme.transitions.duration.standard,
        blink: null, // ZAPAC never blinks
      },
    },
    // Reserved role names (see theme/contract.js) — not yet wired into
    // term-theme.js's TERM_THEME (task 6.1 owns that resolver). Approximated
    // here from ZAPAC's existing semantic palette; note `cursor` already
    // matches TERM_THEME's literal cursor color in both modes.
    terminal: {
      background: v.background.paper,
      foreground: v.text.primary,
      dim: v.text.secondary,
      cursor: v.primary.main,
      success: v.success.main,
      info: v.info.main,
      caution: v.warning.main,
      danger: v.error.main,
    },
  };
}
