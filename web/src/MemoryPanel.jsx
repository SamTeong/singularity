import React, { useEffect, useState, useCallback } from 'react';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import InputAdornment from '@mui/material/InputAdornment';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import SearchIcon from '@mui/icons-material/Search';
import SaveIcon from '@mui/icons-material/Save';
import CodeMirror from '@uiw/react-codemirror';
import { markdown } from '@codemirror/lang-markdown';
import { StatusPill, useColorMode } from '@zapac/mui-theme';

export default function MemoryPanel() {
  const { mode } = useColorMode();
  const [q, setQ] = useState('');
  const [results, setResults] = useState(null); // search hits
  const [files, setFiles] = useState([]); // all memory files (browse)
  const [capped, setCapped] = useState(false);
  const [sel, setSel] = useState(null); // {path, project, file}
  const [content, setContent] = useState('');
  const [dirty, setDirty] = useState(false);
  const [msg, setMsg] = useState(null);

  useEffect(() => { fetch('/memory/files').then((r) => r.json()).then((d) => setFiles(d.files || [])); }, []);

  const search = useCallback(() => {
    if (!q.trim()) { setResults(null); return; }
    fetch(`/memory/search?q=${encodeURIComponent(q.trim())}`).then((r) => r.json()).then((d) => {
      setResults(d.results || []); setCapped(!!d.capped);
    });
  }, [q]);

  const open = (item) => {
    setSel(item); setMsg(null);
    fetch(`/memory/file?path=${encodeURIComponent(item.path)}`).then((r) => r.json()).then((d) => {
      setContent(d.ok ? d.content : ''); setDirty(false);
      if (!d.ok) setMsg({ sev: 'error', text: d.error });
    });
  };

  const save = async () => {
    const r = await fetch('/memory/file', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: sel.path, content }),
    }).then((x) => x.json()).catch((e) => ({ ok: false, error: String(e) }));
    setMsg(r.ok ? { sev: 'success', text: 'Saved' } : { sev: 'error', text: r.error });
    if (r.ok) setDirty(false);
  };

  const showing = results ?? files;

  return (
    <Box sx={{ height: '100%', display: 'flex', minHeight: 0 }}>
      {/* left: search + list */}
      <Stack sx={(t) => ({ width: 340, flexShrink: 0, borderRight: `1px solid ${t.vars.palette.glass.stroke}`, minHeight: 0 })}>
        <Box sx={{ p: 1.5 }}>
          <TextField
            fullWidth size="small" placeholder="Search all memory…"
            value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && search()}
            InputProps={{ startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment> }}
          />
          <Typography variant="code" sx={{ color: 'text.secondary', fontSize: 11, mt: 0.5, display: 'block' }}>
            {results ? `${results.length}${capped ? '+ (capped)' : ''} matches` : `${files.length} files`}
          </Typography>
        </Box>
        <List dense sx={{ flex: 1, overflow: 'auto', px: 0.5 }}>
          {showing.map((it, i) => (
            <ListItemButton key={`${it.path}:${it.line ?? i}`} selected={sel?.path === it.path && !results} onClick={() => open(it)}
              sx={{ borderRadius: (t) => `${t.zapac.radius.sm}px`, display: 'block', mb: 0.25 }}>
              <Stack direction="row" spacing={1} alignItems="center">
                <StatusPill status="review">{it.project}</StatusPill>
                <Typography variant="code" sx={{ fontSize: 11 }} noWrap>{it.file}{it.line ? `:${it.line}` : ''}</Typography>
              </Stack>
              {it.text && <Typography sx={{ fontSize: 12, color: 'text.secondary', mt: 0.5 }} noWrap>{it.text}</Typography>}
            </ListItemButton>
          ))}
          {showing.length === 0 && <Typography sx={{ p: 2, color: 'text.secondary', fontSize: 13 }}>{results ? 'No matches.' : 'No memory files.'}</Typography>}
        </List>
      </Stack>

      {/* right: editor */}
      <Stack sx={{ flex: 1, minWidth: 0, minHeight: 0, p: 1.5 }} spacing={1}>
        {!sel ? (
          <Box sx={{ flex: 1, display: 'grid', placeItems: 'center' }}>
            <Typography color="text.secondary">Select a file to view or edit.</Typography>
          </Box>
        ) : (
          <>
            <Typography variant="code" sx={{ color: 'text.secondary', fontSize: 11 }}>{sel.path}</Typography>
            <Box sx={(t) => ({ flex: 1, minHeight: 0, overflow: 'auto', border: `1px solid ${t.vars.palette.glass.stroke}`, borderRadius: `${t.zapac.radius.sm}px` })}>
              <CodeMirror value={content} theme={mode === 'dark' ? 'dark' : 'light'} height="100%"
                extensions={[markdown()]} onChange={(v) => { setContent(v); setDirty(true); }} />
            </Box>
            <Stack direction="row" spacing={1.5} alignItems="center">
              <Button variant="contained" startIcon={<SaveIcon />} onClick={save} disabled={!dirty}>Save</Button>
              {msg && <Typography color={msg.sev === 'error' ? 'error' : 'success.main'} sx={{ fontSize: 13 }}>{msg.text}</Typography>}
            </Stack>
          </>
        )}
      </Stack>
    </Box>
  );
}
