import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import RailSearch from './RailSearch.jsx';
import RailGroupToggle from './RailGroupToggle.jsx';

// Shared rail-header toolbar: search + optional group-toggle + folder-open
// button + optional trailing buttons + collapse chevron. Rendered inside a
// Rail render-prop. Caption markup below the toolbar (counts, paths, category
// filters) stays in each panel — it varies too much to share. `onToggleAll`
// present → group toggle shows; `extra` slots trailing buttons before the
// collapse chevron (e.g. Wiki's graph button).
export default function RailHeader({ searchPlaceholder, searchValue, onSearchChange, allOpen, onToggleAll, groupToggleDisabled, onPickFolder, extra, onCollapse, children }) {
  return (
    <Box sx={{ p: 1.5, pb: 0.5 }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
        <RailSearch placeholder={searchPlaceholder} value={searchValue} onChange={onSearchChange} />
        {onToggleAll && <RailGroupToggle allOpen={allOpen} onToggle={onToggleAll} disabled={groupToggleDisabled} />}
        <Tooltip title="Browse" placement="bottom" disableInteractive>
          <IconButton size="small" onClick={onPickFolder}><FolderOpenIcon /></IconButton>
        </Tooltip>
        {extra}
        <IconButton size="small" onClick={onCollapse}><ChevronLeftIcon /></IconButton>
      </Stack>
      {children}
    </Box>
  );
}