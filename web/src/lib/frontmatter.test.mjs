import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFrontmatter } from './frontmatter.js';

test('parseFrontmatter splits meta (scalars + [lists], CRLF) from the body', () => {
  assert.deepEqual(parseFrontmatter('---\r\ntitle: Home\r\ntags: [a, b, ]\r\nnot a pair\r\n---\r\n# Body'), {
    meta: { title: 'Home', tags: ['a', 'b'] },
    body: '# Body',
  });
  assert.deepEqual(parseFrontmatter('url: http://x:1\n'), { meta: {}, body: 'url: http://x:1\n' });
  assert.deepEqual(parseFrontmatter('---\nurl: http://x:1\n---\n').meta, { url: 'http://x:1' });
});
