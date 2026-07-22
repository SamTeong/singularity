import { getTokens } from '@/theme/contract.js';
import { useEffect, useMemo, useRef, useState, Suspense, lazy } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Snackbar from '@mui/material/Snackbar';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Button from '@mui/material/Button';
import { useColorMode } from '@zapac/mui-theme';
import { useThemeSkin } from '@/theme/AppThemeProvider.jsx';
import { getSkin } from '@/theme/registry.js';
import DirPicker from '@/components/DirPicker.jsx';
import { untildify } from '@/lib/paths.js';
import ProcessManager from '@/features/processes/ProcessManager.jsx';
import CreateAgentDialog from '@/features/sessions/CreateAgentDialog.jsx';
import CreateTaskDialog from '@/features/tasks/CreateTaskDialog.jsx';
import CreateCronDialog from '@/features/automation/CreateCronDialog.jsx';
import { useResizable } from '@/hooks/useResizable.jsx';
import { useAgents } from '@/providers/AgentsProvider.jsx';
import { useTaskActions } from '@/hooks/useTaskActions.js';
import Sidebar from '@/shell/Sidebar.jsx';
import SessionDock from '@/shell/SessionDock.jsx';
import AppMenu from '@/shell/AppMenu.jsx';
import { glass } from '@/shell/shellStyles.js';

// Lazy: these carry CodeMirror (the biggest non-xterm dep) or only render off the
// terminal view — split them out of the initial (terminal) bundle.
const ConfigEditor = lazy(() => import('@/features/config/ConfigEditor.jsx'));
const HooksEditor = lazy(() => import('@/features/config-hooks/HooksEditor.jsx'));
const RulesPanel = lazy(() => import('@/features/rules/RulesPanel.jsx'));
const MemoryPanel = lazy(() => import('@/features/memory/MemoryPanel.jsx'));
const SessionHistory = lazy(() => import('@/features/transcripts/SessionHistory.jsx'));
const WikiPanel = lazy(() => import('@/features/wiki/WikiPanel.jsx'));
const SkillsPanel = lazy(() => import('@/features/skills/SkillsPanel.jsx'));
const UsageView = lazy(() => import('@/features/usage/UsageView.jsx'));
const TasksBoard = lazy(() => import('@/features/tasks/TasksBoard.jsx'));
const CronJobs = lazy(() => import('@/features/automation/CronJobs.jsx'));
const AppearanceView = lazy(() => import('@/features/appearance/AppearanceView.jsx'));

// Views that mount once (on first visit) and stay mounted (display:none when
// hidden) so live CodeMirror + unsaved edits survive view switches.
const PERSISTENT_VIEWS = ['config', 'hooks', 'rules', 'memory', 'wiki', 'sessions'];

const isLive = (s) => s === 'running' || s === 'idle' || s === 'starting';

/**
 * AppShell — orchestration + layout. Holds UI-only state (view, collapse, dock
 * minimise, dialogs, toast), routes the selected view, and composes the sidebar,
 * session dock, more-menu, and dialogs. Fleet/domain state lives in
 * {@link useAgents}; colour mode in `useColorMode`.
 */
