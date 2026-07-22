import { getTokens } from '@/theme/contract.js';
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
import { StatusPill, EmptyState } from '@zapac/mui-theme';
import DetailPane from '@/components/DetailPane.jsx';
import DirPicker from '@/components/DirPicker.jsx';
import MarkdownBody from '@/components/MarkdownBody.jsx';
import { tildify, untildify } from '@/lib/paths.js';
import Rail from '@/components/panelkit/Rail.jsx';
import RailSearch from '@/components/panelkit/RailSearch.jsx';
import RailGroupToggle from '@/components/panelkit/RailGroupToggle.jsx';
import { useRootList } from '@/components/panelkit/useRootList.js';

// Skills viewer: tree of roots → scopes → skills (left), rendered SKILL.md
// (right). Read-only — no write. Each root's layout (grouped vs flat) is
// auto-detected server-side; the server derives paths from (root, scope, skill).
export default function SkillsPanel() {
  const { roots, shownRoots, remember, forget, loaded } = useRootList('/skills');
  const [picking, setPicking] = useState(false);
  const [dataByRoot, setDataByRoot] = useState({}); // root -> { flat, scopes, error }
  const [q, setQ] = useState('');
  const [expandedRoots, setExpandedRoots] = useState(() => new Set());
  const [expandedScopes, setExpandedScopes] = useState(() => new Set()); // keys: `${root}::${scope}`
  const [sel, setSel] = useState(null); // { root, scope, skill, flat }
  const [skill, setSkill] = useState(null); // { name, description, triggers, body }
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);

  // Fetch each root's skills independently — one root's slow/failed fetch
  // doesn't block the others.
  useEffect(() => {
    if (!loaded) return;
    let cancelled = false;
    roots.forEach((r) => {
      fetch(`/skills?root=${encodeURIComponent(untildify(r))}`).then((res) => res.json()).then((d) => {
        if (cancelled) return;
        setDataByRoot((prev) => ({ ...prev, [r]: { flat: !!d.flat, scopes: d.scopes || [], error: d.error || null } }));
      }).catch(() => { if (!cancelled) setDataByRoot((prev) => ({ ...prev, [r]: { flat: false, scopes: [], error: 'failed to load skills' } })); });
    });
    return () => { cancelled = true; };
  }, [roots, loaded]);

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

  // Expand/collapse-all over both levels (roots + scopes). Search auto-expands
  // matches, so the toggle is disabled while a query is active.
  const rootKeys = view.map((r) => r.root);
  const scopeKeys = view.flatMap((r) => r.scopes.map((sc) => `${r.root}::${sc.name}`));
  const allOpen = rootKeys.length > 0
    && rootKeys.every((k) => expandedRoots.has(k))
    && scopeKeys.every((k) => expandedScopes.has(k));
  const toggleAll = () => {
    if (allOpen) { setExpandedRoots(new Set()); setExpandedScopes(new Set()); }
    else { setExpandedRoots(new Set(rootKeys)); setExpandedScopes(new Set(scopeKeys)); }
  };

  return (
    <Box sx={{ height: '100%', display: 'flex', minHeight: 0 }}>
      {/* left: root → scope → skill tree (collapsible) */}
      <Rail storageKey="sing-skills-w" defaultWidth={300} collapsedTitle="Show skill paths">
        {({ collapse }) => (
          <>
        <Box sx={{ p: 1.5, pb: 0.5 }}>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
            <RailSearch placeholder="Search skills…" value={q} onChange={setQ} />
            <RailGroupToggle allOpen={allOpen} onToggle={toggleAll} disabled={!!query} />
            <Tooltip title="Select skills folder" placement="bottom" disableInteractive>
              <IconButton size="small" onClick={() => setPicking(true)}><FolderOpenIcon /></IconButton>
            </Tooltip>
            <IconButton size="small" onClick={collapse}><ChevronLeftIcon /></IconButton>
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
                  sx={{ borderRadius: (t) => `${getTokens(t).radius.sm}px`, mb: 0.25, '&:hover .del': { opacity: 1 } }}>
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
                            sx={{ pl: 3, borderRadius: (t) => `${getTokens(t).radius.sm}px`, mb: 0.25 }}>
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
                                    sx={{ pl: 7, borderRadius: (t) => `${getTokens(t).radius.sm}px`, mb: 0.25 }}
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
      </Rail>

      {/* right: rendered SKILL.md */}
      <Stack sx={{ flex: 1, minWidth: 0, minHeight: 0, p: 1.5 }} spacing={1}>
        <DetailPane
          empty={!sel && <EmptyState icon={<SchoolIcon />} title="Select a skill" description="Browse on the left to view here." />}
          loading={loading}
          error={err}
        >
          <Typography variant="code" sx={{ color: 'text.secondary', fontSize: 11 }}>{tildify(sel?.root)} / {sel?.flat ? '(flat)' : sel?.scope} / {sel?.skill}</Typography>
          <Box sx={(t) => ({
            flex: 1, minHeight: 0, overflow: 'auto',
            border: `1px solid ${getTokens(t).glass.stroke}`, borderRadius: `${getTokens(t).radius.sm}px`,
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
        </DetailPane>
      </Stack>

      {picking && <DirPicker start={untildify(roots[roots.length - 1] || '~')} onPick={pickRoot} onClose={() => setPicking(false)} />}
    </Box>
  );
}
