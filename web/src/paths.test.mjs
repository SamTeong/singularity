import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setHome, tildify, untildify } from './paths.js';

setHome('C:\\Users\\user');

test('tildify collapses HOME prefix, preserving separators', () => {
  assert.equal(tildify('C:\\Users\\user\\wiki'), '~\\wiki');
  assert.equal(tildify('C:\\Users\\user'), '~');
  assert.equal(tildify('C:/Users/user/.agents/x'), '~/.agents/x');
});

test('tildify leaves non-HOME paths and already-tildified paths alone', () => {
  assert.equal(tildify('C:\\git\\singularity'), 'C:\\git\\singularity');
  assert.equal(tildify('~/already'), '~/already');
});

test('tildify is case-insensitive', () => {
  assert.equal(tildify('c:\\users\\user\\wiki'), '~\\wiki');
});

test('untildify expands ~ back to HOME', () => {
  assert.equal(untildify('~\\wiki'), 'C:\\Users\\user\\wiki');
  assert.equal(untildify('~/wiki'), 'C:\\Users\\user/wiki');
  assert.equal(untildify('~'), 'C:\\Users\\user');
});

test('untildify passes through full paths unchanged', () => {
  assert.equal(untildify('C:\\git\\x'), 'C:\\git\\x');
});

test('round-trips through tildify + untildify', () => {
  const full = 'C:\\Users\\user\\wiki';
  assert.equal(untildify(tildify(full)), full);
});
