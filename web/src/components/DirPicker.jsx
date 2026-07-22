import React, { useEffect, useState } from 'react';
import Dialog from '@mui/material/Dialog';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Button from '@mui/material/Button';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import Typography from '@mui/material/Typography';
import FolderIcon from '@mui/icons-material/Folder';
import NorthIcon from '@mui/icons-material/North';
import { tildify, untildify } from '@/lib/paths.js';

// Modal folder browser backed by GET /fs/browse. Directories only.
export default function DirPicker({ start, onPick, onClose }) {
  const [path, setPath] = useState(start || '/');
  const [parent, setParent] = useState(null);
  const [dirs, setDirs] = useState([]);
  const [err, setErr] = useState(null);

  const load = (p) => {
    fetch(`/fs/browse?path=${encodeURIComponent(p)}`)
      .then(async (r) => {
        const ct = r.headers.get('content-type') || '';
        if (!ct.includes('application/json')) throw new Error(`daemon unreachable (HTTP ${r.status})`);
        return r.json();
      })
      .then((d) => {
        if (d.error) { setErr(d.error); return; }
        setErr(null); setPath(d.path); setParent(d.parent); setDirs(d.dirs);
      })
      .catch((e) => setErr(String(e)));
  };
  // '/' is a real FS root on both POSIX and Windows (current drive root). The
  // /fs/browse handler doesn't untildify, so '~' can't be the fallback here.
  useEffect(() => { load(start || '/'); }, []);

  const sep = path.includes('/') && !path.includes('\\') ? '/' : '\\';
  const child = (name) => (path.endsWith(sep) ? path + name : path + sep + name);

  return (
    <Dialog open onClose={onClose} maxWidth="sm" fullWidth>
      <Stack direction="row" spacing={1} sx={{ p: 2, pb: 1, alignItems: 'center' }}>
        <TextField fullWidth size="small" value={tildify(path)} spellCheck={false}
          onChange={(e) => setPath(untildify(e.target.value))} onKeyDown={(e) => e.key === 'Enter' && load(path)} />
        <Button size="small" variant="outlined" onClick={() => load(path)}>Go</Button>
      </Stack>
      {err && <Typography color="error" sx={{ px: 2, pb: 1, fontSize: 13 }}>{err}</Typography>}
      <DialogContent dividers sx={{ p: 0, maxHeight: '50vh' }}>
        <List dense disablePadding>
          {parent && (
            <ListItemButton onClick={() => load(parent)}>
              <ListItemIcon sx={{ minWidth: 34 }}><NorthIcon fontSize="small" /></ListItemIcon>
              <ListItemText primary=".." />
            </ListItemButton>
          )}
          {dirs.map((d) => (
            <ListItemButton key={d} onClick={() => load(child(d))}>
              <ListItemIcon sx={{ minWidth: 34 }}><FolderIcon fontSize="small" /></ListItemIcon>
              <ListItemText primary={d} />
            </ListItemButton>
          ))}
          {dirs.length === 0 && !parent && (
            <Typography sx={{ p: 2, color: 'text.secondary', fontSize: 13 }}>(no subfolders)</Typography>
          )}
        </List>
      </DialogContent>
      <DialogActions sx={{ px: 2, pb: 2, pt: 2 }}>
        <Button size="small" variant="secondary" sx={{ px: 2 }} onClick={onClose}>Cancel</Button>
        <Button size="small" sx={{ px: 2 }} variant="contained" onClick={() => onPick(path)}>Use this folder</Button>
      </DialogActions>
    </Dialog>
  );
}
