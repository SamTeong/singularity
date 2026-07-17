import React, { useState } from 'react';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import TextField from '@mui/material/TextField';
import Autocomplete from '@mui/material/Autocomplete';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import FormControlLabel from '@mui/material/FormControlLabel';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import AddIcon from '@mui/icons-material/Add';
import ModelSelect from './ModelSelect.jsx';

// Add-background-def dialog: title, description, cwd, cooldownHours, model
// (optional — falls back to the config's per-backend model), enabled. POST
// /background/defs. Mirrors CreateCronDialog's layout.
export default function CreateBackgroundDialog({ open, onClose, recent = [], onToast }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [cwd, setCwd] = useState('');
  const [cooldownHours, setCooldownHours] = useState('24');
  const [model, setModel] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const canCreate = !busy && !!title.trim() && !!description.trim() && !!cwd.trim();

  const reset = () => {
    setTitle(''); setDescription(''); setCwd(''); setCooldownHours('24'); setModel(''); setEnabled(true);
  };

  const create = async () => {
    if (!canCreate) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch('/background/defs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: title.trim(), description: description.trim(), cwd: cwd.trim(),
          cooldownHours: Number(cooldownHours) || 24, model: model.trim() || null, enabled,
        }),
      });
      const d = await r.json();
      if (!d.ok) { setError(d.error || 'create failed'); return; }
      reset();
      onClose();
    } catch (e) {
      setError(e.message);
      onToast?.(e.message);
    } finally {
      setBusy(false);
    }
  };

  const cancel = () => { reset(); onClose(); };

  if (!open) return null;
  return (
    <Dialog open onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>New background task</DialogTitle>
      <DialogContent sx={{ pb: 1.5 }}>
        <Stack spacing={1.5} sx={{ pt: 0.5 }}>
          <TextField size="small" label="title" value={title} onChange={(e) => setTitle(e.target.value)} />
          <TextField size="small" label="description" value={description} onChange={(e) => setDescription(e.target.value)} multiline minRows={3} maxRows={10} />
          <Autocomplete
            freeSolo fullWidth options={recent} inputValue={cwd}
            onInputChange={(_, v) => setCwd(v)}
            renderInput={(params) => <TextField {...params} size="small" label="working directory" spellCheck={false} />}
          />
          <TextField size="small" label="cooldown (hours)" type="number" value={cooldownHours} onChange={(e) => setCooldownHours(e.target.value)} />
          <ModelSelect model={model} setModel={setModel} />
          <FormControlLabel control={<Checkbox size="small" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />} label="enabled" />
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
