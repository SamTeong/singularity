// Builds the e2e sandbox: fixture corpora on disk + the STATE_DIR root files
// that point every picker at them. Called by serve.mjs BEFORE the daemon boots,
// because each root is read from state/*.json at request time and falls back to
// the user's real ~/.claude, ~/wiki, ~/.claude/skills when the file is absent.
//
// Everything seeded here is inert: agents load as 'detached' (agents.mjs init)
// and tasks load as plain records (tasks.mjs initTasks) — neither spawns a pty,
// so nothing reaches reg.create/ensureTrusted, which would write the real
// ~/.claude.json. Crons and background jobs are seeded disabled with a
// far-future expression for the same reason.
import { mkdirSync, writeFileSync, rmSync, chmodSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import {
  TMP, HOME_DIR, STATE_DIR, TRUSTED_DIR, USAGE_STATE_DIR, BIN_DIR,
  PROJECTS_DIR, WIKI_DIR, SKILLS_DIR, WORKSPACE_DIR, EXPLORER_DIR, SCRATCH_DIR,
  PROJECT_A, PROJECT_B, WIKI_NAME, SESSION_COUNT_A, RICH_SESSION, sessionId,
} from './paths.mjs';

const dir = (p) => { mkdirSync(p, { recursive: true }); return p; };
const file = (p, s) => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, s, 'utf8'); return p; };
const json = (p, v) => file(p, JSON.stringify(v, null, 2));
const jsonl = (p, events) => file(p, events.map((e) => JSON.stringify(e)).join('\n') + '\n');

// Fixed clock so list ordering, "N min ago" captions and cost columns are
// deterministic across runs. 2025-06-01T09:00:00Z.
const T0 = 1748768400000;

// ---------------------------------------------------------------- transcripts

function transcript(cwd, i) {
  const ts = (n) => new Date(T0 + i * 60_000 + n * 1000).toISOString();
  return [
    { type: 'user', cwd, timestamp: ts(0), message: { role: 'user', content: `Fixture request ${i}: summarize the module.` } },
    { type: 'assistant', cwd, timestamp: ts(1), message: { role: 'assistant', model: 'claude-opus-4-5-20251101', content: [{ type: 'text', text: `Fixture reply ${i}.` }] } },
    { type: 'ai-title', aiTitle: `Fixture session ${i}` },
  ];
}

function richTranscript(cwd) {
  const ts = (n) => new Date(T0 + 3600_000 + n * 1000).toISOString();
  return [
    { type: 'user', cwd, timestamp: ts(0), message: { role: 'user', content: 'Trace the retry path and tell me where the backoff is capped.' } },
    { type: 'assistant', cwd, timestamp: ts(1), message: { role: 'assistant', model: 'claude-opus-4-5-20251101', content: [{ type: 'thinking', thinking: 'Look for the backoff constant first.' }] } },
    { type: 'assistant', cwd, timestamp: ts(2), message: { role: 'assistant', model: 'claude-opus-4-5-20251101', content: [{ type: 'tool_use', name: 'Grep', input: { pattern: 'backoff', path: 'src' } }] } },
    { type: 'user', cwd, timestamp: ts(3), message: { role: 'user', content: [{ type: 'tool_result', content: 'src/retry.js:12: const MAX_BACKOFF_MS = 30000;' }] } },
    { type: 'assistant', cwd, timestamp: ts(4), message: { role: 'assistant', model: 'claude-opus-4-5-20251101', content: [{ type: 'text', text: 'Backoff is capped at 30s in `src/retry.js:12`.' }] } },
    { type: 'ai-title', aiTitle: 'Retry backoff cap' },
  ];
}

// Transcript mtime drives both the list order and the "running" pill (a file
// touched within 30s counts as a live external session). Freshly written fixture
// files would all read as running and then flip mid-run, so backdate them —
// spaced a minute apart for a stable reverse-chronological order.
function backdate(p, i) {
  const t = new Date(T0 + i * 60_000);
  utimesSync(p, t, t);
}

