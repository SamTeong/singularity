// Agent registry: spawn/kill, in-memory ptys, agents.json persistence, recent-repos.
// Emits 'output'{id,data}, 'status'{id,status}, 'list' — pty-ws fans these out to sockets.
import { spawn } from 'node-pty';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, accessSync, constants } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { isClaudeModel, isCodexModel, validateToolModel } from './models.mjs';
import { findCodexThread, codexThreadExists, normPath } from './codex-thread.mjs';
import { APP_DIR, STATE_DIR, CACHE_DIR, WORKTREES_DIR, TICKETS_DIR, REPORTS_DIR } from './app-dir.mjs';
export { APP_DIR, STATE_DIR, CACHE_DIR, WORKTREES_DIR, TICKETS_DIR, REPORTS_DIR };

export const RING_MAX = 256 * 1024; // per-agent in-mem scrollback cap (bytes). Disk ring = Phase 3.
const IDLE_MS = 2000; // no pty output for this long while running → 'idle' (waiting for input).
const RECENT_MAX = 10;

// --- app-data dir ---
// APP_DIR is defined in app-dir.mjs (single source — also imported by the
// statusline script + usage.mjs, which can't pull in agents.mjs without loading
// node-pty). The daemon ensures it exists on load.
const STATE_FILE = join(STATE_DIR, 'agents.json');
// Skill-scopes surface root (for --add-dir <scope> into spawned agents). No
// default — SING_SCOPE_ROOT must be set in .env. Null when unset; buildSpawn
// then skips --add-dir. index.mjs requireEnv fails the daemon fast if unset.
const SCOPE_ROOT = process.env.SING_SCOPE_ROOT || null;
mkdirSync(APP_DIR, { recursive: true });
mkdirSync(STATE_DIR, { recursive: true });

// --- claude/ollama binaries: absolute paths from .env (no PATH fallback) ---
// Windows node-pty does NO PATH resolution, so the daemon requires explicit
// absolute paths. resolveBin returns the .env path if it exists, else null;
// index.mjs requireEnv fails the daemon fast on null.
function resolveBin(envOverride) {
  if (envOverride && existsSync(envOverride)) return envOverride;
  return null;
}
const CLAUDE_BIN = resolveBin(process.env.CLAUDE_BIN);
const OLLAMA_BIN = resolveBin(process.env.OLLAMA_BIN);
const CODEX_BIN = resolveBin(process.env.CODEX_BIN);
export { CLAUDE_BIN, OLLAMA_BIN, CODEX_BIN, SCOPE_ROOT };

export const bus = new EventEmitter();

// id -> { id, title, cwd, status, pid, createdAt, proc, buf:string[] }
const agents = new Map();
let recentRepos = [];
// Set during daemon shutdown: killing live ptys then fires onExit, whose normal
// path deletes the entry + re-persists — that would wipe running sessions from
// agents.json. While draining we keep them so init() reloads them as 'detached'
// (resumable) instead of dropping them from the list on restart.
let draining = false;
// persist() writes the current fleet as detached (running→detached mapping), so
// this snapshots every live session to disk at drain time — the authoritative
// last write. onExit then no-ops (guard below), leaving the file intact.
export function beginDrain() { draining = true; try { persist(); } catch { /* best-effort at shutdown */ } }

