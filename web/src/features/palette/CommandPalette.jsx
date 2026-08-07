import { useEffect, useMemo, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Paper from '@mui/material/Paper';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import Typography from '@mui/material/Typography';
import InputBase from '@mui/material/InputBase';
import { getTokens } from '@/theme/contract.js';
import { score } from './fuzzy.mjs';
import { matches, formatBinding } from '@/lib/keys.js';
import { useKeys } from '@/providers/KeysProvider.jsx';

// Presentational palette: props { commands, onRun, onClose }. Owns query + sel
// state, fuzzy filter, keyboard nav. No domain logic. Parent closes on every run.
export default function CommandPalette({ commands, onRun, onClose }) {
  const [query, setQuery] = useState('');
  const [sel, setSel] = useState(0);
  const prevFocus = useRef(null);
  const { keys } = useKeys();

  // Reset selection to top whenever the query changes — a render-time state
  // adjustment (compared against the previous query) instead of an effect, so
  // there's no extra render/paint between the query change and the reset.
  const [prevQuery, setPrevQuery] = useState(query);
  if (query !== prevQuery) {
    setPrevQuery(query);
    setSel(0);
  }

  // Capture focus on mount, restore to the element focused before open on unmount.
  useEffect(() => {
    prevFocus.current = document.activeElement;
    return () => { try { prevFocus.current?.focus?.(); } catch { /* element may be gone */ } };
  }, []);

  // Filter + sort + cap. Empty query => include all (score 0).
  const filtered = useMemo(() => {
    const out = [];
    for (const c of commands) {
      const s = score(query, { label: c.label, keywords: c.keywords });
      if (s !== null) out.push({ c, s });
    }
    out.sort((a, b) => b.s - a.s || a.c.label.localeCompare(b.c.label));
    return out.map((x) => x.c).slice(0, 50); // ponytail: cap; virtualize if >500
  }, [query, commands]);

  // Group preserving filtered order; carry the filtered index for selection.
  const groups = useMemo(() => {
    const m = new Map();
    filtered.forEach((c, i) => {
      const g = c.group || 'Commands';
      if (!m.has(g)) m.set(g, []);
      m.get(g).push({ c, i });
    });
    return [...m.entries()];
  }, [filtered]);

  // Footer hint follows the live bindings — a rebind must not leave it lying.
  const hint = `${formatBinding(keys.palettePrev)}${formatBinding(keys.paletteNext)} select · ${formatBinding(keys.paletteRun)} run · ${formatBinding(keys.paletteClose)} close`;

  // Keyboard nav on the input — stopPropagation so ALT+Up/Down + xterm don't fire.
  const onKeyDown = (e) => {
    if (matches(keys.paletteNext, e)) { e.preventDefault(); e.stopPropagation(); setSel((s) => (s + 1) % filtered.length); }
    else if (matches(keys.palettePrev, e)) { e.preventDefault(); e.stopPropagation(); setSel((s) => (s - 1 + filtered.length) % filtered.length); }
    else if (matches(keys.paletteRun, e)) { e.preventDefault(); e.stopPropagation(); if (filtered[sel]) onRun(filtered[sel]); }
    else if (matches(keys.paletteClose, e)) { e.preventDefault(); e.stopPropagation(); onClose(); }
  };

  return (
    <Box
      onClick={onClose}
      sx={(t) => ({
        position: 'fixed', inset: 0,
        zIndex: getTokens(t).layers.modal ?? 1300,
        display: 'flex', justifyContent: 'center', alignItems: 'flex-start',
        pt: '12vh', backgroundColor: 'rgba(0,0,0,0.35)',
      })}
    >
      <Paper onClick={(e) => e.stopPropagation()} elevation={8} sx={{ width: 520, maxWidth: '92vw', maxHeight: '60vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <InputBase
          autoFocus
          aria-label="Search commands"
          inputProps={{ 'data-palette-input': true }}
          placeholder="Search commands…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          sx={{ px: 2, py: 1.5, fontSize: 16, borderBottom: '1px solid', borderColor: 'divider' }}
        />
        <Box sx={{ overflowY: 'auto', flex: 1 }}>
          {groups.map(([g, items]) => (
            <List key={g} dense disablePadding>
              <Typography component="div" sx={{ px: 2, py: 0.5, fontSize: 11, color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{g}</Typography>
              {items.map(({ c, i }) => (
                <ListItemButton key={c.id} role="option" selected={i === sel} onClick={() => onRun(c)} sx={{ px: 2 }}>
                  <ListItemText primary={c.label} />
                  {c.hint && <Typography sx={{ fontSize: 11, color: 'text.secondary', ml: 1 }}>{c.hint}</Typography>}
                </ListItemButton>
              ))}
            </List>
          ))}
          {filtered.length === 0 && (
            <Typography sx={{ px: 2, py: 3, color: 'text.secondary', fontSize: 13 }}>No matches</Typography>
          )}
        </Box>
        <Typography sx={{ px: 2, py: 0.75, fontSize: 11, color: 'text.secondary', borderTop: '1px solid', borderColor: 'divider' }}>{hint}</Typography>
      </Paper>
    </Box>
  );
}
