// Unit tests for the memory path guard (isMemoryPath) — the write-confinement
// boundary. Run: npm test  (node --test server/)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { isMemoryPath } from './memory.mjs';

const PROJECTS = join(homedir(), '.claude', 'projects');
const mem = (...parts) => join(PROJECTS, ...parts);

test('accepts a .md file directly under a project memory/ dir', () => {
  assert.equal(isMemoryPath(mem('C--git-x', 'memory', 'a-fact.md')), true);
  assert.equal(isMemoryPath(mem('proj', 'memory', 'sub', 'nested.md')), true);
});

test('rejects non-.md, non-memory dirs, escapes, and empty', () => {
  assert.equal(isMemoryPath(mem('proj', 'memory', 'a.txt')), false); // wrong ext
  assert.equal(isMemoryPath(mem('proj', 'notes', 'a.md')), false); // not memory/
  assert.equal(isMemoryPath(mem('proj', 'a.md')), false); // no memory/ segment
  assert.equal(isMemoryPath(mem('memory', 'a.md')), false); // missing project segment
  assert.equal(isMemoryPath(join(homedir(), 'evil.md')), false); // outside projects root
  assert.equal(isMemoryPath(mem('proj', 'memory', '..', '..', 'escape.md')), false);
  assert.equal(isMemoryPath(''), false);
  assert.equal(isMemoryPath(null), false);
});
