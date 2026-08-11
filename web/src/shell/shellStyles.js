/**
 * Shared shell surface styles — the glass recipe, paper-tooltip slot props, and
 * the layout-02 design-token helpers used by the sidebar, main view, and session
 * dock.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * 1.1 AUDIT — getTokens() vs layout-02.html :root CSS vars
 * ═══════════════════════════════════════════════════════════════════════════════
 * The mockup (docs/one-shot/layout-02.html) drives chrome from a small set of
 * CSS custom properties. getTokens(theme) (see theme/contract.js) returns the
 * skin-agnostic bundle `{ radius, space, layers, motion, fonts, glass }`, where
 * `glass` is the vendored theme's `theme.vars.palette.glass` CSS-var group.
 *
 * Token                  getTokens() path                  Status
 * ─────────────────────  ────────────────────────────────  ─────────────────────
 * --surface              .glass.surface                   EXPOSED (core recipe)
 * --glass-blur           .glass.blur                      EXPOSED (core recipe)
 * --stroke               .glass.stroke                    EXPOSED (core recipe)
 * --card-shadow          .glass.cardShadow                EXPOSED (core recipe)
 * --surface-2            .glass.surface2                  EXPOSED on ZAPAC (the
 *                                                         glass group carries more
 *                                                         than the contract typedef
 *                                                         documents)
 * --stroke-2             .glass.stroke2                   EXPOSED on ZAPAC
 * --track                .glass.track                     EXPOSED on ZAPAC
 * --chip                 .glass.chip                      EXPOSED on ZAPAC
 * --nav-active           .glass.navActive                 EXPOSED on ZAPAC
 * --brand                theme.vars.palette.primary.main  NOT in getTokens() —
 *                                                         read via theme.vars
 * --brand-ink            theme.vars.palette.brand.ink     NOT in getTokens() —
 *                                                         read via theme.vars
 * --brand-grad           theme.vars.palette.gradient.brand NOT in getTokens() —
 *                                                         read via theme.vars
 * --ok/--info/--warn/    theme.vars.palette.              NOT in getTokens() —
 *   --danger               {success|info|warning|error}.main read via theme.vars
 *
 * Findings:
 *  - The glass group already carries surface2/stroke2/track/chip/navActive at
 *    runtime on ZAPAC (the contract typedef only documents the core four), so
 *    trackColor/navActiveBg/chipBg/surface2/stroke2 read getTokens() directly
 *    and fall back to DESIGN.md literals (both modes) for skins/test doubles
 *    that omit them.
 *  - The identity gradient, brand-ink, and the four status colors are NOT in
 *    getTokens(); they live on theme.vars.palette.{gradient,brand,<status>}.
 *    The helpers below prefer those CSS-var references and fall back to the
 *    DESIGN.md front-matter literals (mode-aware) when a CSS var is absent.
 *  - No vendored-package edit is needed; everything resolves through existing
 *    theme tokens. No skin edit is needed for this group (task 1.3).
 *
 * Note on --brand-grad: DESIGN.md §2 and the vendored theme define the identity
 * gradient as the 3-stop `linear-gradient(45deg,#aa41af 5%,#3c69c8 60%,#00a5e6
 * 100%)`; layout-02.html :root uses the same 3-stop. DESIGN.md §2 also lists a
 * violet "bridge" stop (#8a53c0) but does not insert it into the brand gradient
 * string. We use the 3-stop (the theme + mockup value) so the restyle matches
 * the mockup exactly.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { getTokens } from '@/theme/contract.js';

// The glass recipe reads its surface tokens through getTokens() (the skin-
// agnostic accessor) so a non-ZAPAC skin only has to satisfy that contract.
// getTokens resolves from theme.vars (the scheme-switching CSS-var reference)
// under cssVariables, not theme.palette.
export const glass = (t) => {
  const { glass: g } = getTokens(t);
  return {
    background: g.surface,
    backdropFilter: `blur(${g.blur})`,
    border: `1px solid ${g.stroke}`,
    // cardShadow + a crisp 1px top-edge sheen — the canonical glass recipe's
    // highlight (DESIGN §4), as an inset shadow so it clips to the radius and
    // never fights child stacking.
    boxShadow: `${g.cardShadow}, inset 0 1px 0 rgba(255,255,255,0.18)`,
  };
};

// ── layout-02 token helpers ───────────────────────────────────────────────────
// Each helper prefers the scheme-switching CSS-var reference emitted by the
// theme under cssVariables (theme.vars.palette.*) and falls back to the DESIGN.md
// front-matter literal (mode-aware) when that CSS var is absent — so the helpers
// still render on a theme built without cssVariables or a test double.

const isDark = (t) => t?.palette?.mode === 'dark';

/**
 * Identity gradient string (DESIGN.md §2 / layout-02 `--brand-grad`). The brand
 * gradient is theme-invariant (same stops in light and dark); the theme emits it
 * at `theme.vars.palette.gradient.brand`. Usable directly as a `background` value.
 * @param {object} t MUI theme
 * @returns {string} a CSS gradient (CSS-var reference or literal fallback)
 */
