import React, { useEffect, useState, useCallback } from 'react';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Stack from '@mui/material/Stack';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';
import RefreshIcon from '@mui/icons-material/Refresh';
import CloseIcon from '@mui/icons-material/Close';
import { StatusPill } from '@zapac/mui-theme';

const KIND_PILL = { tracked: 'active', daemon: 'active', stale: 'error', external: 'review' };
const KIND_HELP = {
  tracked: 'A live session this app is running',
  daemon: 'Part of this running app (its server + build tooling) — cannot be stopped here',
  stale: 'Leftover from this app — no longer tracked, safe to stop',
  external: 'Not started by this app (your terminal or another tool)',
};

export default function ProcessManager({ onClose }) {
  const [procs, setProcs] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    fetch('/procs').then((r) => r.json()).then((d) => setProcs(d.procs || [])).catch(() => setProcs([]));
  }, []);
  useEffect(() => { load(); }, [load]);

  const kill = async (pid) => {
    setBusy(true);
    await fetch('/procs/kill', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pid }) }).catch(() => {});
    setBusy(false);
    load();
  };

  const confirmKill = (p) => {
    if (p.kind === 'daemon') return; // protected — button is disabled anyway
    const warn = p.session ? ' This ends a live session.' : '';
    if (p.kind !== 'stale' && !window.confirm(`Stop ${p.kind} ${p.name} (PID ${p.pid})?${warn}`)) return;
    kill(p.pid);
  };

  const stale = (procs || []).filter((p) => p.kind === 'stale');
  const killAllStale = async () => { for (const p of stale) await kill(p.pid); };

  return (
    <Dialog open onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Stack direction="row" sx={{ alignItems: 'center', gap: 1, lineHeight: '24px' }}>
          Running Processes
          <Typography component="span" variant="code" sx={{ color: 'text.secondary', fontSize: 12, lineHeight: 'inherit' }}>
            {procs ? `${procs.length} running` : 'checking…'}
          </Typography>
        </Stack>
        <span style={{ flex: 1 }} />
        <Tooltip title="Refresh list"><IconButton size="small" onClick={load}><RefreshIcon fontSize="small" /></IconButton></Tooltip>
      </DialogTitle>
      <DialogContent dividers sx={{ p: 0 }}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Process ID</TableCell>
              <TableCell>Name</TableCell>
              <TableCell>Started</TableCell>
              <TableCell>Session</TableCell>
              <TableCell>Type</TableCell>
              <TableCell align="right">Stop</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {(procs || []).map((p) => (
              <TableRow key={p.pid} hover>
                <TableCell><Typography variant="code" sx={{ fontSize: 12 }}>{p.pid}</Typography></TableCell>
                <TableCell><Typography variant="code" sx={{ fontSize: 12 }}>{p.name}</Typography></TableCell>
                <TableCell><Typography variant="code" sx={{ fontSize: 12 }}>{p.started?.slice(11) || '—'}</Typography></TableCell>
                <TableCell><Typography variant="code" sx={{ fontSize: 12 }}>{p.session ? p.session.slice(0, 8) : '—'}</Typography></TableCell>
                <TableCell>
                  <Tooltip title={KIND_HELP[p.kind]}><span><StatusPill status={KIND_PILL[p.kind]}>{p.kind}</StatusPill></span></Tooltip>
                </TableCell>
                <TableCell align="right">
                  <IconButton size="small" disabled={busy || p.kind === 'daemon'} onClick={() => confirmKill(p)}><CloseIcon fontSize="small" /></IconButton>
                </TableCell>
              </TableRow>
            ))}
            {procs && procs.length === 0 && (
              <TableRow><TableCell colSpan={6}><Typography sx={{ color: 'text.secondary', py: 2, textAlign: 'center' }}>No processes running.</Typography></TableCell></TableRow>
            )}
          </TableBody>
        </Table>
      </DialogContent>
      <DialogActions sx={{ px: 2, pb: 2, pt: 2 }}>
        <Button size="small" color="error" sx={{ px: 2 }} disabled={busy || stale.length === 0} onClick={killAllStale}>
          Stop all leftover ({stale.length})
        </Button>
        <span style={{ flex: 1 }} />
        <Button size="small" variant="secondary" sx={{ px: 2 }} onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}
