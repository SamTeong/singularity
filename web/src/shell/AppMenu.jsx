import { useState } from 'react';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Divider from '@mui/material/Divider';
import Switch from '@mui/material/Switch';
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
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import DarkModeIcon from '@mui/icons-material/DarkMode';
import LightModeIcon from '@mui/icons-material/LightMode';
import Sparkline from '@/components/Sparkline.jsx';
import { useSysStats } from '@/hooks/useSysStats.js';
import SkinSwitcher from '@/theme/SkinSwitcher.jsx';

// Overflow-nav entries surfaced from the More menu (view id + icon + label).
const NAV_ITEMS = [
  { v: 'config', icon: <SettingsIcon fontSize="small" />, label: 'Config' },
  { v: 'hooks', icon: <WebhookIcon fontSize="small" />, label: 'Hooks' },
  { v: 'skills', icon: <SchoolIcon fontSize="small" />, label: 'Skills' },
  { v: 'rules', icon: <GavelIcon fontSize="small" />, label: 'Rules' },
  { v: 'memory', icon: <BookIcon fontSize="small" />, label: 'Memory' },
  { v: 'sessions', icon: <HistoryIcon fontSize="small" />, label: 'Transcripts' },
  { v: 'wiki', icon: <MenuBookIcon fontSize="small" />, label: 'Wiki' },
];

const SPARK_WINDOWS = [[5, '5 min'], [30, '30 min'], [60, '1 hour']];

/**
 * The "More" overflow menu: secondary nav (Config/Hooks/…/Wiki), the process
 * manager, a live machine CPU/RAM readout (polled only while the menu is open),
 * an optional server-restart entry, the theme-skin picker, and the light/dark
 * toggle. Navigation + heavy actions are delegated via callbacks.
 */
export default function AppMenu({ anchorEl, onClose, onNavigate, onOpenProcesses, onOpenRestart, restarting, resolved, onToggleTheme }) {
  const open = !!anchorEl;
  const [sparkWin, setSparkWin] = useState(30); // sparkline window in minutes (5 / 30 / 60)
  const sysStats = useSysStats(open);

  return (
    <Menu anchorEl={anchorEl} open={open} onClose={onClose} keepMounted>
      {NAV_ITEMS.map((item) => (
        <MenuItem key={item.v} onClick={() => { onNavigate(item.v); onClose(); }}>
          <ListItemIcon>{item.icon}</ListItemIcon>
          <ListItemText>{item.label}</ListItemText>
        </MenuItem>
      ))}
      <Divider />
      <MenuItem onClick={() => { onOpenProcesses(); onClose(); }}>
        <ListItemIcon><MonitorHeartIcon fontSize="small" /></ListItemIcon>
        <ListItemText>Processes</ListItemText>
      </MenuItem>
      <Box sx={{ px: 2, py: 1 }}>
        <Typography sx={{ fontSize: 11, color: 'text.secondary' }}>
          CPU  {sysStats?.cpu == null ? '—' : sysStats.cpu + '%'}
        </Typography>
        <Sparkline values={(sysStats?.history?.cpu || []).slice(-sparkWin * 30)} capacity={sparkWin * 30} color="var(--mui-palette-primary-main)" />
        <Typography sx={{ fontSize: 11, color: 'text.secondary', mt: 1.5 }}>
          RAM  {sysStats ? `${sysStats.mem.pct}% (${(sysStats.mem.used / 1024 ** 3).toFixed(1)} / ${(sysStats.mem.total / 1024 ** 3).toFixed(1)} GB)` : '—'}
        </Typography>
        <Sparkline values={(sysStats?.history?.mem || []).slice(-sparkWin * 30)} capacity={sparkWin * 30} color="var(--mui-palette-info-main)" />
        {/* Window pills — slice the tail of the 1 h ring (samples = minutes * 30 @ 2s). */}
        <Stack direction="row" spacing={0.5} sx={{ mt: 0.75 }}>
          {SPARK_WINDOWS.map(([m, label]) => (
            <Box
              key={m}
              role="button"
              tabIndex={0}
              onClick={() => setSparkWin(m)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSparkWin(m); } }}
              sx={{
                px: 1, py: 0.25, borderRadius: 1, fontSize: 10, cursor: 'pointer', userSelect: 'none',
                color: sparkWin === m ? 'primary.main' : 'text.secondary',
                bgcolor: sparkWin === m ? 'action.selected' : 'transparent',
                '&:hover': { bgcolor: sparkWin === m ? 'action.selected' : 'action.hover' },
              }}
            >
              {label}
            </Box>
          ))}
        </Stack>
      </Box>
      {/* Self-respawn only works when the daemon serves the built UI (npm start).
          In dev, concurrently -k kills Vite too, so the shell can't reconnect. */}
      {import.meta.env.PROD && (
        <MenuItem disabled={restarting} onClick={() => { onOpenRestart(); onClose(); }}>
          <ListItemIcon><RestartAltIcon fontSize="small" sx={{ color: 'warning.main' }} /></ListItemIcon>
          <ListItemText>Restart server</ListItemText>
        </MenuItem>
      )}
      {/* Registry-driven skin picker — renders only when ≥2 skins registered. */}
      <SkinSwitcher onSelect={onClose} />
      <Divider />
      <MenuItem onClick={onToggleTheme}>
        <ListItemIcon>{resolved === 'dark' ? <DarkModeIcon fontSize="small" /> : <LightModeIcon fontSize="small" />}</ListItemIcon>
        <Switch edge="end" checked={resolved === 'dark'} onChange={onToggleTheme} onClick={(e) => e.stopPropagation()} />
      </MenuItem>
    </Menu>
  );
}
