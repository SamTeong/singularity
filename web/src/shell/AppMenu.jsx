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
import { getTokens, getRoles } from '@/theme/contract.js';
import { chipBg, stroke2, surface2, brandOrInk, focusRing } from '@/shell/shellStyles.js';
import { useThemeSkin } from '@/theme/index.js';
import Sparkline from '@/components/Sparkline.jsx';
import { useSysStats } from '@/hooks/useSysStats.js';

// Overflow-nav entries surfaced from the More menu (view id + icon + label +
// bilingual jp/en pair — task 4.5). The jp glyph is Phosphor-only decorative
// chrome, rendered `aria-hidden` so the menuitem's accessible name (and e2e
// `getByRole('menuitem', {name})` lookups) stay the plain English label.
const NAV_ITEMS = [
  { v: 'config', icon: <SettingsIcon />, label: 'Config', jp: '設定' },
  { v: 'hooks', icon: <WebhookIcon />, label: 'Hooks', jp: '連鎖' },
  { v: 'skills', icon: <SchoolIcon />, label: 'Skills', jp: '技能' },
  { v: 'rules', icon: <GavelIcon />, label: 'Rules', jp: '規則' },
  { v: 'memory', icon: <BookIcon />, label: 'Memory', jp: '記憶' },
  { v: 'explorer', icon: <FolderOpenIcon />, label: 'Explorer', jp: '探索' },
  { v: 'sessions', icon: <HistoryIcon />, label: 'Transcripts', jp: '記録' },
  { v: 'wiki', icon: <MenuBookIcon />, label: 'Wiki', jp: '文庫' },
  { v: 'appearance', icon: <PaletteIcon />, label: 'Appearance', jp: '外観' },
  { v: 'status', icon: <CloudSyncIcon />, label: 'Status', jp: '状態' },
];
const PROCESSES_JP = '工程';
const RESTART_JP = '再起動';

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

// Phosphor console menu item (layout-02 `.mi`): flat void row, mint text, a
// mint hairline only on hover/focus (no chip-tint fill — chip fill is reserved
// for the figure/ground "selected/active" inversion, and these rows are
// one-shot navigations, not persisted selection). Visible focus comes from
// `focusRing` (the shared amber-dashed recipe) since the vendored theme's
// MuiMenuItem override has no `:focus-visible` rule of its own.
const phosphorMenuItemSx = (t) => ({
  m: 0,
  px: '8px',
  py: '6px',
  gap: '9px',
  border: '1px solid transparent',
  '&:hover': { borderColor: getRoles(t).status.nominal, backgroundColor: 'transparent' },
  '&:focus-visible': focusRing(t),
});
const phosphorMenuIconSx = { minWidth: 0, mr: '9px', color: 'inherit', '& svg': { fontSize: 17 } };

/**
 * Bilingual overflow-menu item label (task 4.5): a Mincho jp term beside its
 * English caption, sized/aligned per layout-02's `.mi .jp`/`.mi .en`.
 * Phosphor-only; ZAPAC passes the plain `label` string straight through.
 */
function MenuLabel({ jp, en }) {
  return (
    <Box component="span" sx={{ display: 'inline-flex', alignItems: 'baseline', gap: '9px', minWidth: 0 }}>
      <Box component="span" aria-hidden sx={(t) => ({ fontFamily: getTokens(t).fonts.jp, fontWeight: 800, fontSize: 15, lineHeight: 1, letterSpacing: '.1em', width: '2.4em', flex: 'none' })}>
        {jp}
      </Box>
      <Box component="span" sx={(t) => ({ fontFamily: getTokens(t).fonts.display, fontWeight: 700, fontSize: 11, letterSpacing: '.13em', textTransform: 'uppercase' })}>
        {en}
      </Box>
    </Box>
  );
}

