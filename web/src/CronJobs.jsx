import React from 'react';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import Switch from '@mui/material/Switch';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import Table from '@mui/material/Table';
import TableHead from '@mui/material/TableHead';
import TableBody from '@mui/material/TableBody';
import TableRow from '@mui/material/TableRow';
import TableCell from '@mui/material/TableCell';
import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlined';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import ScheduleIcon from '@mui/icons-material/Schedule';
import { StatusPill, EmptyState } from '@zapac/mui-theme';

const KIND = { starting: 'active', running: 'active', idle: 'review', detached: 'review', exited: 'error' };
const repoName = (p) => (p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop();

const fmtRel = (ts) => {
  if (!ts) return '—';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return new Date(ts).toLocaleDateString();
};
const fmtNext = (iso) => {
  if (!iso) return '—';
  const s = Math.round((new Date(iso).getTime() - Date.now()) / 1000);
  if (s < 60) return `in ${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `in ${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `in ${h}h`;
  return new Date(iso).toLocaleString();
};

// Cron jobs list. Each row: enable toggle, name, schedule (expr + descr),
// prompt preview, model/repo, last fired + next fire, live-run status, run/delete.
export default function CronJobs({ crons, agents, onAdd, onToast }) {
  const toggle = (id, enabled) =>
    fetch(`/crons/${id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: !enabled }) })
      .then((r) => r.json()).then((d) => { if (!d.ok) onToast?.(d.error); }).catch((e) => onToast?.(e.message));
  const run = (id) =>
    fetch(`/crons/${id}/run`, { method: 'POST' })
      .then((r) => r.json()).then((d) => { if (!d.ok) onToast?.(d.error); }).catch((e) => onToast?.(e.message));
  const remove = (id, name) =>
    fetch(`/crons/${id}`, { method: 'DELETE' })
      .then((r) => r.json()).then((d) => { if (!d.ok) onToast?.(d.error); }).catch((e) => onToast?.(e.message));

  return (
    <Stack sx={{ height: '100%', p: 1.5, pb: 1 }} spacing={1}>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
        <Typography sx={{ fontWeight: 700, fontSize: 15 }}>Cron jobs</Typography>
        <Typography variant="code" sx={{ color: 'text.secondary', fontSize: 11 }}>UTC</Typography>
        <Box sx={{ flex: 1 }} />
        <Button size="small" startIcon={<AddIcon />} onClick={onAdd} sx={{ '& .MuiButton-startIcon': { marginRight: 0.5 } }}>Cron job</Button>
      </Stack>
      {crons.length === 0 ? (
        <Box sx={{ flex: 1, display: 'grid', placeItems: 'center' }}>
          <EmptyState icon={<ScheduleIcon />} title="No cron jobs" description="Add one to run a prompt on a schedule." />
        </Box>
      ) : (
        <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
          <Table size="small" stickyHeader>
            <TableHead>
              <TableRow>
                <TableCell padding="checkbox" />
                <TableCell>Name</TableCell>
                <TableCell>Schedule</TableCell>
                <TableCell>Prompt</TableCell>
                <TableCell>Model</TableCell>
                <TableCell>Repo</TableCell>
                <TableCell>Last fired</TableCell>
                <TableCell>Next</TableCell>
                <TableCell>Status</TableCell>
                <TableCell align="right" />
              </TableRow>
            </TableHead>
            <TableBody>
              {crons.map((j) => {
                const agent = agents.find((a) => a.id === j.lastSessionId);
                return (
                  <TableRow key={j.id}>
                    <TableCell padding="checkbox">
                      <Tooltip title={j.enabled ? 'Disable' : 'Enable'} disableInteractive>
                        <Switch size="small" checked={!!j.enabled} onChange={() => toggle(j.id, j.enabled)} />
                      </Tooltip>
                    </TableCell>
                    <TableCell>
                      <Typography variant="subtitle2" noWrap>{j.name}</Typography>
                    </TableCell>
                    <TableCell>
                      <Typography variant="code" sx={{ fontSize: 11 }} noWrap>{j.cronExpr}</Typography>
                      <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block' }} noWrap>{j.nextFire ? fmtNext(j.nextFire) : (j.enabled ? '—' : 'paused')}</Typography>
                    </TableCell>
                    <TableCell sx={{ maxWidth: 220 }}>
                      <Typography variant="body2" sx={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{j.prompt}</Typography>
                    </TableCell>
                    <TableCell><Typography variant="code" sx={{ fontSize: 11 }} noWrap>{j.model}</Typography></TableCell>
                    <TableCell><Typography variant="code" sx={{ fontSize: 11 }} noWrap>{repoName(j.cwd)}</Typography></TableCell>
                    <TableCell><Typography variant="code" sx={{ fontSize: 11 }} noWrap>{fmtRel(j.lastFiredAt)}</Typography></TableCell>
                    <TableCell><Typography variant="code" sx={{ fontSize: 11 }} noWrap>{j.nextFire ? fmtNext(j.nextFire) : '—'}</Typography></TableCell>
                    <TableCell>{agent ? <StatusPill status={KIND[agent.status] ?? 'review'}>{agent.status}</StatusPill> : <Typography variant="code" sx={{ fontSize: 11, color: 'text.secondary' }}>—</Typography>}</TableCell>
                    <TableCell align="right">
                      <Stack direction="row" className="" sx={{ justifyContent: 'flex-end' }}>
                        <Tooltip title="Run now" disableInteractive>
                          <IconButton size="small" onClick={() => run(j.id)}><PlayArrowIcon fontSize="small" /></IconButton>
                        </Tooltip>
                        <Tooltip title="Delete" disableInteractive>
                          <IconButton size="small" onClick={() => { if (window.confirm(`Delete cron job "${j.name}"?`)) remove(j.id, j.name); }}><DeleteOutlineIcon fontSize="small" /></IconButton>
                        </Tooltip>
                      </Stack>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Box>
      )}
    </Stack>
  );
}