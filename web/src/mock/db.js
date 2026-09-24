// The mock's mutable state. One instance per page load: this module has no
// persistence layer of its own, so a page reload re-evaluates it from scratch
// and every store snaps back to its seeded baseline (design.md Requirement
// "Mutations persist for the lifetime of the page"). Mirage route handlers
// and the mock-socket server (ws.js) both import and mutate this same object,
// which is what lets a write broadcast through the WS frame it converges from
// (design.md D7).
import {
  seedFiles, seedSessions, seedTasks, seedTaskHistory,
  seedCrons, seedBackgroundJobs, seedAgents, seedRoots, seedRecentRepos, seedWindowAnchor, seedProjects, seedProjectSummaries, T0,
} from './fixtures.js';

// Fresh top-level containers on every module evaluation — deep clone from
// fixtures.js so mutation in one field (e.g. db.tasks) can never alias
// something a route handler elsewhere expects to be pristine.
const clone = (v) => JSON.parse(JSON.stringify(v));

export const db = {
  files: clone(seedFiles()), // path -> { content, mtime }
  sessions: clone(seedSessions()), // project -> [{ id, project, cwd, events, mtimeMs }]
  tasks: clone(seedTasks()), // [task]
  taskHistory: clone(seedTaskHistory()), // [task & { outcome, concludedAt, finalStats }]
  crons: clone(seedCrons()), // [cron]
  background: clone(seedBackgroundJobs()), // [job]
  windowAnchor: clone(seedWindowAnchor()), // { claude, codex } — the bare /window-anchor snapshot
  agents: clone(seedAgents()), // [] — grows at runtime (create/fork/attach, section 4)
  recentRepos: clone(seedRecentRepos()), // cwd list carried by the `list` frame
  roots: clone(seedRoots()), // per-panel picker roots
  projects: clone(seedProjects()), // [{ path, branch, ahead, behind, ... }] — ordered list, git status baked in
  projectSummaries: clone(seedProjectSummaries()), // path -> { scope, committed, uncommitted, source, ... }
  // Panel UI state (open tabs, selections, ...) — route groups lazy-populate
  // the rest as needed. `usageReportAt` is seeded rather than lazy because it
  // is fixture data, not UI state: it stands in for the mtime of the canned
  // report the mock-assets Vite plugin serves, and `POST /usagereport/refresh`
  // advances it so UsageReportView remounts its iframe.
  ui: {
    usageReportAt: T0,
    // pricing.json stand-in for the harness-usage-report skill (Settings >
    // Models > Prices) — see server/model-prices.mjs / mock/routes/core.js.
    modelPrices: {
      base: {
        'opus-5-5': [4.0, 20.0, 0.20, 5.0],
        opus: [5.0, 25.0, 0.5, 6.25],
        sonnet: [3.0, 15.0, 0.3, 3.75],
        haiku: [1.0, 5.0, 0.1, 1.25],
      },
      above_200k: { 'gpt-6-sol': [4.0, 15.0, 0.4, 5.0] },
      long_context_threshold: 200000,
      default_key: 'opus',
    },
  },
};
