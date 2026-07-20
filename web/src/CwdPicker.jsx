import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Autocomplete from '@mui/material/Autocomplete';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import { tildify } from './paths.js';

// The recent-repos cwd field shared by every Create*Dialog: a freeSolo
// Autocomplete plus, when the caller wires a folder browser, a Browse button.
// `label` varies per dialog — kept as-is, unifying label wording is a separate
// copy batch.
export default function CwdPicker({ value, onChange, recent, onBrowse, label }) {
  const field = (
    <Autocomplete
      freeSolo
      fullWidth
      options={(recent || []).map(tildify)}
      inputValue={value}
      onInputChange={(_, v) => onChange(v)}
      renderInput={(params) => <TextField {...params} size="small" label={label} spellCheck={false} />}
    />
  );
  if (!onBrowse) return field;
  return (
    <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
      {field}
      <Tooltip title="Browse…">
        <IconButton onClick={onBrowse}><FolderOpenIcon /></IconButton>
      </Tooltip>
    </Stack>
  );
}