// --- persistence ---
// Shared write-temp-then-rename primitive for every state/*.json save (and
// ensureTrusted's ~/.claude.json write below). On Windows, renaming over an
// existing file can transiently EPERM/EACCES/EBUSY when AV/Search/a reader
// briefly holds the target open — retry a few times with a short sync sleep
// (Atomics.wait: the write path is sync, so the backoff must be too) before
// giving up. Anything else, or the last attempt, rethrows raw — callers keep
// their own catch/log/wrap untouched.
const RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const retrySignal = new Int32Array(new SharedArrayBuffer(4));
// `rename` param defaults to the real renameSync — overridable so tests can
// inject a fake that fails N times without a mocking framework.
export function writeAtomic(file, data, rename = renameSync) {
  // pid-scoped tmp name: ~/.claude.json (ensureTrusted) is Claude Code's own
  // machine-global file, written by every claude process on the box — a fixed
  // `.tmp` lets two writers clobber each other's staged content and rename the
  // wrong one into place. The state/*.json files are ours alone and wouldn't
  // need it, but one naming rule is cheaper than two.
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, data);
  for (let attempt = 1; ; attempt++) {
    try { rename(tmp, file); return; }
    catch (e) {
      if (attempt >= 5 || !RETRY_CODES.has(e.code)) throw e;
      Atomics.wait(retrySignal, 0, 0, 20 * attempt);
    }
  }
}

let logger = null;
function persist() {
  const data = {
    agents: [...agents.values()].map(({ id, title, cwd, status, createdAt, model, scopes, permissionMode, extraArgs, activeMs, runningSince, mock, tool, threadId }) => ({
      id, title, cwd, createdAt, model, scopes, permissionMode, extraArgs, mock, tool, threadId,
      // fold the live running-span in so a daemon exit while 'running' doesn't lose it
      activeMs: status === 'running' && runningSince ? (activeMs || 0) + (Date.now() - runningSince) : activeMs,
      status: status === 'running' || status === 'starting' || status === 'idle' ? 'detached' : status,
    })),
    recentRepos,
  };
  try {
    writeAtomic(STATE_FILE, JSON.stringify(data, null, 2)); // atomic swap — a crash mid-write never truncates STATE_FILE
  } catch (e) {
    logger?.warn({ err: e.message }, 'agents.json write failed — registry not persisted');
    const err = new Error(`agents.json write failed: ${e.message}`);
    err.persistFailure = true; // flags a genuine disk write failure vs. a validation error — index.mjs routes surface it as 500
    throw err;
  }
}

export function init(log) {
  logger = log;
  try {
    if (existsSync(STATE_FILE)) {
      const data = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
      recentRepos = data.recentRepos || [];
      for (const a of data.agents || []) {
        // ptys are gone after a daemon restart → mark detached, no proc.
        // Pre-rename records stored the display field as `name`; normalize so
        // buildSpawn/reattach read `title` regardless of which shape is on disk.
        if (a.title == null && a.name != null) { a.title = a.name; delete a.name; }
        agents.set(a.id, { ...a, status: 'detached', proc: null, buf: [], written: 0 });
      }
      log?.info({ agents: agents.size }, 'loaded agents.json (detached)');
    }
  } catch (e) { log?.warn({ err: e.message }, 'agents.json load failed'); }
}

// --- snapshots ---
export function snapshot() {
  return [...agents.values()].map(({ id, title, cwd, status, pid, createdAt, model, scopes, tool }) => ({ id, title, cwd, status, pid, createdAt, model, scopes, tool }));
}
export function getRecentRepos() { return recentRepos; }
export function getBuf(id) { return agents.get(id)?.buf.join('') ?? ''; }
// Cumulative pty output bytes since this spawn (0 on detached/never-run). Exceeding
// RING_MAX means the ring trimmed early history the terminal can't reach.
export function getWritten(id) { return agents.get(id)?.written ?? 0; }
export function getStatus(id) { return agents.get(id)?.status; }
export function isLive(id) { return !!agents.get(id)?.proc; }
// Launch config for a registered agent (by id), for resuming a past session from
// the Transcripts view: skill-scopes are NOT recorded in the transcript JSONL,
// only in agents.json, so the registry is the sole source. Returns null for
// sessions never launched via Singularity (e.g. plain `claude` CLI sessions).
export function getLaunchConfig(id) {
  const a = agents.get(id);
  if (!a) return null;
  return { model: a.model || null, scopes: Array.isArray(a.scopes) ? a.scopes : [], tool: a.tool || 'claude' };
}
// getLaunchConfig's codex sibling: a codex agent's registry key (id) is the
// randomUUID create() minted, unrelated to the codex-minted thread uuid the
// Transcripts view actually has (codex has no --session-id flag — see
// codex-thread.mjs). So resuming this lookup by id can't work; instead invert
// findCodexThread's forward relation (cwd+createdAt -> thread uuid) by
// scanning codex agents in `cwd` for the one whose rollout produced
// `threadId`. normPath keeps the cwd compare aligned with findCodexThread's
// own Windows case/separator handling. Same ceiling as getLaunchConfig: wire()'s
// onExit deletes an exited agent's registry entry, so scopes are only
// recoverable while the entry still exists (live or detached).
export function getLaunchConfigForCodexThread(threadId, cwd) {
  if (!threadId || !cwd) return null;
  const wantCwd = normPath(cwd);
  for (const a of agents.values()) {
    if (!(a.tool === 'codex' || isCodexModel(a.model))) continue;
    if (!a.cwd || normPath(a.cwd) !== wantCwd) continue; // normPath resolve()s — a cwd-less record on disk would throw
    if (findCodexThread(a.cwd, a.createdAt) === threadId) return getLaunchConfig(a.id);
  }
  return null;
}

