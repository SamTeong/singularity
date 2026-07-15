import React, { useEffect, useState } from 'react';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Autocomplete from '@mui/material/Autocomplete';
import Button from '@mui/material/Button';
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

// New-agent dialog: owns the form fields (name/model/scopes/session id); cwd is
// lifted to App (shared with the dir picker + config fallback). Emits `create`
// over the WS via sendMsg, then resets its own fields and closes.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export default function CreateAgentDialog({ open, onClose, connected, cwd, setCwd, recent, onBrowse, sendMsg }) {
  const [name, setName] = useState('');
  const [model, setModel] = useState('');
  const [scopeList, setScopeList] = useState([]);
  const [scopes, setScopes] = useState([]);
  const [sessionId, setSessionId] = useState('');
  const sessionIdInvalid = sessionId.trim() !== '' && !UUID_RE.test(sessionId.trim());

  useEffect(() => {
    if (!open) return;
    fetch('/skill-scopes').then((r) => r.json()).then((d) => setScopeList(d.scopes || [])).catch(() => {});
  }, [open]);

  const reset = () => { setName(''); setScopes([]); setSessionId(''); setModel(''); };

  const create = () => {
    if (!connected || !cwd.trim()) return;
    sendMsg({ t: 'create', cwd: cwd.trim(), name: name.trim(), model: model.trim(), scopes, sessionId: sessionId.trim() });
    reset();
    onClose();
  };

  const cancel = () => { reset(); onClose(); };

  if (!open) return null;
  return (
    <Dialog open onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>New agent</DialogTitle>
      <DialogContent sx={{ pb: 1.5 }}>
        <Stack spacing={1.5} sx={{ pt: 0.5 }}>
          <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
            <Autocomplete
              freeSolo
              fullWidth
              options={recent}
              inputValue={cwd}
              onInputChange={(_, v) => setCwd(v)}
              renderInput={(params) => <TextField {...params} size="small" label="cwd (repo path)" spellCheck={false} />}
            />
            <Tooltip title="Browse…">
              <IconButton onClick={onBrowse}><FolderOpenIcon /></IconButton>
            </Tooltip>
          </Stack>
          <TextField size="small" label="name (optional)" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') create(); }} />
          <ModelSelect model={model} setModel={setModel} />
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
          <TextField size="small" label="session id (optional, resume)" value={sessionId} onChange={(e) => setSessionId(e.target.value)} spellCheck={false} error={sessionIdInvalid} helperText={sessionIdInvalid ? 'must be a UUID' : ''} />
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 2, pb: 2, pt: 0.5 }}>
        <Button size="small" sx={{ px: 2 }} onClick={cancel}>Cancel</Button>
        <Button size="small" sx={{ px: 2, '& .MuiButton-startIcon': { marginRight: 0.5 } }} variant="contained" startIcon={<AddIcon />} onClick={create} disabled={!connected || !cwd.trim() || sessionIdInvalid}>Create</Button>
      </DialogActions>
    </Dialog>
  );
}
