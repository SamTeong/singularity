import React, { useEffect, useState } from 'react';
import Autocomplete from '@mui/material/Autocomplete';
import TextField from '@mui/material/TextField';
import Box from '@mui/material/Box';

// Shared model picker for the create dialogs. Free-text-with-suggestions: lists
// the claude aliases (mirror /model) + ollama presets, but accepts any typed
// string — a new claude alias, a full id (claude-opus-4-8), or any ollama name.
// /model's list is baked into the claude binary and shifts over time, so the
// suggestions are convenience defaults, not a closed set. Controlled via
// inputValue/onInputChange (same pattern as the cwd picker in the dialogs).
export default function ModelSelect({ model, setModel, label = 'model', placeholder = 'claude (default)' }) {
  const [options, setOptions] = useState([]);

  useEffect(() => {
    let alive = true;
    fetch('/models').then((r) => r.json()).then((d) => {
      if (!alive) return;
      const claude = d.claude || [];
      const ollama = d.ollama || [];
      setOptions([...claude.map((m) => ({ label: m, group: 'claude' })), ...ollama.map((m) => ({ label: m, group: 'ollama' }))]);
    }).catch(() => {});
    return () => { alive = false; };
  }, []);

  return (
    <Autocomplete
      freeSolo
      fullWidth
      disableClearable
      size="small"
      options={options}
      groupBy={(o) => o.group}
      inputValue={model}
      onInputChange={(_, v) => setModel(v || '')}
      getOptionLabel={(o) => (typeof o === 'string' ? o : o.label)}
      isOptionEqualToValue={(o, v) => (typeof o === 'string' ? o : o.label) === v}
      renderInput={(params) => <TextField {...params} label={label} placeholder={placeholder} spellCheck={false} />}
      renderGroup={(props) => (
        <li key={props.key}>
          <Box sx={{ px: 1.75, pt: 0.5, pb: 0.25, fontSize: 12, color: 'text.secondary', textTransform: 'uppercase', letterSpacing: 0.5 }}>{props.group}</Box>
          <ul style={{ padding: 0, margin: 0 }}>{props.children}</ul>
        </li>
      )}
    />
  );
}