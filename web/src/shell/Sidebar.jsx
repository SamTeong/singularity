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
import { ProviderRow } from '@/features/usage/UsagePill.jsx';
import { visibleProviders, usageSummary } from '@/lib/usageUtil.js';
import { useCapabilities } from '@/hooks/useCapabilities.js';
import { StatusPill } from '@zapac/mui-theme';
import { useAgents } from '@/providers/AgentsProvider.jsx';
import { glass, PAPER_TOOLTIP_SLOTPROPS } from '@/shell/shellStyles.js';

// Vertical nav rail entries (icon + label). The rail is the sidebar's primary
// navigation; the ＋ "New agent" row above it opens the create dialog.
const NAV = [
  { v: 'tasks', icon: <ViewKanbanIcon />, label: 'Tasks' },
  { v: 'cron', icon: <ScheduleIcon />, label: 'Automation' },
  { v: 'usage', icon: <SpeedIcon />, label: 'Usage' },
];

/**
 * App sidebar: brand mark + more-menu button, and the vertical nav rail
 * (New session · Tasks · Automation · Usage). Collapsible to an icon rail.
 * Domain state comes from {@link useAgents}; only view/collapse UI state and the
 * menu-open callback are passed in.
 */
export default function Sidebar({ collapsed, setCollapsed, view, setView, onNewSession, onOpenMenu }) {
  const { agents, connected, usage, refreshUsage } = useAgents();
  const caps = useCapabilities();
  const usageTip = usageSummary(usage, caps); // per-provider 5h/7d summary for the collapsed tooltip

  return (
    <Box
      component="aside"
      sx={(t) => ({
        ...glass(t),
        position: 'relative',
        zIndex: t.zapac.layers.nav,
        width: collapsed ? 64 : 320,
        flexShrink: 0,
        mt: 1.5,
        ml: 1.5,
        borderRadius: `${t.zapac.radius.lg}px`,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        transition: 'width .2s ease',
      })}
    >
      {/* Header: logo (+ title when expanded) + more menu (nav overflow, processes, dark mode). */}
      <Stack direction={collapsed ? 'column' : 'row'} spacing={1.25} sx={{ p: 2, pb: 1.5, alignItems: 'center', justifyContent: collapsed ? 'center' : 'flex-start' }}>
        <Tooltip title={connected ? '' : 'disconnected'} placement="bottom" disableInteractive slotProps={PAPER_TOOLTIP_SLOTPROPS}>
          <Badge variant="dot" color="error" overlap="circular" anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }} invisible={connected}>
            <Logo active={agents.some((a) => a.status === 'running' || a.status === 'starting')} />
          </Badge>
        </Tooltip>
        {!collapsed && (
          <>
            <Typography component="span" sx={{ flex: 1, fontSize: 16, fontWeight: 700, lineHeight: 1, letterSpacing: '-0.01em' }}>Singularity</Typography>
            <Tooltip title="More" placement="bottom" disableInteractive slotProps={PAPER_TOOLTIP_SLOTPROPS}>
              <IconButton onClick={onOpenMenu} size="small"><MoreVertIcon /></IconButton>
            </Tooltip>
          </>
        )}
        {collapsed && (
          <Tooltip title="More" placement="right" disableInteractive slotProps={PAPER_TOOLTIP_SLOTPROPS}>
            <IconButton onClick={onOpenMenu} size="small"><MoreVertIcon /></IconButton>
          </Tooltip>
        )}
      </Stack>

      {/* Vertical nav rail: ＋ New agent, then Tasks / Cron / Usage. Icon-only when collapsed. */}
      <List sx={{ px: 1, pb: 1 }}>
        {/* Tooltips only when collapsed — expanded rows show their label already. */}
        <Tooltip title={collapsed ? 'New session' : ''} placement="right" disableInteractive slotProps={PAPER_TOOLTIP_SLOTPROPS}>
          <ListItemButton
            onClick={onNewSession}
            sx={{ justifyContent: collapsed ? 'center' : 'flex-start', minHeight: 44, borderRadius: (t) => `${t.zapac.radius.sm}px`, mb: 0.5 }}
          >
            <ListItemIcon sx={{ minWidth: collapsed ? 0 : 36, justifyContent: 'center' }}><AddIcon /></ListItemIcon>
            {!collapsed && <ListItemText primary="New session" />}
          </ListItemButton>
        </Tooltip>
        {NAV.map((item) => {
          const isUsage = item.v === 'usage';
          const tooltipLabel = isUsage && usageTip ? usageTip : item.label;
          return (
            <Tooltip key={item.v} title={collapsed ? tooltipLabel : ''} placement="right" disableInteractive slotProps={PAPER_TOOLTIP_SLOTPROPS}>
              <ListItemButton
                selected={view === item.v}
                onClick={() => {
                  if (view === item.v) { setCollapsed((c) => !c); return; }
                  setView(item.v);
                  if (isUsage) refreshUsage(true);
                }}
                sx={{ justifyContent: collapsed ? 'center' : 'flex-start', alignItems: collapsed || !isUsage ? 'center' : 'flex-start', minHeight: 44, borderRadius: (t) => `${t.zapac.radius.sm}px`, mb: 0.5 }}
              >
                <ListItemIcon sx={{ minWidth: collapsed ? 0 : 36, justifyContent: 'center', mt: collapsed || !isUsage ? 0 : '2px' }}>{item.icon}</ListItemIcon>
                {!collapsed && (
                  <ListItemText
                    primary={item.label}
                    secondary={isUsage ? (
                      <Stack spacing={0.75} sx={{ mt: 0.75 }}>
                        {visibleProviders(caps).map((p) => <ProviderRow key={p.key} label={p.label} u={usage?.[p.key]} />)}
                      </Stack>
                    ) : null}
                    slotProps={isUsage ? { secondary: { component: 'div' } } : undefined}
                  />
                )}
              </ListItemButton>
            </Tooltip>
          );
        })}
      </List>

      {!collapsed && !connected && (
        <Box sx={{ px: 2, pb: 1 }}>
          <StatusPill status="error">disconnected</StatusPill>
        </Box>
      )}

      <Box sx={{ flex: 1 }} />
    </Box>
  );
}
