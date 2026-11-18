import { join } from 'node:path';
import { STATE_DIR } from './app-dir.mjs';

const STATE_FILE = join(STATE_DIR, 'keys.json');
let backend;

export function setKeysBackend(rustBackend) {
  backend = rustBackend;
}

export async function getKeys() {
  try { return await backend.keysGet(STATE_FILE); }
  catch { return {}; }
}

export async function setKeys(patch) {
  try { return await backend.keysSet(STATE_FILE, patch); }
  catch (error) { return { ok: false, error: error.message }; }
}
