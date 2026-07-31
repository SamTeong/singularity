import { useState } from 'react';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Divider from '@mui/material/Divider';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import SettingsIcon from '@mui/icons-material/Settings';
import WebhookIcon from '@mui/icons-material/Webhook';
import GavelIcon from '@mui/icons-material/Gavel';
import BookIcon from '@mui/icons-material/Book';
import MenuBookIcon from '@mui/icons-material/MenuBook';
import SchoolIcon from '@mui/icons-material/School';
import HistoryIcon from '@mui/icons-material/History';
import MonitorHeartIcon from '@mui/icons-material/MonitorHeart';
import CloudSyncIcon from '@mui/icons-material/CloudSync';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import PaletteIcon from '@mui/icons-material/Palette';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import { getTokens } from '@/theme/contract.js';
import { chipBg, stroke2 } from '@/shell/shellStyles.js';
import Sparkline from '@/components/Sparkline.jsx';
import { useSysStats } from '@/hooks/useSysStats.js';

// Overflow-nav entries surfaced from the More menu (view id + icon + label).
const NAV_ITEMS = [
  { v: 'config', icon: <SettingsIcon />, label: 'Config' },
  { v: 'hooks', icon: <WebhookIcon />, label: 'Hooks' },
  { v: 'skills', icon: <SchoolIcon />, label: 'Skills' },
  { v: 'rules', icon: <GavelIcon />, label: 'Rules' },
  { v: 'memory', icon: <BookIcon />, label: 'Memory' },
  { v: 'explorer', icon: <FolderOpenIcon />, label: 'Explorer' },
  { v: 'sessions', icon: <HistoryIcon />, label: 'Transcripts' },
  { v: 'wiki', icon: <MenuBookIcon />, label: 'Wiki' },
  { v: 'appearance', icon: <PaletteIcon />, label: 'Appearance' },
  { v: 'status', icon: <CloudSyncIcon />, label: 'Status' },
];

const SPARK_WINDOWS = [[5, '5 min'], [30, '30 min'], [60, '1 hour']];

// layout-02 `.menu-item`: 9px/12px padding, r-sm radius, hover = chip fill. The
// theme's global MuiMenuItem override (margin 2px 6px) is meant for menus that
// sit flush against the paper's own padding — this menu gives the paper 6px of
// its own (via `slotProps.list`), so items reset their margin to 0 and take the
// mockup's exact padding instead.
const menuItemSx = (t) => ({
  m: 0,
  px: '12px',
  py: '9px',
  borderRadius: `${getTokens(t).radius.sm}px`,
  '&:hover': { backgroundColor: chipBg(t) },
});

// layout-02 `.menu-item svg`: 17px icons in ink-2, 12px gap to the label.
const menuIconSx = { minWidth: 0, mr: '12px', color: 'text.secondary', '& svg': { fontSize: 17 } };

/**
 * The "More" overflow menu: secondary nav (Config/Hooks/…/Wiki), the process
 * manager, a live machine CPU/RAM readout (polled only while the menu is open),
 * an optional server-restart entry, and the Appearance (theme) view. Navigation
 * + heavy actions are delegated via callbacks.
 */
export default function AppMenu({ anchorEl, onClose, onNavigate, onOpenProcesses, onOpenRestart, restarting }) {
  const open = !!anchorEl;
  const [sparkWin, setSparkWin] = useState(30); // sparkline window in minutes (5 / 30 / 60)
  const sysStats = useSysStats(open);

  return (
    <Menu
      anchorEl={anchorEl}
      open={open}
      onClose={onClose}
      keepMounted
      slotProps={{
        paper: { sx: { minWidth: 248 } },
        // layout-02 `.menu`: 6px padding around the whole item stack.
        list: { sx: { p: '6px' } },
      }}
    >
      {NAV_ITEMS.map((item) => (
        <MenuItem key={item.v} onClick={() => { onNavigate(item.v); onClose(); }} sx={menuItemSx}>
          <ListItemIcon sx={menuIconSx}>{item.icon}</ListItemIcon>
          <ListItemText>{item.label}</ListItemText>
        </MenuItem>
      ))}
      <Divider sx={(t) => ({ borderColor: stroke2(t), my: '6px', mx: '8px' })} />
      <MenuItem onClick={() => { onOpenProcesses(); onClose(); }} sx={menuItemSx}>
        <ListItemIcon sx={menuIconSx}><MonitorHeartIcon /></ListItemIcon>
        <ListItemText>Processes</ListItemText>
      </MenuItem>
      {/* layout-02 `.menu-sys`: CPU/RAM readout, sparkline, window pills — polled
          live from `/sysstats` (server/sysstats.mjs) only while the menu is open. */}
      <Box sx={{ px: '12px', pt: '8px', pb: '10px' }}>
        <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'baseline', fontSize: 11, color: 'text.disabled', mb: '6px' }}>
          <span>CPU</span>
          <Box component="b" className="tnum" sx={{ color: 'text.secondary', fontWeight: 700 }}>
            {sysStats?.cpu == null ? '—' : `${sysStats.cpu}%`}
          </Box>
        </Stack>
        <Sparkline values={(sysStats?.history?.cpu || []).slice(-sparkWin * 30)} capacity={sparkWin * 30} color="var(--mui-palette-primary-main)" width={224} height={26} />
        <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'baseline', fontSize: 11, color: 'text.disabled', mt: '9px', mb: '6px' }}>
          <span>RAM</span>
          <Box component="b" className="tnum" sx={{ color: 'text.secondary', fontWeight: 700 }}>
            {sysStats ? `${sysStats.mem.pct}% · ${(sysStats.mem.used / 1024 ** 3).toFixed(1)} / ${(sysStats.mem.total / 1024 ** 3).toFixed(1)} GB` : '—'}
          </Box>
        </Stack>
        <Sparkline values={(sysStats?.history?.mem || []).slice(-sparkWin * 30)} capacity={sparkWin * 30} color="var(--mui-palette-info-main)" width={224} height={26} />
        {/* Window pills — slice the tail of the 1 h ring (samples = minutes * 30 @ 2s). */}
        <Stack direction="row" spacing="5px" role="tablist" aria-label="Sparkline window" sx={{ mt: '9px' }}>
          {SPARK_WINDOWS.map(([m, label]) => (
            <Box
              key={m}
              role="tab"
              aria-selected={sparkWin === m}
              tabIndex={0}
              onClick={() => setSparkWin(m)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSparkWin(m); } }}
              sx={(t) => ({
                px: '10px', py: '3px', borderRadius: 999, fontSize: 10, cursor: 'pointer', userSelect: 'none',
                color: sparkWin === m ? 'text.primary' : 'text.disabled',
                bgcolor: sparkWin === m ? chipBg(t) : 'transparent',
                '&:hover': { bgcolor: sparkWin === m ? chipBg(t) : 'action.hover' },
              })}
            >
              {label}
            </Box>
          ))}
        </Stack>
      </Box>
      {/* Self-respawn only works when the daemon serves the built UI (npm start).
          In dev, concurrently -k kills Vite too, so the shell can't reconnect. */}
      {import.meta.env.PROD && (
        <MenuItem disabled={restarting} onClick={() => { onOpenRestart(); onClose(); }} sx={(t) => ({ ...menuItemSx(t), color: 'warning.main' })}>
          <ListItemIcon sx={{ ...menuIconSx, color: 'warning.main' }}><RestartAltIcon /></ListItemIcon>
          <ListItemText>Restart server</ListItemText>
        </MenuItem>
      )}
    </Menu>
  );
}
