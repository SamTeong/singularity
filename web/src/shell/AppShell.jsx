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
import CreateSessionDialog from '@/features/sessions/CreateSessionDialog.jsx';
import CreateTaskDialog from '@/features/tasks/CreateTaskDialog.jsx';
import CreateScheduledJobDialog from '@/features/automation/CreateScheduledJobDialog.jsx';
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
const StatusView = lazy(() => import('@/features/status/StatusView.jsx'));

// Views that mount once (on first visit) and stay mounted (display:none when
// hidden) so live CodeMirror + unsaved edits survive view switches.
const PERSISTENT_VIEWS = ['config', 'hooks', 'rules', 'memory', 'wiki', 'sessions'];

const isLive = (s) => s === 'running' || s === 'idle' || s === 'starting';
// Mirror of server isCodexModel: gpt-* id → codex-only model.
const isCodexModel = (m) => !!m && m.startsWith('gpt-');

// Glass snackbar content — MUI v9 dropped `ContentProps`, so this must go through
// slotProps.content or SnackbarContent keeps its default (mode-inverted) colours.
const SNACK_GLASS = (t) => ({ bgcolor: getTokens(t).glass.surface, color: 'text.primary', border: `1px solid ${getTokens(t).glass.stroke}`, backdropFilter: getTokens(t).glass.blur });

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
  const [createInitialSessionId, setCreateInitialSessionId] = useState('');
  const [createInitialModel, setCreateInitialModel] = useState('');
  const [createInitialScopes, setCreateInitialScopes] = useState([]);
  const [createInitialTool, setCreateInitialTool] = useState('');
  const [taskOpen, setTaskOpen] = useState(false);
  // false (closed) | true (create) | a cron job object (edit that row) — same
  // tri-state the Automation view uses for background defs.
  const [cronOpen, setCronOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  // Persisted so the selected view survives a skin switch (which remounts the
  // whole shell) and page reloads — otherwise switching theme bounces to Tasks.
  const [view, setView] = useState(() => localStorage.getItem('sing-view') || 'tasks');
  const [toast, setToast] = useState(null);
  const [txPrompt, setTxPrompt] = useState(null); // agent whose terminal hit scrollback top
  const [openTx, setOpenTx] = useState(null); // {project, id, cwd, mtime} handed to SessionHistory
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
  // Updated during render (React's documented "adjust state on prop change"
  // pattern) rather than a ref, since this set genuinely drives what renders below.
  const [visited, setVisited] = useState(() => new Set(PERSISTENT_VIEWS.includes(view) ? [view] : []));
  if (PERSISTENT_VIEWS.includes(view) && !visited.has(view)) {
    setVisited((s) => new Set(s).add(view));
  }

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
    setToast('Restarting the app…');
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
    setToast("The app didn't come back — please restart it yourself.");
  };

  // Open an agent's transcript in the Transcripts view — from the scrollback-top
  // prompt or a session row's action. No title: the agent's display title is a
  // truncated id, so let SessionHistory fall back to the full session id.
  // Codex agents: the registry id isn't the codex-minted thread uuid the
  // transcript is filed under, so resolve it server-side first (mirrors
  // buildSpawn's own discovery). That resolver only answers for agents still in
  // the registry, so fall back to the id itself — for a session resumed from
  // this view it already IS the thread uuid, and /session's own by-id lookup
  // covers it. Only a genuinely unknown id lands on "Transcript not found".
  const viewTranscript = async (a) => {
    if (a.tool === 'codex' || isCodexModel(a.model)) {
      const threadId = await fetch(`/session/codex-thread?id=${encodeURIComponent(a.id)}`)
        .then((r) => r.json()).then((d) => (d.ok ? d.threadId : null)).catch(() => null);
      setOpenTx({ project: '<codex>', id: threadId || a.id, cwd: a.cwd, source: 'codex', mtime: Date.now() });
      setView('sessions');
      setTxPrompt(null);
      return;
    }
    setOpenTx({ project: (a.cwd || '').replace(/[^a-zA-Z0-9]/g, '-'), id: a.id, cwd: a.cwd, mtime: Date.now() });
    setView('sessions');
    setTxPrompt(null);
  };

  // Resume a past session from the Transcripts view: prefill the new-agent
  // dialog with its id + cwd + last model + last skill-scopes + tool, then create.
  // Backend switches to --resume when the session log exists at cwd. Model is
  // the last used (from the transcript); skill-scopes come from the agent
  // registry (the transcript doesn't record them) — absent for non-Singularity sessions.
  const onResumeSession = (id, cwd, model, scopes, tool) => {
    setCwd(cwd);
    setCreateInitialSessionId(id);
    setCreateInitialModel(model || '');
    setCreateInitialScopes(Array.isArray(scopes) ? scopes : []);
    setCreateInitialTool(tool || 'claude');
    setCreateOpen(true);
  };

  const liveCount = agents.filter((a) => isLive(a.status)).length;
  // Live (running/idle/starting) dock agents by id — passed to SessionHistory so its
  // Resume button can disable when the transcript's session is already attached.
  const liveSessionIds = useMemo(() => new Set(agents.filter((a) => isLive(a.status)).map((a) => a.id)), [agents]);

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
            {visited.has('config') && (
              <Box sx={{ display: view === 'config' ? 'block' : 'none', height: '100%' }}><ConfigEditor /></Box>
            )}
            {visited.has('hooks') && (
              <Box sx={{ display: view === 'hooks' ? 'block' : 'none', height: '100%' }}><HooksEditor /></Box>
            )}
            {visited.has('rules') && (
              <Box sx={{ display: view === 'rules' ? 'block' : 'none', height: '100%' }}><RulesPanel /></Box>
            )}
            {visited.has('memory') && (
              <Box sx={{ display: view === 'memory' ? 'block' : 'none', height: '100%' }}><MemoryPanel /></Box>
            )}
            {visited.has('wiki') && (
              <Box sx={{ display: view === 'wiki' ? 'block' : 'none', height: '100%' }}><WikiPanel /></Box>
            )}
            {visited.has('sessions') && (
              <Box sx={{ display: view === 'sessions' ? 'block' : 'none', height: '100%' }}>
                <SessionHistory active={view === 'sessions'} sendMsg={sendMsg} registerChat={registerChat} openSession={openTx} onResume={onResumeSession} liveSessionIds={liveSessionIds} />
              </Box>
            )}
            {view === 'usage' && <UsageView usage={usage} onRefresh={refreshUsage} />}
            {view === 'appearance' && <AppearanceView onToggleColorMode={onToggleTheme} />}
            {view === 'status' && <StatusView />}
            {view === 'skills' && <SkillsPanel />}
            {view === 'cron' && <CronJobs crons={crons} agents={agents} background={background} recent={recent} cwd={cwd} setCwd={setCwd} onBrowse={() => setPicking(true)} onAdd={() => setCronOpen(true)} onEdit={setCronOpen} onToast={setToast} />}
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
        listW={listW}
        expandDock={expandDock}
        onTopReached={setTxPrompt}
        onViewTranscript={viewTranscript}
        onToast={setToast}
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
        <DialogTitle>Restart sessions to match the new theme?</DialogTitle>
        <DialogContent>
          <Typography variant="body2">
            You changed the theme. {respawnCount} running session{respawnCount === 1 ? '' : 's'} still show the old theme. Restart them to match?
          </Typography>
          <Typography variant="body2" sx={{ mt: 1, color: 'text.secondary' }}>
            This restarts each session — anything in progress right now will be interrupted, but the conversation history is kept. The session order may change.
          </Typography>
        </DialogContent>
        <DialogActions sx={{ px: 2, pb: 2, pt: 0.5 }}>
          <Button size="small" variant="secondary" sx={{ px: 2 }} onClick={() => setRespawnCount(0)}>Dismiss</Button>
          <Button size="small" sx={{ px: 2 }} variant="contained" onClick={() => { sendMsg({ t: 'respawnAll' }); setRespawnCount(0); }}>Restart</Button>
        </DialogActions>
      </Dialog>

      {/* Restart the server — respawns itself detached, killing every live session. */}
      <Dialog open={restartOpen} onClose={() => setRestartOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>Restart the app?</DialogTitle>
        <DialogContent>
          <Typography variant="body2">
            Restarting the app will end all {liveCount} running session{liveCount === 1 ? '' : 's'} and their conversations will be lost. Continue?
          </Typography>
        </DialogContent>
        <DialogActions sx={{ px: 2, pb: 2, pt: 0.5 }}>
          <Button size="small" variant="secondary" sx={{ px: 2 }} onClick={() => setRestartOpen(false)}>Cancel</Button>
          <Button size="small" sx={{ px: 2 }} variant="contained" onClick={doRestart}>Restart</Button>
        </DialogActions>
      </Dialog>

      <CreateSessionDialog
        open={createOpen}
        onClose={() => { setCreateOpen(false); setCreateInitialSessionId(''); setCreateInitialModel(''); setCreateInitialScopes([]); setCreateInitialTool(''); }}
        connected={connected}
        cwd={cwd}
        setCwd={setCwd}
        recent={recent}
        onBrowse={() => setPicking(true)}
        sendMsg={sendMsg}
        onSessionCreated={expandDock}
        initialSessionId={createInitialSessionId}
        initialModel={createInitialModel}
        initialScopes={createInitialScopes}
        initialTool={createInitialTool}
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

      <CreateScheduledJobDialog
        open={!!cronOpen}
        job={typeof cronOpen === 'object' ? cronOpen : null}
        onClose={() => setCronOpen(false)}
        cwd={cwd}
        setCwd={setCwd}
        recent={recent}
        onBrowse={() => setPicking(true)}
      />

      <Snackbar open={!!toast} autoHideDuration={5000} onClose={() => setToast(null)} message={toast} anchorOrigin={{ vertical: 'top', horizontal: 'center' }} slotProps={{ content: { sx: SNACK_GLASS } }} />

      {/* Offered when a terminal scrolls to the top of its (capped) scrollback. */}
      <Snackbar
        open={!!txPrompt}
        autoHideDuration={10000}
        onClose={() => setTxPrompt(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
        message="That's the start of what this terminal keeps. View the full transcript?"
        slotProps={{ content: { sx: SNACK_GLASS } }}
        action={
          <>
            <Button size="small" variant="secondary" onClick={() => setTxPrompt(null)}>Dismiss</Button>
            <Button size="small" variant="contained" onClick={() => viewTranscript(txPrompt)}>View transcript</Button>
          </>
        }
      />
    </Box>
  );
}
