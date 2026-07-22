import { useEffect, useState } from 'react';
import Autocomplete from '@mui/material/Autocomplete';
import TextField from '@mui/material/TextField';
import Checkbox from '@mui/material/Checkbox';

// Skill-scopes multiselect shared by every Create*Dialog. Owns the
// GET /skill-scopes fetch, refreshed whenever the dialog opens. When
// SING_SCOPE_ROOT is unset the daemon returns { scopes: [] } and we render
// nothing — the field disappears for vanilla users (no skill-scopes), matching
// the /capabilities-driven degradation elsewhere.
export default function ScopeSelect({ open, value, onChange }) {
  const [scopeList, setScopeList] = useState([]);

  useEffect(() => {
    if (!open) return;
    fetch('/skill-scopes').then((r) => r.json()).then((d) => setScopeList(d.scopes || [])).catch(() => {});
  }, [open]);

  if (scopeList.length === 0) return null;

  return (
    <Autocomplete
      multiple
      size="small"
      disableCloseOnSelect
      options={scopeList}
      value={value}
      onChange={(_, v) => onChange(v)}
      renderOption={(props, option, { selected }) => (
        <li {...props}><Checkbox size="small" checked={selected} style={{ marginRight: 8 }} />{option}</li>
      )}
      renderInput={(params) => <TextField {...params} label="skill-scopes" placeholder="" />}
    />
  );
}
