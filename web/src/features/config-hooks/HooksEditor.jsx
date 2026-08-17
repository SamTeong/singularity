import { getTokens } from '@/theme/contract.js';
import { useEffect, useState, useMemo } from 'react';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { json } from '@codemirror/lang-json';
import { javascript } from '@codemirror/lang-javascript';
import IconButton from '@mui/material/IconButton';
import { EmptyState } from '@/components/EmptyState.jsx';
import WebhookIcon from '@mui/icons-material/Webhook';
import CmEditor from '@/components/CmEditor.jsx';
import DetailPane from '@/components/DetailPane.jsx';
import DirPicker from '@/components/DirPicker.jsx';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ClearIcon from '@mui/icons-material/Clear';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import { tildify, untildify } from '@/lib/paths.js';
import Rail from '@/components/panelkit/Rail.jsx';
import RailHeader from '@/components/panelkit/RailHeader.jsx';
import EmptyListLine from '@/components/EmptyListLine.jsx';
import SaveBar from '@/components/panelkit/SaveBar.jsx';
import { useRootList, normKey } from '@/components/panelkit/useRootList.js';
import { useRefreshOnFocus } from '@/components/panelkit/useRefreshOnFocus.js';
import { useDirtyGuard } from '@/components/panelkit/useDirtyGuard.jsx';

// Language extension per file extension: JS family → javascript(), .json → json(),
// everything else (.ps1/.sh/…) → plain (no lang extension).
function langFor(path) {
  const ext = (path || '').toLowerCase().split('.').pop();
  if (ext === 'mjs' || ext === 'js' || ext === 'cjs') return javascript();
  if (ext === 'json') return json();
  return null;
}

