// Unit test for stripQueries: replayed scrollback (case 'attach' in
// attachPtyWs) must have terminal *query* escape sequences removed so
// xterm.js doesn't re-answer a stale query and leak the late reply into
// whatever the app currently has focused (see stripQueries's comment in
// pty-ws.mjs). pty-ws.mjs imports agents.mjs, whose APP_DIR derives from
// SINGULARITY_HOME — pointed at a scratch temp dir before a dynamic import,
// same convention as crons.test.mjs. Run: npm test  (node --test server/)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const scratch = mkdtempSync(join(tmpdir(), 'singularity-pty-ws-test-'));
process.env.SINGULARITY_HOME = join(scratch, 'singularity');
after(() => rmSync(scratch, { recursive: true, force: true }));

const { stripQueries, stripColorResponses } = await import('./pty-ws.mjs');

test('stripQueries: removes each covered query sequence', () => {
  assert.equal(stripQueries('\x1b[c'), ''); // DA1
  assert.equal(stripQueries('\x1b[0c'), ''); // DA1
  assert.equal(stripQueries('\x1b[>c'), ''); // DA2
  assert.equal(stripQueries('\x1b[>0c'), ''); // DA2 with param
  assert.equal(stripQueries('\x1b[=c'), ''); // DA3
  assert.equal(stripQueries('\x1b[5n'), ''); // DSR status
  assert.equal(stripQueries('\x1b[6n'), ''); // DSR cursor position
  assert.equal(stripQueries('\x1b]10;?\x07'), ''); // OSC 10 (fg), BEL-terminated
  assert.equal(stripQueries('\x1b]11;?\x1b\\'), ''); // OSC 11 (bg), ST-terminated
  assert.equal(stripQueries('\x1b]12;?\x07'), ''); // OSC 12 (cursor color)
  assert.equal(stripQueries('\x1bP+q544e\x1b\\'), ''); // XTGETTCAP
  assert.equal(stripQueries('\x1b[?u'), ''); // kitty keyboard protocol query
});

test('stripQueries: strips only the query, leaving surrounding output intact', () => {
  const input = 'hello\x1b[c\x1b]10;?\x07world';
  assert.equal(stripQueries(input), 'helloworld');
});

test('stripQueries: leaves ordinary output byte-identical', () => {
  const samples = [
    'plain text',
    '\x1b[31mred\x1b[0m',
    '\x1b[2J',
    '\x1b[10;5H',
  ];
  for (const s of samples) assert.equal(stripQueries(s), s);
});

test('stripColorResponses: removes automatic OSC colour replies from live input', () => {
  const reply = '\x1b]10;rgb:d9d9/d2d2/eeee\x1b\\\x1b]11;rgb:0b0b/0808/1313\x1b\\';
  assert.equal(stripColorResponses(reply), '');
  assert.equal(stripColorResponses(`before${reply}after`), 'beforeafter');
});

test('stripColorResponses: leaves normal input byte-identical', () => {
  assert.equal(stripColorResponses('hello\x1b[A'), 'hello\x1b[A');
});
