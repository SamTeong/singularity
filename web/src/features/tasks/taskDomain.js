// Board pipeline + domain-state mapping shared by TasksBoard.jsx (column
// heads, card edges/stamps) and TaskDetailPanel.jsx (Activity stage list,
// head stamp) — was independently re-derived in each file (own COLUMNS/STAGES
// arrays, own COLUMN_DOMAIN/STAGE_DOMAIN tables, own domain-precedence logic)
// with nothing enforcing the copies stayed in sync. Centralized here so a task
// reads the same tone/stage on the board and in its dossier by construction.
// Relative, not the `@/` alias — Node's test runner doesn't resolve it (see
// theme/resolveSkin.js's doc comment for the same note), and this module now
// has a co-located *.test.mjs that imports it directly.
import { KIND, KIND_TO_DOMAIN } from '../../lib/agentStatus.js';

// Single source of column metadata — id, display label, and its shared
// domain-state id (design.md D4: todo≈queued/idle, inprogress≈running/nominal,
// inreview≈review/caution, done≈done/merged) — so `COLUMNS` and
// `COLUMN_DOMAIN` below are DERIVED from one record per column instead of
// being two hand-synced tables that happen to share the same four ids. A
// column added here without a `domain` would need one before `COLUMN_DOMAIN`
// could resolve it, rather than silently missing an entry the way two
// separately-maintained tables could.
const COLUMN_DEFS = [
  { id: 'todo', label: 'To-Do', domain: 'queued' },
  { id: 'inprogress', label: 'In Progress', domain: 'running' },
  { id: 'inreview', label: 'In Review', domain: 'review' },
  { id: 'done', label: 'Done', domain: 'done' },
];

/** The board's four columns as an ordered pipeline: [id, display label]. */
export const COLUMNS = COLUMN_DEFS.map((c) => [c.id, c.label]);

/** Column id -> shared domain-state id (see `COLUMN_DEFS` above). */
export const COLUMN_DOMAIN = Object.fromEntries(COLUMN_DEFS.map((c) => [c.id, c.domain]));

/**
 * A task's resting domain-state id: a live agent's own state takes priority
 * over the column's resting tone — the same precedence the top-row StatusPill
 * (agent status vs. task.state chip) already uses.
 * @param {{ column: string }} task
 * @param {{ status: string }|undefined} agent
 * @returns {import('@/lib/domainState.js').DomainStateId}
 */
export const cardDomainId = (task, agent) =>
  agent ? (KIND_TO_DOMAIN[KIND[agent.status]] ?? 'review') : (COLUMN_DOMAIN[task.column] ?? 'queued');
