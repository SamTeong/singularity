import { useEffect, useRef, useState, useMemo } from 'react';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import IconButton from '@mui/material/IconButton';
import Collapse from '@mui/material/Collapse';
import Tooltip from '@mui/material/Tooltip';
import FolderIcon from '@mui/icons-material/Folder';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import InsertDriveFileOutlinedIcon from '@mui/icons-material/InsertDriveFileOutlined';
import ClearIcon from '@mui/icons-material/Clear';
import TimerIcon from '@mui/icons-material/Timer';
import TimerOffIcon from '@mui/icons-material/TimerOff';
import { EmptyState } from '@zapac/mui-theme';
import { json } from '@codemirror/lang-json';
import CmEditor from '@/components/CmEditor.jsx';
import DirPicker from '@/components/DirPicker.jsx';
import Rail from '@/components/panelkit/Rail.jsx';
import RailHeader from '@/components/panelkit/RailHeader.jsx';
import EmptyListLine from '@/components/EmptyListLine.jsx';
import SaveBar from '@/components/panelkit/SaveBar.jsx';
import TabStrip from '@/features/explorer/TabStrip.jsx';
import { useRootList, normKey } from '@/components/panelkit/useRootList.js';
import { useDirtyGuard } from '@/components/panelkit/useDirtyGuard.jsx';
import { tildify, untildify } from '@/lib/paths.js';

// Config files under a root. Claude: project + local settings JSON. Codex: a
// single config.toml — `user` scope when the root is home (~/.codex/config.toml),
// `project` otherwise (<root>/.codex/config.toml) — mirrors writeConfig's home
// check so the leaf we show is the one save writes.
const CLAUDE_LEAVES = [
  { scope: 'project', name: 'settings.json' },
  { scope: 'local', name: 'settings.local.json' },
];
const CODEX_LEAF_NAME = 'config.toml';
const codexScope = (cwd) => (untildify(cwd) === untildify('~') ? 'user' : 'project');
const toolBase = (tool) => (tool === 'codex' ? '/codex-config' : '/config');

