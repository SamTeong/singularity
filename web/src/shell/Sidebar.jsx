import { getTokens } from '@/theme/contract.js';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import Badge from '@mui/material/Badge';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import AddIcon from '@mui/icons-material/Add';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import ViewKanbanIcon from '@mui/icons-material/ViewKanban';
import ScheduleIcon from '@mui/icons-material/Schedule';
import SpeedIcon from '@mui/icons-material/Speed';
import Logo from '@/components/Logo.jsx';
import { visibleProviders, usageSummary } from '@/lib/usageUtil.js';
import { useCapabilities } from '@/hooks/useCapabilities.js';
import { useAgents } from '@/providers/AgentsProvider.jsx';
import {
  glass,
  PAPER_TOOLTIP_SLOTPROPS,
  brandGrad,
  brandGlow,
  trackColor,
  navActiveBg,
  chipBg,
  surface2,
  stroke2,
  brandOrInk,
  statusColor,
  focusRing,
} from '@/shell/shellStyles.js';

// Vertical nav rail entries (icon + label). The rail is the sidebar's primary
// navigation; the ＋ "New session" row above it opens the create dialog.
const NAV = [
  { v: 'tasks', icon: <ViewKanbanIcon />, label: 'Tasks' },
  { v: 'cron', icon: <ScheduleIcon />, label: 'Automation' },
  { v: 'usage', icon: <SpeedIcon />, label: 'Usage' },
];

// ink-2 / ink-3 from DESIGN.md map to MUI's scheme-switching text palette.
const INK2 = 'text.secondary';
const INK3 = 'text.disabled';
const INK = 'text.primary';

/**
 * App sidebar: brand mark + more-menu button, and the vertical nav rail
 * (New session · Tasks · Automation · Usage). Collapsible to an icon rail.
 * Domain state comes from {@link useAgents}; only view/collapse UI state and the
 * menu-open callback are passed in.
 */
