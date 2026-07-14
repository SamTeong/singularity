import React, { useEffect, useRef, useState, useCallback, Suspense, lazy } from 'react';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
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
import AddIcon from '@mui/icons-material/Add';
import CloseIcon from '@mui/icons-material/Close';
import ReplayIcon from '@mui/icons-material/Replay';
import TerminalIcon from '@mui/icons-material/Terminal';
import MonitorHeartIcon from '@mui/icons-material/MonitorHeart';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import SettingsIcon from '@mui/icons-material/Settings';
import BookIcon from '@mui/icons-material/Book';
import Brightness4Icon from '@mui/icons-material/Brightness4';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import { useTheme } from '@mui/material/styles';
import { AmbientBackground, useColorMode, StatusPill, EmptyState } from '@zapac/mui-theme';
import Terminal from './Terminal.jsx';
import DirPicker from './DirPicker.jsx';
import ProcessManager from './ProcessManager.jsx';
import CreateAgentDialog from './CreateAgentDialog.jsx';

// Lazy: these two carry CodeMirror (the biggest non-xterm dep) and only render
// in the Config/Memory views — split them out of the initial (terminal) bundle.
const ConfigEditor = lazy(() => import('./ConfigEditor.jsx'));
const MemoryPanel = lazy(() => import('./MemoryPanel.jsx'));

const WS_URL = `ws://${location.host}/ws${window.__SING_TOKEN__ ? `?token=${encodeURIComponent(window.__SING_TOKEN__)}` : ''}`;

// agent lifecycle -> the theme's fixed StatusPill kinds (done|active|review|error)
const KIND = { starting: 'active', running: 'active', idle: 'review', detached: 'review', exited: 'error' };
// Status ring color for the collapsed-rail numbered circles — an agent can die
// (exit) while the rail is collapsed; the ring is the only signal there.
const statusRing = (t, status) => ({
  running: t.vars.palette.success.main,
  starting: t.vars.palette.warning.main,
  idle: t.vars.palette.warning.main,
  detached: t.vars.palette.text.disabled,
  exited: t.vars.palette.error.main,
}[status] || t.vars.palette.glass.stroke);
const fmtTokens = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : `${n}`);

