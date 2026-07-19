import React, { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import ClearIcon from '@mui/icons-material/Clear';
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
import SchoolIcon from '@mui/icons-material/School';
import { StatusPill, SearchInput, EmptyState } from '@zapac/mui-theme';
import DirPicker from './DirPicker.jsx';
import MarkdownBody from './MarkdownBody.jsx';
import { tildify, untildify } from './paths.js';
import { useResizable, ResizeHandle } from './useResizable.jsx';

// Skills viewer: tree of roots → scopes → skills (left), rendered SKILL.md
// (right). Read-only — no write. Each root's layout (grouped vs flat) is
// auto-detected server-side; the server derives paths from (root, scope, skill).
export default function SkillsPanel() {
  const [roots, setRoots] = useState([]);
  const [rootsLoaded, setRootsLoaded] = useState(false);
  const [picking, setPicking] = useState(false);
  const [dataByRoot, setDataByRoot] = useState({}); // root -> { flat, scopes, error }
  const [q, setQ] = useState('');
  const [expandedRoots, setExpandedRoots] = useState(() => new Set());
  const [expandedScopes, setExpandedScopes] = useState(() => new Set()); // keys: `${root}::${scope}`
  const [collapsed, setCollapsed] = useState(false);
  const [sel, setSel] = useState(null); // { root, scope, skill, flat }
  const [skill, setSkill] = useState(null); // { name, description, triggers, body }
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  const railW = useResizable('sing-skills-w', 300);

  // Load the FS-persisted root list once on mount (skills load via the [roots] effect).
  useEffect(() => {
    fetch('/skills/roots').then((r) => r.json()).then((d) => { if (d.roots?.length) setRoots(d.roots); }).catch(() => {}).finally(() => setRootsLoaded(true));
  }, []);

  // Merge paths into the list (MRU-first, deduped, capped) and persist to FS.
  const remember = (paths) => setRoots((prev) => {
    const next = [...new Set([...paths, ...prev])].slice(0, 50);
    fetch('/skills/roots', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roots: next }),
    }).catch(() => {});
    return next;
  });

  // Drop a path from the list and persist to FS. Match on the same normalized
  // key shownRoots dedups by, so collapsed variants (~ vs expanded home) all go.
  const normKey = (p) => tildify(p).replace(/\\/g, '/').toLowerCase();
  const forget = (p) => setRoots((prev) => {
    const k = normKey(p);
    const next = prev.filter((x) => normKey(x) !== k);
    fetch('/skills/roots', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roots: next }),
    }).catch(() => {});
    return next;
  });

  // Fetch each root's skills independently — one root's slow/failed fetch
  // doesn't block the others.
  useEffect(() => {
    if (!rootsLoaded) return;
    let cancelled = false;
    roots.forEach((r) => {
      fetch(`/skills?root=${encodeURIComponent(untildify(r))}`).then((res) => res.json()).then((d) => {
        if (cancelled) return;
        setDataByRoot((prev) => ({ ...prev, [r]: { flat: !!d.flat, scopes: d.scopes || [], error: d.error || null } }));
      }).catch(() => { if (!cancelled) setDataByRoot((prev) => ({ ...prev, [r]: { flat: false, scopes: [], error: 'failed to load skills' } })); });
    });
    return () => { cancelled = true; };
  }, [roots, rootsLoaded]);

  const pickRoot = (p) => { remember([untildify(p)]); setPicking(false); };

  const toggleRoot = (r) => setExpandedRoots((s) => {
    const n = new Set(s);
    if (n.has(r)) n.delete(r); else n.add(r);
    return n;
  });
  const toggleScope = (key) => setExpandedScopes((s) => {
    const n = new Set(s);
    if (n.has(key)) n.delete(key); else n.add(key);
    return n;
  });

  const open = (rootPath, scopeName, skillName, flatVal) => {
    if (sel?.root === rootPath && sel?.scope === scopeName && sel?.skill === skillName) return;
    setSel({ root: rootPath, scope: scopeName, skill: skillName, flat: flatVal }); setErr(null); setLoading(true); setSkill(null);
    fetch(`/skill?root=${encodeURIComponent(untildify(rootPath))}&scope=${encodeURIComponent(scopeName)}&skill=${encodeURIComponent(skillName)}&flat=${flatVal ? '1' : '0'}`).then((r) => r.json()).then((d) => {
      if (!d.ok) { setErr(d.error || 'failed to load skill'); setSkill(null); }
      else setSkill({ name: d.name, description: d.description, triggers: d.triggers || [], body: d.body });
    }).catch(() => setErr('failed to load skill')).finally(() => setLoading(false));
  };

  // Dedup on a normalized key (tildified, forward slashes, lowercased) so `~`
  // and its expanded home path, or `/` vs `\`, don't show as separate entries.
  const shownRoots = [...new Map(
    roots.map((p) => [normKey(p), p]),
  ).values()].sort((a, b) => normKey(a).localeCompare(normKey(b))); // sort by displayed (tildified) form

  // Client-side filter — a root whose own path matches keeps all its scopes;
  // otherwise only scopes/skills (name + description) that match.
  const query = q.trim().toLowerCase();
  const view = shownRoots.map((r) => {
    const d = dataByRoot[r] || { flat: false, scopes: [], error: null };
    if (!query || r.toLowerCase().includes(query)) return { root: r, ...d };
    const scopes = d.scopes
      .map((sc) => {
        if (sc.name.toLowerCase().includes(query)) return sc;
        const skills = sc.skills.filter((sk) =>
          sk.name.toLowerCase().includes(query) || (sk.description || '').toLowerCase().includes(query));
        return skills.length ? { ...sc, skills } : null;
      })
      .filter(Boolean);
    return scopes.length ? { root: r, flat: d.flat, scopes, error: d.error } : null;
  }).filter(Boolean);

  // While searching, auto-expand matching roots/scopes so hits are visible.
  const isExpandedRoot = (r) => (query ? true : expandedRoots.has(r));
  const isExpandedScope = (r, name) => (query ? true : expandedScopes.has(`${r}::${name}`));

  const totalScopes = view.reduce((n, r) => n + r.scopes.length, 0);
  const totalSkills = view.reduce((n, r) => n + new Set(r.scopes.flatMap((sc) => sc.skills.map((sk) => sk.name))).size, 0);

  return (
    <Box sx={{ height: '100%', display: 'flex', minHeight: 0 }}>
      {/* left: root → scope → skill tree (collapsible) */}
      <Stack sx={(t) => ({ width: collapsed ? 40 : railW.width, flexShrink: 0, borderRight: `1px solid ${t.vars.palette.glass.stroke}`, minHeight: 0, transition: 'width .2s ease' })}>
        {collapsed ? (
          <IconButton size="small" onClick={() => setCollapsed(false)} sx={{ m: 0.5 }}><ChevronRightIcon /></IconButton>
        ) : (
          <>
        <Box sx={{ p: 1.5, pb: 0.5 }}>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
            <Box sx={{ flex: 1, minWidth: 0, position: 'relative' }}>
              <SearchInput placeholder="Search skills…" value={q} onChange={setQ} shortcut="" sx={{ minWidth: 0 }} />
              {q && (
                <IconButton size="small" onClick={() => setQ('')} aria-label="Clear search"
                  sx={{ position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)', '&:hover': { transform: 'translateY(-50%)' } }}>
                  <ClearIcon fontSize="small" />
                </IconButton>
              )}
            </Box>
            <Tooltip title="Select skills folder" placement="bottom" disableInteractive>
              <IconButton size="small" onClick={() => setPicking(true)}><FolderOpenIcon /></IconButton>
            </Tooltip>
            <IconButton size="small" onClick={() => setCollapsed(true)}><ChevronLeftIcon /></IconButton>
          </Stack>
          <Typography variant="code" sx={{ color: 'text.secondary', fontSize: 11, ml: 2, display: 'block' }}>
            {totalScopes} scope{totalScopes === 1 ? '' : 's'} · {totalSkills} skill{totalSkills === 1 ? '' : 's'}
          </Typography>
        </Box>
        <List dense sx={{ flex: 1, overflow: 'auto', px: 0.5, pt: 0 }}>
          {view.map((r) => {
            const rOpen = isExpandedRoot(r.root);
            return (
              <Box key={r.root}>
                <ListItemButton onClick={() => toggleRoot(r.root)}
                  sx={{ borderRadius: (t) => `${t.zapac.radius.sm}px`, mb: 0.25, '&:hover .del': { opacity: 1 } }}>
                  <ListItemIcon sx={{ minWidth: 28 }}>{rOpen ? <ExpandMoreIcon fontSize="small" /> : <ChevronRightIcon fontSize="small" />}</ListItemIcon>
                  <ListItemIcon sx={{ minWidth: 24 }}>{rOpen ? <FolderOpenIcon fontSize="small" /> : <FolderIcon fontSize="small" />}</ListItemIcon>
                  <ListItemText primary={tildify(r.root)} primaryTypographyProps={{ variant: 'subtitle2', noWrap: true, title: r.root }} />
                  <Typography variant="code" sx={{ color: 'text.secondary', fontSize: 11, mr: 0.5 }}>{r.error || r.scopes.length}</Typography>
                  <IconButton className="del" size="small" aria-label="Remove from list" title="Remove from list"
                    onClick={(e) => { e.stopPropagation(); forget(r.root); }}
                    sx={{ opacity: 0, ml: 0.5, p: 0.25 }}>
                    <ClearIcon fontSize="small" />
                  </IconButton>
                </ListItemButton>
                <Collapse in={rOpen} timeout="auto" unmountOnExit>
                  <List dense disablePadding>
                    {r.scopes.map((sc) => {
                      const scopeKey = `${r.root}::${sc.name}`;
                      const scOpen = isExpandedScope(r.root, sc.name);
                      const label = r.flat ? '(flat)' : sc.name;
                      return (
                        <Box key={scopeKey}>
                          <ListItemButton onClick={() => toggleScope(scopeKey)}
                            sx={{ pl: 3, borderRadius: (t) => `${t.zapac.radius.sm}px`, mb: 0.25 }}>
                            <ListItemIcon sx={{ minWidth: 28 }}>{scOpen ? <ExpandMoreIcon fontSize="small" /> : <ChevronRightIcon fontSize="small" />}</ListItemIcon>
                            <ListItemIcon sx={{ minWidth: 24 }}>{scOpen ? <FolderOpenIcon fontSize="small" /> : <FolderIcon fontSize="small" />}</ListItemIcon>
                            <ListItemText primary={label} slotProps={{ primary: { variant: 'subtitle2', noWrap: true } }} />
                            <Typography variant="code" sx={{ color: 'text.secondary', fontSize: 11 }}>{sc.skills.length}</Typography>
                          </ListItemButton>
                          <Collapse in={scOpen} timeout="auto" unmountOnExit>
                            <List dense disablePadding>
                              {sc.skills.map((sk) => {
                                const isSel = sel?.root === r.root && sel?.scope === sc.name && sel?.skill === sk.name;
                                return (
                                  <ListItemButton key={sk.name} selected={isSel} onClick={() => open(r.root, sc.name, sk.name, r.flat)}
                                    sx={{ pl: 7, borderRadius: (t) => `${t.zapac.radius.sm}px`, mb: 0.25 }}
                                    title={sk.description || sk.name}
                                  >
                                    <Typography variant="code" sx={{ fontSize: 12 }} noWrap>{sk.name}</Typography>
                                  </ListItemButton>
                                );
                              })}
                              {sc.capped && <Typography sx={{ pl: 7, py: 0.5, color: 'text.secondary', fontSize: 11 }}>(capped at 200)</Typography>}
                              {sc.skills.length === 0 && <Typography sx={{ pl: 7, py: 1, color: 'text.secondary', fontSize: 12 }}>(no skills)</Typography>}
                            </List>
                          </Collapse>
                        </Box>
                      );
                    })}
                    {r.error && <Typography sx={{ pl: 3, py: 1, color: 'text.secondary', fontSize: 12 }}>{r.error}</Typography>}
                    {!r.error && r.scopes.length === 0 && <Typography sx={{ pl: 3, py: 1, color: 'text.secondary', fontSize: 12 }}>No scopes.</Typography>}
                  </List>
                </Collapse>
              </Box>
            );
          })}
          {view.length === 0 && <Typography sx={{ p: 2, color: 'text.secondary', fontSize: 13 }}>{query ? 'No matches.' : 'No roots — pick a folder.'}</Typography>}
        </List>
          </>
        )}
      </Stack>
      {!collapsed && <ResizeHandle onMouseDown={railW.startDrag} />}

      {/* right: rendered SKILL.md */}
      <Stack sx={{ flex: 1, minWidth: 0, minHeight: 0, p: 1.5 }} spacing={1}>
        {!sel ? (
          <Box sx={{ flex: 1, display: 'grid', placeItems: 'center' }}>
            <EmptyState icon={<SchoolIcon />} title="Select a skill" description="Browse roots on the left to view a skill here." />
          </Box>
        ) : loading ? (
          <Box sx={{ flex: 1, display: 'grid', placeItems: 'center' }}>
            <Typography color="text.secondary">Loading…</Typography>
          </Box>
        ) : err ? (
          <Box sx={{ flex: 1, display: 'grid', placeItems: 'center' }}>
            <Typography color="text.secondary">{err}</Typography>
          </Box>
        ) : (
          <>
            <Typography variant="code" sx={{ color: 'text.secondary', fontSize: 11 }}>{tildify(sel.root)} / {sel.flat ? '(flat)' : sel.scope} / {sel.skill}</Typography>
            <Box sx={(t) => ({
              flex: 1, minHeight: 0, overflow: 'auto',
              border: `1px solid ${t.vars.palette.glass.stroke}`, borderRadius: `${t.zapac.radius.sm}px`,
              p: 3, pb: 4,
            })}>
              {skill?.name && <Typography variant="h1" sx={{ fontSize: 26, fontWeight: 800, mt: 0, mb: 1, letterSpacing: '-0.01em' }}>{skill.name}</Typography>}
              {skill?.description && <Typography sx={{ color: 'text.secondary', fontSize: 14, lineHeight: 1.6, mb: 2 }}>{skill.description}</Typography>}
              {skill?.triggers?.length > 0 && (
                <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', gap: 1, mb: 2.5, alignItems: 'center' }}>
                  {skill.triggers.map((t2) => <StatusPill key={t2} status="review">{t2}</StatusPill>)}
                </Stack>
              )}
              <MarkdownBody>{skill?.body || ''}</MarkdownBody>
            </Box>
          </>
        )}
      </Stack>

      {picking && <DirPicker start={untildify(roots[roots.length - 1] || '~')} onPick={pickRoot} onClose={() => setPicking(false)} />}
    </Box>
  );
}
