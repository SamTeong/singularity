import React, { useEffect, useState, useMemo } from 'react';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { json } from '@codemirror/lang-json';
import { javascript } from '@codemirror/lang-javascript';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import { EmptyState } from '@zapac/mui-theme';
import WebhookIcon from '@mui/icons-material/Webhook';
import CmEditor from './CmEditor.jsx';
import DetailPane from './DetailPane.jsx';
import DirPicker from './DirPicker.jsx';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ClearIcon from '@mui/icons-material/Clear';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import { tildify, untildify } from './paths.js';
import Rail from './panelkit/Rail.jsx';
import RailSearch from './panelkit/RailSearch.jsx';
import RailGroupToggle from './panelkit/RailGroupToggle.jsx';
import SaveBar from './panelkit/SaveBar.jsx';
import { useRootList, normKey } from './panelkit/useRootList.js';

// Language extension per file extension: JS family → javascript(), .json → json(),
// everything else (.ps1/.sh/…) → plain (no lang extension).
function langFor(path) {
  const ext = (path || '').toLowerCase().split('.').pop();
  if (ext === 'mjs' || ext === 'js' || ext === 'cjs') return javascript();
  if (ext === 'json') return json();
  return null;
}

export default function HooksEditor() {
  const { roots, remember, forget } = useRootList('/hooks', { initial: ['~'] });
  const [picking, setPicking] = useState(false);
  const [groups, setGroups] = useState([]); // [{ cwd, files:[{path,rel,name}] }]
  const [path, setPath] = useState(null); // selected file path
  const [content, setContent] = useState('');
  const [dirty, setDirty] = useState(false);
  const [msg, setMsg] = useState(null);
  const [q, setQ] = useState('');
  const [results, setResults] = useState(null); // content-search hits, null = show file list

  // Fetch grouped hook files whenever the root list changes.
  useEffect(() => {
    fetch('/hooks/list', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roots: roots.map(untildify) }),
    }).then((r) => r.json()).then((d) => setGroups(d.groups || [])).catch(() => setGroups([]));
  }, [roots]);

  // Dedup groups on normalized cwd (~ vs expanded home, / vs \) — picking home
  // while ~ is present otherwise renders two identical groups. First-seen wins,
  // order preserved (mirrors ConfigEditor's shownRoots dedup).
  const shownGroups = useMemo(() => {
    const seen = new Set();
    return groups.filter((g) => {
      const k = normKey(g.cwd);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    }).sort((a, b) => normKey(a.cwd).localeCompare(normKey(b.cwd))); // alpha by displayed form
  }, [groups]);

  // Collapsible section state — set of normKey(cwd) the user folded. Default
  // expanded (empty). Shared across browse + search so a fold persists in view.
  const [collapsed, setCollapsed] = useState(() => new Set());
  const toggleGroup = (cwd) => setCollapsed((s) => {
    const k = normKey(cwd);
    const n = new Set(s);
    n.has(k) ? n.delete(k) : n.add(k);
    return n;
  });
  // Search hits grouped by cwd (flat list → [[cwd, items], …]), alpha by cwd.
  const searchGroups = useMemo(() => {
    const m = new Map();
    for (const it of results || []) {
      const k = normKey(it.cwd);
      if (!m.has(k)) m.set(k, { cwd: it.cwd, items: [] });
      m.get(k).items.push(it);
    }
    return [...m.values()].sort((a, b) => normKey(a.cwd).localeCompare(normKey(b.cwd)));
  }, [results]);

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
        body: JSON.stringify({ roots: roots.map(untildify), q: term }),
      }).then((r) => r.json()).then((d) => setResults(d.results || [])).catch(() => setResults([]));
    }, 250);
    return () => clearTimeout(id);
  }, [q, roots]);

  // Language extension depends on the selected file — CmEditor recomputes its
  // stable extensions array only when `path` changes.
  const lang = langFor(path);
  const onChange = (v) => { setContent(v); setDirty(true); };

  // Keys for the groups currently displayed (browse or search) → drive the
  // expand/collapse-all toggle.
  const groupKeys = (results ? searchGroups : shownGroups).map((g) => normKey(g.cwd));
  const allOpen = groupKeys.length > 0 && groupKeys.every((k) => !collapsed.has(k));
  const toggleAll = () => setCollapsed(allOpen ? new Set(groupKeys) : new Set());

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
      <Rail storageKey="sing-hooks-w" defaultWidth={300} collapsedTitle="Show hook files">
        {({ collapse }) => (
          <>
            <Box sx={{ p: 1.5, pb: 0.5 }}>
              <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                <RailSearch placeholder="Search hooks…" value={q} onChange={setQ} />
                <RailGroupToggle allOpen={allOpen} onToggle={toggleAll} />
                <Tooltip title="Select root folder" placement="bottom" disableInteractive>
                  <IconButton size="small" onClick={() => { if (dirty && !window.confirm('Discard unsaved changes?')) return; setPicking(true); }}><FolderOpenIcon /></IconButton>
                </Tooltip>
                <IconButton size="small" onClick={collapse}><ChevronLeftIcon /></IconButton>
              </Stack>
            </Box>
            <List dense sx={{ flex: 1, minHeight: 0, overflow: 'auto', px: 0.5, pt: 0 }}>
              {(results ? searchGroups : shownGroups.map((g) => ({ cwd: g.cwd, items: g.files }))).map((g) => {
                const isCol = collapsed.has(normKey(g.cwd));
                const count = g.items.length;
                return (
                  <Box key={g.cwd}>
                    <ListItemButton sx={{ borderRadius: (t) => `${t.zapac.radius.sm}px`, mb: 0.25, '&:hover .del': { opacity: 1 } }}>
                      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', width: '100%' }} onClick={() => toggleGroup(g.cwd)}>
                        {isCol ? <ChevronRightIcon fontSize="small" color="action" /> : <ExpandMoreIcon fontSize="small" color="action" />}
                        <FolderOpenIcon fontSize="small" color="action" />
                        <Typography noWrap title={g.cwd} sx={{ flex: 1, minWidth: 0, fontFamily: 'monospace', fontSize: 11, color: 'text.secondary' }}>{tildify(g.cwd)}</Typography>
                        <Typography variant="code" sx={{ fontSize: 11, color: 'text.secondary' }}>{count}</Typography>
                      </Stack>
                      {!results && (
                        <IconButton className="del" size="small" aria-label="Remove from list" title="Remove from list"
                          onClick={(e) => { e.stopPropagation(); forget(g.cwd); }} sx={{ opacity: 0, ml: 0.5, p: 0.25 }}>
                          <ClearIcon fontSize="small" />
                        </IconButton>
                      )}
                    </ListItemButton>
                    {!isCol && g.items.map((it, i) => results ? (
                      <ListItemButton key={`${it.path}:${i}`} selected={it.path === path} onClick={() => loadFile(it.path)}
                        sx={{ borderRadius: (t) => `${t.zapac.radius.sm}px`, display: 'block', py: 0.5, mb: 0.25, pl: 4 }}>
                        <Typography variant="code" sx={{ fontSize: 11 }} noWrap title={it.path}>{tildify(it.path)}:{it.line}</Typography>
                        <Typography sx={{ fontSize: 12, color: 'text.secondary', mt: 0.5, fontFamily: 'monospace' }} noWrap>{it.text}</Typography>
                      </ListItemButton>
                    ) : (
                      <ListItemButton key={it.path} selected={it.path === path} onClick={() => loadFile(it.path)}
                        sx={{ borderRadius: (t) => `${t.zapac.radius.sm}px`, py: 0.25, mb: 0.25, pl: 4 }}>
                        <ListItemText primary={it.rel} primaryTypographyProps={{ noWrap: true, title: it.path, sx: { fontFamily: 'monospace', fontSize: 12 } }} />
                      </ListItemButton>
                    ))}
                    {!isCol && count === 0 && <Typography color="text.secondary" sx={{ fontSize: 11, px: 2, py: 0.5 }}>No hooks.</Typography>}
                  </Box>
                );
              })}
              {results && (results.length === 0) && <Typography color="text.secondary" sx={{ fontSize: 12, p: 1.5 }}>No matches.</Typography>}
              {!results && shownGroups.length === 0 && <Typography color="text.secondary" sx={{ fontSize: 12, p: 1.5 }}>No hook roots.</Typography>}
            </List>
          </>
        )}
      </Rail>

    <Stack sx={{ flex: 1, minWidth: 0, height: '100%', p: 2, minHeight: 0 }} spacing={1.5}>
      {picking && <DirPicker start={untildify(roots[0] || '~')} onPick={pick} onClose={() => setPicking(false)} />}
      <DetailPane empty={!path && <EmptyState icon={<WebhookIcon />} title="Select a hook" description="Browse on the left to view or edit here." />}>
        <Typography noWrap variant="code" sx={{ flexShrink: 0, color: 'text.secondary', fontSize: 11 }}>{tildify(path)}</Typography>
        <CmEditor value={content} onChange={onChange} extensions={lang ? [lang] : []} deps={[path]} />
        <SaveBar msg={msg} disabled={!dirty} onSave={save} />
      </DetailPane>
    </Stack>
    </Box>
  );
}
