import { getTokens } from '@/theme/contract.js';
import { useEffect, useState, useCallback, useMemo } from 'react';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import BookIcon from '@mui/icons-material/Book';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import DirPicker from '@/components/DirPicker.jsx';
import { markdown } from '@codemirror/lang-markdown';
import { EmptyState } from '@/components/EmptyState.jsx';
import CmEditor from '@/components/CmEditor.jsx';
import DetailPane from '@/components/DetailPane.jsx';
import { tildify, untildify } from '@/lib/paths.js';
import Rail from '@/components/panelkit/Rail.jsx';
import RailHeader from '@/components/panelkit/RailHeader.jsx';
import EmptyListLine from '@/components/EmptyListLine.jsx';
import SaveBar from '@/components/panelkit/SaveBar.jsx';
import { useRefreshOnFocus } from '@/components/panelkit/useRefreshOnFocus.js';
import { useFocusTick } from '@/components/panelkit/useFocusTick.js';
import { useDirtyGuard } from '@/components/panelkit/useDirtyGuard.jsx';
import { confirmOverwrite } from '@/components/panelkit/confirmOverwrite.js';

// Memory root persists across sessions on the daemon FS (survives browser cache
// clear). Default ~/.claude/projects; loaded from /memory/root on mount.
const DEFAULT_ROOT = '~/.claude/projects';

export default function MemoryPanel() {
  // null until /memory/root resolves — keeps the file list from being fetched
  // against a guessed root on first render (mirrors SessionHistory:95).
  const [root, setRoot] = useState(null);
  const [picking, setPicking] = useState(false);
  const [q, setQ] = useState('');
  const [results, setResults] = useState(null); // search hits
  const [files, setFiles] = useState([]); // all memory files (browse)
  const [capped, setCapped] = useState(false);
  const [sel, setSel] = useState(null); // {path, project, file}
  const [content, setContent] = useState('');
  const [dirty, setDirty] = useState(false);
  const [mtime, setMtime] = useState(null);
  const [loadingFile, setLoadingFile] = useState(false);
  const [msg, setMsg] = useState(null);
  const onChange = (v) => { setContent(v); setDirty(true); };
  const [err, setErr] = useState(null);
  const { ensureSaved, dialogEl } = useDirtyGuard();
  const focusTick = useFocusTick();

  // Load the FS-persisted root once on mount (files load via the [root] effect).
  // Falls back to DEFAULT_ROOT either way so a failed fetch still resolves to a
  // usable state rather than stalling at null forever (matches SessionHistory:118).
  useEffect(() => {
    fetch('/api/memory/root').then((r) => r.json()).then((d) => setRoot(d.root || DEFAULT_ROOT)).catch(() => setRoot(DEFAULT_ROOT));
  }, []);

  useEffect(() => {
    if (root == null) return;
    fetch(`/api/memory/files?root=${encodeURIComponent(untildify(root))}`).then((r) => r.json()).then((d) => setFiles(d.files || [])).catch(() => setErr('failed to load memory files'));
  }, [root, focusTick]);

  const search = useCallback(() => {
    if (!q.trim()) { setResults(null); return; }
    fetch(`/api/memory/search?q=${encodeURIComponent(q.trim())}&root=${encodeURIComponent(untildify(root))}`).then((r) => r.json()).then((d) => {
      setResults(d.results || []); setCapped(!!d.capped);
    });
  }, [q, root]);

  // Debounced search-as-you-type (search() clears results when q is empty).
  useEffect(() => { const id = setTimeout(search, 250); return () => clearTimeout(id); }, [q, search]);

  const open = async (item) => {
    if (item.path === sel?.path) return;
    if (!await ensureSaved({ dirty, save })) return;
    setSel(item); setMsg(null); setLoadingFile(true); setMtime(null);
    fetch(`/api/memory/file?path=${encodeURIComponent(untildify(item.path))}&root=${encodeURIComponent(untildify(root))}`).then((r) => r.json()).then((d) => {
      setContent(d.ok ? d.content : ''); setDirty(false); setMtime(d.ok ? (d.mtime ?? null) : null);
      if (!d.ok) setMsg({ sev: 'error', text: d.error });
    }).finally(() => setLoadingFile(false));
  };

  const save = async (force = false) => {
    const r = await fetch('/api/memory/file', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: untildify(sel.path), content, root: untildify(root), mtime, force }),
    }).then((x) => x.json()).catch((e) => ({ ok: false, error: String(e) }));
    if (r.error === 'changed on disk') {
      if (confirmOverwrite()) return save(true);
      setMsg({ sev: 'error', text: 'Not saved — file changed on disk' });
      return;
    }
    setMsg(r.ok ? { sev: 'success', text: 'Saved' } : { sev: 'error', text: r.error });
    if (r.ok) { setDirty(false); if (r.mtime != null) setMtime(r.mtime); }
  };

  useRefreshOnFocus({
    enabled: !!sel,
    mtime,
    dirty,
    refetch: async () => {
      const d = await fetch(`/api/memory/file?path=${encodeURIComponent(untildify(sel.path))}&root=${encodeURIComponent(untildify(root))}`).then((r) => r.json()).catch(() => ({ ok: false }));
      return { ok: !!d.ok, mtime: d.mtime ?? null, content: d.content ?? '' };
    },
    onChanged: (c, m) => { setContent(c); setMtime(m); setDirty(false); setMsg({ sev: 'success', text: 'Reloaded from disk' }); },
    onWarn: () => setMsg({ sev: 'error', text: 'Changed on disk — saving will ask before overwriting' }),
  });

  const pickRoot = async (p) => {
    setPicking(false);
    const r = await fetch('/api/memory/root', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ root: p }) })
      .then((x) => x.json()).catch((e) => ({ ok: false, error: String(e) }));
    if (!r.ok) { setErr(r.error || 'failed to set memory root'); return; }
    setRoot(p);
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
            <RailHeader
              searchPlaceholder="Search memory…"
              searchValue={q}
              onSearchChange={setQ}
              allOpen={allOpen}
              onToggleAll={toggleAll}
              onPickFolder={() => setPicking(true)}
              onCollapse={collapse}
            >
              <Typography variant="code" sx={{ color: 'text.secondary', fontSize: 11, mt: 1, ml: 2, display: 'block' }} noWrap>{root ? tildify(root) : ''}</Typography>
              <Typography variant="code" sx={{ color: 'text.secondary', fontSize: 11, ml: 2, display: 'block' }}>
                {results ? `${results.length}${capped ? '+ (capped)' : ''} matches` : `${files.length} file${files.length === 1 ? '' : 's'}`}
              </Typography>
            </RailHeader>
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
              {showing.length === 0 && <EmptyListLine>{results ? 'No matches.' : (err || 'No memory files.')}</EmptyListLine>}
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
          <CmEditor key={sel?.path} value={content} onChange={onChange} extensions={[markdown()]} />
          <SaveBar msg={msg} disabled={!dirty} onSave={save} />
        </DetailPane>
      </Stack>

      {picking && <DirPicker start={untildify(root)} onPick={pickRoot} onClose={() => setPicking(false)} />}
      {dialogEl}
    </Box>
  );
}
