import { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import TextField from '@mui/material/TextField';
import Autocomplete from '@mui/material/Autocomplete';
import FormControlLabel from '@mui/material/FormControlLabel';
import Checkbox from '@mui/material/Checkbox';
import ModelSelect from '@/components/ModelSelect.jsx';
import CwdPicker from '@/components/CwdPicker.jsx';
import ScopeSelect from '@/components/ScopeSelect.jsx';
import CreateDialog, { clearAdornment } from '@/components/CreateDialog.jsx';
import { untildify } from '@/lib/paths.js';
import { isCodexModel, toolForModel } from '@/lib/models.js';

// New-task dialog: CreateSessionDialog minus session id, plus title/description
// (the requirements), plan-approval gate and merge policy. Submits POST /tasks
// (REST, not WS — the create is request/response with a possible error).
export default function CreateTaskDialog({ open, onClose, cwd, setCwd, recent, onBrowse, tagOptions = [] }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [tags, setTags] = useState([]);
  const [model, setModel] = useState('');
  const [implModel, setImplModel] = useState('sonnet');
  const [reviewerModel, setReviewerModel] = useState('opus');
  const [orchTurns, setOrchTurns] = useState('');
  const [implTurns, setImplTurns] = useState('');
  const [revTurns, setRevTurns] = useState('');
  const [claudeSet, setClaudeSet] = useState(null);
  const [scopes, setScopes] = useState([]);
  const [requireApproval, setRequireApproval] = useState(false);
  const [mergeMode, setMergeMode] = useState('manual');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    // Classifier, not a picker: disabled entries are still claude models, so this
    // deliberately does not filter on `enabled`.
    fetch('/api/models').then((r) => r.json())
      .then((d) => setClaudeSet(new Set((d.models || []).filter((m) => m.group === 'claude').map((m) => m.id))))
      .catch(() => {});
  }, [open]);

  // Mirror of server isClaudeModel: empty/'claude'/known alias/claude-* id → claude.
  const isClaude = (m) => !m || (claudeSet ? claudeSet.has(m) : m === 'claude') || m.startsWith('claude-');
  // Pre-fill impl/reviewer from the orchestrator model: claude → sonnet/opus,
  // ollama → mirror it. Re-derives whenever the orchestrator model changes (or
  // claudeSet finishes loading, which can reclassify the same model). Compared
  // against the previous values during render, not an effect, since impl/reviewer
  // stay independently editable afterwards.
  const [prevModel, setPrevModel] = useState(model);
  const [prevClaudeSet, setPrevClaudeSet] = useState(claudeSet);
  if (model !== prevModel || claudeSet !== prevClaudeSet) {
    setPrevModel(model);
    setPrevClaudeSet(claudeSet);
    if (isClaude(model)) { setImplModel('sonnet'); setReviewerModel('opus'); }
    else if (isCodexModel(model)) { /* codex is single-agent — impl/reviewer hidden, leave as-is */ }
    else { setImplModel(model); setReviewerModel(model); }
  }

  const reset = () => {
    setTitle(''); setDescription(''); setTags([]); setScopes([]); setModel('');
    setImplModel('sonnet'); setReviewerModel('opus');
    setOrchTurns(''); setImplTurns(''); setRevTurns('');
    setRequireApproval(false); setMergeMode('manual');
  };

  // Max-turn cap: positive int or undefined (empty/0 → no cap sent).
  const posNum = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : undefined; };

  const create = async () => {
    if (busy || !cwd.trim() || !title.trim() || !description.trim() || !model.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          repo: untildify(cwd.trim()), title: title.trim(), description: description.trim(),
          model: model.trim(), implModel: implModel.trim(), reviewerModel: reviewerModel.trim(),
          orchestratorMaxTurns: posNum(orchTurns), implMaxTurns: posNum(implTurns), reviewerMaxTurns: posNum(revTurns),
          scopes, tags, requirePlanApproval: requireApproval, mergeMode, tool: toolForModel(model.trim()),
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

  return (
    <CreateDialog
      open={open}
      onClose={onClose}
      title="New task"
      onCancel={cancel}
      onCreate={create}
      createDisabled={busy || !cwd.trim() || !title.trim() || !description.trim() || !model.trim()}
    >
      <TextField size="small" label="title" value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') create(); }} slotProps={{ input: { endAdornment: clearAdornment(title !== '', () => setTitle('')) } }} />
      <TextField size="small" label="description" value={description} onChange={(e) => setDescription(e.target.value)} multiline minRows={3} maxRows={10} slotProps={{ input: { endAdornment: clearAdornment(description !== '', () => setDescription('')) } }} />
      <CwdPicker value={cwd} onChange={setCwd} recent={recent} onBrowse={onBrowse} label="Working directory" />
      <Stack spacing={1}>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
          <Box sx={{ flex: 1 }}><ModelSelect model={model} setModel={setModel} label="orchestrator model" placeholder="required — claude, ollama, or gpt-*" /></Box>
          <TextField size="small" type="number" label="turn limit" placeholder="—" value={orchTurns} onChange={(e) => setOrchTurns(e.target.value)} sx={{ width: 110 }} />
        </Stack>
        {!isCodexModel(model) && (
          <>
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
              <Box sx={{ flex: 1 }}><ModelSelect model={implModel} setModel={setImplModel} label="implementor model" /></Box>
              <TextField size="small" type="number" label="turn limit" placeholder="—" value={implTurns} onChange={(e) => setImplTurns(e.target.value)} sx={{ width: 110 }} />
            </Stack>
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
              <Box sx={{ flex: 1 }}><ModelSelect model={reviewerModel} setModel={setReviewerModel} label="reviewer model" /></Box>
              <TextField size="small" type="number" label="turn limit" placeholder="—" value={revTurns} onChange={(e) => setRevTurns(e.target.value)} sx={{ width: 110 }} />
            </Stack>
          </>
        )}
      </Stack>
      <ScopeSelect open={open} value={scopes} onChange={setScopes} />
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
        label="Have the agent draft a plan and wait for your approval before it starts coding"
      />
      <FormControlLabel
        sx={{ mt: -2 }}
        control={<Checkbox size="small" sx={{ py: 0.25 }} checked={mergeMode === 'auto'} onChange={(e) => setMergeMode(e.target.checked ? 'auto' : 'manual')} />}
        label="Automatically merge the changes if everything passes (git projects only)"
      />
      {error && <Typography variant="body2" color="error">{error}</Typography>}
    </CreateDialog>
  );
}