import { join } from 'node:path';
import { STATE_DIR } from './app-dir.mjs';

const STATE_FILE = join(STATE_DIR, 'models.json');
let backend;

export function setModelsBackend(value) {
  backend = value;
}

function modelsBackend() {
  if (!backend) throw new Error('Rust Models backend is not configured');
  return backend;
}

export function getModels() {
  return modelsBackend().modelsGet(STATE_FILE);
}

export function setModels(doc) {
  return modelsBackend().modelsSet(STATE_FILE, doc);
}

export async function restoreDefaults() {
  return modelsBackend().modelsRestore(STATE_FILE);
}

export async function groupFor(id) {
  return (await modelsBackend().modelRoute(STATE_FILE, id, null)).group;
}

export function modelRoute(id, tool) {
  return modelsBackend().modelRoute(STATE_FILE, id, tool);
}

export async function listEnabled() {
  return (await getModels()).models.filter((model) => model.enabled);
}

export async function getSummariserModel() {
  return (await getModels()).summariserModel;
}

export function getSummariser() {
  return modelsBackend().modelsSummariser(STATE_FILE);
}

export async function getDefaultModel() {
  return (await getModels()).defaultModel;
}
