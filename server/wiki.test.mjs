import assert from 'node:assert/strict';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { test } from 'node:test';

process.env.SINGULARITY_HOME ??= mkdtempSync(join(tmpdir(), 'sing-wiki-'));
const { resolveRoot } = await import('./wiki.mjs');

test('traversal root resolution expands home paths and resolves ordinary paths', () => {
  assert.equal(resolveRoot('~/notes'), join(homedir(), 'notes'));
  assert.equal(resolveRoot(''), null);
  assert.equal(resolveRoot(null), null);
});
