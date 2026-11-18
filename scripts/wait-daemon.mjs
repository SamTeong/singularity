// `pnpm dev`: hold Vite back until the daemon listens, so the first proxied
// /api requests don't fail with ECONNREFUSED. Port follows .env (worktrees differ).
import waitOn from 'wait-on';
import { envPort } from './env-port.mjs';

await waitOn({ resources: [`tcp:127.0.0.1:${envPort('DAEMON_PORT', 4317)}`] });
