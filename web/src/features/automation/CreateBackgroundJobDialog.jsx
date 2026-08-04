import { useState, useEffect } from 'react';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import TextField from '@mui/material/TextField';
import Checkbox from '@mui/material/Checkbox';
import Chip from '@mui/material/Chip';
import FormControlLabel from '@mui/material/FormControlLabel';
import FormControl from '@mui/material/FormControl';
import InputLabel from '@mui/material/InputLabel';
import Select from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import ModelSelect from '@/components/ModelSelect.jsx';
import CwdPicker from '@/components/CwdPicker.jsx';
import ScopeSelect from '@/components/ScopeSelect.jsx';
import CreateDialog, { clearAdornment } from '@/components/CreateDialog.jsx';
import { untildify } from '@/lib/paths.js';

const DAYS = [['Su', 0], ['Mo', 1], ['Tu', 2], ['We', 3], ['Th', 4], ['Fr', 5], ['Sa', 6]];
const DEFAULT_WINDOW = { startHour: 9, endHour: 18, days: [1, 2, 3, 4, 5] };
const DEFAULT_THRESHOLDS = {
  claude: { start: 50, stop: 75, weeklyMax: 50 },
  codex: { start: 50, stop: 75, weeklyMax: 50 },
  ollama: { start: 50, stop: 75, weeklyMax: 50 },
};
const DEFAULT_MODELS = { claude: 'opus', codex: 'gpt-5.6-luna', ollama: 'glm-5.2:cloud' };
const DEFAULT_TOKEN_CAPS = { claude: 15_000_000, codex: 15_000_000, ollama: 15_000_000 };
const BACKEND_LABEL = { claude: 'Claude', codex: 'Codex', ollama: 'Ollama' };

