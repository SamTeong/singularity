import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { select, shardCount, FEATURE_SPEC_ALIASES, FEATURE_CONSUMERS, SHARED_FEATURE_SPECS, featureImportSpecifiers, unitRunPlan } from './test-changed.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SPECS = readdirSync(join(ROOT, 'e2e-mock')).filter((f) => f.endsWith('.spec.mjs'));

test('selection by path', () => {
  const cases = [
    [['README.md', 'docs/x.png', 'backlog/tasks/t.md', 'github-pages/src/a.tsx'], { unit: [], mock: [], daemon: false }],
    [['server/tasks.mjs'], { unit: ['server'], mock: [], daemon: true }],
    [['server/agents.test.mjs'], { unit: ['server'], mock: [], daemon: false }],
    [['rust/backend/src/main.rs'], { unit: ['server'], mock: [], daemon: true }],
    [['web/src/lib/x.test.mjs'], { unit: ['web'], mock: [], daemon: false }],
    [['web/src/features/tasks/Board.jsx'], { unit: ['web', 'scripts'], mock: ['projects-review.spec.mjs', 'projects.spec.mjs', 'responsive.spec.mjs', 'tasks-automation-responsive.spec.mjs', 'tasks.spec.mjs', 'webkit-mobile.spec.mjs'], daemon: true }],
    [['web/src/features/skills/x.jsx'], { unit: ['web', 'scripts'], mock: ['editors.spec.mjs', 'responsive.spec.mjs'], daemon: true }],
    [['web/src/features/explorer/TabStrip.jsx'], { unit: ['web', 'scripts'], mock: ['config.spec.mjs', 'explorer-wiki-responsive.spec.mjs', 'explorer.spec.mjs', 'responsive.spec.mjs'], daemon: true }],
    [['web/src/features/config/ConfigEditor.jsx'], { unit: ['web', 'scripts'], mock: ['config.spec.mjs', 'responsive.spec.mjs'], daemon: true }],
    [['web/src/features/projects/ProjectsView.jsx'], { unit: ['web', 'scripts'], mock: ['projects-review.spec.mjs', 'projects.spec.mjs', 'responsive.spec.mjs'], daemon: true }],
    [['web/src/features/sessions/term-theme.js'], { unit: ['web', 'scripts'], mock: ['history.spec.mjs', 'projects-review.spec.mjs', 'projects.spec.mjs', 'responsive.spec.mjs', 'tasks-automation-responsive.spec.mjs', 'tasks.spec.mjs', 'transcripts-liveness.spec.mjs', 'transcripts.spec.mjs', 'webkit-mobile.spec.mjs'], daemon: true }],
    [['web/src/features/transcripts/TranscriptView.jsx'], { unit: ['web', 'scripts'], mock: ['history.spec.mjs', 'projects-review.spec.mjs', 'projects.spec.mjs', 'responsive.spec.mjs', 'tasks-automation-responsive.spec.mjs', 'tasks.spec.mjs', 'transcripts-liveness.spec.mjs', 'transcripts.spec.mjs', 'webkit-mobile.spec.mjs'], daemon: true }],
    [['web/src/features/sessions/term-theme.test.mjs'], { unit: ['web'], mock: [], daemon: false }],
    [['web/src/features/tasks/helpers/board.test.mjs'], { unit: ['web'], mock: [], daemon: false }],
    [['web/src/features/unknown/x.jsx'], { unit: ['web', 'scripts'], mock: 'all', daemon: true }],
    [['web/src/shell/AppShell.jsx'], { unit: ['web'], mock: 'all', daemon: true }],
    [['e2e-mock/usage.spec.mjs'], { unit: ['scripts'], mock: ['usage.spec.mjs'], daemon: false }],
    [['e2e-mock/deleted.spec.mjs'], { unit: ['scripts'], mock: [], daemon: false }],
    [['e2e-mock/helpers/responsive.mjs'], { unit: [], mock: 'all', daemon: false }],
    [['e2e/helpers/nav.mjs'], { unit: [], mock: 'all', daemon: true }],
    [['e2e/tasks.spec.mjs'], { unit: [], mock: [], daemon: true }],
    [['scripts/test-changed.mjs'], { unit: ['scripts'], mock: [], daemon: false }],
    [['.claude/skills/harness-usage-report/scripts/a.mjs', '.claude/settings.json'], { unit: ['usageReport'], mock: [], daemon: false }],
    [['.claude/skills/harness-usage-report/scripts/statusline.mjs'], { unit: ['server', 'usageReport'], mock: [], daemon: false }],
  ];
  for (const [files, want] of cases) assert.deepEqual(select(files, SPECS), want, files.join(','));
});

