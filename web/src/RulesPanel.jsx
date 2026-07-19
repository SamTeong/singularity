import React, { useEffect, useState, useMemo, useCallback } from 'react';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ClearIcon from '@mui/icons-material/Clear';
import GavelIcon from '@mui/icons-material/Gavel';
import CodeMirror from '@uiw/react-codemirror';
import { markdown } from '@codemirror/lang-markdown';
import { EditorView } from '@codemirror/view';
import { useColorMode, EmptyState } from '@zapac/mui-theme';
import { cmTheme } from './cmTheme.js';
import DirPicker from './DirPicker.jsx';
import { tildify, untildify } from './paths.js';
import Rail from './panelkit/Rail.jsx';
import RailSearch from './panelkit/RailSearch.jsx';
import SaveBar from './panelkit/SaveBar.jsx';
import { useRootList, normKey } from './panelkit/useRootList.js';

export default function RulesPanel() {
  const { mode } = useColorMode();
  const { roots, shownRoots, remember, forget } = useRootList('/rules');
  const [files, setFiles] = useState([]);
  const [q, setQ] = useState('');
  const [results, setResults] = useState(null); // search hits, null = browse
  const [sel, setSel] = useState(null); // {root, path, rel, file}
  const [content, setContent] = useState('');
  const [dirty, setDirty] = useState(false);
  const [loadingFile, setLoadingFile] = useState(false);
  const [picking, setPicking] = useState(false);
  const [msg, setMsg] = useState(null);

  // Refresh the browse list whenever the root list changes.
  useEffect(() => {
    if (!roots.length) { setFiles([]); return; }
    fetch('/rules/files', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roots }),
    }).then((r) => r.json()).then((d) => setFiles(d.files || [])).catch(() => setFiles([]));
  }, [roots]);

  // Debounced content search across rule roots (empty q → browse list).
  useEffect(() => {
    const term = q.trim();
    if (!term) { setResults(null); return; }
    const id = setTimeout(() => {
      fetch('/rules/search', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ roots, q: term }),
      }).then((r) => r.json()).then((d) => setResults(d.results || [])).catch(() => setResults([]));
    }, 250);
    return () => clearTimeout(id);
  }, [q, roots]);

  const open = (item) => {
    if (item.path === sel?.path) return;
    if (dirty && !window.confirm('Discard unsaved changes?')) return;
    setSel(item); setMsg(null); setLoadingFile(true);
    fetch(`/rules/file?path=${encodeURIComponent(untildify(item.path))}`).then((r) => r.json()).then((d) => {
      setContent(d.ok ? d.content : ''); setDirty(false);
      if (!d.ok) setMsg({ sev: 'error', text: d.error });
    }).finally(() => setLoadingFile(false));
  };

  // Stable extensions + onChange: @uiw/react-codemirror's reconfigure effect lists both
  // in its deps, so fresh identities each render reconfigure the editor and drop the
  // open Ctrl+F search panel (flash-close).
  const extensions = useMemo(() => [EditorView.lineWrapping, markdown(), cmTheme], []);
  const onChange = useCallback((v) => { setContent(v); setDirty(true); }, []);

  const save = async () => {
    const r = await fetch('/rules/file', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: untildify(sel.path), content }),
    }).then((x) => x.json()).catch((e) => ({ ok: false, error: String(e) }));
    setMsg(r.ok ? { sev: 'success', text: 'Saved' } : { sev: 'error', text: r.error });
    if (r.ok) setDirty(false);
  };

  // No /config/scan equivalent — a picked folder is added directly as a rule root.
  const pick = (p) => {
    if (dirty && !window.confirm('Discard unsaved changes?')) return;
    setPicking(false);
    remember([untildify(p)]);
  };

  // Group by normKey so a file's base and the shownRoots key match even across
  // ~ vs expanded-home or / vs \ variants.
  const filesByRoot = (root) => files.filter((f) => normKey(f.root) === normKey(root));

  return (
    <Box sx={{ display: 'flex', height: '100%', minHeight: 0 }}>
      <Rail storageKey="sing-rules-w" defaultWidth={300} collapsedTitle="Show rule paths">
        {({ collapse }) => (
          <>
            <Box sx={{ p: 1.5, pb: 0.5 }}>
              <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                <RailSearch placeholder="Search rules…" value={q} onChange={setQ} />
                <Tooltip title="Select root folder" placement="bottom" disableInteractive>
                  <IconButton size="small" onClick={() => { if (dirty && !window.confirm('Discard unsaved changes?')) return; setPicking(true); }}><FolderOpenIcon /></IconButton>
                </Tooltip>
                <IconButton size="small" onClick={collapse}><ChevronLeftIcon /></IconButton>
              </Stack>
            </Box>
            <List dense sx={{ flex: 1, minHeight: 0, overflow: 'auto', px: 0.5, pt: 0 }}>
              {results ? (
                <>
                  {results.map((it, i) => (
                    <ListItemButton key={`${it.path}:${it.line}:${i}`} selected={sel?.path === it.path} onClick={() => open(it)}
                      sx={{ borderRadius: (t) => `${t.zapac.radius.sm}px`, display: 'block', py: 0.5, mb: 0.25 }}>
                      <Typography variant="code" sx={{ fontSize: 11 }} noWrap title={it.path}>{tildify(it.path)}:{it.line}</Typography>
                      <Typography sx={{ fontSize: 12, color: 'text.secondary', mt: 0.5, fontFamily: 'monospace' }} noWrap>{it.text}</Typography>
                    </ListItemButton>
                  ))}
                  {results.length === 0 && <Typography color="text.secondary" sx={{ fontSize: 12, p: 1.5 }}>No matches.</Typography>}
                </>
              ) : (
                <>
                  {shownRoots.map((root) => (
                    <Box key={root} sx={{ mb: 0.5 }}>
                      <ListItemButton sx={{ borderRadius: (t) => `${t.zapac.radius.sm}px`, py: 0.25, '&:hover .del': { opacity: 1 } }}>
                        <ListItemText primary={tildify(root)} primaryTypographyProps={{ noWrap: true, title: root, sx: { fontFamily: 'monospace', fontSize: 12 } }} />
                        <IconButton className="del" size="small" aria-label="Remove from list" title="Remove from list"
                          onClick={(e) => { e.stopPropagation(); forget(root); }}
                          sx={{ opacity: 0, ml: 0.5, p: 0.25 }}>
                          <ClearIcon fontSize="small" />
                        </IconButton>
                      </ListItemButton>
                      {filesByRoot(root).map((f) => (
                        <ListItemButton key={f.path} selected={sel?.path === f.path} onClick={() => open(f)}
                          sx={{ borderRadius: (t) => `${t.zapac.radius.sm}px`, py: 0.25, pl: 3, mb: 0.25 }}>
                          <ListItemText primary={tildify(f.rel)} primaryTypographyProps={{ noWrap: true, title: f.path, sx: { fontSize: 12 } }} />
                        </ListItemButton>
                      ))}
                    </Box>
                  ))}
                  {shownRoots.length === 0 && <Typography color="text.secondary" sx={{ fontSize: 12, p: 1.5 }}>No rule paths.</Typography>}
                </>
              )}
            </List>
          </>
        )}
      </Rail>

      <Stack sx={{ flex: 1, minWidth: 0, minHeight: 0, p: 1.5 }} spacing={1}>
        {picking && <DirPicker start={untildify(roots[0] || '~')} onPick={pick} onClose={() => setPicking(false)} />}
        {!sel ? (
          <Box sx={{ flex: 1, display: 'grid', placeItems: 'center' }}>
            <EmptyState icon={<GavelIcon />} title="Select a rule" description="Browse on the left to view or edit here." />
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
                extensions={extensions} onChange={onChange} />
            </Box>
            <SaveBar msg={msg} disabled={!dirty} onSave={save} />
          </>
        )}
      </Stack>
    </Box>
  );
}