function seedProjects() {
  const a = dir(join(PROJECTS_DIR, PROJECT_A));
  for (let i = 0; i < SESSION_COUNT_A; i++) backdate(jsonl(join(a, `${sessionId(i)}.jsonl`), transcript('/fixture/alpha', i)), i);
  const b = dir(join(PROJECTS_DIR, PROJECT_B));
  backdate(jsonl(join(b, `${RICH_SESSION}.jsonl`), richTranscript('/fixture/beta')), SESSION_COUNT_A + 1);
  backdate(jsonl(join(b, `${sessionId(901)}.jsonl`), transcript('/fixture/beta', 901)), SESSION_COUNT_A);

  // memory lives at <root>/<project>/memory/*.md — same tree, second root.
  file(join(a, 'memory', 'MEMORY.md'), '# Memory index\n- [Retry cap](retry-cap.md) — backoff ceiling lives in retry.js\n');
  file(join(a, 'memory', 'retry-cap.md'), '---\nname: retry-cap\ndescription: backoff ceiling\nmetadata:\n  type: project\n---\n\nBackoff caps at 30s.\n');
  file(join(b, 'memory', 'deploy-notes.md'), '---\nname: deploy-notes\ndescription: staging deploy quirks\nmetadata:\n  type: project\n---\n\nStaging deploys need a manual cache purge.\n');
}

// ----------------------------------------------------------------------- wiki

function seedWiki() {
  const w = dir(join(WIKI_DIR, WIKI_NAME));
  file(join(w, 'index.md'), '---\ntitle: Handbook\nstatus: stable\ncategory: overview\n---\n\nStart at [[architecture]], then read [[glossary]].\n');
  file(join(w, 'architecture.md'), '---\ntitle: Architecture\nstatus: draft\ncategory: design\n---\n\nThe daemon owns state; the shell renders it. See [[glossary]].\n');
  file(join(w, 'glossary.md'), '---\ntitle: Glossary\nstatus: stable\ncategory: reference\n---\n\n**Worktree** — an isolated checkout per task.\n');
  // A page in a subdirectory: WikiPanel derives the category filter from the
  // folder segment of a page's rel path (category(p.rel)), NOT from frontmatter,
  // so a wholly flat corpus leaves the filter unrendered and untestable.
  file(join(w, 'design', 'daemon.md'), '---\ntitle: Daemon\nstatus: draft\n---\n\nThe daemon binds loopback only.\n');
}

// --------------------------------------------------------------------- skills

function seedSkills() {
  const skill = (scope, name, desc, body) => {
    const d = dir(join(SKILLS_DIR, scope, '.claude', 'skills', name));
    file(join(d, 'SKILL.md'), `---\nname: ${name}\ndescription: ${desc}\n---\n\n${body}\n`);
    return d;
  };
  const lint = skill('coding', 'lint-guard', 'Blocks a commit when the linter is unhappy.', '# Lint guard\n\nRun the linter before staging.');
  file(join(lint, 'reference.md'), '# Rule table\n\nOne row per rule.\n');
  skill('design', 'color-audit', 'Checks palette contrast against WCAG AA.', '# Color audit\n\nContrast first, hue second.');
}

// -------------------------------------------------------------------- explorer

function seedExplorer() {
  const root = dir(EXPLORER_DIR);
  file(join(root, 'notes.md'), '# Notes\n\nExplorer fixture markdown.\n');
  file(join(root, 'script.mjs'), 'export const explorerFixture = true;\n');
  file(join(root, '.hidden'), 'hidden fixture\n');
  file(join(root, 'subdir', 'nested.txt'), 'Nested file content.\n');
  // 1x1 transparent PNG — decoded from the canonical "smallest PNG" fixture
  // bytes, not a binary asset checked into the repo.
  writeFileSync(join(root, 'pixel.png'), Buffer.from(
    '89504e470d0a1a0a0000000d4948445200000001000000010100000000a09767900000000b49444154789c636000020000050001e9fadcd80000000049454e44ae426082',
    'hex',
  ));
}