// getLaunchConfigForCodexThread's inverse: given a registered agent's id (the
// randomUUID create() minted), resolve the codex-minted thread uuid its
// transcript is actually filed under — the Transcripts view needs this uuid,
// not the registry id, to open a codex session. Same discovery order buildSpawn
// uses: time-based (cwd+createdAt) else the id itself when it's already a known
// codex thread for this cwd (agents created from the Transcripts view).
export function codexThreadFor(id) {
  const a = agents.get(id);
  if (!a) return null;
  return rememberCodexThread(a);
}
// Discovery is by cwd + start-time window (codex has no --session-id to pin an
// id at spawn), so it can drift to an unrelated codex thread the user started
// in the same cwd later on — see findCodexThread's ceiling. Pin the first
// answer onto the agent (persisted) and reuse it from then on: restart/reattach
// resume the SAME thread they were live on, and repeat lookups skip the walk.
function rememberCodexThread(a) {
  if (!(a.tool === 'codex' || isCodexModel(a.model)) || !a.cwd) return null;
  if (a.threadId) return a.threadId;
  const found = (a.createdAt && findCodexThread(a.cwd, a.createdAt))
    || (codexThreadExists(a.id, a.cwd) ? a.id : null);
  if (found) { a.threadId = found; try { persist(); } catch { /* pin is a cache — a write failure must not fail the caller */ } }
  return found;
}
// PIDs of agents this daemon currently owns a live pty for (for process classification).
export function livePids() {
  return new Set([...agents.values()].filter((a) => a.proc).map((a) => a.pid));
}

function emitList() { bus.emit('list', snapshot()); }
// Single transition point for agent status. Tracks activeMs (persisted, wall
// time spent 'running') across the running <-> idle/exited/detached edges.
function setStatus(a, status) {
  if (status === 'running' && a.status !== 'running') a.runningSince = Date.now();
  else if (a.status === 'running' && status !== 'running') { a.activeMs = (a.activeMs || 0) + (Date.now() - a.runningSince); a.runningSince = null; }
  a.status = status;
  bus.emit('status', { id: a.id, status });
}
// Persisted activeMs plus the live delta while currently running.
export function getActiveMs(id) {
  const a = agents.get(id);
  if (!a) return 0;
  const base = a.activeMs || 0;
  return a.status === 'running' && a.runningSince ? base + (Date.now() - a.runningSince) : base;
}
function pushBuf(a, data) {
  a.buf.push(data);
  a.written = (a.written || 0) + data.length; // cumulative pty bytes (never trimmed) — daemon-side ground truth for "is there history beyond the ring?"
  let total = a.buf.reduce((n, s) => n + s.length, 0);
  while (total > RING_MAX && a.buf.length > 1) total -= a.buf.shift().length;
}

