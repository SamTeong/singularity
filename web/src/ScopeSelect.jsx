import { useEffect, useState } from 'react';
import Autocomplete from '@mui/material/Autocomplete';
import TextField from '@mui/material/TextField';
import Checkbox from '@mui/material/Checkbox';

// Skill-scopes multiselect shared by every Create*Dialog. Owns the
// GET /skill-scopes fetch, refreshed whenever the dialog opens.
export default function ScopeSelect({ open, value, onChange }) {
  const [scopeList, setScopeList] = useState([]);

  useEffect(() => {
    if (!open) return;
    fetch('/skill-scopes').then((r) => r.json()).then((d) => setScopeList(d.scopes || [])).catch(() => {});
  }, [open]);

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
