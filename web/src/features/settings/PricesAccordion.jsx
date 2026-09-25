import { useEffect, useRef, useState } from 'react';
import Accordion from '@mui/material/Accordion';
import AccordionSummary from '@mui/material/AccordionSummary';
import AccordionDetails from '@mui/material/AccordionDetails';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import TextField from '@mui/material/TextField';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import { stroke2 } from '@/shell/shellStyles.js';
import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/Delete';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import useMediaQuery from '@mui/material/useMediaQuery';
import { PHONE_QUERY } from '@/shell/breakpoints.js';

const VALUE_COLS = ['Input', 'Output', 'Cache read', 'Cache write'];
// Header text is uppercase; 'CACHE WRITE' needs a little more room than the rest.
const colWidth = (i) => (i === 3 ? 112 : 96);
const emptyRow = () => ({ key: '', values: ['', '', '', ''] });
const EMPTY_DRAFT = { base: [], above: [], threshold: '200000', defaultKey: '' };

// pricing.json table ({ "<key>": [in, out, cacheRead, cacheWrite] }) <-> an
// ordered row array, so a key can be edited without losing its slot or
// colliding mid-edit with another row (object key order is not a safe
// editing surface). base's row order IS match order (spec3.md).
const toRows = (table) => Object.entries(table || {}).map(([key, values]) => ({ key, values: values.map(String) }));
const toTable = (rows) => Object.fromEntries(
  rows.filter((r) => r.key.trim()).map((r) => [r.key.trim(), r.values.map(Number)]),
);
const toDraft = (doc) => ({
  base: toRows(doc.base),
  above: toRows(doc.above_200k),
  threshold: String(doc.long_context_threshold ?? 200000),
  defaultKey: doc.default_key || '',
});

/**
 * Settings > Models > Prices — pricing.json, the harness-usage-report's only
 * rate source (GET/PUT /api/models/prices). Local draft; PUT the full doc on
 * blur (only if it actually changed since the last load/save) / add / delete
 * / move / select — no optimistic update; a 400 shows the server error and
 * refetches.
 */
