// POC-only mock data for the Plans 2D/3D board prototypes.
// Shape mirrors the real server contract (server/plans.mjs listSessions/getSession)
// so the winning POC can switch to fetch('/api/plans/...') without reshaping.
// ponytail: POC — delete along with the losing view once a board is picked.

const plan = (file, title, status, objective, phases, nextSteps, extra = {}) => ({
  file,
  title,
  status,
  statusRaw: status,
  objective,
  currentPhase: extra.currentPhase ?? null,
  phases,
  nextSteps,
  required: extra.required ?? [],
  completed: extra.completed ?? null,
});

const phase = (text, state) => ({ text, state });

// Status buckets: active / done / blocked / superseded / other
export const MOCK_SESSIONS = [
  {
    sid: 'a1b2c3d4-1111-4000-8000-000000000001',
    mtime: '2026-09-29T14:20:00Z',
    branch: 'main',
    cwd: 'C:/git/singularity',
    plans: [
      plan(
        'plan.md',
        'eval-skill-report — Laya layout overhaul',
        'active',
        'Update eval skill SSOT so future reports use reference layout and Laya styling.',
        [phase('Audit current layout', 'done'), phase('Migrate reference files', 'done'), phase('QA both themes', 'open'), phase('Sign-off', 'open')],
        ['Rerun colour regression in dark mode', 'Get user sign-off on QA screenshots'],
        { currentPhase: 'QA both themes', required: ['C:/…/eval-skill-spec.md'] },
      ),
    ],
    notes: [{ file: 'findings/eval-browser-qa.md', title: 'Browser QA findings', plan: 'plan.md' }, { file: 'p1-chrome-record.md', title: 'P1 record', plan: 'plan.md' }],
    state: { generatedAt: '2026-09-29T14:22:31Z', contextTokens: 141000, branch: 'main' },
  },
  {
    sid: 'a1b2c3d4-1111-4000-8000-000000000002',
    mtime: '2026-09-29T11:05:00Z',
    branch: 'fix/e2e-mock-stale-expectations',
    cwd: 'C:/git/singularity',
    plans: [
      plan(
        'plan.md',
        'e2e-mock: fix stale toast-unhover and pricing-seed expectations',
        'done',
        'Make e2e-mock suite green against current toast and pricing code.',
        [phase('Fix toast-unhover spec', 'done'), phase('Fix pricing seed', 'done'), phase('CI run', 'done')],
        ['No required implementation or QA work remains.'],
        { completed: '2026-09-29, session a1b2c3d4-…-0001' },
      ),
    ],
    notes: [],
    state: { generatedAt: '2026-09-29T11:06:02Z', contextTokens: 98000, branch: 'fix/e2e-mock-stale-expectations' },
  },
  {
    sid: 'a1b2c3d4-1111-4000-8000-000000000003',
    mtime: '2026-09-28T19:40:00Z',
    branch: 'main',
    cwd: 'C:/Users/sate/.harness',
    plans: [
      plan(
        'plan.md',
        'Plan — 045789de: harness regen + drift gate',
        'done',
        'Absorb live hand-edits into harness config and regen without drift.',
        [
          phase('1 — audit drift', 'done'),
          phase('2 — absorb CLAUDE.md', 'done'),
          phase('3 — absorb hooks.json', 'done'),
          phase('4 — regen + check', 'done'),
          phase('5 — proposal', 'done'),
          phase('6 — docs', 'done'),
          phase('7 — BIOS update (SKIPPED by user)', 'skipped'),
        ],
        ['Seven-day follow-up open, due 2026-10-05.'],
        { completed: '2026-09-28, session 045789de' },
      ),
    ],
    notes: [{ file: 'phase-4.md', title: 'Phase 4 record', plan: 'plan.md' }, { file: 'verdict.md', title: 'Review verdict', plan: 'plan.md' }],
    state: null,
  },
  {
    sid: 'a1b2c3d4-1111-4000-8000-000000000004',
    mtime: '2026-09-28T16:10:00Z',
    branch: 'unknown',
    cwd: 'C:/Users/sate/OneDrive/wiki',
    plans: [
      plan('plan.md', 'wiki-research — singularity fleet notes', 'active', 'Draft wiki page on fleet orchestration patterns.', [phase('Outline', 'done'), phase('First draft', 'open')], ['Finish fleet section', 'Cite three sources'], { currentPhase: 'First draft' }),
      plan('second-plan.md', 'wiki-research — pricing page audit', 'blocked', 'Audit pricing page consistency.', [phase('Snapshot pages', 'done'), phase('Compare rates', 'open')], ['Unblock on upstream table rename']),
    ],
    notes: [{ file: 'toast-investigation.md', title: 'Toast investigation', plan: null }],
    state: { generatedAt: '2026-09-28T16:12:00Z', contextTokens: 201000, branch: 'unknown' },
  },
  {
    sid: 'a1b2c3d4-1111-4000-8000-000000000005',
    mtime: '2026-09-27T09:00:00Z',
    branch: 'main',
    cwd: 'C:/git/singularity',
    plans: [plan('plan.md', 'usage meter — five-hour meter file', 'superseded', 'Build five-hour usage meter reading.', [phase('Meter file format', 'done')], ['Merged into a1b2…-0006/plan.md'])],
    notes: [],
    state: null,
  },
  {
    sid: 'a1b2c3d4-1111-4000-8000-000000000006',
    mtime: '2026-09-27T08:55:00Z',
    branch: 'feat/usage-meter',
    cwd: 'C:/git/singularity',
    plans: [
      plan(
        'plan.md',
        'usage meter — per-route meters (merged)',
        'active',
        'Separate quota meters per harness route with freshness windows.',
        [phase('Claude meter', 'done'), phase('Codex meter', 'done'), phase('Ollama meter', 'open'), phase('Docs', 'open')],
        ['Finish ollama meter file discovery'],
        { currentPhase: 'Ollama meter', required: ['C:/…/usage-meter-spec.md'] },
      ),
    ],
    notes: [{ file: 'decisions.md', title: 'Meter design decisions', plan: 'plan.md' }, { file: 'probe-results.md', title: 'Probe results', plan: 'plan.md' }],
    state: { generatedAt: '2026-09-27T08:56:10Z', contextTokens: 173000, branch: 'feat/usage-meter' },
  },
  {
    sid: 'a1b2c3d4-1111-4000-8000-000000000007',
    mtime: '2026-09-26T22:30:00Z',
    branch: 'main',
    cwd: 'C:/git/singularity',
    plans: [plan('plan.md', 'Status: six findings fixed; verification complete', 'other', 'Fix review findings on PR #84.', [phase('P1 toast drain budget', 'done'), phase('P2 pricing seed', 'done')], ['Watch CI green run'])],
    notes: [{ file: 'review.md', title: 'PR #84 review', plan: 'plan.md' }],
    state: null,
  },
  {
    sid: 'a1b2c3d4-1111-4000-8000-000000000008',
    mtime: '2026-09-26T14:00:00Z',
    branch: 'main',
    cwd: 'C:/git/singularity',
    plans: [plan('plan.md', 'plan-skeleton — handoff layout v2', 'done', 'Rework plan.md skeleton to lean-authoring layout.', [phase('Skeleton rewrite', 'done'), phase('Reference split', 'done'), phase('Hook update', 'done')], ['No work remains.'], { completed: '2026-09-26' })],
    notes: [{ file: 'handoff-survey.md', title: 'Handoff skill survey', plan: 'plan.md' }],
    state: { generatedAt: '2026-09-26T14:01:00Z', contextTokens: 120000, branch: 'main' },
  },
  {
    sid: 'a1b2c3d4-1111-4000-8000-000000000009',
    mtime: '2026-09-25T10:15:00Z',
    branch: 'feat/timeline-view',
    cwd: 'C:/git/singularity',
    plans: [plan('plan.md', 'timeline-view — day card FLIP animation', 'active', 'Add transform-only travel animation to history day cards.', [phase('Measure jank', 'done'), phase('Implement FLIP', 'open')], ['Prototype FLIP on DayCard'])],
    notes: [],
    state: { generatedAt: '2026-09-25T10:16:00Z', contextTokens: 88000, branch: 'feat/timeline-view' },
  },
  {
    sid: 'a1b2c3d4-1111-4000-8000-000000000010',
    mtime: '2026-09-24T18:45:00Z',
    branch: 'main',
    cwd: 'C:/Users/sate/.harness',
    plans: [plan('plan.md', 'skills-reference manifest materializer', 'done', 'Single SSOT manifest for skill HTML report chrome.', [phase('Materializer', 'done'), phase('Rollout', 'done')], ['No work remains.'], { completed: '2026-09-24' })],
    notes: [],
    state: null,
  },
  {
    sid: 'a1b2c3d4-1111-4000-8000-000000000011',
    mtime: '2026-09-23T09:30:00Z',
    branch: 'main',
    cwd: 'C:/git/singularity',
    plans: [plan('plan.md', 'daemon origin allowlist — DNS rebinding guard', 'done', 'Block DNS rebinding against loopback daemon.', [phase('Origin check', 'done'), phase('Tests', 'done')], ['No work remains.'], { completed: '2026-09-23' })],
    notes: [{ file: 'findings/rebinding-poc.md', title: 'Rebinding PoC', plan: 'plan.md' }],
    state: null,
  },
  {
    sid: 'a1b2c3d4-1111-4000-8000-000000000012',
    mtime: '2026-09-22T13:00:00Z',
    branch: 'main',
    cwd: 'C:/git/singularity',
    plans: [plan('plan.md', 'pricing table — Opus 5.5/5 Sonnet 5.5/5 rates', 'done', 'Add latest model rates to stats pricing table.', [phase('Rate lookup', 'done'), phase('Table update', 'done')], ['No work remains.'], { completed: '2026-09-22' })],
    notes: [],
    state: null,
  },
];

export const planBadge = (status) => {
  switch (status) {
    case 'active': return '●';
    case 'done': return '✓';
    case 'blocked': return '⊘';
    case 'superseded': return '⇄';
    default: return '○';
  }
};