function rememberRepo(cwd) {
  recentRepos = [cwd, ...recentRepos.filter((r) => r !== cwd)].slice(0, RECENT_MAX);
}

function wire(a) {
  // Idle heuristic: Claude Code's TUI spinner emits output continuously while
  // working; a turn waiting for user input goes quiet. No pty output for
  // IDLE_MS while 'running' → mark 'idle'; the next byte flips it back.
  const armIdle = () => {
    clearTimeout(a.idleTimer);
    a.idleTimer = setTimeout(() => { if (a.status === 'running') setStatus(a, 'idle'); }, IDLE_MS);
  };
  a.proc.onData((data) => {
    pushBuf(a, data);
    if (a.status === 'starting' || a.status === 'idle') setStatus(a, 'running');
    bus.emit('output', { id: a.id, data });
    armIdle();
  });
  a.proc.onExit(({ exitCode }) => {
    clearTimeout(a.idleTimer);
    a.proc = null;
    // Daemon shutdown killed this pty: keep the entry as-is (agents.json already
    // holds it as detached from the last persist) so restart reloads it. Don't
    // delete/persist here or the running session vanishes from the list.
    if (draining) return;
    // Theme-change respawn (see respawnAll): resume with the same config
    // instead of the normal exited/removed handling below. setImmediate defers
    // create() until this onExit call (and the Map mutation here) fully unwinds.
    if (a.respawnAfterExit) {
      const cfg = a.respawnAfterExit;
      agents.delete(a.id); // drop the dead entry so create() takes the fresh-spawn-over-existing-log path
      setImmediate(() => { try { create({ sessionId: a.id, ...cfg }); } catch (e) { logger?.warn({ err: e.message }, 'respawn failed'); } });
      persist();
      emitList();
      return;
    }
    // A task-completed session is dropped outright (see remove()) rather than
    // left as a dead 'exited' row cluttering the session list.
    if (a.removeOnExit) {
      agents.delete(a.id);
      persist();
      emitList();
      return;
    }
    setStatus(a, 'exited'); // status event for crons auto-kill; tracks activeMs
    const isCodex = a.tool === 'codex' || isCodexModel(a.model);
    const codexThreadId = isCodex ? rememberCodexThread(a) : null;
    const resumeCmd = isCodex
      ? (codexThreadId ? `codex resume ${codexThreadId}` : 'codex')
      : isClaudeModel(a.model)
        ? `claude --resume ${a.id}${a.model && a.model !== 'claude' ? ` --model ${a.model}` : ''}`
        : `ollama launch claude --model ${a.model} -- --resume ${a.id}`;
    bus.emit('output', { id: a.id, data: `\r\n\x1b[90m[agent exited code=${exitCode}] resume: ${resumeCmd}\x1b[0m\r\n` });
    // Drop the session from the list rather than leaving a dead 'exited' row;
    // resume still works off the on-disk session log (new session, same id).
    agents.delete(a.id);
    persist();
    emitList();
  });
}

