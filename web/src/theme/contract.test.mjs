import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getTokens,
  getRoles,
  assertSkinContract,
  REQUIRED_TOKEN_GROUPS,
  REQUIRED_ROLE_GROUPS,
} from './contract.js';
import { buildZapacRoles } from './skins/zapac.roles.js';
import { buildPhosphorRoles } from './skins/phosphor.roles.js';

// Minimal same-shaped test doubles for the two vendored themes — small enough
// to hand-construct so this file never needs the JSX/TS loader the real
// `@zapac/mui-theme` / `phosphor-console-theme` packages require.

function fakeZapacTheme() {
  return {
    vars: {
      palette: {
        background: { default: 'var(--bg)', paper: 'var(--paper)' },
        glass: { chip: 'var(--chip)', stroke: 'var(--stroke)', stroke2: 'var(--stroke2)', track: 'var(--track)', cardShadow: 'var(--shadow)' },
        divider: 'var(--divider)',
        success: { main: 'var(--ok)' },
        info: { main: 'var(--info)' },
        warning: { main: 'var(--warn)' },
        error: { main: 'var(--danger)' },
        text: { primary: 'var(--text)', secondary: 'var(--text2)', disabled: 'var(--text-disabled)' },
        primary: { main: 'var(--brand)' },
      },
    },
    transitions: {
      easing: { easeInOut: 'cubic-bezier(.65,.05,.36,1)' },
      duration: { shortest: 200, standard: 400 },
    },
  };
}

function fakePhosphorTheme() {
  const hue = {
    void: '#0A0A0A', mint: '#52F29A', greenMap: '#3C9C6C', greenDim: '#246C3C',
    orange: '#F26400', amber: '#F49F09', red: '#C20C0C', redHi: '#E2280F', blue: '#5090D0',
  };
  return {
    nerv: {
      hue,
      chamfer: (cut = 16) => `polygon(chamfer:${cut})`,
      motion: {
        linear: 'linear',
        step: 'steps(4, jump-none)',
        snap: 'steps(1, jump-none)',
        durations: { snap: 80, fast: 120, blink: 1000 },
      },
    },
    vars: {
      palette: {
        background: { default: hue.void, paper: hue.void },
        nerv: {
          stroke: hue.orange, stroke2: hue.greenDim, track: hue.greenDim,
          glowPanel: 'inset 0 0 8px rgba(242,100,0,.1)', termText: hue.amber, termDim: '#C67A5A',
        },
      },
    },
  };
}

test('getTokens falls back to EMPTY groups for a bare theme', () => {
  const tokens = getTokens({});
  for (const g of REQUIRED_TOKEN_GROUPS) assert.deepEqual(tokens[g], {});
});

test('getRoles falls back to EMPTY groups for a bare theme', () => {
  const roles = getRoles({});
  for (const g of REQUIRED_ROLE_GROUPS) assert.deepEqual(roles[g], {});
});

test('getRoles reads theme.roles when present', () => {
  const roles = { shell: { a: 1 } };
  assert.equal(getRoles({ roles }), roles);
});

test('buildZapacRoles satisfies every required role group', () => {
  const roles = buildZapacRoles(fakeZapacTheme());
  for (const g of REQUIRED_ROLE_GROUPS) {
    assert.ok(roles[g] && Object.keys(roles[g]).length > 0, `missing role group: ${g}`);
  }
});

test('buildPhosphorRoles satisfies every required role group', () => {
  const roles = buildPhosphorRoles(fakePhosphorTheme());
  for (const g of REQUIRED_ROLE_GROUPS) {
    assert.ok(roles[g] && Object.keys(roles[g]).length > 0, `missing role group: ${g}`);
  }
});

test('assertSkinContract warns on a bare theme and stays silent on a fully-populated one', () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (msg) => warnings.push(msg);
  try {
    assertSkinContract({}, 'bare');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /bare/);

    const zapacTheme = fakeZapacTheme();
    zapacTheme.tokens = { radius: { sm: 1 }, layers: { a: 1 }, glass: zapacTheme.vars.palette.glass, fonts: { ui: 'sans' } };
    zapacTheme.roles = buildZapacRoles(zapacTheme);
    assertSkinContract(zapacTheme, 'zapac');

    const phosphorTheme = fakePhosphorTheme();
    phosphorTheme.tokens = { radius: { chip: 2 }, layers: { base: 0 }, glass: { surface: '#000' }, fonts: { mono: 'monospace' } };
    phosphorTheme.roles = buildPhosphorRoles(phosphorTheme);
    assertSkinContract(phosphorTheme, 'phosphor');

    assert.equal(warnings.length, 1); // no new warnings from the two fully-populated themes
  } finally {
    console.warn = originalWarn;
  }
});

test('Phosphor roles never use orange as a status color (chrome-only)', () => {
  const roles = buildPhosphorRoles(fakePhosphorTheme());
  const orange = fakePhosphorTheme().nerv.hue.orange;
  for (const v of Object.values(roles.status)) assert.notEqual(v, orange);
});

test('ZAPAC has no frame chrome; Phosphor has the double-frame recipe', () => {
  const zapacRoles = buildZapacRoles(fakeZapacTheme());
  assert.equal(zapacRoles.shell.frameBorderWidth, 0);
  assert.equal(zapacRoles.shell.chamfer(), 'none');

  const phosphorRoles = buildPhosphorRoles(fakePhosphorTheme());
  assert.equal(phosphorRoles.shell.frameBorderWidth, 3);
  assert.equal(typeof phosphorRoles.shell.chamfer, 'function');
  assert.match(phosphorRoles.shell.chamfer(28), /chamfer:28/);
});

test('focus role grammar differs by skin (shadow vs. outline)', () => {
  assert.equal(buildZapacRoles(fakeZapacTheme()).focus.kind, 'shadow');
  assert.equal(buildPhosphorRoles(fakePhosphorTheme()).focus.kind, 'outline');
});