export default function AppShell() {
  const {
    agents, active, setActive, connected, tasks, taskHistory, crons, background, recent,
    usage, stats, sendMsg, refreshUsage, registerChat, registerError,
  } = useAgents();
  const { toggle: toggleColorMode } = useColorMode();
  // The active skin optionally paints a full-bleed background behind the shell.
  const { skinId } = useThemeSkin();
  const SkinBackground = getSkin(skinId)?.Background;

  const [cwd, setCwd] = useState('~');
  const [picking, setPicking] = useState(false);
  const [procsOpen, setProcsOpen] = useState(false);
  const [menuAnchor, setMenuAnchor] = useState(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [taskOpen, setTaskOpen] = useState(false);
  const [cronOpen, setCronOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  // Persisted so the selected view survives a skin switch (which remounts the
  // whole shell) and page reloads — otherwise switching theme bounces to Tasks.
  const [view, setView] = useState(() => localStorage.getItem('sing-view') || 'tasks');
  const [toast, setToast] = useState(null);
  const [respawnCount, setRespawnCount] = useState(0); // >0 -> respawn-confirm dialog open, holds live-session count
  const [restartOpen, setRestartOpen] = useState(false); // restart-daemon confirm dialog
  const [restarting, setRestarting] = useState(false); // true while polling /health for the new daemon
  // Terminal dock minimized state, persisted (height is a useResizable below).
  const [dockMin, setDockMin] = useState(() => localStorage.getItem('sing-dock-min') === '1');

  const mainRef = useRef(null);
  // Session-list panel width (px, drag-resizable), persisted.
  const listW = useResizable('sing-list-w', 260, { min: 160, max: 640 });
  // Terminal dock height (px, drag-resizable), persisted — resizes up from the
  // main pane's bottom, clamped so neither the dock nor the top view can vanish.
  const { width: dockH, startDrag: startDockDrag } = useResizable('sing-dock-h', 300, { min: 140, max: 2000, axis: 'y', containerRef: mainRef });

  // Panels that mount once and stay mounted — track which have ever been shown.
  const visited = useRef({});
  if (PERSISTENT_VIEWS.includes(view)) visited.current[view] = true;

  // Remember the selected view across skin remounts + reloads.
  useEffect(() => { localStorage.setItem('sing-view', view); }, [view]);

  // Surface daemon 'error' frames as a toast (the provider owns no UI state).
  useEffect(() => registerError(setToast), [registerError]);

  const { moveTask, concludeTask, deleteHistory } = useTaskActions(setToast);

  // Distinct tags across live tasks + history — options for the task tags input.
  const tagOptions = useMemo(() => {
    const s = new Set();
    for (const t of tasks) (t.tags || []).forEach((x) => s.add(x));
    for (const h of taskHistory) (h.tags || []).forEach((x) => s.add(x));
    return [...s].sort();
  }, [tasks, taskHistory]);

  const toggleDock = () => setDockMin((m) => { const n = !m; localStorage.setItem('sing-dock-min', n ? '1' : '0'); return n; });
  // Starting a new session should reveal the Sessions dock even if the user had
  // it minimized — no-op if already expanded.
  const expandDock = () => setDockMin((m) => { if (!m) return m; localStorage.setItem('sing-dock-min', '0'); return false; });

  // A running claude process picks its TUI theme once at spawn (queried from the
  // terminal background) — xterm's palette flips live but a live session's colors
  // won't until it's respawned. Offer that after every theme toggle.
  const onToggleTheme = () => {
    toggleColorMode();
    const live = agents.filter((a) => isLive(a.status)).length;
    if (live) setRespawnCount(live);
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
      } catch { /* expected while the daemon is down */ }
    }
    setRestarting(false);
    setToast('Server did not come back — restart it manually.');
  };

  const liveCount = agents.filter((a) => isLive(a.status)).length;

  return (
    <Box ref={mainRef} sx={{ position: 'relative', height: '100dvh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {SkinBackground && <SkinBackground />}

      {/* Top row: sidebar + selected view. The terminal dock spans full width below. */}
      <Box sx={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <Sidebar
          collapsed={collapsed}
          setCollapsed={setCollapsed}
          view={view}
          setView={setView}
          onNewSession={() => setCreateOpen(true)}
          onOpenMenu={(e) => setMenuAnchor(e.currentTarget)}
        />

        {/* Selected view. Persistent views mount once (visited) and stay mounted
            (display:none when hidden); Tasks/Cron/Usage render on demand. */}
        <Box sx={(t) => ({ ...glass(t), position: 'relative', flex: 1, mt: 1.5, mx: 1.5, minWidth: 0, borderRadius: `${getTokens(t).radius.lg}px`, overflow: 'hidden', zIndex: getTokens(t).layers.content })}>
          <Suspense fallback={<Box sx={{ p: 3, color: 'text.secondary' }}>Loading…</Box>}>
            {visited.current.config && (
              <Box sx={{ display: view === 'config' ? 'block' : 'none', height: '100%' }}><ConfigEditor /></Box>
            )}
            {visited.current.hooks && (
              <Box sx={{ display: view === 'hooks' ? 'block' : 'none', height: '100%' }}><HooksEditor /></Box>
            )}
            {visited.current.rules && (
              <Box sx={{ display: view === 'rules' ? 'block' : 'none', height: '100%' }}><RulesPanel /></Box>
            )}
            {visited.current.memory && (
              <Box sx={{ display: view === 'memory' ? 'block' : 'none', height: '100%' }}><MemoryPanel /></Box>
            )}
            {visited.current.wiki && (
              <Box sx={{ display: view === 'wiki' ? 'block' : 'none', height: '100%' }}><WikiPanel /></Box>
            )}
            {visited.current.sessions && (
              <Box sx={{ display: view === 'sessions' ? 'block' : 'none', height: '100%' }}>
                <SessionHistory active={view === 'sessions'} sendMsg={sendMsg} registerChat={registerChat} />
              </Box>
            )}
            {view === 'usage' && <UsageView usage={usage} onRefresh={refreshUsage} />}
            {view === 'appearance' && <AppearanceView onToggleColorMode={onToggleTheme} />}
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

      <SessionDock
        dockMin={dockMin}
        toggleDock={toggleDock}
        dockH={dockH}
        startDockDrag={startDockDrag}
        listW={listW}
        expandDock={expandDock}
      />

      {picking && <DirPicker start={untildify(cwd)} onPick={(p) => { setCwd(p); setPicking(false); }} onClose={() => setPicking(false)} />}
      {procsOpen && <ProcessManager onClose={() => setProcsOpen(false)} />}

      <AppMenu
        anchorEl={menuAnchor}
        onClose={() => setMenuAnchor(null)}
        onNavigate={setView}
        onOpenProcesses={() => setProcsOpen(true)}
        onOpenRestart={() => setRestartOpen(true)}
        restarting={restarting}
      />

      {/* After a theme toggle, offer to respawn live sessions so their claude TUI
          re-queries the terminal background and matches the new theme. */}
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
          <Typography variant="body2">
            Restarting the server kills all {liveCount} running session{liveCount === 1 ? '' : 's'} (conversations are lost). Continue?
          </Typography>
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
        onSessionCreated={expandDock}
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
