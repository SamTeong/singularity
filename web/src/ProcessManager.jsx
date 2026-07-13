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

const KIND_PILL = { tracked: 'active', stale: 'error', external: 'review' };
const KIND_HELP = {
  tracked: 'Live agent this daemon owns',
  stale: 'Orphaned — app-spawned but no longer tracked (kill me)',
  external: 'Not app-spawned (your terminal / other tools)',
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
    if (p.kind !== 'stale' && !window.confirm(`Kill ${p.kind} claude.exe (PID ${p.pid})? This ends a live session.`)) return;
    kill(p.pid);
  };

  const stale = (procs || []).filter((p) => p.kind === 'stale');
  const killAllStale = async () => { for (const p of stale) await kill(p.pid); };

  return (
    <Dialog open onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        Claude processes
        <Typography component="span" variant="code" sx={{ color: 'text.secondary', fontSize: 12 }}>
          {procs ? `${procs.length} running` : 'scanning…'}
        </Typography>
        <span style={{ flex: 1 }} />
        <Tooltip title="Rescan"><IconButton size="small" onClick={load}><RefreshIcon fontSize="small" /></IconButton></Tooltip>
      </DialogTitle>
      <DialogContent dividers sx={{ p: 0 }}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>PID</TableCell>
              <TableCell>Started</TableCell>
              <TableCell>Session</TableCell>
              <TableCell>Kind</TableCell>
              <TableCell align="right">Kill</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {(procs || []).map((p) => (
              <TableRow key={p.pid} hover>
                <TableCell><Typography variant="code" sx={{ fontSize: 12 }}>{p.pid}</Typography></TableCell>
                <TableCell><Typography variant="code" sx={{ fontSize: 12 }}>{p.started?.slice(11) || '—'}</Typography></TableCell>
                <TableCell><Typography variant="code" sx={{ fontSize: 12 }}>{p.session ? p.session.slice(0, 8) : '—'}</Typography></TableCell>
                <TableCell>
                  <Tooltip title={KIND_HELP[p.kind]}><span><StatusPill status={KIND_PILL[p.kind]}>{p.kind}</StatusPill></span></Tooltip>
                </TableCell>
                <TableCell align="right">
                  <IconButton size="small" disabled={busy} onClick={() => confirmKill(p)}><CloseIcon fontSize="small" /></IconButton>
                </TableCell>
              </TableRow>
            ))}
            {procs && procs.length === 0 && (
              <TableRow><TableCell colSpan={5}><Typography sx={{ color: 'text.secondary', py: 2, textAlign: 'center' }}>No claude.exe running.</Typography></TableCell></TableRow>
            )}
          </TableBody>
        </Table>
      </DialogContent>
      <DialogActions>
        <Button color="error" disabled={busy || stale.length === 0} onClick={killAllStale}>
          Kill all stale ({stale.length})
        </Button>
        <span style={{ flex: 1 }} />
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}