// --- codex skill-scoping ---
// Codex has no --add-dir; instead it scopes skills via a TOML override on the
// config file. resolveSkillManifest() finds the skill-manifest.json (derived
// from SCOPE_ROOT: dirname(SCOPE_ROOT)/skills/skill-manifest.json, falling back
// to ~/.agents/skills/skill-manifest.json). codexScopeConfig() builds the
// `skills.config=[{path="...",enabled=false},...]` string — every skill whose
// scopes have NO intersection with the chosen scopes (+ 'common') is disabled.
function resolveSkillManifest() {
  const cands = [];
  if (SCOPE_ROOT) cands.push(join(dirname(SCOPE_ROOT), 'skills', 'skill-manifest.json'));
  cands.push(join(homedir(), '.agents', 'skills', 'skill-manifest.json'));
  return cands.find((p) => existsSync(p)) || null;
}
function codexScopeConfig(scopes) {
  const manifestPath = resolveSkillManifest();
  if (!manifestPath) return null; // no manifest → no disable (codex default: all skills on)
  let manifest;
  try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); } catch { return null; }
  const keep = new Set([...(scopes || []), 'common']);
  const skills = Array.isArray(manifest)
    ? manifest
    : Object.entries(manifest.scopes || {}).reduce((all, [scope, names]) => {
      for (const name of Array.isArray(names) ? names : []) {
        if (typeof name !== 'string') continue;
        const skill = all.get(name) || { refs: [{ path: manifest.external?.[name] || join(dirname(manifestPath), name) }], scopes: [] };
        skill.scopes.push(scope);
        all.set(name, skill);
      }
      return all;
    }, new Map()).values();
  const disable = [...skills]
    .filter((sk) => !(sk.scopes || []).some((s) => keep.has(s)))
    .map((sk) => {
      const skillMd = join(sk.refs?.[0]?.path || '', 'SKILL.md');
      return `{path="${skillMd.replace(/\\/g, '/')}",enabled=false}`;
    });
  return disable.length ? `skills.config=[${disable.join(',')}]` : null;
}

// Build (bin, args) for an agent's pty: skill-scopes → --add-dir <abs> (only
// existing dirs under the scope root), resume if a session log already exists
// for this id at this cwd (else fresh --session-id), optional ollama wrapper.
// Shared by create + reattach so reattach keeps the model + scopes.
// `prompt` (initial user message) is only sent on a fresh spawn — passing it
// with --resume would re-submit it as a new message on every reattach.
export function buildSpawn({ id, title, cwd, model, scopes, permissionMode, extraArgs, tool, createdAt, threadId: pinned }, prompt) {
  // ponytail: codex has no --session-id/--name flag to pin an id at spawn (it
  // mints its own uuid) and no Task tool. The uuid is recovered after the fact
  // from its rollout file (findCodexThread) so reattach can `codex resume
  // <uuid>` instead of losing history. Model-driven: a gpt-* model routes here
  // even with tool='claude'. The tool toggle still covers the empty-model case
  // (codex's own default via config.toml).
  if (tool === 'codex' || isCodexModel(model)) {
    if (!CODEX_BIN) throw new Error('codex not found (CODEX_BIN not set in .env)');
    // Prefer time-based discovery (reattach/respawn, createdAt set); else fall
    // back to the caller-supplied id when it's itself a known codex thread for
    // this cwd — covers create({ sessionId: <codex uuid> }) from the
    // Transcripts view or a uuid typed into the New-session dialog, where
    // createdAt is deliberately absent (see create()'s comment above).
    // A pinned thread (rememberCodexThread, carried through respawn/reattach)
    // wins over re-discovery — same thread every time, no time-window drift.
    const threadId = pinned
      || (createdAt && findCodexThread(cwd, createdAt))
      || (codexThreadExists(id, cwd) ? id : null);
    const args = [];
    if (threadId) args.push('resume', threadId);
    const cfg = codexScopeConfig(scopes);
    if (cfg) args.push('-c', cfg);
    args.push('-C', cwd, '-s', 'workspace-write', '-a', permissionMode ? 'never' : 'on-request');
    if (model) args.push('-m', model);
    if (prompt && !threadId) args.push(prompt);
    return { bin: CODEX_BIN, args };
  }
  const claudeArgs = [];
  for (const s of (scopes || [])) {
    if (!s) continue;
    const dir = SCOPE_ROOT ? join(SCOPE_ROOT, s) : null;
    if (dir && existsSync(dir)) { claudeArgs.push('--add-dir', dir); }
  }
  const resuming = sessionLogExists(cwd, id);
  const sessionFlag = resuming ? ['--resume', id] : ['--session-id', id];
  // '--name' is claude's CLI flag (contract); the session's display field is `title`.
  claudeArgs.push(...sessionFlag, '--name', title);
  if (permissionMode) claudeArgs.push('--permission-mode', permissionMode);
  claudeArgs.push(...(extraArgs || []));
  if (prompt && !resuming) claudeArgs.push(prompt);
  if (isClaudeModel(model)) {
    // claude bin; --model only for a specific (non-default) alias or full id.
    if (model && model !== 'claude') claudeArgs.push('--model', model);
    return { bin: CLAUDE_BIN, args: claudeArgs };
  }
  if (!OLLAMA_BIN) {
    throw new Error('ollama not found (OLLAMA_BIN not set in .env)');
  }
  // On resume the transcript recorded the ollama model with its tag stripped
  // (glm-5.2:cloud -> glm-5.2); claude would request the stripped name and
  // ollama rejects it. --model overrides the transcript model on resume.
  if (resuming) claudeArgs.push('--model', model);
  return { bin: OLLAMA_BIN, args: ['launch', 'claude', '--model', model, '--', ...claudeArgs] };
}

