import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// plans.mjs reads only node builtins, but keep the repo convention (rules.test.mjs):
// pin the daemon-state env var to a scratch temp dir before the dynamic import,
// because static imports hoist above an assignment and app-dir.mjs throws without it.
process.env.SINGULARITY_HOME = mkdtempSync(join(tmpdir(), 'sing-home-'));
// The tree plans.mjs actually reads — set BEFORE the import (read at module load).
const ROOT = mkdtempSync(join(tmpdir(), 'sing-plans-'));
process.env.SING_PLANS_ROOT = ROOT;
const { listSessions, getSession } = await import('./plans.mjs');

const SID_A = 'aaaaaaaa-1111-4111-8111-111111111111'; // full plan + note + phase-N + state.json
const SID_B = 'bbbbbbbb-2222-4222-8222-222222222222'; // plan-less (review.md only)
const SID_C = 'cccccccc-3333-4333-8333-333333333333'; // bold status, detected by `# Plan`
const SID_D = 'dddddddd-4444-4444-8444-444444444444'; // detected by `## Objective` only
const SID_E = 'eeeeeeee-5555-4555-8555-555555555555'; // state.json only → hidden
const SID_MISSING = '99999999-9999-4999-8999-999999999999';

const put = (sid, name, body) => {
  mkdirSync(join(ROOT, sid), { recursive: true });
  writeFileSync(join(ROOT, sid, name), body);
};

// VERIFY: plans-test-parse
put(SID_A, 'plan.md', `# Plan — ${SID_A.slice(0, 8)}

Status: active
Origin session: ${SID_A}
Completed: 2026-09-29, session 01a0ec63

## Objective
Ship the plans view.

Current phase: Phase 2 — wiring routes

## Phases
- [x] 1 — model + parse ./phase-1.md
- [ ] 2 — routes
- [-] 3 — frontend (later)

## Next steps
- Required before acting: /tmp/x/decisions.md (change record)
- Call pointer-reviewer.

## Evidence
- notes.md
`);
put(SID_A, 'phase-1.md', 'phase one evidence, no headings\n');
put(SID_A, 'notes.md', '# Note about things\nbody\n');
put(SID_A, 'state.json', JSON.stringify({
  session_id: SID_A,
  generated_at: '2026-09-29T10:00:00.000Z',
  cwd: 'C:/git/singularity',
  branch: 'main',
  context_tokens: 173412,
  dirty: [],
}));

put(SID_B, 'review.md', '# Review\n\n## Correctness\nno plan markers in this file\n');
put(SID_C, 'plan.md', `# Plan — ${SID_C.slice(0, 8)}\nStatus: **complete**\n`);
put(SID_D, 'plan.md', '## Objective\nDetected by heading alone.\n');
put(SID_E, 'state.json', JSON.stringify({ session_id: SID_E, context_tokens: 1 }));

// Non-session siblings: the origin index dir and a non-UUID-shaped dir.
mkdirSync(join(ROOT, 'origins'), { recursive: true });
writeFileSync(join(ROOT, 'origins', SID_E), SID_A);
put('not-a-session', 'plan.md', '# Plan — nope\nStatus: active\n');

test('listSessions: only session dirs with >=1 plan; origins/, non-UUID and plan-less hidden', async () => {
  const list = await listSessions();
  assert.deepEqual(list.map((s) => s.sid).sort(), [SID_A, SID_C, SID_D].sort());

  const a = list.find((s) => s.sid === SID_A);
  assert.equal(a.planCount, 1); // notes.md and phase-1.md are not plans
  assert.deepEqual(a.statusBuckets, { active: 1, done: 0, blocked: 0, superseded: 0, other: 0 });
  assert.equal(typeof a.mtime, 'number');
  assert.ok(a.mtime > 0); // folder mtime

  // state.json summary fields (VERIFY: refine-server-fields)
  assert.equal(a.branch, 'main');
  assert.equal(a.contextTokens, 173412);

  const c = list.find((s) => s.sid === SID_C); // no state.json in this dir
  assert.equal(c.branch, null);
  assert.equal(c.contextTokens, null);
});

test('isPlan detection: `# Plan` heading and `## Objective` heading both qualify', async () => {
  const list = await listSessions();
  const c = list.find((s) => s.sid === SID_C);
  const d = list.find((s) => s.sid === SID_D);
  assert.equal(c.planCount, 1);
  assert.equal(d.planCount, 1);
  assert.equal(c.statusBuckets.done, 1); // Status: **complete** → done
  assert.equal(c.statusBuckets.other, 0);

  const pc = (await getSession(SID_C)).plans[0];
  assert.equal(pc.statusRaw, 'complete'); // markdown ** stripped
  assert.equal(pc.status, 'done');

  const pd = (await getSession(SID_D)).plans[0];
  assert.equal(pd.status, 'other'); // no Status: line
  assert.equal(pd.objective, 'Detected by heading alone.');
});

test('getSession: parses plan fields, phases/next steps/required, groups notes, reads state.json', async () => {
  const r = await getSession(SID_A);
  assert.equal(r.ok, true);
  assert.equal(r.sid, SID_A);
  assert.equal(r.plans.length, 1);

  const p = r.plans[0];
  assert.equal(p.file, 'plan.md');
  assert.equal(p.title, `Plan — ${SID_A.slice(0, 8)}`);
  assert.equal(p.status, 'active');
  assert.equal(p.statusRaw, 'active');
  assert.equal(p.objective, 'Ship the plans view.');
  assert.equal(p.currentPhase, 'Phase 2 — wiring routes');
  assert.deepEqual(p.phases, [
    { text: '1 — model + parse ./phase-1.md', state: 'done' },
    { text: '2 — routes', state: 'open' },
    { text: '3 — frontend (later)', state: 'skipped' },
  ]);
  assert.deepEqual(p.nextSteps, [
    'Required before acting: /tmp/x/decisions.md (change record)',
    'Call pointer-reviewer.',
  ]);
  assert.deepEqual(p.required, ['/tmp/x/decisions.md']); // parenthetical dropped
  assert.equal(p.completed, '2026-09-29, session 01a0ec63');

  assert.deepEqual(r.notes.map((n) => n.file).sort(), ['notes.md', 'phase-1.md']);
  // Both notes are mentioned by the plan body (## Evidence / ## Phases link).
  assert.deepEqual([...new Set(r.notes.map((n) => n.plan))], ['plan.md']);

  assert.deepEqual(r.state, {
    generatedAt: '2026-09-29T10:00:00.000Z',
    cwd: 'C:/git/singularity',
    branch: 'main',
    contextTokens: 173412,
  });
});

test('getSession: plan-less folder resolves with no plans; missing sid and traversal rejected', async () => {
  const b = await getSession(SID_B);
  assert.equal(b.ok, true); // the dir exists — notes are still browsable
  assert.deepEqual(b.plans, []);
  assert.deepEqual(b.notes.map((n) => n.file), ['review.md']);
  assert.equal(b.notes[0].plan, null); // nothing to group it to
  assert.equal(b.notes[0].title, 'Review');
  assert.equal(b.state, null);

  const miss = await getSession(SID_MISSING);
  assert.equal(miss.ok, false);
  assert.equal(miss.error, 'not found');

  for (const bad of ['', 'not-a-sid!', '../origins', '..\\..\\etc', null, undefined, 42,
    `${SID_A}/../../x`, 'ZZZZZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZZZZZZZZZ']) {
    const r = await getSession(bad);
    assert.equal(r.ok, false, `sid ${String(bad)} must be rejected`);
  }
});
