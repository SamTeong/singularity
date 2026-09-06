import Box from '@mui/material/Box';
import Drawer from '@mui/material/Drawer';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import Typography from '@mui/material/Typography';
import MenuIcon from '@mui/icons-material/Menu';
import AddIcon from '@mui/icons-material/Add';
import MonitorHeartIcon from '@mui/icons-material/MonitorHeart';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import { getTokens } from '@/theme/contract.js';
import { useAgents } from '@/providers/AgentsProvider.jsx';
import { NAV } from '@/shell/Sidebar.jsx';
import { NAV_ITEMS } from '@/shell/AppMenu.jsx';
import { glass, stroke2, statusColor } from '@/shell/shellStyles.js';

// The phone destination list is the same catalogue views.mjs derives its route
// validation from (rail NAV first, then the More-menu overflow), deduped by id —
// no second copy of labels or route ids.
const DESTINATIONS = [];
for (const item of [...NAV, ...NAV_ITEMS]) {
  if (!DESTINATIONS.some((x) => x.v === item.v)) DESTINATIONS.push(item);
}

/**
 * Phone navigation (`down('sm')`): a header bar with the menu trigger and the
 * current view's name, plus the temporary drawer it opens. MUI's temporary
 * Drawer is a modal — it already traps focus, closes on Escape and backdrop
 * click, and restores focus to the trigger — so this only adds the rows and the
 * close-on-navigate behaviour. The tablet/desktop rail stays in `Sidebar`.
 *
 * The drawer is the phone's only nav surface, so it carries everything the rail
 * and the More menu carry between them: New session, all 15 destinations, the
 * daemon state, Processes, and (built UI only) Restart server.
 */
export default function MobileNavDrawer({
  open, setOpen, triggerRef, view, setView, onNewSession, onOpenProcesses, onOpenRestart, restarting,
}) {
  const { connected } = useAgents();
  const current = DESTINATIONS.find((d) => d.v === view);
  const go = (v) => { setView(v); setOpen(false); };
  const run = (fn) => { setOpen(false); fn(); };

  return (
    <>
      <Box
        component="header"
        sx={(t) => ({
          ...glass(t),
          position: 'relative',
          zIndex: getTokens(t).layers.nav,
          flex: 'none',
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          px: 1,
          py: 0.75,
          m: 1.5,
          mb: 0,
          borderRadius: `${getTokens(t).radius.lg}px`,
        })}
      >
        <IconButton
          ref={triggerRef}
          onClick={() => setOpen(true)}
          aria-label="Open navigation"
          aria-haspopup="dialog"
          aria-expanded={open}
        >
          <MenuIcon />
        </IconButton>
        <Typography component="h1" variant="h4" sx={{ flex: 1, minWidth: 0, lineHeight: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {current?.label || 'Singularity'}
        </Typography>
      </Box>

      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        slotProps={{ paper: { 'aria-label': 'Navigation', sx: { width: 280, maxWidth: '85vw' } } }}
      >
        <List sx={{ px: '10px', py: '6px' }}>
          <ListItemButton onClick={() => run(onNewSession)} sx={{ gap: '12px', minHeight: 44 }}>
            <ListItemIcon sx={{ minWidth: 36 }}><AddIcon /></ListItemIcon>
            <ListItemText primary="New session" sx={{ my: 0 }} slotProps={{ primary: { sx: { fontSize: 14, fontWeight: 700 } } }} />
          </ListItemButton>
          {DESTINATIONS.map((item) => (
            <ListItemButton
              key={item.v}
              selected={view === item.v}
              aria-current={view === item.v ? 'page' : undefined}
              onClick={() => go(item.v)}
              sx={{ gap: '12px', minHeight: 44 }}
            >
              <ListItemIcon sx={{ minWidth: 36 }}>{item.icon}</ListItemIcon>
              <ListItemText primary={item.label} sx={{ my: 0 }} slotProps={{ primary: { sx: { fontSize: 14 } } }} />
            </ListItemButton>
          ))}
        </List>

        <Divider sx={(t) => ({ borderColor: stroke2(t), mx: '10px' })} />

        <List sx={{ px: '10px', py: '6px' }}>
          <ListItemButton onClick={() => run(onOpenProcesses)} sx={{ gap: '12px', minHeight: 44 }}>
            <ListItemIcon sx={{ minWidth: 36 }}><MonitorHeartIcon /></ListItemIcon>
            <ListItemText primary="Processes" sx={{ my: 0 }} slotProps={{ primary: { sx: { fontSize: 14 } } }} />
          </ListItemButton>
          {/* Same PROD gate as AppMenu: in dev the daemon can't respawn itself. */}
          {import.meta.env.PROD && (
            <ListItemButton disabled={restarting} onClick={() => run(onOpenRestart)} sx={{ gap: '12px', minHeight: 44, color: 'warning.main' }}>
              <ListItemIcon sx={{ minWidth: 36, color: 'inherit' }}><RestartAltIcon /></ListItemIcon>
              <ListItemText primary="Restart server" sx={{ my: 0 }} slotProps={{ primary: { sx: { fontSize: 14 } } }} />
            </ListItemButton>
          )}
        </List>

        {/* Daemon state — the rail's DaemonFooter equivalent. Text, never colour alone. */}
        <Box
          component="footer"
          role="status"
          sx={(t) => ({
            mt: 'auto', display: 'flex', alignItems: 'center', gap: 1, px: '18px', py: '14px',
            borderTop: `1px solid ${stroke2(t)}`, fontSize: 12, color: 'text.secondary',
          })}
        >
          <Box aria-hidden sx={(t) => ({ width: 8, height: 8, borderRadius: '50%', flex: 'none', background: statusColor(t, connected ? 'ok' : 'danger') })} />
          {connected ? 'Daemon connected' : 'Daemon disconnected'}
        </Box>
      </Drawer>
    </>
  );
}
