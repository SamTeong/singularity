// The mock's mutable state. One instance per page load: this module has no
// persistence layer of its own, so a page reload re-evaluates it from scratch
// and every store snaps back to its seeded baseline (design.md Requirement
// "Mutations persist for the lifetime of the page"). Mirage route handlers
// and the mock-socket server (ws.js) both import and mutate this same object,
// which is what lets a write broadcast through the WS frame it converges from
// (design.md D7).
import {
  seedFiles, seedSessions, seedTasks, seedTaskHistory,
  seedCrons, seedBackgroundJobs, seedAgents, seedRoots,
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
  agents: clone(seedAgents()), // [] — grows at runtime (create/fork/attach, section 4)
  roots: clone(seedRoots()), // per-panel picker roots
  ui: {}, // panel UI state (open tabs, selections, ...) — starts empty, route groups populate as needed
};
