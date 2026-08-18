// Static fixtures for the deck simulation. Pure data only — no DOM, no
// timers, no React. Transcribed verbatim from
// docs/one-shot/3d/sample-gitlab-3d-scan.html.

// Source L815.
export type ToneName = 'mint' | 'blue' | 'amber' | 'red';

export const TONES: Record<ToneName, string> = {
  mint: 'var(--mint)',
  blue: 'var(--blue)',
  amber: 'var(--amber)',
  red: 'var(--red-hi)',
};

// Source L833-843/844-854. A term row's `kind` is one of '', 'dim', 'ok' —
// '' produces `className="term-row "` (trailing space) exactly like the
// source's `'term-row ' + kind`; that inconsistency is authored, not a bug.
export type TermKind = '' | 'dim' | 'ok';
export type TermRowSeed = readonly [TermKind, string];

export const termRows: readonly TermRowSeed[] = [
  ['dim', 'SINGULARITY SESSION BRIDGE · REV 0.9'],
  ['', '› pnpm test -- web/src/lib/domainState.test.mjs'],
  ['dim', 'TAP VERSION 13'],
  ['ok', '✓ MAPS AGENT STATES TO TASK DOMAINS'],
  ['ok', '✓ PRESERVES REVIEW STATE ON DISCONNECT'],
  ['ok', '✓ NORMALIZES BACKGROUND COMPLETION'],
  ['dim', '# TESTS 3 · PASS 3 · FAIL 0'],
  ['', '› git status --short'],
  ['ok', 'WORKTREE CLEAN · READY FOR REVIEW'],
];

export const liveRows: readonly TermRowSeed[] = [
  ['ok', '✓ READ server/agents.mjs'],
  ['ok', '✓ EDIT web/src/features/tasks'],
  ['dim', 'GREP "reg(" server/ · 12 HITS'],
  ['ok', '✓ TEST server/pty.test.mjs · PASS'],
  ['', '› git rebase main'],
  ['dim', 'BUILD web → dist · OK'],
  ['ok', '✓ WRITE .tickets/TSK-118/plan.md'],
  ['', '› pnpm test'],
  ['dim', 'DIFF 14 FILES · REVIEW PENDING'],
];

// Source L978-984. The source's 4th field is an HTML string set via
// innerHTML (`'<b>CODE:</b> SPEC·121<br>...'`). Restructured here into typed
// [label, value] pairs — rendered as `<b>{label}</b>{' ' + value}` with a
// `<br/>` before every item except the first, which reproduces the exact
// markup (including the authored space after `</b>`) without
// dangerouslySetInnerHTML.
export interface FlowStep {
  kanji: string;
  title: string;
  text: string;
  code: readonly (readonly [string, string])[];
}

export const flowData: readonly FlowStep[] = [
  {
    kanji: '仕様',
    title: 'DEFINE THE OUTCOME',
    text: 'Write the requirement and acceptance criteria once. The task begins with a durable description of done.',
    code: [
      ['CODE:', 'SPEC·121'],
      ['STATE:', 'APPROVED'],
      ['INPUT:', 'REQUIREMENTS'],
    ],
  },
  {
    kanji: '任務',
    title: 'CREATE THE OPERATIONAL RECORD',
    text: 'The task board binds the requirement to status, tags, repository, and the agent that will own the work.',
    code: [
      ['TASK:', 'TSK·121'],
      ['QUEUE:', 'READY'],
      ['LABEL:', 'AGENT-OK'],
    ],
  },
  {
    kanji: '分岐',
    title: 'ISOLATE THE CHANGE',
    text: 'Singularity creates a dedicated git worktree and branch for the task, so parallel agents can build without conflicting with one another or contaminating main.',
    code: [
      ['PATH:', '.WORKTREES/9E0B59D'],
      ['BRANCH:', 'TASK/9E0B59D'],
      ['STATE:', 'CLEAN'],
    ],
  },
  {
    kanji: '実行',
    title: 'DISPATCH A LIVE AGENT',
    text: 'A coding-agent PTY starts inside the worktree with the selected model and context scopes. Its terminal remains available in the session dock.',
    code: [
      ['MODEL:', 'OPUS'],
      ['SESSION:', '7FE813AB'],
      ['CHANNEL:', 'LIVE'],
    ],
  },
  {
    kanji: '審査',
    title: 'MAKE THE HUMAN RULING',
    text: 'When work is ready, inspect the diff and transcript, resolve the review, and conclude or return the task without losing its history.',
    code: [
      ['DIFF:', 'READY'],
      ['TESTS:', 'PASS'],
      ['RULING:', 'REQUIRED'],
    ],
  },
];

// Source L933 — the seed curve for the usage chart's 48-sample window. Kept
// here as a pure function (rather than inline in chartData.ts) so the
// mutable array in chartData.ts is built from the exact same authored
// formula and nothing else drifts it at construction time.
export function seedChartData(length = 48): number[] {
  return Array.from({ length }, (_, i) => 42 + Math.sin(i / 4.2) * 13 + Math.cos(i / 8) * 8);
}
