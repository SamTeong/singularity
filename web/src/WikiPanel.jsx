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
import Collapse from '@mui/material/Collapse';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import FolderIcon from '@mui/icons-material/Folder';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import Link from '@mui/material/Link';
import { StatusPill, SearchInput } from '@zapac/mui-theme';
import DirPicker from './DirPicker.jsx';

// Wiki root persists across sessions in localStorage (default ~/wiki).
const DEFAULT_ROOT = '~/wiki';
const loadRoot = () => localStorage.getItem('sing-wiki-root') || DEFAULT_ROOT;
const folder = (rel) => { const i = rel.lastIndexOf('/'); return i < 0 ? '' : rel.slice(0, i); };

// Split a leading YAML frontmatter block (---\n...\n---) from the body. Each
// `key: value` line is parsed; `value` may be `[a, b, c]`. Returns {meta, body}.
const parseFrontmatter = (src) => {
  const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { meta: {}, body: src };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if (v.startsWith('[') && v.endsWith(']')) v = v.slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean);
    if (k) meta[k] = v;
  }
  return { meta, body: src.slice(m[0].length) };
};

export default function WikiPanel() {
  const [root, setRoot] = useState(loadRoot);
  const [picking, setPicking] = useState(false);
  const [q, setQ] = useState('');
  const [results, setResults] = useState(null); // search hits
  const [wikis, setWikis] = useState([]); // [{name, path, pages:[{path,rel}]}]
  const [capped, setCapped] = useState(false);
  const [err, setErr] = useState(null);
  const [expanded, setExpanded] = useState(() => new Set()); // wiki names
  const [sel, setSel] = useState(null); // {path, rel}
  const [collapsed, setCollapsed] = useState(false);
  const [content, setContent] = useState('');
  const [loadingFile, setLoadingFile] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setSel(null); setContent(''); setErr(null);
    fetch(`/wiki/files?root=${encodeURIComponent(root)}`).then((r) => r.json()).then((d) => {
      if (cancelled) return;
      if (d.error) { setWikis([]); setCapped(false); setErr(d.error); return; }
      setWikis(d.wikis || []); setCapped(!!d.capped); setErr(null);
    }).catch(() => { if (!cancelled) { setWikis([]); setCapped(false); setErr('failed to load wikis'); } });
    return () => { cancelled = true; };
  }, [root]);

  const search = useCallback(() => {
    if (!q.trim()) { setResults(null); return; }
    fetch(`/wiki/search?q=${encodeURIComponent(q.trim())}&root=${encodeURIComponent(root)}`).then((r) => r.json()).then((d) => {
      setResults(d.results || []); setCapped(!!d.capped);
    });
  }, [q, root]);

  // Debounced search-as-you-type (search() clears results when q is empty).
  useEffect(() => { const id = setTimeout(search, 250); return () => clearTimeout(id); }, [q, search]);

  const open = (item) => {
    if (item.path === sel?.path) return;
    setSel(item); setErr(null); setLoadingFile(true);
    fetch(`/wiki/file?path=${encodeURIComponent(item.path)}&root=${encodeURIComponent(root)}`).then((r) => r.json()).then((d) => {
      setContent(d.ok ? d.content : '');
      if (!d.ok) setErr(d.error);
    }).catch(() => { setContent(''); setErr('failed to load page'); }).finally(() => setLoadingFile(false));
  };

  // Selecting a page expands its wiki so the selection is visible in the tree.
  const openPage = (wiki, page) => {
    setExpanded((s) => (s.has(wiki.name) ? s : new Set([...s, wiki.name])));
    open({ path: page.path, rel: `${wiki.name}/${page.rel}` });
  };
  const toggleWiki = (name) => setExpanded((s) => {
    const n = new Set(s);
    if (n.has(name)) n.delete(name); else n.add(name);
    return n;
  });

  const pickRoot = (p) => { localStorage.setItem('sing-wiki-root', p); setRoot(p); setPicking(false); };
  const pageCount = wikis.reduce((n, w) => n + w.pages.length, 0);

  return (
    <Box sx={{ height: '100%', display: 'flex', minHeight: 0 }}>
      {/* left: search + wiki tree (collapsible) */}
      <Stack sx={(t) => ({ width: collapsed ? 40 : 340, flexShrink: 0, borderRight: `1px solid ${t.vars.palette.glass.stroke}`, minHeight: 0, transition: 'width .2s ease' })}>
        {collapsed ? (
          <IconButton size="small" onClick={() => setCollapsed(false)} sx={{ m: 0.5 }}><ChevronRightIcon /></IconButton>
        ) : (
          <>
            <Box sx={{ p: 1.5, pb: 0.5 }}>
              <Stack direction="row" spacing={1} alignItems="center">
                <Box sx={{ flex: 1, minWidth: 0 }}><SearchInput placeholder="Search wiki…" value={q} onChange={setQ} shortcut="" /></Box>
                <Tooltip title="Pick wiki folder" placement="bottom" disableInteractive>
                  <IconButton size="small" onClick={() => setPicking(true)}><FolderOpenIcon /></IconButton>
                </Tooltip>
                <IconButton size="small" onClick={() => setCollapsed(true)}><ChevronLeftIcon /></IconButton>
              </Stack>
              <Typography variant="code" sx={{ color: 'text.secondary', fontSize: 11, mt: 1, ml: 2, display: 'block' }} noWrap>{root}</Typography>
              <Typography variant="code" sx={{ color: 'text.secondary', fontSize: 11, ml: 2, display: 'block' }}>
                {results ? `${results.length}${capped ? '+ (capped)' : ''} matches` : `${wikis.length} wikis · ${pageCount}${capped ? '+' : ''} pages`}
              </Typography>
            </Box>
            <List dense sx={{ flex: 1, overflow: 'auto', px: 0.5, pt: 0 }}>
              {results ? (
                results.map((it, i) => (
                  <ListItemButton key={`${it.path}:${it.line ?? i}`} selected={sel?.path === it.path} onClick={() => open(it)}
                    sx={{ borderRadius: (t) => `${t.zapac.radius.sm}px`, display: 'block', mb: 0.25 }}>
                    <Stack direction="row" spacing={1} alignItems="center">
                      <StatusPill status="review">{it.rel.split('/')[0]}</StatusPill>
                      <Typography variant="code" sx={{ fontSize: 11, position: 'relative', top: 3 }} noWrap>{it.rel.split('/').slice(1).join('/')}{it.line ? `:${it.line}` : ''}</Typography>
                    </Stack>
                    {it.text && <Typography sx={{ fontSize: 12, color: 'text.secondary', mt: 0.5 }} noWrap>{it.text}</Typography>}
                  </ListItemButton>
                ))
              ) : (
                wikis.map((w) => {
                  const open2 = expanded.has(w.name);
                  return (
                    <Box key={w.path}>
                      <ListItemButton onClick={() => toggleWiki(w.name)}
                        sx={{ borderRadius: (t) => `${t.zapac.radius.sm}px`, mb: 0.25 }}>
                        <ListItemIcon sx={{ minWidth: 28 }}>{open2 ? <ExpandMoreIcon fontSize="small" /> : <ChevronRightIcon fontSize="small" />}</ListItemIcon>
                        <ListItemIcon sx={{ minWidth: 24 }}>{open2 ? <FolderOpenIcon fontSize="small" /> : <FolderIcon fontSize="small" />}</ListItemIcon>
                        <ListItemText primary={w.name} primaryTypographyProps={{ variant: 'subtitle2', noWrap: true }} />
                        <Typography variant="code" sx={{ color: 'text.secondary', fontSize: 11 }}>{w.pages.length}</Typography>
                      </ListItemButton>
                      <Collapse in={open2} timeout="auto" unmountOnExit>
                        <List dense disablePadding>
                          {w.pages.map((p) => {
                            const f = folder(p.rel);
                            return (
                              <ListItemButton key={p.path} selected={sel?.path === p.path} onClick={() => openPage(w, p)}
                                sx={{ pl: 5, borderRadius: (t) => `${t.zapac.radius.sm}px`, display: 'block', mb: 0.25 }}>
                                <Stack direction="row" spacing={1} alignItems="center">
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
              {!results && wikis.length === 0 && <Typography sx={{ p: 2, color: 'text.secondary', fontSize: 13 }}>{err ? `${err}.` : 'No wikis.'}</Typography>}
              {results && results.length === 0 && <Typography sx={{ p: 2, color: 'text.secondary', fontSize: 13 }}>No matches.</Typography>}
            </List>
          </>
        )}
      </Stack>

      {/* right: read-only viewer */}
      <Stack sx={{ flex: 1, minWidth: 0, minHeight: 0, p: 1.5 }} spacing={1}>
        {!sel ? (
          <Box sx={{ flex: 1, display: 'grid', placeItems: 'center' }}>
            <Typography color="text.secondary">Select a page to view.</Typography>
          </Box>
        ) : loadingFile ? (
          <Box sx={{ flex: 1, display: 'grid', placeItems: 'center' }}>
            <Typography color="text.secondary">Loading…</Typography>
          </Box>
        ) : err ? (
          <Box sx={{ flex: 1, display: 'grid', placeItems: 'center' }}>
            <Typography color="text.secondary">{err}</Typography>
          </Box>
        ) : (
          <>
            <Typography variant="code" sx={{ color: 'text.secondary', fontSize: 11 }}>{sel.rel}</Typography>
            <Box sx={(t) => ({
              flex: 1, minHeight: 0, overflow: 'auto',
              border: `1px solid ${t.vars.palette.glass.stroke}`, borderRadius: `${t.zapac.radius.sm}px`,
              p: 3, pb: 4,
              '& :is(h1,h2,h3,h4,h5,h6)': { fontWeight: 700, mt: 2.5, mb: 1, lineHeight: 1.25, '&:first-of-type': { mt: 0 } },
              '& h1': { fontSize: 24 }, '& h2': { fontSize: 20 }, '& h3': { fontSize: 17 }, '& h4,& h5,& h6': { fontSize: 15 },
              '& p': { my: 1.25, lineHeight: 1.7, fontSize: 14 },
              '& ul,& ol': { pl: 3, my: 1.25, lineHeight: 1.7, fontSize: 14, '& li': { my: 0.4, '&::marker': { color: t.vars.palette.text.secondary } } },
              '& :is(ul,ol) :is(ul,ol)': { my: 0.4 },
              '& blockquote': { ml: 0, pl: 2, my: 1.5, borderLeft: `3px solid ${t.vars.palette.glass.stroke}`, color: 'text.secondary' },
              '& a': { color: 'primary.main' },
              '& :is(code,pre)': { fontFamily: 'var(--mui-font-CodeFont, monospace)', fontSize: 13 },
              '& :not(pre) > code': { px: 0.5, py: 0.15, borderRadius: '4px', bgcolor: 'action.hover', fontSize: '0.9em' },
              '& pre': { p: 1.5, my: 1.5, overflow: 'auto', borderRadius: `${t.zapac.radius.sm}px`, bgcolor: 'action.hover', border: `1px solid ${t.vars.palette.glass.stroke}` },
              '& hr': { border: 'none', borderTop: `1px solid ${t.vars.palette.glass.stroke}`, my: 2.5 },
              '& table': { borderCollapse: 'collapse', my: 1.5, width: '100%', fontSize: 13 },
              '& th,& td': { border: `1px solid ${t.vars.palette.glass.stroke}`, px: 1, py: 0.75, textAlign: 'left' },
              '& th': { bgcolor: 'action.hover', fontWeight: 700 },
              '& img': { maxWidth: '100%' },
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
                    <ReactMarkdown remarkPlugins={[remarkGfm]}
                      components={{ a: (p) => <Link {...p} target="_blank" rel="noopener noreferrer" /> }}>
                      {body}
                    </ReactMarkdown>
                  </>
                );
              })()}
            </Box>
          </>
        )}
      </Stack>

      {picking && <DirPicker start={root} onPick={pickRoot} onClose={() => setPicking(false)} />}
    </Box>
  );
}