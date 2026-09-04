import { useState } from 'react';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import MenuItem from '@mui/material/MenuItem';
import Radio from '@mui/material/Radio';
import Select from '@mui/material/Select';
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import { alpha } from '@mui/material/styles';
import AddIcon from '@mui/icons-material/Add';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import DeleteIcon from '@mui/icons-material/Delete';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import { useModels } from '@/hooks/useModels.js';
import { useCapabilities } from '@/hooks/useCapabilities.js';

const GROUPS = ['claude', 'ollama', 'codex'];
const EMPTY_ADD = { id: '', label: '', group: 'claude' };

/**
 * Models tab — the user-managed model list (GET/PUT /api/models). Each row
 * edits id + label inline (saved on blur), toggles enable/disable, moves within
 * its group, or deletes; the radio marks the default across the whole list, and
 * the History summariser picks an ollama entry. Reorder is deliberately within
 * a group only: the picker re-partitions by group before rendering (MUI
 * Autocomplete emits a group header per transition), so a cross-group move
 * would never be visible there. Local draft + PUT /api/models on change — no
 * optimistic update; a 400 shows the server error and refetches.
 */
export default function ModelsPanel() {
  const { models, defaultModel, summariserModel, reload } = useModels();
  const caps = useCapabilities();
  const ollamaUnavailable = caps && caps.ollama?.available === false;
  const doc = models ? { models, defaultModel, summariserModel } : null;
  const [draft, setDraft] = useState(null);
  const [prevDoc, setPrevDoc] = useState(null);
  const [error, setError] = useState(null);
  const [add, setAdd] = useState(EMPTY_ADD);

  // Sync the draft from the fetched document — during render, guarded on doc
  // identity (the React-documented "adjust state when a prop changes" pattern;
  // an effect would setState synchronously, which react-hooks forbids).
  if (doc && doc !== prevDoc) {
    setPrevDoc(doc);
    setDraft(doc);
  }

  // The server rejects a document whose defaultModel/summariserModel points at
  // a removed or disabled entry — clear the pointer instead of failing the save.
  const normalize = (next) => ({
    ...next,
    defaultModel: next.models.some((m) => m.id === next.defaultModel && m.enabled) ? next.defaultModel : '',
    summariserModel: next.models.some((m) => m.id === next.summariserModel && m.group === 'ollama') ? next.summariserModel : '',
  });

  const save = async (next) => {
    const body = normalize(next);
    setDraft(body);
    setError(null);
    try {
      const r = await fetch('/api/models', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) { setError(d.error || `save failed (${r.status})`); reload(); return; }
      setDraft(d.state);
    } catch (e) { setError(e.message); reload(); }
  };

  const restoreDefaults = async () => {
    setError(null);
    try {
      const r = await fetch('/api/models/restore-defaults', { method: 'POST' });
      const d = await r.json();
      if (!r.ok || !d.ok) { setError(d.error || `restore failed (${r.status})`); reload(); return; }
      setDraft(d.state);
    } catch (e) { setError(e.message); reload(); }
  };

  if (!draft) return null;
  const replace = (i, patch) => ({ ...draft, models: draft.models.map((m, j) => (j === i ? { ...m, ...patch } : m)) });

  // Renaming an entry keeps the default/summariser pointers on it.
  const editId = (i, id) => setDraft((d) => ({
    ...d,
    defaultModel: d.defaultModel === d.models[i].id ? id : d.defaultModel,
    summariserModel: d.summariserModel === d.models[i].id ? id : d.summariserModel,
    models: d.models.map((m, j) => (j === i ? { ...m, id } : m)),
  }));

  // Swap with the adjacent row — the up/down buttons are disabled at a group
  // boundary, so this never moves an entry across groups.
  const move = (i, dir) => {
    const j = i + dir;
    if (j < 0 || j >= draft.models.length || draft.models[j].group !== draft.models[i].group) return;
    const models = [...draft.models];
    [models[i], models[j]] = [models[j], models[i]];
    save({ ...draft, models });
  };

  const addModel = () => {
    save({ ...draft, models: [...draft.models, { id: add.id.trim(), group: add.group, label: add.label, enabled: true }] });
    setAdd(EMPTY_ADD);
  };

  return (
    <Box sx={{ p: 2 }}>
      <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', mb: 1, flexWrap: 'wrap' }}>
        <Typography sx={{ fontSize: 16, fontWeight: 600, flex: 1 }}>Models</Typography>
        <Button size="small" startIcon={<RestartAltIcon />} onClick={restoreDefaults}>Restore defaults</Button>
      </Stack>
      <Typography variant="body2" sx={{ color: 'text.secondary', mb: 2 }}>
        Suggestions for the free-text model pickers, grouped by which bin the daemon routes them to.
      </Typography>

      {error && (
        <Typography variant="body2" color="error" sx={{ mb: 2 }}>
          {error}
        </Typography>
      )}

      {draft.models.map((m, i) => (
        <Stack
          key={i}
          direction="row"
          spacing={1}
          sx={{ alignItems: 'center', py: 0.75, borderBottom: (t) => `1px solid ${alpha(t.palette.glass.stroke, 0.1)}` }}
        >
          <Tooltip title={m.enabled ? 'Mark as default' : 'Enable to mark as default'}>
            <Radio
              size="small"
              sx={{ p: 0.5 }}
              checked={draft.defaultModel === m.id}
              disabled={!m.enabled}
              onChange={() => save({ ...draft, defaultModel: m.id })}
            />
          </Tooltip>
          <TextField
            size="small"
            value={m.id}
            onChange={(e) => editId(i, e.target.value)}
            onBlur={() => save(replace(i, {}))}
            sx={{ width: 210 }}
          />
          <TextField
            size="small"
            placeholder="label"
            value={m.label}
            onChange={(e) => setDraft(replace(i, { label: e.target.value }))}
            onBlur={() => save(replace(i, {}))}
            sx={{ width: 170 }}
          />
          <Select size="small" value={m.group} onChange={(e) => save(replace(i, { group: e.target.value }))} sx={{ width: 96 }}>
            {GROUPS.map((g) => <MenuItem key={g} value={g}>{g}</MenuItem>)}
          </Select>
          <Tooltip title="Enabled in the picker">
            <Switch size="small" checked={m.enabled} onChange={(e) => save(replace(i, { enabled: e.target.checked }))} />
          </Tooltip>
          <IconButton size="small" onClick={() => move(i, -1)} disabled={i === 0 || draft.models[i - 1].group !== m.group}>
            <ArrowUpwardIcon fontSize="small" />
          </IconButton>
          <IconButton size="small" onClick={() => move(i, 1)} disabled={i === draft.models.length - 1 || draft.models[i + 1].group !== m.group}>
            <ArrowDownwardIcon fontSize="small" />
          </IconButton>
          <Tooltip title="Delete">
            <IconButton size="small" onClick={() => save({ ...draft, models: draft.models.filter((_, j) => j !== i) })}>
              <DeleteIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Stack>
      ))}

      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mt: 2 }}>
        <TextField size="small" placeholder="id — e.g. sonnet[1m]" value={add.id} onChange={(e) => setAdd({ ...add, id: e.target.value })} sx={{ width: 210 }} />
        <TextField size="small" placeholder="label" value={add.label} onChange={(e) => setAdd({ ...add, label: e.target.value })} sx={{ width: 170 }} />
        <Select size="small" value={add.group} onChange={(e) => setAdd({ ...add, group: e.target.value })} sx={{ width: 96 }}>
          {GROUPS.map((g) => <MenuItem key={g} value={g}>{g}</MenuItem>)}
        </Select>
        <Button size="small" startIcon={<AddIcon />} disabled={!add.id.trim()} onClick={addModel}>Add</Button>
      </Stack>

      <TextField
        select
        size="small"
        label="History summariser"
        value={draft.summariserModel}
        disabled={ollamaUnavailable}
        onChange={(e) => save({ ...draft, summariserModel: e.target.value })}
        helperText={ollamaUnavailable ? caps?.ollama?.hint : 'Ollama model that summarises the History view.'}
        sx={{ width: 280, mt: 3 }}
      >
        <MenuItem value="">None</MenuItem>
        {draft.models.filter((m) => m.group === 'ollama').map((m) => (
          <MenuItem key={m.id} value={m.id}>{m.label || m.id}</MenuItem>
        ))}
      </TextField>
    </Box>
  );
}