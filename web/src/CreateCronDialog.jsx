import React, { useEffect, useMemo, useState } from 'react';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import TextField from '@mui/material/TextField';
import Autocomplete from '@mui/material/Autocomplete';
import Button from '@mui/material/Button';
import Select from '@mui/material/Select';
import FormControl from '@mui/material/FormControl';
import InputLabel from '@mui/material/InputLabel';
import Checkbox from '@mui/material/Checkbox';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import MenuItem from '@mui/material/MenuItem';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import FormControlLabel from '@mui/material/FormControlLabel';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import AddIcon from '@mui/icons-material/Add';
import ModelSelect from './ModelSelect.jsx';
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
    catch { descr = '(partial expr)'; }
    return { descr, nextIso, ok: true };
  } catch (e) {
    return { descr: e.message, nextIso: null, ok: false };
  }
}

// New-cron dialog: name, cron expr (live descr + next-fire), prompt, cwd, model,
// scopes, permission mode. POST /crons. Mirrors CreateTaskDialog layout.
export default function CreateCronDialog({ open, onClose, cwd, setCwd, recent, onBrowse }) {
  const [name, setName] = useState('');
  const [cronExpr, setCronExpr] = useState('0 * * * *');
  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState('');
  const [scopeList, setScopeList] = useState([]);
  const [scopes, setScopes] = useState([]);
  const [permissionMode, setPermissionMode] = useState('acceptEdits');
  const [enabled, setEnabled] = useState(true);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    fetch('/skill-scopes').then((r) => r.json()).then((d) => setScopeList(d.scopes || [])).catch(() => {});
  }, [open]);

  const desc = useMemo(() => describe(cronExpr.trim()), [cronExpr]);
  const canCreate = !busy && !!name.trim() && desc.ok && !!prompt.trim() && !!cwd.trim();

  const reset = () => {
    setName(''); setCronExpr('0 * * * *'); setPrompt(''); setScopes([]); setModel(''); setPermissionMode('acceptEdits'); setEnabled(true);
  };

  const create = async () => {
    if (!canCreate) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch('/crons', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(), cronExpr: cronExpr.trim(), prompt: prompt.trim(), cwd: cwd.trim(),
          model: model.trim(), scopes, permissionMode, enabled,
        }),
      });
      const d = await r.json();
      if (!d.ok) { setError(d.error || 'create failed'); return; }
      reset();
      onClose();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const cancel = () => { reset(); onClose(); };

  if (!open) return null;
  return (
    <Dialog open onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>New cron job</DialogTitle>
      <DialogContent sx={{ pb: 1.5 }}>
        <Stack spacing={1.5} sx={{ pt: 0.5 }}>
          <TextField size="small" label="name" value={name} onChange={(e) => setName(e.target.value)} />
          <Stack spacing={0.5}>
            <TextField size="small" label="cron expr (UTC, 5-field)" value={cronExpr} onChange={(e) => setCronExpr(e.target.value)} spellCheck={false} error={!!cronExpr.trim() && !desc.ok} />
            <Typography variant="caption" sx={{ color: desc.ok ? 'text.secondary' : 'error.main', display: 'block' }} noWrap>
              {desc.ok ? `${desc.descr} · next ${new Date(desc.nextIso).toLocaleString()}` : `invalid: ${desc.descr}`}
            </Typography>
          </Stack>
          <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
            <Autocomplete
              freeSolo fullWidth options={recent} inputValue={cwd}
              onInputChange={(_, v) => setCwd(v)}
              renderInput={(params) => <TextField {...params} size="small" label="agent working dir" spellCheck={false} />}
            />
            <Tooltip title="Browse…"><IconButton onClick={onBrowse}><FolderOpenIcon /></IconButton></Tooltip>
          </Stack>
          <TextField size="small" label="prompt" value={prompt} onChange={(e) => setPrompt(e.target.value)} multiline minRows={3} maxRows={10} />
          <ModelSelect model={model} setModel={setModel} />
          <Autocomplete
            multiple size="small" disableCloseOnSelect options={scopeList} value={scopes}
            onChange={(_, v) => setScopes(v)}
            renderOption={(props, option, { selected }) => (<li {...props}><Checkbox size="small" checked={selected} style={{ marginRight: 8 }} />{option}</li>)}
            renderInput={(params) => <TextField {...params} label="skill-scopes" placeholder="" />}
          />
          <FormControl size="small" fullWidth>
            <InputLabel>permission mode</InputLabel>
            <Select label="permission mode" value={permissionMode} onChange={(e) => setPermissionMode(e.target.value)}>
              <MenuItem value="default">default</MenuItem>
              <MenuItem value="acceptEdits">acceptEdits</MenuItem>
              <MenuItem value="plan">plan</MenuItem>
              <MenuItem value="bypassPermissions">bypassPermissions</MenuItem>
            </Select>
          </FormControl>
          <FormControlLabel control={<Checkbox size="small" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />} label="enabled (start firing immediately)" />
          {error && <Typography variant="body2" color="error">{error}</Typography>}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 2, pb: 2, pt: 0.5 }}>
        <Button size="small" sx={{ px: 2 }} onClick={cancel}>Cancel</Button>
        <Button size="small" sx={{ px: 2, '& .MuiButton-startIcon': { marginRight: 0.5 } }} variant="contained" startIcon={<AddIcon />} onClick={create} disabled={!canCreate}>Create</Button>
      </DialogActions>
    </Dialog>
  );
}