export default function PricesAccordion() {
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [error, setError] = useState(null);
  const [addBase, setAddBase] = useState(emptyRow());
  const [addAbove, setAddAbove] = useState(emptyRow());
  const isPhone = useMediaQuery(PHONE_QUERY);
  // Last known-good draft (from load or a successful save), to skip a PUT on
  // blur when nothing actually changed.
  const lastSaved = useRef(EMPTY_DRAFT);

  const load = () => {
    fetch('/api/models/prices')
      .then((r) => r.json())
      .then((d) => { const next = toDraft(d); setDraft(next); lastSaved.current = next; setError(null); })
      .catch((e) => setError(e.message || 'could not load prices'));
  };
  useEffect(load, []);

  const save = async (next) => {
    setDraft(next);
    setError(null);
    try {
      const r = await fetch('/api/models/prices', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          base: toTable(next.base),
          above_200k: toTable(next.above),
          long_context_threshold: Number(next.threshold),
          default_key: next.defaultKey,
        }),
      });
      const d = await r.json();
      if (!r.ok) { setError(d.error || `save failed (${r.status})`); load(); return; }
      const saved = toDraft(d);
      setDraft(saved);
      lastSaved.current = saved;
    } catch (e) { setError(e.message); load(); }
  };

  const saveIfChanged = () => {
    if (JSON.stringify(draft) !== JSON.stringify(lastSaved.current)) save(draft);
  };

  const replaceRow = (table, i, patch) => draft[table].map((row, j) => (j === i ? { ...row, ...patch } : row));
  const moveRow = (table, i, dir) => {
    const rows = [...draft[table]];
    const j = i + dir;
    if (j < 0 || j >= rows.length) return;
    [rows[i], rows[j]] = [rows[j], rows[i]];
    save({ ...draft, [table]: rows });
  };
  const deleteRow = (table, i) => {
    const rows = draft[table].filter((_, j) => j !== i);
    let defaultKey = draft.defaultKey;
    if (table === 'base' && draft.base[i]?.key.trim() === defaultKey) {
      defaultKey = rows[i]?.key.trim() || rows[i - 1]?.key.trim() || '';
    }
    save({ ...draft, [table]: rows, defaultKey });
  };
  const addRow = (table, add, setAdd, atTop) => {
    const row = { key: add.key.trim(), values: add.values };
    const rows = atTop ? [row, ...draft[table]] : [...draft[table], row];
    save({ ...draft, [table]: rows });
    setAdd(emptyRow());
  };

  const baseKeys = draft.base.map((r) => r.key.trim()).filter(Boolean);

  const table = (tableKey, rows, add, setAdd, { movable, atTop }) => (
    <>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', pb: 0.5, '& > *': { fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5, color: 'text.secondary' } }}>
        <Typography sx={{ width: 160 }}>Key</Typography>
        {VALUE_COLS.map((c, ci) => <Typography key={c} sx={{ width: colWidth(ci) }}>{c}</Typography>)}
        <Typography sx={{ width: movable ? 90 : 30 }} />
      </Stack>

      {rows.map((row, i) => (
        <Stack
          key={i}
          direction="row"
          spacing={1}
          sx={{ alignItems: 'center', py: 0.75, borderBottom: (t) => `1px solid ${stroke2(t)}` }}
        >
          <TextField
            size="small"
            placeholder="e.g. opus"
            value={row.key}
            onChange={(e) => {
              const key = e.target.value;
              const defaultKey = tableKey === 'base' && row.key.trim() === draft.defaultKey
                ? key.trim()
                : draft.defaultKey;
              setDraft({ ...draft, [tableKey]: replaceRow(tableKey, i, { key }), defaultKey });
            }}
            onBlur={saveIfChanged}
            sx={{ width: 160 }}
          />
          {row.values.map((v, vi) => (
            <TextField
              key={vi}
              size="small"
              type="number"
              inputProps={{ min: 0, step: 'any' }}
              value={v}
              onChange={(e) => setDraft({ ...draft, [tableKey]: replaceRow(tableKey, i, { values: row.values.map((x, xi) => (xi === vi ? e.target.value : x)) }) })}
              onBlur={saveIfChanged}
              sx={{ width: colWidth(vi) }}
            />
          ))}
          {movable && (
            <Tooltip title="Move up">
              <span>
                <IconButton size="small" aria-label={`Move ${row.key || 'row'} up`} disabled={i === 0} onClick={() => moveRow(tableKey, i, -1)}>
                  <ArrowUpwardIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
          )}
          {movable && (
            <Tooltip title="Move down">
              <span>
                <IconButton size="small" aria-label={`Move ${row.key || 'row'} down`} disabled={i === rows.length - 1} onClick={() => moveRow(tableKey, i, 1)}>
                  <ArrowDownwardIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
          )}
          <Tooltip title="Delete">
            <IconButton size="small" aria-label={`Delete ${row.key || 'row'}`} onClick={() => deleteRow(tableKey, i)}>
              <DeleteIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Stack>
      ))}

      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mt: 2 }}>
        <TextField size="small" placeholder="key" value={add.key} onChange={(e) => setAdd({ ...add, key: e.target.value })} sx={{ width: 160 }} />
        {add.values.map((v, vi) => (
          <TextField
            key={vi}
            size="small"
            type="number"
            inputProps={{ min: 0, step: 'any' }}
            placeholder={VALUE_COLS[vi]}
            value={v}
            onChange={(e) => setAdd({ ...add, values: add.values.map((x, xi) => (xi === vi ? e.target.value : x)) })}
            sx={{ width: colWidth(vi) }}
          />
        ))}
        <Button size="small" startIcon={<AddIcon />} disabled={!add.key.trim() || add.values.some((v) => v === '')} onClick={() => addRow(tableKey, add, setAdd, atTop)}>Add</Button>
      </Stack>
    </>
  );

  const body = (
    <>
      <Typography variant="subtitle2" sx={{ mb: 1 }}>Base rates</Typography>
      {table('base', draft.base, addBase, setAddBase, { movable: true, atTop: true })}

      <Typography variant="subtitle2" sx={{ mt: 3, mb: 1 }}>Above long-context threshold</Typography>
      <TextField
        size="small"
        type="number"
        label="Long-context threshold (tokens)"
        inputProps={{ min: 1, step: 1 }}
        value={draft.threshold}
        onChange={(e) => setDraft({ ...draft, threshold: e.target.value })}
        onBlur={saveIfChanged}
        sx={{ width: 260, mb: 1.5 }}
      />
      {table('above', draft.above, addAbove, setAddAbove, { movable: false, atTop: false })}

      <Typography variant="subtitle2" sx={{ mt: 3, mb: 1 }}>Fallback key</Typography>
      <Select
        size="small"
        value={baseKeys.includes(draft.defaultKey) ? draft.defaultKey : ''}
        onChange={(e) => save({ ...draft, defaultKey: e.target.value })}
        sx={{ width: 280 }}
      >
        <MenuItem value="">(none — unmatched models unpriced)</MenuItem>
        {baseKeys.map((k) => <MenuItem key={k} value={k}>{k}</MenuItem>)}
      </Select>
    </>
  );

  return (
    <Accordion sx={{ mb: 2 }}>
      <AccordionSummary expandIcon={<ExpandMoreIcon />}>
        <Typography sx={{ fontSize: 14, fontWeight: 600 }}>Prices (harness-usage-report)</Typography>
      </AccordionSummary>
      <AccordionDetails>
        <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mb: 1.5 }}>
          $/MTok. The usage report's only rate source (pricing.json). A model uses the first key contained in its id; order matters.
        </Typography>

        {error && (
          <Typography variant="body2" color="error" sx={{ mb: 1.5 }}>
            {error}
          </Typography>
        )}

        {isPhone ? (
          <Box role="region" aria-label="Price list (scrolls horizontally)" tabIndex={0} sx={{ maxWidth: '100%', flexShrink: 0, overflowX: 'auto' }}>
            <Box sx={{ minWidth: 620 }}>{body}</Box>
          </Box>
        ) : body}
      </AccordionDetails>
    </Accordion>
  );
}
