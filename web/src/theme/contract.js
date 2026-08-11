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
 * Contract shape (unchanged — do not rename/remove; many components depend on
 * this exact shape):
 *   radius  { sm, md, lg, ... }         corner radii (px numbers)
 *   space   { ... }                     spacing scale
 *   layers  { nav, content, ... }       semantic z-index scale
 *   motion  { ease, easeInOut }         easing curves
 *   fonts   { ... }                     font stacks
 *   glass   { surface, blur, stroke, cardShadow }   glass-surface recipe (CSS-var strings)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Presentation roles — {@link getRoles}
 * ─────────────────────────────────────────────────────────────────────────────
 * `getTokens()` above is a *literal* token bundle (radii, spacing, fonts, …).
 * `getRoles()` is a step up: small, named *presentation recipes* that both
 * skins resolve to their own values, so a shared component (or `shellStyles.js`)
 * never has to branch on `skinId` or reach into `theme.nerv`/`theme.zapac`
 * directly. Each group is documented below with its sub-keys and intent.
 *
 * A skin populates this by attaching a pre-built `theme.roles` object once (see
 * `skins/zapac.jsx` / `skins/phosphor.jsx`) — {@link getRoles} just reads it.
 *
 *   shell   — the app surface model: page/panel background, the optional outer
 *             command frame (border/width/inset rule), a `chamfer(cut)` clip-
 *             path factory, and the ambient panel glow. ZAPAC has no frame
 *             chrome, so its `frameBorderWidth` is `0` and `chamfer()` is a
 *             no-op (`'none'`) — components should treat `frameBorderWidth: 0`
 *             as "skip the frame" rather than special-casing `skinId`.
 *
 *   chrome  — structural stroke/border colors: the primary structural rule
 *             (`stroke`), the idle/divider hairline (`stroke2`), the MUI
 *             `divider` equivalent, and the meter/progress `track` color.
 *             Under Phosphor `stroke`/`divider` are safety orange — chrome
 *             only, never a status color (see `status` below).
 *
 *   status  — the semantic tone lookup for the four core states plus idle,
 *             deliberately *excluding* orange: `nominal` (mint/success),
 *             `pending` (blue/info), `caution` (amber/warning), `critical`
 *             (red/error), `idle` (dim/secondary). This is the low-level color
 *             lookup; the bilingual/tone *domain* mapping (queued, planning,
 *             running, review, done, failed) lives in `lib/domainState.js` and
 *             is intentionally a separate, higher-level module — don't
 *             duplicate that table here.
 *
 *   focus   — one visible-focus recipe, shape-normalized so both skins' very
 *             different grammars (ZAPAC's soft box-shadow ring vs. Phosphor's
 *             dashed outline) resolve through one helper (`shellStyles.focusRing`):
 *             `{ kind: 'shadow'|'outline', color, width, style, offset }`.
 *
 *   motion  — the mechanical-motion recipe: a default `transition` timing
 *             function, an optional stepped `step` function and hard-cut
 *             `snap` function (Phosphor only — `null` under ZAPAC, which has
 *             no stepped/snap concept), and `durations` in ms (`fast`,
 *             `standard`, `blink` — `blink` is `null` under ZAPAC, which never
 *             blinks).
 *
 *   terminal — reserved *role names* for the machine-output palette
 *             (`background`, `foreground`, `dim`, `cursor`, `success`, `info`,
 *             `caution`, `danger`) — NOT the full 16-color ANSI/xterm palette.
 *             The actual `getTerminalTheme(skinId, mode)` resolver consumed by
 *             `Terminal.jsx`/`TranscriptView.jsx` is a later batch (task 6.1);
 *             this group only reserves the shape so it lands consistent with
 *             the rest of the contract. Today it resolves to each skin's
 *             closest existing semantic colors and is not yet wired into
 *             `term-theme.js`.
 */

/** @typedef {{ radius: object, space: object, layers: object, motion: object, fonts: object, glass: object }} SkinTokens */

