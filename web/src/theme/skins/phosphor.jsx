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
// (#E2280F), which reaches only 4.28:1 on the void surface — under AA's 4.5:1
// for normal text. Filling does NOT rescue it: contrast is a property of the
// pair, so black-on-`#E2280F` is the same 4.28:1 as `#E2280F`-on-black. Both
// the plain-text uses (`color: 'error.main'` in UsageReportView, SkillsPanel,
// CronJobs, SaveBar, MermaidBlock) and the filled red Stamp/StatusPill
// inversion therefore failed. `#F04438` is the nearest in-hue red clearing AA
// in both directions (5.27:1 either way), so the filled-control grammar is
// unchanged and red text becomes legible. The vendored tarball is not modified
// (design.md D2); this is an adapter-level semantic-token adjustment sourced
// from the same red family rather than a new ad-hoc color.
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

  // AA override (see PHOSPHOR_ERROR_AA above). The authoritative assignment is
  // `nerv.hue.redHi`: it is read AT RENDER by the vendored `toneHue(t,'red')`
  // (components/util.ts) and by every vendored `.Mui-error` override, so this
  // single line is what actually reaches the pixels — every red `Stamp`,
  // `StatusPill`, disconnected daemon readout, failed task card and dossier
  // head. Mutating the palette alone does NOT work: MUI's `CssVarsProvider`
  // rebuilds `theme.vars` from a map computed at `createTheme()` time, so a
  // post-hoc `vars.palette.error.main` write is discarded and reads resolve to
  // the string `var(--mui-palette-error-main)` instead. (`style.css` then has
  // to keep its ZAPAC `--mui-palette-error-main` override off this skin, or it
  // wins at the variable level regardless — see the `:not([data-skin=...])`
  // there.) The `palette.error.main` write below is still worth keeping for the
  // non-var read path; it is not sufficient on its own.
  phosphorTheme.nerv.hue.redHi = PHOSPHOR_ERROR_AA;
  if (phosphorTheme.palette?.error) phosphorTheme.palette.error.main = PHOSPHOR_ERROR_AA;
  if (phosphorTheme.vars?.palette?.error) phosphorTheme.vars.palette.error.main = PHOSPHOR_ERROR_AA;

  // ── Content-vs-chrome casing (task 7.3) ───────────────────────────────────
  // design.md's non-goals are explicit that the all-caps grammar applies to UI
  // chrome only — user prose, paths and source keep their original case. Three
  // vendored overrides break that because, in THIS app, they land on content:
  //   · MuiInputBase.input  — every text field shows the user's own typed value
  //     (task titles/descriptions, cwd paths, all search boxes) in caps.
  //   · MuiListItemText.primary — filesystem paths in the Config, Rules, Hooks,
  //     Skills, Wiki and DirPicker panels.
  //   · typography.subtitle2 — task-card, session and cron-job titles (9 of its
  //     10 call sites are content, not chrome).
  // Reset casing on those three only; genuinely-chrome surfaces (labels,
  // headers, stamps, buttons, nav) are untouched and stay uppercase.
  // `textTransform` is presentation-only, so DOM text — and therefore every
  // accessible name the e2e suite matches on — is unchanged.
  const uncased = (prev) => (props) => ({
    ...(typeof prev === 'function' ? prev(props) : prev),
    textTransform: 'none',
  });
  const io = phosphorTheme.components?.MuiInputBase?.styleOverrides;
  if (io) {
    const prev = io.input;
    io.input = (props) => {
      const base = typeof prev === 'function' ? prev(props) : prev;
      return {
        ...base,
        textTransform: 'none',
        '&::placeholder': {
          ...base?.['&::placeholder'],
          // AA (task 7.4): the vendored placeholder is `hue.greenDim` (#246C3C),
          // 3.10:1 on void — below AA. `hue.greenMap` is the theme's own
          // secondary-text hue at 5.81:1.
          color: n.hue.greenMap,
          textTransform: 'none',
        },
      };
    };
  }
  const lo = phosphorTheme.components?.MuiListItemText?.styleOverrides;
  if (lo) lo.primary = uncased(lo.primary);
  // Helper text under form fields is full English prose AND often carries
  // literal identifiers whose casing is meaningful — e.g. "Set CODEX_BIN in
  // .env to enable Codex agent/task spawns." was rendering as "SET CODEX_BIN
  // IN .ENV …". Uppercasing it is a content-integrity bug, not a style choice.
  const fh = phosphorTheme.components?.MuiFormHelperText?.styleOverrides;
  if (fh) fh.root = uncased(fh.root);
  // Select values are content too (model ids, scopes, directory paths).
  const so = phosphorTheme.components?.MuiSelect?.styleOverrides;
  if (so) so.select = uncased(so.select);
  if (phosphorTheme.typography?.subtitle2) phosphorTheme.typography.subtitle2.textTransform = 'none';

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
