import React, { useEffect, useState } from 'react';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import TextField from '@mui/material/TextField';
import Autocomplete from '@mui/material/Autocomplete';
import Button from '@mui/material/Button';
import FormControlLabel from '@mui/material/FormControlLabel';
import Checkbox from '@mui/material/Checkbox';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import AddIcon from '@mui/icons-material/Add';
import ModelSelect from './ModelSelect.jsx';

// New-task dialog: CreateAgentDialog minus session id, plus title/description
// (the requirements), plan-approval gate and merge policy. Submits POST /tasks
// (REST, not WS — the create is request/response with a possible error).
export default function CreateTaskDialog({ open, onClose, cwd, setCwd, recent, onBrowse, tagOptions = [] }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [tags, setTags] = useState([]);
  const [model, setModel] = useState('');
  const [implModel, setImplModel] = useState('sonnet');
  const [reviewerModel, setReviewerModel] = useState('opus');
  const [claudeSet, setClaudeSet] = useState(null);
  const [scopeList, setScopeList] = useState([]);
  const [scopes, setScopes] = useState([]);
  const [requireApproval, setRequireApproval] = useState(false);
  const [mergeMode, setMergeMode] = useState('manual');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    fetch('/skill-scopes').then((r) => r.json()).then((d) => setScopeList(d.scopes || [])).catch(() => {});
    fetch('/models').then((r) => r.json()).then((d) => setClaudeSet(new Set(d.claude || []))).catch(() => {});
  }, [open]);

  // Mirror of server isClaudeModel: empty/'claude'/known alias/claude-* id → claude.
  const isClaude = (m) => !m || (claudeSet ? claudeSet.has(m) : m === 'claude') || m.startsWith('claude-');
  // Pre-fill impl/reviewer from the orchestrator model: claude → sonnet/opus,
  // ollama → mirror it. Re-derives whenever the orchestrator model changes.
  useEffect(() => {
    if (isClaude(model)) { setImplModel('sonnet'); setReviewerModel('opus'); }
    else { setImplModel(model); setReviewerModel(model); }
  }, [model, claudeSet]);

  const reset = () => {
    setTitle(''); setDescription(''); setTags([]); setScopes([]); setModel('');
    setImplModel('sonnet'); setReviewerModel('opus');
    setRequireApproval(false); setMergeMode('manual');
  };

  const create = async () => {
    if (busy || !cwd.trim() || !title.trim() || !description.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch('/tasks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          repo: cwd.trim(), title: title.trim(), description: description.trim(),
          model: model.trim(), implModel: implModel.trim(), reviewerModel: reviewerModel.trim(),
          scopes, tags, requirePlanApproval: requireApproval, mergeMode,
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
      <DialogTitle>New task</DialogTitle>
      <DialogContent sx={{ pb: 1.5 }}>
        <Stack spacing={1.5} sx={{ pt: 0.5 }}>
          <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
            <Autocomplete
              freeSolo
              fullWidth
              options={recent}
              inputValue={cwd}
              onInputChange={(_, v) => setCwd(v)}
              renderInput={(params) => <TextField {...params} size="small" label="working directory" spellCheck={false} />}
            />
            <Tooltip title="Browse…">
              <IconButton onClick={onBrowse}><FolderOpenIcon /></IconButton>
            </Tooltip>
          </Stack>
          <TextField size="small" label="title" value={title} onChange={(e) => setTitle(e.target.value)} />
          <TextField size="small" label="requirements" value={description} onChange={(e) => setDescription(e.target.value)} multiline minRows={3} maxRows={10} />
          <ModelSelect model={model} setModel={setModel} />
          <Stack direction="row" spacing={1}>
            <ModelSelect model={implModel} setModel={setImplModel} label="implementor model" placeholder="" />
            <ModelSelect model={reviewerModel} setModel={setReviewerModel} label="reviewer model" placeholder="" />
          </Stack>
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
          <Autocomplete
            multiple
            freeSolo
            size="small"
            options={tagOptions}
            value={tags}
            onChange={(_, v) => setTags(v)}
            renderInput={(params) => <TextField {...params} label="tags (optional)" placeholder="" />}
          />
          <FormControlLabel
            control={<Checkbox size="small" sx={{ py: 0.25 }} checked={requireApproval} onChange={(e) => setRequireApproval(e.target.checked)} />}
            label="require plan approval"
          />
          <FormControlLabel
            sx={{ mt: -2 }}
            control={<Checkbox size="small" sx={{ py: 0.25 }} checked={mergeMode === 'auto'} onChange={(e) => setMergeMode(e.target.checked ? 'auto' : 'manual')} />}
            label="auto-merge on pass (git repos only)"
          />
          {error && <Typography variant="body2" color="error">{error}</Typography>}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 2, pb: 2, pt: 0.5 }}>
        <Button size="small" sx={{ px: 2 }} onClick={cancel}>Cancel</Button>
        <Button size="small" sx={{ px: 2, '& .MuiButton-startIcon': { marginRight: 0.5 } }} variant="contained" startIcon={<AddIcon />} onClick={create} disabled={busy || !cwd.trim() || !title.trim() || !description.trim()}>Create</Button>
      </DialogActions>
    </Dialog>
  );
}
