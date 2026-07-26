import { useEffect, useState } from 'react';
import Autocomplete from '@mui/material/Autocomplete';
import TextField from '@mui/material/TextField';
import Checkbox from '@mui/material/Checkbox';
import Tooltip from '@mui/material/Tooltip';
import IconButton from '@mui/material/IconButton';
import CloseIcon from '@mui/icons-material/Close';
import InputAdornment from '@mui/material/InputAdornment';
import { PAPER_TOOLTIP_SLOTPROPS } from '@/shell/shellStyles.js';

// Skill-scopes multiselect shared by every Create*Dialog. Owns the
// GET /skill-scopes fetch, refreshed whenever the dialog opens. When
// SING_SCOPE_ROOT is unset the daemon returns { scopes: [] } and we render
// nothing — the field disappears for vanilla users (no skill-scopes), matching
// the /capabilities-driven degradation elsewhere. Each option's MUI Tooltip
// lists the skills belonging to that scope (sorted, numbered).
export default function ScopeSelect({ open, value, onChange }) {
  const [scopeList, setScopeList] = useState([]);
  const [skillsByScope, setSkillsByScope] = useState({});
  const [inputText, setInputText] = useState('');

  useEffect(() => {
    if (!open) return;
    fetch('/skill-scopes').then((r) => r.json()).then((d) => {
      setScopeList(d.scopes || []);
      setSkillsByScope(d.skillsByScope || {});
    }).catch(() => {});
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
      inputValue={inputText}
      onInputChange={(_, v) => setInputText(v || '')}
      renderOption={({ key, ...props }, option, { selected }) => {
        const skills = (skillsByScope[option] || []).slice().sort((a, b) => a.localeCompare(b));
        return (
          <Tooltip
            key={key}
            placement="right"
            disableInteractive
            title={skills.length ? skills.map((s, i) => `${i + 1}. ${s}`).join('\n') : '(no skills)'}
            slotProps={PAPER_TOOLTIP_SLOTPROPS}
          >
            <li {...props}><Checkbox size="small" checked={selected} style={{ marginRight: 8 }} />{option}</li>
          </Tooltip>
        );
      }}
      renderInput={(params) => {
        const endAdornment = inputText ? (
          <InputAdornment position="end" sx={{ marginRight: '-4px' }}>
            <IconButton size="small" aria-label="clear text" onClick={() => setInputText('')} edge="end" sx={{ p: 0.25 }}>
              <CloseIcon fontSize="small" />
            </IconButton>
          </InputAdornment>
        ) : null;
        return (
          <TextField
            {...params}
            label="skill-scopes"
            placeholder=""
            slotProps={{
              ...params.slotProps,
              input: {
                ...params.slotProps?.input,
                endAdornment: <>{endAdornment}{params.slotProps?.input?.endAdornment}</>,
              },
            }}
          />
        );
      }}
    />
  );
}
