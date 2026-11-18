import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { select, shardCount, FEATURE_SPEC_ALIASES } from './test-changed.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SPECS = ['tasks.spec.mjs', 'tasks-automation-responsive.spec.mjs', 'editors.spec.mjs', 'usage.spec.mjs'];

test('selection by path', () => {
  const cases = [
    [['README.md', 'docs/x.png', 'backlog/tasks/t.md', 'github-pages/src/a.tsx'], { unit: [], mock: [], daemon: false }],
    [['server/tasks.mjs'], { unit: ['server'], mock: [], daemon: true }],
    [['rust/backend/src/main.rs'], { unit: ['server'], mock: [], daemon: true }],
    [['web/src/features/tasks/Board.jsx'], { unit: ['web'], mock: ['tasks-automation-responsive.spec.mjs', 'tasks.spec.mjs'], daemon: true }],
    [['web/src/features/skills/x.jsx'], { unit: ['web'], mock: ['editors.spec.mjs'], daemon: true }],
    [['web/src/features/unknown/x.jsx'], { unit: ['web'], mock: 'all', daemon: true }],
    [['web/src/shell/AppShell.jsx'], { unit: ['web'], mock: 'all', daemon: true }],
    [['e2e-mock/usage.spec.mjs'], { unit: [], mock: ['usage.spec.mjs'], daemon: false }],
    [['e2e-mock/deleted.spec.mjs'], { unit: [], mock: [], daemon: false }],
    [['e2e-mock/helpers/responsive.mjs'], { unit: [], mock: 'all', daemon: false }],
    [['e2e/tasks.spec.mjs'], { unit: [], mock: [], daemon: true }],
    [['scripts/test-changed.mjs'], { unit: ['scripts'], mock: [], daemon: false }],
    [['.claude/skills/harness-usage-report/scripts/a.mjs', '.claude/settings.json'], { unit: ['usageReport'], mock: [], daemon: false }],
  ];
  for (const [files, want] of cases) assert.deepEqual(select(files, SPECS), want, files.join(','));
});

test('unrecognised or shared paths fail safe to everything', () => {
  for (const f of ['package.json', 'pnpm-lock.yaml', 'eslint.config.mjs', 'scripts/build-rust-backend.mjs', '.github/workflows/ci.yml', 'newdir/x.js']) {
    assert.deepEqual(select([f], SPECS), { unit: ['server', 'web', 'scripts', 'usageReport'], mock: 'all', daemon: true }, f);
  }
});

test('shard count scales with selected specs, capped at 4', () => {
  assert.equal(shardCount(['a'], 30), 1);
  assert.equal(shardCount(['a', 'b', 'c', 'd', 'e'], 30), 2);
  assert.equal(shardCount('all', 30), 8);
});

// Drift guard: a new feature dir or a renamed spec must not silently fall back
// to the whole mock suite, nor map to a spec that no longer exists.
test('every web feature dir maps to an existing mock spec', () => {
  const specs = readdirSync(join(ROOT, 'e2e-mock')).filter((f) => f.endsWith('.spec.mjs'));
  const features = readdirSync(join(ROOT, 'web/src/features'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  const unmapped = features.filter((f) => select([`web/src/features/${f}/x.jsx`], specs).mock === 'all');
  assert.deepEqual(unmapped, [], `add these to FEATURE_SPEC_ALIASES: ${unmapped}`);
  for (const [f, prefixes] of Object.entries(FEATURE_SPEC_ALIASES)) {
    assert.ok(features.includes(f), `alias for missing feature ${f}`);
    for (const p of prefixes) assert.ok(specs.some((s) => s === `${p}.spec.mjs` || s.startsWith(`${p}-`)), `alias ${f} -> ${p} has no spec`);
  }
});
