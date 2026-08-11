import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  trackColor,
  stroke2,
  statusColor,
  statusTone,
  focusRing,
  frameSx,
  chamfer,
  frameGlow,
  terminalRoles,
} from './shellStyles.js';

// A ZAPAC-shaped test double: `getTokens()` prefers `theme.zapac` + the glass
// palette group when `theme.tokens` is absent (see contract.js), so this
// mirrors the *real* runtime shape rather than the shortcut `theme.tokens` path.
function fakeZapacTheme(mode = 'dark') {
  return {
    palette: { mode },
    zapac: {},
    vars: {
      palette: {
        glass: { stroke: 'var(--stroke)', stroke2: 'var(--stroke2)', track: 'var(--track)', chip: 'var(--chip)', cardShadow: 'var(--shadow)' },
        success: { main: 'var(--ok)' },
      },
    },
    roles: {
      chrome: { stroke: 'var(--stroke)', stroke2: 'var(--stroke2)', divider: 'var(--divider)', track: 'var(--track)' },
      status: { nominal: 'var(--ok)', pending: 'var(--info)', caution: 'var(--warn)', critical: 'var(--danger)', idle: 'var(--idle)' },
      focus: { kind: 'shadow', color: 'var(--chip)', width: 3, style: 'solid', offset: 0 },
      shell: { surface: 'var(--bg)', frameBorderWidth: 0, frameBorder: 'none', chamfer: () => 'none', glow: 'var(--shadow)' },
      terminal: { background: 'var(--paper)', foreground: 'var(--text)' },
    },
  };
}

function fakePhosphorTheme() {
  return {
    palette: { mode: 'dark' },
    // Mirrors the real Phosphor shim: `glass` omits track/stroke2/chip.
    tokens: { glass: { surface: '#0A0A0A', blur: '0px', stroke: '#F26400', cardShadow: 'inset 0 0 8px rgba(242,100,0,.1)' } },
    vars: { palette: {} }, // no `success`/`info`/etc. lookalikes needed for these tests
    roles: {
      chrome: { stroke: '#F26400', stroke2: '#246C3C', divider: '#F26400', track: '#246C3C' },
      status: { nominal: '#52F29A', pending: '#5090D0', caution: '#F49F09', critical: '#E2280F', idle: '#3C9C6C' },
      focus: { kind: 'outline', color: '#F49F09', width: 2, style: 'dashed', offset: 2 },
      shell: {
        surface: '#0A0A0A',
        frameBorderWidth: 3,
        frameBorder: '#F26400',
        frameInsetBorder: '#F26400',
        chamfer: (cut = 16) => `polygon(chamfer:${cut})`,
        glow: 'inset 0 0 8px rgba(242,100,0,.1)',
      },
      terminal: { background: '#0A0A0A', foreground: '#F49F09' },
    },
  };
}

test('trackColor prefers the ZAPAC CSS var (byte-for-byte with the pre-role behavior)', () => {
  assert.equal(trackColor(fakeZapacTheme()), 'var(--track)');
});

test('trackColor falls back to roles.chrome.track when the ZAPAC glass group omits it (Phosphor)', () => {
  assert.equal(trackColor(fakePhosphorTheme()), '#246C3C');
});

test('stroke2 prefers the ZAPAC CSS var and falls back to roles.chrome.stroke2 for Phosphor', () => {
  assert.equal(stroke2(fakeZapacTheme()), 'var(--stroke2)');
  assert.equal(stroke2(fakePhosphorTheme()), '#246C3C');
});

test('statusColor resolves via theme.vars.palette.<group>.main first, then roles.status', () => {
  assert.equal(statusColor(fakeZapacTheme(), 'ok'), 'var(--ok)');
  // Phosphor's fake vars.palette has no success/info/etc., so it falls to roles.status.
  assert.equal(statusColor(fakePhosphorTheme(), 'ok'), '#52F29A');
  assert.equal(statusColor(fakePhosphorTheme(), 'danger'), '#E2280F');
});

test('statusTone reads roles.status directly by its own vocabulary', () => {
  assert.equal(statusTone(fakePhosphorTheme(), 'caution'), '#F49F09');
});

test('focusRing renders ZAPAC as a box-shadow ring and Phosphor as a dashed outline', () => {
  assert.deepEqual(focusRing(fakeZapacTheme()), { boxShadow: '0 0 0 3px var(--chip)' });
  assert.deepEqual(focusRing(fakePhosphorTheme()), { outline: '2px dashed #F49F09', outlineOffset: 2 });
});

test('frameSx is a no-op under ZAPAC and the double-frame recipe under Phosphor', () => {
  assert.deepEqual(frameSx(fakeZapacTheme()), {});
  const sx = frameSx(fakePhosphorTheme());
  assert.equal(sx.border, '3px solid #F26400');
  assert.equal(sx.clipPath, 'polygon(chamfer:16)');
  assert.equal(sx.boxShadow, 'inset 0 0 8px rgba(242,100,0,.1)');
  // The inset second rule (docs/one-shot/phosphor-layout-02.html's `.frame::before`).
  assert.deepEqual(sx['&::before'], {
    content: '""',
    position: 'absolute',
    inset: '6px',
    border: '1px solid #F26400',
    opacity: 0.4,
    pointerEvents: 'none',
  });
});

test('frameSx omits the inset rule when frameInsetBorder is "none" (ZAPAC-shaped shell with a frame)', () => {
  const t = fakePhosphorTheme();
  t.roles.shell.frameInsetBorder = 'none';
  assert.equal(frameSx(t)['&::before'], undefined);
});

test('chamfer resolves through roles.shell.chamfer and never throws on a bare theme', () => {
  assert.equal(chamfer(fakeZapacTheme()), 'none');
  assert.equal(chamfer(fakePhosphorTheme(), 28), 'polygon(chamfer:28)');
  assert.equal(chamfer({}), 'none');
});

test('frameGlow reads roles.shell.glow', () => {
  assert.equal(frameGlow(fakePhosphorTheme()), 'inset 0 0 8px rgba(242,100,0,.1)');
});

test('terminalRoles is a thin pass-through to roles.terminal', () => {
  assert.deepEqual(terminalRoles(fakePhosphorTheme()), { background: '#0A0A0A', foreground: '#F49F09' });
});
