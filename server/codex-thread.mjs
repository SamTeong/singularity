import { resolve } from 'node:path';
import { CODEX_HOME } from './usage.mjs';

let identityBackend = null;

export function setCodexIdentityBackend(backend) {
  identityBackend = backend;
}

export function normPath(path) {
  const normalized = resolve(path).replace(/\\/g, '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export async function findCodexThread(cwd, spawnedAt, { home = CODEX_HOME } = {}) {
  if (!identityBackend?.codexThreadFind) return null;
  try {
    const threadId = await identityBackend.codexThreadFind(home, cwd, Number.isFinite(spawnedAt) ? Math.trunc(spawnedAt) : null);
    return typeof threadId === 'string' && threadId ? threadId : null;
  } catch { return null; }
}

export async function codexThreadExists(id, cwd, { home = CODEX_HOME } = {}) {
  if (!identityBackend?.codexThreadExists) return false;
  try { return await identityBackend.codexThreadExists(home, cwd, id) === true; }
  catch { return false; }
}
