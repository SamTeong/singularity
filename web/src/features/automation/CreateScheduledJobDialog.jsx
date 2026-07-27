import { useEffect, useMemo, useState } from 'react';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import TextField from '@mui/material/TextField';
import Select from '@mui/material/Select';
import FormControl from '@mui/material/FormControl';
import InputLabel from '@mui/material/InputLabel';
import Checkbox from '@mui/material/Checkbox';
import MenuItem from '@mui/material/MenuItem';
import FormControlLabel from '@mui/material/FormControlLabel';
import ModelSelect from '@/components/ModelSelect.jsx';
import CwdPicker from '@/components/CwdPicker.jsx';
import ScopeSelect from '@/components/ScopeSelect.jsx';
import CreateDialog, { clearAdornment } from '@/components/CreateDialog.jsx';
import { untildify } from '@/lib/paths.js';
import cronstrue from 'cronstrue';
import { CronExpressionParser } from 'cron-parser';

// Live cron expr validation + human description. Returns { descr, nextIso, ok }.
function describe(expr) {
  if (!expr) return { descr: '', nextIso: null, ok: false };
  try {
    const it = CronExpressionParser.parse(expr, { utc: true, tz: 'UTC' });
    const nextIso = it.next().toISOString();
    let descr;
    try { descr = cronstrue.toString(expr); }
    catch { descr = '(valid, but no plain-English description)'; }
    return { descr, nextIso, ok: true };
  } catch (e) {
    return { descr: e.message, nextIso: null, ok: false };
  }
}

// Add/edit-scheduled-job dialog: title, cron expr (live descr + next-fire),
// description, cwd, model, scopes, permission mode. `job` set → edit mode
// (prefill + POST /crons/:id), else create mode (POST /crons). Mirrors
// CreateBackgroundJobDialog. Wire keys (title/description) match the UI labels.
export default function CreateScheduledJobDialog({ open, onClose, job, cwd, setCwd, recent, onBrowse }) {
  const editing = !!job;
  const [title, setTitle] = useState('');
  const [cronExpr, setCronExpr] = useState('0 * * * *');
  const [description, setDescription] = useState('');
  const [model, setModel] = useState('');
  const [scopes, setScopes] = useState([]);
  const [permissionMode, setPermissionMode] = useState('acceptEdits');
  const [enabled, setEnabled] = useState(true);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  // The dialog never unmounts (renders null while closed) — resync on every
  // open, either from `job` (edit) or back to blank/defaults (create). Fires
  // only on the false→true open transition, so it's a render-time state
  // adjustment (compared against the previous `open`) rather than an effect
  // that would setState on every commit. Callers always close before switching
  // to a different job (see AppShell.jsx), so `job` changing identity while
  // `open` stays true only ever means a fresh server push of the same record.
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) {
      if (job) {
        setTitle(job.title || '');
        setCronExpr(job.cronExpr || '0 * * * *');
        setDescription(job.description || '');
        setModel(job.model === 'claude' ? '' : (job.model || ''));
        setScopes(job.scopes || []);
        setPermissionMode(job.permissionMode || 'acceptEdits');
        setEnabled(job.enabled !== false);
      } else {
        setTitle(''); setCronExpr('0 * * * *'); setDescription(''); setModel(''); setScopes([]); setPermissionMode('acceptEdits'); setEnabled(true);
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

  const desc = useMemo(() => describe(cronExpr.trim()), [cronExpr]);
  const canSubmit = !busy && !!title.trim() && desc.ok && !!description.trim() && !!cwd.trim();

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(editing ? `/crons/${job.id}` : '/crons', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: title.trim(), cronExpr: cronExpr.trim(), description: description.trim(), cwd: untildify(cwd.trim()),
          model: model.trim(), scopes, permissionMode, enabled,
        }),
      });
      const d = await r.json();
      if (!d.ok) { setError(d.error || `${editing ? 'save' : 'create'} failed`); return; }
      onClose();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;
  return (
    <CreateDialog
      open={open}
      onClose={onClose}
      title={editing ? 'Edit scheduled job' : 'New scheduled job'}
      onCancel={onClose}
      onCreate={submit}
      editing={editing}
      createDisabled={!canSubmit}
    >
      <TextField size="small" label="title" value={title} onChange={(e) => setTitle(e.target.value)} slotProps={{ input: { endAdornment: clearAdornment(title !== '', () => setTitle('')) } }} />
      <TextField size="small" label="description" value={description} onChange={(e) => setDescription(e.target.value)} multiline minRows={3} maxRows={10} slotProps={{ input: { endAdornment: clearAdornment(description !== '', () => setDescription('')) } }} />
      <CwdPicker value={cwd} onChange={setCwd} recent={recent} onBrowse={onBrowse} label="working directory" />
      <Stack spacing={0.5}>
        <TextField size="small" label="schedule (cron format, UTC)" placeholder="minute hour day month weekday — e.g. 0 * * * *" value={cronExpr} onChange={(e) => setCronExpr(e.target.value)} spellCheck={false} error={!!cronExpr.trim() && !desc.ok} />
        <Typography variant="caption" sx={{ color: desc.ok ? 'text.secondary' : 'error.main', display: 'block' }} noWrap>
          {desc.ok ? `${desc.descr} · next ${new Date(desc.nextIso).toLocaleString()}` : `Not a valid schedule: ${desc.descr}`}
        </Typography>
      </Stack>
      <ModelSelect model={model} setModel={setModel} />
      <ScopeSelect open={open} value={scopes} onChange={setScopes} />
      <FormControl size="small" fullWidth>
        <InputLabel>permission mode</InputLabel>
        <Select label="permission mode" value={permissionMode} onChange={(e) => setPermissionMode(e.target.value)}>
          <MenuItem value="default">Ask before risky actions (default)</MenuItem>
          <MenuItem value="acceptEdits">Auto-accept file edits</MenuItem>
          <MenuItem value="plan">Plan only, no changes</MenuItem>
          <MenuItem value="bypassPermissions">Full access, no prompts</MenuItem>
        </Select>
      </FormControl>
      <FormControlLabel control={<Checkbox size="small" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />} label="enabled" />
      {error && <Typography variant="body2" color="error">{error}</Typography>}
    </CreateDialog>
  );
}