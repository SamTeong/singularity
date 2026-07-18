import React, { useEffect, useState, useMemo } from 'react';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Tabs from '@mui/material/Tabs';
import Tab from '@mui/material/Tab';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import Alert from '@mui/material/Alert';
import FormControlLabel from '@mui/material/FormControlLabel';
import Switch from '@mui/material/Switch';
import SaveIcon from '@mui/icons-material/Save';
import CodeMirror from '@uiw/react-codemirror';
import { json } from '@codemirror/lang-json';
import { EditorView } from '@codemirror/view';
import { useColorMode } from '@zapac/mui-theme';
import { cmTheme } from './cmTheme.js';
import DirPicker from './DirPicker.jsx';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';

const SCOPES = [
  { key: 'project', label: 'project' },
  { key: 'local', label: 'project-local' },
  { key: 'user', label: 'user' },
];

export default function ConfigEditor() {
  const { mode } = useColorMode();
  const [cwd, setCwd] = useState('~');
  const [picking, setPicking] = useState(false);
  const [data, setData] = useState(null);
  const [loadedCwd, setLoadedCwd] = useState(null);
  const [loading, setLoading] = useState(false);
  const [scope, setScope] = useState('project');
  const [content, setContent] = useState('');
  const [dirty, setDirty] = useState(false);
  const [editUser, setEditUser] = useState(false);
  const [msg, setMsg] = useState(null);

  const load = () => {
    if (!cwd) return;
    setLoading(true);
    fetch(`/config?cwd=${encodeURIComponent(cwd)}`).then((r) => r.json()).then((d) => {
      setData(d);
      setLoadedCwd(cwd);
      setContent(d[scope]?.content ?? '');
      setDirty(false); setMsg(null);
    }).catch((e) => setMsg({ sev: 'error', text: String(e) })).finally(() => setLoading(false));
  };
  useEffect(() => { if (dirty && !window.confirm('Discard unsaved changes?')) return; load(); /* eslint-disable-line */ }, [cwd]);
  useEffect(() => { if (data) { setContent(data[scope]?.content ?? ''); setDirty(false); setMsg(null); } }, [scope, data]);

  const jsonError = useMemo(() => {
    if (!content.trim()) return null;
    try { JSON.parse(content); return null; } catch (e) { return e.message; }
  }, [content]);

  const info = data?.[scope];
  // cwd=~ makes project/local resolve to the same shared ~/.claude file as user scope.
  const isUserFile = !!info?.path && info.path === data?.user?.path;
  const readOnly = isUserFile && !editUser;

  const save = async () => {
    const r = await fetch(`/config/${scope}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: loadedCwd, content }),
    }).then((x) => x.json()).catch((e) => ({ ok: false, error: String(e) }));
    if (r.ok) { setMsg({ sev: 'success', text: `Saved${r.backup ? ' (.bak written)' : ''}` }); setDirty(false); load(); }
    else setMsg({ sev: 'error', text: r.error || 'save failed' });
  };

  const pick = (p) => { setCwd(p); setPicking(false); };

  if (loading && !data) return <Box sx={{ p: 3 }}><Typography color="text.secondary">Loading config…</Typography></Box>;

  return (
    <Stack sx={{ height: '100%', p: 2, minHeight: 0 }} spacing={1.5}>
      <Tabs value={scope} onChange={(_, v) => { if (dirty && !window.confirm('Discard unsaved changes?')) return; setScope(v); }} variant="fullWidth">
        {SCOPES.map((s) => <Tab key={s.key} value={s.key} label={s.label} />)}
      </Tabs>

      <Box sx={{ display: 'grid', gridTemplateColumns: '1fr auto', columnGap: 1, alignItems: 'center' }}>
        <Stack direction="row" spacing={1} alignItems="center" sx={{ minWidth: 0 }}>
          <Typography noWrap variant="code" sx={{ alignSelf: 'center', flexShrink: 0, color: 'text.secondary', fontSize: 11 }}>
            {info?.path} {info && !info.exists && '· (does not exist — save creates it)'}
          </Typography>
          {isUserFile && (
            <Alert severity="warning" sx={{ flex: 1, minWidth: 0, py: 0, '& .MuiAlert-action': { alignItems: 'center', paddingRight: 2 } }}
              action={<FormControlLabel sx={{ mr: 0, '& .MuiFormControlLabel-label': { marginLeft: 1.5, lineHeight: 1 } }} control={<Switch size="small" checked={editUser} onChange={(e) => setEditUser(e.target.checked)} />} label="Edit anyway" />}>
              User scope is shared, versioned config{data?.user?.symlink ? ' (a symlink/junction into another repo)' : ''}. Edits mutate it for every project. Read-only by default.
            </Alert>
          )}
        </Stack>
        <Button size="small" startIcon={<FolderOpenIcon />} onClick={() => { if (dirty && !window.confirm('Discard unsaved changes?')) return; setPicking(true); }}>Select root</Button>
      </Box>
      {picking && <DirPicker start={cwd} onPick={pick} onClose={() => setPicking(false)} />}

      <Box sx={(t) => ({ flex: 1, minHeight: 0, overflow: 'auto', border: `1px solid ${t.vars.palette.glass.stroke}`, borderRadius: `${t.zapac.radius.sm}px` })}>
        <CodeMirror
          value={content}
          theme={mode === 'dark' ? 'dark' : 'light'}
          height="100%"
          extensions={[EditorView.lineWrapping, json(), cmTheme]}
          editable={!readOnly}
          onChange={(v) => { setContent(v); setDirty(true); }}
        />
      </Box>

      <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
        {jsonError && <Typography color="error" variant="code" sx={{ fontSize: 12 }}>invalid JSON: {jsonError}</Typography>}
        {msg && !jsonError && <Typography color={msg.sev === 'error' ? 'error' : 'success.main'} sx={{ fontSize: 13 }}>{msg.text}</Typography>}
        <Box sx={{ flex: 1 }} />
        <Button size="small" variant="contained" startIcon={<SaveIcon />} sx={{ px: 2, '& .MuiButton-startIcon': { marginRight: 0.5 } }} onClick={save} disabled={readOnly || !dirty || !!jsonError}>Save</Button>
      </Stack>
    </Stack>
  );
}
