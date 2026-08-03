import { useState } from 'react';
import TextField from '@mui/material/TextField';
import ModelSelect from '@/components/ModelSelect.jsx';
import ToolSelect from '@/components/ToolSelect.jsx';
import CwdPicker from '@/components/CwdPicker.jsx';
import ScopeSelect from '@/components/ScopeSelect.jsx';
import CreateDialog, { clearAdornment } from '@/components/CreateDialog.jsx';
import { untildify } from '@/lib/paths.js';

// New-session dialog: owns the form fields (title/model/scopes/session id); cwd is
// lifted to App (shared with the dir picker + config fallback). Emits `create`
// over the WS via sendMsg, then resets its own fields and closes.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Mirror of server isCodexModel: gpt-* id → codex-only model.
const isCodexModel = (m) => !!m && m.startsWith('gpt-');
export default function CreateSessionDialog({ open, onClose, connected, cwd, setCwd, recent, onBrowse, sendMsg, onSessionCreated, initialSessionId = '', initialModel = '', initialScopes = [], initialTool = 'claude' }) {
  const [title, setTitle] = useState('');
  const [model, setModel] = useState('');
  const [tool, setTool] = useState('claude');
  const [scopes, setScopes] = useState([]);
  const [sessionId, setSessionId] = useState('');
  const sessionIdInvalid = sessionId.trim() !== '' && !UUID_RE.test(sessionId.trim());

  // Prefill the session id + last model + last skill-scopes when opened for a
  // resume (e.g. from the Transcripts view). Fires only on the false→true open
  // transition, so it's a render-time state adjustment (compared against the
  // previous `open`) rather than an effect that would setState on every commit.
  // AppShell always closes this dialog before starting another resume, so
  // `initialSessionId` never changes while `open` stays true.
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open && initialSessionId) {
      setSessionId(initialSessionId);
      if (initialTool) setTool(initialTool);
      if (initialModel) setModel(initialModel);
      if (initialScopes?.length) setScopes(initialScopes);
    }
  }

  const reset = () => { setTitle(''); setScopes([]); setSessionId(''); setModel(''); setTool('claude'); };

  // Flipping the toggle while an incompatible model is selected (e.g. a claude
  // alias, then Tool -> Codex) must not leave that stale model in place —
  // clear it so the mismatch never reaches the server's validateToolModel.
  const changeTool = (t) => {
    setTool(t);
    if (t === 'codex' ? (model && !isCodexModel(model)) : isCodexModel(model)) setModel('');
  };

  const create = () => {
    if (!connected || !cwd.trim()) return;
    sendMsg({ t: 'create', cwd: untildify(cwd.trim()), title: title.trim(), model: model.trim(), scopes, sessionId: sessionId.trim(), tool });
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
      <ModelSelect model={model} setModel={setModel} tool={tool} />
      <ToolSelect tool={tool} setTool={changeTool} />
      <ScopeSelect open={open} value={scopes} onChange={setScopes} />
      <TextField size="small" label="session id (optional — resumes a past session)" value={sessionId} onChange={(e) => setSessionId(e.target.value)} spellCheck={false} error={sessionIdInvalid} helperText={sessionIdInvalid ? 'Not a valid session id' : ''} slotProps={{ input: { endAdornment: clearAdornment(sessionId !== '', () => setSessionId('')) } }} />
    </CreateDialog>
  );
}