import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerSkin, getSkin, listSkins, DEFAULT_SKIN_ID } from './registry.js';
import { ZAPAC_META } from './skins/zapac.meta.js';
import { PHOSPHOR_META } from './skins/phosphor.meta.js';

const fakeSkin = (id, extra = {}) => ({ id, label: id.toUpperCase(), Provider: () => null, ...extra });

test('registerSkin returns the registered skin and defaults supportsColorMode', () => {
  const s = registerSkin(fakeSkin('alpha'));
  assert.equal(s.id, 'alpha');
  assert.equal(s.supportsColorMode, true);
});

test('registerSkin preserves an explicit supportsColorMode', () => {
  const s = registerSkin(fakeSkin('beta', { supportsColorMode: false }));
  assert.equal(s.supportsColorMode, false);
});

test('getSkin looks up by id, undefined when absent', () => {
  registerSkin(fakeSkin('gamma'));
  assert.equal(getSkin('gamma').id, 'gamma');
  assert.equal(getSkin('nope'), undefined);
});

test('re-registering an id replaces rather than duplicates', () => {
  registerSkin(fakeSkin('delta', { label: 'first' }));
  const before = listSkins().filter((s) => s.id === 'delta').length;
  registerSkin(fakeSkin('delta', { label: 'second' }));
  const after = listSkins().filter((s) => s.id === 'delta');
  assert.equal(before, 1);
  assert.equal(after.length, 1);
  assert.equal(after[0].label, 'second');
});

test('registerSkin rejects a skin without id or Provider', () => {
  assert.throws(() => registerSkin({ label: 'x', Provider: () => null }), /needs an `id`/);
  assert.throws(() => registerSkin({ id: 'x' }), /Provider/);
});

test('DEFAULT_SKIN_ID is zapac', () => {
  assert.equal(DEFAULT_SKIN_ID, 'zapac');
});

test('ZAPAC remains the default skin and supports color-mode toggling', () => {
  assert.equal(ZAPAC_META.id, DEFAULT_SKIN_ID);
  assert.equal(ZAPAC_META.supportsColorMode, true);
});

test('Phosphor Console is dark-only', () => {
  assert.equal(PHOSPHOR_META.id, 'phosphor');
  assert.equal(PHOSPHOR_META.supportsColorMode, false);
});

test('registering the real built-in skin metadata round-trips through the registry', () => {
  const zapac = registerSkin({ ...ZAPAC_META, Provider: () => null });
  assert.equal(zapac.supportsColorMode, true);

  const phosphor = registerSkin({ ...PHOSPHOR_META, Provider: () => null });
  assert.equal(phosphor.supportsColorMode, false);
  assert.equal(getSkin('phosphor').supportsColorMode, false);
});
