import { useEffect, useRef, useState } from 'react';
import { getTokens } from '@/theme/contract.js';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import Alert from '@mui/material/Alert';
import SnackbarContent from '@mui/material/SnackbarContent';
import AddIcon from '@mui/icons-material/Add';
import RefreshIcon from '@mui/icons-material/Refresh';
import FolderCopyIcon from '@mui/icons-material/FolderCopy';
import { EmptyState } from '@/components/EmptyState.jsx';
import DirPicker from '@/components/DirPicker.jsx';
import { untildify, repoName } from '@/lib/paths.js';
import ProjectCard from '@/features/projects/ProjectCard.jsx';
import { useThemeSkin } from '@/theme/index.js';
import { primaryBtn, PHOSPHOR_CONTROL_H } from '@/features/tasks/TasksBoard.jsx';
import { SNACK_GLASS } from '@/shell/shellStyles.js';

/**
 * Projects — tracked git repo toplevels, each showing its git status at a
 * glance. Header adds a folder (via DirPicker), refreshes every card's
 * status, and surfaces the "not a git repository" add error. No polling: a
 * card refreshes on mount, on add, and on refresh-all (gaps §Refresh).
 */
export default function ProjectsView() {
  const [projects, setProjects] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [dragId, setDragId] = useState(null);
  // One undo toast per delete, stacked (not replaced) — each carries the
  // deleted path and its pre-delete index so Undo can restore its slot.
  const [toasts, setToasts] = useState([]);
  const nextToastId = useRef(0);
  const toastTimers = useRef({});
  const { skinId } = useThemeSkin();
  const phosphor = skinId === 'phosphor';

  useEffect(() => () => { Object.values(toastTimers.current).forEach(clearTimeout); }, []);

  const dismissToast = (id) => {
    clearTimeout(toastTimers.current[id]);
    delete toastTimers.current[id];
    setToasts((ts) => ts.filter((t) => t.id !== id));
  };

  useEffect(() => {
    fetch('/api/projects').then((r) => r.json()).then((d) => setProjects(d.projects || [])).finally(() => setLoaded(true));
  }, []);

  const addProject = (path) => {
    setPicking(false);
    fetch('/api/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path }) })
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok || d.ok === false) { setError(d.error || 'Could not add project.'); return; }
        setError(null);
        setProjects(d.projects);
      })
      .catch(() => setError('Could not add project.'));
  };

  const removeProject = (path) => {
    const index = projects.indexOf(path);
    fetch('/api/projects', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path }) })
      .then((r) => r.json())
      .then((d) => {
        setProjects(d.projects);
        const id = ++nextToastId.current;
        setToasts((ts) => [...ts, { id, path, index }]);
        toastTimers.current[id] = setTimeout(() => dismissToast(id), 10000);
      })
      .catch(() => {});
  };

  // Undo one toast: re-add the path, then reinsert it into the CURRENT server
  // order (not the pre-delete `prev` snapshot — other cards may have been
  // deleted/reordered since) at its original index, clamped to the new length.
  const undoDelete = (toast) => {
    fetch('/api/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: toast.path }) })
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok || d.ok === false) throw new Error();
        const without = d.projects.filter((p) => p !== toast.path);
        const idx = Math.min(toast.index, without.length);
        const next = [...without.slice(0, idx), toast.path, ...without.slice(idx)];
        return fetch('/api/projects/order', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ paths: next }) })
          .then((r2) => r2.json())
          .then((d2) => {
            if (!d2.ok) throw new Error();
            setProjects(d2.projects);
            dismissToast(toast.id);
          });
      })
      .catch(() => setError('Could not restore project.'));
  };

  // Native HTML5 DnD (TasksBoard precedent) — drop moves `path` into the drop
  // target's slot (before it when dragging up, after it when dragging down, so
  // first and last are both reachable), optimistically, then persists; a
  // non-ok response rolls back.
  const handleDrop = (targetPath) => {
    const id = dragId;
    setDragId(null);
    if (!id || id === targetPath) return;
    const prev = projects;
    const without = prev.filter((p) => p !== id);
    const idx = without.indexOf(targetPath) + (prev.indexOf(id) < prev.indexOf(targetPath) ? 1 : 0);
    const next = [...without.slice(0, idx), id, ...without.slice(idx)];
    setProjects(next);
    fetch('/api/projects/order', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ paths: next }) })
      .then((r) => r.json())
      .then((d) => { if (!d.ok) setProjects(prev); })
      .catch(() => setProjects(prev));
  };

  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <Stack sx={{ borderBottom: (t) => `1px solid ${getTokens(t).glass.stroke}` }}>
        <Stack direction="row" spacing={1.5} sx={{ p: 2, pb: 1.5, alignItems: 'center', flexWrap: 'wrap', minHeight: 71 }}>
          <Typography sx={{ fontSize: 20, fontWeight: 600 }}>Projects</Typography>
          <Box sx={{ flex: 1 }} />
          <Button size="small" startIcon={<AddIcon />} onClick={() => setPicking(true)} sx={(t) => (phosphor ? { height: PHOSPHOR_CONTROL_H } : primaryBtn(t))}>
            Add folder
          </Button>
          <Tooltip title="Refresh all" disableInteractive>
            <IconButton size="small" aria-label="Refresh all" onClick={() => setRefreshKey((k) => k + 1)}><RefreshIcon fontSize="small" /></IconButton>
          </Tooltip>
        </Stack>
        {error && <Alert severity="error" role="alert" sx={{ mx: 2, mb: 1.5 }} onClose={() => setError(null)}>{error}</Alert>}
      </Stack>

      <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto', p: 2 }}>
        {!loaded ? (
          <Typography sx={{ color: 'text.secondary' }}>Loading…</Typography>
        ) : projects.length === 0 ? (
          <Box sx={{ py: 4, display: 'grid', placeItems: 'center' }}>
            <EmptyState icon={<FolderCopyIcon />} title="No projects yet" description="Add a folder to track its git status." />
          </Box>
        ) : (
          <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 2 }}>
            {projects.map((path) => (
              <ProjectCard
                key={path}
                path={path}
                refreshKey={refreshKey}
                onDelete={removeProject}
                onDragStart={() => setDragId(path)}
                onDragEnd={() => setDragId(null)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => handleDrop(path)}
              />
            ))}
          </Box>
        )}
      </Box>

      {picking && <DirPicker start={untildify('~')} onPick={addProject} onClose={() => setPicking(false)} />}

      {/* MUI Snackbar can't stack itself — a fixed-position column of
          SnackbarContent stands in so a delete during an open toast's window
          adds a second toast instead of replacing it. */}
      {toasts.length > 0 && (
        <Box
          sx={(t) => ({
            position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)',
            zIndex: t.zIndex.snackbar, display: 'flex', flexDirection: 'column', gap: 1, alignItems: 'center',
          })}
        >
          {toasts.map((toast) => (
            <SnackbarContent
              key={toast.id}
              sx={SNACK_GLASS}
              message={`Removed ${repoName(toast.path)}`}
              action={<Button size="small" variant="contained" onClick={() => undoDelete(toast)}>Undo</Button>}
            />
          ))}
        </Box>
      )}
    </Box>
  );
}
