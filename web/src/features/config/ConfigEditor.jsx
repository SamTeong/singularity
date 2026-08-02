import { getTokens } from '@/theme/contract.js';
import { useEffect, useState, useMemo } from 'react';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Tabs from '@mui/material/Tabs';
import Tab from '@mui/material/Tab';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';
import { json } from '@codemirror/lang-json';
import IconButton from '@mui/material/IconButton';
import CmEditor from '@/components/CmEditor.jsx';
import DirPicker from '@/components/DirPicker.jsx';
import ClearIcon from '@mui/icons-material/Clear';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import { tildify, untildify } from '@/lib/paths.js';
import Rail from '@/components/panelkit/Rail.jsx';
import RailHeader from '@/components/panelkit/RailHeader.jsx';
import EmptyListLine from '@/components/EmptyListLine.jsx';
import SaveBar from '@/components/panelkit/SaveBar.jsx';
import { useRootList } from '@/components/panelkit/useRootList.js';

const CLAUDE_SCOPES = [
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
  const [tool, setTool] = useState('claude'); // 'claude' | 'codex'
  const claudeRoots = useRootList('/config', { initial: ['~'] });
  const codexRoots = useRootList('/codex-config', { initial: ['~'] });
  const { roots, shownRoots, remember, forget } = tool === 'codex' ? codexRoots : claudeRoots;
  const [q, setQ] = useState('');
  const [searchResults, setSearchResults] = useState(null); // content-search hits, raw
  const results = q.trim() ? searchResults : null; // null = show config list

  const base = tool === 'codex' ? '/codex-config' : '/config';
  // Codex has no scope tabs: one config.toml per root. `~` (home) → user-level
  // (~/.codex/config.toml); any project root → project-level (.codex/config.toml).
  const effScope = tool === 'codex' ? (untildify(cwd) === untildify('~') ? 'user' : 'project') : scope;

  const load = () => {
    if (!cwd) return;
    const full = untildify(cwd);
    setLoading(true);
    fetch(`${base}?cwd=${encodeURIComponent(full)}`).then((r) => r.json()).then((d) => {
      setData(d);
      setLoadedCwd(full);
      setContent(d[effScope]?.content ?? '');
      setDirty(false); setMsg(null);
      remember([full]);
    }).catch((e) => setMsg({ sev: 'error', text: String(e) })).finally(() => setLoading(false));
  };
  useEffect(() => { if (dirty && !window.confirm('Discard unsaved changes?')) return; load(); /* eslint-disable-line */ }, [cwd]);
  // Tool switch: reload for the current cwd/scope under the new tool's backend.
  // load() reads `base`/`scope` from closure; an effect keyed on [tool] runs
  // after those state updates settle, so it sees the fresh values.
  useEffect(() => { load(); /* eslint-disable-line */ }, [tool]);

  // Debounced content search across config roots' settings files (empty q → config list,
  // derived above rather than reset here).
  useEffect(() => {
    const term = q.trim();
    if (!term) return;
    const id = setTimeout(() => {
      fetch(`${base}/search`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ roots, q: term }),
      }).then((r) => r.json()).then((d) => setSearchResults(d.results || [])).catch(() => setSearchResults([]));
    }, 250);
    return () => clearTimeout(id);
  }, [q, roots, base]);

  // Switching tabs/scope is a direct user action — sync content here instead of
  // an effect keyed on [scope, data].
  const changeScope = (v) => {
    setScope(v);
    if (data) { setContent(data[v]?.content ?? ''); setDirty(false); setMsg(null); }
  };

  const openResult = (it) => {
    if (dirty && !window.confirm('Discard unsaved changes?')) return;
    changeScope(it.scope);
    setCwd(it.cwd);
  };

  const changeTool = (next) => {
    if (next === tool) return;
    if (dirty && !window.confirm('Discard unsaved changes?')) return;
    setTool(next);
    setScope('project');
    setData(null);
    setLoadedCwd(null);
    setContent('');
    setDirty(false);
    setMsg(null);
  };

  const validationError = useMemo(() => {
    if (tool !== 'claude') return null;
    if (!content.trim()) return null;
    try { JSON.parse(content); return null; } catch (e) { return e.message; }
  }, [content, tool]);

  const info = data?.[effScope];

  const onChange = (v) => { setContent(v); setDirty(true); };

  const save = async () => {
    const r = await fetch(`${base}/${effScope}`, {
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
    fetch(`${base}/scan?root=${encodeURIComponent(untildify(p))}`).then((r) => r.json()).then((d) => {
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
            <RailHeader
              searchPlaceholder="Search config…"
              searchValue={q}
              onSearchChange={setQ}
              onPickFolder={() => { if (dirty && !window.confirm('Discard unsaved changes?')) return; setPicking(true); }}
              onCollapse={collapse}
            />
            <List dense sx={{ flex: 1, minHeight: 0, overflow: 'auto', px: 0.5, pt: 0 }}>
              {results ? (
                <>
                  {results.map((it, i) => (
                    <ListItemButton key={`${it.path}:${i}`} selected={it.cwd === loadedCwd && it.scope === effScope} onClick={() => openResult(it)}
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
                  {shownRoots.length === 0 && <EmptyListLine>No config paths.</EmptyListLine>}
                </>
              )}
            </List>
          </>
        )}
      </Rail>

      <Stack sx={{ flex: 1, minWidth: 0, height: '100%', p: 2, minHeight: 0 }} spacing={1.5}>
        <ToggleButtonGroup value={tool} exclusive size="small" color="primary" onChange={(_, v) => v && changeTool(v)} sx={{ alignSelf: 'flex-start' }}>
          <ToggleButton value="claude">Claude Code</ToggleButton>
          <ToggleButton value="codex">Codex</ToggleButton>
        </ToggleButtonGroup>
        {tool === 'claude' && (
          <Tabs value={scope} onChange={(_, v) => { if (dirty && !window.confirm('Discard unsaved changes?')) return; changeScope(v); }} variant="fullWidth">
            {CLAUDE_SCOPES.map((s) => <Tab key={s.key} value={s.key} label={s.label} />)}
          </Tabs>
        )}

        <Typography noWrap variant="code" sx={{ flexShrink: 0, color: 'text.secondary', fontSize: 11 }}>
          {tildify(info?.path)} {info && !info.exists && "· (doesn't exist yet — saving will create it)"}
        </Typography>
        {picking && <DirPicker start={untildify(cwd)} onPick={pick} onClose={() => setPicking(false)} />}

        <CmEditor value={content} onChange={onChange} extensions={tool === 'codex' ? [] : [json()]} />

        <SaveBar msg={validationError ? null : msg} disabled={!dirty || !!validationError} onSave={save}>
          {validationError && <Typography color="error" variant="code" sx={{ fontSize: 12 }}>This isn't valid JSON: {validationError}</Typography>}
        </SaveBar>
      </Stack>
    </Box>
  );
}
