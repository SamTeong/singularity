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

/** Overlay limit states — a task keeps its column and agent, so its badge
 *  must show alongside an attached agent's pill (server/tasks.mjs
 *  OVERLAY_STATES). */
const LIMIT_STATES = ['usage-limited', 'rate-limited'];

/** @param {{ state?: string }} task */
export const isLimitState = (task) => LIMIT_STATES.includes(task.state);

/**
 * The task-state text a badge shows: `task.state`, plus the local reset
 * wall-clock for a Claude usage limit when the daemon parsed one
 * (server/tasks.mjs limitResetAt). A reset on a later local day carries an
 * unambiguous `YYYY-MM-DD` so it is not read as today (or already past).
 * @param {{ state?: string, limitResetAt?: number }} task
 * @param {number} [now] epoch ms, injectable for tests
 * @returns {string|undefined}
 */
export const taskStateLabel = (task, now = Date.now()) => {
  if (task.state !== 'usage-limited' || typeof task.limitResetAt !== 'number') return task.state;
  const pad = (n) => String(n).padStart(2, '0');
  const d = new Date(task.limitResetAt);
  const clock = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const resetDay = new Date(d);
  resetDay.setHours(0, 0, 0, 0);
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return `usage-limited · resets ${resetDay > today ? `${date} ${clock}` : clock}`;
};

/**
 * Epoch ms the task first entered `columnId`. To-Do starts at task creation;
 * later columns use their first durable transition record targeting that
 * column (appended by server/tasks.mjs updateTaskInner on a real column
 * change). Null when the stage has no known entry time.
 * @param {{ to: string, at: number }[]|undefined} transitions
 * @param {string} columnId
 * @param {number|undefined} createdAt
 * @returns {number|null}
 */
export const firstEnteredAt = (transitions, columnId, createdAt) =>
  (columnId === 'todo' && typeof createdAt === 'number' ? createdAt : null)
    ?? transitions?.find((r) => r.to === columnId)?.at
    ?? null;
