import React, { useState, useEffect } from 'react';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import TextField from '@mui/material/TextField';
import Autocomplete from '@mui/material/Autocomplete';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import Chip from '@mui/material/Chip';
import FormControlLabel from '@mui/material/FormControlLabel';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import FormControl from '@mui/material/FormControl';
import InputLabel from '@mui/material/InputLabel';
import Select from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import AddIcon from '@mui/icons-material/Add';
import ModelSelect from './ModelSelect.jsx';
import { tildify, untildify } from './paths.js';

const DAYS = [['Su', 0], ['Mo', 1], ['Tu', 2], ['We', 3], ['Th', 4], ['Fr', 5], ['Sa', 6]];
const DEFAULT_WINDOW = { startHour: 9, endHour: 18, days: [1, 2, 3, 4, 5] };
const DEFAULT_THRESHOLDS = {
  claude: { start: 50, stop: 75, weeklyMax: 50 },
  ollama: { start: 50, stop: 75, weeklyMax: 50 },
};
const DEFAULT_MODELS = { claude: 'opus', ollama: 'glm-5.2:cloud' };
const DEFAULT_TOKEN_CAPS = { claude: 15_000_000, ollama: 15_000_000 };

// Add/edit-background-def dialog: title, description, cwd, cooldownHours,
// enabled, plus the per-task window/thresholds/models/tokenCaps that used to
// live in one global config block above the CronJobs table — each task now
// carries its own. `def` set → edit mode (prefill + PATCH /background/defs/:id),
// else create mode (POST /background/defs). Mirrors CreateCronDialog's layout.
export default function CreateBackgroundDialog({ open, onClose, def, recent = [], onToast }) {
  const editing = !!def;
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [cwd, setCwd] = useState('');
  const [cooldownHours, setCooldownHours] = useState('24');
  const [enabled, setEnabled] = useState(true);
  const [conclude, setConclude] = useState('inreview');
  const [windowCfg, setWindowCfg] = useState(DEFAULT_WINDOW);
  const [thresholds, setThresholds] = useState(DEFAULT_THRESHOLDS);
  const [models, setModels] = useState(DEFAULT_MODELS);
  const [tokenCaps, setTokenCaps] = useState(DEFAULT_TOKEN_CAPS);
  const [scopeList, setScopeList] = useState([]);
  const [scopes, setScopes] = useState([]);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  // The dialog never unmounts (renders null while closed), so a plain useState
  // initializer only runs once — resync on every open, either from `def` (edit)
  // or back to blank/defaults (create).
  useEffect(() => {
    if (!open) return;
    fetch('/skill-scopes').then((r) => r.json()).then((d) => setScopeList(d.scopes || [])).catch(() => {});
  }, [open]);

  useEffect(() => {
    if (!open) return;
    if (def) {
      setTitle(def.title || '');
      setDescription(def.description || '');
      setCwd(def.cwd || '');
      setCooldownHours(String(def.cooldownHours ?? 24));
      setEnabled(def.enabled !== false);
      setConclude(def.conclude || 'inreview');
      setWindowCfg(def.window || DEFAULT_WINDOW);
      setThresholds(def.thresholds || DEFAULT_THRESHOLDS);
      setModels(def.models || DEFAULT_MODELS);
      setTokenCaps(def.tokenCaps || DEFAULT_TOKEN_CAPS);
      setScopes(def.scopes || []);
    } else {
      setTitle(''); setDescription(''); setCwd(''); setCooldownHours('24'); setEnabled(true); setConclude('inreview');
      setWindowCfg(DEFAULT_WINDOW); setThresholds(DEFAULT_THRESHOLDS); setModels(DEFAULT_MODELS); setTokenCaps(DEFAULT_TOKEN_CAPS); setScopes([]);
    }
    setError(null);
  }, [open, def]);

  const canSubmit = !busy && !!title.trim() && !!description.trim() && !!cwd.trim();

  const toggleDay = (d) =>
    setWindowCfg((w) => ({ ...w, days: w.days.includes(d) ? w.days.filter((x) => x !== d) : [...w.days, d].sort((a, b) => a - b) }));
  const setThreshold = (backend, field, v) =>
    setThresholds((t) => ({ ...t, [backend]: { ...t[backend], [field]: v } }));
  const setModel = (backend, v) => setModels((m) => ({ ...m, [backend]: v }));
  const setTokenCap = (backend, v) => setTokenCaps((c) => ({ ...c, [backend]: v }));

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const url = editing ? `/background/defs/${def.id}` : '/background/defs';
      const method = editing ? 'PATCH' : 'POST';
      const r = await fetch(url, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: title.trim(), description: description.trim(), cwd: untildify(cwd.trim()),
          cooldownHours: Number(cooldownHours) || 24, enabled, conclude,
          window: windowCfg, thresholds, models, tokenCaps, scopes,
        }),
      });
      const d = await r.json();
      if (!d.ok) { setError(d.error || `${editing ? 'save' : 'create'} failed`); return; }
      onClose();
    } catch (e) {
      setError(e.message);
      onToast?.(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;
  return (
    <Dialog open onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{editing ? 'Edit background task' : 'New background task'}</DialogTitle>
      <DialogContent sx={{ pb: 1.5 }}>
        <Stack spacing={1.5} sx={{ pt: 0.5 }}>
          <TextField size="small" label="title" value={title} onChange={(e) => setTitle(e.target.value)} />
          <TextField size="small" label="description" value={description} onChange={(e) => setDescription(e.target.value)} multiline minRows={3} maxRows={10} />
          <Autocomplete
            freeSolo fullWidth options={(recent || []).map(tildify)} inputValue={cwd}
            onInputChange={(_, v) => setCwd(v)}
            renderInput={(params) => <TextField {...params} size="small" label="working directory" spellCheck={false} />}
          />
          <Autocomplete
            multiple size="small" disableCloseOnSelect
            options={scopeList} value={scopes} onChange={(_, v) => setScopes(v)}
            renderOption={(props, option, { selected }) => (
              <li {...props}><Checkbox size="small" checked={selected} style={{ marginRight: 8 }} />{option}</li>
            )}
            renderInput={(params) => <TextField {...params} size="small" label="skill-scopes" placeholder="" />}
          />
          <TextField size="small" label="cooldown (hours)" type="number" value={cooldownHours} onChange={(e) => setCooldownHours(e.target.value)} />
          <FormControlLabel control={<Checkbox size="small" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />} label="enabled" />
          <FormControl size="small" fullWidth>
            <InputLabel>on completion</InputLabel>
            <Select label="on completion" value={conclude} onChange={(e) => setConclude(e.target.value)}>
              <MenuItem value="inreview">In review (default)</MenuItem>
              <MenuItem value="done">Done</MenuItem>
            </Select>
          </FormControl>

          {/* Window */}
          <Stack spacing={0.5}>
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>Window</Typography>
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 1 }}>
              <TextField size="small" label="start hour" type="number" value={windowCfg.startHour} onChange={(e) => setWindowCfg((w) => ({ ...w, startHour: Number(e.target.value) }))} sx={{ width: 90 }} />
              <TextField size="small" label="end hour" type="number" value={windowCfg.endHour} onChange={(e) => setWindowCfg((w) => ({ ...w, endHour: Number(e.target.value) }))} sx={{ width: 90 }} />
              <Stack direction="row" spacing={0.5}>
                {DAYS.map(([lbl, d]) => (
                  <Chip key={d} size="small" label={lbl} variant={windowCfg.days.includes(d) ? 'filled' : 'outlined'} color={windowCfg.days.includes(d) ? 'primary' : 'default'} onClick={() => toggleDay(d)} sx={{ height: 24, fontSize: 11 }} />
                ))}
              </Stack>
            </Stack>
          </Stack>

          {/* Thresholds */}
          <Stack spacing={0.5}>
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>Thresholds (% used)</Typography>
            {['claude', 'ollama'].map((b) => (
              <Stack key={b} direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 1 }}>
                <Typography variant="code" sx={{ fontSize: 11, width: 54 }}>{b}</Typography>
                <TextField size="small" label="start <" type="number" value={thresholds[b].start} onChange={(e) => setThreshold(b, 'start', Number(e.target.value))} sx={{ width: 90 }} />
                <TextField size="small" label="stop ≥" type="number" value={thresholds[b].stop} onChange={(e) => setThreshold(b, 'stop', Number(e.target.value))} sx={{ width: 90 }} />
                <TextField size="small" label="weekly max" type="number" value={thresholds[b].weeklyMax} onChange={(e) => setThreshold(b, 'weeklyMax', Number(e.target.value))} sx={{ width: 110 }} />
              </Stack>
            ))}
          </Stack>

          {/* Models + token caps */}
          <Stack spacing={0.5}>
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>Models & token caps</Typography>
            {['claude', 'ollama'].map((b) => (
              <Stack key={b} direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 1 }}>
                <Typography variant="code" sx={{ fontSize: 11, width: 54 }}>{b}</Typography>
                <Box sx={{ minWidth: 160, flex: 1 }}>
                  <ModelSelect model={models[b]} setModel={(v) => setModel(b, v)} />
                </Box>
                <TextField size="small" label="token cap" type="number" value={tokenCaps[b]} onChange={(e) => setTokenCap(b, Number(e.target.value))} sx={{ width: 140 }} />
              </Stack>
            ))}
          </Stack>

          {error && <Typography variant="body2" color="error">{error}</Typography>}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 2, pb: 2, pt: 0.5 }}>
        <Button size="small" variant="secondary" sx={{ px: 2 }} onClick={onClose}>Cancel</Button>
        <Button size="small" sx={{ px: 2, '& .MuiButton-startIcon': { marginRight: 0.5 } }} variant="contained" startIcon={!editing ? <AddIcon /> : undefined} onClick={submit} disabled={!canSubmit}>
          {editing ? 'Save' : 'Create'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
