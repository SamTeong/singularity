import React, { useEffect, useState } from 'react';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import TextField from '@mui/material/TextField';
import Autocomplete from '@mui/material/Autocomplete';
import Button from '@mui/material/Button';
import Select from '@mui/material/Select';
import FormControl from '@mui/material/FormControl';
import FormControlLabel from '@mui/material/FormControlLabel';
import InputLabel from '@mui/material/InputLabel';
import Checkbox from '@mui/material/Checkbox';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import MenuItem from '@mui/material/MenuItem';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import AddIcon from '@mui/icons-material/Add';

// New-task dialog: CreateAgentDialog minus session id, plus title/description
// (the requirements), plan-approval gate and merge policy. Submits POST /tasks
// (REST, not WS — the create is request/response with a possible error).
export default function CreateTaskDialog({ open, onClose, cwd, setCwd, recent, onBrowse }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [model, setModel] = useState('claude');
  const [ollamaModel, setOllamaModel] = useState('');
  const [scopeList, setScopeList] = useState([]);
  const [scopes, setScopes] = useState([]);
  const [requireApproval, setRequireApproval] = useState(false);
  const [mergeMode, setMergeMode] = useState('manual');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    fetch('/skill-scopes').then((r) => r.json()).then((d) => setScopeList(d.scopes || [])).catch(() => {});
  }, [open]);

  const create = async () => {
    if (busy || !cwd.trim() || !title.trim() || !description.trim()) return;
    const resolvedModel = model === '__ollama' ? ollamaModel.trim() : model;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch('/tasks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          repo: cwd.trim(), title: title.trim(), description: description.trim(),
          model: resolvedModel, scopes, requirePlanApproval: requireApproval, mergeMode,
        }),
      });
      const d = await r.json();
      if (!d.ok) { setError(d.error || 'create failed'); return; }
      setTitle(''); setDescription(''); setScopes([]); setOllamaModel(''); setModel('claude');
      setRequireApproval(false); setMergeMode('manual');
      onClose();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;
  return (
    <Dialog open onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>New task</DialogTitle>
      <DialogContent sx={{ pb: 1.5 }}>
        <Stack spacing={1.5} sx={{ pt: 0.5 }}>
          <Stack direction="row" spacing={0.5} alignItems="center">
            <Autocomplete
              freeSolo
              fullWidth
              options={recent}
              inputValue={cwd}
              onInputChange={(_, v) => setCwd(v)}
              renderInput={(params) => <TextField {...params} size="small" label="repo path (git)" spellCheck={false} />}
            />
            <Tooltip title="Browse…">
              <IconButton onClick={onBrowse}><FolderOpenIcon /></IconButton>
            </Tooltip>
          </Stack>
          <TextField size="small" label="title" value={title} onChange={(e) => setTitle(e.target.value)} />
          <TextField size="small" label="requirements" value={description} onChange={(e) => setDescription(e.target.value)} multiline minRows={3} maxRows={10} />
          <FormControl size="small" fullWidth>
            <InputLabel>model</InputLabel>
            <Select label="model" value={model} onChange={(e) => setModel(e.target.value)}>
              <MenuItem value="claude">claude</MenuItem>
              <MenuItem value="glm-5.2:cloud">glm-5.2:cloud</MenuItem>
              <MenuItem value="kimi-k2.7-code:cloud">kimi-k2.7-code:cloud</MenuItem>
              <MenuItem value="__ollama">other ollama…</MenuItem>
            </Select>
          </FormControl>
          {model === '__ollama' && (
            <TextField size="small" label="ollama model name" value={ollamaModel} onChange={(e) => setOllamaModel(e.target.value)} spellCheck={false} />
          )}
          <Autocomplete
            multiple
            size="small"
            disableCloseOnSelect
            options={scopeList}
            value={scopes}
            onChange={(_, v) => setScopes(v)}
            renderOption={(props, option, { selected }) => (
              <li {...props}><Checkbox size="small" checked={selected} style={{ marginRight: 8 }} />{option}</li>
            )}
            renderInput={(params) => <TextField {...params} label="skill-scopes" placeholder="" />}
          />
          <FormControlLabel
            control={<Checkbox size="small" sx={{ py: 0.25 }} checked={requireApproval} onChange={(e) => setRequireApproval(e.target.checked)} />}
            label="require plan approval before work starts"
          />
          <FormControlLabel
            sx={{ mt: -2 }}
            control={<Checkbox size="small" sx={{ py: 0.25 }} checked={mergeMode === 'auto'} onChange={(e) => setMergeMode(e.target.checked ? 'auto' : 'manual')} />}
            label="auto-merge on pass"
          />
          {error && <Typography variant="body2" color="error">{error}</Typography>}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 2, pb: 2, pt: 0.5 }}>
        <Button size="small" sx={{ px: 2 }} onClick={onClose}>Cancel</Button>
        <Button size="small" sx={{ px: 2, '& .MuiButton-startIcon': { marginRight: 0.5 } }} variant="contained" startIcon={<AddIcon />} onClick={create} disabled={busy || !cwd.trim() || !title.trim() || !description.trim() || (model === '__ollama' && !ollamaModel.trim())}>Create</Button>
      </DialogActions>
    </Dialog>
  );
}
