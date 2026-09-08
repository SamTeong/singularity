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
import { NAV_CATALOG } from '@/shell/views.mjs';
import { glass, stroke2, statusColor } from '@/shell/shellStyles.js';

// The phone destination list is the same deduped catalogue views.mjs derives
// its route validation from (rail NAV first, then the More-menu overflow) —
// no second copy of the dedupe loop.
const DESTINATIONS = NAV_CATALOG;

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
      {/* `div`, not `header` (Phase 8 A8): under Phosphor, AppShell also mounts
          `PhosphorMasthead` (a real `<header>`/banner landmark) at phone
          width, so a second, unlabelled header here duplicated the banner
          landmark. This bar is the drawer's trigger + current view name, not
          a second page banner, so it loses the landmark role rather than
          gaining a redundant distinguishing label. */}
      <Box
        component="div"
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
        {/* `p`, not `h1`, for the same reason the bar above is a `div`: this is
            the drawer's current-view caption, not the page's heading. As an
            `h1` it was a second one on every route under Phosphor (whose
            masthead already renders one) and a third on the routes that own a
            heading of their own (Appearance, Wiki). Known trade-off: ZAPAC
            never had a shell-level `h1`, so the routes that own no heading of
            their own now ship none at phone width either — the same state they
            have always had at desktop and tablet. Restoring one here would put
            the duplicate back under Phosphor and on Wiki (whose page title is
            the correct `h1`, pinned at `level: 1` by e2e/wiki.spec.mjs). A real
            fix is a per-route heading pass across every view in both skins,
            deferred rather than papered over here. */}
        <Typography component="p" variant="h4" sx={{ flex: 1, minWidth: 0, lineHeight: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
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
