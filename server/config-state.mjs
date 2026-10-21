import { join } from 'node:path';
import { STATE_DIR } from './app-dir.mjs';

const STATE_FILE = join(STATE_DIR, 'config-state.json');
const DEFAULT_STATE = { tabs: [], active: null, autosave: false, expanded: [] };
let backend;

export function setConfigStateBackend(rustBackend) {
  backend = rustBackend;
}

export async function getConfigState() {
  try { return await backend.configStateGet(STATE_FILE); }
  catch { return { ...DEFAULT_STATE }; }
}

export async function setConfigState(patch) {
  try { return await backend.configStateSet(STATE_FILE, patch); }
  catch (error) { return { ok: false, error: error.message }; }
}
