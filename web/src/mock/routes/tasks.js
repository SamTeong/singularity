// Task board routes: the kanban surface. Mirrors server/tasks.mjs — GET /tasks
// returns the snapshotTasks shape, and every mutation broadcasts the `tasks`
// WS frame (the same shape the on-connect burst sends, ws.js) so the board
// converges from the socket (design.md D7). The mock has no git worktrees, no
// agent sessions, and no filesystem, so createTask skips the git/fs side
// effects the daemon performs and just records the card.
import { Response } from 'miragejs';
import { db } from '../db.js';
import { broadcast } from '../ws.js';
import { parseBody } from '../helpers.js';

const COLUMNS = ['todo', 'inprogress', 'inreview', 'done'];
// Per-column state vocabulary — mirrors server/tasks.mjs STATES. updateTask
// hard-rejects a state that isn't valid for its column.
const STATES = {
  todo: ['analyzing', 'clarifying', 'awaiting plan approval'],
  inprogress: ['working', 'implementing', 'fixing'],
  inreview: ['reviewing', 'parked — needs human', 'parked — merge conflict', 'awaiting human merge', 'awaiting human review', 'stopped — budget'],
  done: ['complete', 'report ready'],
};
const OVERLAY_STATES = ['rate-limited'];

// The `tasks` WS frame — same shape as the on-connect burst (ws.js), so a
// mutation converges the board from the socket.
function tasksFrame() {
  return { t: 'tasks', tasks: db.tasks, history: db.taskHistory };
}

// Normalize free-form tags: trim, lowercase, drop blanks, dedupe (server/tasks.mjs).
function normalizeTags(tags) {
  return [...new Set((tags || []).map((s) => String(s).trim().toLowerCase()).filter(Boolean))];
}

// Max-turn cap from the dialog: positive int or null (server/tasks.mjs posInt).
const posInt = (v) => { const n = Math.trunc(Number(v)); return Number.isFinite(n) && n > 0 ? n : null; };

export function registerTasks(server) {
  // GET /tasks — snapshotTasks() shape: { tasks, history }. The client doesn't
  // fetch this today (tasks arrive via the WS burst), but the daemon serves it
  // — keep parity so a future caller never hits an unhandled route.
  server.get('/tasks', () => ({ tasks: [...db.tasks], history: [...db.taskHistory] }));

  // DELETE /tasks/history/:id — registered before the parameterised POST routes
  // (static sibling before parameterised, design.md D8).
  server.delete('/tasks/history/:id', (schema, req) => {
    const i = db.taskHistory.findIndex((h) => h.id === req.params.id);
    if (i < 0) return new Response(400, {}, { ok: false, error: 'no such history entry' });
    db.taskHistory.splice(i, 1);
    broadcast(tasksFrame());
    return { ok: true };
  });

  // POST /tasks — create a card. The daemon validates repo/title/description,
  // creates a git worktree + agent session, and persists; the mock just records
  // the card (no fs, no session) and broadcasts.
  server.post('/tasks', (schema, req) => {
    const body = parseBody(req);
    if (!body.repo || !body.title?.trim() || !body.description?.trim()) {
      return new Response(400, {}, { ok: false, error: 'repo, title and description required' });
    }
    const task = {
      id: crypto.randomUUID(),
      title: body.title.trim(),
      description: body.description.trim(),
      repo: body.repo,
      kind: 'plain', // no git in mock mode
      worktree: null, branch: null, baseBranch: null,
      model: body.model,
      implModel: body.implModel,
      reviewerModel: body.reviewerModel,
      orchestratorMaxTurns: posInt(body.orchestratorMaxTurns),
      implMaxTurns: posInt(body.implMaxTurns),
      reviewerMaxTurns: posInt(body.reviewerMaxTurns),
      scopes: body.scopes || [],
      tags: normalizeTags(body.tags),
      requirePlanApproval: !!body.requirePlanApproval,
      mergeMode: null, // kind is 'plain' — no merge policy
      column: 'todo',
      state: 'analyzing',
      sessionId: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...(body.tool ? { tool: body.tool } : {}),
    };
    db.tasks.push(task);
    broadcast(tasksFrame());
    return { ok: true, task };
  });

  // POST /tasks/:id/status — move a card (column/state). Mirrors
  // server/tasks.mjs updateTask: validates column + state, bumps updatedAt.
  server.post('/tasks/:id/status', (schema, req) => {
    const t = db.tasks.find((x) => x.id === req.params.id);
    if (!t) return new Response(400, {}, { ok: false, error: 'no such task' });
    const { column, state } = parseBody(req);
    if (column !== undefined) {
      if (!COLUMNS.includes(column)) {
        return new Response(400, {}, { ok: false, error: `bad column (expected ${COLUMNS.join('|')})` });
      }
      const wasDone = t.column === 'done';
      t.column = column;
      if (column === 'done' && !wasDone) {
        t.doneAt = Date.now();
        t.state = 'complete'; // clear stale agent state on manual move; explicit state param below still wins
      } else if (column !== 'done' && wasDone) {
        delete t.doneAt;
      }
    }
    if (state !== undefined) {
      const col = column ?? t.column;
      const s = String(state).slice(0, 120);
      const allowed = [...(STATES[col] ?? []), ...OVERLAY_STATES];
      if (!allowed.includes(s)) {
        return new Response(400, {}, { ok: false, error: `bad state for ${col} (expected ${allowed.join('|')})` });
      }
      t.state = s;
    }
    t.updatedAt = Date.now();
    broadcast(tasksFrame());
    return { ok: true, task: t };
  });

  // POST /tasks/:id/conclude — move a card to history with outcome + stats.
  // finalStats mirrors statsFor's shape (server/stats.mjs) — the mock has no
  // real session, so a zeroed snapshot.
  server.post('/tasks/:id/conclude', (schema, req) => {
    const outcome = parseBody(req).outcome;
    if (outcome !== 'completed' && outcome !== 'abandoned') {
      return new Response(400, {}, { ok: false, error: 'bad outcome (expected completed|abandoned)' });
    }
    const i = db.tasks.findIndex((x) => x.id === req.params.id);
    if (i < 0) return new Response(400, {}, { ok: false, error: 'no such task' });
    const [t] = db.tasks.splice(i, 1);
    db.taskHistory.push({
      ...t,
      outcome,
      concludedAt: Date.now(),
      finalStats: {
        turns: 0, tokens: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
        models: [], exists: false, estCostUsd: null, costUsd: null, costSource: null,
        apiMs: null, wallMs: null, busyMs: 0,
      },
    });
    broadcast(tasksFrame());
    return { ok: true };
  });
}
