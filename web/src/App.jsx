import React, { useEffect, useRef, useState, useCallback, useMemo, Suspense, lazy } from 'react';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import Badge from '@mui/material/Badge';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Divider from '@mui/material/Divider';
import Switch from '@mui/material/Switch';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import Snackbar from '@mui/material/Snackbar';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Button from '@mui/material/Button';
import AddIcon from '@mui/icons-material/Add';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import CallSplitIcon from '@mui/icons-material/CallSplit';
import CloseIcon from '@mui/icons-material/Close';
import LinkIcon from '@mui/icons-material/Link';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import TerminalIcon from '@mui/icons-material/Terminal';
import SmartToyIcon from '@mui/icons-material/SmartToy';
import MonitorHeartIcon from '@mui/icons-material/MonitorHeart';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import SettingsIcon from '@mui/icons-material/Settings';
import WebhookIcon from '@mui/icons-material/Webhook';
import GavelIcon from '@mui/icons-material/Gavel';
import BookIcon from '@mui/icons-material/Book';
import MenuBookIcon from '@mui/icons-material/MenuBook';
import SchoolIcon from '@mui/icons-material/School';
import HistoryIcon from '@mui/icons-material/History';
import SpeedIcon from '@mui/icons-material/Speed';
import ViewKanbanIcon from '@mui/icons-material/ViewKanban';
import DarkModeIcon from '@mui/icons-material/DarkMode';
import LightModeIcon from '@mui/icons-material/LightMode';
import ScheduleIcon from '@mui/icons-material/Schedule';
import { useTheme } from '@mui/material/styles';
import { AmbientBackground, useColorMode, StatusPill, EmptyState } from '@zapac/mui-theme';
import Terminal from './Terminal.jsx';
import DirPicker from './DirPicker.jsx';
import { setHome, tildify } from './paths.js';
import { fmtTokens } from './format.js';
import { KIND } from './agentStatus.js';
import ProcessManager from './ProcessManager.jsx';
import CreateAgentDialog from './CreateAgentDialog.jsx';
import CreateTaskDialog from './CreateTaskDialog.jsx';
import CreateCronDialog from './CreateCronDialog.jsx';
import { ProviderRow } from './UsagePill.jsx';
import { PROVIDERS, usageSummary } from './usageUtil.js';
import { useResizable, ResizeHandle } from './useResizable.jsx';

// Lazy: these carry CodeMirror (the biggest non-xterm dep) or only render off the
// terminal view — split them out of the initial (terminal) bundle.
const ConfigEditor = lazy(() => import('./ConfigEditor.jsx'));
const HooksEditor = lazy(() => import('./HooksEditor.jsx'));
const RulesPanel = lazy(() => import('./RulesPanel.jsx'));
const MemoryPanel = lazy(() => import('./MemoryPanel.jsx'));
const SessionHistory = lazy(() => import('./SessionHistory.jsx'));
const WikiPanel = lazy(() => import('./WikiPanel.jsx'));
const SkillsPanel = lazy(() => import('./SkillsPanel.jsx'));
const UsageView = lazy(() => import('./UsageView.jsx'));
const TasksBoard = lazy(() => import('./TasksBoard.jsx'));
const CronJobs = lazy(() => import('./CronJobs.jsx'));

const WS_URL = `ws://${location.host}/ws${window.__SING_TOKEN__ ? `?token=${encodeURIComponent(window.__SING_TOKEN__)}` : ''}`;

// Vertical nav rail entries (icon + label). The rail is the sidebar's primary
// navigation; the ＋ "New agent" row above it opens the create dialog.
const NAV = [
  { v: 'tasks', icon: <ViewKanbanIcon />, label: 'Tasks' },
  { v: 'cron', icon: <ScheduleIcon />, label: 'Automation' },
  { v: 'usage', icon: <SpeedIcon />, label: 'Usage' },
];
// Use theme.vars (the --mui-* CSS vars) not theme.palette — under cssVariables
// theme.palette holds only the default (light) scheme's literals and won't switch
// with the .dark class; theme.vars is the scheme-switching reference.
const glass = (t) => ({
  background: t.vars.palette.glass.surface,
  backdropFilter: `blur(${t.vars.palette.glass.blur})`,
  border: `1px solid ${t.vars.palette.glass.stroke}`,
  // cardShadow + a crisp 1px top-edge sheen — the canonical glass recipe's
  // highlight (DESIGN §4), as an inset shadow so it clips to the radius and
  // never fights child stacking.
  boxShadow: `${t.vars.palette.glass.cardShadow}, inset 0 1px 0 rgba(255,255,255,0.18)`,
});