// Vertical nav rail entries (icon + label). The rail is the sidebar's primary
// navigation; the ＋ "New agent" row above it opens the create dialog.
const NAV = [
  { v: 'agents', icon: <TerminalIcon />, label: 'Agents' },
  { v: 'config', icon: <SettingsIcon />, label: 'Config' },
  { v: 'memory', icon: <BookIcon />, label: 'Memory' },
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
  const [collapsed, setCollapsed] = useState(false);
  const [view, setView] = useState('agents');
  const { resolved, toggle: toggleColorMode } = useColorMode();
  const [toast, setToast] = useState(null);
  const [stats, setStats] = useState({}); // id -> {turns, tokens}
  const wsRef = useRef(null);
  const termHandlers = useRef({}); // id -> { write(data), reset() }

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
        } else if (m.t === 'error') {
          setToast(m.msg);
        }
      };
    };
    connect();
    return () => { unmounted = true; clearTimeout(timer); ws.close(); };
  }, []);

  const sendMsg = useCallback((msg) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }, []);

  // Poll per-agent stats (turns/tokens from each session .jsonl).
  const agentKey = agents.map((a) => a.id).join(',');
  useEffect(() => {
    if (!connected) return undefined;
    const pull = () => fetch('/agent-stats').then((r) => r.json()).then((d) => setStats(d.stats || {})).catch(() => {});
    pull();
    const t = setInterval(pull, 8000);
    return () => clearInterval(t);
  }, [connected, agentKey]);

  // Ctrl+Alt+PgUp/PgDn — switch to prev/next non-detached agent session.
  // Capture phase so it beats xterm's own keydown; ignore while a field/dialog
  // has focus (don't steal the key from forms or the editor).
  useEffect(() => {
    const onKey = (e) => {
      if (!e.ctrlKey || !e.altKey) return;
      if (e.key !== 'PageUp' && e.key !== 'PageDown') return;
      const tag = (e.target?.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || e.target?.isContentEditable) return;
      if (createOpen || procsOpen || picking) return;
      const live = agents.filter((a) => a.status !== 'detached');
      if (live.length < 2) return;
      e.preventDefault();
      e.stopPropagation();
      const idx = live.findIndex((a) => a.id === active);
      const cur = idx < 0 ? 0 : idx;
      const next = e.key === 'PageDown' ? (cur + 1) % live.length : (cur - 1 + live.length) % live.length;
      setActive(live[next].id);
      setView('agents');
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [agents, active, createOpen, procsOpen, picking]);

  const activeAgent = agents.find((a) => a.id === active);

  return (
    <Box sx={{ position: 'relative', height: '100dvh', display: 'flex', overflow: 'hidden' }}>
      <AmbientBackground />

      {/* Sidebar */}
      <Box
        component="aside"
        sx={(t) => ({
          ...glass(t),
          position: 'relative',
          zIndex: t.zapac.layers.nav,
          width: collapsed ? 64 : 320,
          flexShrink: 0,
          m: 1.5,
          mr: 0,
          borderRadius: `${t.zapac.radius.lg}px`,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          transition: 'width .2s ease',
        })}
      >
        {/* Header: logo (+ title when expanded) */}
        <Stack direction="row" spacing={1.25} sx={{ p: 2, pb: 1.5, alignItems: 'center', justifyContent: collapsed ? 'center' : 'flex-start' }}>
          <Logo active={agents.some((a) => a.status === 'running' || a.status === 'starting')} />
          {!collapsed && (
            <Typography component="span" sx={{ flex: 1, fontSize: 16, fontWeight: 700, lineHeight: 1, letterSpacing: '-0.01em' }}>Singularity</Typography>
          )}
        </Stack>

        {/* Vertical nav rail: ＋ New agent, then Agents / Config / Memory. Icon-only when collapsed. */}
        <List sx={{ px: 1, pb: 1 }}>
          {/* Tooltips only when collapsed — expanded rows show their label already. */}
          <Tooltip title={collapsed ? 'New agent' : ''} placement="right" disableInteractive slotProps={PAPER_TOOLTIP_SLOTPROPS}>
            <ListItemButton
              onClick={() => setCreateOpen(true)}
              sx={{ justifyContent: collapsed ? 'center' : 'flex-start', minHeight: 44, borderRadius: (t) => `${t.zapac.radius.sm}px`, mb: 0.5 }}
            >
              <ListItemIcon sx={{ minWidth: collapsed ? 0 : 36, justifyContent: 'center' }}><AddIcon /></ListItemIcon>
              {!collapsed && <ListItemText primary="New agent" />}
            </ListItemButton>
          </Tooltip>
          {NAV.map((item) => (
            <Tooltip key={item.v} title={collapsed ? item.label : ''} placement="right" disableInteractive slotProps={PAPER_TOOLTIP_SLOTPROPS}>
              <ListItemButton
                selected={view === item.v}
                onClick={() => setView(item.v)}
                sx={{ justifyContent: collapsed ? 'center' : 'flex-start', minHeight: 44, borderRadius: (t) => `${t.zapac.radius.sm}px`, mb: 0.5 }}
              >
                <ListItemIcon sx={{ minWidth: collapsed ? 0 : 36, justifyContent: 'center' }}>{item.icon}</ListItemIcon>
                {!collapsed && <ListItemText primary={item.label} />}
              </ListItemButton>
            </Tooltip>
          ))}
        </List>

        {!collapsed && (
          <Box sx={{ px: 2, pb: 1 }}>
            <StatusPill status={connected ? 'done' : 'error'}>{connected ? 'connected' : 'disconnected'}</StatusPill>
          </Box>
        )}

        {/* Agent list — expanded: shown for every view (mirrors collapsed numbered-circles). */}
        {!collapsed && (
          <List sx={{ flex: 1, overflow: 'auto', px: 1 }}>
            {agents.map((a) => (
              <ListItemButton
                key={a.id}
                selected={a.id === active}
                onClick={() => { setActive(a.id); setView('agents'); }}
                sx={{ borderRadius: (t) => `${t.zapac.radius.sm}px`, mb: 0.5, alignItems: 'flex-start', '& .row-act': { opacity: a.status === 'detached' ? 1 : 0 }, '&:hover .row-act': { opacity: 1 } }}
              >
                <Stack sx={{ flex: 1, minWidth: 0 }} spacing={0.5}>
                  <Typography variant="subtitle2" noWrap>{a.name}</Typography>
                  <Typography variant="code" sx={{ color: 'text.secondary', fontSize: 11 }} noWrap>{a.cwd}</Typography>
                  <Stack direction="row" spacing={1} alignItems="center">
                    <StatusPill status={KIND[a.status] ?? 'review'}>{a.status}</StatusPill>
                    {stats[a.id]?.turns > 0 && (
                      <Typography variant="code" sx={{ color: 'text.secondary', fontSize: 11 }}>
                        {stats[a.id].turns} turns · {fmtTokens(stats[a.id].tokens)} tok
                      </Typography>
                    )}
                  </Stack>
                </Stack>
                <Stack direction="row" className="row-act" sx={{ transition: 'opacity .15s' }}>
                  {a.status === 'detached' && (
                    <Tooltip title="Reattach (claude --resume)" disableInteractive>
                      <IconButton size="small" onClick={(e) => { e.stopPropagation(); sendMsg({ t: 'reattach', id: a.id }); }}><ReplayIcon fontSize="small" /></IconButton>
                    </Tooltip>
                  )}
                  <Tooltip title={a.status === 'running' || a.status === 'starting' ? 'Kill' : 'Remove'} disableInteractive>
                    <IconButton size="small" onClick={(e) => { e.stopPropagation(); sendMsg({ t: 'kill', id: a.id }); }}><CloseIcon fontSize="small" /></IconButton>
                  </Tooltip>
                </Stack>
              </ListItemButton>
            ))}
          </List>
        )}

        {/* Collapsed agent list: numbered circles (1..N), selectable. */}
        {collapsed && (
          <List sx={{ flex: 1, overflow: 'auto', px: 1, pb: 1 }}>
            {agents.map((a, i) => {
              const sel = a.id === active && view === 'agents';
              return (
                <Tooltip
                  key={a.id}
                  placement="right"
                  slotProps={{
                    tooltip: {
                      sx: { ...PAPER_TOOLTIP_SLOTPROPS.tooltip.sx, maxWidth: 280 },
                    },
                  }}
                  title={
                    <Stack spacing={0.5} sx={{ p: 0.5, maxWidth: 280 }}>
                      <Typography variant="subtitle2" noWrap>{a.name || 'agent'}</Typography>
                      <Typography variant="code" sx={{ fontSize: 11, opacity: 0.8 }} noWrap>{a.cwd}</Typography>
                      <Stack direction="row" spacing={1} alignItems="center">
                        <StatusPill status={KIND[a.status] ?? 'review'}>{a.status}</StatusPill>
                        {stats[a.id]?.turns > 0 && (
                          <Typography variant="code" sx={{ fontSize: 11, opacity: 0.8 }}>
                            {stats[a.id].turns} turns · {fmtTokens(stats[a.id].tokens)} tok
                          </Typography>
                        )}
                      </Stack>
                    </Stack>
                  }
                >
                  <ListItemButton
                    onClick={() => { setActive(a.id); setView('agents'); }}
                    sx={{ justifyContent: 'center', alignItems: 'center', minHeight: 40, borderRadius: (t) => `${t.zapac.radius.sm}px`, mb: 0.5 }}
                  >
                    <Box
                      sx={(t) => ({
                        width: 28, height: 28, flexShrink: 0, borderRadius: '50%',
                        display: 'grid', placeItems: 'center',
                        fontSize: 13, fontWeight: 600,
                        border: `2px solid ${statusRing(t, a.status)}`,
                        bgcolor: sel ? t.vars.palette.primary.main : 'transparent',
                        color: sel ? t.vars.palette.primary.contrastText : t.vars.palette.text.secondary,
                      })}
                    >
                      {i + 1}
                    </Box>
                  </ListItemButton>
                </Tooltip>
              );
            })}
          </List>
        )}

        {/* Bottom-pinned: collapse toggle + more (processes, dark mode). */}
        <Box sx={{ p: 1, mt: 'auto' }}>
          <Stack direction="column" spacing={0.5} sx={{ width: 'fit-content' }}>
            {/* placement=right + disableInteractive: the default bottom-placed
                interactive tooltip opens over the neighbouring button and
                swallows its clicks. */}
            <Tooltip title={collapsed ? 'Expand' : 'Collapse'} placement="right" disableInteractive slotProps={PAPER_TOOLTIP_SLOTPROPS}>
              <IconButton onClick={() => setCollapsed((c) => !c)} size="small">
                {collapsed ? <ChevronRightIcon /> : <ChevronLeftIcon />}
              </IconButton>
            </Tooltip>
            <Tooltip title="More" placement="right" disableInteractive slotProps={PAPER_TOOLTIP_SLOTPROPS}>
              <IconButton onClick={(e) => setMenuAnchor(e.currentTarget)} size="small"><MoreVertIcon /></IconButton>
            </Tooltip>
          </Stack>
        </Box>
      </Box>

      {/* Main terminal pane */}
      <Box sx={(t) => ({ position: 'relative', flex: 1, m: 1.5, minWidth: 0, zIndex: t.zapac.layers.content })}>
        {(view === 'config' || view === 'memory') && (
          <Box sx={(t) => ({ ...glass(t), position: 'absolute', inset: 0, borderRadius: `${t.zapac.radius.lg}px`, overflow: 'hidden' })}>
            <Suspense fallback={<Box sx={{ p: 3, color: 'text.secondary' }}>Loading…</Box>}>
              {view === 'config' ? <ConfigEditor cwd={activeAgent?.cwd || cwd} /> : <MemoryPanel />}
            </Suspense>
          </Box>
        )}
        {/* Terminals stay mounted across all views (display:none when hidden) so
            switching Agents→Config→Agents keeps the live xterm + scrollback,
            matching agent-to-agent switching. */}
        {agents.filter((a) => a.status !== 'detached').map((a) => {
          const show = view === 'agents' && a.id === active;
          return (
            <Box
              key={a.id}
              sx={(t) => ({
                ...glass(t),
                position: 'absolute', inset: 0,
                display: show ? 'block' : 'none',
                borderRadius: `${t.zapac.radius.lg}px`,
                overflow: 'hidden',
                p: 0.5,
              })}
            >
              <Terminal agent={a} visible={show} sendMsg={sendMsg} registerOutput={(fn) => { termHandlers.current[a.id] = fn; }} />
            </Box>
          );
        })}
        {view === 'agents' && (!activeAgent || activeAgent.status === 'detached') && (
          <Box sx={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center' }}>
            <EmptyState
              icon={<TerminalIcon />}
              title={activeAgent?.status === 'detached' ? 'Agent detached' : 'No agent selected'}
              description={activeAgent?.status === 'detached' ? 'Click the reattach button to resume the conversation.' : 'Create an agent to begin.'}
            />
          </Box>
        )}
      </Box>

      {picking && <DirPicker start={cwd} onPick={(p) => { setCwd(p); setPicking(false); }} onClose={() => setPicking(false)} />}
      {procsOpen && <ProcessManager onClose={() => setProcsOpen(false)} />}

      {/* More menu: processes + dark mode only (nav lives in the rail). */}
      <Menu anchorEl={menuAnchor} open={!!menuAnchor} onClose={() => setMenuAnchor(null)} keepMounted>
        <MenuItem onClick={() => { setProcsOpen(true); setMenuAnchor(null); }}>
          <ListItemIcon><MonitorHeartIcon fontSize="small" /></ListItemIcon>
          <ListItemText>Claude processes</ListItemText>
        </MenuItem>
        <Divider />
        <MenuItem onClick={toggleColorMode}>
          <ListItemIcon><Brightness4Icon fontSize="small" /></ListItemIcon>
          <ListItemText>Dark mode</ListItemText>
          <Switch edge="end" checked={resolved === 'dark'} onChange={toggleColorMode} onClick={(e) => e.stopPropagation()} />
        </MenuItem>
      </Menu>

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

      <Snackbar open={!!toast} autoHideDuration={5000} onClose={() => setToast(null)} message={toast} anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }} />
    </Box>
  );
}
