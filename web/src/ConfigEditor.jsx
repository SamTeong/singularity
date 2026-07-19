import React, { useEffect, useState, useMemo } from 'react';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Tabs from '@mui/material/Tabs';
import Tab from '@mui/material/Tab';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import SaveIcon from '@mui/icons-material/Save';
import CodeMirror from '@uiw/react-codemirror';
import { json } from '@codemirror/lang-json';
import { EditorView } from '@codemirror/view';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import { useColorMode, SearchInput } from '@zapac/mui-theme';
import { cmTheme } from './cmTheme.js';
import DirPicker from './DirPicker.jsx';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import { tildify, untildify } from './paths.js';
import { useResizable, ResizeHandle } from './useResizable.jsx';

const SCOPES = [
  { key: 'project', label: 'settings.json' },
  { key: 'local', label: 'settings.local.json' },
];

export default function ConfigEditor() {
  const { mode } = useColorMode();
  const [cwd, setCwd] = useState('~');
  const [picking, setPicking] = useState(false);
  const [data, setData] = useState(null);
  const [loadedCwd, setLoadedCwd] = useState(null);
  const [loading, setLoading] = useState(false);
  const [scope, setScope] = useState('project');
  const [content, setContent] = useState('');
  const [dirty, setDirty] = useState(false);
  const [msg, setMsg] = useState(null);
  const [configList, setConfigList] = useState(['~']);
  const [q, setQ] = useState('');
  const [results, setResults] = useState(null); // content-search hits, null = show config list
  const [collapsed, setCollapsed] = useState(false);
  const railW = useResizable('sing-config-w', 300);

  // Load the FS-persisted root list once on mount.
  useEffect(() => {
    fetch('/config/roots').then((r) => r.json()).then((d) => { if (d.roots?.length) setConfigList(d.roots); }).catch(() => {});
  }, []);

  // Merge paths into the list (MRU-first, deduped, capped) and persist to FS.
  const remember = (paths) => setConfigList((prev) => {
    const next = [...new Set([...paths, ...prev])].slice(0, 50);
    fetch('/config/roots', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roots: next }),
    }).catch(() => {});
    return next;
  });

  const load = () => {
    if (!cwd) return;
    const full = untildify(cwd);
    setLoading(true);
    fetch(`/config?cwd=${encodeURIComponent(full)}`).then((r) => r.json()).then((d) => {
      setData(d);
      setLoadedCwd(full);
      setContent(d[scope]?.content ?? '');
      setDirty(false); setMsg(null);
      remember([full]);
    }).catch((e) => setMsg({ sev: 'error', text: String(e) })).finally(() => setLoading(false));
  };
  useEffect(() => { if (dirty && !window.confirm('Discard unsaved changes?')) return; load(); /* eslint-disable-line */ }, [cwd]);
  useEffect(() => { if (data) { setContent(data[scope]?.content ?? ''); setDirty(false); setMsg(null); } }, [scope, data]);

  // Debounced content search across config roots' settings files (empty q → config list).
  useEffect(() => {
    const term = q.trim();
    if (!term) { setResults(null); return; }
    const id = setTimeout(() => {
      fetch('/config/search', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ roots: configList, q: term }),
      }).then((r) => r.json()).then((d) => setResults(d.results || [])).catch(() => setResults([]));
    }, 250);
    return () => clearTimeout(id);
  }, [q, configList]);

  const openResult = (it) => {
    if (dirty && !window.confirm('Discard unsaved changes?')) return;
    setScope(it.scope);
    setCwd(it.cwd);
  };

  const jsonError = useMemo(() => {
    if (!content.trim()) return null;
    try { JSON.parse(content); return null; } catch (e) { return e.message; }
  }, [content]);

  const info = data?.[scope];

  const save = async () => {
    const r = await fetch(`/config/${scope}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: loadedCwd, content }),
    }).then((x) => x.json()).catch((e) => ({ ok: false, error: String(e) }));
    if (r.ok) { setMsg({ sev: 'success', text: `Saved${r.backup ? ' (.bak written)' : ''}` }); setDirty(false); load(); }
    else setMsg({ sev: 'error', text: r.error || 'save failed' });
  };

  const pick = (p) => {
    if (dirty && !window.confirm('Discard unsaved changes?')) return;
    setCwd(p); setPicking(false);
    // Recursively find nested roots (e.g. ~/wiki/sub/.claude/settings.json) and
    // fold them into the config list so they become pickable.
    fetch(`/config/scan?root=${encodeURIComponent(untildify(p))}`).then((r) => r.json()).then((d) => {
      const found = d.roots || [];
      if (found.length) remember(found);
      if (d.truncated) setMsg({ sev: 'info', text: 'Scan hit cap — some subfolders skipped.' });
    }).catch(() => {});
  };
  // Dedup on a normalized key (tildified, forward slashes, lowercased) so `~`
  // and its expanded home path, or `/` vs `\`, don't show as separate entries.
  const shownList = [...new Map(
    configList.map((p) => [tildify(p).replace(/\\/g, '/').toLowerCase(), p]),
  ).values()].sort((a, b) => a.localeCompare(b));

  if (loading && !data) return <Box sx={{ p: 3 }}><Typography color="text.secondary">Loading config…</Typography></Box>;

  return (
    <Box sx={{ display: 'flex', height: '100%', minHeight: 0 }}>
      <Stack sx={(t) => ({ width: collapsed ? 40 : railW.width, flexShrink: 0, borderRight: `1px solid ${t.vars.palette.glass.stroke}`, minHeight: 0, transition: 'width .2s ease' })}>
        {collapsed ? (
          <Tooltip title="Show config paths" placement="right" disableInteractive>
            <IconButton size="small" onClick={() => setCollapsed(false)} sx={{ m: 0.5 }}><ChevronRightIcon /></IconButton>
          </Tooltip>
        ) : (
          <>
            <Box sx={{ p: 1.5, pb: 0.5 }}>
              <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                <Box sx={{ flex: 1, minWidth: 0 }}><SearchInput placeholder="Search config" value={q} onChange={setQ} shortcut="" sx={{ minWidth: 0 }} /></Box>
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
                    <ListItemButton key={`${it.path}:${i}`} selected={it.cwd === loadedCwd && it.scope === scope} onClick={() => openResult(it)}
                      sx={{ borderRadius: (t) => `${t.zapac.radius.sm}px`, display: 'block', py: 0.5, mb: 0.25 }}>
                      <Typography variant="code" sx={{ fontSize: 11 }} noWrap title={it.path}>{tildify(it.path)}:{it.line}</Typography>
                      <Typography sx={{ fontSize: 12, color: 'text.secondary', mt: 0.5, fontFamily: 'monospace' }} noWrap>{it.text}</Typography>
                    </ListItemButton>
                  ))}
                  {results.length === 0 && <Typography color="text.secondary" sx={{ fontSize: 12, p: 1.5 }}>No matches.</Typography>}
                </>
              ) : (
                <>
                  {shownList.map((p) => (
                    <ListItemButton key={p} selected={p === loadedCwd} onClick={() => { if (dirty && !window.confirm('Discard unsaved changes?')) return; setCwd(p); }}
                      sx={{ borderRadius: (t) => `${t.zapac.radius.sm}px`, py: 0.25, mb: 0.25 }}>
                      <ListItemText primary={tildify(p)} primaryTypographyProps={{ noWrap: true, title: p, sx: { fontFamily: 'monospace', fontSize: 12 } }} />
                    </ListItemButton>
                  ))}
                  {shownList.length === 0 && <Typography color="text.secondary" sx={{ fontSize: 12, p: 1.5 }}>No config paths.</Typography>}
                </>
              )}
            </List>
          </>
        )}
      </Stack>
      {!collapsed && <ResizeHandle onMouseDown={railW.startDrag} />}

    <Stack sx={{ flex: 1, minWidth: 0, height: '100%', p: 2, minHeight: 0 }} spacing={1.5}>
      <Tabs value={scope} onChange={(_, v) => { if (dirty && !window.confirm('Discard unsaved changes?')) return; setScope(v); }} variant="fullWidth">
        {SCOPES.map((s) => <Tab key={s.key} value={s.key} label={s.label} />)}
      </Tabs>

      <Typography noWrap variant="code" sx={{ flexShrink: 0, color: 'text.secondary', fontSize: 11 }}>
        {tildify(info?.path)} {info && !info.exists && '· (does not exist — save creates it)'}
      </Typography>
      {picking && <DirPicker start={untildify(cwd)} onPick={pick} onClose={() => setPicking(false)} />}

      <Box sx={(t) => ({ flex: 1, minHeight: 0, overflow: 'auto', border: `1px solid ${t.vars.palette.glass.stroke}`, borderRadius: `${t.zapac.radius.sm}px` })}>
        <CodeMirror
          value={content}
          theme={mode === 'dark' ? 'dark' : 'light'}
          height="100%"
          extensions={[EditorView.lineWrapping, json(), cmTheme]}
          onChange={(v) => { setContent(v); setDirty(true); }}
        />
      </Box>

      <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
        {jsonError && <Typography color="error" variant="code" sx={{ fontSize: 12 }}>invalid JSON: {jsonError}</Typography>}
        {msg && !jsonError && <Typography color={msg.sev === 'error' ? 'error' : 'success.main'} sx={{ fontSize: 13 }}>{msg.text}</Typography>}
        <Box sx={{ flex: 1 }} />
        <Button size="small" variant="contained" startIcon={<SaveIcon />} sx={{ px: 2, '& .MuiButton-startIcon': { marginRight: 0.5 } }} onClick={save} disabled={!dirty || !!jsonError}>Save</Button>
      </Stack>
    </Stack>
    </Box>
  );
}
