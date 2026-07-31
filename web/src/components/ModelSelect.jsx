import { useEffect, useState } from 'react';
import Autocomplete from '@mui/material/Autocomplete';
import TextField from '@mui/material/TextField';
import Box from '@mui/material/Box';
import { getTokens } from '@/theme/contract.js';
import { useCapabilities } from '@/hooks/useCapabilities.js';

// Shared model picker for the create dialogs. Free-text-with-suggestions: lists
// the claude aliases (mirror /model) + ollama presets + codex presets, but
// accepts any typed string — a new claude alias, a full id (claude-opus-4-8),
// any ollama name, or a gpt-* id. /model's list is baked into the claude
// binary and shifts over time, so the suggestions are convenience defaults,
// not a closed set. Controlled via inputValue/onInputChange (same pattern as
// the cwd picker in the dialogs). The session type (tool) is derived from
// which group the chosen model belongs to (see lib/models.js) — this picker
// always offers all three groups rather than filtering by a tool choice.
// Alias → friendly name. /model's menu shows names (Opus, Sonnet, …) while the
// values the claude bin accepts are aliases, so the rows show both: name
// first (what users recognise), alias second (what gets submitted). Unknown
// aliases — a new server entry — render bare rather than guessing a name.
const CLAUDE_NAMES = {
  claude: 'Default',
  best: 'Best available',
  fable: 'Fable',
  opus: 'Opus',
  sonnet: 'Sonnet',
  haiku: 'Haiku',
  'opus[1m]': 'Opus (1M context)',
  'sonnet[1m]': 'Sonnet (1M context)',
  opusplan: 'Opus in plan mode, Sonnet after',
};

export default function ModelSelect({ model, setModel, label = 'model', placeholder = 'claude (default)' }) {
  const [options, setOptions] = useState([]);
  const caps = useCapabilities();
  // OLLAMA_PRESETS is a static list the server always returns — gate the ollama
  // group on OLLAMA_BIN actually being set so the picker doesn't suggest models
  // that would fail at spawn. Free-text still lets a user type an ollama name.
  const ollamaUnavailable = caps && caps.ollama?.available === false;
  const ollamaHint = caps?.ollama?.hint;
  // Codex group gates on CODEX_BIN (codexSpawn capability), same convention as
  // ollama — the static CODEX_PRESETS list is always returned by /models.
  const codexUnavailable = caps && caps.codexSpawn?.available === false;
  const codexHint = caps?.codexSpawn?.hint;

  useEffect(() => {
    let alive = true;
    fetch('/models').then((r) => r.json()).then((d) => {
      if (!alive) return;
      const claude = (d.claude || []).map((m) => ({ label: m, group: 'claude' }));
      const ollama = ollamaUnavailable ? [] : (d.ollama || []).map((m) => ({ label: m, group: 'ollama' }));
      const codex = codexUnavailable ? [] : (d.codex || []).map((m) => ({ label: m, group: 'codex' }));
      setOptions([...claude, ...ollama, ...codex]);
    }).catch(() => {});
    return () => { alive = false; };
  }, [ollamaUnavailable, codexUnavailable]);

  return (
    <Autocomplete
      freeSolo
      fullWidth
      clearOnEscape
      size="small"
      options={options}
      groupBy={(o) => o.group}
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
          <span>{CLAUDE_NAMES[o.label] || o.label}</span>
          {CLAUDE_NAMES[o.label] ? (
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