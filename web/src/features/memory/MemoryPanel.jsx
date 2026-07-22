import { getTokens } from '@/theme/contract.js';
import React, { useEffect, useState, useCallback, useMemo } from 'react';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import BookIcon from '@mui/icons-material/Book';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import Tooltip from '@mui/material/Tooltip';
import DirPicker from '@/components/DirPicker.jsx';
import { markdown } from '@codemirror/lang-markdown';
import { EmptyState } from '@zapac/mui-theme';
import CmEditor from '@/components/CmEditor.jsx';
import DetailPane from '@/components/DetailPane.jsx';
import { tildify, untildify } from '@/lib/paths.js';
import Rail from '@/components/panelkit/Rail.jsx';
import RailSearch from '@/components/panelkit/RailSearch.jsx';
import RailGroupToggle from '@/components/panelkit/RailGroupToggle.jsx';
import SaveBar from '@/components/panelkit/SaveBar.jsx';

// Memory root persists across sessions on the daemon FS (survives browser cache
// clear). Default ~/.claude/projects; loaded from /memory/root on mount.
const DEFAULT_ROOT = '~/.claude/projects';

export default function MemoryPanel() {
  const [root, setRoot] = useState(DEFAULT_ROOT);
  const [picking, setPicking] = useState(false);
  const [q, setQ] = useState('');
  const [results, setResults] = useState(null); // search hits
  const [files, setFiles] = useState([]); // all memory files (browse)
  const [capped, setCapped] = useState(false);
  const [sel, setSel] = useState(null); // {path, project, file}
  const [content, setContent] = useState('');
  const [dirty, setDirty] = useState(false);
  const [loadingFile, setLoadingFile] = useState(false);
  const [msg, setMsg] = useState(null);
  const onChange = (v) => { setContent(v); setDirty(true); };
  const [err, setErr] = useState(null);

  // Load the FS-persisted root once on mount (files load via the [root] effect).
  useEffect(() => {
    fetch('/memory/root').then((r) => r.json()).then((d) => { if (d.root) setRoot(d.root); }).catch(() => {});
  }, []);

  useEffect(() => {
    fetch(`/memory/files?root=${encodeURIComponent(untildify(root))}`).then((r) => r.json()).then((d) => setFiles(d.files || [])).catch(() => setErr('failed to load memory files'));
  }, [root]);

  const search = useCallback(() => {
    if (!q.trim()) { setResults(null); return; }
    fetch(`/memory/search?q=${encodeURIComponent(q.trim())}&root=${encodeURIComponent(untildify(root))}`).then((r) => r.json()).then((d) => {
      setResults(d.results || []); setCapped(!!d.capped);
    });
  }, [q, root]);

  // Debounced search-as-you-type (search() clears results when q is empty).
  useEffect(() => { const id = setTimeout(search, 250); return () => clearTimeout(id); }, [q, search]);

  const open = (item) => {
    if (item.path === sel?.path) return;
    if (dirty && !window.confirm('Discard unsaved changes?')) return;
    setSel(item); setMsg(null); setLoadingFile(true);
    fetch(`/memory/file?path=${encodeURIComponent(untildify(item.path))}&root=${encodeURIComponent(untildify(root))}`).then((r) => r.json()).then((d) => {
      setContent(d.ok ? d.content : ''); setDirty(false);
      if (!d.ok) setMsg({ sev: 'error', text: d.error });
    }).finally(() => setLoadingFile(false));
  };

  const save = async () => {
    const r = await fetch('/memory/file', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: untildify(sel.path), content, root: untildify(root) }),
    }).then((x) => x.json()).catch((e) => ({ ok: false, error: String(e) }));
    setMsg(r.ok ? { sev: 'success', text: 'Saved' } : { sev: 'error', text: r.error });
    if (r.ok) setDirty(false);
  };

  const pickRoot = (p) => {
    setRoot(p); setPicking(false);
    fetch('/memory/root', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ root: p }) }).catch(() => {});
  };

  const showing = results ?? files;

  // Group rows by project folder (encoded cwd, e.g. c--git-myapp). Backend already
  // tags each row with `project`; this is a pure render grouping. Collapsed set
  // holds project names the user folded — default expanded (empty set).
  const [collapsed, setCollapsed] = useState(() => new Set());
  const toggleGroup = (p) => setCollapsed((s) => {
    const n = new Set(s);
    n.has(p) ? n.delete(p) : n.add(p);
    return n;
  });
  const groups = useMemo(() => {
    const m = new Map();
    for (const it of showing) {
      if (!m.has(it.project)) m.set(it.project, []);
      m.get(it.project).push(it);
    }
    return [...m].sort((a, b) => a[0].localeCompare(b[0]));
  }, [showing]);
  const allOpen = groups.length > 0 && groups.every(([p]) => !collapsed.has(p));
  const toggleAll = () => setCollapsed(allOpen ? new Set(groups.map(([p]) => p)) : new Set());

  return (
    <Box sx={{ height: '100%', display: 'flex', minHeight: 0 }}>
      <Rail storageKey="sing-memory-w" defaultWidth={340} collapsedTitle="Show memory files">
        {({ collapse }) => (
          <>
            <Box sx={{ p: 1.5, pb: 0.5 }}>
              <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                <RailSearch placeholder="Search memory…" value={q} onChange={setQ} />
                <RailGroupToggle allOpen={allOpen} onToggle={toggleAll} />
                <Tooltip title="Select memory folder" placement="bottom" disableInteractive>
                  <IconButton size="small" onClick={() => setPicking(true)}><FolderOpenIcon /></IconButton>
                </Tooltip>
                <IconButton size="small" onClick={collapse}><ChevronLeftIcon /></IconButton>
              </Stack>
              <Typography variant="code" sx={{ color: 'text.secondary', fontSize: 11, mt: 1, ml: 2, display: 'block' }} noWrap>{tildify(root)}</Typography>
              <Typography variant="code" sx={{ color: 'text.secondary', fontSize: 11, ml: 2, display: 'block' }}>
                {results ? `${results.length}${capped ? '+ (capped)' : ''} matches` : `${files.length} file${files.length === 1 ? '' : 's'}`}
              </Typography>
            </Box>
            <List dense sx={{ flex: 1, overflow: 'auto', px: 0.5, pt: 0 }}>
              {groups.map(([project, items]) => {
                const isCol = collapsed.has(project);
                return (
                  <Box key={project}>
                    <ListItemButton onClick={() => toggleGroup(project)}
                      sx={{ borderRadius: (t) => `${getTokens(t).radius.sm}px`, mb: 0.25 }}>
                      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', width: '100%' }}>
                        {isCol ? <ChevronRightIcon fontSize="small" color="action" /> : <ExpandMoreIcon fontSize="small" color="action" />}
                        <FolderOpenIcon fontSize="small" color="action" />
                        <Typography variant="code" sx={{ fontSize: 12 }} noWrap>{project}</Typography>
                        <Typography variant="code" sx={{ fontSize: 11, color: 'text.secondary', ml: 'auto' }}>{items.length}</Typography>
                      </Stack>
                    </ListItemButton>
                    {!isCol && items.map((it, i) => (
                      <ListItemButton key={`${it.path}:${it.line ?? i}`} selected={sel?.path === it.path && !results} onClick={() => open(it)}
                        sx={{ borderRadius: (t) => `${getTokens(t).radius.sm}px`, display: 'block', mb: 0.25, pl: 4 }}>
                        <Typography variant="code" sx={{ fontSize: 11, position: 'relative', top: 3 }} noWrap>{it.file}{it.line ? `:${it.line}` : ''}</Typography>
                        {it.text && <Typography sx={{ fontSize: 12, color: 'text.secondary', mt: 0.5 }} noWrap>{it.text}</Typography>}
                      </ListItemButton>
                    ))}
                  </Box>
                );
              })}
              {showing.length === 0 && <Typography sx={{ p: 2, color: 'text.secondary', fontSize: 13 }}>{results ? 'No matches.' : (err || 'No memory files.')}</Typography>}
            </List>
          </>
        )}
      </Rail>

      {/* right: editor */}
      <Stack sx={{ flex: 1, minWidth: 0, minHeight: 0, p: 1.5 }} spacing={1}>
        <DetailPane
          empty={!sel && <EmptyState icon={<BookIcon />} title="Select a memory" description="Browse on the left to view or edit here." />}
          loading={loadingFile}
        >
          <Typography variant="code" sx={{ color: 'text.secondary', fontSize: 11 }}>{tildify(sel?.path)}</Typography>
          <CmEditor value={content} onChange={onChange} extensions={[markdown()]} />
          <SaveBar msg={msg} disabled={!dirty} onSave={save} />
        </DetailPane>
      </Stack>

      {picking && <DirPicker start={untildify(root)} onPick={pickRoot} onClose={() => setPicking(false)} />}
    </Box>
  );
}