/**
 * @typedef {Object} ShellRole
 * @property {string} surface page/background surface color
 * @property {string} panel panel/paper surface color
 * @property {string} frameBorder outer frame border color (`'none'` = no frame)
 * @property {number} frameBorderWidth outer frame border width in px (`0` = no frame)
 * @property {string} frameInsetBorder inner double-frame inset rule color (`'none'` = no inset)
 * @property {(cut?: number) => string} chamfer clip-path factory for a chamfered panel
 * @property {string} glow ambient panel glow (CSS `box-shadow` value)
 *
 * @typedef {Object} ChromeRole
 * @property {string} stroke primary structural border/rule color
 * @property {string} stroke2 secondary/idle divider color
 * @property {string} divider MUI `divider`-equivalent color
 * @property {string} track meter/progress track color
 *
 * @typedef {Object} StatusRole
 * @property {string} nominal mint/success — running/nominal
 * @property {string} pending blue/info — planning/pending
 * @property {string} caution amber/warning — review/caution
 * @property {string} critical red/error — failure/disconnection
 * @property {string} idle dim/secondary — queued/idle
 *
 * @typedef {Object} FocusRole
 * @property {'shadow'|'outline'} kind which CSS mechanism renders the ring
 * @property {string} color ring color
 * @property {number} width ring width in px
 * @property {string} style `outline-style` (only meaningful when `kind === 'outline'`)
 * @property {number} offset `outline-offset` in px (only meaningful when `kind === 'outline'`)
 *
 * @typedef {Object} MotionRole
 * @property {string} transition default CSS timing function
 * @property {?string} step stepped/discrete timing function (Phosphor only)
 * @property {?string} snap hard-cut timing function (Phosphor only)
 * @property {{ fast: number, standard: number, blink: ?number }} durations
 *
 * @typedef {Object} TerminalRole
 * @property {string} background terminal field background
 * @property {string} foreground primary terminal text
 * @property {string} dim secondary/dim terminal text (AA-safe)
 * @property {string} cursor caret color
 * @property {string} success ANSI nominal/success role color
 * @property {string} info ANSI pending/information role color
 * @property {string} caution ANSI caution/warning role color
 * @property {string} danger ANSI error/danger role color
 *
 * @typedef {Object} SkinRoles
 * @property {ShellRole} shell
 * @property {ChromeRole} chrome
 * @property {StatusRole} status
 * @property {FocusRole} focus
 * @property {MotionRole} motion
 * @property {TerminalRole} terminal
 */

const EMPTY = Object.freeze({});

const EMPTY_ROLES = Object.freeze({
  shell: EMPTY,
  chrome: EMPTY,
  status: EMPTY,
  focus: EMPTY,
  motion: EMPTY,
  terminal: EMPTY,
});

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
  // A skin may attach a pre-normalized bundle at `theme.tokens` (the preferred
  // path — see skins/phosphor.jsx). Otherwise fall back to the ZAPAC mapping,
  // reading its `zapac` namespace + the glass palette group.
  if (theme?.tokens) return theme.tokens;
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

/**
 * Read the skin-agnostic presentation roles off a MUI theme — see the
 * "Presentation roles" section of this module's doc comment for the full
 * shape. A skin attaches its resolved bundle at `theme.roles` once (see
 * `skins/zapac.jsx` / `skins/phosphor.jsx`); this just reads it, falling back
 * to an all-empty bundle so a partially-built or test-double theme never
 * throws — components should treat an empty group as "this role isn't
 * available yet" rather than crash.
 *
 * @param {object} theme MUI theme
 * @returns {SkinRoles}
 */
export function getRoles(theme) {
  return theme?.roles ?? EMPTY_ROLES;
}

/** Keys a conforming skin's tokens must expose (used by the dev-time assertion). */
export const REQUIRED_TOKEN_GROUPS = ['radius', 'layers', 'glass', 'fonts'];

/** Keys a conforming skin's presentation roles must expose (used by the dev-time assertion). */
export const REQUIRED_ROLE_GROUPS = ['shell', 'chrome', 'status', 'focus', 'motion', 'terminal'];

function emptyGroups(bundle, groups) {
  return groups.filter((g) => {
    const v = bundle[g];
    return !v || (typeof v === 'object' && Object.keys(v).length === 0);
  });
}

/**
 * Dev-only sanity check that a skin's theme satisfies the token + role
 * contract. Warns (never throws) so a partially-built skin still renders while
 * surfacing the gap in the console. No-op in production builds.
 *
 * @param {object} theme MUI theme produced by a skin
 * @param {string} skinId id of the skin, for the warning message
 */
export function assertSkinContract(theme, skinId) {
  if (import.meta.env?.PROD) return;
  const missingTokens = emptyGroups(getTokens(theme), REQUIRED_TOKEN_GROUPS);
  const missingRoles = emptyGroups(getRoles(theme), REQUIRED_ROLE_GROUPS).map((g) => `roles.${g}`);
  const missing = [...missingTokens, ...missingRoles];
  if (missing.length) {
    console.warn(
      `[theme] skin "${skinId}" is missing token group(s): ${missing.join(', ')}. ` +
        'Components reading getTokens()/getRoles() may fall back to empty values.',
    );
  }
}
