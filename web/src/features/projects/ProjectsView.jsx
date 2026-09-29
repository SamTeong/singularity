import { useCallback, useEffect, useRef, useState } from 'react';
import { getTokens } from '@/theme/contract.js';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import useMediaQuery from '@mui/material/useMediaQuery';
import Alert from '@mui/material/Alert';
import AddIcon from '@mui/icons-material/Add';
import RefreshIcon from '@mui/icons-material/Refresh';
import UnfoldLessIcon from '@mui/icons-material/UnfoldLess';
import UnfoldMoreIcon from '@mui/icons-material/UnfoldMore';
import FolderCopyIcon from '@mui/icons-material/FolderCopy';
import { EmptyState } from '@/components/EmptyState.jsx';
import DirPicker from '@/components/DirPicker.jsx';
import { untildify, repoName } from '@/lib/paths.js';
import ProjectCard from '@/features/projects/ProjectCard.jsx';
import { useThemeSkin } from '@/theme/index.js';
import { primaryBtn, PHOSPHOR_CONTROL_H } from '@/features/tasks/TasksBoard.jsx';
import { PHONE_QUERY, TABLET_QUERY } from '@/shell/breakpoints.js';


/**
 * Projects — tracked git repo toplevels, each showing its git status at a
 * glance. Header adds a folder (via DirPicker), refreshes every card's
 * status, and surfaces the "not a git repository" add error. No polling: a
 * card refreshes on mount, on add, and on refresh-all (gaps §Refresh).
 */
export default function ProjectsView({ onToast, dismissToast }) {
  const [projects, setProjects] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [expandAll, setExpandAll] = useState({ on: false, n: 0 });
  const [dragId, setDragId] = useState(null);
  // Undo metadata stays here; the shell's shared host owns toast presentation.
  const [undoToasts, setUndoToasts] = useState([]);
  const undoToastIds = useRef(new Set());
  const refreshAll = useRef(null);
  const [refreshingAll, setRefreshingAll] = useState(false);
  const { skinId } = useThemeSkin();
  const phosphor = skinId === 'phosphor';
  const isPhone = useMediaQuery(PHONE_QUERY);
  const isTablet = useMediaQuery(TABLET_QUERY);
  // Below 900px an HTML5 drag is not operable by touch, so the card's grip is
  // replaced by the compact Move pair (same phone||tablet switch as CronJobs).
  const narrow = isPhone || isTablet;

  useEffect(() => () => {
    for (const id of undoToastIds.current) dismissToast(id);
    undoToastIds.current.clear();
  }, [dismissToast]);

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
    const order = undoToasts[0]?.order || projects;
    fetch('/api/projects', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path }) })
      .then((r) => r.json())
      .then((d) => {
        setProjects(d.projects);
        const batch = refreshAll.current;
        if (batch) {
          batch.paths = batch.paths.filter((p) => p !== path);
          batch.results.delete(path);
          settleRefreshAll();
        }
        const toast = { id: null, path, order };
        const id = onToast(`Removed ${repoName(path)}`, {
          duration: 10000,
          action: <Button size="small" variant="contained" onClick={() => undoDelete({ ...toast, id })}>Undo</Button>,
          onDismiss: () => {
            undoToastIds.current.delete(id);
            setUndoToasts((ts) => ts.filter((t) => t.id !== id));
          },
        });
        toast.id = id;
        undoToastIds.current.add(id);
        setUndoToasts((ts) => [...ts, toast]);
      })
      .catch(() => {});
  };

  // Undo one toast: re-add the path, then reinsert it into the CURRENT server
  // order (not the pre-delete `prev` snapshot). Nearest surviving neighbors
  // from the shared delete-stack order keep stacked removals in saved order.
  const undoDelete = (toast) => {
    fetch('/api/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: toast.path }) })
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok || d.ok === false) throw new Error();
        const without = d.projects.filter((p) => p !== toast.path);
        const orderIndex = toast.order.indexOf(toast.path);
        let index = -1;
        for (let i = orderIndex - 1; i >= 0; i--) {
          const neighborIndex = without.indexOf(toast.order[i]);
          if (neighborIndex >= 0) { index = neighborIndex + 1; break; }
        }
        if (index < 0) {
          for (let i = orderIndex + 1; i < toast.order.length; i++) {
            const neighborIndex = without.indexOf(toast.order[i]);
            if (neighborIndex >= 0) { index = neighborIndex; break; }
          }
        }
        if (index < 0) index = Math.min(Math.max(orderIndex, 0), without.length);
        const next = [...without.slice(0, index), toast.path, ...without.slice(index)];
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

  const settleRefreshAll = useCallback(() => {
    const batch = refreshAll.current;
    if (!batch || batch.results.size !== batch.paths.length) return;
    refreshAll.current = null;
    setRefreshingAll(false);
    const failed = [...batch.results].filter(([, outcome]) => !outcome.ok);
    onToast(failed.length
      ? `Refresh all failed: ${failed.map(([p, outcome]) => `${repoName(p)}: ${outcome.error}`).join('; ')}`
      : 'All projects refreshed');
  }, [onToast]);

  const onRefreshResult = useCallback((generation, path, result) => {
    const batch = refreshAll.current;
    if (!batch || batch.generation !== generation || !batch.paths.includes(path)) return;
    batch.results.set(path, result);
    settleRefreshAll();
  }, [settleRefreshAll]);

  const refreshAllProjects = () => {
    const generation = refreshKey + 1;
    const paths = [...projects];
    if (!paths.length) { onToast('All projects refreshed'); return; }
    refreshAll.current = { generation, paths, results: new Map() };
    setRefreshingAll(true);
    setRefreshKey(generation);
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

  // Narrow-viewport equivalent of the grip drag — adjacent swap, persisted the
  // same way (PUT /api/projects/order, rolled back on a non-ok response).
  const moveCard = (from, dir) => {
    const to = from + dir;
    if (to < 0 || to >= projects.length) return;
    const prev = projects;
    const next = [...prev];
    [next[from], next[to]] = [next[to], next[from]];
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
          <Tooltip title={expandAll.on ? 'Collapse all' : 'Expand all'} disableInteractive>
            <IconButton
              size="small"
              aria-label={expandAll.on ? 'Collapse all' : 'Expand all'}
              aria-pressed={expandAll.on}
              onClick={() => setExpandAll((s) => ({ on: !s.on, n: s.n + 1 }))}
            >
              {expandAll.on ? <UnfoldLessIcon fontSize="small" /> : <UnfoldMoreIcon fontSize="small" />}
            </IconButton>
          </Tooltip>
          <Tooltip title="Refresh all" disableInteractive>
          <IconButton size="small" aria-label="Refresh all" disabled={refreshingAll} onClick={refreshAllProjects}><RefreshIcon fontSize="small" /></IconButton>
          </Tooltip>
          <Button size="small" startIcon={<AddIcon />} onClick={() => setPicking(true)} sx={(t) => (phosphor ? { height: PHOSPHOR_CONTROL_H } : primaryBtn(t))}>
            Add folder
          </Button>
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
            {projects.map((path, i) => (
              <ProjectCard
                key={path}
                path={path}
                refreshKey={refreshKey}
                onToast={onToast}
                onRefreshResult={onRefreshResult}
                expandAll={expandAll}
                onDelete={removeProject}
                narrow={narrow}
                onMove={(dir) => moveCard(i, dir)}
                canUp={i > 0}
                canDown={i < projects.length - 1}
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

    </Box>
  );
}
