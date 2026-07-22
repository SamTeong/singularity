/**
 * Phosphor Console skin — SCAFFOLD (not yet registered).
 *
 * A NERV/MAGI tactical console skin: a black CRT command deck where colour IS
 * state (mint nominal · orange chrome · blue pending · amber caution · red
 * critical), depth comes from border + glow + hue, and type is bimodal mono.
 * See the `phosphor-console` skill for the full design language.
 *
 * ── Why this is a scaffold, not a working skin yet ──────────────────────────
 * Under MUI's `cssVariables` theming, app components read `theme.vars.palette.*`
 * (the scheme-switching CSS-var reference). A real second skin must therefore be
 * a *fully built* theme — its own `createTheme({ cssVariables, colorSchemes,
 * ... , zapac: { radius, space, fonts, motion, layers } })` — so that
 * `theme.vars.palette.glass` and the `zapac.*` token namespace resolve. Nesting
 * a plain override under the ZAPAC provider would update `theme.palette` but not
 * the generated CSS vars, so it would not take visual effect. Building that full
 * theme is Phase 5.
 *
 * ── To activate, once the theme below is built ──────────────────────────────
 *   import { registerSkin } from '../registry.js';
 *   import { phosphorSkin } from './skins/phosphor.jsx';
 *   registerSkin(phosphorSkin);
 * The switcher and provider pick it up with no further changes — that is the
 * whole point of the registry.
 */

// import { ThemeProvider } from '@mui/material/styles';
// import CssBaseline from '@mui/material/CssBaseline';
// import { createPhosphorTheme } from './phosphor.theme.js';  // Phase 5
//
// function PhosphorProvider({ children, defaultMode = 'dark' }) {
//   const theme = createPhosphorTheme(defaultMode);
//   return (
//     <ThemeProvider theme={theme} defaultMode={defaultMode} disableTransitionOnChange>
//       <CssBaseline />
//       {children}
//     </ThemeProvider>
//   );
// }
//
// /** @type {import('../registry.js').Skin} */
// export const phosphorSkin = {
//   id: 'phosphor',
//   label: 'Phosphor Console',
//   description: 'NERV/MAGI tactical CRT command deck — colour is state.',
//   Provider: PhosphorProvider,
//   supportsColorMode: false, // console is dark-only
// };

export {};
