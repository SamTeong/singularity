// Demo driver for the Tasks board — creates N [DEMO] cards and walks each
// through the full workflow (plan → in progress → review → maybe REJECT → fix →
// review → APPROVE → done → auto-delete) using mock transitions only.
// Zero tokens: tasks are created with mock:true, so the daemon spawns an idle
// claude (no workflow prompt) — a live session for the status pill, but no turn
// ever starts. We drive every column move ourselves via the plain HTTP status
// endpoint; at Done the daemon removes the session (pill clears). Model is haiku.
//
// Cards run concurrently with jitter (multiple progressing at once). Each review
// has a 30% reject chance, looping up to the server's cap (3). After 3s on Done a
// card is deleted outright (conclude → delete-history nets to gone, no history),
// so nothing is left to clean up.
//
// NOTE: needs a daemon running the mock-flag build of createTask (restart :4317
// or run an isolated daemon to pick it up).
//
// Run:  node --env-file-if-exists=.env scripts/demo-tasks.mjs [N]   (from repo root)
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert';

const PORT = process.env.PORT;
if (!PORT) { console.error('PORT not set (run with --env-file-if-exists=.env from repo root)'); process.exit(1); }
const TOKEN = process.env.SING_TOKEN || null;
const BASE = `http://127.0.0.1:${PORT}`;
const authHeaders = TOKEN ? { 'x-sing-token': TOKEN } : {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const STEP_MS = 1500;
const REJECT_RATE = 0.3;
const MAX_REJECTS = 3;          // mirrors MAX_REVIEW_REJECTS in server/tasks.mjs
const DONE_TTL_MS = 3000;       // dwell on Done before auto-delete
const jitter = (ms) => ms * (0.6 + Math.random() * 0.8); // ±40% so concurrent cards desync

async function api(path, body, method = 'POST') {
  // Only set content-type when a body is sent — Fastify 400s a bodyless request
  // (e.g. DELETE) that still declares content-type: application/json.
  const opts = body != null
    ? { method, headers: { 'content-type': 'application/json', ...authHeaders }, body: JSON.stringify(body) }
    : { method, headers: authHeaders };
  const res = await fetch(BASE + path, opts);
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.ok === false) throw new Error(`${path} -> ${res.status} ${j.error || ''}`);
  return j;
}

async function move(t, column, state) {
  await api(`/tasks/${t.id}/status`, { column, state });
  console.log(`  [${t.id.slice(0, 8)}] ${column.padEnd(10)} ${state}`);
  await sleep(jitter(STEP_MS));
}

async function runTask(n) {
  await sleep(Math.random() * 2000); // start jitter — stagger card creation
  const repo = mkdtempSync(join(tmpdir(), `sing-demo-${n}-`)); // non-git → kind:'plain', no worktree
  const title = `[DEMO] Sample task ${n}`;
  const { task } = await api('/tasks', {
    repo, title,
    description: `Mock demo task ${n}. No real work is performed; transitions are scripted.`,
    model: 'claude-haiku-4-5-20251001',
    requirePlanApproval: false,
    mergeMode: 'manual',
    mock: true, // idle claude, no workflow prompt → zero tokens, live status pill
  });
  console.log(`  [${task.id.slice(0, 8)}] created "${title}" (idle session, 0 tokens)`);

  // mock-plan: write the Plan.md the orchestrator would have produced
  writeFileSync(join(task.ticketDir, 'Plan.md'), `# Plan — ${title}\n\n- Mock step 1\n- Mock step 2\n`);
  await sleep(jitter(STEP_MS));

  await move(task, 'inprogress', 'implementing');
  let rejects = 0;
  for (;;) {
    await move(task, 'inreview', 'reviewing');
    if (rejects < MAX_REJECTS && Math.random() < REJECT_RATE) {
      rejects++;
      assert(rejects <= MAX_REJECTS, 'reject count exceeded server cap');
      await move(task, 'inprogress', `fixing (review ${rejects}/${MAX_REJECTS})`); // mock-REJECT
      continue;
    }
    break; // mock-APPROVE
  }
  await move(task, 'done', 'complete'); // daemon drops the session at done
  console.log(`  [${task.id.slice(0, 8)}] ✔ done (${rejects} reject${rejects === 1 ? '' : 's'}) — deleting in ${DONE_TTL_MS / 1000}s`);

  await sleep(DONE_TTL_MS);
  // Delete outright: conclude pushes to history, delete-history removes it → gone.
  await api(`/tasks/${task.id}/conclude`, { outcome: 'completed' });
  await api(`/tasks/history/${task.id}`, null, 'DELETE');
  console.log(`  [${task.id.slice(0, 8)}] 🗑 deleted (no history)`);
}

const COUNT = Number(process.argv[2]) || 3;
console.log(`Starting ${COUNT} [DEMO] cards (concurrent, jittered)...\n`);
await Promise.all(Array.from({ length: COUNT }, (_, i) => runTask(i + 1)));
console.log('\nDemo complete. No cards left behind.');