export const brandGrad = (t) =>
  t?.vars?.palette?.gradient?.brand ??
  'linear-gradient(45deg, #aa41af 5%, #3c69c8 60%, #00a5e6 100%)';

/**
 * Brand glow (layout-02 `--glow-1`) — the purple bloom under the gradient brand
 * mark and the primary action. Mode-aware: stronger in dark, softer on light glass.
 * @param {object} t MUI theme
 * @returns {string} CSS color
 */
export const brandGlow = (t) => (isDark(t) ? 'rgba(170,65,175,.5)' : 'rgba(170,65,175,.30)');

/**
 * Meter / progress-bar track colour (DESIGN.md `surfaces.track`).
 * @param {object} t MUI theme
 * @returns {string|undefined} CSS color (CSS-var ref or mode-aware literal fallback)
 */
export const trackColor = (t) =>
  getTokens(t).glass.track ?? (isDark(t) ? 'rgba(160,130,255,.14)' : 'rgba(152,91,156,.15)');

/**
 * Active nav-item background (DESIGN.md `surfaces.navActive`).
 * @param {object} t MUI theme
 * @returns {string|undefined} CSS color (CSS-var ref or mode-aware literal fallback)
 */
export const navActiveBg = (t) =>
  getTokens(t).glass.navActive ?? (isDark(t) ? 'rgba(255,255,255,.06)' : 'rgba(255,255,255,.9)');

/**
 * Chip / icon-tile background — the purple tint at ~.13 (DESIGN.md
 * `surfaces.chip`). Also the visible focus-ring fill (DESIGN §5).
 * @param {object} t MUI theme
 * @returns {string|undefined} CSS color (CSS-var ref or mode-aware literal fallback)
 */
export const chipBg = (t) =>
  getTokens(t).glass.chip ?? (isDark(t) ? 'rgba(160,130,255,.14)' : 'rgba(152,91,156,.13)');

/**
 * Recessed inner surface — usage panel, footers, hover fills (DESIGN.md
 * `surfaces.surface2`).
 * @param {object} t MUI theme
 * @returns {string|undefined} CSS color (CSS-var ref or mode-aware literal fallback)
 */
export const surface2 = (t) =>
  getTokens(t).glass.surface2 ?? (isDark(t) ? 'rgba(255,255,255,.03)' : 'rgba(255,255,255,.42)');

/**
 * Faint divider / hairline border (DESIGN.md `surfaces.stroke2`).
 * @param {object} t MUI theme
 * @returns {string|undefined} CSS color (CSS-var ref or mode-aware literal fallback)
 */
export const stroke2 = (t) =>
  getTokens(t).glass.stroke2 ?? (isDark(t) ? 'rgba(160,130,255,.08)' : 'rgba(152,91,156,.11)');

/**
 * Brand ink — the darker purple used for text/icons on light glass for AA
 * legibility (DESIGN.md `brand.ink`); the dark theme lightens it to `#cba3ea`.
 * The theme emits it at `theme.vars.palette.brand.ink` (scheme-switching).
 * @param {object} t MUI theme
 * @returns {string} CSS color (CSS-var ref or mode-aware literal fallback)
 */
export const brandInk = (t) =>
  t?.vars?.palette?.brand?.ink ?? (isDark(t) ? '#cba3ea' : '#834f88');

