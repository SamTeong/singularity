// The isolation boundary for the e2e suite: rebuild the sandbox, then boot the
// daemon against it. Started by playwright.config.mjs `webServer`.
//
// The daemon spawned here shares nothing with the user's real :4317 instance —
// its own port, its own SINGULARITY_HOME, its own trusted root (worktrees /
// tickets / reports), its own usage-report state, and a keepalive stub for
// CLAUDE_BIN so no flow can start a real claude turn. The env is built by
// deleting every SING_*/CLAUDE_BIN/PORT key off process.env first, so a value
// exported in the parent shell can't leak the real state root in.
//
// Run standalone (useful when writing a spec):  node e2e/serve.mjs
import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { REPO_ROOT, PORT, TOKEN, HOME_DIR, TRUSTED_DIR, USAGE_STATE_DIR, BASE_URL } from './fixtures/paths.mjs';
import { seed } from './fixtures/seed.mjs';

const { claudeBin } = seed();

const env = { ...process.env };
// Anything the daemon reads for state placement is set explicitly below or must
// be absent — never inherited.
for (const k of ['SINGULARITY_HOME', 'PORT', 'CLAUDE_BIN', 'OLLAMA_BIN', 'SING_SCOPE_ROOT',
  'SING_TRUSTED_ROOT', 'SING_USAGE_SKILL', 'SING_USAGE_REPORTS', 'SING_TOKEN', 'USAGE_REPORT_STATE']) delete env[k];
Object.assign(env, {
  SINGULARITY_HOME: HOME_DIR,
  SING_TRUSTED_ROOT: TRUSTED_DIR,
  USAGE_REPORT_STATE: USAGE_STATE_DIR,
  PORT: String(PORT),
  CLAUDE_BIN: claudeBin,
  // Same keepalive stub. Needed for /capabilities to report ollama available —
  // visibleProviders() (web/src/lib/usageUtil.js) filters the Ollama usage card
  // out entirely when it isn't, so the provider's needsAuth state is unreachable.
  // No scrape risk: with no ollama.json in the sandbox state dir, fetchOllama
  // short-circuits to {needsAuth, error:'no-config'} before launching a browser.
  OLLAMA_BIN: claudeBin,
  SING_TOKEN: TOKEN,
  // SING_SCOPE_ROOT / SING_USAGE_SKILL / SING_USAGE_REPORTS stay unset on
  // purpose — those degraded empty states are part of what we test.
});

const child = spawn(process.execPath, [join(REPO_ROOT, 'server', 'index.mjs')], {
  cwd: REPO_ROOT, env, stdio: ['ignore', 'inherit', 'inherit'],
});

console.log(`[e2e] sandbox daemon → ${BASE_URL} (home=${HOME_DIR})`);

child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
// child.kill() only signals this one process — on Windows it does not reap the
// daemon's own pty children, so a Ctrl-C mid-run would leak them. taskkill /T
// kills the whole tree; POSIX has no such gap, so child.kill() stays enough there.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']);
    else child.kill();
  });
}
