// Single source of truth for the e2e sandbox layout. Imported by serve.mjs (to
// boot the isolated daemon), seed.mjs (to build the corpora), specs (to assert
// on-disk writes) and playwright.config.mjs (reporter output). Pure constants —
// no FS, no side effects, so a spec can import it without touching the sandbox.
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { envPort } from '../../scripts/env-port.mjs';

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Which daemon the suite drives: the reference Node server (default) or the
// native `singularity-backend --http` binary. Rejecting an unknown value here,
// at import time, is deliberate: serve.mjs calls seed() — which wipes TMP — only
// after its imports evaluate, so a typo fails before any sandbox is rebuilt.
export const BACKENDS = ['node', 'rust'];
const requestedBackend = process.env.E2E_BACKEND ?? '';
export const BACKEND = requestedBackend === '' ? 'node' : requestedBackend;
if (!BACKENDS.includes(BACKEND)) {
  throw new Error(`E2E_BACKEND must be one of ${BACKENDS.join('|')} (got ${JSON.stringify(requestedBackend)})`);
}

// Checkout the `node` backend runs from. Defaults to this repo; point it at
// another clone to compare the native daemon against a pinned Node checkout.
export const NODE_ROOT = process.env.E2E_NODE_ROOT ? resolve(process.env.E2E_NODE_ROOT) : REPO_ROOT;

// 4319: not 4317 (the user's real daemon — never restart it) and not 5317
// (Vite). server/index.mjs derives its Host/Origin allowlist from PORT, so the
// browser is allowed automatically.
//
// E2E_PORT gives a run its own port AND its own sandbox dir (serve.mjs wipes
// TMP on boot, so two runs sharing one would clobber each other) — that's what
// lets several spec files be developed in parallel.
export const PORT = envPort('E2E_PORT', 4319);
export const TOKEN = 'e2etoken';
export const BASE_URL = `http://127.0.0.1:${PORT}`;

// Sandbox root lives outside the repository and is keyed per checkout (a short
// hash of REPO_ROOT), so two checkouts at their default port never share — and
// never wipe — each other's fixtures. Within a checkout it stays per-port
// because serve.mjs wipes it on boot. E2E_TMP_ROOT replaces the base verbatim
// (CI, constrained tmp); pointing two checkouts at one value shares it again.
export const CHECKOUT_ID = createHash('sha1').update(REPO_ROOT).digest('hex').slice(0, 8); // VERIFY: wave3-e2e-1
export const TMP_ROOT = process.env.E2E_TMP_ROOT
  ? resolve(process.env.E2E_TMP_ROOT)
  : join(tmpdir(), 'singularity-e2e', CHECKOUT_ID);
export const TMP = join(TMP_ROOT, String(PORT));
export const HOME_DIR = join(TMP, 'home');          // SINGULARITY_HOME
export const STATE_DIR = join(HOME_DIR, 'state');
export const TRUSTED_DIR = join(TMP, 'trusted');    // SING_TRUSTED_ROOT (.worktrees/.tickets/.reports)
export const USAGE_STATE_DIR = join(TMP, 'usage-state'); // USAGE_REPORT_STATE — keeps stats.mjs off the real cost store
export const BIN_DIR = join(TMP, 'bin');

const CORPUS = join(TMP, 'corpus');
export const CORPUS_DIR = CORPUS;
// One tree serves both roots: sessions read <root>/<project>/*.jsonl,
// memory reads <root>/<project>/memory/*.md.
export const PROJECTS_DIR = join(CORPUS, 'projects');
export const WIKI_DIR = join(CORPUS, 'wiki');
export const SKILLS_DIR = join(CORPUS, 'skills');
export const WORKSPACE_DIR = join(CORPUS, 'workspace'); // config + hooks + rules root
export const EXPLORER_DIR = join(CORPUS, 'explorer');   // explorer.mjs browse/edit root
export const SCRATCH_DIR = join(CORPUS, 'scratch');     // non-git cwd: task create → kind 'plain', no worktree

// Fixture identifiers specs assert against.
export const PROJECT_A = 'workspace-alpha';
export const PROJECT_B = 'workspace-beta';
export const WIKI_NAME = 'handbook';
export const SESSION_COUNT_A = 30; // > the 25 default page size, so pagination has a second page
export const sessionId = (i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
export const RICH_SESSION = sessionId(900); // the multi-message transcript in PROJECT_B
