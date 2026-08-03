// Model picker source of truth: claude aliases (mirror /model) + ollama presets.
// /model's list is built into the claude binary and shifts with version/account/env
// (no CLI flag exposes it), so the picker is free-text-with-suggestions — these
// aliases are convenience defaults, not a closed set. Any typed string is passed
// through; isClaudeModel() routes it to the claude bin or the ollama wrapper.
export const CLAUDE_ALIASES = ['claude', 'best', 'fable', 'opus', 'sonnet', 'haiku', 'opus[1m]', 'sonnet[1m]', 'opusplan'];
export const OLLAMA_PRESETS = ['glm-5.2:cloud', 'kimi-k3:cloud'];
// Codex presets (gpt-* family). Convenience defaults like the claude aliases —
// free-text still passes any gpt-* id through to the codex bin.
export const CODEX_PRESETS = ['gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.4-pro'];
const ALIAS_SET = new Set(CLAUDE_ALIASES);
const CODEX_SET = new Set(CODEX_PRESETS);

// true → run via the `claude` bin (optional --model); false → ollama wrapper.
// 'claude' is the default alias (no --model). Known aliases and full claude-*
// ids resolve to the claude bin; everything else is treated as an ollama model.
export function isClaudeModel(model) {
  return !model || model === 'claude' || ALIAS_SET.has(model) || model.startsWith('claude-');
}

// true → run via the `codex` bin. Known codex presets and any gpt-* id route to
// codex. Checked after isClaudeModel (claude ids never start with gpt-), so a
// model is claude | codex | ollama in that order.
export function isCodexModel(model) {
  return !!model && (CODEX_SET.has(model) || model.startsWith('gpt-'));
}

// The transcript logs an assistant event's model as the resolved full id
// (opus[1m] -> claude-opus-5; opus -> claude-opus-4-8), never the alias the
// user picked. That id is a valid claude arg but not a dropdown entry, so the
// Transcripts Resume button prefilled a raw id. Reverse-map a resolved id
// back to its family alias so the picker shows a recognized option. The [1m]
// context flag is preserved when the id carries it (claude-opus-4-8[1m] ->
// opus[1m]); for ids that drop it (claude-opus-5 from opus[1m]) it is
// unrecoverable, so the base alias is the safe fallback. Non-claude ids and
// already-alias input pass through unchanged.
const CLAUDE_ID_TO_ALIAS = [
  [/^claude-(opus)-[0-9].*\[1m\]$/, 'opus[1m]'],
  [/^claude-(sonnet)-[0-9].*\[1m\]$/, 'sonnet[1m]'],
  [/^claude-opus-/, 'opus'],
  [/^claude-sonnet-/, 'sonnet'],
  [/^claude-haiku-/, 'haiku'],
  [/^claude-fable-/, 'fable'],
];
export function claudeIdToAlias(model) {
  if (!model || ALIAS_SET.has(model) || !model.startsWith('claude-')) return model;
  for (const [re, alias] of CLAUDE_ID_TO_ALIAS) if (re.test(model)) return alias;
  return model;
}