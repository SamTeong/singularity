import { useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemIcon from '@mui/material/ListItemIcon';
import FolderIcon from '@mui/icons-material/Folder';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import TimerIcon from '@mui/icons-material/Timer';
import TimerOffIcon from '@mui/icons-material/TimerOff';
import InsertDriveFileOutlinedIcon from '@mui/icons-material/InsertDriveFileOutlined';
import { EmptyState } from '@zapac/mui-theme';
import { json } from '@codemirror/lang-json';
import { javascript } from '@codemirror/lang-javascript';
import { markdown } from '@codemirror/lang-markdown';
import CmEditor from '@/components/CmEditor.jsx';
import DetailPane from '@/components/DetailPane.jsx';
import DirPicker from '@/components/DirPicker.jsx';
import Rail from '@/components/panelkit/Rail.jsx';
import RailHeader from '@/components/panelkit/RailHeader.jsx';
import EmptyListLine from '@/components/EmptyListLine.jsx';
import SaveBar from '@/components/panelkit/SaveBar.jsx';
import { useDirtyGuard } from '@/components/panelkit/useDirtyGuard.jsx';
import { tildify, untildify } from '@/lib/paths.js';
import FileTree from './FileTree.jsx';
import TabStrip from './TabStrip.jsx';

const TOKEN = window.__SING_TOKEN__;

// Language extension per file extension — mirrors HooksEditor's langFor, plus
// markdown() since Skills/Rules views already pull that package in.
function langFor(path) {
  const ext = (path || '').toLowerCase().split('.').pop();
  if (ext === 'mjs' || ext === 'js' || ext === 'cjs' || ext === 'jsx') return javascript({ jsx: ext === 'jsx' });
  if (ext === 'json') return json();
  if (ext === 'md' || ext === 'markdown') return markdown();
  return null;
}

// Path helpers matching DirPicker's own separator convention: build child
// paths with whatever separator is already present in the parent path.
const sepOf = (p) => (p.includes('/') && !p.includes('\\') ? '/' : '\\');
const joinPath = (dir, name) => (dir.endsWith(sepOf(dir)) ? dir + name : dir + sepOf(dir) + name);
const baseOf = (p) => { const s = sepOf(p); const i = p.lastIndexOf(s); return i < 0 ? p : p.slice(i + 1); };

export default function ExplorerPanel() {
  const [root, setRoot] = useState('~'); // tildified
  const [picking, setPicking] = useState(false);
  const [childrenByPath, setChildrenByPath] = useState(new Map()); // absPath -> {entries, capped}
  const [expanded, setExpanded] = useState(new Set()); // absPaths
  const [q, setQ] = useState('');
  const [results, setResults] = useState(null); // null = browse the tree; else {list, capped}
  const [menu, setMenu] = useState(null); // {x,y,node:{path,type,parentDir}}

  const [tabs, setTabs] = useState([]); // [{path,kind,size,dirty}]
  const [content, setContent] = useState(new Map()); // absPath -> string
  const [active, setActive] = useState(null);
  const [autosave, setAutosave] = useState(false);
  const [msg, setMsg] = useState(null);

  // Autosave's 5s timer fires long after the render that armed it, so `save`
  // can't read `content` from that closure (it predates the keystroke that
  // armed the timer) — it reads the latest map through this ref instead.
  const contentRef = useRef(content);
  useEffect(() => { contentRef.current = content; }, [content]);
  const tabsRef = useRef(tabs); // same reason: the focus listener + autosave timer outlive their render
  useEffect(() => { tabsRef.current = tabs; }, [tabs]);

  const loadedRef = useRef(false); // guards the debounced PUT until restore finishes
  const autosaveTimer = useRef(null); // {id, path} — one pending timer, always for the active tab

  const clearAutosaveTimer = () => { if (autosaveTimer.current) { clearTimeout(autosaveTimer.current.id); autosaveTimer.current = null; } };
  const rootAbs = untildify(root);
  const { ensureSaved, dialogEl } = useDirtyGuard();

  const relist = (dir) => {
    fetch(`/fs/list?path=${encodeURIComponent(dir)}`).then((r) => r.json()).then((d) => {
      if (!d.ok) return;
      setChildrenByPath((m) => { const n = new Map(m); n.set(dir, { entries: d.entries, capped: d.capped }); return n; });
    });
  };

  // Initial restore: GET /fs/state, then load the root + every expanded dir's
  // listing and re-read every restored tab in parallel. Tabs whose read fails
  // are dropped. loadedRef flips only once everything above has settled, so
  // the debounced save effect below can't clobber /fs/state with a half-loaded view.
  useEffect(() => {
    let cancelled = false;
    fetch('/fs/state').then((r) => r.json()).then(async (d) => {
      const st = d.state || {};
      const rt = st.root || '~';
      const rootAbs = untildify(rt);
      const expandedPaths = st.expanded || [];
      const dirLoads = [rootAbs, ...expandedPaths].map((p) =>
        fetch(`/fs/list?path=${encodeURIComponent(p)}`).then((r) => r.json())
          .then((dd) => (dd.ok ? [p, { entries: dd.entries, capped: dd.capped }] : null)).catch(() => null));
      const tabLoads = (st.tabs || []).map((p) =>
        fetch(`/fs/read?path=${encodeURIComponent(p)}`).then((r) => r.json())
          .then((dd) => (dd.ok ? { path: p, kind: dd.kind, size: dd.size, mtime: dd.mtime, content: dd.content } : null)).catch(() => null));
      const [dirResults, tabResults] = await Promise.all([Promise.all(dirLoads), Promise.all(tabLoads)]);
      if (cancelled) return;
      setRoot(rt);
      setAutosave(!!st.autosave);
      setChildrenByPath(new Map(dirResults.filter(Boolean)));
      setExpanded(new Set(expandedPaths));
      const okTabs = tabResults.filter(Boolean);
      setTabs(okTabs.map((t) => ({ path: t.path, kind: t.kind, size: t.size, mtime: t.mtime, dirty: false })));
      setContent(new Map(okTabs.map((t) => [t.path, t.content ?? ''])));
      setActive(okTabs.some((t) => t.path === st.active) ? st.active : null);
      loadedRef.current = true;
    }).catch(() => { loadedRef.current = true; });
    return () => { cancelled = true; };
  }, []);

  // Debounced persist — keyed off derived string/primitive values so a dirty-flag
  // toggle (which recreates `tabs`) doesn't reset the debounce on every keystroke.
  const expandedKey = [...expanded].join('|');
  const tabPathsKey = tabs.map((t) => t.path).join('|');
  useEffect(() => {
    if (!loadedRef.current) return;
    const id = setTimeout(() => {
      fetch('/fs/state', {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ root, expanded: [...expanded], tabs: tabs.map((t) => t.path), active, autosave }),
      });
    }, 400);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- expandedKey/tabPathsKey stand in for expanded/tabs (see above)
  }, [root, expandedKey, tabPathsKey, active, autosave]);

  useEffect(() => () => clearAutosaveTimer(), []);

  // Nothing watches the FS, so an edit made outside the app (notepad, an agent
  // run) leaves the open tab stale. Re-read the active tab when the window
  // regains focus: refresh it if clean, warn if the user has unsaved edits.
  useEffect(() => {
    if (!active) return undefined;
    const onFocus = () => {
      fetch(`/fs/read?path=${encodeURIComponent(active)}`).then((r) => r.json()).then((d) => {
        const tab = tabsRef.current.find((t) => t.path === active);
        if (!d.ok || !tab || d.mtime === tab.mtime) return;
        if (tab.dirty) { setMsg({ sev: 'error', text: 'Changed on disk — saving will ask before overwriting' }); return; }
        setTabs((ts) => ts.map((t) => (t.path === active ? { ...t, kind: d.kind, size: d.size, mtime: d.mtime } : t)));
        if (d.content != null) setContent((m) => { const n = new Map(m); n.set(active, d.content); return n; });
        setMsg({ sev: 'success', text: 'Reloaded from disk' });
      }).catch(() => {});
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [active]);

  // Search is server-side and recursive: a filter over the loaded tree would
  // only ever see folders the user already expanded. Debounced like the other
  // rails' search boxes.
  useEffect(() => {
    const term = q.trim();
    if (!term) return; // stale results are gated on `term` below, so nothing to clear
    const id = setTimeout(() => {
      fetch(`/fs/search?root=${encodeURIComponent(rootAbs)}&q=${encodeURIComponent(term)}`)
        .then((r) => r.json()).then((d) => { if (d.ok) setResults({ term, list: d.results, capped: d.capped }); })
        .catch(() => setResults({ term, list: [], capped: false }));
    }, 250);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rootAbs derives from root
  }, [q, root]);

  const onToggleDir = (path) => {
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(path)) n.delete(path); else n.add(path);
      return n;
    });
    if (!childrenByPath.has(path)) relist(path);
  };

  const allOpen = expanded.size > 0;
  const toggleAll = () => setExpanded(new Set()); // "expand all" would mean recursive prefetch — not done here

  const save = async (path, force = false) => {
    if (autosaveTimer.current?.path === path) clearAutosaveTimer();
    const r = await fetch('/fs/write', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path, content: contentRef.current.get(path) ?? '', mtime: tabsRef.current.find((t) => t.path === path)?.mtime, force }),
    }).then((x) => x.json()).catch((e) => ({ ok: false, error: String(e) }));
    // 409: the file changed underneath us (an external editor). Ask once, then
    // re-save with force — never overwrite someone else's edit silently.
    if (r.error === 'changed on disk') {
      if (window.confirm('This file changed on disk since it was opened. Overwrite it?')) return save(path, true);
      setMsg({ sev: 'error', text: 'Not saved — file changed on disk' });
      return;
    }
    if (r.ok) { setTabs((ts) => ts.map((t) => (t.path === path ? { ...t, dirty: false, mtime: r.mtime } : t))); setMsg({ sev: 'success', text: 'Saved' }); }
    else setMsg({ sev: 'error', text: r.error || 'save failed' });
  };

  // Flushes the outgoing tab's pending autosave (if any) before moving focus —
  // only the active tab ever has a live timer, so this always targets it.
  const switchActive = (path) => {
    if (autosaveTimer.current) save(autosaveTimer.current.path);
    setActive(path);
    setMsg(null);
  };

  // Alt+Up/Down cycles editor tabs when this panel's CodeMirror has focus.
  // key={active} remounts CmEditor on switch, so refocus the new cm-content
  // one frame after switchActive (remount lands on next render).
  const editorHostRef = useRef(null);
  useEffect(() => {
    const onKey = (e) => {
      if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
      const ae = document.activeElement;
      if (!ae?.closest?.('.cm-editor')) return;
      if (tabs.length < 2) return;
      e.preventDefault();
      const idx = tabs.findIndex((t) => t.path === active);
      if (idx < 0) return;
      const dir = e.key === 'ArrowUp' ? -1 : 1;
      const next = tabs[(idx + dir + tabs.length) % tabs.length];
      switchActive(next.path);
      requestAnimationFrame(() => editorHostRef.current?.querySelector('.cm-content')?.focus());
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tabs, active, switchActive]);

  const openFile = (path) => {
    if (path === active) return;
    if (tabs.some((t) => t.path === path)) { switchActive(path); return; }
    fetch(`/fs/read?path=${encodeURIComponent(path)}`).then((r) => r.json()).then((d) => {
      if (!d.ok) return;
      setTabs((ts) => [...ts, { path, kind: d.kind, size: d.size, mtime: d.mtime, dirty: false }]);
      setContent((m) => { const n = new Map(m); n.set(path, d.content ?? ''); return n; });
      switchActive(path);
    });
  };

  const removeTab = (path) => {
    const idx = tabs.findIndex((t) => t.path === path);
    if (idx === -1) return;
    const next = tabs.filter((t) => t.path !== path);
    setTabs(next);
    setContent((m) => { const n = new Map(m); n.delete(path); return n; });
    if (active === path) setActive(next[idx]?.path ?? next[idx - 1]?.path ?? null);
    if (autosaveTimer.current?.path === path) clearAutosaveTimer();
  };

  const closeTab = async (path) => {
    const tab = tabs.find((t) => t.path === path);
    if (tab?.dirty) {
      if (autosave) save(path); // flush instead of prompting
      else if (!await ensureSaved({ dirty: true, save: () => save(path) })) return;
    }
    removeTab(path);
  };

  const onChange = (path, value) => {
    setContent((m) => { const n = new Map(m); n.set(path, value); return n; });
    setTabs((ts) => ts.map((t) => (t.path === path && !t.dirty ? { ...t, dirty: true } : t)));
    setMsg(null);
    if (autosave) { clearAutosaveTimer(); autosaveTimer.current = { path, id: setTimeout(() => save(path), 5000) }; }
  };

  const toggleAutosave = () => { setAutosave((v) => !v); clearAutosaveTimer(); };

  // Search hit on a folder: expand the whole chain from the root down to it,
  // load any of those levels not cached yet, and drop back to tree view.
  const revealDir = (dirAbs) => {
    const sep = sepOf(dirAbs);
    const chain = [];
    for (let p = dirAbs; p.length > rootAbs.length && p.startsWith(rootAbs); p = p.slice(0, p.lastIndexOf(sep))) {
      chain.push(p);
      if (p.lastIndexOf(sep) < 0) break;
    }
    setExpanded((s) => { const n = new Set(s); chain.forEach((c) => n.add(c)); return n; });
    chain.forEach((c) => { if (!childrenByPath.has(c)) relist(c); });
    setQ('');
  };

  const pickRoot = (absPath) => {
    setRoot(tildify(absPath));
    setExpanded(new Set());
    setChildrenByPath(new Map());
    relist(absPath);
    setPicking(false);
  };

  // Tree mutations — right-click New File/Folder/Rename/Delete. Errors surface
  // via window.alert, matching the repo's window.confirm/prompt convention (no
  // dialog component).
  const createEntry = (dir, kind) => {
    const name = window.prompt(kind === 'dir' ? 'Folder name:' : 'File name:');
    if (!name) return;
    fetch('/fs/entry', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: joinPath(dir, name), kind }),
    }).then((r) => r.json()).then((d) => {
      if (!d.ok) { window.alert(d.error || 'Failed'); return; }
      relist(dir);
      setExpanded((s) => new Set(s).add(dir));
    });
  };

  const renameEntry = (node) => {
    const name = window.prompt('Rename to:', baseOf(node.path));
    if (!name) return;
    const to = joinPath(node.parentDir, name);
    fetch('/fs/rename', {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from: node.path, to }),
    }).then((r) => r.json()).then((d) => {
      if (!d.ok) { window.alert(d.error || 'Failed'); return; }
      relist(node.parentDir);
      if (node.type === 'dir') {
        // Renaming a dir invalidates any cached grandchildren under the old
        // prefix — simplest safe move is to collapse+drop it, not remap paths.
        setExpanded((s) => { const n = new Set(s); n.delete(node.path); return n; });
        setChildrenByPath((m) => { const n = new Map(m); n.delete(node.path); return n; });
      }
      const sep = sepOf(node.path);
      const remap = (p) => (p === node.path || p.startsWith(node.path + sep) ? to + p.slice(node.path.length) : p);
      setTabs((ts) => ts.map((t) => ({ ...t, path: remap(t.path) })));
      setContent((m) => new Map([...m].map(([k, v]) => [remap(k), v])));
      setActive((a) => (a == null ? a : remap(a)));
    });
  };

  const deleteEntry = (node) => {
    if (!window.confirm(`Delete "${baseOf(node.path)}"?`)) return;
    const sep = sepOf(node.path);
    const under = tabs.filter((t) => t.path === node.path || t.path.startsWith(node.path + sep));
    fetch(`/fs/entry?path=${encodeURIComponent(node.path)}`, { method: 'DELETE' }).then((r) => r.json()).then((d) => {
      if (!d.ok) { window.alert(d.error || 'Failed'); return; }
      relist(node.parentDir);
      under.forEach((t) => removeTab(t.path));
      setExpanded((s) => { const n = new Set(s); n.delete(node.path); return n; });
      setChildrenByPath((m) => { const n = new Map(m); n.delete(node.path); return n; });
    });
  };

  const groupToggleDisabled = !(childrenByPath.get(rootAbs)?.entries?.length);
  const searching = !!q.trim();
  const hits = searching && results?.term === q.trim() ? results : null; // gated so a stale term never shows
  const activeTab = tabs.find((t) => t.path === active);
  const lang = langFor(active);
  const imgSrc = active ? `/fs/raw?path=${encodeURIComponent(active)}${TOKEN ? `&token=${encodeURIComponent(TOKEN)}` : ''}` : null;

  return (
    <Box sx={{ display: 'flex', height: '100%', minHeight: 0 }}>
      <Rail storageKey="sing-explorer-w" defaultWidth={280} collapsedTitle="Show file tree">
        {({ collapse }) => (
          <>
            <RailHeader
              searchPlaceholder="Search files…"
              searchValue={q}
              onSearchChange={setQ}
              allOpen={allOpen}
              onToggleAll={toggleAll}
              groupToggleDisabled={groupToggleDisabled}
              onPickFolder={() => setPicking(true)}
              onCollapse={collapse}
              extra={
                <Tooltip title={autosave ? 'Autosave on (5s)' : 'Autosave off'} placement="bottom" disableInteractive>
                  <IconButton size="small" onClick={toggleAutosave} sx={{ color: autosave ? 'primary.main' : undefined }}>
                    {autosave ? <TimerIcon fontSize="small" /> : <TimerOffIcon fontSize="small" />}
                  </IconButton>
                </Tooltip>
              }
            >
              <Typography variant="code" noWrap title={rootAbs} sx={{ color: 'text.secondary', fontSize: 11, ml: 2, display: 'block' }}>{tildify(root)}</Typography>
            </RailHeader>
            {/* Right-click on the empty area targets the root itself — the only
                way to create a top-level entry when the root shows no rows. */}
            <List dense sx={{ flex: 1, minHeight: 0, overflow: 'auto', px: 0.5, pt: 0 }}
              onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, node: { path: rootAbs, type: 'dir', parentDir: rootAbs, isRoot: true } }); }}
            >
              {searching ? (
                <>
                  {(hits?.list || []).map((r) => (
                    <ListItemButton key={r.path} selected={r.path === active} sx={{ borderRadius: 1, py: 0.25 }}
                      onClick={() => (r.type === 'dir' ? revealDir(r.path) : openFile(r.path))}
                      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setMenu({ x: e.clientX, y: e.clientY, node: { path: r.path, type: r.type, parentDir: r.path.slice(0, r.path.lastIndexOf(sepOf(r.path))) } }); }}
                    >
                      <ListItemIcon sx={{ minWidth: 22, color: 'text.secondary' }}>
                        {r.type === 'dir' ? <FolderIcon fontSize="small" /> : <InsertDriveFileOutlinedIcon fontSize="small" />}
                      </ListItemIcon>
                      <Box sx={{ minWidth: 0 }}>
                        <Typography noWrap sx={{ fontSize: 13 }}>{r.name}</Typography>
                        <Typography noWrap title={r.path} sx={{ fontSize: 10, color: 'text.secondary' }}>{r.path.slice(rootAbs.length + 1) || tildify(root)}</Typography>
                      </Box>
                    </ListItemButton>
                  ))}
                  {!hits && <EmptyListLine>Searching…</EmptyListLine>}
                  {hits && !hits.list.length && <EmptyListLine>No matches.</EmptyListLine>}
                  {hits?.capped && <Typography sx={{ px: 2, py: 0.5, color: 'text.secondary', fontSize: 11 }}>Stopped early — narrow the search.</Typography>}
                </>
              ) : (
                <>
                  <FileTree path={rootAbs} depth={0} expanded={expanded} childrenByPath={childrenByPath}
                    activePath={active} onToggleDir={onToggleDir} onOpenFile={openFile}
                    onContextMenu={(e, node) => setMenu({ x: e.clientX, y: e.clientY, node })} />
                  {groupToggleDisabled && <EmptyListLine>No files.</EmptyListLine>}
                </>
              )}
            </List>
          </>
        )}
      </Rail>

      <Stack ref={editorHostRef} sx={{ flex: 1, minWidth: 0, minHeight: 0, height: '100%' }}
        onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); if (active) save(active); } }}>
        {tabs.length > 0 && <TabStrip tabs={tabs} active={active} onSelect={openFile} onClose={closeTab} />}
        <Stack sx={{ flex: 1, minWidth: 0, minHeight: 0, p: 2 }} spacing={1.5}>
          <DetailPane empty={!activeTab && <EmptyState icon={<InsertDriveFileOutlinedIcon />} title="Select a file" description="Browse the tree on the left to open a file here." />}>
            <Typography noWrap variant="code" sx={{ flexShrink: 0, color: 'text.secondary', fontSize: 11 }}>{tildify(active)}</Typography>
            {activeTab?.kind === 'text' && (
              // key={active}: same @uiw typing-latch reason as HooksEditor — a deferred
              // `value` update from switching files mid-type would show stale content.
              <CmEditor key={active} value={content.get(active) ?? ''} onChange={(v) => onChange(active, v)} extensions={lang ? [lang] : []} deps={[active]} />
            )}
            {activeTab?.kind === 'image' && (
              <Box component="img" src={imgSrc} sx={{ flex: 1, minHeight: 0, maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
            )}
            {(activeTab?.kind === 'binary' || activeTab?.kind === 'toolarge') && (
              <Typography color="text.secondary" sx={{ fontSize: 13 }}>
                {activeTab.kind === 'toolarge' ? 'File too large to preview.' : "Can't preview this file type."}
              </Typography>
            )}
            {activeTab?.kind === 'text' && <SaveBar msg={msg} disabled={!activeTab.dirty} onSave={() => save(active)} />}
          </DetailPane>
        </Stack>
      </Stack>

      {picking && <DirPicker start={rootAbs} onPick={pickRoot} onClose={() => setPicking(false)} />}

      <Menu open={!!menu} onClose={() => setMenu(null)} anchorReference="anchorPosition"
        anchorPosition={menu ? { top: menu.y, left: menu.x } : undefined}>
        <MenuItem onClick={() => { const n = menu.node; setMenu(null); createEntry(n.type === 'dir' ? n.path : n.parentDir, 'file'); }}>New File</MenuItem>
        <MenuItem onClick={() => { const n = menu.node; setMenu(null); createEntry(n.type === 'dir' ? n.path : n.parentDir, 'dir'); }}>New Folder</MenuItem>
        {!menu?.node.isRoot && <MenuItem onClick={() => { const n = menu.node; setMenu(null); renameEntry(n); }}>Rename</MenuItem>}
        {!menu?.node.isRoot && <MenuItem onClick={() => { const n = menu.node; setMenu(null); deleteEntry(n); }}>Delete</MenuItem>}
      </Menu>

      {dialogEl}
    </Box>
  );
}