// -------------------------------------------------- workspace: config/hooks/rules

function seedWorkspace() {
  const c = dir(join(WORKSPACE_DIR, '.claude'));
  json(join(c, 'settings.json'), { permissions: { allow: ['Bash(git status)'] }, env: { FIXTURE: 'project' } });
  json(join(c, 'settings.local.json'), { env: { FIXTURE: 'local' } });
  file(join(c, 'hooks', 'pre-commit.sh'), '#!/bin/sh\n# fixture hook\necho "pre-commit fixture"\n');
  file(join(c, 'hooks', 'format.ps1'), '# fixture hook\nWrite-Output "format fixture"\n');
  file(join(c, 'rules', 'style.md'), '# Style\n\nTwo-space indent. No trailing whitespace.\n');
  file(join(c, 'rules', 'testing.md'), '# Testing\n\nOne runnable check per non-trivial branch.\n');
  dir(SCRATCH_DIR); // non-git on purpose
}

// ------------------------------------------------------------- daemon state

const TAGS = ['fixture', 'ui'];

function task(id, title, column, state, extra = {}) {
  return {
    id, title, description: `${title} — seeded fixture card.`,
    repo: SCRATCH_DIR, kind: 'plain', worktree: null, branch: null, baseBranch: null,
    ticketDir: join(TRUSTED_DIR, '.tickets', id.slice(0, 8)), reportDir: join(TRUSTED_DIR, '.tickets', id.slice(0, 8)),
    model: 'claude', implModel: 'claude', reviewerModel: 'claude',
    orchestratorMaxTurns: null, implMaxTurns: null, reviewerMaxTurns: null,
    scopes: [], tags: TAGS, requirePlanApproval: false, mergeMode: null,
    column, state, sessionId: null, createdAt: T0, updatedAt: T0, ...extra,
  };
}

