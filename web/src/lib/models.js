// Mirror of server/models.mjs isCodexModel. When the caller has the model list
// (Settings ▸ Models — GET /api/models), the stored group wins: a claude-group
// entry whose id happens to start with gpt- would otherwise misroute. The gpt-*
// prefix check stays as the free-text fallback (the server enforces that every
// codex-group entry is a gpt-* id, so the two agree for stored entries).
export const isCodexModel = (m, models) => {
  const group = models?.find((x) => x.id === m)?.group;
  if (group) return group === 'codex';
  return !!m && m.startsWith('gpt-');
};
export const toolForModel = (m, models) => (isCodexModel(m, models) ? 'codex' : 'claude');