/**
 * The "More" overflow menu: secondary nav (Config/Hooks/…/Wiki), the process
 * manager, a live machine CPU/RAM readout (polled only while the menu is open),
 * an optional server-restart entry, and the Appearance (theme) view. Navigation
 * + heavy actions are delegated via callbacks.
 *
 * Restyled under Phosphor (task 4.5) as an orange-framed console menu with
 * bilingual items and a red destructive restart row — same destinations,
 * actions, confirmation flow, and `Menu`/`Popover` portal behavior as ZAPAC.
 */
export default function AppMenu({ anchorEl, onClose, onNavigate, onOpenProcesses, onOpenRestart, restarting }) {
  const open = !!anchorEl;
  const [sparkWin, setSparkWin] = useState(30); // sparkline window in minutes (5 / 30 / 60)
  const sysStats = useSysStats(open);
  const { skinId } = useThemeSkin();
  const isPhosphor = skinId === 'phosphor';

  return (
    <Menu
      anchorEl={anchorEl}
      open={open}
      onClose={onClose}
      keepMounted
      slotProps={{
        // `Menu` already renders through a `Popover` portal, so the frame's
        // chamfer clip can't cut this off (design.md D5's "overlays escape the
        // frame clip" requirement) — only the paper's own presentation changes.
        paper: {
          sx: (t) =>
            isPhosphor
              ? {
                  width: 248,
                  background: getRoles(t).shell.panel,
                  border: `2px solid ${getRoles(t).chrome.stroke}`,
                  borderRadius: getTokens(t).radius.none,
                  boxShadow: getRoles(t).shell.glow,
                  clipPath: getRoles(t).shell.chamfer(16),
                }
              : { width: 248 },
        },
        // layout-02 `.menu`: 6px padding around the whole item stack.
        list: { sx: { p: '6px' } },
      }}
    >
      {NAV_ITEMS.map((item) => (
        <MenuItem key={item.v} onClick={() => { onNavigate(item.v); onClose(); }} sx={isPhosphor ? phosphorMenuItemSx : menuItemSx}>
          <ListItemIcon sx={isPhosphor ? phosphorMenuIconSx : menuIconSx}>{item.icon}</ListItemIcon>
          <ListItemText>{isPhosphor ? <MenuLabel jp={item.jp} en={item.label} /> : item.label}</ListItemText>
        </MenuItem>
      ))}
      <Divider sx={(t) => ({ borderColor: stroke2(t), my: '6px', mx: '8px' })} />
      <MenuItem onClick={() => { onOpenProcesses(); onClose(); }} sx={isPhosphor ? phosphorMenuItemSx : menuItemSx}>
        <ListItemIcon sx={isPhosphor ? phosphorMenuIconSx : menuIconSx}><MonitorHeartIcon /></ListItemIcon>
        <ListItemText>{isPhosphor ? <MenuLabel jp={PROCESSES_JP} en="Processes" /> : 'Processes'}</ListItemText>
      </MenuItem>
      {/* layout-02 `.menu-sys`: CPU/RAM readout, sparkline, window pills — polled
          live from `/sysstats` (server/sysstats.mjs) only while the menu is open.
          Real machine data under both skins — Sparkline's CSS-var colors
          (`--mui-palette-primary-main` / `--mui-palette-info-main`) already
          resolve to Phosphor's mint/blue automatically, no fabricated feed. */}
      <Box sx={{ px: '12px', pt: '8px', pb: '10px' }}>
        <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'baseline', fontSize: 11, color: 'text.disabled', mb: '6px' }}>
          <span>CPU</span>
          <Box component="b" className="tnum" sx={{ color: 'text.secondary', fontWeight: 700 }}>
            {sysStats?.cpu == null ? '—' : `${sysStats.cpu}%`}
          </Box>
        </Stack>
        <Sparkline values={(sysStats?.history?.cpu || []).slice(-sparkWin * 30)} capacity={sparkWin * 30} color="var(--mui-palette-primary-main)" width={220} height={26} compact />
        <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'baseline', fontSize: 11, color: 'text.disabled', mt: '9px', mb: '6px' }}>
          <span>RAM</span>
          <Box component="b" className="tnum" sx={{ color: 'text.secondary', fontWeight: 700 }}>
            {sysStats ? `${sysStats.mem.pct}% · ${(sysStats.mem.used / 1024 ** 3).toFixed(1)} / ${(sysStats.mem.total / 1024 ** 3).toFixed(1)} GB` : '—'}
          </Box>
        </Stack>
        <Sparkline values={(sysStats?.history?.mem || []).slice(-sparkWin * 30)} capacity={sparkWin * 30} color="var(--mui-palette-info-main)" width={220} height={26} compact />
        {/* Window pills — slice the tail of the 1 h ring (samples = minutes * 30 @ 2s).
            `menu` only permits menuitem/menuitemradio/menuitemcheckbox/group/separator
            as children, so this is a `group` of `menuitemradio`s (one-of-three), not
            a tablist/tab pair — MUI's MenuList manages focus/typeahead for them. */}
        <Stack direction="row" spacing="5px" role="group" aria-label="Sparkline window" sx={{ mt: '9px' }}>
          {SPARK_WINDOWS.map(([m, label]) => (
            <Box
              key={m}
              role="menuitemradio"
              aria-checked={sparkWin === m}
              tabIndex={0}
              onClick={() => setSparkWin(m)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSparkWin(m); } }}
              sx={(t) =>
                isPhosphor
                  ? {
                      px: '10px', py: '3px', borderRadius: getTokens(t).radius.none, fontSize: 10, cursor: 'pointer', userSelect: 'none',
                      border: `1px solid ${getRoles(t).chrome.stroke}`,
                      color: sparkWin === m ? getRoles(t).shell.surface : getRoles(t).chrome.stroke,
                      background: sparkWin === m ? getRoles(t).chrome.stroke : 'transparent',
                      '&:hover': { color: sparkWin === m ? getRoles(t).shell.surface : getRoles(t).status.nominal, borderColor: sparkWin === m ? getRoles(t).chrome.stroke : getRoles(t).status.nominal },
                      '&:focus-visible': focusRing(t),
                    }
                  : {
                      px: '10px', py: '3px', borderRadius: 999, fontSize: 10, cursor: 'pointer', userSelect: 'none',
                      transition: 'background .14s ease',
                      color: sparkWin === m ? brandOrInk(t) : 'text.disabled',
                      bgcolor: sparkWin === m ? chipBg(t) : 'transparent',
                      '&:hover': { bgcolor: sparkWin === m ? chipBg(t) : surface2(t) },
                    }
              }
            >
              {label}
            </Box>
          ))}
        </Stack>
      </Box>
      {/* Self-respawn only works when the daemon serves the built UI (npm start).
          In dev, concurrently -k kills Vite too, so the shell can't reconnect. */}
      {import.meta.env.PROD && (
        <>
          <Divider sx={(t) => ({ borderColor: stroke2(t), my: '6px', mx: '8px' })} />
          <MenuItem
            disabled={restarting}
            onClick={() => { onOpenRestart(); onClose(); }}
            sx={(t) =>
              isPhosphor
                // `error.main` (not `roles.status.critical`) so the AA override
                // in skins/phosphor.jsx applies — `redHi` alone is 4.28:1 on void.
                ? { ...phosphorMenuItemSx(t), color: t.vars.palette.error.main, '&:hover': { borderColor: t.vars.palette.error.main, backgroundColor: 'transparent' } }
                : { ...menuItemSx(t), color: 'warning.main' }
            }
          >
            <ListItemIcon sx={isPhosphor ? { ...phosphorMenuIconSx, color: 'inherit' } : { ...menuIconSx, color: 'warning.main' }}><RestartAltIcon /></ListItemIcon>
            <ListItemText>{isPhosphor ? <MenuLabel jp={RESTART_JP} en="Restart server" /> : 'Restart server'}</ListItemText>
          </MenuItem>
        </>
      )}
    </Menu>
  );
}
