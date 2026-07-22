import { getTokens } from '@/theme/contract.js';
import React, { useEffect, useState, useMemo } from 'react';
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
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ClearIcon from '@mui/icons-material/Clear';
import GavelIcon from '@mui/icons-material/Gavel';
import { markdown } from '@codemirror/lang-markdown';
import { EmptyState } from '@zapac/mui-theme';
import CmEditor from '@/components/CmEditor.jsx';
import DetailPane from '@/components/DetailPane.jsx';
import DirPicker from '@/components/DirPicker.jsx';
import { tildify, untildify } from '@/lib/paths.js';
import Rail from '@/components/panelkit/Rail.jsx';
import RailSearch from '@/components/panelkit/RailSearch.jsx';
import RailGroupToggle from '@/components/panelkit/RailGroupToggle.jsx';
import SaveBar from '@/components/panelkit/SaveBar.jsx';
import { useRootList, normKey } from '@/components/panelkit/useRootList.js';

export default function RulesPanel() {
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

  const onChange = (v) => { setContent(v); setDirty(true); };

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

  // Collapsible section state — set of normKey(root) the user folded. Default
  // expanded (empty). Shared across browse + search so a fold persists in view.
  const [collapsed, setCollapsed] = useState(() => new Set());
  const toggleGroup = (root) => setCollapsed((s) => {
    const k = normKey(root);
    const n = new Set(s);
    n.has(k) ? n.delete(k) : n.add(k);
    return n;
  });
  // Search hits grouped by root (flat list → [{root, items}], …), alpha by root.
  const searchGroups = useMemo(() => {
    const m = new Map();
    for (const it of results || []) {
      const k = normKey(it.root);
      if (!m.has(k)) m.set(k, { root: it.root, items: [] });
      m.get(k).items.push(it);
    }
    return [...m.values()].sort((a, b) => normKey(a.root).localeCompare(normKey(b.root)));
  }, [results]);

  // Keys for the groups currently displayed (browse or search) → drive the
  // expand/collapse-all toggle. shownRoots are bare strings; searchGroups are
  // {root, items} objects — normalize both to root keys.
  const groupKeys = (results ? searchGroups : shownRoots.map((r) => ({ root: r }))).map((g) => normKey(g.root));
  const allOpen = groupKeys.length > 0 && groupKeys.every((k) => !collapsed.has(k));
  const toggleAll = () => setCollapsed(allOpen ? new Set(groupKeys) : new Set());

  return (
    <Box sx={{ display: 'flex', height: '100%', minHeight: 0 }}>
      <Rail storageKey="sing-rules-w" defaultWidth={300} collapsedTitle="Show rule paths">
        {({ collapse }) => (
          <>
            <Box sx={{ p: 1.5, pb: 0.5 }}>
              <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                <RailSearch placeholder="Search rules…" value={q} onChange={setQ} />
                <RailGroupToggle allOpen={allOpen} onToggle={toggleAll} />
                <Tooltip title="Select root folder" placement="bottom" disableInteractive>
                  <IconButton size="small" onClick={() => { if (dirty && !window.confirm('Discard unsaved changes?')) return; setPicking(true); }}><FolderOpenIcon /></IconButton>
                </Tooltip>
                <IconButton size="small" onClick={collapse}><ChevronLeftIcon /></IconButton>
              </Stack>
            </Box>
            <List dense sx={{ flex: 1, minHeight: 0, overflow: 'auto', px: 0.5, pt: 0 }}>
              {(results ? searchGroups : shownRoots.map((root) => ({ root, items: filesByRoot(root) }))).map((g) => {
                const isCol = collapsed.has(normKey(g.root));
                const count = g.items.length;
                return (
                  <Box key={g.root} sx={{ mb: 0.5 }}>
                    <ListItemButton sx={{ borderRadius: (t) => `${getTokens(t).radius.sm}px`, py: 0.25, '&:hover .del': { opacity: 1 } }}>
                      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', width: '100%' }} onClick={() => toggleGroup(g.root)}>
                        {isCol ? <ChevronRightIcon fontSize="small" color="action" /> : <ExpandMoreIcon fontSize="small" color="action" />}
                        <FolderOpenIcon fontSize="small" color="action" />
                        <ListItemText primary={tildify(g.root)} primaryTypographyProps={{ noWrap: true, title: g.root, sx: { fontFamily: 'monospace', fontSize: 12 } }} />
                        <Typography variant="code" sx={{ fontSize: 11, color: 'text.secondary' }}>{count}</Typography>
                      </Stack>
                      {!results && (
                        <IconButton className="del" size="small" aria-label="Remove from list" title="Remove from list"
                          onClick={(e) => { e.stopPropagation(); forget(g.root); }}
                          sx={{ opacity: 0, ml: 0.5, p: 0.25 }}>
                          <ClearIcon fontSize="small" />
                        </IconButton>
                      )}
                    </ListItemButton>
                    {!isCol && g.items.map((it, i) => results ? (
                      <ListItemButton key={`${it.path}:${it.line}:${i}`} selected={sel?.path === it.path} onClick={() => open(it)}
                        sx={{ borderRadius: (t) => `${getTokens(t).radius.sm}px`, display: 'block', py: 0.5, pl: 4, mb: 0.25 }}>
                        <Typography variant="code" sx={{ fontSize: 11 }} noWrap title={it.path}>{tildify(it.path)}:{it.line}</Typography>
                        <Typography sx={{ fontSize: 12, color: 'text.secondary', mt: 0.5, fontFamily: 'monospace' }} noWrap>{it.text}</Typography>
                      </ListItemButton>
                    ) : (
                      <ListItemButton key={it.path} selected={sel?.path === it.path} onClick={() => open(it)}
                        sx={{ borderRadius: (t) => `${getTokens(t).radius.sm}px`, py: 0.25, pl: 4, mb: 0.25 }}>
                        <ListItemText primary={tildify(it.rel)} primaryTypographyProps={{ noWrap: true, title: it.path, sx: { fontSize: 12 } }} />
                      </ListItemButton>
                    ))}
                  </Box>
                );
              })}
              {results && results.length === 0 && <Typography color="text.secondary" sx={{ fontSize: 12, p: 1.5 }}>No matches.</Typography>}
              {!results && shownRoots.length === 0 && <Typography color="text.secondary" sx={{ fontSize: 12, p: 1.5 }}>No rule paths.</Typography>}
            </List>
          </>
        )}
      </Rail>

      <Stack sx={{ flex: 1, minWidth: 0, minHeight: 0, p: 1.5 }} spacing={1}>
        {picking && <DirPicker start={untildify(roots[0] || '~')} onPick={pick} onClose={() => setPicking(false)} />}
        <DetailPane
          empty={!sel && <EmptyState icon={<GavelIcon />} title="Select a rule" description="Browse on the left to view or edit here." />}
          loading={loadingFile}
        >
          <Typography variant="code" sx={{ color: 'text.secondary', fontSize: 11 }}>{tildify(sel?.path)}</Typography>
          <CmEditor value={content} onChange={onChange} extensions={[markdown()]} />
          <SaveBar msg={msg} disabled={!dirty} onSave={save} />
        </DetailPane>
      </Stack>
    </Box>
  );
}
