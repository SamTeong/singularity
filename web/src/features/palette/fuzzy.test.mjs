import { test } from 'node:test';
import assert from 'node:assert/strict';
import { score } from './fuzzy.mjs';

test('empty query scores 0 for all', () => {
  assert.equal(score('', { label: 'Tasks' }), 0);
  assert.equal(score('', { label: 'Config', keywords: ['config'] }), 0);
});

test('cfg matches Config via keyword', () => {
  const s = score('cfg', { label: 'Config', keywords: ['config'] });
  assert.notEqual(s, null);
  assert.ok(s > 0);
});

test('tasks matches Tasks via label substring', () => {
  const s = score('tasks', { label: 'Tasks', keywords: ['tasks'] });
  assert.ok(s !== null && s > 0);
});

test('non-match returns null', () => {
  assert.equal(score('zzz', { label: 'Tasks', keywords: ['tasks'] }), null);
});

test('earlier substring beats later', () => {
  const a = score('a', { label: 'abc' });
  const b = score('a', { label: 'xab' });
  assert.ok(a > b, `a=${a} b=${b}`);
});

test('exact keyword alias beats label substring', () => {
  const alias = score('config', { label: 'Config', keywords: ['config'] });
  const sub = score('conf', { label: 'Config', keywords: ['cfg'] });
  assert.ok(alias > sub);
});
