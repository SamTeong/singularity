// Single source of truth for the app data dir + subdirs. Lightweight — no side
// effects, no heavy deps — so the statusline script (~300ms cadence, child
// process) can import it without loading node-pty (which agents.mjs pulls in).
// APP_DIR has NO default — SINGULARITY_HOME must be set (in .env, loaded via
// --env-file-if-exists=.env; tests point it at a scratch temp dir before
// import). Layout: state/ = durable state + cache/ = disposable live under
// APP_DIR/SINGULARITY_HOME; worktrees/ + tickets/ live at the repo root
// (trusted — see below), NOT under APP_DIR.
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const home = process.env.SINGULARITY_HOME;
if (!home) {
  throw new Error('SINGULARITY_HOME required — set it in .env (no default). State root.');
}
export const APP_DIR = home;
export const STATE_DIR = join(APP_DIR, 'state');
export const CACHE_DIR = join(APP_DIR, 'cache');
// worktrees/ + tickets/ MUST live inside the trusted project root: Claude
// ignores repo-controllable permissions (allow-rules/hooks) for paths rooted
// outside it, so a worktree/ticket under SINGULARITY_HOME (external) fires
// Task-permission prompts. Repo root = parent of server/ (this module's dir)
// — self-locating, no new env var.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const WORKTREES_DIR = join(REPO_ROOT, '.worktrees');
export const TICKETS_DIR = join(REPO_ROOT, '.tickets');