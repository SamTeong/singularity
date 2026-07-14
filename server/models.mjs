// Model picker source of truth: claude aliases (mirror /model) + ollama presets.
// /model's list is built into the claude binary and shifts with version/account/env
// (no CLI flag exposes it), so the picker is free-text-with-suggestions — these
// aliases are convenience defaults, not a closed set. Any typed string is passed
// through; isClaudeModel() routes it to the claude bin or the ollama wrapper.
export const CLAUDE_ALIASES = ['claude', 'best', 'fable', 'opus', 'sonnet', 'haiku', 'opus[1m]', 'sonnet[1m]', 'opusplan'];
export const OLLAMA_PRESETS = ['glm-5.2:cloud', 'kimi-k2.7-code:cloud'];
const ALIAS_SET = new Set(CLAUDE_ALIASES);

// true → run via the `claude` bin (optional --model); false → ollama wrapper.
// 'claude' is the default alias (no --model). Known aliases and full claude-*
// ids resolve to the claude bin; everything else is treated as an ollama model.
export function isClaudeModel(model) {
  return !model || model === 'claude' || ALIAS_SET.has(model) || model.startsWith('claude-');
}