// Model routing. The suggestion lists themselves are user-managed runtime state
// now — they live in model-store.mjs (STATE_DIR/models.json), seeded from the
// shipped defaults on first boot. This module only answers "which bin does this
// model string spawn under".
//
// The picker stays free-text-with-suggestions: /model's list is built into the
// claude binary and shifts with version/account/env (no CLI flag exposes it), so
// any typed string is passed through. A string that is not in the store falls
// back to the prefix heuristics below.
//
// Every lookup goes through the store per call, never a module-level snapshot —
// a Settings edit must take effect without a daemon restart.
// ponytail: groupFor() re-reads models.json each call (read-on-every-get, same
// as config-state.mjs). Fine at the call rates here (per spawn / per session
// open); memoize on mtime if a hot loop ever appears.
import { groupFor } from './model-store.mjs';

// Floor set of the shipped claude alias ids (model-store.mjs SEED's claude
// group): tasks.mjs hardcodes 'sonnet'/'opus' as the subagent-split defaults,
// so a user who deletes those entries in Settings must still route them to the
// claude bin, not silently reroute them to the ollama wrapper.
const SHIPPED_CLAUDE_ALIASES = new Set(['claude', 'best', 'fable', 'opus', 'sonnet', 'haiku', 'opus[1m]', 'sonnet[1m]', 'opusplan']);

// true → run via the `claude` bin (optional --model); false → ollama wrapper.
// 'claude' is the default alias (no --model). The stored group wins; for a
// free-text id that is not in the store, the shipped aliases and full claude-*
// ids resolve to the claude bin and everything else is treated as an ollama
// model.
export function isClaudeModel(model) {
  const group = groupFor(model);
  if (group) return group === 'claude';
  return !model || SHIPPED_CLAUDE_ALIASES.has(model) || model.startsWith('claude-');
}

// true → run via the `codex` bin. The stored group wins; free-text falls back to
// the gpt-* prefix check (the store enforces that every codex entry is a gpt-*
// id, so the two agree). Checked after isClaudeModel (claude ids never start
// with gpt-), so a model is claude | codex | ollama in that order.
export function isCodexModel(model) {
  const group = groupFor(model);
  if (group) return group === 'codex';
  return !!model && model.startsWith('gpt-');
}

// Trust-boundary check: reject a tool/model pairing that can't reach a valid
// spawn (e.g. tool 'codex' + a claude alias, or tool 'claude' + a gpt-* id).
// Empty/absent model always passes (means "CLI default"); an absent/unknown
// tool is left to buildSpawn's own isCodexModel-driven routing. ollama models
// have no tool of their own — they only spawn under tool 'claude', so a gpt-*
// model under 'claude' or a non-gpt model under 'codex' both reject here.
export function validateToolModel(tool, model) {
  if (!tool || !model) return;
  if (isCodexModel(model) !== (tool === 'codex')) {
    throw new Error(`model '${model}' is not valid for tool '${tool}'`);
  }
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
//
// This table stays hardcoded on purpose: it maps resolved claude-* ids back to
// alias families, which is claude-binary behaviour, not user configuration.
const CLAUDE_ID_TO_ALIAS = [
  [/^claude-(opus)-[0-9].*\[1m\]$/, 'opus[1m]'],
  [/^claude-(sonnet)-[0-9].*\[1m\]$/, 'sonnet[1m]'],
  [/^claude-opus-/, 'opus'],
  [/^claude-sonnet-/, 'sonnet'],
  [/^claude-haiku-/, 'haiku'],
  [/^claude-fable-/, 'fable'],
];
export function claudeIdToAlias(model) {
  // A model the user has stored as a claude entry is already a picker option —
  // pass it through rather than folding it into a family alias.
  if (!model || groupFor(model) === 'claude' || !model.startsWith('claude-')) return model;
  for (const [re, alias] of CLAUDE_ID_TO_ALIAS) if (re.test(model)) return alias;
  return model;
}