export default function Sidebar({ collapsed, setCollapsed, view, setView, onNewSession, onOpenMenu, menuOpen }) {
  const { agents, connected, usage, refreshUsage, tasks, crons } = useAgents();
  const caps = useCapabilities();
  const usageTip = usageSummary(usage, caps); // per-provider 5h/7d summary for the collapsed tooltip
  const counts = { tasks: tasks.length, cron: crons.length };

  return (
    <Box
      component="aside"
      sx={(t) => {
        const g = glass(t);
        return {
          ...g,
          // layout-02 `.bg-fallback`'s glow-1 (16% 8%), scoped to the rail itself
          // rather than the global AmbientBackground: strongest behind the brand
          // mark / "New session" pill, fading to the flat glass surface by the
          // nav rows below (mock's warm top bloom on `.side`).
          background: `radial-gradient(120% 46% at 26% 0%, ${brandGlow(t)}, transparent 68%), ${g.background}`,
          position: 'relative',
          zIndex: getTokens(t).layers.nav,
          width: collapsed ? 64 : 300, // layout-02 `.side` width
          flexShrink: 0,
          mt: 1.5,
          ml: 1.5,
          borderRadius: `${getTokens(t).radius.lg}px`,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          transition: 'width .2s ease',
          '@media (prefers-reduced-motion: reduce)': { transition: 'none' },
        };
      }}
    >
      {/* Header: logo (+ title when expanded) + more menu (nav overflow, processes, dark mode). */}
      <Stack direction={collapsed ? 'column' : 'row'} spacing={1.5} sx={{ p: '18px', pb: '14px', alignItems: 'center', justifyContent: collapsed ? 'center' : 'flex-start' }}>
        <Tooltip title={connected ? '' : 'disconnected'} placement="bottom" disableInteractive slotProps={PAPER_TOOLTIP_SLOTPROPS}>
          <Badge variant="dot" color="error" overlap="circular" anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }} invisible={connected}>
            {/* layout-02 `.brand-mark`: the identity gradient as a rounded tile with
                a soft bloom, glyph flattened to white on top of it. */}
            <Box
              sx={(t) => ({
                width: 36,
                height: 36,
                flexShrink: 0,
                borderRadius: '10px',
                background: brandGrad(t),
                display: 'grid',
                placeItems: 'center',
                boxShadow: `0 8px 22px -8px ${brandGlow(t)}`,
              })}
            >
              <Logo onBrand active={agents.some((a) => a.status === 'running' || a.status === 'starting')} />
            </Box>
          </Badge>
        </Tooltip>
        {!collapsed && (
          <>
            {/* layout-02 `.brand-name`: font-family: var(--font-display) — h4 is the
                theme's "brand name / section heading" variant (16px/700/-.01em). */}
            <Typography component="span" variant="h4" sx={{ flex: 1, lineHeight: 1 }}>Singularity</Typography>
            <Tooltip title="More" placement="bottom" disableInteractive slotProps={PAPER_TOOLTIP_SLOTPROPS}>
              <IconButton onClick={onOpenMenu} size="small" aria-label="More" aria-haspopup="menu" aria-expanded={menuOpen}><MoreVertIcon /></IconButton>
            </Tooltip>
          </>
        )}
        {collapsed && (
          <Tooltip title="More" placement="right" disableInteractive slotProps={PAPER_TOOLTIP_SLOTPROPS}>
            <IconButton onClick={onOpenMenu} size="small" aria-label="More" aria-haspopup="menu" aria-expanded={menuOpen}><MoreVertIcon /></IconButton>
          </Tooltip>
        )}
      </Stack>

      {/* Vertical nav rail: ＋ New session, then Tasks / Automation / Usage. Icon-only when collapsed. */}
      {/* layout-02 `.nav`: 6px/10px padding, 3px between rows. */}
      <List sx={{ px: '10px', py: '6px' }}>
        {/* Tooltips only when collapsed — expanded rows show their label already. */}
        <Tooltip title={collapsed ? 'New session' : ''} placement="right" disableInteractive slotProps={PAPER_TOOLTIP_SLOTPROPS}>
          <ListItemButton
            onClick={onNewSession}
            sx={(t) => ({
              display: 'flex',
              alignItems: 'center',
              gap: '12px',
              justifyContent: collapsed ? 'center' : 'flex-start',
              minHeight: 44,
              borderRadius: `${getTokens(t).radius.sm}px`,
              mb: '5px', // `.nav-new` sits 5px clear of the nav items below it
              pl: collapsed ? 0 : '14px',
              pr: collapsed ? 0 : '14px',
              py: '11px',
              background: chipBg(t),
              border: `1px solid ${stroke2(t)}`,
              color: INK,
              fontWeight: 700,
              fontSize: 14,
              transition: 'border-color .18s ease, background .18s ease',
              '&:hover': {
                borderColor: t.vars.palette.primary.main,
                background: `color-mix(in srgb, ${t.vars.palette.primary.main} 12%, ${chipBg(t)})`,
              },
              '&:focus-visible': focusRing(t),
            })}
          >
            <ListItemIcon sx={(t) => ({ minWidth: collapsed ? 0 : 36, justifyContent: 'center', color: brandOrInk(t) })}><AddIcon /></ListItemIcon>
            {!collapsed && <ListItemText primary="New session" slotProps={{ primary: { sx: { fontSize: 14, fontWeight: 700 } } }} />}
          </ListItemButton>
        </Tooltip>
        {NAV.map((item) => {
          const isUsage = item.v === 'usage';
          const tooltipLabel = isUsage && usageTip ? usageTip : item.label;
          const count = counts[item.v];
          return (
            <Tooltip key={item.v} title={collapsed ? tooltipLabel : ''} placement="right" disableInteractive slotProps={PAPER_TOOLTIP_SLOTPROPS}>
              <ListItemButton
                selected={view === item.v}
                onClick={() => {
                  if (view === item.v) { setCollapsed((c) => !c); return; }
                  setView(item.v);
                  if (isUsage) refreshUsage(true);
                }}
                sx={(t) => ({
                  display: 'flex',
                  alignItems: 'center',
                  gap: '13px',
                  justifyContent: collapsed ? 'center' : 'flex-start',
                  minHeight: 44,
                  borderRadius: `${getTokens(t).radius.sm}px`,
                  mb: '3px', // `.nav` row gap
                  pl: collapsed ? 0 : '14px',
                  pr: collapsed ? 0 : '14px',
                  py: '11px',
                  position: 'relative',
                  color: INK2,
                  fontWeight: 400,
                  fontSize: 14,
                  transition: 'background .18s ease, color .18s ease',
                  '&:hover': { background: surface2(t), color: INK },
                  '&.Mui-selected': {
                    background: navActiveBg(t),
                    color: INK,
                    fontWeight: 700,
                    boxShadow: getTokens(t).glass.cardShadow,
                    '&:hover': { background: navActiveBg(t) },
                  },
                  // 4px gradient left-edge marker — the ONE sanctioned active indicator (DESIGN §6).
                  '&.Mui-selected::before': {
                    content: '""',
                    position: 'absolute',
                    left: 0,
                    top: '9px',
                    bottom: '9px',
                    width: '4px',
                    borderRadius: '0 4px 4px 0',
                    background: brandGrad(t),
                  },
                  '&:focus-visible': focusRing(t),
                })}
              >
                <ListItemIcon sx={{ minWidth: collapsed ? 0 : 36, justifyContent: 'center', color: 'inherit', opacity: 0.85 }}>{item.icon}</ListItemIcon>
                {!collapsed && <ListItemText primary={item.label} slotProps={{ primary: { sx: { fontSize: 14, fontWeight: 'inherit' } } }} />}
                {!collapsed && count != null && (
                  <Typography
                    component="span"
                    sx={(t) => ({
                      ml: 'auto',
                      fontSize: 11,
                      fontWeight: 700,
                      letterSpacing: '.02em',
                      color: INK3,
                      background: chipBg(t),
                      px: '9px',
                      py: '2px',
                      borderRadius: `${getTokens(t).radius.pill ?? 999}px`,
                      '.Mui-selected &': { color: brandOrInk(t) },
                    })}
                  >
                    {count}
                  </Typography>
                )}
              </ListItemButton>
            </Tooltip>
          );
        })}
      </List>

      <Box sx={{ flex: 1 }} />

      {/* "Usage · 5h window" mini-bar panel — only in the expanded rail. */}
      {!collapsed && <UsagePanel usage={usage} caps={caps} />}

      {/* Daemon-status footer — always visible (replaces the conditional StatusPill). */}
      <DaemonFooter connected={connected} />
    </Box>
  );
}

