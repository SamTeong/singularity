import React, { useEffect, useState, useCallback } from 'react';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import Autocomplete from '@mui/material/Autocomplete';
import TextField from '@mui/material/TextField';
import Collapse from '@mui/material/Collapse';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import FolderIcon from '@mui/icons-material/Folder';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import MenuBookIcon from '@mui/icons-material/MenuBook';
import HubIcon from '@mui/icons-material/Hub';
import HorizontalSplitIcon from '@mui/icons-material/HorizontalSplit';
import OpenInFullIcon from '@mui/icons-material/OpenInFull';
import CloseIcon from '@mui/icons-material/Close';
import { StatusPill, EmptyState } from '@zapac/mui-theme';
import DetailPane from './DetailPane.jsx';
import DirPicker from './DirPicker.jsx';
import { parseFrontmatter } from './frontmatter.js';
import MarkdownBody from './MarkdownBody.jsx';
import WikiGraph from './WikiGraph.jsx';
import { tildify, untildify } from './paths.js';
import Rail from './panelkit/Rail.jsx';
import RailSearch from './panelkit/RailSearch.jsx';
import RailGroupToggle from './panelkit/RailGroupToggle.jsx';
import { useCapabilities } from './useCapabilities.js';

// Wiki root persists across sessions on the daemon FS (survives browser cache
// clear). Default ~/wiki; loaded from /wiki/root on mount.
const DEFAULT_ROOT = '~/wiki';
const folder = (rel) => { const i = rel.lastIndexOf('/'); return i < 0 ? '' : rel.slice(0, i); };
// Category = top-level subfolder of the page (concepts/flows/entities); a page
// lives in exactly one, so filtering is single-membership.
const category = (rel) => { const i = rel.indexOf('/'); return i < 0 ? '' : rel.slice(0, i); };

