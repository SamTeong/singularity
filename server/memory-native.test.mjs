import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRustBackend } from './rust-backend.mjs';

test('Memory reads use the persistent Rust stdio bridge and invalidate cached lines', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'sing-memory-native-'));
  const root = join(scratch, 'projects');
  const alpha = join(root, 'alpha', 'memory');
  const beta = join(root, 'beta', 'memory');
  mkdirSync(alpha, { recursive: true });
  mkdirSync(beta, { recursive: true });
  const fact = join(alpha, 'z-fact.MD');
  writeFileSync(fact, 'first\r\n  Needle 😀 and more  \r\nlast\n');
  writeFileSync(join(alpha, 'a-fact.md'), 'needle second');
  const longLine = `needle ${'x'.repeat(192)}😀tail`;
  writeFileSync(join(alpha, 'long.md'), `${longLine}\n`);
  writeFileSync(join(beta, 'fact.md'), 'other');
  writeFileSync(join(beta, 'ignore.txt'), 'needle ignored');
  const broken = join(beta, 'broken.md');
  writeFileSync(broken, Buffer.from([0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65, 0x20, 0xff]));

  const backend = createRustBackend({ binaryPath: process.env.SINGULARITY_RUST_BACKEND_BINARY });
  const home = mkdtempSync(join(tmpdir(), 'sing-memory-native-home-'));
  process.env.SINGULARITY_HOME = home;
  const memory = await import('./memory.mjs');
  await backend.start();
  memory.setMemoryRoot(root);
  let guardedReads = 0;
  memory.setMemoryReadBackend({
    ...backend,
    async memoryRead(path) { guardedReads++; return backend.memoryRead(path); },
  });
  try {
    const files = await memory.listFiles(root);
    assert.deepEqual(files.map(({ project, file }) => `${project}/${file}`), ['alpha/a-fact.md', 'alpha/long.md', 'alpha/z-fact.MD', 'beta/broken.md', 'beta/fact.md']);
    const matches = await memory.searchMemory('needle', root);
    assert.deepEqual(matches.results.map(({ project, file, line, text }) => ({ project, file, line, text }))
      .sort((a, b) => a.project.localeCompare(b.project) || a.file.localeCompare(b.file)), [
      { project: 'alpha', file: 'a-fact.md', line: 1, text: 'needle second' },
      { project: 'alpha', file: 'long.md', line: 1, text: longLine.trim().slice(0, 200) },
      { project: 'alpha', file: 'z-fact.MD', line: 2, text: 'Needle 😀 and more' },
      { project: 'beta', file: 'broken.md', line: 1, text: 'needle �' },
    ]);
    assert.equal(matches.capped, false);
    const longMatch = matches.results.find((hit) => hit.file === 'long.md');
    assert.equal(longMatch.text.length, 200);
    assert.equal(longMatch.text.charCodeAt(199), 0xd83d);
    const read = await memory.readMemoryFile(fact, root);
    assert.equal(read.ok, true);
    assert.equal(read.content, 'first\r\n  Needle 😀 and more  \r\nlast\n');
    assert.equal(typeof read.mtime, 'number');

    const beforeRejectedRead = guardedReads;
    const rejected = await memory.readMemoryFile(join(scratch, 'outside.md'), root);
    assert.deepEqual(rejected, { ok: false, error: 'path outside memory dirs' });
    assert.equal(guardedReads, beforeRejectedRead);

    writeFileSync(fact, 'replacement needle\n');
    const future = (Date.now() + 5000) / 1000;
    utimesSync(fact, future, future);
    const refreshed = await memory.searchMemory('needle', root);
    assert.equal(refreshed.results.some((hit) => hit.file === 'z-fact.MD' && hit.line === 1 && hit.text === 'replacement needle'), true);

    const crowded = join(beta, 'crowded.md');
    writeFileSync(crowded, Array.from({ length: 301 }, (_, index) => `hit ${index}`).join('\n'));
    const capped = await memory.searchMemory('hit', root);
    assert.equal(capped.results.length, 300);
    assert.equal(capped.capped, true);

    const orderedRoot = join(scratch, 'ordered-projects');
    const projects = ['zeta', 'Alpha', 'éclair'];
    const names = ['z.md', 'B.md', 'a.md', 'é.md'];
    for (const project of projects) {
      const dir = join(orderedRoot, project, 'memory');
      mkdirSync(dir, { recursive: true });
      for (const name of names) {
        const lines = Array.from({ length: 31 }, (_, index) => `needle ${project}/${name}/${index + 1}`);
        writeFileSync(join(dir, name), lines.join('\n'));
      }
    }
    const localeNames = [...names].sort((a, b) => a.localeCompare(b));
    assert.notDeepEqual(localeNames, [...names].sort());
    const expected = [...projects].sort((a, b) => a.localeCompare(b)).flatMap((project) =>
      localeNames.flatMap((name) => Array.from({ length: 31 }, (_, index) => ({
        project,
        file: name,
        path: join(orderedRoot, project, 'memory', name),
        line: index + 1,
        text: `needle ${project}/${name}/${index + 1}`,
      }))),
    ).slice(0, 300);
    const orderedCap = await memory.searchMemory('needle', orderedRoot);
    assert.deepEqual(orderedCap.results, expected);
    assert.equal(orderedCap.capped, true);
    const missing = await backend.memoryRead(join(root, 'missing.md'));
    assert.deepEqual(missing, { ok: false, error: 'not found' });
  } finally {
    memory.setMemoryReadBackend(null);
    await backend.stop();
    rmSync(scratch, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
