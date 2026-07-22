import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import ClearIcon from '@mui/icons-material/Clear';
import { SearchInput } from '@zapac/mui-theme';

// Search field + inline clear button — the rail-header search block shared by
// every file-browser panel. Clear appears only when there's a value.
export default function RailSearch({ placeholder, value, onChange }) {
  return (
    <Box sx={{ flex: 1, minWidth: 0, position: 'relative' }}>
      <SearchInput placeholder={placeholder} value={value} onChange={onChange} shortcut="" sx={{ minWidth: 0 }} />
      {value && (
        <IconButton size="small" onClick={() => onChange('')} aria-label="Clear search"
          sx={{ position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)', '&:hover': { transform: 'translateY(-50%)' } }}>
          <ClearIcon fontSize="small" />
        </IconButton>
      )}
    </Box>
  );
}
