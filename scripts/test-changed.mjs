#!/usr/bin/env node
// Changed-file test selection: maps the paths changed since a base ref to the
// test suites (and mock e2e specs) that can observe them, then runs only those.
// Fail-safe: a path no rule recognises selects everything.
//
//   node scripts/test-changed.mjs                 run what changed vs origin/main
//   node scripts/test-changed.mjs --base main     pick another base ref
//   node scripts/test-changed.mjs --all           run everything
//   node scripts/test-changed.mjs --plan          print the selection as JSON; under
//                                                 GitHub Actions also write step outputs
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export const UNIT_GLOBS = {
  server: 'server/*.test.mjs',
  web: 'web/src/**/*.test.mjs',
  scripts: 'scripts/*.test.mjs',
  usageReport: '.claude/skills/harness-usage-report/scripts/*.test.mjs',
};

// Feature dirs whose mock specs do not start with the feature's own name.
// A feature that matches neither this map nor a spec prefix runs every mock spec.
export const FEATURE_SPEC_ALIASES = {
  'config-hooks': ['editors'],
  memory: ['editors'],
  rules: ['editors'],
  skills: ['editors'],
  sessions: ['transcripts'],
  plans: ['plans-carousel'],
  appearance: ['appearance', 'phosphor'],
  palette: ['nav'], // command palette is shell-level; nav.spec owns shell routing
};

// Paths that cannot affect any test. Docs, planning data, the standalone Pages
// app (own workflow) and agent config.
const IGNORED = [
  /\.md$/i,
  /^(docs|backlog|openspec|groma|\.tickets|\.reports|\.codex|\.opencode|github-pages)\//,
  /^\.claude\/(?!skills\/harness-usage-report\/scripts\/)/,
  /^\.github\/workflows\/pages\.yml$/,
  /^LICENSE/,
];

const ALL = 'all';

/** @param {string[]} files repo-relative, forward slashes @param {string[]} mockSpecs basenames in e2e-mock/ */
export function select(files, mockSpecs) {
  const unit = new Set();
  let mock = new Set();
  let mockAll = false;
  let daemon = false;
  const everything = () => {
    Object.keys(UNIT_GLOBS).forEach((k) => unit.add(k));
    mockAll = true;
    daemon = true;
  };
  const specsFor = (feature) => {
    const prefixes = FEATURE_SPEC_ALIASES[feature] ?? [feature];
    const hits = mockSpecs.filter((s) => prefixes.some((p) => s === `${p}.spec.mjs` || s.startsWith(`${p}-`)));
    return hits.length ? hits : null;
  };

  for (const f of files) {
    let m;
    if (IGNORED.some((re) => re.test(f))) continue;
    if (f.startsWith('server/') || f.startsWith('rust/')) {
      unit.add('server');
      daemon = true;
    } else if ((m = f.match(/^web\/src\/features\/([^/]+)\//))) {
      unit.add('web');
      daemon = true;
      const specs = specsFor(m[1]);
      if (specs) specs.forEach((s) => mock.add(s));
      else mockAll = true;
    } else if (f.startsWith('web/')) {
      // shell, components, hooks, lib, providers, theme, mock backend, vite config
      unit.add('web');
      mockAll = true;
      daemon = true;
    } else if ((m = f.match(/^e2e-mock\/([^/]+\.spec\.mjs)$/))) {
      if (mockSpecs.includes(m[1])) mock.add(m[1]); // a deleted spec needs no run
    } else if (f.startsWith('e2e-mock/') || f === 'playwright.mock.config.mjs') {
      mockAll = true;
    } else if (f.startsWith('e2e/') || f === 'playwright.config.mjs') {
      daemon = true;
    } else if (f.startsWith('.claude/skills/harness-usage-report/scripts/')) {
      unit.add('usageReport');
    } else if (/^scripts\/[^/]+\.test\.mjs$/.test(f) || f === 'scripts/test-changed.mjs') {
      unit.add('scripts');
    } else if (f.startsWith('scripts/')) {
      everything(); // build/dev scripts feed every suite
    } else {
      everything(); // package.json, lockfile, eslint config, vendor/, CI, anything new
    }
  }
  if (mockAll) mock = new Set();
  return {
    unit: Object.keys(UNIT_GLOBS).filter((k) => unit.has(k)),
    mock: mockAll ? ALL : [...mock].sort(),
    daemon,
  };
}

function git(...args) {
  return execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8' }).split('\n').filter(Boolean);
}

function changedFiles(base) {
  const mergeBase = git('merge-base', base, 'HEAD')[0];
  return [...new Set([
    ...git('diff', '--name-only', mergeBase), // committed + staged + unstaged
    ...git('ls-files', '--others', '--exclude-standard'),
  ])];
}

const listMockSpecs = () => readdirSync(join(ROOT, 'e2e-mock')).filter((f) => f.endsWith('.spec.mjs'));

// Mock e2e shard count for CI: one runner per ~3 specs, at most 10 (CI runs tests ~10x slower than a dev box).
export function shardCount(mock, specTotal) {
  if (mock === ALL) return Math.min(10, Math.ceil(specTotal / 3));
  return Math.min(10, Math.max(1, Math.ceil(mock.length / 3)));
}

function run(cmd, args) {
  console.log(`\n> ${cmd} ${args.join(' ')}`);
  // shell:true on every OS; the quoted globs stay unexpanded, so node --test expands them itself.
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', shell: true });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

function main(argv) {
  const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const specs = listMockSpecs();
  const all = argv.includes('--all');
  const files = all ? [] : changedFiles(opt('--base') ?? 'origin/main');
  const sel = all ? select(['package.json'], specs) : select(files, specs);
  const shards = sel.mock.length ? shardCount(sel.mock, specs.length) : 0;

  if (argv.includes('--plan')) {
    console.log(JSON.stringify({ files: files.length, ...sel, shards }, null, 2));
    if (process.env.GITHUB_OUTPUT) {
      appendFileSync(process.env.GITHUB_OUTPUT, [
        `unit=${sel.unit.length > 0}`,
        `mock=${sel.mock === ALL ? ALL : sel.mock.length ? 'some' : 'none'}`,
        `mock_specs=${sel.mock === ALL ? '' : sel.mock.join(' ')}`,
        `shards=${JSON.stringify(Array.from({ length: shards }, (_, i) => i + 1))}`,
        `shard_total=${shards}`,
        '',
      ].join('\n'));
    }
    return;
  }

  if (!sel.unit.length && !sel.mock.length && !sel.daemon) return console.log('No test-relevant changes.');
  if (sel.unit.includes('server') || sel.daemon) run('node', ['scripts/build-rust-backend.mjs']);
  if (sel.unit.length) run('node', ['--test', '--test-force-exit', ...sel.unit.map((k) => `"${UNIT_GLOBS[k]}"`)]);
  if (sel.mock.length) {
    run('pnpm', ['build:mock']);
    run('pnpm', ['exec', 'playwright', 'test', '--config', 'playwright.mock.config.mjs', ...(sel.mock === ALL ? [] : sel.mock)]);
  }
  if (sel.daemon) run('pnpm', ['test:e2e']);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