function seedState() {
  dir(STATE_DIR);
  // Picker roots — without these every panel reads the user's real dotfiles.
  json(join(STATE_DIR, 'sessions-root.json'), { root: PROJECTS_DIR });
  json(join(STATE_DIR, 'memory-root.json'), { root: PROJECTS_DIR });
  json(join(STATE_DIR, 'wiki-root.json'), { root: WIKI_DIR });
  json(join(STATE_DIR, 'skills-roots.json'), { roots: [SKILLS_DIR] });
  json(join(STATE_DIR, 'config-roots.json'), [WORKSPACE_DIR]);
  json(join(STATE_DIR, 'hook-roots.json'), [WORKSPACE_DIR]);
  json(join(STATE_DIR, 'rules-roots.json'), [WORKSPACE_DIR]);
  // Explorer's persisted root otherwise defaults to '~' — point it at the
  // corpus dir up front so specs don't have to drive DirPicker.
  json(join(STATE_DIR, 'explorer-state.json'), { root: EXPLORER_DIR });

  // No agents: an empty registry keeps the dock in its empty state and
  // guarantees no reattach path is reachable.
  json(join(STATE_DIR, 'agents.json'), { agents: [], recentRepos: [SCRATCH_DIR] });

  json(join(STATE_DIR, 'tasks.json'), {
    tasks: [
      task(sessionId(1001), 'Seeded todo card', 'todo', 'analyzing'),
      task(sessionId(1002), 'Seeded in-progress card', 'inprogress', 'working'),
      task(sessionId(1003), 'Seeded review card', 'inreview', 'awaiting human review'),
      task(sessionId(1004), 'Seeded done card', 'done', 'report ready'),
    ],
    history: [
      { ...task(sessionId(1005), 'Concluded fixture run', 'done', 'report ready'), outcome: 'completed', concludedAt: T0 + 7200_000, finalStats: { turns: 4, totalTokens: 12_345, activeMs: 120_000, cost_usd: 0.42 } },
      { ...task(sessionId(1006), 'Abandoned fixture run', 'done', 'abandoned'), outcome: 'abandoned', concludedAt: T0 + 10800_000, finalStats: { turns: 1, totalTokens: 900, activeMs: 20_000, cost_usd: 0.01 } },
    ],
  });

  // Disabled + far-future expression: enabling one from a spec must not make it
  // due, because firing spawns a real agent run.
  const cron = (i, title, expr) => ({
    id: sessionId(2000 + i), title, enabled: false, cronExpr: expr, description: `${title} — seeded fixture job.`,
    cwd: SCRATCH_DIR, model: 'claude', scopes: [], permissionMode: 'acceptEdits',
    lastSessionId: null, lastFiredAt: null, nextAt: null, createdAt: T0, updatedAt: T0,
  });
  json(join(STATE_DIR, 'crons.json'), { crons: [cron(1, 'Nightly fixture sweep', '0 4 1 1 *'), cron(2, 'Weekly fixture digest', '0 5 1 1 *')] });

  const bgJob = (i, title) => ({
    id: sessionId(3000 + i), title, description: `${title} — seeded fixture job.`, cwd: SCRATCH_DIR,
    cooldownHours: 24, enabled: false,
    window: { startHour: 9, endHour: 18, days: [1, 2, 3, 4, 5] },
    thresholds: { claude: { start: 50, stop: 75, weeklyMax: 50 }, ollama: { start: 50, stop: 75, weeklyMax: 50 } },
    models: { claude: 'opus', ollama: 'glm-5.2:cloud' },
    tokenCaps: { claude: 15_000_000, ollama: 15_000_000 },
    scopes: [], conclude: 'inreview', lastRunAt: null, lastTaskId: null,
  });
  json(join(STATE_DIR, 'background.json'), { jobs: [bgJob(1, 'Fixture backlog groomer'), bgJob(2, 'Fixture dependency check')] });
}

// ------------------------------------------------------------ claude stub bin

// Keepalive stub, same shape as server/agents.test.mjs. CLAUDE_BIN must exist
// on disk — resolveBin() returns null otherwise and requireEnv refuses to boot.
//
// win32 has no POSIX shell to write a `sleep`-style script into, so this points
// at cmd.exe instead. Verified empirically (spawned through node-pty exactly as
// agents.mjs spawnPty() does, with claude-style argv like `--session-id <id>
// --name <title>`): cmd.exe doesn't recognize any of those as its own switches
// (which would need a leading `/`), so it ignores them, prints its usual banner
// + prompt, and sits there indefinitely — it does not exit on its own. That
// matches the POSIX branch's `sleep 2147483647` closely enough for a keepalive.
// Currently moot either way: the sandbox seeds zero agents (see seedState
// below) and no spec drives New session/Resume/"Run now" to completion (see
// e2e/README.md "Never drive these"), so as of this writing nothing in the
// suite actually spawns this binary — only /capabilities' existsSync check
// touches it.
export function stubClaudeBin() {
  if (process.platform === 'win32') return join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
  const p = join(dir(BIN_DIR), 'claude-stub.sh');
  file(p, '#!/bin/sh\nexec sleep 2147483647\n');
  chmodSync(p, 0o755);
  return p;
}

// Wipe and rebuild the whole sandbox. Idempotent — a killed run leaves a dirty
// e2e/.tmp behind and the next run must still be green.
export function seed() {
  rmSync(TMP, { recursive: true, force: true });
  [HOME_DIR, TRUSTED_DIR, USAGE_STATE_DIR, BIN_DIR].forEach(dir);
  seedProjects();
  seedWiki();
  seedSkills();
  seedExplorer();
  seedWorkspace();
  seedState();
  return { claudeBin: stubClaudeBin() };
}