test('unrecognised or shared paths fail safe to everything', () => {
  for (const f of ['package.json', 'pnpm-lock.yaml', 'eslint.config.mjs', 'scripts/build-rust-backend.mjs', '.github/workflows/ci.yml', 'newdir/x.js']) {
    assert.deepEqual(select([f], SPECS), { unit: ['server', 'web', 'scripts', 'usageReport'], mock: 'all', daemon: true }, f);
  }
});

test('shard count scales with selected specs, capped at 10', () => {
  assert.equal(shardCount(['a'], 30), 1);
  assert.equal(shardCount(['a', 'b', 'c', 'd'], 30), 2);
  assert.equal(shardCount('all', 30), 10);
});

test('unit-only run plans dispatch selected buckets and build Rust only for server', () => {
  assert.deepEqual(unitRunPlan(['scripts']), [
    { cmd: 'node', args: ['--test', '--test-force-exit', '"scripts/*.test.mjs"'] },
  ]);
  assert.deepEqual(unitRunPlan(['web', 'usageReport']), [
    { cmd: 'node', args: ['--test', '--test-force-exit', '"web/src/**/*.test.mjs"', '".claude/skills/harness-usage-report/scripts/*.test.mjs"'] },
  ]);
  assert.deepEqual(unitRunPlan(['server']), [
    { cmd: 'node', args: ['scripts/build-rust-backend.mjs'] },
    { cmd: 'node', args: ['--test', '--test-force-exit', '"server/*.test.mjs"'] },
  ]);
});

test('feature aliases add to the feature prefix', () => {
  assert.deepEqual(select(['web/src/features/config-hooks/Hook.jsx'], ['config-hooks.spec.mjs', 'editors.spec.mjs', 'responsive.spec.mjs']).mock, ['config-hooks.spec.mjs', 'editors.spec.mjs', 'responsive.spec.mjs']);
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

test('feature consumer map covers cross-feature imports', () => {
  const featuresRoot = join(ROOT, 'web/src/features');
  const files = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (/\.(?:jsx?|mjs)$/.test(entry.name)) files.push(path);
      assert.ok(files.length <= 600, 'feature source scan exceeds its 600-file bound');
    }
  };
  visit(featuresRoot);
  for (const path of files) {
    const sourceFeature = path.slice(featuresRoot.length + 1).split(/[\\/]/)[0];
    const source = readFileSync(path, 'utf8');
    for (const specifier of featureImportSpecifiers(source)) {
      let importedFeature;
      if (specifier.startsWith('@/features/')) importedFeature = specifier.slice('@/features/'.length).split('/')[0];
      else if (specifier.startsWith('.')) {
        const importPath = relative(featuresRoot, resolve(dirname(path), specifier));
        if (importPath.startsWith('..') || isAbsolute(importPath)) continue;
        importedFeature = importPath.split(/[\\/]/)[0];
      } else continue;
      if (sourceFeature !== importedFeature) {
        assert.ok(FEATURE_CONSUMERS[importedFeature]?.includes(sourceFeature), `${importedFeature} change must select ${sourceFeature} (${path})`);
      }
    }
  }
});

test('feature import drift guard recognizes side-effect imports', () => {
  assert.deepEqual(featureImportSpecifiers("import '@/features/tasks/TasksBoard.css';"), ['@/features/tasks/TasksBoard.css']);
});

test('shared feature spec targets exist', () => {
  const missing = Object.values(SHARED_FEATURE_SPECS).flat().filter((spec) => !SPECS.includes(spec));
  assert.deepEqual(missing, []);
});
