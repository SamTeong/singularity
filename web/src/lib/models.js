// Mirror of server/models.mjs isCodexModel: gpt-* id (or a codex preset) →
// codex; everything else spawns under the claude bin (claude or ollama).
export const isCodexModel = (m) => !!m && m.startsWith('gpt-');
export const toolForModel = (m) => (isCodexModel(m) ? 'codex' : 'claude');