// ponytail: mock demo sessions (idle claude, see tasks.mjs) are spawned+killed
// in throwaway repos, but they still load the user's real ~/.claude/settings.json
// statusline, which would otherwise write a permanent-orphan cost-state file
// under the user's real USAGE_REPORT_STATE. Point mock spawns at a disposable
// dir under the existing CACHE_DIR instead of inventing a new state root.
export function spawnEnv(mock) {
  return mock ? { ...process.env, USAGE_REPORT_STATE: join(CACHE_DIR, 'mock-usage-state') } : process.env;
}

// node-pty's raw spawn failure ("posix_spawnp failed." on macOS/Linux) names
// neither the binary nor the cause. Wrap so the surfaced error is actionable —
// the usual culprit is CLAUDE_BIN/OLLAMA_BIN pointing at a non-executable file
// (missing +x, wrong arch, or a path that isn't the real binary).
function spawnPty(bin, args, opts) {
  try {
    return spawn(bin, args, opts);
  } catch (e) {
    let hint = '';
    try { accessSync(bin, constants.X_OK); }
    catch { hint = ' — not executable; `chmod +x` it or point CLAUDE_BIN/OLLAMA_BIN at the real binary'; }
    throw new Error(`failed to launch ${bin}: ${e.message}${hint}`, { cause: e });
  }
}

// `~` is a shell-ism node never expands — a client that sends it raw (or whose
// home dir hasn't loaded yet) would spawn into a literal '~' directory. Same
// 2-liner config.mjs/hooks.mjs/rules.mjs/memory.mjs use on their own inputs.
export function untildify(p) {
  if (p === '~' || p?.startsWith('~/') || p?.startsWith('~\\')) return join(homedir(), p.slice(1));
  return p;
}

// create new agent (id IS the claude --session-id)
export function create({ cwd, title, model, scopes, sessionId, prompt, permissionMode, extraArgs, mock, tool, createdAt, threadId }) {
  cwd = untildify(cwd);
  const id = (sessionId && sessionId.trim()) || randomUUID();
  const existing = agents.get(id);
  if (existing) {
    if (existing.proc) throw new Error('session id already in use');
    // id belongs to an exited/detached agent (e.g. its claude proc died on a
    // usage-limit hit and onExit left a dead 'exited' entry in the registry).
    // The user re-entered the id to bring the conversation back → resume it
    // rather than refusing. reattach keeps the original model + skill-scopes.
    return reattach(id);
  }
  if (!cwd || !existsSync(cwd)) throw new Error(`working directory does not exist: ${cwd || '(empty)'}`);
  validateToolModel(tool, model);
  const displayName = title || id.slice(0, 8);
  // `createdAt` is only set by respawn() (theme toggle), where the codex thread
  // must be recovered so history survives. A genuinely fresh create must NOT
  // pass one: findCodexThread matches on cwd+time, not id, so within its skew
  // window it would resume an unrelated codex session the user started in the
  // same cwd by hand.
  const spawnedAt = createdAt || Date.now();
  const { bin, args } = buildSpawn({ id, title: displayName, cwd, model, scopes, permissionMode, extraArgs, tool, createdAt, threadId }, prompt);
  ensureTrusted(cwd);
  const proc = spawnPty(bin, args, { cwd, cols: 80, rows: 24, env: spawnEnv(mock), useConptyDll: true });
  const a = { id, title: displayName, cwd, model, scopes, permissionMode, extraArgs, mock: !!mock, tool, threadId, activeMs: 0, status: 'starting', pid: proc.pid, createdAt: spawnedAt, proc, buf: [], written: 0 };
  agents.set(id, a);
  wire(a);
  rememberRepo(cwd);
  persist();
  emitList();
  return a;
}

