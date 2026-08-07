// Mirror of server/models.mjs isCodexModel. The server enforces that every
// codex preset is a gpt-* id, so this prefix check alone is correct — there's
// no preset list to duplicate or fall out of sync with.
export const isCodexModel = (m) => !!m && m.startsWith('gpt-');
export const toolForModel = (m) => (isCodexModel(m) ? 'codex' : 'claude');
