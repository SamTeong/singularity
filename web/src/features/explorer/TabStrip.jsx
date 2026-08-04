import { getTokens } from '@/theme/contract.js';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import IconButton from '@mui/material/IconButton';
import Typography from '@mui/material/Typography';
import CloseIcon from '@mui/icons-material/Close';

const baseOf = (p) => p.slice(Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')) + 1);

// Horizontal scrollable tab row above the editor. `tabs` = [{path,dirty,...}] —
// basename as the label, full path as title, a dirty dot, a close button.
export default function TabStrip({ tabs, active, onSelect, onClose }) {
  return (
    <Stack direction="row" sx={(t) => ({ flexShrink: 0, overflowX: 'auto', borderBottom: `1px solid ${getTokens(t).glass.stroke}` })}>
      {tabs.map((tab) => (
        <Stack key={tab.path} direction="row" spacing={0.5} title={tab.path} onClick={() => onSelect(tab.path)}
          sx={(t) => ({
            alignItems: 'center', flexShrink: 0, gap: 0.5, px: 1, py: 0.5, cursor: 'pointer',
            borderRight: `1px solid ${getTokens(t).glass.stroke}`,
            bgcolor: tab.path === active ? 'action.selected' : 'transparent',
          })}
        >
          {tab.dirty && <Box sx={{ width: 6, height: 6, borderRadius: '50%', bgcolor: 'warning.main', flexShrink: 0 }} />}
          <Typography noWrap sx={{ fontSize: 12, maxWidth: 160 }}>{baseOf(tab.path)}</Typography>
          <IconButton size="small" sx={{ p: 0.25 }} onClick={(e) => { e.stopPropagation(); onClose(tab.path); }}>
            <CloseIcon sx={{ fontSize: 14 }} />
          </IconButton>
        </Stack>
      ))}
    </Stack>
  );
}