export default function WikiPanel() {
  const [root, setRoot] = useState(DEFAULT_ROOT);
  const [picking, setPicking] = useState(false);
  const [q, setQ] = useState('');
  const [results, setResults] = useState(null); // search hits
  const [wikis, setWikis] = useState([]); // [{name, path, pages:[{path,rel}]}]
  const [capped, setCapped] = useState(false);
  const [err, setErr] = useState(null);
  const [expanded, setExpanded] = useState(() => new Set()); // wiki names
  const [sel, setSel] = useState(null); // {path, rel}
  const [cats, setCats] = useState([]); // active category filter (empty = all)
  const [content, setContent] = useState('');
  const [loadingFile, setLoadingFile] = useState(false);
  const [graphView, setGraphView] = useState(null); // null | 'main' (right pane) | 'dock' (bottom of left nav)
  const caps = useCapabilities();
  // wiki.available is false when the configured root has no wiki subfolders.
  // The root-picker button (top of the rail) is the enable action — keep it
  // reachable; surface the hint in the viewer's empty state.
  const wikiUnavailable = caps && caps.wiki?.available === false;
  const wikiHint = caps?.wiki?.hint;

  // Load the FS-persisted root once on mount (files load via the [root] effect).
  useEffect(() => {
    fetch('/wiki/root').then((r) => r.json()).then((d) => { if (d.root) setRoot(d.root); }).catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    setSel(null); setContent(''); setErr(null);
    fetch(`/wiki/files?root=${encodeURIComponent(untildify(root))}`).then((r) => r.json()).then((d) => {
      if (cancelled) return;
      if (d.error) { setWikis([]); setCapped(false); setErr(d.error); return; }
      setWikis(d.wikis || []); setCapped(!!d.capped); setErr(null);
    }).catch(() => { if (!cancelled) { setWikis([]); setCapped(false); setErr('failed to load wikis'); } });
    return () => { cancelled = true; };
  }, [root]);

  const search = useCallback(() => {
    if (!q.trim()) { setResults(null); return; }
    fetch(`/wiki/search?q=${encodeURIComponent(q.trim())}&root=${encodeURIComponent(untildify(root))}`).then((r) => r.json()).then((d) => {
      setResults(d.results || []); setCapped(!!d.capped);
    });
  }, [q, root]);

  // Debounced search-as-you-type (search() clears results when q is empty).
  useEffect(() => { const id = setTimeout(search, 250); return () => clearTimeout(id); }, [q, search]);

  const open = (item) => {
    if (item.path === sel?.path) return;
    setSel(item); setErr(null); setLoadingFile(true);
    fetch(`/wiki/file?path=${encodeURIComponent(untildify(item.path))}&root=${encodeURIComponent(untildify(root))}`).then((r) => r.json()).then((d) => {
      setContent(d.ok ? d.content : '');
      if (!d.ok) setErr(d.error);
    }).catch(() => { setContent(''); setErr('failed to load page'); }).finally(() => setLoadingFile(false));
  };

  // Selecting a page expands its wiki so the selection is visible in the tree.
  const openPage = (wiki, page) => {
    setExpanded((s) => (s.has(wiki.name) ? s : new Set([...s, wiki.name])));
    open({ path: page.path, rel: `${wiki.name}/${page.rel}` });
  };
  // Jump from a [[wikilink]]. Target (e.g. "entities/session-manager") resolves
  // within the current page's wiki first, then any wiki; matches full rel or
  // basename, with/without .md.
  const jumpTo = (target) => {
    const want = target.replace(/\.md$/i, '').toLowerCase();
    const match = (w) => w.pages.find((p) => {
      const rel = p.rel.replace(/\.md$/i, '').toLowerCase();
      return rel === want || rel.split('/').pop() === want;
    });
    const cur = wikis.find((w) => w.name === sel?.rel.split('/')[0]);
    for (const w of [cur, ...wikis].filter(Boolean)) {
      const page = match(w);
      if (page) { openPage(w, page); return; }
    }
    // ponytail: unresolved link is a no-op (don't blank the current page)
  };
  const toggleWiki = (name) => setExpanded((s) => {
    const n = new Set(s);
    if (n.has(name)) n.delete(name); else n.add(name);
    return n;
  });

  const pickRoot = (p) => {
    setRoot(p); setPicking(false);
    fetch('/wiki/root', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ root: p }) }).catch(() => {});
  };

  // Distinct categories across all pages, and the tree filtered to active ones.
  const allCats = [...new Set(wikis.flatMap((w) => w.pages.map((p) => category(p.rel)).filter(Boolean)))].sort();
  const catSet = new Set(cats);
  const viewWikis = cats.length === 0 ? wikis
    : wikis.map((w) => ({ ...w, pages: w.pages.filter((p) => catSet.has(category(p.rel))) })).filter((w) => w.pages.length);
  const pageCount = viewWikis.reduce((n, w) => n + w.pages.length, 0);
  // Expand/collapse-all over the wiki tree (browse only — search is flat).
  const wikiKeys = viewWikis.map((w) => w.name);
  const allOpen = wikiKeys.length > 0 && wikiKeys.every((k) => expanded.has(k));
  const toggleAll = () => setExpanded(allOpen ? new Set() : new Set(wikiKeys));

  // Graph scope = the selected page's wiki (fallback: first wiki). Node ids are
  // page rels relative to that wiki, so they map straight to openPage.
  const graphWiki = sel?.rel.split('/')[0] || wikis[0]?.name;
  const openByRel = (rel) => {
    const w = wikis.find((x) => x.name === graphWiki);
    const want = rel.replace(/\.md$/i, '').toLowerCase();
    const page = w?.pages.find((p) => {
      const r = p.rel.replace(/\.md$/i, '').toLowerCase();
      return r === want || r.split('/').pop() === want.split('/').pop();
    });
    // 'main' graph hides the viewer, so drop back to it; 'dock' stays open.
    if (page) { if (graphView === 'main') setGraphView(null); openPage(w, page); }
  };
  const selectedRel = sel && sel.rel.split('/')[0] === graphWiki ? sel.rel.split('/').slice(1).join('/') : null;

  return (
    <Box sx={{ height: '100%', display: 'flex', minHeight: 0 }}>
      {/* left: search + wiki tree (collapsible) */}
      <Rail storageKey="sing-wiki-w" defaultWidth={380} collapsedTitle="Show wiki pages">
        {({ collapse }) => (
          <>
            <Box sx={{ p: 1.5, pb: 0.5 }}>
              <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                <RailSearch placeholder="Search wiki…" value={q} onChange={setQ} />
                <RailGroupToggle allOpen={allOpen} onToggle={toggleAll} disabled={!!results} />
                <Tooltip title="Select wiki folder" placement="bottom" disableInteractive>
                  <IconButton size="small" onClick={() => setPicking(true)}><FolderOpenIcon /></IconButton>
                </Tooltip>
                <Tooltip title={graphWiki ? `Graph of ${graphWiki}` : 'Link graph'} placement="bottom" disableInteractive>
                  <span><IconButton size="small" color={graphView ? 'primary' : 'default'} disabled={!graphWiki}
                    onClick={() => setGraphView((v) => (v ? null : 'dock'))}><HubIcon /></IconButton></span>
                </Tooltip>
                <IconButton size="small" onClick={collapse}><ChevronLeftIcon /></IconButton>
              </Stack>
              <Typography variant="code" sx={{ color: 'text.secondary', fontSize: 11, mt: 1, ml: 2, display: 'block' }} noWrap>{tildify(root)}</Typography>
              <Typography variant="code" sx={{ color: 'text.secondary', fontSize: 11, ml: 2, display: 'block' }}>
                {results ? `${results.length}${capped ? '+ (capped)' : ''} matches` : `${viewWikis.length} wiki${viewWikis.length === 1 ? '' : 's'} · ${pageCount}${capped ? '+' : ''} page${pageCount === 1 ? '' : 's'}`}
              </Typography>
              {!results && allCats.length > 0 && (
                <Autocomplete multiple size="small" options={allCats} value={cats} onChange={(_, v) => setCats(v)}
                  disableCloseOnSelect ChipProps={{ size: 'small' }} sx={{ mt: 1, ml: 2, mr: 1 }}
                  renderInput={(params) => <TextField {...params} variant="standard" placeholder={cats.length ? '' : 'Filter categories…'} />} />
              )}
            </Box>
            <List dense sx={{ flex: 1, minHeight: 0, overflow: 'auto', px: 0.5, pt: 0 }}>
              {results ? (
                results.map((it, i) => (
                  <ListItemButton key={`${it.path}:${it.line ?? i}`} selected={sel?.path === it.path} onClick={() => open(it)}
                    sx={{ borderRadius: (t) => `${t.zapac.radius.sm}px`, display: 'block', mb: 0.25 }}>
                    <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                      <StatusPill status="review">{it.rel.split('/')[0]}</StatusPill>
                      <Typography variant="code" sx={{ fontSize: 11, position: 'relative', top: 3 }} noWrap>{it.rel.split('/').slice(1).join('/')}{it.line ? `:${it.line}` : ''}</Typography>
                    </Stack>
                    {it.text && <Typography sx={{ fontSize: 12, color: 'text.secondary', mt: 0.5 }} noWrap>{it.text}</Typography>}
                  </ListItemButton>
                ))
              ) : (
                viewWikis.map((w) => {
                  const open2 = expanded.has(w.name);
                  return (
                    <Box key={w.path}>
                      <ListItemButton onClick={() => toggleWiki(w.name)}
                        sx={{ borderRadius: (t) => `${t.zapac.radius.sm}px`, mb: 0.25 }}>
                        <ListItemIcon sx={{ minWidth: 28 }}>{open2 ? <ExpandMoreIcon fontSize="small" /> : <ChevronRightIcon fontSize="small" />}</ListItemIcon>
                        <ListItemIcon sx={{ minWidth: 24 }}>{open2 ? <FolderOpenIcon fontSize="small" /> : <FolderIcon fontSize="small" />}</ListItemIcon>
                        <ListItemText primary={w.name} slotProps={{ primary: { variant: 'subtitle2', noWrap: true } }} />
                        <Typography variant="code" sx={{ color: 'text.secondary', fontSize: 11 }}>{w.pages.length}</Typography>
                      </ListItemButton>
                      <Collapse in={open2} timeout="auto" unmountOnExit>
                        <List dense disablePadding>
                          {w.pages.map((p) => {
                            const f = folder(p.rel);
                            return (
                              <ListItemButton key={p.path} selected={sel?.path === p.path} onClick={() => openPage(w, p)}
                                sx={{ pl: 5, borderRadius: (t) => `${t.zapac.radius.sm}px`, display: 'block', mb: 0.25 }}>
                                <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                                  {f && <StatusPill status="review">{f}</StatusPill>}
                                  <Typography variant="code" sx={{ fontSize: 11 }} noWrap>{p.rel.split('/').pop()}</Typography>
                                </Stack>
                              </ListItemButton>
                            );
                          })}
                          {w.pages.length === 0 && <Typography sx={{ pl: 5, py: 1, color: 'text.secondary', fontSize: 12 }}>(no pages)</Typography>}
                        </List>
                      </Collapse>
                    </Box>
                  );
                })
              )}
              {!results && viewWikis.length === 0 && <Typography sx={{ p: 2, color: 'text.secondary', fontSize: 13 }}>{err ? `${err}.` : (cats.length ? 'No pages in selected categories.' : 'No wikis.')}</Typography>}
              {results && results.length === 0 && <Typography sx={{ p: 2, color: 'text.secondary', fontSize: 13 }}>No matches.</Typography>}
            </List>
            {graphView === 'dock' && graphWiki && (
              <Stack sx={(t) => ({ flex: 1, minHeight: 0, borderTop: `1px solid ${t.vars.palette.glass.stroke}`, p: 1 })} spacing={0.5}>
                <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
                  <Typography variant="code" sx={{ flex: 1, minWidth: 0, color: 'text.secondary', fontSize: 11 }} noWrap>{graphWiki} · link graph</Typography>
                  <Tooltip title="Expand to main pane" placement="bottom" disableInteractive>
                    <IconButton size="small" onClick={() => setGraphView('main')}><OpenInFullIcon sx={{ fontSize: 15 }} /></IconButton>
                  </Tooltip>
                  <Tooltip title="Close graph" placement="bottom" disableInteractive>
                    <IconButton size="small" onClick={() => setGraphView(null)}><CloseIcon sx={{ fontSize: 16 }} /></IconButton>
                  </Tooltip>
                </Stack>
                <WikiGraph root={root} wiki={graphWiki} selected={selectedRel} onOpenPage={openByRel} />
              </Stack>
            )}
          </>
        )}
      </Rail>

      {/* right: read-only viewer (or link graph) */}
      <Stack sx={{ flex: 1, minWidth: 0, minHeight: 0, p: 1.5 }} spacing={1}>
        {graphView === 'main' && graphWiki ? (
          <>
            <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
              <Typography variant="code" sx={{ flex: 1, minWidth: 0, color: 'text.secondary', fontSize: 11 }} noWrap>{graphWiki} · link graph</Typography>
              <Tooltip title="Dock to sidebar" placement="bottom" disableInteractive>
                <IconButton size="small" onClick={() => setGraphView('dock')}><HorizontalSplitIcon sx={{ fontSize: 16 }} /></IconButton>
              </Tooltip>
              <Tooltip title="Close graph" placement="bottom" disableInteractive>
                <IconButton size="small" onClick={() => setGraphView(null)}><CloseIcon sx={{ fontSize: 16 }} /></IconButton>
              </Tooltip>
            </Stack>
            <WikiGraph root={root} wiki={graphWiki} selected={selectedRel} onOpenPage={openByRel} />
          </>
        ) : (
          <DetailPane
            empty={!sel && <EmptyState icon={<MenuBookIcon />} title={wikiUnavailable ? 'Wiki not configured' : 'Select a page'} description={wikiUnavailable ? wikiHint : 'Browse on the left to view here.'} />}
            loading={loadingFile}
            error={err}
          >
            <Typography variant="code" sx={{ color: 'text.secondary', fontSize: 11 }}>{sel?.rel}</Typography>
            <Box sx={(t) => ({
              flex: 1, minHeight: 0, overflow: 'auto',
              border: `1px solid ${t.vars.palette.glass.stroke}`, borderRadius: `${t.zapac.radius.sm}px`,
              p: 3, pb: 4,
            })}>
              {(() => {
                const { meta, body } = parseFrontmatter(content);
                const tags = Array.isArray(meta.tags) ? meta.tags : (meta.tags ? [meta.tags] : []);
                return (
                  <>
                    {meta.title && <Typography variant="h1" sx={{ fontSize: 26, fontWeight: 800, mt: 0, mb: 1.5, letterSpacing: '-0.01em' }}>{meta.title}</Typography>}
                    {(meta.type || meta.status || tags.length > 0) && (
                      <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', gap: 1, mb: 2.5, alignItems: 'center' }}>
                        {meta.type && <StatusPill status="active">{meta.type}</StatusPill>}
                        {meta.status && <StatusPill status={meta.status === 'active' ? 'done' : 'review'}>{meta.status}</StatusPill>}
                        {tags.map((t2) => <StatusPill key={t2} status="review">{t2}</StatusPill>)}
                      </Stack>
                    )}
                    <MarkdownBody onWikiLink={jumpTo}>{body}</MarkdownBody>
                  </>
                );
              })()}
            </Box>
          </DetailPane>
        )}
      </Stack>

      {picking && <DirPicker start={untildify(root)} onPick={pickRoot} onClose={() => setPicking(false)} />}
    </Box>
  );
}