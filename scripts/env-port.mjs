// Port lookup for dev/test tooling that must not load the whole .env (mock mode
// and the e2e sandbox stay isolated from machine config like SING_TOKEN or
// SINGULARITY_HOME). Order: process env, then the repo .env, then the fallback.
// A worktree sets its own ports in its .env to run beside the main checkout.
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

const ENV_FILE = new URL('../.env', import.meta.url);

export function envPort(key, fallback) {
  let v = process.env[key];
  if (!v) {
    try { v = parseEnv(readFileSync(ENV_FILE, 'utf8'))[key]; } catch { /* no .env */ }
  }
  return Number(v) || fallback;
}
