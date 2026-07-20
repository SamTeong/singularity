import React, { useState } from 'react';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import AddIcon from '@mui/icons-material/Add';
import ModelSelect from './ModelSelect.jsx';
import CwdPicker from './CwdPicker.jsx';
import ScopeSelect from './ScopeSelect.jsx';
import { untildify } from './paths.js';

// New-agent dialog: owns the form fields (name/model/scopes/session id); cwd is
// lifted to App (shared with the dir picker + config fallback). Emits `create`
// over the WS via sendMsg, then resets its own fields and closes.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export default function CreateAgentDialog({ open, onClose, connected, cwd, setCwd, recent, onBrowse, sendMsg }) {
  const [name, setName] = useState('');
  const [model, setModel] = useState('');
  const [scopes, setScopes] = useState([]);
  const [sessionId, setSessionId] = useState('');
  const sessionIdInvalid = sessionId.trim() !== '' && !UUID_RE.test(sessionId.trim());

  const reset = () => { setName(''); setScopes([]); setSessionId(''); setModel(''); };

  const create = () => {
    if (!connected || !cwd.trim()) return;
    sendMsg({ t: 'create', cwd: untildify(cwd.trim()), name: name.trim(), model: model.trim(), scopes, sessionId: sessionId.trim() });
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
          <CwdPicker value={cwd} onChange={setCwd} recent={recent} onBrowse={onBrowse} label="working directory" />
          <TextField size="small" label="name (optional)" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') create(); }} />
          <ModelSelect model={model} setModel={setModel} />
          <ScopeSelect open={open} value={scopes} onChange={setScopes} />
          <TextField size="small" label="session id (optional, resume)" value={sessionId} onChange={(e) => setSessionId(e.target.value)} spellCheck={false} error={sessionIdInvalid} helperText={sessionIdInvalid ? 'must be a UUID' : ''} />
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 2, pb: 2, pt: 0.5 }}>
        <Button size="small" variant="secondary" sx={{ px: 2 }} onClick={cancel}>Cancel</Button>
        <Button size="small" sx={{ px: 2, '& .MuiButton-startIcon': { marginRight: 0.5 } }} variant="contained" startIcon={<AddIcon />} onClick={create} disabled={!connected || !cwd.trim() || sessionIdInvalid}>Create</Button>
      </DialogActions>
    </Dialog>
  );
}
