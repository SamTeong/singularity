// The isolation boundary for the e2e suite: rebuild the sandbox, then boot the
// daemon against it. Started by playwright.config.mjs `webServer`.
//
// The daemon spawned here shares nothing with the user's real :4317 instance —
// its own port, its own SINGULARITY_HOME, its own trusted root (worktrees /
// tickets / reports), its own usage-report state, and a keepalive stub for
// CLAUDE_BIN so no flow can start a real claude turn. The env is built by
// deleting every SING_*/CLAUDE_BIN/DAEMON_PORT key off process.env first, then
// pinning the child process's OS home to the sandbox, so neither state nor user
// configuration can leak in from the parent shell.
//
// E2E_BACKEND picks the daemon: `node` (default) runs NODE_ROOT/server/index.mjs,
// `rust` spawns the native `singularity-backend --http` binary directly — no
// Node gateway in front of it. The backend is validated by paths.mjs at import
// time, so an invalid value exits before seed() wipes the sandbox.
//
// Run standalone (useful when writing a spec):  node e2e/serve.mjs
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync, symlinkSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { BACKEND, NODE_ROOT, REPO_ROOT, PORT, TOKEN, HOME_DIR, TRUSTED_DIR, USAGE_STATE_DIR, TMP, BASE_URL } from './fixtures/paths.mjs';
import { seed } from './fixtures/seed.mjs';

const EXE_NAME = process.platform === 'win32' ? 'singularity-backend.exe' : 'singularity-backend';

// Resolve the native binary before seeding: a missing build is a startup error,
// not a half-rebuilt sandbox. Prefer the newest profile like
// scripts/native-daemon-e2e.mjs — a stale release binary would test old code.
function nativeBinary() {
  const override = process.env.SINGULARITY_NATIVE_BIN;
  // VERIFY: wave3-e2e-3 — a typo'd override must fail here, not as an uncaught
  // spawn error after seed() rebuilt the sandbox.
  if (override) {
    const binary = resolve(REPO_ROOT, override);
    if (!existsSync(binary)) {
      console.error(`[e2e] SINGULARITY_NATIVE_BIN does not exist: ${override}`);
      process.exit(1);
    }
    return binary;
  }
  const built = ['release', 'debug']
    .map((profile) => join(REPO_ROOT, 'rust', 'backend', 'target', profile, EXE_NAME))
    .filter((path) => existsSync(path))
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
  if (built.length) return built[0];
  console.error('[e2e] native backend binary not found; run: cargo build --release --manifest-path rust/backend/Cargo.toml');
  process.exit(1);
}

// VERIFY: wave3-e2e-2 — refuse a port another daemon already owns (another
// checkout at its default, or a side-run) before seed() touches the sandbox,
// instead of handing the specs a foreign daemon or a bind stack trace.
async function assertPortFree() {
  await new Promise((done) => {
    const probe = createServer();
    probe.once('error', (err) => {
      console.error(`[e2e] cannot bind port ${PORT} (${err.code}); another daemon or run owns it — set E2E_PORT to a free port`);
      process.exit(1);
    });
    probe.once('listening', () => probe.close(done));
    probe.listen(PORT, '127.0.0.1');
  });
}

const native = BACKEND === 'rust' ? nativeBinary() : null;

await assertPortFree();
const { claudeBin } = seed();

// The native daemon reads `.env` from its cwd and serves the shell from
// cwd/web/dist. Run it from a sandbox cwd so a checkout `.env` cannot re-supply
// the SING_* keys deleted below, and link the checkout's web tree in so the
// built shell is still served.
function nativeCwd() {
  const cwd = join(TMP, 'cwd');
  const web = join(cwd, 'web');
  mkdirSync(cwd, { recursive: true });
  if (!existsSync(web)) symlinkSync(join(REPO_ROOT, 'web'), web, process.platform === 'win32' ? 'junction' : 'dir');
  return cwd;
}

const env = { ...process.env };
// Anything the daemon reads for state placement is set explicitly below or must
// be absent — never inherited.
for (const k of ['SINGULARITY_HOME', 'DAEMON_PORT', 'CLAUDE_BIN', 'OLLAMA_BIN', 'SING_SCOPE_ROOT',
  'SING_TRUSTED_ROOT', 'SING_USAGE_SKILL', 'SING_USAGE_REPORTS', 'SING_TOKEN', 'USAGE_REPORT_STATE',
  'CODEX_HOME', 'WINDOW_ANCHOR']) delete env[k];
Object.assign(env, {
  // Node's os.homedir() reads HOME on POSIX and USERPROFILE on Windows. Pin
  // both so the shell's synchronous __SING_HOME__ injection and every daemon
  // read of ~/.claude resolve inside the sandbox instead of the real user home.
  HOME: HOME_DIR,
  USERPROFILE: HOME_DIR,
  SINGULARITY_HOME: HOME_DIR,
  SING_TRUSTED_ROOT: TRUSTED_DIR,
  USAGE_REPORT_STATE: USAGE_STATE_DIR,
  DAEMON_PORT: String(PORT),
  CLAUDE_BIN: claudeBin,
  // Same keepalive stub. Needed for /capabilities to report ollama available —
  // visibleProviders() (web/src/lib/usageUtil.js) filters the Ollama usage card
  // out entirely when it isn't, so the provider's needsAuth state is unreachable.
  // No scrape risk: with no ollama.json in the sandbox state dir, fetchOllama
  // short-circuits to {needsAuth, error:'no-config'} before launching a browser.
  OLLAMA_BIN: claudeBin,
  SING_TOKEN: TOKEN,
  // Sandbox the Codex sessions root: listCodexSessions() scans CODEX_HOME/sessions
  // — without this, the real ~/.codex leaks live Codex transcripts into the
  // sandbox (162 real sessions showed up in a side-run), and scanDays() finds
  // them in the backfill window, upgrading the seeded gap day and firing a real
  // LLM call. Point at a nonexistent path so listCodexSessions returns [] early.
  CODEX_HOME: join(HOME_DIR, 'no-codex'),
  // SING_SCOPE_ROOT stays unset on purpose (no skill-scopes). SING_USAGE_REPORTS
  // is deleted too, so the report falls back to the sandbox default:
  // dirname(USAGE_REPORT_STATE)/reports.
});

const [command, args, cwd] = BACKEND === 'rust'
  ? [native, ['--http'], nativeCwd()]
  : [process.execPath, [join(NODE_ROOT, 'server', 'index.mjs')], NODE_ROOT];

const child = spawn(command, args, {
  cwd, env, stdio: ['ignore', 'inherit', 'inherit'],
});

console.log(`[e2e] sandbox ${BACKEND} daemon → ${BASE_URL} (home=${HOME_DIR})`);

child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
// VERIFY: wave3-e2e-4 — a spawn failure (missing/non-executable binary) is a
// startup diagnosis, not an uncaught exception.
child.on('error', (err) => {
  console.error(`[e2e] failed to start ${command}: ${err.message}`);
  process.exit(1);
});
// child.kill() only signals this one process — on Windows it does not reap the
// daemon's own pty children, so a Ctrl-C mid-run would leak them. taskkill /T
// kills the whole tree; POSIX has no such gap, so child.kill() stays enough there.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']);
    else child.kill();
  });
}
