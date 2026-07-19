import React, { useEffect, useState, useCallback } from 'react';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import SaveIcon from '@mui/icons-material/Save';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import BookIcon from '@mui/icons-material/Book';
import CodeMirror from '@uiw/react-codemirror';
import { markdown } from '@codemirror/lang-markdown';
import { EditorView } from '@codemirror/view';
import { StatusPill, SearchInput, useColorMode, EmptyState } from '@zapac/mui-theme';
import { cmTheme } from './cmTheme.js';
import { tildify, untildify } from './paths.js';
import { useResizable, ResizeHandle } from './useResizable.jsx';

export default function MemoryPanel() {
  const { mode } = useColorMode();
  const [q, setQ] = useState('');
  const [results, setResults] = useState(null); // search hits
  const [files, setFiles] = useState([]); // all memory files (browse)
  const [capped, setCapped] = useState(false);
  const [sel, setSel] = useState(null); // {path, project, file}
  const [collapsed, setCollapsed] = useState(false);
  const [content, setContent] = useState('');
  const [dirty, setDirty] = useState(false);
  const [loadingFile, setLoadingFile] = useState(false);
  const [msg, setMsg] = useState(null);
  const [err, setErr] = useState(null);
  const railW = useResizable('sing-memory-w', 340);

  useEffect(() => { fetch('/memory/files').then((r) => r.json()).then((d) => setFiles(d.files || [])).catch(() => setErr('failed to load memory files')); }, []);

  const search = useCallback(() => {
    if (!q.trim()) { setResults(null); return; }
    fetch(`/memory/search?q=${encodeURIComponent(q.trim())}`).then((r) => r.json()).then((d) => {
      setResults(d.results || []); setCapped(!!d.capped);
    });
  }, [q]);

  // Debounced search-as-you-type (search() clears results when q is empty).
  useEffect(() => { const id = setTimeout(search, 250); return () => clearTimeout(id); }, [q, search]);

  const open = (item) => {
    if (item.path === sel?.path) return;
    if (dirty && !window.confirm('Discard unsaved changes?')) return;
    setSel(item); setMsg(null); setLoadingFile(true);
    fetch(`/memory/file?path=${encodeURIComponent(untildify(item.path))}`).then((r) => r.json()).then((d) => {
      setContent(d.ok ? d.content : ''); setDirty(false);
      if (!d.ok) setMsg({ sev: 'error', text: d.error });
    }).finally(() => setLoadingFile(false));
  };

  const save = async () => {
    const r = await fetch('/memory/file', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: untildify(sel.path), content }),
    }).then((x) => x.json()).catch((e) => ({ ok: false, error: String(e) }));
    setMsg(r.ok ? { sev: 'success', text: 'Saved' } : { sev: 'error', text: r.error });
    if (r.ok) setDirty(false);
  };

  const showing = results ?? files;

  return (
    <Box sx={{ height: '100%', display: 'flex', minHeight: 0 }}>
      {/* left: search + list (collapsible) */}
      <Stack sx={(t) => ({ width: collapsed ? 40 : railW.width, flexShrink: 0, borderRight: `1px solid ${t.vars.palette.glass.stroke}`, minHeight: 0, transition: 'width .2s ease' })}>
        {collapsed ? (
          <IconButton size="small" onClick={() => setCollapsed(false)} sx={{ m: 0.5 }}><ChevronRightIcon /></IconButton>
        ) : (
          <>
            <Box sx={{ p: 1.5, pb: 0.5 }}>
              <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                <Box sx={{ flex: 1, minWidth: 0 }}><SearchInput placeholder="Search all memory…" value={q} onChange={setQ} shortcut="" /></Box>
                <IconButton size="small" onClick={() => setCollapsed(true)}><ChevronLeftIcon /></IconButton>
              </Stack>
              <Typography variant="code" sx={{ color: 'text.secondary', fontSize: 11, mt: 1, ml: 2, display: 'block' }}>
                {results ? `${results.length}${capped ? '+ (capped)' : ''} matches` : `${files.length} file${files.length === 1 ? '' : 's'}`}
              </Typography>
            </Box>
            <List dense sx={{ flex: 1, overflow: 'auto', px: 0.5, pt: 0 }}>
              {showing.map((it, i) => (
                <ListItemButton key={`${it.path}:${it.line ?? i}`} selected={sel?.path === it.path && !results} onClick={() => open(it)}
                  sx={{ borderRadius: (t) => `${t.zapac.radius.sm}px`, display: 'block', mb: 0.25 }}>
                  <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                    <StatusPill status="review">{it.project}</StatusPill>
                    <Typography variant="code" sx={{ fontSize: 11, position: 'relative', top: 3 }} noWrap>{it.file}{it.line ? `:${it.line}` : ''}</Typography>
                  </Stack>
                  {it.text && <Typography sx={{ fontSize: 12, color: 'text.secondary', mt: 0.5 }} noWrap>{it.text}</Typography>}
                </ListItemButton>
              ))}
              {showing.length === 0 && <Typography sx={{ p: 2, color: 'text.secondary', fontSize: 13 }}>{results ? 'No matches.' : (err || 'No memory files.')}</Typography>}
            </List>
          </>
        )}
      </Stack>
      {!collapsed && <ResizeHandle onMouseDown={railW.startDrag} />}

      {/* right: editor */}
      <Stack sx={{ flex: 1, minWidth: 0, minHeight: 0, p: 1.5 }} spacing={1}>
        {!sel ? (
          <Box sx={{ flex: 1, display: 'grid', placeItems: 'center' }}>
            <EmptyState icon={<BookIcon />} title="Select a file" description="Browse or search memory files on the left to view or edit here." />
          </Box>
        ) : loadingFile ? (
          <Box sx={{ flex: 1, display: 'grid', placeItems: 'center' }}>
            <Typography color="text.secondary">Loading…</Typography>
          </Box>
        ) : (
          <>
            <Typography variant="code" sx={{ color: 'text.secondary', fontSize: 11 }}>{tildify(sel.path)}</Typography>
            <Box sx={(t) => ({ flex: 1, minHeight: 0, overflow: 'auto', border: `1px solid ${t.vars.palette.glass.stroke}`, borderRadius: `${t.zapac.radius.sm}px` })}>
              <CodeMirror value={content} theme={mode === 'dark' ? 'dark' : 'light'} height="100%"
                extensions={[EditorView.lineWrapping, markdown(), cmTheme]} onChange={(v) => { setContent(v); setDirty(true); }} />
            </Box>
            <Stack direction="row" spacing={1.5} sx={{ mt: 1.5, alignItems: 'center' }}>
              {msg && <Typography color={msg.sev === 'error' ? 'error' : 'success.main'} sx={{ fontSize: 13 }}>{msg.text}</Typography>}
              <Box sx={{ flex: 1 }} />
              <Button size="small" variant="contained" startIcon={<SaveIcon />} sx={{ px: 2, '& .MuiButton-startIcon': { marginRight: 0.5 } }} onClick={save} disabled={!dirty}>Save</Button>
            </Stack>
          </>
        )}
      </Stack>
    </Box>
  );
}
