import React, { useMemo, useState } from 'react';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import TextField from '@mui/material/TextField';
import Button from '@mui/material/Button';
import Select from '@mui/material/Select';
import FormControl from '@mui/material/FormControl';
import InputLabel from '@mui/material/InputLabel';
import Checkbox from '@mui/material/Checkbox';
import MenuItem from '@mui/material/MenuItem';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import FormControlLabel from '@mui/material/FormControlLabel';
import AddIcon from '@mui/icons-material/Add';
import ModelSelect from '@/components/ModelSelect.jsx';
import CwdPicker from '@/components/CwdPicker.jsx';
import ScopeSelect from '@/components/ScopeSelect.jsx';
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

// New-cron dialog: name, cron expr (live descr + next-fire), prompt, cwd, model,
// scopes, permission mode. POST /crons. Mirrors CreateTaskDialog layout.
export default function CreateCronDialog({ open, onClose, cwd, setCwd, recent, onBrowse }) {
  const [name, setName] = useState('');
  const [cronExpr, setCronExpr] = useState('0 * * * *');
  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState('');
  const [scopes, setScopes] = useState([]);
  const [permissionMode, setPermissionMode] = useState('acceptEdits');
  const [enabled, setEnabled] = useState(true);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

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
          name: name.trim(), cronExpr: cronExpr.trim(), prompt: prompt.trim(), cwd: untildify(cwd.trim()),
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
      <DialogTitle>New scheduled job</DialogTitle>
      <DialogContent sx={{ pb: 1.5 }}>
        <Stack spacing={1.5} sx={{ pt: 0.5 }}>
          <TextField size="small" label="name" value={name} onChange={(e) => setName(e.target.value)} />
          <Stack spacing={0.5}>
            <TextField size="small" label="schedule (cron format, UTC)" placeholder="minute hour day month weekday — e.g. 0 * * * *" value={cronExpr} onChange={(e) => setCronExpr(e.target.value)} spellCheck={false} error={!!cronExpr.trim() && !desc.ok} />
            <Typography variant="caption" sx={{ color: desc.ok ? 'text.secondary' : 'error.main', display: 'block' }} noWrap>
              {desc.ok ? `${desc.descr} · next ${new Date(desc.nextIso).toLocaleString()}` : `Not a valid schedule: ${desc.descr}`}
            </Typography>
          </Stack>
          <CwdPicker value={cwd} onChange={setCwd} recent={recent} onBrowse={onBrowse} label="agent working dir" />
          <TextField size="small" label="prompt" value={prompt} onChange={(e) => setPrompt(e.target.value)} multiline minRows={3} maxRows={10} />
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
          <FormControlLabel control={<Checkbox size="small" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />} label="enabled (starts running on schedule right away)" />
          {error && <Typography variant="body2" color="error">{error}</Typography>}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 2, pb: 2, pt: 0.5 }}>
        <Button size="small" variant="secondary" sx={{ px: 2 }} onClick={cancel}>Cancel</Button>
        <Button size="small" sx={{ px: 2, '& .MuiButton-startIcon': { marginRight: 0.5 } }} variant="contained" startIcon={<AddIcon />} onClick={create} disabled={!canCreate}>Create</Button>
      </DialogActions>
    </Dialog>
  );
}