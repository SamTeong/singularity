// Single source of truth for the app data dir + subdirs. Lightweight — no side
// effects, no heavy deps — so the statusline script (~300ms cadence, child
// process) can import it without loading node-pty (which agents.mjs pulls in).
// APP_DIR has NO default — SINGULARITY_HOME must be set (in .env, loaded via
// --env-file-if-exists=.env; tests point it at a scratch temp dir before
// import). Layout: state/ = durable state, cache/ = disposable, worktrees/ =
// git worktrees (stays at root — git-registered with each repo).
import { join } from 'node:path';

const home = process.env.SINGULARITY_HOME;
if (!home) {
  throw new Error('SINGULARITY_HOME required — set it in .env (no default). State root.');
}
export const APP_DIR = home;
export const STATE_DIR = join(APP_DIR, 'state');
export const CACHE_DIR = join(APP_DIR, 'cache');
export const WORKTREES_DIR = join(APP_DIR, 'worktrees');