// xterm ANSI palette resolver — the single source of truth for the machine-
// output layer, shared by the live Terminal (xterm theme) and the read-only
// TranscriptView (CSS mimic) so a restyle of one never drifts from the other.
//
// Resolved by *skin* (design.md D6) as well as color mode: ZAPAC keeps its
// existing light/dark palettes unchanged; Phosphor is dark-only and always
// returns its void/amber console palette regardless of `resolvedMode` (kept in
// the signature for symmetry with the ZAPAC branch and so a future dark-only
// skin has the same shape to fill in).

// ZAPAC's existing palettes — UNCHANGED. Built for a dark background; the
// light variant is retuned so the default 16-color ANSI palette stays legible
// on white.
export const TERM_THEME = {
  dark: {
    background: '#0b0813', foreground: '#d9d2ee',
    cursor: '#985b9c', cursorAccent: '#0b0813', selectionBackground: '#985b9c55',
    black: '#0b0813', red: '#ff6b81', green: '#2ec76f', yellow: '#f2a33c',
    blue: '#5b8bff', magenta: '#c58cff', cyan: '#33b5e0', white: '#b6afd4',
    brightBlack: '#7d7699', brightRed: '#ff8fa0', brightGreen: '#5fe0a0', brightYellow: '#ffc46b',
    brightBlue: '#84a8ff', brightMagenta: '#d9b0ff', brightCyan: '#66cdf0', brightWhite: '#f3f0ff',
  },
  light: {
    background: '#f3f0fb', foreground: '#181320',
    cursor: '#834f88', cursorAccent: '#f3f0fb', selectionBackground: '#985b9c33',
    black: '#181320', red: '#b00020', green: '#088043', yellow: '#8a6d00',
    blue: '#3c69c8', magenta: '#834f88', cyan: '#007299', white: '#524b62',
    brightBlack: '#736c88', brightRed: '#d32f2f', brightGreen: '#2e9e5b', brightYellow: '#a67c00',
    brightBlue: '#4f7fd8', brightMagenta: '#985b9c', brightCyan: '#0090c0', brightWhite: '#181320',
  },
};

// Phosphor's console palette — every value traces to the vendored
// `phosphor-console-theme` tokens (`theme/tokens.ts`'s `hue`/`terminal`
// groups), never a new hex literal. Void background; AA-legible amber primary
// foreground/cursor; AA-legible dim rust (`terminal.dim`, ~5.97:1 on void —
// see term-theme.test.mjs) for secondary/dim text. ANSI success -> mint,
// pending/info -> blue, caution/warning -> amber, error -> red — safety orange
// never appears (chrome-only, per design.md D4).
export const PHOSPHOR_TERM_THEME = {
  background: '#0A0A0A', foreground: '#F49F09',
  cursor: '#F49F09', cursorAccent: '#0A0A0A', selectionBackground: '#F49F0955',
  black: '#0A0A0A', red: '#C20C0C', green: '#52F29A', yellow: '#F49F09',
  blue: '#5090D0', magenta: '#E60225', cyan: '#0C6C80', white: '#EDF8D6',
  brightBlack: '#C67A5A', brightRed: '#E2280F', brightGreen: '#7CF4AB', brightYellow: '#F49F09',
  brightBlue: '#5090D0', brightMagenta: '#E60225', brightCyan: '#0C6C80', brightWhite: '#EDF8D6',
};

/**
 * Resolve the active xterm/ANSI palette for a skin + color mode (design.md
 * D6). ZAPAC returns its existing light/dark palette unchanged; Phosphor
 * (dark-only) always returns its console palette. Unknown skin ids fall back
 * to ZAPAC, mirroring `resolveSkin`'s default-skin fallback.
 * @param {string} skinId active skin id (`'zapac'` | `'phosphor'`)
 * @param {'light'|'dark'} resolvedMode active ZAPAC color mode (ignored for Phosphor)
 * @returns {object} an xterm `ITheme`-shaped palette
 */
export function getTerminalTheme(skinId, resolvedMode) {
  if (skinId === 'phosphor') return PHOSPHOR_TERM_THEME;
  return TERM_THEME[resolvedMode === 'light' ? 'light' : 'dark'];
}
