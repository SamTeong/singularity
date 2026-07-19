import React, { useEffect, useState, useMemo, useCallback } from 'react';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import SaveIcon from '@mui/icons-material/Save';
import CodeMirror from '@uiw/react-codemirror';
import { json } from '@codemirror/lang-json';
import { javascript } from '@codemirror/lang-javascript';
import { EditorView } from '@codemirror/view';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import { useColorMode, SearchInput } from '@zapac/mui-theme';
import { cmTheme } from './cmTheme.js';
import DirPicker from './DirPicker.jsx';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import ClearIcon from '@mui/icons-material/Clear';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import ListSubheader from '@mui/material/ListSubheader';
import { tildify, untildify } from './paths.js';
import { useResizable, ResizeHandle } from './useResizable.jsx';

// Language extension per file extension: JS family → javascript(), .json → json(),
// everything else (.ps1/.sh/…) → plain (no lang extension).
function langFor(path) {
  const ext = (path || '').toLowerCase().split('.').pop();
  if (ext === 'mjs' || ext === 'js' || ext === 'cjs') return javascript();
  if (ext === 'json') return json();
  return null;
}

export default function HooksEditor() {
  const { mode } = useColorMode();
  const [picking, setPicking] = useState(false);
  const [rootList, setRootList] = useState(['~']);
  const [groups, setGroups] = useState([]); // [{ cwd, files:[{path,rel,name}] }]
  const [path, setPath] = useState(null); // selected file path
  const [content, setContent] = useState('');
  const [dirty, setDirty] = useState(false);
  const [msg, setMsg] = useState(null);
  const [q, setQ] = useState('');
  const [results, setResults] = useState(null); // content-search hits, null = show file list
  const [collapsed, setCollapsed] = useState(false);
  const railW = useResizable('sing-hooks-w', 300);

  // Load the FS-persisted root list once on mount.
  useEffect(() => {
    fetch('/hooks/roots').then((r) => r.json()).then((d) => { if (d.roots?.length) setRootList(d.roots); }).catch(() => {});
  }, []);

  // Fetch grouped hook files whenever the root list changes.
  useEffect(() => {
    fetch('/hooks/list', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roots: rootList.map(untildify) }),
    }).then((r) => r.json()).then((d) => setGroups(d.groups || [])).catch(() => setGroups([]));
  }, [rootList]);

  // Merge paths into the root list (MRU-first, deduped, capped) and persist to FS.
  const remember = (paths) => setRootList((prev) => {
    const next = [...new Set([...paths, ...prev])].slice(0, 50);
    fetch('/hooks/roots', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roots: next }),
    }).catch(() => {});
    return next;
  });

  // Drop a root from the list and persist to FS.
  const normKey = (p) => tildify(p).replace(/\\/g, '/').toLowerCase();

  // Dedup groups on normalized cwd (~ vs expanded home, / vs \) — picking home
  // while ~ is present otherwise renders two identical groups. First-seen wins,
  // order preserved (mirrors ConfigEditor's shownList dedup).
  const shownGroups = useMemo(() => {
    const seen = new Set();
    return groups.filter((g) => {
      const k = normKey(g.cwd);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }, [groups]);
  const forget = (p) => setRootList((prev) => {
    const k = normKey(p);
    const next = prev.filter((x) => normKey(x) !== k);
    fetch('/hooks/roots', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roots: next }),
    }).catch(() => {});
    return next;
  });

  const loadFile = (p) => {
    if (dirty && !window.confirm('Discard unsaved changes?')) return;
    fetch(`/hooks/file?path=${encodeURIComponent(p)}`).then((r) => r.json()).then((d) => {
      setPath(p);
      setContent(d.content ?? '');
      setDirty(false); setMsg(null);
    }).catch((e) => setMsg({ sev: 'error', text: String(e) }));
  };

  // Debounced content search across hook roots' files (empty q → file list).
  useEffect(() => {
    const term = q.trim();
    if (!term) { setResults(null); return; }
    const id = setTimeout(() => {
      fetch('/hooks/search', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ roots: rootList.map(untildify), q: term }),
      }).then((r) => r.json()).then((d) => setResults(d.results || [])).catch(() => setResults([]));
    }, 250);
    return () => clearTimeout(id);
  }, [q, rootList]);

  // Stable extensions: a fresh array/lang() each render makes @uiw/react-codemirror
  // reconfigure the editor, dropping the open Ctrl+F search panel (flash-close).
  // Recompute only when the selected file's extension changes.
  const extensions = useMemo(() => {
    const lang = langFor(path);
    return lang ? [EditorView.lineWrapping, lang, cmTheme] : [EditorView.lineWrapping, cmTheme];
  }, [path]);
  // Stable onChange too: @uiw's reconfigure effect lists onChange in its deps.
  const onChange = useCallback((v) => { setContent(v); setDirty(true); }, []);

  const save = async () => {
    const r = await fetch('/hooks/file', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path, content }),
    }).then((x) => x.json()).catch((e) => ({ ok: false, error: String(e) }));
    if (r.ok) { setMsg({ sev: 'success', text: `Saved${r.backup ? ' (.bak written)' : ''}` }); setDirty(false); }
    else setMsg({ sev: 'error', text: r.error || 'save failed' });
  };

  const pick = (p) => {
    if (dirty && !window.confirm('Discard unsaved changes?')) return;
    setPicking(false);
    remember([p]);
  };

  return (
    <Box sx={{ display: 'flex', height: '100%', minHeight: 0 }}>
      <Stack sx={(t) => ({ width: collapsed ? 40 : railW.width, flexShrink: 0, borderRight: `1px solid ${t.vars.palette.glass.stroke}`, minHeight: 0, transition: 'width .2s ease' })}>
        {collapsed ? (
          <Tooltip title="Show hook files" placement="right" disableInteractive>
            <IconButton size="small" onClick={() => setCollapsed(false)} sx={{ m: 0.5 }}><ChevronRightIcon /></IconButton>
          </Tooltip>
        ) : (
          <>
            <Box sx={{ p: 1.5, pb: 0.5 }}>
              <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                <Box sx={{ flex: 1, minWidth: 0, position: 'relative' }}>
                  <SearchInput placeholder="Search hooks…" value={q} onChange={setQ} shortcut="" sx={{ minWidth: 0 }} />
                  {q && (
                    <IconButton size="small" onClick={() => setQ('')} aria-label="Clear search"
                      sx={{ position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)', '&:hover': { transform: 'translateY(-50%)' } }}>
                      <ClearIcon fontSize="small" />
                    </IconButton>
                  )}
                </Box>
                <Tooltip title="Select root folder" placement="bottom" disableInteractive>
                  <IconButton size="small" onClick={() => { if (dirty && !window.confirm('Discard unsaved changes?')) return; setPicking(true); }}><FolderOpenIcon /></IconButton>
                </Tooltip>
                <IconButton size="small" onClick={() => setCollapsed(true)}><ChevronLeftIcon /></IconButton>
              </Stack>
            </Box>
            <List dense sx={{ flex: 1, minHeight: 0, overflow: 'auto', px: 0.5, pt: 0 }}>
              {results ? (
                <>
                  {results.map((it, i) => (
                    <ListItemButton key={`${it.path}:${i}`} selected={it.path === path} onClick={() => loadFile(it.path)}
                      sx={{ borderRadius: (t) => `${t.zapac.radius.sm}px`, display: 'block', py: 0.5, mb: 0.25 }}>
                      <Typography variant="code" sx={{ fontSize: 11 }} noWrap title={it.path}>{tildify(it.path)}:{it.line}</Typography>
                      <Typography sx={{ fontSize: 12, color: 'text.secondary', mt: 0.5, fontFamily: 'monospace' }} noWrap>{it.text}</Typography>
                    </ListItemButton>
                  ))}
                  {results.length === 0 && <Typography color="text.secondary" sx={{ fontSize: 12, p: 1.5 }}>No matches.</Typography>}
                </>
              ) : (
                <>
                  {shownGroups.map((g) => (
                    <React.Fragment key={g.cwd}>
                      <ListSubheader disableSticky sx={{ bgcolor: 'transparent', lineHeight: '28px', px: 1, '&:hover .del': { opacity: 1 } }}>
                        <Stack direction="row" sx={{ alignItems: 'center' }}>
                          <Typography noWrap title={g.cwd} sx={{ flex: 1, minWidth: 0, fontFamily: 'monospace', fontSize: 11, color: 'text.secondary' }}>{tildify(g.cwd)}</Typography>
                          <IconButton className="del" size="small" aria-label="Remove from list" title="Remove from list"
                            onClick={() => forget(g.cwd)} sx={{ opacity: 0, ml: 0.5, p: 0.25 }}>
                            <ClearIcon fontSize="small" />
                          </IconButton>
                        </Stack>
                      </ListSubheader>
                      {g.files.map((f) => (
                        <ListItemButton key={f.path} selected={f.path === path} onClick={() => loadFile(f.path)}
                          sx={{ borderRadius: (t) => `${t.zapac.radius.sm}px`, py: 0.25, mb: 0.25, pl: 2 }}>
                          <ListItemText primary={f.rel} primaryTypographyProps={{ noWrap: true, title: f.path, sx: { fontFamily: 'monospace', fontSize: 12 } }} />
                        </ListItemButton>
                      ))}
                      {g.files.length === 0 && <Typography color="text.secondary" sx={{ fontSize: 11, px: 2, py: 0.5 }}>No hooks.</Typography>}
                    </React.Fragment>
                  ))}
                  {shownGroups.length === 0 && <Typography color="text.secondary" sx={{ fontSize: 12, p: 1.5 }}>No hook roots.</Typography>}
                </>
              )}
            </List>
          </>
        )}
      </Stack>
      {!collapsed && <ResizeHandle onMouseDown={railW.startDrag} />}

    <Stack sx={{ flex: 1, minWidth: 0, height: '100%', p: 2, minHeight: 0 }} spacing={1.5}>
      <Typography noWrap variant="code" sx={{ flexShrink: 0, color: 'text.secondary', fontSize: 11 }}>
        {path ? tildify(path) : 'Select a hook file'}
      </Typography>
      {picking && <DirPicker start={untildify(rootList[0] || '~')} onPick={pick} onClose={() => setPicking(false)} />}

      <Box sx={(t) => ({ flex: 1, minHeight: 0, overflow: 'auto', border: `1px solid ${t.vars.palette.glass.stroke}`, borderRadius: `${t.zapac.radius.sm}px` })}>
        <CodeMirror
          value={content}
          theme={mode === 'dark' ? 'dark' : 'light'}
          height="100%"
          extensions={extensions}
          onChange={onChange}
          editable={!!path}
        />
      </Box>

      <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
        {msg && <Typography color={msg.sev === 'error' ? 'error' : 'success.main'} sx={{ fontSize: 13 }}>{msg.text}</Typography>}
        <Box sx={{ flex: 1 }} />
        <Button size="small" variant="contained" startIcon={<SaveIcon />} sx={{ px: 2, '& .MuiButton-startIcon': { marginRight: 0.5 } }} onClick={save} disabled={!dirty || !path}>Save</Button>
      </Stack>
    </Stack>
    </Box>
  );
}