// Hub-and-spoke brand mark: one gradient daemon hub, six radiating agent nodes.
// Spokes/nodes take a theme-following neutral; the gradient is reserved to the
// hub (identity). `active` pulses a radar-ping halo when any agent is running.
const LOGO_NODES = [-90, -30, 30, 90, 150, 210].map((a) => {
  const r = (a * Math.PI) / 180;
  return [+(16 + 11 * Math.cos(r)).toFixed(2), +(16 + 11 * Math.sin(r)).toFixed(2)];
});

function Logo({ active }) {
  const t = useTheme();
  const line = t.vars.palette.text.secondary;
  const nodeFill = t.vars.palette.background.default;
  return (
    <Box
      component="svg"
      viewBox="0 0 32 32"
      role="img"
      aria-label="Singularity"
      sx={{ width: 30, height: 30, flexShrink: 0, filter: 'drop-shadow(0 0 5px rgba(152,91,156,0.55))' }}
    >
      <defs>
        <linearGradient id="sing-grad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#aa41af" />
          <stop offset="55%" stopColor="#3c69c8" />
          <stop offset="100%" stopColor="#00a5e6" />
        </linearGradient>
      </defs>
      {LOGO_NODES.map(([x, y], i) => (
        <line key={`s${i}`} x1="16" y1="16" x2={x} y2={y} stroke={line} strokeWidth="1.2" strokeLinecap="round" />
      ))}
      {active && (
        <Box
          component="circle"
          cx="16" cy="16" r="3" fill="url(#sing-grad)"
          sx={{
            transformBox: 'fill-box', transformOrigin: 'center',
            animation: 'sing-ping 2s cubic-bezier(0,0,0.2,1) infinite',
            '@keyframes sing-ping': { '0%': { transform: 'scale(1)', opacity: 0.5 }, '70%,100%': { transform: 'scale(2.6)', opacity: 0 } },
            '@media (prefers-reduced-motion: reduce)': { animation: 'none', opacity: 0 },
          }}
        />
      )}
      <circle cx="16" cy="16" r="5.2" fill="none" stroke="url(#sing-grad)" strokeWidth="1.4" />
      <circle cx="16" cy="16" r="3" fill="url(#sing-grad)" />
      {LOGO_NODES.map(([x, y], i) => (
        <circle key={`n${i}`} cx={x} cy={y} r="2.4" fill={nodeFill} stroke={line} strokeWidth="1.3" />
      ))}
    </Box>
  );
}

// Paper-surface tooltip styling, shared across the nav rail + collapsed list.
const PAPER_TOOLTIP_SLOTPROPS = {
  tooltip: {
    sx: {
      bgcolor: 'var(--mui-palette-background-paper) !important',
      color: 'var(--mui-palette-text-primary) !important',
      border: '1px solid var(--mui-palette-divider) !important',
      backdropFilter: 'blur(8px)',
      whiteSpace: 'pre-line', // multi-line titles (usage summary) break on \n
    },
  },
};

