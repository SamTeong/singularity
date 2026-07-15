import React, { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import Collapse from '@mui/material/Collapse';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import FolderIcon from '@mui/icons-material/Folder';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import SchoolIcon from '@mui/icons-material/School';
import { StatusPill, EmptyState } from '@zapac/mui-theme';
import MarkdownBody from './MarkdownBody.jsx';

// Skills viewer: tree of skill scopes → skills (left), rendered SKILL.md
// (right). Read-only — no write. Skills live under SING_SCOPE_ROOT; the server
// derives paths from (scope, skill).
export default function SkillsPanel() {
  const [scopes, setScopes] = useState([]);
  const [loadErr, setLoadErr] = useState(null);
  const [expanded, setExpanded] = useState(() => new Set());
  const [sel, setSel] = useState(null); // { scope, skill }
  const [skill, setSkill] = useState(null); // { name, description, triggers, body }
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);

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

  const skillCount = scopes.reduce((n, s) => n + s.skills.length, 0);

  return (
    <Box sx={{ height: '100%', display: 'flex', minHeight: 0 }}>
      {/* left: scope → skill tree */}
      <Stack sx={(t) => ({ width: 300, flexShrink: 0, borderRight: `1px solid ${t.vars.palette.glass.stroke}`, minHeight: 0 })}>
        <Box sx={{ p: 1.5, pb: 0.5 }}>
          <Typography variant="subtitle2" sx={{ px: 1 }}>Skills</Typography>
          <Typography variant="code" sx={{ color: 'text.secondary', fontSize: 11, mt: 0.5, ml: 1, display: 'block' }}>
            {loadErr ? `${loadErr}` : `${scopes.length} scope${scopes.length === 1 ? '' : 's'} · ${skillCount} skill${skillCount === 1 ? '' : 's'}`}
          </Typography>
        </Box>
        <List dense sx={{ flex: 1, overflow: 'auto', px: 0.5, pt: 0 }}>
          {scopes.map((sc) => {
            const open2 = expanded.has(sc.name);
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
          {scopes.length === 0 && !loadErr && <Typography sx={{ p: 2, color: 'text.secondary', fontSize: 13 }}>No scopes.</Typography>}
          {loadErr && <Typography sx={{ p: 2, color: 'text.secondary', fontSize: 13 }}>{loadErr}.</Typography>}
        </List>
      </Stack>

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