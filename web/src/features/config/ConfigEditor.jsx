import { getTokens } from '@/theme/contract.js';
import React, { useEffect, useState, useMemo } from 'react';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Tabs from '@mui/material/Tabs';
import Tab from '@mui/material/Tab';
import Typography from '@mui/material/Typography';
import { json } from '@codemirror/lang-json';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import CmEditor from '@/components/CmEditor.jsx';
import DirPicker from '@/components/DirPicker.jsx';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ClearIcon from '@mui/icons-material/Clear';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import { tildify, untildify } from '@/lib/paths.js';
import Rail from '@/components/panelkit/Rail.jsx';
import RailSearch from '@/components/panelkit/RailSearch.jsx';
import SaveBar from '@/components/panelkit/SaveBar.jsx';
import { useRootList } from '@/components/panelkit/useRootList.js';

const SCOPES = [
  { key: 'project', label: 'settings.json' },
  { key: 'local', label: 'settings.local.json' },
];

export default function ConfigEditor() {
  const [cwd, setCwd] = useState('~');
  const [picking, setPicking] = useState(false);
  const [data, setData] = useState(null);
  const [loadedCwd, setLoadedCwd] = useState(null);
  const [loading, setLoading] = useState(false);
  const [scope, setScope] = useState('project');
  const [content, setContent] = useState('');
  const [dirty, setDirty] = useState(false);
  const [msg, setMsg] = useState(null);
  const { roots, shownRoots, remember, forget } = useRootList('/config', { initial: ['~'] });
  const [q, setQ] = useState('');
  const [results, setResults] = useState(null); // content-search hits, null = show config list

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
        body: JSON.stringify({ roots, q: term }),
      }).then((r) => r.json()).then((d) => setResults(d.results || [])).catch(() => setResults([]));
    }, 250);
    return () => clearTimeout(id);
  }, [q, roots]);

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

  const onChange = (v) => { setContent(v); setDirty(true); };

  const save = async () => {
    const r = await fetch(`/config/${scope}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: loadedCwd, content }),
    }).then((x) => x.json()).catch((e) => ({ ok: false, error: String(e) }));
    if (r.ok) { setMsg({ sev: 'success', text: `Saved${r.backup ? ' (backup made)' : ''}` }); setDirty(false); load(); }
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
      if (d.truncated) setMsg({ sev: 'info', text: 'Reached the folder limit — some subfolders were skipped.' });
    }).catch(() => {});
  };

  if (loading && !data) return <Box sx={{ p: 3 }}><Typography color="text.secondary">Loading config…</Typography></Box>;

  return (
    <Box sx={{ display: 'flex', height: '100%', minHeight: 0 }}>
      <Rail storageKey="sing-config-w" defaultWidth={300} collapsedTitle="Show config paths">
        {({ collapse }) => (
          <>
            <Box sx={{ p: 1.5, pb: 0.5 }}>
              <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                <RailSearch placeholder="Search config…" value={q} onChange={setQ} />
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
                    <ListItemButton key={`${it.path}:${i}`} selected={it.cwd === loadedCwd && it.scope === scope} onClick={() => openResult(it)}
                      sx={{ borderRadius: (t) => `${getTokens(t).radius.sm}px`, display: 'block', py: 0.5, mb: 0.25 }}>
                      <Typography variant="code" sx={{ fontSize: 11 }} noWrap title={it.path}>{tildify(it.path)}:{it.line}</Typography>
                      <Typography sx={{ fontSize: 12, color: 'text.secondary', mt: 0.5, fontFamily: 'monospace' }} noWrap>{it.text}</Typography>
                    </ListItemButton>
                  ))}
                  {results.length === 0 && <Typography color="text.secondary" sx={{ fontSize: 12, p: 1.5 }}>No matches.</Typography>}
                </>
              ) : (
                <>
                  {shownRoots.map((p) => (
                    <ListItemButton key={p} selected={p === loadedCwd} onClick={() => { if (dirty && !window.confirm('Discard unsaved changes?')) return; setCwd(p); }}
                      sx={{ borderRadius: (t) => `${getTokens(t).radius.sm}px`, py: 0.25, mb: 0.25, '&:hover .del': { opacity: 1 } }}>
                      <ListItemText primary={tildify(p)} slotProps={{ primary: { noWrap: true, title: p, sx: { fontFamily: 'monospace', fontSize: 12 } } }} />
                      <IconButton className="del" size="small" aria-label="Remove from list" title="Remove from list"
                        onClick={(e) => { e.stopPropagation(); forget(p); }}
                        sx={{ opacity: 0, ml: 0.5, p: 0.25 }}>
                        <ClearIcon fontSize="small" />
                      </IconButton>
                    </ListItemButton>
                  ))}
                  {shownRoots.length === 0 && <Typography color="text.secondary" sx={{ fontSize: 12, p: 1.5 }}>No config paths.</Typography>}
                </>
              )}
            </List>
          </>
        )}
      </Rail>

      <Stack sx={{ flex: 1, minWidth: 0, height: '100%', p: 2, minHeight: 0 }} spacing={1.5}>
        <Tabs value={scope} onChange={(_, v) => { if (dirty && !window.confirm('Discard unsaved changes?')) return; setScope(v); }} variant="fullWidth">
          {SCOPES.map((s) => <Tab key={s.key} value={s.key} label={s.label} />)}
        </Tabs>

        <Typography noWrap variant="code" sx={{ flexShrink: 0, color: 'text.secondary', fontSize: 11 }}>
          {tildify(info?.path)} {info && !info.exists && "· (doesn't exist yet — saving will create it)"}
        </Typography>
        {picking && <DirPicker start={untildify(cwd)} onPick={pick} onClose={() => setPicking(false)} />}

        <CmEditor value={content} onChange={onChange} extensions={[json()]} />

        <SaveBar msg={jsonError ? null : msg} disabled={!dirty || !!jsonError} onSave={save}>
          {jsonError && <Typography color="error" variant="code" sx={{ fontSize: 12 }}>This isn't valid JSON: {jsonError}</Typography>}
        </SaveBar>
      </Stack>
    </Box>
  );
}