/**
 * Brand-ink for chrome that should read purple on light glass, full ink on
 * dark (layout-02: `--brand-ink` in light, `--ink` in dark) — the active
 * nav-item count chip, the More-menu's selected sparkline-window pill.
 * @param {object} t MUI theme
 * @returns {string} CSS color
 */
export const brandOrInk = (t) => (t.palette.mode === 'dark' ? 'text.primary' : brandInk(t));

const STATUS_TO_MUI = { ok: 'success', info: 'info', warn: 'warning', danger: 'error' };
const STATUS_FALLBACK = {
  ok: { light: '#088043', dark: '#2ec76f' },
  info: { light: '#007299', dark: '#33b5e0' },
  warn: { light: '#f2a33c', dark: '#f2a33c' },
  danger: { light: '#b00020', dark: '#b00020' },
};

/**
 * Semantic status colour (DESIGN.md `status`). `kind` is one of `ok | info |
 * warn | danger`, mapped to the MUI palette's `success | info | warning |
 * error` groups. The theme emits each at `theme.vars.palette.<group>.main`
 * (scheme-switching); falls back to the DESIGN.md mode-aware literal.
 * @param {object} t MUI theme
 * @param {'ok'|'info'|'warn'|'danger'} kind status kind
 * @returns {string} CSS color (CSS-var ref or mode-aware literal fallback)
 */
export const statusColor = (t, kind) => {
  const muiKey = STATUS_TO_MUI[kind] ?? kind;
  return (
    t?.vars?.palette?.[muiKey]?.main ??
    (isDark(t) ? STATUS_FALLBACK[kind]?.dark : STATUS_FALLBACK[kind]?.light) ??
    ''
  );
};

// ── layout-02 chip primitives ─────────────────────────────────────────────────
// `.pill` and `.tag` from the mockup, as `sx` fragments for MUI Chip. Shared by
// the board cards and the task detail sheet so one task reads the same in both.

/**
 * `.pill` — a state badge: 10px uppercase letterspaced label on a chip fill.
 * @param {object} t MUI theme
 * @returns {object} an `sx` object for MUI Chip
 */
export const statePill = (t) => ({
  height: 'auto', borderRadius: 999,
  background: chipBg(t), color: 'text.secondary',
  '& .MuiChip-label': {
    px: '9px', py: '3px',
    fontSize: 10, fontWeight: 700, letterSpacing: '.1em', textTransform: 'uppercase', lineHeight: 1.3,
  },
});

/**
 * `.tag` — a read-only tag chip: quieter and smaller than an interactive filter
 * chip (recessed surface, hairline border, no hover).
 * @param {object} t MUI theme
 * @returns {object} an `sx` object for MUI Chip
 */
export const cardTag = (t) => ({
  height: 19, fontSize: 10, borderRadius: 999,
  background: surface2(t),
  border: `1px solid ${stroke2(t)}`,
  color: 'text.disabled',
  '& .MuiChip-label': { px: '8px' },
});

/**
 * `.detail-sec h4` / `.usage h4` — the small uppercase section label.
 * @returns {object} an `sx` object
 */
export const sectionLabel = () => ({
  fontSize: 11, fontWeight: 700, letterSpacing: '.14em',
  textTransform: 'uppercase', color: 'text.disabled',
});

/**
 * Visible keyboard-focus indicator — the soft purple ring from DESIGN §5 /
 * layout-02's `:focus-visible` rule (`box-shadow: 0 0 0 3px var(--chip)`).
 * Spread into an `sx` style object alongside other box-shadows (the focus ring
 * composes after any surface shadow).
 * @param {object} t MUI theme
 * @returns {{ boxShadow: string }} an `sx`-spreadable style fragment
 */
export const focusRing = (t) => ({ boxShadow: `0 0 0 3px ${chipBg(t)}` });

// ── tooltip slot props ────────────────────────────────────────────────────────

// Paper-surface tooltip styling, shared across the nav rail + collapsed list.
export const PAPER_TOOLTIP_SLOTPROPS = {
  tooltip: {
    sx: {
      bgcolor: 'var(--mui-palette-background-paper) !important',
      color: 'var(--mui-palette-text-primary) !important',
      border: '1px solid var(--mui-palette-divider) !important',
      backdropFilter: 'blur(8px)',
      whiteSpace: 'pre-line', // multi-line titles (usage summary) break on \n
    },
  },
};