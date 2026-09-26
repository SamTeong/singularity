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
import KeyboardArrowUpIcon from '@mui/icons-material/KeyboardArrowUp';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import DragIndicatorIcon from '@mui/icons-material/DragIndicator';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import useMediaQuery from '@mui/material/useMediaQuery';
import { PHONE_QUERY, TABLET_QUERY } from '@/shell/breakpoints.js';

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
  // Only the handle is draggable — a draggable row would break text selection
  // inside its key/rate fields. A drag is scoped to its own table: a cross-table
  // drop is rejected rather than reordering the other table's rows.
  const [drag, setDrag] = useState(null);
  const [over, setOver] = useState(null);
  const isPhone = useMediaQuery(PHONE_QUERY);
  const isTablet = useMediaQuery(TABLET_QUERY);
  // Below 900px an HTML5 drag is not operable by touch, so the grip is replaced
  // (not merely hidden) by Move up/down buttons — the same phone||tablet switch
  // CronJobs uses. Desktop keeps the grip.
  const narrow = isPhone || isTablet;
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
  // Move a row to another slot in the same table — base's row order IS match
  // order, so a non-adjacent drop relocates the row rather than swapping the
  // endpoints. Native HTML5 DnD, committed on drop like ModelsPanel's group
  // reorder; the handle also takes ArrowUp/ArrowDown so it stays keyboard-usable.
  const reorder = (table, from, to) => {
    const rows = [...draft[table]];
    if (to < 0 || to >= rows.length) return;
    const [row] = rows.splice(from, 1);
    rows.splice(to, 0, row);
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

  const table = (tableKey, rows, add, setAdd, { atTop }) => (
    <>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', pb: 0.5, '& > *': { fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5, color: 'text.secondary' } }}>
        <Typography sx={{ width: 30 }} />
        <Typography sx={{ width: 160 }}>Key</Typography>
        {VALUE_COLS.map((c, ci) => <Typography key={c} sx={{ width: colWidth(ci) }}>{c}</Typography>)}
        <Typography sx={{ width: 30 }} />
      </Stack>

      {rows.map((row, i) => (
        <Stack
          key={i}
          direction="row"
          spacing={1}
          onDragOver={(e) => { if (drag?.table === tableKey) { e.preventDefault(); setOver({ table: tableKey, index: i }); } }}
          onDrop={(e) => { e.preventDefault(); if (drag?.table === tableKey) reorder(tableKey, drag.index, i); setDrag(null); setOver(null); }}
          sx={{
            alignItems: 'center',
            py: 0.75,
            borderBottom: (t) => `1px solid ${stroke2(t)}`,
            opacity: drag?.table === tableKey && drag.index === i ? 0.4 : 1,
            bgcolor: over?.table === tableKey && over.index === i && drag?.index !== i ? 'action.hover' : 'transparent',
          }}
        >
          {narrow ? (
            <Stack sx={{ alignItems: 'center' }}>
              <Tooltip title="Move up" disableInteractive>
                <span>
                  <IconButton size="small" aria-label={`Move ${row.key || 'row'} up`} sx={{ p: 0.25 }} disabled={i === 0} onClick={() => moveRow(tableKey, i, -1)}>
                    <KeyboardArrowUpIcon fontSize="small" />
                  </IconButton>
                </span>
              </Tooltip>
              <Tooltip title="Move down" disableInteractive>
                <span>
                  <IconButton size="small" aria-label={`Move ${row.key || 'row'} down`} sx={{ p: 0.25 }} disabled={i === rows.length - 1} onClick={() => moveRow(tableKey, i, 1)}>
                    <KeyboardArrowDownIcon fontSize="small" />
                  </IconButton>
                </span>
              </Tooltip>
            </Stack>
          ) : (
            <Tooltip title="Drag to reorder (or focus and press ↑ / ↓)">
              <IconButton
                size="small"
                aria-label="Reorder"
                draggable
                onDragStart={(e) => { setDrag({ table: tableKey, index: i }); e.dataTransfer.effectAllowed = 'move'; }}
                onDragEnd={() => { setDrag(null); setOver(null); }}
                onKeyDown={(e) => {
                  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
                  e.preventDefault();
                  reorder(tableKey, i, i + (e.key === 'ArrowUp' ? -1 : 1));
                }}
                sx={{ cursor: 'grab' }}
              >
                <DragIndicatorIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          )}
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
          <Tooltip title="Delete">
            <IconButton size="small" aria-label={`Delete ${row.key || 'row'}`} onClick={() => deleteRow(tableKey, i)}>
              <DeleteIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Stack>
      ))}

      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mt: 2 }}>
        <TextField size="small" placeholder="Key" value={add.key} onChange={(e) => setAdd({ ...add, key: e.target.value })} sx={{ width: 160 }} />
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
      {table('base', draft.base, addBase, setAddBase, { atTop: true })}

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
      {table('above', draft.above, addAbove, setAddAbove, { atTop: false })}

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
        <Typography sx={{ fontSize: 14, fontWeight: 600 }}>API Rates</Typography>
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
