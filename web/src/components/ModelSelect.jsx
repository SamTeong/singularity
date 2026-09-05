import { useMemo } from 'react';
import Autocomplete from '@mui/material/Autocomplete';
import TextField from '@mui/material/TextField';
import Box from '@mui/material/Box';
import { getTokens } from '@/theme/contract.js';
import { useCapabilities } from '@/hooks/useCapabilities.js';
import { useModels } from '@/hooks/useModels.js';

// Shared model picker for the create dialogs. Free-text-with-suggestions: the
// options come from the user-managed model list (Settings ▸ Models, via
// useModels) filtered to enabled entries and grouped by which bin the daemon
// routes them to, but any typed string is accepted — a new alias, a full id
// (claude-opus-4-8), any ollama name, or a gpt-* id. /model's list is baked
// into the claude binary and shifts over time, so the list is convenience
// data, not a closed set. Controlled via inputValue/onInputChange (same
// pattern as the cwd picker in the dialogs). The session type (tool) is
// derived from which group the chosen model belongs to (see lib/models.js) —
// this picker always offers all three groups rather than filtering by a tool
// choice. Rows show the stored label (friendly name) first and the id second;
// entries with no label render the id bare. A failed /api/models fetch leaves
// the options empty — freeSolo keeps the field usable regardless.
export default function ModelSelect({ model, setModel, label = 'model', placeholder = 'claude (default)' }) {
  const { models } = useModels();
  const caps = useCapabilities();
  // Gate the ollama group on OLLAMA_BIN actually being set so the picker doesn't
  // suggest models that would fail at spawn. Free-text still lets a user type an
  // ollama name.
  const ollamaUnavailable = caps && caps.ollama?.available === false;
  const ollamaHint = caps?.ollama?.hint;
  // Codex group gates on CODEX_BIN (codexSpawn capability), same convention as ollama.
  const codexUnavailable = caps && caps.codexSpawn?.available === false;
  const codexHint = caps?.codexSpawn?.hint;

  // Partition by group in this fixed order (claude → ollama → codex) while
  // keeping the user's array order inside each group — Autocomplete's groupBy
  // emits a group header per transition, so interleaved groups would render
  // repeated headers.
  const options = useMemo(() => {
    const inGroup = (g) => (models || []).filter((m) => m.enabled && m.group === g).map((m) => ({ label: m.id, group: g, name: m.label }));
    return [
      ...inGroup('claude'),
      ...(ollamaUnavailable ? [] : inGroup('ollama')),
      ...(codexUnavailable ? [] : inGroup('codex')),
    ];
  }, [models, ollamaUnavailable, codexUnavailable]);

  return (
    <Autocomplete
      freeSolo
      fullWidth
      clearOnEscape
      size="small"
      options={options}
      groupBy={(o) => o.group}
      // Suggestions, not a filter: the D5 default prefill means the input is
      // usually non-empty when the list opens, and the default matcher would
      // then hide every option that doesn't happen to contain that text.
      filterOptions={(o) => o}
      inputValue={model}
      onInputChange={(_, v) => setModel(v || '')}
      getOptionLabel={(o) => (typeof o === 'string' ? o : o.label)}
      isOptionEqualToValue={(o, v) => (typeof o === 'string' ? o : o.label) === v}
      renderInput={(params) => (
        <TextField
          {...params}
          label={label}
          placeholder={placeholder}
          spellCheck={false}
          helperText={ollamaUnavailable ? ollamaHint : codexUnavailable ? codexHint : null}
        />
      )}
      renderOption={({ key, ...props }, o) => (
        <Box component="li" key={key} {...props} sx={{ display: 'flex', justifyContent: 'space-between', gap: 2 }}>
          <span>{o.name || o.label}</span>
          {o.name ? (
            <Box component="span" sx={(t) => ({ fontFamily: getTokens(t).fonts.mono, fontSize: 12, color: 'text.secondary' })}>{o.label}</Box>
          ) : null}
        </Box>
      )}
      renderGroup={(props) => (
        <li key={props.key}>
          <Box sx={{ px: 1.75, pt: 0.5, pb: 0.25, fontSize: 12, color: 'text.secondary', textTransform: 'uppercase', letterSpacing: 0.5 }}>{props.group}</Box>
          <ul style={{ padding: 0, margin: 0 }}>{props.children}</ul>
        </li>
      )}
    />
  );
}