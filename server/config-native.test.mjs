import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRustBackend } from './rust-backend.mjs';

test('Claude config read, search, and scan use the Rust stdio bridge', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'sing-config-native-'));
  const backend = createRustBackend({ binaryPath: process.env.SINGULARITY_RUST_BACKEND_BINARY });
  try {
    await backend.start();

    const missing = await backend.configRead(join(scratch, 'missing.json'));
    assert.deepEqual(missing, { exists: false, content: '', mtime: 0 });

    const root = join(scratch, 'project');
    const claude = join(root, '.claude');
    mkdirSync(claude, { recursive: true });
    const project = join(claude, 'settings.json');
    const local = join(claude, 'settings.local.json');
    const longLine = `needle ${'x'.repeat(192)}😀tail`;
    writeFileSync(project, `ignored\n${longLine}\nneedle duplicate\n"theme":"ΟΣ"\n`);
    writeFileSync(local, 'local settings');

    const brokenUtf8 = join(scratch, 'replacement.json');
    writeFileSync(brokenUtf8, Buffer.from([0x7b, 0xff, 0x7d]));
    const read = await backend.configRead(brokenUtf8);
    assert.equal(read.exists, true);
    assert.equal(read.content, '{\u{fffd}}');
    assert.equal(typeof read.mtime, 'number');

    const roots = [{ cwd: root, project, local }, { cwd: root, project, local }];
    const matches = await backend.configSearch(roots, 'needle');
    assert.equal(matches.length, 1);
    assert.deepEqual(matches[0], {
      cwd: root,
      scope: 'project',
      path: project,
      line: 2,
      text: longLine.trim().slice(0, 200),
    });
    assert.equal(matches[0].text.length, 200);
    assert.equal(matches[0].text.charCodeAt(199), 0xd83d);

    const greek = await backend.configSearch([{ cwd: root, project, local }], 'ος');
    assert.equal(greek.length, 1);
    assert.equal(greek[0].line, 4);

    const child = join(root, 'child');
    const hidden = join(root, '.hidden');
    const dependency = join(root, 'node_modules', 'pkg');
    for (const dir of [join(child, '.claude'), join(hidden, '.claude'), join(dependency, '.claude')]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'settings.json'), '{}');
    }
    const fullScan = await backend.configScan(root, 20000);
    assert.deepEqual(fullScan, { roots: [root, child].sort((a, b) => a.localeCompare(b)), truncated: false });
    const cappedScan = await backend.configScan(root, 1);
    assert.deepEqual(cappedScan, { roots: [root], truncated: true });
  } finally {
    await backend.stop();
    rmSync(scratch, { recursive: true, force: true });
  }
});