// Claude logs a session to ~/.claude/projects/<encoded-cwd>/<id>.jsonl, where
// encoded-cwd is the abs path with every non-alphanumeric replaced by '-'
// (dots too: C:\Users\x\.claude -> C--Users-x--claude).
export function encodeCwd(cwd) { return cwd.replace(/[^a-zA-Z0-9]/g, '-'); }

// Pre-seed Claude's per-directory workspace-trust flag for `cwd` so a
// daemon-spawned claude doesn't stall on the blocking "Quick safety check"
// prompt. Claude keys ~/.claude.json projects on the abs cwd with \→/ (case
// preserved). Short-circuits if already trusted (fewer writes, smaller race
// window vs Claude's own frequent writes). Atomic temp+rename so a concurrent
// Claude read never sees a half-written file. Never throws into the spawn path.
export function ensureTrusted(cwd, file = join(homedir(), '.claude.json')) {
  try {
    const key = cwd.replace(/\\/g, '/');
    const json = JSON.parse(readFileSync(file, 'utf8'));
    if (json.projects?.[key]?.hasTrustDialogAccepted === true) return;
    ((json.projects ??= {})[key] ??= {}).hasTrustDialogAccepted = true;
    writeAtomic(file, JSON.stringify(json, null, 2));
  } catch { /* unreadable/missing/parse-fail → let the prompt show once */ }
}
function sessionLogExists(cwd, id) {
  return existsSync(join(homedir(), '.claude', 'projects', encodeCwd(cwd), `${id}.jsonl`));
}

// reattach a detached agent: `--resume <id>` if a conversation was persisted,
// else spawn fresh with the same `--session-id` (a session that never had a
// turn has no log to resume — resuming it errors "No conversation found").
// buildSpawn keeps the agent's model + skill-scopes from create time.
export function reattach(id) {
  const a = agents.get(id);
  if (!a || a.proc) return a;
  const { bin, args } = buildSpawn(a);
  ensureTrusted(a.cwd);
  const proc = spawnPty(bin, args, {
    cwd: a.cwd, cols: 80, rows: 24, env: spawnEnv(a.mock), useConptyDll: true,
  });
  a.proc = proc; a.pid = proc.pid; a.buf = []; a.written = 0; a.status = 'starting';
  wire(a);
  persist();
  emitList();
  return a;
}

// Launch a session in an external terminal (Windows Terminal / macOS Terminal)
// so the user can continue it outside the dock without /exit + manual `claude
// --resume`. Pure builder — returns the launcher + argv for the route to
// detached-spawn (keeps node:child_process out of this module). Reuses
// buildSpawn so the resume argv matches in-app reattach (scopes, model,
// permission-mode, ollama wrapper). `platform` param only for testability.
export function externalLaunch(id, platform = process.platform) {
  const a = agents.get(id);
  if (!a) return { ok: false, error: 'no such session' };
  const { bin, args } = buildSpawn(a);
  if (platform === 'win32')
    return { ok: true, launcher: 'wt.exe', launcherArgs: ['-d', a.cwd, bin, ...args], cwd: a.cwd };
  if (platform === 'darwin') {
    const sq = (s) => `'${String(s).replace(/'/g, `'"'"'`)}'`;
    const shell = `cd ${sq(a.cwd)} && exec ${sq(bin)} ${args.map(sq).join(' ')}`;
    return { ok: true, launcher: 'osascript',
      launcherArgs: ['-e', `tell application "Terminal" to do script ${JSON.stringify(shell)}`],
      cwd: a.cwd };
  }
  return { ok: false, error: 'external terminal open is Windows/macOS only' };
}

