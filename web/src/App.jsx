import React, { useEffect, useRef, useState, useCallback } from 'react';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import TextField from '@mui/material/TextField';
import Autocomplete from '@mui/material/Autocomplete';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import Snackbar from '@mui/material/Snackbar';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import AddIcon from '@mui/icons-material/Add';
import CloseIcon from '@mui/icons-material/Close';
import ReplayIcon from '@mui/icons-material/Replay';
import TerminalIcon from '@mui/icons-material/Terminal';
import MemoryIcon from '@mui/icons-material/Memory';
import Tabs from '@mui/material/Tabs';
import Tab from '@mui/material/Tab';
import { AmbientBackground, ColorModeToggle, StatusPill, EmptyState } from '@zapac/mui-theme';
import Terminal from './Terminal.jsx';
import DirPicker from './DirPicker.jsx';
import ProcessManager from './ProcessManager.jsx';
import ConfigEditor from './ConfigEditor.jsx';
import MemoryPanel from './MemoryPanel.jsx';

const WS_URL = `ws://${location.host}/ws${window.__SING_TOKEN__ ? `?token=${encodeURIComponent(window.__SING_TOKEN__)}` : ''}`;

// agent lifecycle -> the theme's fixed StatusPill kinds (done|active|review|error)
const KIND = { starting: 'active', running: 'active', idle: 'review', detached: 'review', exited: 'error' };
const fmtTokens = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : `${n}`);
// Use theme.vars (the --mui-* CSS vars) not theme.palette — under cssVariables
// theme.palette holds only the default (light) scheme's literals and won't switch
// with the .dark class; theme.vars is the scheme-switching reference.
const glass = (t) => ({
  background: t.vars.palette.glass.surface,
  backdropFilter: `blur(${t.vars.palette.glass.blur})`,
  border: `1px solid ${t.vars.palette.glass.stroke}`,
  boxShadow: t.vars.palette.glass.cardShadow,
});