// Add/edit-background-job dialog: title, description, cwd, cooldownHours,
// enabled, plus the per-task window/thresholds/models/tokenCaps that used to
// live in one global config block above the CronJobs table — each task now
// carries its own. `job` set → edit mode (prefill + PATCH /background/jobs/:id),
// else create mode (POST /background/jobs). Mirrors CreateScheduledJobDialog's layout.
export default function CreateBackgroundJobDialog({ open, onClose, job, cwd, setCwd, recent = [], onBrowse, onToast }) {
  const editing = !!job;
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [cooldownHours, setCooldownHours] = useState('24');
  const [enabled, setEnabled] = useState(true);
  const [conclude, setConclude] = useState('inreview');
  const [windowCfg, setWindowCfg] = useState(DEFAULT_WINDOW);
  const [thresholds, setThresholds] = useState(DEFAULT_THRESHOLDS);
  const [models, setModels] = useState(DEFAULT_MODELS);
  const [tokenCaps, setTokenCaps] = useState(DEFAULT_TOKEN_CAPS);
  const [scopes, setScopes] = useState([]);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  // The dialog never unmounts (renders null while closed) — resync on every
  // open, either from `job` (edit) or back to blank/defaults (create). Fires
  // only on the false→true open transition, so it's a render-time state
  // adjustment (compared against the previous `open`) rather than an effect
  // that would setState on every commit. Callers always close before switching
  // to a different job (see CronJobs.jsx), so `job` changing identity while
  // `open` stays true only ever means a fresh server push of the same record.
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) {
      if (job) {
        setTitle(job.title || '');
        setDescription(job.description || '');
        setCooldownHours(String(job.cooldownHours ?? 24));
        setEnabled(job.enabled !== false);
        setConclude(job.conclude || 'inreview');
        setWindowCfg(job.window || DEFAULT_WINDOW);
        setThresholds(job.thresholds || DEFAULT_THRESHOLDS);
        setModels(job.models || DEFAULT_MODELS);
        setTokenCaps(job.tokenCaps || DEFAULT_TOKEN_CAPS);
        setScopes(job.scopes || []);
      } else {
        setTitle(''); setDescription(''); setCooldownHours('24'); setEnabled(true); setConclude('inreview');
        setWindowCfg(DEFAULT_WINDOW); setThresholds(DEFAULT_THRESHOLDS); setModels(DEFAULT_MODELS); setTokenCaps(DEFAULT_TOKEN_CAPS); setScopes([]);
      }
      setError(null);
    }
  }
  // cwd is AppShell's shared picker state (the Browse button writes to it), not
  // owned by this component — syncing it into a sibling still belongs in an
  // effect. `job` is deliberately left out of the dep array (it's only read
  // for its value here): the job list is websocket-fed and gets a new object
  // identity on every server push, so keying on it would re-fire this effect
  // on every push while the dialog is open and clobber a cwd the user just
  // picked with Browse. Keying on `open` alone fires this only on the
  // false→true transition, mirroring the render-time block above.
  useEffect(() => {
    if (open && job?.cwd) setCwd(job.cwd);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see comment above
  }, [open, setCwd]);

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
      const url = editing ? `/background/jobs/${job.id}` : '/background/jobs';
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
    <CreateDialog
      open={open}
      onClose={onClose}
      title={editing ? 'Edit background job' : 'New background job'}
      onCancel={onClose}
      onCreate={submit}
      editing={editing}
      createDisabled={!canSubmit}
    >
      <TextField size="small" label="title" value={title} onChange={(e) => setTitle(e.target.value)} slotProps={{ input: { endAdornment: clearAdornment(title !== '', () => setTitle('')) } }} />
      <TextField size="small" label="description" value={description} onChange={(e) => setDescription(e.target.value)} multiline minRows={3} maxRows={10} slotProps={{ input: { endAdornment: clearAdornment(description !== '', () => setDescription('')) } }} />
      <CwdPicker value={cwd} onChange={setCwd} recent={recent} onBrowse={onBrowse} label="working directory" />
      <ScopeSelect open={open} value={scopes} onChange={setScopes} />
      <TextField size="small" label="Cooldown" type="number" value={cooldownHours} onChange={(e) => setCooldownHours(e.target.value)} />
      <FormControlLabel control={<Checkbox size="small" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />} label="enabled" />
      <FormControl size="small" fullWidth>
        <InputLabel>when finished</InputLabel>
        <Select label="when finished" value={conclude} onChange={(e) => setConclude(e.target.value)}>
          <MenuItem value="inreview">In review (default)</MenuItem>
          <MenuItem value="done">Done</MenuItem>
        </Select>
      </FormControl>

      {/* Window */}
      <Stack spacing={0.5}>
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>Daily time window</Typography>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 1 }}>
          <TextField size="small" label="start hour (24h)" type="number" value={windowCfg.startHour} onChange={(e) => setWindowCfg((w) => ({ ...w, startHour: Number(e.target.value) }))} sx={{ width: 90 }} />
          <TextField size="small" label="end hour (24h)" type="number" value={windowCfg.endHour} onChange={(e) => setWindowCfg((w) => ({ ...w, endHour: Number(e.target.value) }))} sx={{ width: 90 }} />
          <Stack direction="row" spacing={0.5}>
            {DAYS.map(([lbl, d]) => (
              <Chip key={d} size="small" label={lbl} variant={windowCfg.days.includes(d) ? 'filled' : 'outlined'} color={windowCfg.days.includes(d) ? 'primary' : 'default'} onClick={() => toggleDay(d)} sx={{ height: 24, fontSize: 11 }} />
            ))}
          </Stack>
        </Stack>
      </Stack>

      {/* Thresholds */}
      <Stack spacing={0.5}>
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>Usage thresholds (%), for when to start/stop</Typography>
        {['claude', 'codex', 'ollama'].map((b) => (
          <Stack key={b} direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 1 }}>
            <Typography variant="code" sx={{ fontSize: 11, width: 54 }}>{BACKEND_LABEL[b]}</Typography>
            <TextField size="small" label="start below (%)" type="number" value={thresholds[b].start} onChange={(e) => setThreshold(b, 'start', Number(e.target.value))} sx={{ width: 90 }} />
            <TextField size="small" label="stop above (%)" type="number" value={thresholds[b].stop} onChange={(e) => setThreshold(b, 'stop', Number(e.target.value))} sx={{ width: 90 }} />
            <TextField size="small" label="weekly cap (%)" type="number" value={thresholds[b].weeklyMax} onChange={(e) => setThreshold(b, 'weeklyMax', Number(e.target.value))} sx={{ width: 110 }} />
          </Stack>
        ))}
      </Stack>

      {/* Models + token caps */}
      <Stack spacing={0.5}>
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>Models & spending limits</Typography>
        {['claude', 'codex', 'ollama'].map((b) => (
          <Stack key={b} direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 1 }}>
            <Typography variant="code" sx={{ fontSize: 11, width: 54 }}>{BACKEND_LABEL[b]}</Typography>
            <Box sx={{ minWidth: 160, flex: 1 }}>
              <ModelSelect model={models[b]} setModel={(v) => setModel(b, v)} />
            </Box>
            <TextField size="small" label="max tokens per run" type="number" value={tokenCaps[b]} onChange={(e) => setTokenCap(b, Number(e.target.value))} sx={{ width: 140 }} />
          </Stack>
        ))}
      </Stack>

      {error && <Typography variant="body2" color="error">{error}</Typography>}
    </CreateDialog>
  );
}
