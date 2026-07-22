/**
 * Skin token contract — the shape every theme skin must expose.
 *
 * Singularity is a multi-skin app: ZAPAC (the vendored `@zapac/mui-theme`) is the
 * default skin, and future skins (e.g. Phosphor Console) plug in through the
 * registry. To keep app components skin-agnostic, they should read design tokens
 * through {@link getTokens} rather than reaching into a skin-specific namespace.
 *
 * The contract mirrors what the vendored ZAPAC theme already provides today, so
 * migrating a `t.zapac.radius.sm` read to `getTokens(t).radius.sm` is a no-op for
 * the ZAPAC skin — but it frees the read from the `zapac` namespace so a second
 * skin only has to satisfy this shape.
 *
 * Contract shape:
 *   radius  { sm, md, lg, ... }         corner radii (px numbers)
 *   space   { ... }                     spacing scale
 *   layers  { nav, content, ... }       semantic z-index scale
 *   motion  { ease, easeInOut }         easing curves
 *   fonts   { ... }                     font stacks
 *   glass   { surface, blur, stroke, cardShadow }   glass-surface recipe (CSS-var strings)
 */

/** @typedef {{ radius: object, space: object, layers: object, motion: object, fonts: object, glass: object }} SkinTokens */

const EMPTY = Object.freeze({});

/**
 * Read the skin-agnostic design tokens off a MUI theme.
 *
 * Prefers `theme.vars.palette.glass` (the scheme-switching CSS-var reference under
 * `cssVariables`) and falls back to `theme.palette.glass` when vars are absent
 * (e.g. a skin built without cssVariables, or in a test double).
 *
 * @param {object} theme MUI theme
 * @returns {SkinTokens}
 */
export function getTokens(theme) {
  const z = theme?.zapac ?? EMPTY;
  const glass = theme?.vars?.palette?.glass ?? theme?.palette?.glass ?? EMPTY;
  return {
    radius: z.radius ?? EMPTY,
    space: z.space ?? EMPTY,
    layers: z.layers ?? EMPTY,
    motion: z.motion ?? EMPTY,
    fonts: z.fonts ?? EMPTY,
    glass,
  };
}

/** Keys a conforming skin's tokens must expose (used by the dev-time assertion). */
const REQUIRED_TOKEN_GROUPS = ['radius', 'layers', 'glass'];

/**
 * Dev-only sanity check that a skin's theme satisfies the token contract.
 * Warns (never throws) so a partially-built skin still renders while surfacing
 * the gap in the console. No-op in production builds.
 *
 * @param {object} theme MUI theme produced by a skin
 * @param {string} skinId id of the skin, for the warning message
 */
export function assertSkinContract(theme, skinId) {
  if (import.meta.env?.PROD) return;
  const tokens = getTokens(theme);
  const missing = REQUIRED_TOKEN_GROUPS.filter((g) => {
    const v = tokens[g];
    return !v || (typeof v === 'object' && Object.keys(v).length === 0);
  });
  if (missing.length) {
    // eslint-disable-next-line no-console
    console.warn(
      `[theme] skin "${skinId}" is missing token group(s): ${missing.join(', ')}. ` +
        'Components reading getTokens() may fall back to empty values.',
    );
  }
}
