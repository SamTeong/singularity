import React, { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import ClearIcon from '@mui/icons-material/Clear';
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
import MarkdownBody from './MarkdownBody.jsx';
import { useResizable, ResizeHandle } from './useResizable.jsx';

// Skills viewer: tree of skill scopes → skills (left), rendered SKILL.md
// (right). Read-only — no write. Skills live under SING_SCOPE_ROOT; the server
// derives paths from (scope, skill).
export default function SkillsPanel() {
  const [scopes, setScopes] = useState([]);
  const [q, setQ] = useState('');
  const [loadErr, setLoadErr] = useState(null);
  const [expanded, setExpanded] = useState(() => new Set());
  const [collapsed, setCollapsed] = useState(false);
  const [sel, setSel] = useState(null); // { scope, skill }
  const [skill, setSkill] = useState(null); // { name, description, triggers, body }
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  const railW = useResizable('sing-skills-w', 300);

  useEffect(() => {
    let cancelled = false;
    fetch('/skills').then((r) => r.json()).then((d) => {
      if (cancelled) return;
      if (d.error) { setLoadErr(d.error); setScopes([]); return; }
      setScopes(d.scopes || []);
      setLoadErr(null);
    }).catch(() => { if (!cancelled) setLoadErr('failed to load skills'); });
    return () => { cancelled = true; };
  }, []);

  const toggleScope = (name) => setExpanded((s) => {
    const n = new Set(s);
    if (n.has(name)) n.delete(name); else n.add(name);
    return n;
  });

  const open = (scope, skillName) => {
    const key = { scope, skill: skillName };
    if (sel?.scope === scope && sel?.skill === skillName) return;
    setSel(key); setErr(null); setLoading(true); setSkill(null);
    fetch(`/skill?scope=${encodeURIComponent(scope)}&skill=${encodeURIComponent(skillName)}`).then((r) => r.json()).then((d) => {
      if (!d.ok) { setErr(d.error || 'failed to load skill'); setSkill(null); }
      else setSkill({ name: d.name, description: d.description, triggers: d.triggers || [], body: d.body });
    }).catch(() => setErr('failed to load skill')).finally(() => setLoading(false));
  };

  // Client-side filter — skills (name + description) and scope names. A scope
  // whose own name matches keeps all its skills; otherwise only matching skills.
  const query = q.trim().toLowerCase();
  const view = !query ? scopes : scopes
    .map((sc) => {
      if (sc.name.toLowerCase().includes(query)) return sc;
      const skills = sc.skills.filter((sk) =>
        sk.name.toLowerCase().includes(query) || (sk.description || '').toLowerCase().includes(query));
      return skills.length ? { ...sc, skills } : null;
    })
    .filter(Boolean);

  // While searching, auto-expand matching scopes so hits are visible.
  const isExpanded = (name) => (query ? true : expanded.has(name));
  const skillCount = new Set(view.flatMap((s) => s.skills.map((sk) => sk.name))).size;

  return (
    <Box sx={{ height: '100%', display: 'flex', minHeight: 0 }}>
      {/* left: scope → skill tree (collapsible) */}
      <Stack sx={(t) => ({ width: collapsed ? 40 : railW.width, flexShrink: 0, borderRight: `1px solid ${t.vars.palette.glass.stroke}`, minHeight: 0, transition: 'width .2s ease' })}>
        {collapsed ? (
          <IconButton size="small" onClick={() => setCollapsed(false)} sx={{ m: 0.5 }}><ChevronRightIcon /></IconButton>
        ) : (
          <>
        <Box sx={{ p: 1.5, pb: 0.5 }}>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
            <Box sx={{ flex: 1, minWidth: 0, position: 'relative' }}>
              <SearchInput placeholder="Search skills…" value={q} onChange={setQ} shortcut="" />
              {q && (
                <IconButton size="small" onClick={() => setQ('')} aria-label="Clear search"
                  sx={{ position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)', '&:hover': { transform: 'translateY(-50%)' } }}>
                  <ClearIcon fontSize="small" />
                </IconButton>
              )}
            </Box>
            <IconButton size="small" onClick={() => setCollapsed(true)}><ChevronLeftIcon /></IconButton>
          </Stack>
          <Typography variant="code" sx={{ color: 'text.secondary', fontSize: 11, mt: 1, ml: 2, display: 'block' }}>
            {loadErr ? `${loadErr}` : `${view.length} scope${view.length === 1 ? '' : 's'} · ${skillCount} skill${skillCount === 1 ? '' : 's'}`}
          </Typography>
        </Box>
        <List dense sx={{ flex: 1, overflow: 'auto', px: 0.5, pt: 0 }}>
          {view.map((sc) => {
            const open2 = isExpanded(sc.name);
            return (
              <Box key={sc.name}>
                <ListItemButton onClick={() => toggleScope(sc.name)}
                  sx={{ borderRadius: (t) => `${t.zapac.radius.sm}px`, mb: 0.25 }}>
                  <ListItemIcon sx={{ minWidth: 28 }}>{open2 ? <ExpandMoreIcon fontSize="small" /> : <ChevronRightIcon fontSize="small" />}</ListItemIcon>
                  <ListItemIcon sx={{ minWidth: 24 }}>{open2 ? <FolderOpenIcon fontSize="small" /> : <FolderIcon fontSize="small" />}</ListItemIcon>
                  <ListItemText primary={sc.name} slotProps={{ primary: { variant: 'subtitle2', noWrap: true } }} />
                  <Typography variant="code" sx={{ color: 'text.secondary', fontSize: 11 }}>{sc.skills.length}</Typography>
                </ListItemButton>
                <Collapse in={open2} timeout="auto" unmountOnExit>
                  <List dense disablePadding>
                    {sc.skills.map((sk) => {
                      const isSel = sel?.scope === sc.name && sel?.skill === sk.name;
                      return (
                        <ListItemButton key={sk.name} selected={isSel} onClick={() => open(sc.name, sk.name)}
                          sx={{ pl: 5, borderRadius: (t) => `${t.zapac.radius.sm}px`, mb: 0.25 }}
                          title={sk.description || sk.name}
                        >
                          <Typography variant="code" sx={{ fontSize: 12 }} noWrap>{sk.name}</Typography>
                        </ListItemButton>
                      );
                    })}
                    {sc.capped && <Typography sx={{ pl: 5, py: 0.5, color: 'text.secondary', fontSize: 11 }}>(capped at 200)</Typography>}
                    {sc.skills.length === 0 && <Typography sx={{ pl: 5, py: 1, color: 'text.secondary', fontSize: 12 }}>(no skills)</Typography>}
                  </List>
                </Collapse>
              </Box>
            );
          })}
          {view.length === 0 && !loadErr && <Typography sx={{ p: 2, color: 'text.secondary', fontSize: 13 }}>{query ? 'No matches.' : 'No scopes.'}</Typography>}
          {loadErr && <Typography sx={{ p: 2, color: 'text.secondary', fontSize: 13 }}>{loadErr}.</Typography>}
        </List>
          </>
        )}
      </Stack>
      {!collapsed && <ResizeHandle onMouseDown={railW.startDrag} />}

      {/* right: rendered SKILL.md */}
      <Stack sx={{ flex: 1, minWidth: 0, minHeight: 0, p: 1.5 }} spacing={1}>
        {!sel ? (
          <Box sx={{ flex: 1, display: 'grid', placeItems: 'center' }}>
            <EmptyState icon={<SchoolIcon />} title="Select a skill" description="Browse scopes on the left to view a skill here." />
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
            <Typography variant="code" sx={{ color: 'text.secondary', fontSize: 11 }}>{sel.scope}/{sel.skill}</Typography>
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
    </Box>
  );
}