// fork a session: copies the source's transcript (uuid rewritten to the new
// id so claude's own history doesn't collide with the source) into a new
// session log, then create()s a fresh agent over it — no log yet → create()
// falls back to a fresh --session-id spawn, i.e. a config-only copy.
export function fork(srcId, title) {
  const src = agents.get(srcId);
  if (!src) throw new Error('source not found');
  const newId = randomUUID();
  const dir = join(homedir(), '.claude', 'projects', encodeCwd(src.cwd));
  const srcLog = join(dir, `${srcId}.jsonl`);
  if (existsSync(srcLog)) {
    const content = readFileSync(srcLog, 'utf8').replaceAll(srcId, newId); // uuid → collision-free global replace
    writeFileSync(join(dir, `${newId}.jsonl`), content);
  }
  // no source log → nothing written → create() spawns fresh with --session-id (fallback = copy)
  return create({ cwd: src.cwd, title, model: src.model, scopes: src.scopes, sessionId: newId, tool: src.tool });
}

export function input(id, data) { agents.get(id)?.proc?.write(data); }
export function resize(id, cols, rows) { try { agents.get(id)?.proc?.resize(cols, rows); } catch {} }

// kill live agent; remove dead/detached agent from registry.
export function kill(id) {
  const a = agents.get(id);
  if (!a) return;
  if (a.proc) { a.proc.kill(); return; } // onExit -> status exited + persist
  agents.delete(id);
  persist();
  emitList();
}

// Remove an agent from the registry entirely: a live pty is killed and the
// entry dropped when it exits (removeOnExit); a dead/detached entry is dropped
// immediately. Unlike kill(), which leaves a live agent as a resumable dead
// 'exited' row, this is used when a task completes and its session should
// leave the session list for good.
export function remove(id) {
  const a = agents.get(id);
  if (!a) return;
  if (a.proc) { a.removeOnExit = true; a.proc.kill(); return; } // onExit -> delete
  agents.delete(id);
  persist();
  emitList();
}

// Respawn one live agent: kill it, and its onExit resumes with the same config
// (log survives → --resume, history kept). Used to pick up a new terminal theme.
export function respawn(id) {
  const a = agents.get(id);
  if (!a?.proc) return false;
  // Pin the codex thread while the agent is still live: discovery after the kill
  // can drift to a newer codex thread in the same cwd (see rememberCodexThread).
  a.respawnAfterExit = { title: a.title, cwd: a.cwd, model: a.model, scopes: a.scopes, permissionMode: a.permissionMode, extraArgs: a.extraArgs, tool: a.tool, createdAt: a.createdAt, threadId: rememberCodexThread(a) || undefined };
  a.proc.kill();
  return true;
}

// Respawn every live agent (e.g. after an app theme toggle).
export function respawnAll() {
  const ids = [];
  for (const a of agents.values()) if (respawn(a.id)) ids.push(a.id);
  return ids;
}

// Reorder the registry to match `ids` (a permutation of every current id);
// rebuilds the Map in that insertion order, persists, and re-emits the list.
export function reorder(ids) {
  if (!Array.isArray(ids) || ids.length !== agents.size) return;
  const next = new Map();
  for (const id of ids) { const a = agents.get(id); if (!a) return; next.set(id, a); }
  if (next.size !== agents.size) return;
  agents.clear();
  for (const [id, a] of next) agents.set(id, a);
  persist();
  emitList();
}
