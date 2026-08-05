/**
 * Phosphor Console skin — NERV/MAGI tactical CRT command deck.
 *
 * Wraps the vendored `phosphor-console-theme` (a full dark-only cssVariables MUI
 * theme). Its structural tokens live under `theme.nerv.*` and its surface colours
 * under `theme.vars.palette.nerv.*` — a different namespace from ZAPAC's.
 *
 * This adapter bridges Phosphor to the app by attaching `theme.tokens` once at
 * load — the normalized bundle {@link module:theme/contract getTokens} reads,
 * so the app's own components (which call `getTokens()`/`getRoles()`, never
 * `theme.nerv.*` or `theme.zapac.*` directly) stay skin-agnostic.
 *
 * A temporary ZAPAC-compat shim (`theme.zapac` + `theme.vars.palette.glass` /
 * `theme.palette.glass`) used to live here as well, mapping Phosphor's `nerv`
 * tokens onto the ZAPAC namespace so a few @zapac house components
 * (`StatusPill`, `EmptyState`, `SearchInput`) wouldn't throw reading a shape
 * this theme didn't have. It was removed once those were replaced by the
 * skin-neutral primitives in `components/StatusPill.jsx`,
 * `components/EmptyState.jsx`, and `components/SearchInput.jsx` (task 2.4) —
 * no runtime consumer reads `theme.zapac.*` off the Phosphor theme anymore.
 */
import { ThemeProvider } from '@mui/material/styles';
import CssBaseline from '@mui/material/CssBaseline';
import InitColorSchemeScript from '@mui/material/InitColorSchemeScript';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import { theme as phosphorTheme } from 'phosphor-console-theme/theme';
import { buildPhosphorRoles } from '@/theme/skins/phosphor.roles.js';
import { PHOSPHOR_META } from '@/theme/skins/phosphor.meta.js';

// WCAG-AA adjustment (task 7.4): the vendored `error.main` is `hue.redHi`
// (#E2280F), which the design system intends for fills/strobes with black
// `contrastText` (the inversion signature — high contrast) but which only
// reaches 4.28:1 as text on the void surface, just under AA's 4.5:1 for normal
// text. Several app surfaces render error messages as plain body text via
// `color: 'error.main'` (UsageReportView, SkillsPanel, CronJobs, SaveBar,
// MermaidBlock) — those fail AA under Phosphor. `#F04438` is the nearest
// in-hue red that clears AA in both directions (5.27:1 on void; black
// contrastText on it is the same 5.27:1), so the filled-control grammar is
// unchanged and error text becomes legible. The vendored tarball is not
// modified (design.md D2); this is an adapter-level semantic-token
// adjustment, sourced from the same red family rather than a new ad-hoc color.
const PHOSPHOR_ERROR_AA = '#F04438';

if (!phosphorTheme.tokens) {
  const n = phosphorTheme.nerv;
  const v = phosphorTheme.vars.palette;

  // Radius: Phosphor is sharp (chips 2px, segments 4px, hero chamfer). Alias the
  // ZAPAC scale (sm/md/lg/pill) onto it so getTokens() consumers resolve either way.
  const radius = { ...n.radius, sm: n.radius.chip, md: n.radius.seg, lg: n.radius.seg, pill: n.radius.chip };
  // Fonts: Phosphor UI type is mono. Provide the `ui` alias getTokens() consumers expect.
  const fonts = { ...n.fonts, ui: n.fonts.mono };
  // Motion: mechanical/linear — expose ZAPAC's `ease`/`easeInOut` easing keys.
  const motion = { ...n.motion, ease: n.motion.linear, easeInOut: n.motion.linear };
  // Flat CRT "glass": black void surface, no blur, chrome-orange stroke, panel glow.
  const glass = {
    surface: v.background.paper,
    surface2: v.nerv.surface2,
    blur: '0px',
    stroke: v.nerv.stroke,
    strokeStrong: v.nerv.stroke,
    cardShadow: v.nerv.glowPanel,
  };

  phosphorTheme.tokens = { radius, space: n.space, layers: n.layers, motion, fonts, glass };

  // AA override (see PHOSPHOR_ERROR_AA above): repoint the MUI `error` palette
  // main + its CSS-var reference to the AA-legible red. `contrastText` stays
  // `hue.void` (black) — still high contrast on the lighter red (5.27:1).
  if (phosphorTheme.palette?.error) phosphorTheme.palette.error.main = PHOSPHOR_ERROR_AA;
  if (phosphorTheme.vars?.palette?.error) phosphorTheme.vars.palette.error.main = PHOSPHOR_ERROR_AA;

  // ── Presentation roles (see theme/contract.js's "Presentation roles" doc
  // comment / phosphor.roles.js for the full shape and value provenance). ──
  phosphorTheme.roles = buildPhosphorRoles(phosphorTheme);
}

function PhosphorProvider({ children }) {
  return (
    <>
      <InitColorSchemeScript attribute="class" defaultMode="dark" />
      <ThemeProvider theme={phosphorTheme} defaultMode="dark" disableTransitionOnChange>
        <CssBaseline />
        {children}
      </ThemeProvider>
    </>
  );
}

const PHOSPHOR_BG = '#0A0A0A';
const PHOSPHOR_ORANGE = '#F26400';
const PHOSPHOR_MINT = '#52F29A';
const PHOSPHOR_AMBER = '#F49F09';
const PHOSPHOR_CRT =
  'repeating-linear-gradient(0deg, rgba(0,0,0,.22) 0 1px, transparent 1px 3px), ' +
  'radial-gradient(ellipse at center, transparent 55%, rgba(0,0,0,.55) 100%)';

/** Small representative preview of the Phosphor Console skin identity. */
export function PhosphorPreview() {
  return (
    <Box
      aria-hidden
      sx={{
        width: '100%',
        height: 80,
        borderRadius: 0,
        background: PHOSPHOR_BG,
        border: `1px solid ${PHOSPHOR_ORANGE}`,
        p: 1.25,
        position: 'relative',
        overflow: 'hidden',
        boxShadow: 'inset 0 0 8px rgba(242,100,0,.1)',
        '&::before': {
          content: '""',
          position: 'absolute',
          inset: 0,
          pointerEvents: 'none',
          background: PHOSPHOR_CRT,
        },
      }}
    >
      <Stack direction="row" spacing={0.75} sx={{ position: 'relative', zIndex: 1 }}>
        <Box sx={{ width: 8, height: 8, background: PHOSPHOR_MINT }} />
        <Box sx={{ width: 40, height: 8, background: PHOSPHOR_AMBER }} />
      </Stack>
      <Box
        sx={{
          mt: 1,
          width: '70%',
          height: 6,
          background: 'rgba(82,242,154,.25)',
          position: 'relative',
          zIndex: 1,
        }}
      />
    </Box>
  );
}

/** @type {import('../registry.js').Skin} */
export const phosphorSkin = {
  ...PHOSPHOR_META,
  Provider: PhosphorProvider,
  Preview: PhosphorPreview,
};