/**
 * Sidebar usage panel (layout-02 `.usage`): a recessed glass tile with a labelled
 * mini-bar + percentage per provider, wired to the live `useAgents.usage` shape.
 * Renders a muted placeholder row when no data has loaded yet.
 */
function UsagePanel({ usage, caps }) {
  const rows = visibleProviders(caps).map((p) => {
    const u = usage?.[p.key];
    const pct = u?.ok && u.session?.pctUsed != null ? Math.round(u.session.pctUsed) : null;
    return { key: p.key, label: p.label, pct };
  });
  const hasData = rows.some((r) => r.pct != null);
  return (
    <Box
      sx={(t) => ({
        mx: 1.5,
        mb: 1.5,
        p: '14px',
        borderRadius: `${getTokens(t).radius.md}px`,
        background: surface2(t),
        border: `1px solid ${stroke2(t)}`,
      })}
    >
      <Typography sx={{ fontSize: 11, fontWeight: 700, letterSpacing: '.14em', textTransform: 'uppercase', color: INK3, mb: '11px' }}>
        Usage · 5h window
      </Typography>
      {!hasData ? (
        <Typography sx={{ fontSize: 12, color: INK3 }}>No usage yet</Typography>
      ) : (
        <Stack spacing="10px">
          {rows.map((r) => (
            <Stack key={r.key} direction="row" spacing="10px" sx={{ alignItems: 'center' }}>
              <Typography sx={{ fontSize: 12, color: INK2, width: '52px', flex: 'none' }}>{r.label}</Typography>
              <Box
                sx={(t) => ({
                  flex: 1,
                  height: '6px',
                  borderRadius: `${getTokens(t).radius.pill ?? 999}px`,
                  background: trackColor(t),
                  overflow: 'hidden',
                })}
              >
                <Box
                  sx={(t) => ({
                    display: 'block',
                    height: '100%',
                    width: `${r.pct ?? 0}%`,
                    borderRadius: `${getTokens(t).radius.pill ?? 999}px`,
                    background: brandGrad(t),
                  })}
                />
              </Box>
              <Typography sx={{ fontSize: 11, fontWeight: 700, color: INK3, width: '34px', textAlign: 'right', flex: 'none' }}>
                {r.pct == null ? '—' : `${r.pct}%`}
              </Typography>
            </Stack>
          ))}
        </Stack>
      )}
    </Box>
  );
}

/**
 * Daemon-status footer (layout-02 `.side-foot`): a connection dot + label + the
 * loopback address the client reaches the daemon/WS through (`location.host`).
 * Always visible — reflects the live `useAgents.connected` state.
 */
function DaemonFooter({ connected }) {
  const host = typeof location !== 'undefined' ? location.host : '127.0.0.1:4317';
  return (
    <Box
      component="footer"
      sx={(t) => ({
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        pt: '13px',
        pb: '13px',
        px: '18px',
        borderTop: `1px solid ${stroke2(t)}`,
      })}
    >
      <Box
        aria-hidden
        sx={(t) => {
          const kind = connected ? 'ok' : 'danger';
          const c = statusColor(t, kind);
          return {
            width: '8px',
            height: '8px',
            borderRadius: '50%',
            background: c,
            flex: 'none',
            boxShadow: `0 0 0 3px color-mix(in srgb, ${c} 22%, transparent)`,
          };
        }}
      />
      <Box sx={{ lineHeight: 1.25 }}>
        <Typography component="div" sx={{ fontSize: 12, fontWeight: 700, color: INK2, lineHeight: 1.25 }}>
          {connected ? 'Daemon connected' : 'Daemon disconnected'}
        </Typography>
        <Typography component="small" variant="code" sx={{ display: 'block', fontSize: 11, fontWeight: 400, color: INK3, lineHeight: 1.25 }}>
          {host}
        </Typography>
      </Box>
    </Box>
  );
}