export default function App() {
  const [agents, setAgents] = useState([]);
  const [active, setActive] = useState(null);
  const [connected, setConnected] = useState(false);
  const [recent, setRecent] = useState([]);
  const [cwd, setCwd] = useState('C:\\git\\singularity');
  const [picking, setPicking] = useState(false);
  const [procsOpen, setProcsOpen] = useState(false);
  const [menuAnchor, setMenuAnchor] = useState(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [tasks, setTasks] = useState([]);
  const [taskHistory, setTaskHistory] = useState([]);
  const [taskOpen, setTaskOpen] = useState(false);
  const [crons, setCrons] = useState([]);
  const [cronOpen, setCronOpen] = useState(false);
  const [background, setBackground] = useState(null); // { config, lastTick, liveTaskId }
  // Terminal dock minimized state, persisted (height is a useResizable below).
  const [dockMin, setDockMin] = useState(() => localStorage.getItem('sing-dock-min') === '1');
  // Session-list panel width (px, drag-resizable), persisted.
  const listW = useResizable('sing-list-w', 260, { min: 160, max: 640 });
  const mainRef = useRef(null);
  // Terminal dock height (px, drag-resizable), persisted — resizes up from the
  // main pane's bottom, clamped so neither the dock nor the top view can vanish.
  const { width: dockH, startDrag: startDockDrag } = useResizable('sing-dock-h', 300, { min: 140, max: 2000, axis: 'y', containerRef: mainRef });
  const [collapsed, setCollapsed] = useState(false);
  const [view, setView] = useState('tasks');
  const visited = useRef({}); // view -> ever selected, so lazy panels mount once and stay mounted
  if (view === 'config' || view === 'hooks' || view === 'rules' || view === 'memory' || view === 'wiki' || view === 'sessions') visited.current[view] = true;
  const { resolved, toggle: toggleColorMode } = useColorMode();
  const [toast, setToast] = useState(null);
  const [respawnCount, setRespawnCount] = useState(0); // >0 -> respawn-confirm dialog open, holds live-session count
  const [restartOpen, setRestartOpen] = useState(false); // restart-daemon confirm dialog
  const [restarting, setRestarting] = useState(false); // true while polling /health for the new daemon
  const [stats, setStats] = useState({}); // id -> {turns, tokens}
  const [subagents, setSubagents] = useState({}); // agentId -> [{agentId, title, running, mtime}]
  const [usage, setUsage] = useState(null); // { ollama, claude } from /usage
  const [dragId, setDragId] = useState(null); // id of the agent row being dragged
  const wsRef = useRef(null);
  const termHandlers = useRef({}); // id -> { write(data), reset() }
  const chatHandler = useRef(null); // session-history chat -> {t:'chat:*', ...}

  // WS with auto-reconnect (exponential backoff, 0.5s → 8s). On reconnect the
  // fresh socket has no attachments — re-attach every mounted terminal, each
  // reset first so the scrollback replay doesn't duplicate content.
  useEffect(() => {
    let ws, timer, unmounted = false, delay = 500;
    const connect = () => {
      ws = new WebSocket(WS_URL);
      wsRef.current = ws;
      ws.onopen = () => {
        setConnected(true);
        delay = 500;
        for (const [id, h] of Object.entries(termHandlers.current)) {
          h.reset();
          ws.send(JSON.stringify({ t: 'attach', id }));
        }
      };
      ws.onclose = () => {
        setConnected(false);
        if (!unmounted) { timer = setTimeout(connect, delay); delay = Math.min(delay * 2, 8000); }
      };
      ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.t === 'list') {
          setAgents(m.agents);
          if (m.recentRepos) setRecent(m.recentRepos);
          setActive((cur) => (cur && m.agents.some((a) => a.id === cur) ? cur : m.agents[0]?.id ?? null));
        } else if (m.t === 'status') {
          setAgents((as) => as.map((a) => (a.id === m.id ? { ...a, status: m.status } : a)));
        } else if (m.t === 'output') {
          termHandlers.current[m.id]?.write(m.data);
        } else if (m.t === 'attached') {
          setActive(m.id);
        } else if (m.t === 'usage') {
          setUsage(m.data);
        } else if (m.t === 'tasks') {
          setTasks(m.tasks);
          setTaskHistory(m.history || []);
        } else if (m.t === 'crons') {
          setCrons(m.crons);
        } else if (m.t === 'background') {
          setBackground({ config: m.config, lastTick: m.lastTick, liveTaskId: m.liveTaskId });
        } else if (m.t === 'chat:delta' || m.t === 'chat:done' || m.t === 'chat:error') {
          chatHandler.current?.(m);
        } else if (m.t === 'error') {
          setToast(m.msg);
        }
      };
    };
    connect();
    return () => { unmounted = true; clearTimeout(timer); ws.close(); };
  }, []);

  // Home dir, for tildify() to collapse full paths to `~` on display.
  useEffect(() => { fetch('/env').then((r) => r.json()).then((d) => setHome(d.home)).catch(() => {}); }, []);

  const sendMsg = useCallback((msg) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }, []);

  // Copy/Fork target name: strip a trailing _N from the source, pick the lowest
  // free _N across existing session names. Unnamed source (name == id prefix) → blank.
  const nextName = (a) => {
    if (a.name === a.id.slice(0, 8)) return '';
    const base = a.name.replace(/_\d+$/, '');
    const taken = new Set(agents.map((x) => x.name));
    let n = 2; while (taken.has(`${base}_${n}`)) n++;
    return `${base}_${n}`;
  };

  // Drag-and-drop reorder: optimistically move dragId onto overId's slot,
  // then tell the server to persist the new order (it re-emits 'list').
  const dropAgent = (overId) => {
    if (!dragId || dragId === overId) { setDragId(null); return; }
    const ids = agents.map((a) => a.id);
    const from = ids.indexOf(dragId);
    const to = ids.indexOf(overId);
    if (from < 0 || to < 0) { setDragId(null); return; }
    ids.splice(from, 1);
    ids.splice(to, 0, dragId);
    setAgents(ids.map((id) => agents.find((a) => a.id === id)));
    sendMsg({ t: 'reorder', ids });
    setDragId(null);
  };

  // Task board actions. Moves/deletes go over REST; the server re-emits
  // 'tasks' on the WS so state converges from there.
  const moveTask = (id, column) => {
    fetch(`/tasks/${id}/status`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ column }) })
      .then((r) => r.json()).then((d) => { if (!d.ok) setToast(d.error); }).catch((e) => setToast(e.message));
  };
  const concludeTask = (id, outcome) => {
    fetch(`/tasks/${id}/conclude`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ outcome }) })
      .then((r) => r.json()).then((d) => { if (!d.ok) setToast(d.error); }).catch((e) => setToast(e.message));
  };
  const deleteHistory = (id) => {
    fetch(`/tasks/history/${id}`, { method: 'DELETE' })
      .then((r) => r.json()).then((d) => { if (!d.ok) setToast(d.error); }).catch((e) => setToast(e.message));
  };

  const toggleDock = () => setDockMin((m) => { const n = !m; localStorage.setItem('sing-dock-min', n ? '1' : '0'); return n; });

  // Poll per-agent stats (turns/tokens from each session .jsonl).
  const agentKey = agents.map((a) => a.id).join(',');
  useEffect(() => {
    if (!connected) return undefined;
    const pull = () => fetch('/agent-stats').then((r) => r.json()).then((d) => setStats(d.stats || {})).catch(() => {});
    pull();
    const t = setInterval(pull, 8000);
    return () => clearInterval(t);
  }, [connected, agentKey]);

  // Poll live subagents — indicator-only rows nested under the dock agent row.
  // Server scopes this to live agents, so it stays cheap (no full-history scan).
  useEffect(() => {
    if (!connected) return undefined;
    const pull = () => fetch('/subagents').then((r) => r.json()).then((d) => setSubagents(d.subagents || {})).catch(() => {});
    pull();
    const t = setInterval(pull, 5000);
    return () => clearInterval(t);
  }, [connected, agentKey]);

  // Usage (Ollama Cloud + Claude 5h/7d). On-demand only — no interval poll.
  // Server caches ~60s so repeated opens are cheap; force=1 bypasses.
  const refreshUsage = useCallback((force = false) => {
    fetch(`/usage${force ? '?force=1' : ''}`).then((r) => r.json()).then(setUsage).catch(() => {});
  }, []);

  // On-demand: fetch once the socket is up (app opened / reconnected). The
  // backend pushes 'usage' updates on its own auto-refresh from here on.
  useEffect(() => { if (connected) refreshUsage(false); }, [connected, refreshUsage]);

  // Background snapshot: initial load on connect; live updates arrive over the WS.
  useEffect(() => {
    if (!connected) return;
    fetch('/background').then((r) => r.json()).then(setBackground).catch(() => {});
  }, [connected]);

  // Distinct tags across live tasks + history — options for the task tags input.
  const tagOptions = useMemo(() => {
    const s = new Set();
    for (const t of tasks) (t.tags || []).forEach((x) => s.add(x));
    for (const h of taskHistory) (h.tags || []).forEach((x) => s.add(x));
    return [...s].sort();
  }, [tasks, taskHistory]);

  const activeAgent = agents.find((a) => a.id === active);

  // Cap live terminals: each mounted xterm holds a full scrollback buffer, so
  // mounting every agent's terminal grows memory without bound. Keep the active
  // agent + the most-recently-viewed few mounted (instant switch); the daemon
  // replays scrollback on re-attach for the rest.
  // ponytail: MRU list, bump the cap if switching to an evicted agent feels slow.
  const MOUNT_LRU = 4;
  const mruRef = useRef([]);
  if (active && mruRef.current[0] !== active) {
    mruRef.current = [active, ...mruRef.current.filter((id) => id !== active)];
  }
  const mountedSet = new Set(mruRef.current.slice(0, MOUNT_LRU));
  const usageTip = usageSummary(usage); // per-provider 5h/7d summary for the collapsed tooltip

  // A running claude process picks its TUI theme once at spawn (queried from
  // the terminal background) — xterm's palette flips live but a live session's
  // colors won't until it's respawned. Offer that after every theme toggle.
  const onToggleTheme = () => {
    toggleColorMode();
    const live = agents.filter((a) => a.status === 'running' || a.status === 'idle' || a.status === 'starting').length;
    if (live) setRespawnCount(live);
  };

  // Alt+Up/Down cycles sessions (dir -1/+1), wrapping. Detached ones excluded.
  const cycleSession = (dir) => {
    const list = agents.filter((a) => a.status !== 'detached');
    if (list.length < 2) return;
    const i = list.findIndex((a) => a.id === active);
    setActive(list[(i + dir + list.length) % list.length].id);
  };

  // Restart the daemon: it respawns itself detached and exits, so the socket
  // drops. Poll /health until a new pid answers, then reload the shell.
  const doRestart = async () => {
    setRestartOpen(false);
    setRestarting(true);
    setToast('Restarting server…');
    const before = await fetch('/health').then((r) => r.json()).then((d) => d.pid).catch(() => null);
    await fetch('/restart', { method: 'POST' }).catch(() => {}); // connection drops; ignore
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 800));
      try {
        const d = await fetch('/health').then((r) => r.json());
        if (d.ok && d.pid !== before) { location.reload(); return; }
      } catch {} // expected while the daemon is down
    }
    setRestarting(false);
    setToast('Server did not come back — restart it manually.');
  };

  return (
    <Box ref={mainRef} sx={{ position: 'relative', height: '100dvh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <AmbientBackground />

      {/* Top row: sidebar + selected view. The terminal dock spans full width below. */}
      <Box sx={{ flex: 1, minHeight: 0, display: 'flex' }}>

      {/* Sidebar */}
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
                <IconButton onClick={(e) => setMenuAnchor(e.currentTarget)} size="small"><MoreVertIcon /></IconButton>
              </Tooltip>
            </>
          )}
          {collapsed && (
            <Tooltip title="More" placement="right" disableInteractive slotProps={PAPER_TOOLTIP_SLOTPROPS}>
              <IconButton onClick={(e) => setMenuAnchor(e.currentTarget)} size="small"><MoreVertIcon /></IconButton>
            </Tooltip>
          )}
        </Stack>

        {/* Vertical nav rail: ＋ New agent, then Tasks / Cron / Usage. Icon-only when collapsed. */}
        <List sx={{ px: 1, pb: 1 }}>
          {/* Tooltips only when collapsed — expanded rows show their label already. */}
          <Tooltip title={collapsed ? 'New session' : ''} placement="right" disableInteractive slotProps={PAPER_TOOLTIP_SLOTPROPS}>
            <ListItemButton
              onClick={() => setCreateOpen(true)}
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
                          {PROVIDERS.map((p) => <ProviderRow key={p.key} label={p.label} u={usage?.[p.key]} />)}
                        </Stack>
                      ) : null}
                      secondaryTypographyProps={isUsage ? { component: 'div' } : undefined}
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

        {/* Selected view. Config/Memory mount once (visited) and stay mounted
            across switches (display:none when hidden) so live CodeMirror +
            unsaved edits survive; Tasks/Cron/Usage render on demand. */}
        <Box sx={(t) => ({ ...glass(t), position: 'relative', flex: 1, mt: 1.5, mx: 1.5, minWidth: 0, borderRadius: `${t.zapac.radius.lg}px`, overflow: 'hidden', zIndex: t.zapac.layers.content })}>
          <Suspense fallback={<Box sx={{ p: 3, color: 'text.secondary' }}>Loading…</Box>}>
            {visited.current.config && (
              <Box sx={{ display: view === 'config' ? 'block' : 'none', height: '100%' }}>
                <ConfigEditor />
              </Box>
            )}
            {visited.current.hooks && (
              <Box sx={{ display: view === 'hooks' ? 'block' : 'none', height: '100%' }}>
                <HooksEditor />
              </Box>
            )}
            {visited.current.rules && (
              <Box sx={{ display: view === 'rules' ? 'block' : 'none', height: '100%' }}>
                <RulesPanel />
              </Box>
            )}
            {visited.current.memory && (
              <Box sx={{ display: view === 'memory' ? 'block' : 'none', height: '100%' }}>
                <MemoryPanel />
              </Box>
            )}
            {visited.current.wiki && (
              <Box sx={{ display: view === 'wiki' ? 'block' : 'none', height: '100%' }}>
                <WikiPanel />
              </Box>
            )}
            {visited.current.sessions && (
              <Box sx={{ display: view === 'sessions' ? 'block' : 'none', height: '100%' }}>
                <SessionHistory sendMsg={sendMsg} registerChat={(cb) => { chatHandler.current = cb; }} />
              </Box>
            )}
            {view === 'usage' && <UsageView usage={usage} onRefresh={refreshUsage} />}
            {view === 'skills' && <SkillsPanel />}
            {view === 'cron' && <CronJobs crons={crons} agents={agents} background={background} recent={recent} onAdd={() => setCronOpen(true)} onToast={setToast} />}
            {view === 'tasks' && (
              <TasksBoard
                tasks={tasks}
                history={taskHistory}
                agents={agents}
                stats={stats}
                activeId={active}
                onSelect={(sid) => sid && setActive(sid)}
                onAdd={() => setTaskOpen(true)}
                onMove={moveTask}
                onConclude={concludeTask}
                onDeleteHistory={deleteHistory}
              />
            )}
          </Suspense>
        </Box>
      </Box>

      {/* Drag handle — resize the dock (hidden while minimized). */}
      {!dockMin && <Box onMouseDown={startDockDrag} sx={{ height: 12, flexShrink: 0, mx: 1.5, cursor: 'row-resize' }} />}

      {/* Terminal dock — full width, below sidebar + view: session list (left) + selected terminal (right). */}
      <Box sx={(t) => ({ ...glass(t), position: 'relative', zIndex: t.zapac.layers.content, flexShrink: 0, height: dockMin ? 'auto' : dockH, mx: 1.5, mb: 1.5, mt: dockMin ? 1.5 : 0, borderRadius: `${t.zapac.radius.lg}px`, overflow: 'hidden', display: 'flex', flexDirection: 'column' })}>
          <Stack direction="row" spacing={1} onClick={toggleDock} title={dockMin ? 'Restore' : 'Minimize'} sx={(t) => ({ px: 1.5, height: 36, flexShrink: 0, display: 'flex', alignItems: 'center', cursor: 'pointer', userSelect: 'none', borderBottom: dockMin ? 'none' : `1px solid ${t.vars.palette.glass.stroke}` })}>
            <SmartToyIcon sx={{ fontSize: 16, color: 'text.secondary' }} />
            <Typography variant="subtitle2" sx={{ flex: 1 }} noWrap>Sessions</Typography>
            {dockMin ? <ExpandMoreIcon sx={{ fontSize: 18, color: 'text.secondary' }} /> : <ExpandLessIcon sx={{ fontSize: 18, color: 'text.secondary' }} />}
          </Stack>

          {/* Body kept mounted while minimized (display:none) so terminals keep
              their live xterm + scrollback. */}
          <Box sx={{ display: dockMin ? 'none' : 'flex', flex: 1, minHeight: 0 }}>
            <List sx={(t) => ({ width: listW.width, flexShrink: 0, overflow: 'auto', px: 1, py: 0.5, borderRight: `1px solid ${t.vars.palette.glass.stroke}` })}>
              {agents.map((a) => (
                <React.Fragment key={a.id}>
                <ListItemButton
                  selected={a.id === active}
                  onClick={() => setActive(a.id)}
                  draggable
                  onDragStart={() => setDragId(a.id)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => dropAgent(a.id)}
                  onDragEnd={() => setDragId(null)}
                  sx={{ borderRadius: (t) => `${t.zapac.radius.sm}px`, mb: 0.5, flexDirection: 'column', alignItems: 'stretch', gap: 0.5, opacity: dragId === a.id ? 0.4 : 1, '& .row-act': { opacity: a.status === 'detached' ? 1 : 0 }, '&:hover .row-act': { opacity: 1 } }}
                >
                  {/* Row 1: name (left) + actions (right). */}
                  <Stack direction="row" sx={{ alignItems: 'center', minWidth: 0 }}>
                    <Typography variant="subtitle2" noWrap sx={{ flex: 1, minWidth: 0 }}>{a.name}</Typography>
                    <Stack direction="row" className="row-act" sx={{ flexShrink: 0, transition: 'opacity .15s' }}>
                      <Tooltip title="Duplicate (config only)" disableInteractive>
                        <IconButton size="small" onClick={(e) => { e.stopPropagation(); sendMsg({ t: 'create', cwd: a.cwd, name: nextName(a), model: a.model, scopes: a.scopes }); }}><ContentCopyIcon fontSize="small" /></IconButton>
                      </Tooltip>
                      <Tooltip title="Fork (config + conversation)" disableInteractive>
                        <IconButton size="small" onClick={(e) => { e.stopPropagation(); sendMsg({ t: 'fork', id: a.id, name: nextName(a) }); }}><CallSplitIcon fontSize="small" /></IconButton>
                      </Tooltip>
                      {(a.status === 'running' || a.status === 'idle' || a.status === 'starting') && (
                        <Tooltip title="Restart (kill + resume, keeps conversation)" disableInteractive>
                          <IconButton size="small" sx={{ color: 'error.main', '&:hover': { color: 'error.main' } }} onClick={(e) => { e.stopPropagation(); sendMsg({ t: 'respawn', id: a.id }); }}><RestartAltIcon fontSize="small" /></IconButton>
                        </Tooltip>
                      )}
                      {a.status === 'detached' && (
                        <Tooltip title="Reattach (claude --resume)" disableInteractive>
                          <IconButton size="small" onClick={(e) => { e.stopPropagation(); sendMsg({ t: 'reattach', id: a.id }); }}><LinkIcon fontSize="small" /></IconButton>
                        </Tooltip>
                      )}
                      <Tooltip title={a.status === 'running' || a.status === 'starting' ? 'Kill' : 'Remove'} disableInteractive>
                        <IconButton size="small" sx={{ color: 'error.main', '&:hover': { color: 'error.main' } }} onClick={(e) => { e.stopPropagation(); sendMsg({ t: 'kill', id: a.id }); }}><CloseIcon fontSize="small" /></IconButton>
                      </Tooltip>
                    </Stack>
                  </Stack>
                  {/* Row 2: cwd + status/tokens, full width. */}
                  <Typography variant="code" sx={{ color: 'text.secondary', fontSize: 11 }} noWrap>{tildify(a.cwd)}</Typography>
                  <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                    <StatusPill status={KIND[a.status] ?? 'review'}>{a.status}</StatusPill>
                    {stats[a.id]?.turns > 0 && (
                      <Typography variant="code" sx={{ color: 'text.secondary', fontSize: 11 }}>
                        {stats[a.id].turns} turns · {fmtTokens(stats[a.id].tokens)} tok
                      </Typography>
                    )}
                  </Stack>
                </ListItemButton>
                {/* Live subagents (Task tool) — indicator only, no PTY to attach. */}
                {(subagents[a.id] || []).map((sub) => (
                  <Stack key={sub.id} direction="row" spacing={0.75} sx={{ alignItems: 'center', pl: 2.5, pr: 1, py: 0.25, minWidth: 0 }}>
                    <Box sx={{ width: 6, height: 6, borderRadius: '50%', flexShrink: 0, bgcolor: sub.running ? 'success.main' : 'text.disabled', animation: sub.running ? 'sing-sub-pulse 1.4s ease-in-out infinite' : 'none', '@keyframes sing-sub-pulse': { '0%,100%': { opacity: 1 }, '50%': { opacity: 0.35 } } }} />
                    <Typography variant="code" noWrap sx={{ fontSize: 11, color: 'text.secondary', flex: 1, minWidth: 0 }}>{sub.title || sub.agentId}</Typography>
                  </Stack>
                ))}
                </React.Fragment>
              ))}
            </List>

            {/* Drag handle — resize the session-list width. */}
            <ResizeHandle onMouseDown={listW.startDrag} />

            {/* Selected terminal. All non-detached terminals stay mounted
                (display:none when hidden) so scrollback + WS attach survive. */}
            <Box sx={{ position: 'relative', flex: 1, minWidth: 0, p: 0.5 }}>
              {agents.filter((a) => a.status !== 'detached' && mountedSet.has(a.id)).map((a) => {
                const show = !dockMin && a.id === active;
                return (
                  <Box key={a.id} sx={{ position: 'absolute', inset: 0, display: show ? 'block' : 'none' }}>
                    <Terminal agent={a} visible={show} sendMsg={sendMsg} onSwitch={cycleSession} registerOutput={(fn) => { if (fn) termHandlers.current[a.id] = fn; else delete termHandlers.current[a.id]; }} />
                  </Box>
                );
              })}
              {(!activeAgent || activeAgent.status === 'detached') && (
                <Box sx={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center' }}>
                  <EmptyState
                    icon={<TerminalIcon />}
                    title={activeAgent?.status === 'detached' ? 'Agent detached' : 'No agent selected'}
                    description={activeAgent?.status === 'detached' ? 'Click the reattach button to resume the conversation.' : 'Create an agent to begin.'}
                  />
                </Box>
              )}
            </Box>
          </Box>
        </Box>

      {picking && <DirPicker start={cwd} onPick={(p) => { setCwd(p); setPicking(false); }} onClose={() => setPicking(false)} />}
      {procsOpen && <ProcessManager onClose={() => setProcsOpen(false)} />}

      {/* More menu: Config/Hooks/Skills/Rules/Memory/Transcripts/Wiki nav, then processes + dark mode. */}
      <Menu anchorEl={menuAnchor} open={!!menuAnchor} onClose={() => setMenuAnchor(null)} keepMounted>
        <MenuItem onClick={() => { setView('config'); setMenuAnchor(null); }}>
          <ListItemIcon><SettingsIcon fontSize="small" /></ListItemIcon>
          <ListItemText>Config</ListItemText>
        </MenuItem>
        <MenuItem onClick={() => { setView('hooks'); setMenuAnchor(null); }}>
          <ListItemIcon><WebhookIcon fontSize="small" /></ListItemIcon>
          <ListItemText>Hooks</ListItemText>
        </MenuItem>
        <MenuItem onClick={() => { setView('skills'); setMenuAnchor(null); }}>
          <ListItemIcon><SchoolIcon fontSize="small" /></ListItemIcon>
          <ListItemText>Skills</ListItemText>
        </MenuItem>
        <MenuItem onClick={() => { setView('rules'); setMenuAnchor(null); }}>
          <ListItemIcon><GavelIcon fontSize="small" /></ListItemIcon>
          <ListItemText>Rules</ListItemText>
        </MenuItem>
        <MenuItem onClick={() => { setView('memory'); setMenuAnchor(null); }}>
          <ListItemIcon><BookIcon fontSize="small" /></ListItemIcon>
          <ListItemText>Memory</ListItemText>
        </MenuItem>
        <MenuItem onClick={() => { setView('sessions'); setMenuAnchor(null); }}>
          <ListItemIcon><HistoryIcon fontSize="small" /></ListItemIcon>
          <ListItemText>Transcripts</ListItemText>
        </MenuItem>
        <MenuItem onClick={() => { setView('wiki'); setMenuAnchor(null); }}>
          <ListItemIcon><MenuBookIcon fontSize="small" /></ListItemIcon>
          <ListItemText>Wiki</ListItemText>
        </MenuItem>
        <Divider />
        <MenuItem onClick={() => { setProcsOpen(true); setMenuAnchor(null); }}>
          <ListItemIcon><MonitorHeartIcon fontSize="small" /></ListItemIcon>
          <ListItemText>Claude processes</ListItemText>
        </MenuItem>
        {/* Self-respawn only works when the daemon serves the built UI (npm start).
            In dev, concurrently -k kills Vite too, so the shell can't reconnect. */}
        {import.meta.env.PROD && (
          <MenuItem disabled={restarting} onClick={() => { setRestartOpen(true); setMenuAnchor(null); }}>
            <ListItemIcon><RestartAltIcon fontSize="small" sx={{ color: 'warning.main' }} /></ListItemIcon>
            <ListItemText>Restart server</ListItemText>
          </MenuItem>
        )}
        <Divider />
        <MenuItem onClick={onToggleTheme}>
          <ListItemIcon>{resolved === 'dark' ? <DarkModeIcon fontSize="small" /> : <LightModeIcon fontSize="small" />}</ListItemIcon>
          <Switch edge="end" checked={resolved === 'dark'} onChange={onToggleTheme} onClick={(e) => e.stopPropagation()} />
        </MenuItem>
      </Menu>

      {/* After a theme toggle, offer to respawn live sessions so their claude
          TUI re-queries the terminal background and matches the new theme. */}
      <Dialog open={respawnCount > 0} onClose={() => setRespawnCount(0)} maxWidth="sm" fullWidth>
        <DialogTitle>Restart sessions to match theme?</DialogTitle>
        <DialogContent>
          <Typography variant="body2">
            Theme changed. {respawnCount} running session{respawnCount === 1 ? '' : 's'} still use the old theme. Restart them to match?
          </Typography>
          <Typography variant="body2" sx={{ mt: 1, color: 'text.secondary' }}>
            This restarts each session — any in-flight turn is interrupted (conversation history is kept). Session order may change.
          </Typography>
        </DialogContent>
        <DialogActions sx={{ px: 2, pb: 2, pt: 0.5 }}>
          <Button size="small" variant="secondary" sx={{ px: 2 }} onClick={() => setRespawnCount(0)}>Dismiss</Button>
          <Button size="small" sx={{ px: 2 }} variant="contained" onClick={() => { sendMsg({ t: 'respawnAll' }); setRespawnCount(0); }}>Restart</Button>
        </DialogActions>
      </Dialog>

      {/* Restart the server — respawns itself detached, killing every live session. */}
      <Dialog open={restartOpen} onClose={() => setRestartOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>Restart server?</DialogTitle>
        <DialogContent>
          {(() => {
            const liveCount = agents.filter((a) => a.status === 'running' || a.status === 'idle' || a.status === 'starting').length;
            return (
              <Typography variant="body2">
                Restarting the server kills all {liveCount} running session{liveCount === 1 ? '' : 's'} (conversations are lost). Continue?
              </Typography>
            );
          })()}
        </DialogContent>
        <DialogActions sx={{ px: 2, pb: 2, pt: 0.5 }}>
          <Button size="small" variant="secondary" sx={{ px: 2 }} onClick={() => setRestartOpen(false)}>Cancel</Button>
          <Button size="small" sx={{ px: 2 }} variant="contained" onClick={doRestart}>Restart</Button>
        </DialogActions>
      </Dialog>

      <CreateAgentDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        connected={connected}
        cwd={cwd}
        setCwd={setCwd}
        recent={recent}
        onBrowse={() => setPicking(true)}
        sendMsg={sendMsg}
      />

      <CreateTaskDialog
        open={taskOpen}
        onClose={() => setTaskOpen(false)}
        cwd={cwd}
        setCwd={setCwd}
        recent={recent}
        onBrowse={() => setPicking(true)}
        tagOptions={tagOptions}
      />

      <CreateCronDialog
        open={cronOpen}
        onClose={() => setCronOpen(false)}
        cwd={cwd}
        setCwd={setCwd}
        recent={recent}
        onBrowse={() => setPicking(true)}
      />

      <Snackbar open={!!toast} autoHideDuration={5000} onClose={() => setToast(null)} message={toast} anchorOrigin={{ vertical: 'top', horizontal: 'center' }} />
    </Box>
  );
}
