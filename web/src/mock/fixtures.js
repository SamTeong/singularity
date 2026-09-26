// Dependency-free seed data for mock mode (design.md D10). No imports, no
// `node:*` builtins, no browser globals — this module loads unmodified in the
// browser (via db.js) AND in Node (Playwright specs under e2e-mock/ import it
// directly for expected values, the way today's e2e/ specs import
// e2e/fixtures/paths.mjs).
//
// Identifiers match the existing daemon-backed sandbox corpus
// (e2e/fixtures/paths.mjs + seed.mjs) so a spec ported from e2e/ keeps its
// assertions verbatim: `workspace-alpha`, `workspace-beta`, `handbook`,
// `Seeded <column> card`, the RICH_SESSION id.
//
// This module only builds *data*. web/src/mock/db.js is the mutable store —
// it seeds itself once from the factory functions here.

// ---------------------------------------------------------------- identifiers

export const PROJECT_A = 'workspace-alpha';
export const PROJECT_B = 'workspace-beta';
export const WIKI_NAME = 'handbook';
export const SESSION_COUNT_A = 30; // > the 25 default page size, so pagination has a second page

export const sessionId = (i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
export const RICH_SESSION = sessionId(900); // the multi-tool transcript in PROJECT_B

// Fixed clock so list ordering and "N min ago" captions are deterministic
// across runs — 2025-06-01T09:00:00Z, same instant e2e/fixtures/seed.mjs uses.
export const T0 = 1748768400000;

// A machine-independent stand-in for the daemon's `home` (os.homedir() on the
// real server) — see design.md D3. Every mock root lives under it so
// tildify()/untildify() collapse mock paths to `~/...` exactly as they would
// against a real home.
export const FAKE_HOME = '/home/mock';

const join = (...parts) => parts.join('/').replace(/\/+/g, '/');

// ---------------------------------------------------------------------- roots

// Mirrors e2e/fixtures/paths.mjs's CORPUS_DIR layout: one subtree per panel
// domain, all addressable as plain path strings (there's no real filesystem —
// db.js's `files` store is a flat `path -> {content, mtime}` map keyed by
// these).
export const ROOTS = {
  projects: join(FAKE_HOME, 'projects'), // sessions + memory (<root>/<project>/memory/*.md)
  wiki: join(FAKE_HOME, 'wiki'),
  skills: join(FAKE_HOME, 'skills'),
  workspace: join(FAKE_HOME, 'workspace'), // config + hooks + rules root
  explorer: join(FAKE_HOME, 'explorer'),
  scratch: join(FAKE_HOME, 'scratch'), // non-git task cwd
};

// ------------------------------------------------------------------ sessions

// One session = one JSONL transcript's parsed events, the same event shapes
// e2e/fixtures/seed.mjs writes to disk. A future routes/sessions.js derives
// whatever list/read projection it needs from `events` + `mtimeMs`.
function transcript(cwd, i) {
  const ts = (n) => new Date(T0 + i * 60_000 + n * 1000).toISOString();
  return [
    { type: 'user', cwd, timestamp: ts(0), message: { role: 'user', content: `Fixture request ${i}: summarize the module.` } },
    { type: 'assistant', cwd, timestamp: ts(1), message: { role: 'assistant', model: 'claude-opus-4-5-20251101', content: [{ type: 'text', text: `Fixture reply ${i}.` }] } },
    { type: 'ai-title', aiTitle: `Fixture session ${i}` },
  ];
}

function richTranscript(cwd) {
  const ts = (n) => new Date(T0 + 3600_000 + n * 1000).toISOString();
  return [
    { type: 'user', cwd, timestamp: ts(0), message: { role: 'user', content: 'Trace the retry path and tell me where the backoff is capped.' } },
    { type: 'assistant', cwd, timestamp: ts(1), message: { role: 'assistant', model: 'claude-opus-4-5-20251101', content: [{ type: 'thinking', thinking: 'Look for the backoff constant first.' }] } },
    { type: 'assistant', cwd, timestamp: ts(2), message: { role: 'assistant', model: 'claude-opus-4-5-20251101', content: [{ type: 'tool_use', name: 'Grep', input: { pattern: 'backoff', path: 'src' } }] } },
    { type: 'user', cwd, timestamp: ts(3), message: { role: 'user', content: [{ type: 'tool_result', content: 'src/retry.js:12: const MAX_BACKOFF_MS = 30000;' }] } },
    { type: 'assistant', cwd, timestamp: ts(4), message: { role: 'assistant', model: 'claude-opus-4-5-20251101', content: [{ type: 'text', text: 'Backoff is capped at 30s in `src/retry.js:12`.' }] } },
    { type: 'ai-title', aiTitle: 'Retry backoff cap' },
  ];
}

// mtime drives both list order and the "running" pill (a session touched
// within 30s reads as a live external session) — spaced a minute apart, oldest
// first, so freshly-seeded sessions never all read as concurrently running.
export function seedSessions() {
  const sessions = { [PROJECT_A]: [], [PROJECT_B]: [] };
  for (let i = 0; i < SESSION_COUNT_A; i++) {
    sessions[PROJECT_A].push({
      id: sessionId(i), project: PROJECT_A, cwd: '/fixture/alpha',
      events: transcript('/fixture/alpha', i), mtimeMs: T0 + i * 60_000,
    });
  }
  sessions[PROJECT_B].push({
    id: sessionId(901), project: PROJECT_B, cwd: '/fixture/beta',
    events: transcript('/fixture/beta', 901), mtimeMs: T0 + SESSION_COUNT_A * 60_000,
  });
  sessions[PROJECT_B].push({
    id: RICH_SESSION, project: PROJECT_B, cwd: '/fixture/beta',
    events: richTranscript('/fixture/beta'), mtimeMs: T0 + (SESSION_COUNT_A + 1) * 60_000,
  });
  return sessions;
}

// -------------------------------------------------------------- virtual files
//
// Flat path -> {content, mtime} map. Covers everything served through mtime-
// guarded file routes: memory, wiki, skills, config/hooks/rules, explorer.
// Binary content (explorer's pixel.png) is intentionally absent — `/fs/raw`
// is a subresource load Mirage cannot intercept and is served instead by
// web/mock-assets.plugin.mjs (tasks.md section 6); the file only needs an
// entry so directory listings show it.

function memoryFiles() {
  const a = join(ROOTS.projects, PROJECT_A, 'memory');
  const b = join(ROOTS.projects, PROJECT_B, 'memory');
  return {
    [join(a, 'MEMORY.md')]: '# Memory index\n- [Retry cap](retry-cap.md) — backoff ceiling lives in retry.js\n',
    [join(a, 'retry-cap.md')]: '---\nname: retry-cap\ndescription: backoff ceiling\nmetadata:\n  type: project\n---\n\nBackoff caps at 30s.\n',
    [join(b, 'deploy-notes.md')]: '---\nname: deploy-notes\ndescription: staging deploy quirks\nmetadata:\n  type: project\n---\n\nStaging deploys need a manual cache purge.\n',
  };
}

function wikiFiles() {
  const w = join(ROOTS.wiki, WIKI_NAME);
  return {
    [join(w, 'index.md')]: '---\ntitle: Handbook\nstatus: stable\ncategory: overview\n---\n\nStart at [[architecture]], then read [[glossary]].\n',
    [join(w, 'architecture.md')]: '---\ntitle: Architecture\nstatus: draft\ncategory: design\n---\n\nThe daemon owns state; the shell renders it. See [[glossary]].\n',
    [join(w, 'glossary.md')]: '---\ntitle: Glossary\nstatus: stable\ncategory: reference\n---\n\n**Worktree** — an isolated checkout per task.\n',
    // A page in a subdirectory: WikiPanel derives the category filter from the
    // folder segment of a page's rel path, not from frontmatter — a wholly
    // flat corpus leaves the filter unrendered and untestable.
    [join(w, 'design', 'daemon.md')]: '---\ntitle: Daemon\nstatus: draft\n---\n\nThe daemon binds loopback only.\n',
  };
}

function skillFiles() {
  const lint = join(ROOTS.skills, 'coding', '.claude', 'skills', 'lint-guard');
  const color = join(ROOTS.skills, 'design', '.claude', 'skills', 'color-audit');
  return {
    [join(lint, 'SKILL.md')]: '---\nname: lint-guard\ndescription: Blocks a commit when the linter is unhappy.\n---\n\n# Lint guard\n\nRun the linter before staging.\n',
    [join(lint, 'reference.md')]: '# Rule table\n\nOne row per rule.\n',
    [join(color, 'SKILL.md')]: '---\nname: color-audit\ndescription: Checks palette contrast against WCAG AA.\n---\n\n# Color audit\n\nContrast first, hue second.\n',
  };
}

function workspaceFiles() {
  const c = join(ROOTS.workspace, '.claude');
  return {
    [join(c, 'settings.json')]: JSON.stringify({ permissions: { allow: ['Bash(git status)'] }, env: { FIXTURE: 'project' } }, null, 2),
    [join(c, 'settings.local.json')]: JSON.stringify({ env: { FIXTURE: 'local' } }, null, 2),
    [join(ROOTS.workspace, '.codex', 'config.toml')]: 'model = "gpt-5.2"\n',
    [join(c, 'hooks', 'pre-commit.sh')]: '#!/bin/sh\n# fixture hook\necho "pre-commit fixture"\n',
    [join(c, 'hooks', 'format.ps1')]: '# fixture hook\nWrite-Output "format fixture"\n',
    [join(c, 'rules', 'style.md')]: '# Style\n\nTwo-space indent. No trailing whitespace.\n',
    [join(c, 'rules', 'testing.md')]: '# Testing\n\nOne runnable check per non-trivial branch.\n',
  };
}

function explorerFiles() {
  const root = ROOTS.explorer;
  return {
    [join(root, 'notes.md')]: '# Notes\n\nExplorer fixture markdown.\n',
    [join(root, 'script.mjs')]: 'export const explorerFixture = true;\n',
    [join(root, '.hidden')]: 'hidden fixture\n',
    [join(root, 'subdir', 'nested.txt')]: 'Nested file content.\n',
    [join(root, 'pixel.png')]: null, // binary — see file header; served by the asset plugin
  };
}

export function seedFiles() {
  const entries = { ...memoryFiles(), ...wikiFiles(), ...skillFiles(), ...workspaceFiles(), ...explorerFiles() };
  const files = {};
  let i = 0;
  for (const [path, content] of Object.entries(entries)) {
    files[path] = { content, mtime: T0 + (i += 1000) }; // stable, distinct mtimes
  }
  return files;
}

// --------------------------------------------------------------------- tasks

const TAGS = ['fixture', 'ui'];

function task(id, title, column, state, extra = {}) {
  return {
    id, title, description: `${title} — seeded fixture card.`,
    repo: ROOTS.scratch, kind: 'plain', worktree: null, branch: null, baseBranch: null,
    model: 'claude', implModel: 'claude', reviewerModel: 'claude',
    orchestratorMaxTurns: null, implMaxTurns: null, reviewerMaxTurns: null,
    scopes: [], tags: TAGS, requirePlanApproval: false, mergeMode: null,
    column, state, sessionId: null, createdAt: T0, updatedAt: T0, ...extra,
  };
}

export function seedTasks() {
  return [
    task(sessionId(1001), 'Seeded todo card', 'todo', 'analyzing'),
    task(sessionId(1002), 'Seeded in-progress card', 'inprogress', 'working'),
    task(sessionId(1003), 'Seeded review card', 'inreview', 'awaiting human review'),
    task(sessionId(1004), 'Seeded done card', 'done', 'report ready'),
  ];
}

export function seedTaskHistory() {
  // finalStats uses the statsFor shape (server/stats.mjs) — the client's
  // history table reads h.finalStats.tokens and h.finalStats.costUsd, so the
  // legacy { totalTokens, activeMs, cost_usd } keys would render "—".
  return [
    { ...task(sessionId(1005), 'Concluded fixture run', 'done', 'report ready'), outcome: 'completed', concludedAt: T0 + 7200_000, finalStats: { turns: 4, tokens: 12_345, inputTokens: 8_000, outputTokens: 2_000, cacheReadTokens: 1_000, cacheWriteTokens: 1_345, models: ['claude'], exists: true, estCostUsd: null, costUsd: 0.42, costSource: 'statusline', apiMs: 100_000, wallMs: 120_000, busyMs: 120_000 } },
    { ...task(sessionId(1006), 'Abandoned fixture run', 'done', 'abandoned'), outcome: 'abandoned', concludedAt: T0 + 10800_000, finalStats: { turns: 1, tokens: 900, inputTokens: 600, outputTokens: 200, cacheReadTokens: 50, cacheWriteTokens: 50, models: ['claude'], exists: true, estCostUsd: null, costUsd: 0.01, costSource: 'statusline', apiMs: 15_000, wallMs: 20_000, busyMs: 20_000 } },
  ];
}

// -------------------------------------------------------------- crons + jobs

function cron(i, title, expr) {
  // Disabled + far-future expression: nothing in mock mode ever "fires" a
  // cron, but keeping the same shape as the daemon (and staying disabled)
  // means a route handler that flips `enabled` doesn't need special-casing.
  return {
    id: sessionId(2000 + i), title, enabled: false, cronExpr: expr, description: `${title} — seeded fixture job.`,
    cwd: ROOTS.scratch, model: 'claude', scopes: [], permissionMode: 'acceptEdits',
    lastSessionId: null, lastFiredAt: null, nextFire: null, createdAt: T0, updatedAt: T0,
  };
}

export function seedCrons() {
  return [cron(1, 'Nightly fixture sweep', '0 4 1 1 *'), cron(2, 'Weekly fixture digest', '0 5 1 1 *')];
}

function bgJob(i, title) {
  return {
    id: sessionId(3000 + i), title, description: `${title} — seeded fixture job.`, cwd: ROOTS.scratch,
    cooldownHours: 24, enabled: false,
    window: { startHour: 9, endHour: 18, days: [1, 2, 3, 4, 5] },
    // All three backends, matching server/background.mjs DEFAULT_JOB — the
    // CreateBackgroundJobDialog renders thresholds[b].start for b in
    // ['claude','codex','ollama'], so a seeded job missing `codex` crashes Edit.
    thresholds: { claude: { start: 50, stop: 75, weeklyMax: 50 }, codex: { start: 50, stop: 75, weeklyMax: 50 }, ollama: { start: 50, stop: 75, weeklyMax: 50 } },
    models: { claude: 'opus', codex: 'gpt-6-luna', ollama: 'glm-5.3:cloud' },
    tokenCaps: { claude: 15_000_000, codex: 15_000_000, ollama: 15_000_000 },
    scopes: [], conclude: 'inreview', lastRunAt: null, lastTaskId: null,
  };
}

export function seedBackgroundJobs() {
  return [bgJob(1, 'Fixture backlog groomer'), bgJob(2, 'Fixture dependency check')];
}

// Window-anchor state (server/window-anchor.mjs defaultProviderState shape).
// Claude carries an armed window so the Usage card has a real countdown to
// render; codex is the untouched opt-in shape. nextAnchorAt is relative to
// now, not T0: unlike the other fixtures this one is *read* as a duration, and
// a 2025 timestamp would render "now" (fmtReset) forever.
export function seedWindowAnchor() {
  const hour = 3.6e6;
  return {
    claude: { enabled: true, nextAnchorAt: Date.now() + 2 * hour, lastAnchorAt: Date.now() - hour, lastResult: 'Ok', lastError: null },
    codex: { enabled: false, nextAnchorAt: null, lastAnchorAt: null, lastResult: null, lastError: null },
  };
}

// -------------------------------------------------------------------- agents

// No agents: an empty dock is the sandbox baseline too (e2e/fixtures/seed.mjs
// seeds zero agents), so no reattach path is reachable at page load. Section 4
// (create/fork/attach) grows this list at runtime.
export function seedAgents() {
  return [];
}

// Recent-repos list carried by the `list` WS frame (reg.getRecentRepos). The
// daemon seeds it from agent cwds; the mock seeds the two fixture projects so
// the New-session dialog's cwd picker opens with suggestions instead of empty.
export function seedRecentRepos() {
  return [join(ROOTS.projects, PROJECT_A), join(ROOTS.projects, PROJECT_B)];
}

// ------------------------------------------------------------------ projects

// Projects view fixtures — an ordered list of git repo toplevels, each with a
// baked-in git-status readout (the mock has no real git; the daemon shells
// out to produce this shape from server/projects.mjs:gitStatus). One clean
// repo with unpushed commits, one dirty repo with a stash, one with no
// upstream — so every card state the UI needs is exercisable without a fetch.
export const PROJECT_PATHS = {
  clean: join(FAKE_HOME, 'repos', 'sing-clean'),
  dirty: join(FAKE_HOME, 'repos', 'sing-dirty'),
  noUpstream: join(FAKE_HOME, 'repos', 'sing-scratch'),
};

export function seedProjects() {
  return [
    {
      path: PROJECT_PATHS.clean, branch: 'main', upstream: 'origin/main', ahead: 2, behind: 0,
      staged: 0, modified: 0, untracked: 0, conflicted: 0, stash: 0,
      lastCommit: { sha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678', subject: 'Tidy release notes', date: new Date(T0 - 3_600_000).toISOString() },
    },
    {
      path: PROJECT_PATHS.dirty, branch: 'feat/widget', upstream: 'origin/feat/widget', ahead: 0, behind: 1,
      staged: 2, modified: 3, untracked: 1, conflicted: 0, stash: 1,
      lastCommit: { sha: 'b2c3d4e5f60718293a4b5c6d7e8f90123456789a', subject: 'WIP: widget layout', date: new Date(T0 - 7_200_000).toISOString() },
    },
    {
      path: PROJECT_PATHS.noUpstream, branch: 'scratch', upstream: null, ahead: 0, behind: 0,
      staged: 0, modified: 0, untracked: 2, conflicted: 0, stash: 0,
      lastCommit: { sha: 'c3d4e5f60718293a4b5c6d7e8f90123456789ab0', subject: 'Local experiment', date: new Date(T0 - 86_400_000).toISOString() },
    },
  ];
}

// Summary fixtures (server/projects.mjs:summary shape), keyed by path: one
// LLM-sourced, one deterministic with scope 'recent' (noUpstream has no
// upstream), one with empty uncommitted ("Working tree clean" — clean has no
// working-tree changes either).
export function seedProjectSummaries() {
  return {
    [PROJECT_PATHS.clean]: {
      path: PROJECT_PATHS.clean, scope: 'unpushed', source: 'llm', model: 'opus',
      committed: ['Tidied up the release notes wording', 'Bumped the changelog date'],
      uncommitted: [],
    },
    [PROJECT_PATHS.dirty]: {
      path: PROJECT_PATHS.dirty, scope: 'unpushed', source: 'llm', model: 'opus',
      committed: ['Reworked the widget layout'],
      uncommitted: ['Still tuning the widget spacing', 'Stashed an experiment for later'],
    },
    [PROJECT_PATHS.noUpstream]: {
      path: PROJECT_PATHS.noUpstream, scope: 'recent', source: 'deterministic',
      llm: { ok: false, reason: 'no-summariser' },
      committed: ['Local experiment'],
      uncommitted: ['scratch.txt', 'notes.txt', '2 files changed'],
    },
  };
}

// project-review skill's ledger, keyed by tracked project path (server/
// project-review.mjs:reviewStatus shape). Covers the four states a card's
// review-status section can show: not run (noUpstream), a run with open
// findings whose *latest* run is BLOCKED (dirty — counts still reflect the
// open backlog from its earlier DONE run), and a fully resolved run (clean).
export function seedProjectReviews() {
  return {
    [PROJECT_PATHS.clean]: {
      enabled: true,
      runs: [{
        sessionId: '00000000-0000-4000-8000-r00000000001', worktree: PROJECT_PATHS.clean,
        baseline: 'a1b2c3d', target: 'd4e5f6a', startedAt: new Date(T0 - 172_800_000).toISOString(), completedAt: new Date(T0 - 172_000_000).toISOString(),
        harness: 'Claude Code', model: 'claude-opus-5-5', status: 'DONE',
        artifacts: [{ label: 'report', rel: 'r00000000001/reports/review.md' }, { label: 'findings', rel: 'r00000000001/findings/introduced.md' }],
        findings: [
          { sev: 'P1', title: 'Race condition on save', status: 'fixed', kind: 'introduced', rel: 'r00000000001/findings/introduced.md' },
          { sev: 'P2', title: 'Missing null check', status: 'wontfix', kind: 'preexisting', rel: 'r00000000001/findings/preexisting.md' },
        ],
      }],
      latest: { status: 'DONE', target: 'd4e5f6a', completedAt: new Date(T0 - 172_000_000).toISOString(), commitsSince: 2, counts: { P0: 0, P1: 1, P2: 1, P3: 0, open: 0, resolved: 2 } },
    },
    [PROJECT_PATHS.dirty]: {
      enabled: true,
      runs: [
        {
          sessionId: '00000000-0000-4000-8000-r00000000003', worktree: PROJECT_PATHS.dirty,
          baseline: 'b2c3d4e', target: 'c3d4e5f', startedAt: new Date(T0 - 3_600_000).toISOString(), completedAt: null,
          harness: 'Codex', model: 'unknown', status: 'BLOCKED',
          artifacts: [{ label: 'report', rel: 'r00000000003/reports/review.md' }],
          findings: [],
        },
        {
          sessionId: '00000000-0000-4000-8000-r00000000002', worktree: PROJECT_PATHS.dirty,
          baseline: 'a2b3c4d', target: 'b2c3d4e', startedAt: new Date(T0 - 259_200_000).toISOString(), completedAt: new Date(T0 - 258_800_000).toISOString(),
          harness: 'Claude Code', model: 'claude-sonnet-5', status: 'DONE',
          artifacts: [{ label: 'report', rel: 'r00000000002/reports/review.md' }, { label: 'findings', rel: 'r00000000002/findings/introduced.md' }],
          findings: [
            { sev: 'P0', title: 'Stashed change clobbers widget layout on rebase', status: 'open', kind: 'introduced', rel: 'r00000000002/findings/introduced.md' },
            { sev: 'P2', title: 'Widget spacing still WIP', status: 'open', kind: 'introduced', rel: 'r00000000002/findings/introduced.md' },
          ],
        },
      ],
      latest: { status: 'BLOCKED', target: 'c3d4e5f', completedAt: null, commitsSince: null, counts: { P0: 1, P1: 0, P2: 1, P3: 0, open: 2, resolved: 0 } },
    },
    [PROJECT_PATHS.noUpstream]: { enabled: true, runs: [], latest: null },
  };
}

// GET /projects/review/file fixture content, keyed by the `rel` links above —
// only the two artifacts a card's UI would actually open in this fixture set.
export function seedProjectReviewFiles() {
  return {
    'r00000000001/findings/introduced.md': '# Introduced findings\n\n## P1 — Race condition on save\nStatus: fixed — d4e5f6a\n',
    'r00000000002/findings/introduced.md': '# Introduced findings\n\n## P0 — Stashed change clobbers widget layout on rebase\nStatus: open\n\n## P2 — Widget spacing still WIP\nStatus: open\n',
  };
}

// ---------------------------------------------------------------------- misc

// Per-panel picker roots — mirrors the *-root.json files
// e2e/fixtures/seed.mjs writes to STATE_DIR, so every panel opens pointed at
// seeded content instead of (in the real daemon) falling back to the user's
// actual dotfiles.
export function seedRoots() {
  return {
    sessions: ROOTS.projects,
    memory: ROOTS.projects,
    wiki: ROOTS.wiki,
    skills: [ROOTS.skills],
    config: [ROOTS.workspace],
    codexConfig: [ROOTS.workspace],
    hooks: [ROOTS.workspace],
    rules: [ROOTS.workspace],
    explorer: ROOTS.explorer,
  };
}
