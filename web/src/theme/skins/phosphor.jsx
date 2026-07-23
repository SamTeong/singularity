/**
 * Phosphor Console skin — NERV/MAGI tactical CRT command deck.
 *
 * Wraps the vendored `phosphor-console-theme` (a full dark-only cssVariables MUI
 * theme). Its structural tokens live under `theme.nerv.*` and its surface colours
 * under `theme.vars.palette.nerv.*` — a different namespace from ZAPAC's.
 *
 * This adapter bridges Phosphor to the app in two ways, both applied once at load:
 *
 *  1. `theme.tokens` — the normalized bundle {@link module:theme/contract getTokens}
 *     reads, so the app's own components (which call getTokens) are skin-agnostic.
 *
 *  2. ZAPAC-compat layer (`theme.zapac` + `theme.vars.palette.glass`) — the app
 *     still uses a few @zapac house components (StatusPill, EmptyState, SearchInput)
 *     that hardcode `theme.zapac.*` / `theme.vars.palette.glass.*`. Those reads throw
 *     on a theme without that shape. Until those components are replaced with
 *     skin-neutral equivalents (the UI-theming pass), this shim maps Phosphor's
 *     `nerv` tokens onto the ZAPAC namespace so they render instead of crashing.
 *     Remove it once no @zapac component remains.
 */
import { ThemeProvider } from '@mui/material/styles';
import CssBaseline from '@mui/material/CssBaseline';
import InitColorSchemeScript from '@mui/material/InitColorSchemeScript';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import { theme as phosphorTheme } from 'phosphor-console-theme/theme';

if (!phosphorTheme.tokens) {
  const n = phosphorTheme.nerv;
  const v = phosphorTheme.vars.palette;

  // Radius: Phosphor is sharp (chips 2px, segments 4px, hero chamfer). Alias the
  // ZAPAC scale (sm/md/lg/pill) onto it so both getTokens and @zapac components resolve.
  const radius = { ...n.radius, sm: n.radius.chip, md: n.radius.seg, lg: n.radius.seg, pill: n.radius.chip };
  // Fonts: Phosphor UI type is mono. Provide the `ui` alias @zapac expects.
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
  // ── ZAPAC-compat shim (temporary — see file header) ──
  phosphorTheme.zapac = { radius, fonts, space: n.space, layers: n.layers, motion };
  phosphorTheme.vars.palette.glass = glass;
  phosphorTheme.palette.glass = glass;
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
  id: 'phosphor',
  label: 'Phosphor Console',
  description: 'NERV/MAGI tactical CRT command deck — colour is state.',
  Provider: PhosphorProvider,
  Preview: PhosphorPreview,
  supportsColorMode: false, // dark-only
};
