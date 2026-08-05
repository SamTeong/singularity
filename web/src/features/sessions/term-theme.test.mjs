import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getTerminalTheme, TERM_THEME, PHOSPHOR_TERM_THEME } from './term-theme.js';

// Pre-existing ZAPAC palettes (task 6.1) — byte-identical to the table this
// module replaced. Any diff here is a ZAPAC regression, not an improvement.
const ZAPAC_DARK = {
  background: '#0b0813', foreground: '#d9d2ee',
  cursor: '#985b9c', cursorAccent: '#0b0813', selectionBackground: '#985b9c55',
  black: '#0b0813', red: '#ff6b81', green: '#2ec76f', yellow: '#f2a33c',
  blue: '#5b8bff', magenta: '#c58cff', cyan: '#33b5e0', white: '#b6afd4',
  brightBlack: '#7d7699', brightRed: '#ff8fa0', brightGreen: '#5fe0a0', brightYellow: '#ffc46b',
  brightBlue: '#84a8ff', brightMagenta: '#d9b0ff', brightCyan: '#66cdf0', brightWhite: '#f3f0ff',
};
const ZAPAC_LIGHT = {
  background: '#f3f0fb', foreground: '#181320',
  cursor: '#834f88', cursorAccent: '#f3f0fb', selectionBackground: '#985b9c33',
  black: '#181320', red: '#b00020', green: '#088043', yellow: '#8a6d00',
  blue: '#3c69c8', magenta: '#834f88', cyan: '#007299', white: '#524b62',
  brightBlack: '#736c88', brightRed: '#d32f2f', brightGreen: '#2e9e5b', brightYellow: '#a67c00',
  brightBlue: '#4f7fd8', brightMagenta: '#985b9c', brightCyan: '#0090c0', brightWhite: '#181320',
};

test('ZAPAC dark/light palettes are byte-identical to before this change', () => {
  assert.deepEqual(TERM_THEME.dark, ZAPAC_DARK);
  assert.deepEqual(TERM_THEME.light, ZAPAC_LIGHT);
  assert.deepEqual(getTerminalTheme('zapac', 'dark'), ZAPAC_DARK);
  assert.deepEqual(getTerminalTheme('zapac', 'light'), ZAPAC_LIGHT);
});

test('an unknown skin id falls back to the ZAPAC palette', () => {
  assert.deepEqual(getTerminalTheme('nope', 'dark'), ZAPAC_DARK);
  assert.deepEqual(getTerminalTheme('nope', 'light'), ZAPAC_LIGHT);
});

test('Phosphor returns a distinct palette regardless of resolvedMode', () => {
  const phosphor = getTerminalTheme('phosphor', 'dark');
  assert.deepEqual(phosphor, PHOSPHOR_TERM_THEME);
  assert.notDeepEqual(phosphor, ZAPAC_DARK);
  assert.notDeepEqual(phosphor, ZAPAC_LIGHT);
  // Phosphor is dark-only (design.md) — 'light' resolves the same console palette.
  assert.deepEqual(getTerminalTheme('phosphor', 'light'), PHOSPHOR_TERM_THEME);
});

test('Phosphor terminal background is the console void', () => {
  assert.equal(PHOSPHOR_TERM_THEME.background, '#0A0A0A');
});

test('Phosphor never uses safety orange (#F26400) as a data/ANSI color', () => {
  for (const v of Object.values(PHOSPHOR_TERM_THEME)) {
    assert.notEqual(String(v).toLowerCase(), '#f26400');
  }
});

// --- WCAG 2.x contrast helper (relative luminance) -------------------------
// Minimal inline implementation — no shipped runtime dependency; this file is
// the only consumer. https://www.w3.org/TR/WCAG21/#contrast-minimum
function srgbToLinear(c) {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}
function relativeLuminance(hex) {
  const n = hex.replace('#', '');
  const r = parseInt(n.slice(0, 2), 16);
  const g = parseInt(n.slice(2, 4), 16);
  const b = parseInt(n.slice(4, 6), 16);
  const [rl, gl, bl] = [r, g, b].map(srgbToLinear);
  return 0.2126 * rl + 0.7152 * gl + 0.0722 * bl;
}
function contrastRatio(hexA, hexB) {
  const la = relativeLuminance(hexA);
  const lb = relativeLuminance(hexB);
  const [lighter, darker] = la >= lb ? [la, lb] : [lb, la];
  return (lighter + 0.05) / (darker + 0.05);
}

test('Phosphor dim foreground (brightBlack) is AA-legible on the void background', () => {
  const ratio = contrastRatio(PHOSPHOR_TERM_THEME.brightBlack, PHOSPHOR_TERM_THEME.background);
  assert.ok(ratio >= 4.5, `dim foreground contrast ${ratio.toFixed(2)}:1 is below WCAG AA (4.5:1)`);
});

test('Phosphor primary foreground is AA-legible on the void background', () => {
  const ratio = contrastRatio(PHOSPHOR_TERM_THEME.foreground, PHOSPHOR_TERM_THEME.background);
  assert.ok(ratio >= 4.5, `primary foreground contrast ${ratio.toFixed(2)}:1 is below WCAG AA (4.5:1)`);
});
