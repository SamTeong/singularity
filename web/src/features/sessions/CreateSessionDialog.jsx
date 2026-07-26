import React, { useEffect, useState } from 'react';
import TextField from '@mui/material/TextField';
import ModelSelect from '@/components/ModelSelect.jsx';
import CwdPicker from '@/components/CwdPicker.jsx';
import ScopeSelect from '@/components/ScopeSelect.jsx';
import CreateDialog, { clearAdornment } from '@/components/CreateDialog.jsx';
import { untildify } from '@/lib/paths.js';

// New-session dialog: owns the form fields (title/model/scopes/session id); cwd is
// lifted to App (shared with the dir picker + config fallback). Emits `create`
// over the WS via sendMsg, then resets its own fields and closes.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export default function CreateSessionDialog({ open, onClose, connected, cwd, setCwd, recent, onBrowse, sendMsg, onSessionCreated, initialSessionId = '', initialModel = '', initialScopes = [] }) {
  const [title, setTitle] = useState('');
  const [model, setModel] = useState('');
  const [scopes, setScopes] = useState([]);
  const [sessionId, setSessionId] = useState('');
  const sessionIdInvalid = sessionId.trim() !== '' && !UUID_RE.test(sessionId.trim());

  // Prefill the session id + last model + last skill-scopes when opened for a
  // resume (e.g. from the Transcripts view). Runs only on open + when the
  // caller changes the prefilled id. Model is the transcript's last used;
  // scopes come from the agent registry and may be empty for non-Singularity sessions.
  useEffect(() => {
    if (!open || !initialSessionId) return;
    setSessionId(initialSessionId);
    if (initialModel) setModel(initialModel);
    if (initialScopes?.length) setScopes(initialScopes);
  }, [open, initialSessionId, initialModel, initialScopes]);

  const reset = () => { setTitle(''); setScopes([]); setSessionId(''); setModel(''); };

  const create = () => {
    if (!connected || !cwd.trim()) return;
    sendMsg({ t: 'create', cwd: untildify(cwd.trim()), title: title.trim(), model: model.trim(), scopes, sessionId: sessionId.trim() });
    onSessionCreated?.();
    reset();
    onClose();
  };

  const cancel = () => { reset(); onClose(); };

  return (
    <CreateDialog
      open={open}
      onClose={onClose}
      title="New session"
      onCancel={cancel}
      onCreate={create}
      createLabel={sessionId.trim() ? 'Resume' : 'Create'}
      createDisabled={!connected || !cwd.trim() || sessionIdInvalid}
    >
      <TextField size="small" label="title (optional)" value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') create(); }} slotProps={{ input: { endAdornment: clearAdornment(title !== '', () => setTitle('')) } }} />
      <CwdPicker value={cwd} onChange={setCwd} recent={recent} onBrowse={onBrowse} label="working directory" />
      <ModelSelect model={model} setModel={setModel} />
      <ScopeSelect open={open} value={scopes} onChange={setScopes} />
      <TextField size="small" label="session id (optional — resumes a past session)" value={sessionId} onChange={(e) => setSessionId(e.target.value)} spellCheck={false} error={sessionIdInvalid} helperText={sessionIdInvalid ? 'Not a valid session id' : ''} slotProps={{ input: { endAdornment: clearAdornment(sessionId !== '', () => setSessionId('')) } }} />
    </CreateDialog>
  );
}