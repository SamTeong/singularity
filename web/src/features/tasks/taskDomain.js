// Board pipeline + domain-state mapping shared by TasksBoard.jsx (column
// heads, card edges/stamps) and TaskDetailPanel.jsx (Activity stage list,
// head stamp) — was independently re-derived in each file (own COLUMNS/STAGES
// arrays, own COLUMN_DOMAIN/STAGE_DOMAIN tables, own domain-precedence logic)
// with nothing enforcing the copies stayed in sync. Centralized here so a task
// reads the same tone/stage on the board and in its dossier by construction.
import { KIND, KIND_TO_DOMAIN } from '@/lib/agentStatus.js';

/** The board's four columns as an ordered pipeline: [id, display label]. */
export const COLUMNS = [
  ['todo', 'To-Do'],
  ['inprogress', 'In Progress'],
  ['inreview', 'In Review'],
  ['done', 'Done'],
];

// Column id -> shared domain-state id (design.md D4) for the Phosphor
// tone/bilingual mapping: todo≈queued/idle, inprogress≈running/nominal,
// inreview≈review/caution, done≈done/merged.
export const COLUMN_DOMAIN = { todo: 'queued', inprogress: 'running', inreview: 'review', done: 'done' };

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
