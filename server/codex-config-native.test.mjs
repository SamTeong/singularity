import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRustBackend } from './rust-backend.mjs';

test('Codex config read, search, and scan use the Rust stdio bridge', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'sing-codex-config-native-'));
  const backend = createRustBackend({ binaryPath: process.env.SINGULARITY_RUST_BACKEND_BINARY });
  try {
    await backend.start();
    const missing = await backend.codexConfigRead(join(scratch, 'missing.toml'));
    assert.deepEqual(missing, { exists: false, content: '', mtime: 0 });

    const root = join(scratch, 'project');
    const projectDir = join(root, '.codex');
    const project = join(projectDir, 'config.toml');
    const user = join(scratch, 'user-config.toml');
    mkdirSync(projectDir, { recursive: true });
    const longLine = `needle ${'x'.repeat(192)}😀tail`;
    writeFileSync(project, `ignored\n${longLine}\nneedle duplicate\n"theme" = "ΟΣ"\n`);
    writeFileSync(user, 'theme = "light"\n');
    const brokenUtf8 = join(scratch, 'replacement.toml');
    writeFileSync(brokenUtf8, Buffer.from([0x6b, 0x65, 0x79, 0x20, 0x3d, 0x20, 0xff]));
    const read = await backend.codexConfigRead(brokenUtf8);
    assert.equal(read.exists, true);
    assert.equal(read.content, 'key = �');
    assert.equal(typeof read.mtime, 'number');

    const roots = [{ cwd: root, project, user }, { cwd: root, project, user }];
    const matches = await backend.codexConfigSearch(roots, 'needle');
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
    const userMatch = await backend.codexConfigSearch([{ cwd: root, project, user }], 'theme');
    assert.deepEqual(userMatch.map(({ scope }) => scope).sort(), ['project', 'user']);
    const userThemeMatch = userMatch.find(({ scope }) => scope === 'user');
    assert.ok(userThemeMatch);
    const greekMatch = await backend.codexConfigSearch([{ cwd: root, project, user }], 'ος');
    assert.equal(greekMatch.length, 1);
    assert.equal(greekMatch[0].line, 4);

    const child = join(root, 'child');
    const hidden = join(root, '.hidden');
    const dependency = join(root, 'node_modules', 'pkg');
    for (const dir of [join(child, '.codex'), join(hidden, '.codex'), join(dependency, '.codex')]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'config.toml'), 'model = "x"');
    }
    const fullScan = await backend.codexConfigScan(root, 20000);
    assert.deepEqual(fullScan, { roots: [root, child].sort((a, b) => a.localeCompare(b)), truncated: false });
    assert.deepEqual(await backend.codexConfigScan(root, 1), { roots: [root], truncated: true });
  } finally {
    await backend.stop();
    rmSync(scratch, { recursive: true, force: true });
  }
});