export default function ConfigEditor() {
  // Roots stay separate server-side (the isKnownConfigRoot security gate is
  // per-tool), but the rail shows the union and pick/remember touch both so
  // the user curates one set.
  const claudeRoots = useRootList('/config', { initial: ['~'] });
  const codexRoots = useRootList('/codex-config', { initial: ['~'] });
  const { ensureSaved, dialogEl } = useDirtyGuard();

  const [tabs, setTabs] = useState([]); // [{path, cwd, tool, scope, dirty, mtime}]
  const [content, setContent] = useState(new Map()); // path -> string
  const [active, setActive] = useState(null);
  const [autosave, setAutosave] = useState(false);
  const [msg, setMsg] = useState(null);
  const [expanded, setExpanded] = useState(new Set()); // root strings (raw)
  const [byRoot, setByRoot] = useState(new Map()); // `${tool}:${cwd}` -> readConfig result
  const [q, setQ] = useState('');
  const [results, setResults] = useState(null); // null = tree; else { term, list:[{cwd,tool,scope,path,line,text}] }
  const [picking, setPicking] = useState(false);

  // Autosave's 5s timer + the focus listener outlive their render, so save
  // reads the latest content/tabs through these refs instead of a stale closure
  // (same pattern as ExplorerPanel).
  const contentRef = useRef(content);
  useEffect(() => { contentRef.current = content; }, [content]);
  const tabsRef = useRef(tabs);
  useEffect(() => { tabsRef.current = tabs; }, [tabs]);
  const autosaveTimer = useRef(null); // {id, path} — one pending timer, always for the active tab
  const loadedRef = useRef(false); // guards the debounced PUT until restore settles

  const clearTimer = () => { if (autosaveTimer.current) { clearTimeout(autosaveTimer.current.id); autosaveTimer.current = null; } };

  const shownRoots = useMemo(() => {
    const map = new Map();
    for (const p of [...claudeRoots.roots, ...codexRoots.roots]) map.set(normKey(p), p);
    return [...map.values()].sort((a, b) => normKey(a).localeCompare(normKey(b)));
  }, [claudeRoots.roots, codexRoots.roots]);
  const inClaude = (p) => claudeRoots.roots.some((r) => normKey(r) === normKey(p));
  const inCodex = (p) => codexRoots.roots.some((r) => normKey(r) === normKey(p));

  const activeTab = tabs.find((t) => t.path === active) || null;

  const validationError = useMemo(() => {
    if (!activeTab || activeTab.tool !== 'claude') return null;
    const v = content.get(activeTab.path) || '';
    if (!v.trim()) return null;
    try { JSON.parse(v); return null; } catch (e) { return e.message; }
  }, [activeTab, content]);

  // readConfig for a (tool, cwd), cached in byRoot. `force` bypasses the cache
  // (focus-reload wants a fresh mtime, not the cached one it just compared).
  const readRoot = async (tool, cwd, opts = {}) => {
    const key = `${tool}:${cwd}`;
    if (!opts.force) {
      const cached = byRoot.get(key);
      if (cached) return cached;
    }
    const d = await fetch(`${toolBase(tool)}?cwd=${encodeURIComponent(cwd)}`).then((r) => r.json()).catch(() => null);
    if (!d) return byRoot.get(key) || null;
    setByRoot((m) => { const n = new Map(m); n.set(key, d); return n; });
    return d;
  };

  // Fetch any expanded root not yet cached. Runs on expand, after roots load
  // (restore may set `expanded` before useRootList settles), and after a pick.
  useEffect(() => {
    expanded.forEach((cwd) => {
      if (inClaude(cwd) && !byRoot.has(`claude:${cwd}`)) readRoot('claude', cwd);
      if (inCodex(cwd) && !byRoot.has(`codex:${cwd}`)) readRoot('codex', cwd);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- inClaude/inCodex derive from the roots deps
  }, [expanded, shownRoots, byRoot]);

  // Restore open tabs / autosave / expanded roots from /config/state.
  useEffect(() => {
    let cancelled = false;
    fetch('/config/state').then((r) => r.json()).then(async ({ state }) => {
      const st = state || {};
      setAutosave(!!st.autosave);
      const exp = Array.isArray(st.expanded) ? st.expanded : [];
      setExpanded(new Set(exp));
      const tabDefs = (st.tabs || []).filter((t) => t && t.cwd && t.tool && t.scope);
      const loads = tabDefs.map(async (t) => {
        const d = await readRoot(t.tool, t.cwd);
        if (!d || !d[t.scope]) return null;
        const e = d[t.scope];
        return { path: e.path, cwd: t.cwd, tool: t.tool, scope: t.scope, dirty: false, mtime: e.mtime || 0, text: e.content || '' };
      });
      const okTabs = (await Promise.all(loads)).filter(Boolean);
      if (cancelled) return;
      setTabs(okTabs.map(({ text, ...meta }) => meta));
      setContent(new Map(okTabs.map((t) => [t.path, t.text])));
      setActive(okTabs.some((t) => t.path === st.active) ? st.active : (okTabs[0]?.path ?? null));
      loadedRef.current = true;
    }).catch(() => { loadedRef.current = true; });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot restore
  }, []);

  // Debounced persist — keyed off derived primitives so a dirty-flag toggle
  // (which recreates `tabs`) doesn't reset the debounce on every keystroke.
  const expandedKey = [...expanded].join('|');
  const tabKey = tabs.map((t) => `${t.tool}:${t.cwd}:${t.scope}`).join('|');
  useEffect(() => {
    if (!loadedRef.current) return;
    const id = setTimeout(() => {
      fetch('/config/state', {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          tabs: tabs.map((t) => ({ cwd: t.cwd, tool: t.tool, scope: t.scope, path: t.path })),
          active, autosave, expanded: [...expanded],
        }),
      });
    }, 400);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- expandedKey/tabKey stand in for expanded/tabs
  }, [expandedKey, tabKey, active, autosave]);

  useEffect(() => () => clearTimer(), []);

  // Re-read the active tab when the window regains focus: refresh if clean,
  // warn if dirty (an external editor/agent changed it underneath us).
  useEffect(() => {
    if (!active) return undefined;
    const onFocus = () => {
      const tab = tabsRef.current.find((t) => t.path === active);
      if (!tab) return;
      readRoot(tab.tool, tab.cwd, { force: true }).then((d) => {
        if (!d || !d[tab.scope]) return;
        const e = d[tab.scope];
        if (e.mtime === tab.mtime) return;
        if (tab.dirty) { setMsg({ sev: 'error', text: 'Changed on disk — saving will ask before overwriting' }); return; }
        setTabs((ts) => ts.map((t) => (t.path === active ? { ...t, mtime: e.mtime } : t)));
        setContent((m) => { const n = new Map(m); n.set(active, e.content || ''); return n; });
        setMsg({ sev: 'success', text: 'Reloaded from disk' });
      });
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- readRoot closure is fine; re-bind only on active
  }, [active]);
  // Content search across both tools' roots (fire both, tag hits with tool).
  useEffect(() => {
    const term = q.trim();
    if (!term) return;
    const id = setTimeout(() => {
      Promise.all([
        fetch('/config/search', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ roots: claudeRoots.roots, q: term }) }).then((r) => r.json()).catch(() => ({ results: [] })),
        fetch('/codex-config/search', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ roots: codexRoots.roots, q: term }) }).then((r) => r.json()).catch(() => ({ results: [] })),
      ]).then(([c, x]) => {
        const list = [...(c.results || []).map((h) => ({ ...h, tool: 'claude' })), ...(x.results || []).map((h) => ({ ...h, tool: 'codex' }))];
        setResults({ term, list });
      });
    }, 250);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- roots derive from the listed deps
  }, [q, claudeRoots.roots, codexRoots.roots]);

  const save = async (path, force = false) => {
    const tab = tabsRef.current.find((t) => t.path === path);
    if (!tab) return;
    if (autosaveTimer.current?.path === path) clearTimer();
    const r = await fetch(`${toolBase(tab.tool)}/${tab.scope}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: tab.cwd, content: contentRef.current.get(path) ?? '', mtime: tab.mtime, force }),
    }).then((x) => x.json()).catch((e) => ({ ok: false, error: String(e) }));
    if (r.error === 'changed on disk') {
      if (window.confirm('This file changed on disk since it was opened. Overwrite it?')) return save(path, true);
      setMsg({ sev: 'error', text: 'Not saved — file changed on disk' });
      return;
    }
    if (r.ok) {
      setTabs((ts) => ts.map((t) => (t.path === path ? { ...t, dirty: false, mtime: r.mtime } : t)));
      setMsg({ sev: 'success', text: `Saved${r.backup ? ' (backup made)' : ''}` });
      // Keep the byRoot cache in step so a later scope switch / focus-reload
      // reads the just-written content+mtime, not the pre-save snapshot.
      setByRoot((m) => {
        const key = `${tab.tool}:${tab.cwd}`;
        const cur = m.get(key);
        if (!cur || !cur[tab.scope]) return m;
        const next = new Map(m);
        next.set(key, { ...cur, [tab.scope]: { ...cur[tab.scope], content: contentRef.current.get(path) ?? '', mtime: r.mtime ?? cur[tab.scope].mtime, exists: true } });
        return next;
      });
    } else setMsg({ sev: 'error', text: r.error || 'save failed' });
  };

  // Flush the outgoing tab's pending autosave before moving focus — only the
  // active tab ever has a live timer.
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

  const openFile = async (cwd, tool, scope) => {
    const d = await readRoot(tool, cwd);
    if (!d || !d[scope]) return;
    const entry = d[scope];
    const path = entry.path;
    if (path === active) return;
    if (tabs.some((t) => t.path === path)) { switchActive(path); return; }
    setTabs((ts) => [...ts, { path, cwd, tool, scope, dirty: false, mtime: entry.mtime || 0 }]);
    setContent((m) => { const n = new Map(m); n.set(path, entry.content || ''); return n; });
    switchActive(path);
  };

  const removeTab = (path) => {
    const idx = tabs.findIndex((t) => t.path === path);
    if (idx === -1) return;
    const next = tabs.filter((t) => t.path !== path);
    setTabs(next);
    setContent((m) => { const n = new Map(m); n.delete(path); return n; });
    if (active === path) setActive(next[idx]?.path ?? next[idx - 1]?.path ?? null);
    if (autosaveTimer.current?.path === path) clearTimer();
  };

  const closeTab = async (path) => {
    const tab = tabs.find((t) => t.path === path);
    if (tab?.dirty) {
      if (autosave) save(path); // flush instead of prompting
      else if (!await ensureSaved({ dirty: true, save: () => save(path) })) return;
    }
    removeTab(path);
  };

  const onChange = (value) => {
    if (!active) return;
    setContent((m) => { const n = new Map(m); n.set(active, value); return n; });
    setTabs((ts) => ts.map((t) => (t.path === active && !t.dirty ? { ...t, dirty: true } : t)));
    setMsg(null);
    if (autosave) { clearTimer(); autosaveTimer.current = { path: active, id: setTimeout(() => save(active), 5000) }; }
  };

  const toggleRoot = (cwd) => {
    setExpanded((s) => { const n = new Set(s); if (n.has(cwd)) n.delete(cwd); else n.add(cwd); return n; });
  };

  const pick = async (p) => {
    if (!await ensureSaved({ dirty: !!activeTab?.dirty, save: () => active && save(active) })) return;
    claudeRoots.remember([p]);
    codexRoots.remember([p]);
    setPicking(false);
    setExpanded((s) => new Set(s).add(p));
  };

  const forget = (p) => { claudeRoots.forget(p); codexRoots.forget(p); };

  const openResult = async (it) => {
    if (!await ensureSaved({ dirty: !!activeTab?.dirty, save: () => active && save(active) })) return;
    openFile(it.cwd, it.tool, it.scope);
  };

  const toggleAutosave = () => { setAutosave((v) => !v); clearTimer(); };

  const searching = q.trim() && results;
  const rowSx = { borderRadius: 4, pl: 1, py: 0.25, mb: 0.25 };

  return (
    <Box sx={{ display: 'flex', height: '100%', minHeight: 0 }}>
      <Rail storageKey="sing-config-w" defaultWidth={300} collapsedTitle="Show config paths">
        {({ collapse }) => (
          <>
            <RailHeader
              searchPlaceholder="Search config…"
              searchValue={q}
              onSearchChange={setQ}
              onPickFolder={async () => { if (!await ensureSaved({ dirty: !!activeTab?.dirty, save: () => active && save(active) })) return; setPicking(true); }}
              onCollapse={collapse}
            />
            <List dense sx={{ flex: 1, minHeight: 0, overflow: 'auto', px: 0.5, pt: 0 }}>
              {searching ? (
                <>
                  {results.list.map((it, i) => (
                    <ListItemButton key={`${it.path}:${i}`} onClick={() => openResult(it)}
                      sx={{ ...rowSx, display: 'block' }}>
                      <Typography variant="code" sx={{ fontSize: 11 }} noWrap title={it.path}>{tildify(it.path)}:{it.line}</Typography>
                      <Typography sx={{ fontSize: 12, color: 'text.secondary', mt: 0.5, fontFamily: 'monospace' }} noWrap>{it.text}</Typography>
                    </ListItemButton>
                  ))}
                  {results.list.length === 0 && <Typography color="text.secondary" sx={{ fontSize: 12, p: 1.5 }}>No matches.</Typography>}
                </>
              ) : (
                <>
                  {shownRoots.map((p) => {
                    const open = expanded.has(p);
                    const claudeCfg = byRoot.get(`claude:${p}`);
                    const codexCfg = byRoot.get(`codex:${p}`);
                    const showClaude = inClaude(p);
                    const showCodex = inCodex(p);
                    return (
                      <Box key={p} sx={{ mb: 0.25 }}>
                        <ListItemButton onClick={() => toggleRoot(p)} sx={{ ...rowSx, '&:hover .del': { opacity: 1 } }}>
                          {open ? <ExpandMoreIcon fontSize="small" sx={{ mr: 0.5 }} /> : <ChevronRightIcon fontSize="small" sx={{ mr: 0.5 }} />}
                          {open ? <FolderOpenIcon fontSize="small" color="primary" /> : <FolderIcon fontSize="small" color="primary" />}
                          <Typography noWrap sx={{ fontSize: 12, fontFamily: 'monospace', ml: 0.5, flex: 1 }} title={p}>{tildify(p)}</Typography>
                          <IconButton className="del" size="small" aria-label="Remove from list" title="Remove from list"
                            onClick={(e) => { e.stopPropagation(); forget(p); }} sx={{ opacity: 0, p: 0.25 }}>
                            <ClearIcon fontSize="small" />
                          </IconButton>
                        </ListItemButton>
                        <Collapse in={open} timeout="auto" unmountOnExit>
                          {showClaude && (
                            <Group label=".claude">
                              {CLAUDE_LEAVES.map((leaf) => {
                                const entry = claudeCfg?.[leaf.scope];
                                const exists = !!entry?.exists;
                                const sel = entry?.path === active;
                                return (
                                  <ListItemButton key={leaf.scope} selected={sel} onClick={() => openFile(p, 'claude', leaf.scope)}
                                    sx={{ ...rowSx, pl: 3 + 2, opacity: entry && !exists ? 0.5 : 1 }}>
                                    <InsertDriveFileOutlinedIcon fontSize="small" sx={{ mr: 0.5, color: 'text.secondary' }} />
                                    <Typography noWrap variant="code" sx={{ fontSize: 12 }}>{leaf.name}{entry && !exists ? ' (new)' : ''}</Typography>
                                  </ListItemButton>
                                );
                              })}
                            </Group>
                          )}
                          {showCodex && (() => {
                            const scope = codexScope(p);
                            const entry = codexCfg?.[scope];
                            const exists = !!entry?.exists;
                            const sel = entry?.path === active;
                            return (
                              <Group label=".codex">
                                <ListItemButton selected={sel} onClick={() => openFile(p, 'codex', scope)}
                                  sx={{ ...rowSx, pl: 3 + 2, opacity: entry && !exists ? 0.5 : 1 }}>
                                  <InsertDriveFileOutlinedIcon fontSize="small" sx={{ mr: 0.5, color: 'text.secondary' }} />
                                  <Typography noWrap variant="code" sx={{ fontSize: 12 }}>{CODEX_LEAF_NAME}{entry && !exists ? ' (new)' : ''}</Typography>
                                </ListItemButton>
                              </Group>
                            );
                          })()}
                        </Collapse>
                      </Box>
                    );
                  })}
                  {shownRoots.length === 0 && <EmptyListLine>No config paths.</EmptyListLine>}
                </>
              )}
            </List>
          </>
        )}
      </Rail>

      <Stack ref={editorHostRef} sx={{ flex: 1, minWidth: 0, height: '100%', p: 2, pt: 1, minHeight: 0 }} spacing={1}>
        {picking && <DirPicker start={untildify(activeTab?.cwd ?? shownRoots[0] ?? '~')} onPick={pick} onClose={() => setPicking(false)} />}
        <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'flex-end' }}>
          <Tooltip title={autosave ? 'Autosave on (5s)' : 'Autosave off'} placement="bottom" disableInteractive>
            <IconButton size="small" onClick={toggleAutosave} color={autosave ? 'primary' : 'default'}>
              {autosave ? <TimerIcon /> : <TimerOffIcon />}
            </IconButton>
          </Tooltip>
        </Stack>
        {tabs.length > 0 && <TabStrip tabs={tabs} active={active} onSelect={switchActive} onClose={closeTab} />}
        {activeTab ? (
          <>
            <Typography noWrap variant="code" sx={{ flexShrink: 0, color: 'text.secondary', fontSize: 11 }}>
              {tildify(activeTab.path)} {!byRoot.get(`${activeTab.tool}:${activeTab.cwd}`)?.[activeTab.scope]?.exists && "· (doesn't exist yet — saving will create it)"}
            </Typography>
            {/* key={active}: @uiw's typing latch defers a `value` change landing
                right after a keystroke — remount per tab so the new file's
                content becomes the initial doc (same fix as HooksEditor). */}
            <CmEditor key={active} value={content.get(active) ?? ''} onChange={onChange} extensions={activeTab.tool === 'codex' ? [] : [json()]} />
            <SaveBar msg={validationError ? null : msg} disabled={!activeTab.dirty || !!validationError} onSave={() => active && save(active)}>
              {validationError && <Typography color="error" variant="code" sx={{ fontSize: 12 }}>This isn't valid JSON: {validationError}</Typography>}
            </SaveBar>
          </>
        ) : (
          <Box sx={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <EmptyState icon={<InsertDriveFileOutlinedIcon />} title="Select a config" description="Browse on the left to view or edit here." />
          </Box>
        )}
      </Stack>
      {dialogEl}
    </Box>
  );
}

// A 2-level tree group: a dimmed label row + indented leaf children. Inlined
// here (not shared) because the config tree is a fixed named set, not a
// recursive FS — FileTree's fetch-on-expand model doesn't fit.
function Group({ label, children }) {
  return (
    <Box>
      <Typography sx={{ pl: 3, pt: 0.5, pb: 0.25, fontSize: 11, color: 'text.secondary', fontFamily: 'monospace' }}>{label}</Typography>
      {children}
    </Box>
  );
}