// Single source of truth for the app data dir + subdirs. Lightweight — no side
// effects, no heavy deps — so the statusline script (~300ms cadence, child
// process) can import it without loading node-pty (which agents.mjs pulls in).
// APP_DIR has NO default — SINGULARITY_HOME must be set (in .env, loaded via
// --env-file-if-exists=.env; tests point it at a scratch temp dir before
// import). Layout: state/ = durable state + cache/ = disposable live under
// APP_DIR/SINGULARITY_HOME; worktrees/ + tickets/ live at the repo root
// (trusted — see below), NOT under APP_DIR.
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const home = process.env.SINGULARITY_HOME;
if (!home) {
  throw new Error('SINGULARITY_HOME required — set it in .env (no default). State root.');
}
export const APP_DIR = home;
export const STATE_DIR = join(APP_DIR, 'state');
export const CACHE_DIR = join(APP_DIR, 'cache');
// worktrees/ + tickets/ MUST live inside the trusted project root: Claude
// honors repo-controllable permissions (allow-rules/hooks) only for paths
// inside the trusted project root, and the --settings flag at task spawn is
// the real enabling mechanism. Default = this clone (writable per-user);
// override with SING_TRUSTED_ROOT for a global/npx/shared install where the
// clone isn't writable.
function untildify(p) {
  if (p && p[0] === '~' && (p[1] === '/' || p[1] === '\\')) return join(homedir(), p.slice(2));
  return p;
}
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TRUSTED_ROOT = process.env.SING_TRUSTED_ROOT ? resolve(untildify(process.env.SING_TRUSTED_ROOT)) : REPO_ROOT;
export { TRUSTED_ROOT };
export const WORKTREES_DIR = join(TRUSTED_ROOT, '.worktrees');
export const TICKETS_DIR = join(TRUSTED_ROOT, '.tickets');