import { modelRoute } from './model-store.mjs';

export function getModelRoute(model, tool) {
  return modelRoute(model, tool);
}

export async function isClaudeModel(model) {
  return (await modelRoute(model, null)).isClaudeModel;
}

export async function isCodexModel(model) {
  return (await modelRoute(model, null)).isCodexModel;
}

export async function validateToolModel(tool, model) {
  const result = await modelRoute(model, tool);
  if (result.toolModelError) throw new Error(result.toolModelError);
}

export async function claudeIdToAlias(model) {
  return (await modelRoute(model, null)).claudeAlias;
}
