// xterm ANSI palette tuned per color mode — the single source of truth for the
// machine-output layer. Shared by the live Terminal (xterm theme) and the
// read-only TranscriptView (CSS mimic), so a restyle of one never drift from the
// other. Built for a dark background; the light variant is retuned so the
// default 16-color ANSI palette stays legible on white.
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