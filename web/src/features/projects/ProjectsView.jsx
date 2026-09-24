import { useEffect, useState } from 'react';
import { getTokens } from '@/theme/contract.js';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import Alert from '@mui/material/Alert';
import CreateNewFolderIcon from '@mui/icons-material/CreateNewFolder';
import RefreshIcon from '@mui/icons-material/Refresh';
import FolderCopyIcon from '@mui/icons-material/FolderCopy';
import { EmptyState } from '@/components/EmptyState.jsx';
import DirPicker from '@/components/DirPicker.jsx';
import { untildify } from '@/lib/paths.js';
import ProjectCard from '@/features/projects/ProjectCard.jsx';

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
    fetch('/api/projects', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path }) })
      .then((r) => r.json())
      .then((d) => setProjects(d.projects))
      .catch(() => {});
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
          <Button size="small" variant="outlined" startIcon={<CreateNewFolderIcon fontSize="small" />} onClick={() => setPicking(true)}>
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
                draggable
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