export default function HooksEditor() {
  const { roots, remember, forget } = useRootList('/api/hooks', { initial: ['~'] });
  const [picking, setPicking] = useState(false);
  const [groups, setGroups] = useState([]); // [{ cwd, files:[{path,rel,name}] }]
  const [path, setPath] = useState(null); // selected file path
  const [content, setContent] = useState('');
  const [dirty, setDirty] = useState(false);
  const [mtime, setMtime] = useState(null);
  const [msg, setMsg] = useState(null);
  const [q, setQ] = useState('');
  const [results, setResults] = useState(null); // content-search hits
  // null when q is empty (browse the file list), the last fetched hits otherwise.
  const showResults = q.trim() ? results : null;
  const { ensureSaved, dialogEl } = useDirtyGuard();

  // Fetch grouped hook files whenever the root list changes.
  useEffect(() => {
    fetch('/api/hooks/list', {
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
    for (const it of showResults || []) {
      const k = normKey(it.cwd);
      if (!m.has(k)) m.set(k, { cwd: it.cwd, items: [] });
      m.get(k).items.push(it);
    }
    return [...m.values()].sort((a, b) => normKey(a.cwd).localeCompare(normKey(b.cwd)));
  }, [showResults]);

  const loadFile = async (p) => {
    if (!await ensureSaved({ dirty, save })) return;
    fetch(`/api/hooks/file?path=${encodeURIComponent(p)}`).then((r) => r.json()).then((d) => {
      setPath(p);
      setContent(d.content ?? '');
      setMtime(d.mtime ?? null);
      setDirty(false); setMsg(null);
    }).catch((e) => setMsg({ sev: 'error', text: String(e) }));
  };

  // Debounced content search across hook roots' files. Empty q → no fetch;
  // `showResults` below derives the empty-q "show file list" fallback during
  // render instead of resetting `results` state here.
  useEffect(() => {
    const term = q.trim();
    if (!term) return;
    const id = setTimeout(() => {
      fetch('/api/hooks/search', {
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
  const groupKeys = (showResults ? searchGroups : shownGroups).map((g) => normKey(g.cwd));
  const allOpen = groupKeys.length > 0 && groupKeys.every((k) => !collapsed.has(k));
  const toggleAll = () => setCollapsed(allOpen ? new Set(groupKeys) : new Set());

  const save = async (force = false) => {
    const r = await fetch('/api/hooks/file', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path, content, mtime, force }),
    }).then((x) => x.json()).catch((e) => ({ ok: false, error: String(e) }));
    if (r.error === 'changed on disk') {
      if (window.confirm('This file changed on disk since it was opened. Overwrite it?')) return save(true);
      setMsg({ sev: 'error', text: 'Not saved — file changed on disk' });
      return;
    }
    if (r.ok) { setMsg({ sev: 'success', text: `Saved${r.backup ? ' (backup made)' : ''}` }); setDirty(false); if (r.mtime != null) setMtime(r.mtime); }
    else setMsg({ sev: 'error', text: r.error || 'save failed' });
  };

  useRefreshOnFocus({
    enabled: !!path,
    mtime,
    dirty,
    refetch: async () => {
      const d = await fetch(`/api/hooks/file?path=${encodeURIComponent(path)}`).then((r) => r.json()).catch(() => ({ ok: false }));
      return { ok: !!d.ok, mtime: d.mtime ?? null, content: d.content ?? '' };
    },
    onChanged: (c, m) => { setContent(c); setMtime(m); setDirty(false); setMsg({ sev: 'success', text: 'Reloaded from disk' }); },
    onWarn: () => setMsg({ sev: 'error', text: 'Changed on disk — saving will ask before overwriting' }),
  });

  const pick = async (p) => {
    if (!await ensureSaved({ dirty, save })) return;
    setPicking(false);
    remember([p]);
  };

  return (
    <Box sx={{ display: 'flex', height: '100%', minHeight: 0 }}>
      <Rail storageKey="sing-hooks-w" defaultWidth={300} collapsedTitle="Show hook files">
        {({ collapse }) => (
          <>
            <RailHeader
              searchPlaceholder="Search hooks…"
              searchValue={q}
              onSearchChange={setQ}
              allOpen={allOpen}
              onToggleAll={toggleAll}
              onPickFolder={async () => { if (!await ensureSaved({ dirty, save })) return; setPicking(true); }}
              onCollapse={collapse}
            />
            <List dense sx={{ flex: 1, minHeight: 0, overflow: 'auto', px: 0.5, pt: 0 }}>
              {(showResults ? searchGroups : shownGroups.map((g) => ({ cwd: g.cwd, items: g.files }))).map((g) => {
                const isCol = collapsed.has(normKey(g.cwd));
                const count = g.items.length;
                return (
                  <Box key={g.cwd}>
                    <ListItemButton sx={{ borderRadius: (t) => `${getTokens(t).radius.sm}px`, mb: 0.25, '&:hover .del': { opacity: 1 } }}>
                      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', width: '100%' }} onClick={() => toggleGroup(g.cwd)}>
                        {isCol ? <ChevronRightIcon fontSize="small" color="action" /> : <ExpandMoreIcon fontSize="small" color="action" />}
                        <FolderOpenIcon fontSize="small" color="action" />
                        <Typography variant="code" noWrap title={g.cwd} sx={{ flex: 1, minWidth: 0, fontSize: 11, color: 'text.secondary' }}>{tildify(g.cwd)}</Typography>
                        <Typography variant="code" sx={{ fontSize: 11, color: 'text.secondary' }}>{count}</Typography>
                      </Stack>
                      {!showResults && (
                        <IconButton className="del" size="small" aria-label="Remove from list" title="Remove from list"
                          onClick={(e) => { e.stopPropagation(); forget(g.cwd); }} sx={{ opacity: 0, ml: 0.5, p: 0.25 }}>
                          <ClearIcon fontSize="small" />
                        </IconButton>
                      )}
                    </ListItemButton>
                    {!isCol && g.items.map((it, i) => showResults ? (
                      <ListItemButton key={`${it.path}:${i}`} selected={it.path === path} onClick={() => loadFile(it.path)}
                        sx={{ borderRadius: (t) => `${getTokens(t).radius.sm}px`, display: 'block', py: 0.5, mb: 0.25, pl: 4 }}>
                        <Typography variant="code" sx={{ fontSize: 11 }} noWrap title={it.path}>{tildify(it.path)}:{it.line}</Typography>
                        <Typography variant="code" sx={{ fontSize: 12, color: 'text.secondary', mt: 0.5 }} noWrap>{it.text}</Typography>
                      </ListItemButton>
                    ) : (
                      <ListItemButton key={it.path} selected={it.path === path} onClick={() => loadFile(it.path)}
                        sx={{ borderRadius: (t) => `${getTokens(t).radius.sm}px`, py: 0.25, mb: 0.25, pl: 4 }}>
                        <ListItemText primary={it.rel} slotProps={{ primary: { noWrap: true, title: it.path, variant: 'code', sx: { fontSize: 12 } } }} />
                      </ListItemButton>
                    ))}
                    {!isCol && count === 0 && <Typography color="text.secondary" sx={{ fontSize: 11, px: 2, py: 0.5 }}>No hooks.</Typography>}
                  </Box>
                );
              })}
              {showResults && (showResults.length === 0) && <Typography color="text.secondary" sx={{ fontSize: 12, p: 1.5 }}>No matches.</Typography>}
              {!showResults && shownGroups.length === 0 && <EmptyListLine>No hooks.</EmptyListLine>}
            </List>
          </>
        )}
      </Rail>

    <Stack sx={{ flex: 1, minWidth: 0, height: '100%', p: 2, minHeight: 0 }} spacing={1.5}>
      {picking && <DirPicker start={untildify(roots[0] || '~')} onPick={pick} onClose={() => setPicking(false)} />}
      <DetailPane empty={!path && <EmptyState icon={<WebhookIcon />} title="Select a hook" description="Browse on the left to view or edit here." />}>
        <Typography noWrap variant="code" sx={{ flexShrink: 0, color: 'text.secondary', fontSize: 11 }}>{tildify(path)}</Typography>
        {/* key={path}: @uiw's typing latch defers a `value` prop change that
            lands while the user was just typing, and on a dirty "discard and
            navigate" that deferred update is never applied — the editor keeps
            showing the previous file plus the unsaved edit. Remounting on path
            makes the new file's content the initial doc, sidestepping the latch. */}
        <CmEditor key={path} value={content} onChange={onChange} extensions={lang ? [lang] : []} deps={[path]} />
        <SaveBar msg={msg} disabled={!dirty} onSave={save} />
      </DetailPane>
    </Stack>
    {dialogEl}
    </Box>
  );
}