export default function App() {
  const [agents, setAgents] = useState([]);
  const [active, setActive] = useState(null);
  const [connected, setConnected] = useState(false);
  const [recent, setRecent] = useState([]);
  const [cwd, setCwd] = useState('C:\\git\\singularity');
  const [name, setName] = useState('');
  const [picking, setPicking] = useState(false);
  const [procsOpen, setProcsOpen] = useState(false);
  const [view, setView] = useState('agents');
  const [toast, setToast] = useState(null);
  const [stats, setStats] = useState({}); // id -> {turns, tokens}
  const wsRef = useRef(null);
  const termHandlers = useRef({}); // id -> onOutput(data)

  useEffect(() => {
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;
    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.t === 'list') {
        setAgents(m.agents);
        if (m.recentRepos) setRecent(m.recentRepos);
        setActive((cur) => (cur && m.agents.some((a) => a.id === cur) ? cur : m.agents[0]?.id ?? null));
      } else if (m.t === 'status') {
        setAgents((as) => as.map((a) => (a.id === m.id ? { ...a, status: m.status } : a)));
      } else if (m.t === 'output') {
        termHandlers.current[m.id]?.(m.data);
      } else if (m.t === 'attached') {
        setActive(m.id);
      } else if (m.t === 'error') {
        setToast(m.msg);
      }
    };
    return () => ws.close();
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

  const create = () => {
    if (!cwd.trim()) return;
    sendMsg({ t: 'create', cwd: cwd.trim(), name: name.trim() });
    setName('');
  };

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
          width: 320,
          flexShrink: 0,
          m: 1.5,
          mr: 0,
          borderRadius: `${t.zapac.radius.lg}px`,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        })}
      >
        <Stack direction="row" alignItems="center" spacing={1.25} sx={{ p: 2, pb: 1.5 }}>
          <Box sx={(t) => ({ width: 30, height: 30, borderRadius: '10px', background: t.vars.palette.gradient.brand, boxShadow: t.vars.palette.glass.glow })} />
          <Typography variant="h4" component="span" sx={{ flex: 1 }}>Singularity</Typography>
          <Tooltip title="Claude processes"><IconButton onClick={() => setProcsOpen(true)}><MemoryIcon /></IconButton></Tooltip>
          <ColorModeToggle />
        </Stack>

        <Box sx={{ px: 2, pb: 1 }}>
          <StatusPill status={connected ? 'done' : 'error'}>{connected ? 'daemon connected' : 'disconnected'}</StatusPill>
        </Box>

        <Tabs value={view} onChange={(_, v) => setView(v)} variant="fullWidth" sx={{ px: 1, minHeight: 40 }}>
          <Tab value="agents" label="Agents" sx={{ minHeight: 40 }} />
          <Tab value="config" label="Config" sx={{ minHeight: 40 }} />
          <Tab value="memory" label="Memory" sx={{ minHeight: 40 }} />
        </Tabs>

        {/* Create form */}
        <Stack spacing={1} sx={{ p: 2, pt: 1.5, display: view === 'agents' ? 'flex' : 'none' }}>
          <Stack direction="row" spacing={0.5} alignItems="center">
            <Autocomplete
              freeSolo
              fullWidth
              options={recent}
              inputValue={cwd}
              onInputChange={(_, v) => setCwd(v)}
              renderInput={(params) => <TextField {...params} size="small" label="cwd (repo path)" spellCheck={false} />}
            />
            <Tooltip title="Browse…">
              <IconButton onClick={() => setPicking(true)}><FolderOpenIcon /></IconButton>
            </Tooltip>
          </Stack>
          <TextField size="small" label="name (optional)" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && create()} />
          <Button variant="contained" startIcon={<AddIcon />} onClick={create} disabled={!connected}>New agent</Button>
        </Stack>

        {/* Agent list */}
        <List sx={{ flex: 1, overflow: 'auto', px: 1 }}>
          {agents.map((a) => (
            <ListItemButton
              key={a.id}
              selected={a.id === active}
              onClick={() => setActive(a.id)}
              sx={{ borderRadius: (t) => `${t.zapac.radius.sm}px`, mb: 0.5, alignItems: 'flex-start', '& .row-act': { opacity: 0 }, '&:hover .row-act': { opacity: 1 } }}
            >
              <Stack sx={{ flex: 1, minWidth: 0 }} spacing={0.5}>
                <Typography variant="subtitle2" noWrap>{a.name}</Typography>
                <Typography variant="code" sx={{ color: 'text.secondary', fontSize: 11 }} noWrap>{a.cwd}</Typography>
                <Stack direction="row" spacing={1} alignItems="center">
                  <StatusPill status={KIND[a.status] ?? 'review'}>{a.status}</StatusPill>
                  {stats[a.id]?.turns > 0 && (
                    <Typography variant="code" sx={{ color: 'text.secondary', fontSize: 10 }}>
                      {stats[a.id].turns} turns · {fmtTokens(stats[a.id].tokens)} tok
                    </Typography>
                  )}
                </Stack>
              </Stack>
              <Stack direction="row" className="row-act" sx={{ transition: 'opacity .15s' }}>
                {a.status === 'detached' && (
                  <Tooltip title="Reattach (claude --resume)">
                    <IconButton size="small" onClick={(e) => { e.stopPropagation(); sendMsg({ t: 'reattach', id: a.id }); }}><ReplayIcon fontSize="small" /></IconButton>
                  </Tooltip>
                )}
                <Tooltip title={a.status === 'running' || a.status === 'starting' ? 'Kill' : 'Remove'}>
                  <IconButton size="small" onClick={(e) => { e.stopPropagation(); sendMsg({ t: 'kill', id: a.id }); }}><CloseIcon fontSize="small" /></IconButton>
                </Tooltip>
              </Stack>
            </ListItemButton>
          ))}
        </List>
      </Box>

      {/* Main terminal pane */}
      <Box sx={(t) => ({ position: 'relative', flex: 1, m: 1.5, minWidth: 0, zIndex: t.zapac.layers.content ?? 1 })}>
        {view === 'config' && (
          <Box sx={(t) => ({ ...glass(t), position: 'absolute', inset: 0, borderRadius: `${t.zapac.radius.lg}px`, overflow: 'hidden' })}>
            <ConfigEditor cwd={activeAgent?.cwd || cwd} />
          </Box>
        )}
        {view === 'memory' && (
          <Box sx={(t) => ({ ...glass(t), position: 'absolute', inset: 0, borderRadius: `${t.zapac.radius.lg}px`, overflow: 'hidden' })}>
            <MemoryPanel />
          </Box>
        )}
        {view === 'agents' && agents.filter((a) => a.status !== 'detached').map((a) => (
          <Box
            key={a.id}
            sx={(t) => ({
              ...glass(t),
              position: 'absolute', inset: 0,
              display: a.id === active ? 'block' : 'none',
              borderRadius: `${t.zapac.radius.lg}px`,
              overflow: 'hidden',
              p: 0.5,
            })}
          >
            <Terminal agent={a} visible={a.id === active} sendMsg={sendMsg} registerOutput={(fn) => { termHandlers.current[a.id] = fn; }} />
          </Box>
        ))}
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
      <Snackbar open={!!toast} autoHideDuration={5000} onClose={() => setToast(null)} message={toast} anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }} />
    </Box>
  );
}
