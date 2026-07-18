import React, { useState, useEffect } from 'react';
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
import Chip from '@mui/material/Chip';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import ToggleButton from '@mui/material/ToggleButton';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlined';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import ScheduleIcon from '@mui/icons-material/Schedule';
import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined';
import { StatusPill, EmptyState } from '@zapac/mui-theme';
import CreateBackgroundDialog from './CreateBackgroundDialog.jsx';
import MarkdownBody from './MarkdownBody.jsx';

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
const fmtHM = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

// Automation view: the scheduled cron jobs (top section) plus the background
// quota-soak scheduler (below). Cron rows fire on a cron expr; background defs are
// picked round-robin during a working-hours window when spare quota is available.
export default function CronJobs({ crons, agents, background, recent, onAdd, onToast }) {
  // false (closed) | true (create) | a def object (edit that row)
  const [defOpen, setDefOpen] = useState(false);
  // Background section subview: 'tasks' (defs table, default) | 'reports'.
  const [bgView, setBgView] = useState('tasks');
  const [reports, setReports] = useState([]);
  const [selReport, setSelReport] = useState(null); // taskId
  const [reportContent, setReportContent] = useState(null);
  const [reportLoading, setReportLoading] = useState(false);

  useEffect(() => {
    if (bgView !== 'reports') return;
    fetch('/background/reports').then((r) => r.json()).then((d) => setReports(d.reports || [])).catch(() => onToast?.('Failed to load reports.'));
  }, [bgView]);

  const openReport = (taskId) => {
    setSelReport(taskId);
    setReportContent(null);
    setReportLoading(true);
    fetch(`/background/reports/${taskId}`).then((r) => r.json())
      .then((d) => setReportContent(d.ok ? d.content : null))
      .catch(() => setReportContent(null))
      .finally(() => setReportLoading(false));
  };

  const toggle = (id, enabled) =>
    fetch(`/crons/${id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: !enabled }) })
      .then((r) => r.json()).then((d) => { if (!d.ok) onToast?.(d.error); }).catch((e) => onToast?.(e.message));
  const run = (id) =>
    fetch(`/crons/${id}/run`, { method: 'POST' })
      .then((r) => r.json()).then((d) => { if (!d.ok) onToast?.(d.error); }).catch((e) => onToast?.(e.message));
  const remove = (id) =>
    fetch(`/crons/${id}`, { method: 'DELETE' })
      .then((r) => r.json()).then((d) => { if (!d.ok) onToast?.(d.error); }).catch((e) => onToast?.(e.message));

  const runBg = () =>
    fetch('/background/run', { method: 'POST' })
      .then((r) => r.json()).then((d) => { if (!d.ok) onToast?.(d.reason || d.error); }).catch((e) => onToast?.(e.message));
  const toggleDef = (id, enabled) =>
    fetch(`/background/defs/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: !enabled }) })
      .then((r) => r.json()).then((d) => { if (!d.ok) onToast?.(d.error); }).catch((e) => onToast?.(e.message));
  const removeDef = (id) =>
    fetch(`/background/defs/${id}`, { method: 'DELETE' })
      .then((r) => r.json()).then((d) => { if (!d.ok) onToast?.(d.error); }).catch((e) => onToast?.(e.message));

  const config = background?.config;
  const lastTick = background?.lastTick;

  return (
    <Stack sx={{ height: '100%', p: 1.5, pb: 1 }} spacing={1.5}>
      <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        {/* Scheduled (cron) section */}
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 1 }}>
          <Typography sx={{ fontWeight: 700, fontSize: 15 }}>Scheduled</Typography>
          <Typography variant="code" sx={{ color: 'text.secondary', fontSize: 11 }}>UTC</Typography>
          <Box sx={{ flex: 1 }} />
          <Button size="small" startIcon={<AddIcon />} onClick={onAdd} sx={{ '& .MuiButton-startIcon': { marginRight: 0.5 } }}>Cron job</Button>
        </Stack>
        {crons.length === 0 ? (
          <Box sx={{ py: 3, display: 'grid', placeItems: 'center' }}>
            <EmptyState icon={<ScheduleIcon />} title="No cron jobs" description="Add one to run a prompt on a schedule." />
          </Box>
        ) : (
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
                    <TableCell>
                      <Typography variant="code" sx={{ fontSize: 11 }} noWrap>{fmtRel(j.lastFiredAt)}</Typography>
                      {j.lastError && (
                        <Tooltip title={j.lastError} disableInteractive>
                          <Typography variant="caption" sx={{ color: 'error.main', display: 'block' }} noWrap>{j.lastError}</Typography>
                        </Tooltip>
                      )}
                    </TableCell>
                    <TableCell><Typography variant="code" sx={{ fontSize: 11 }} noWrap>{j.nextFire ? fmtNext(j.nextFire) : '—'}</Typography></TableCell>
                    <TableCell>{agent ? <StatusPill status={KIND[agent.status] ?? 'review'}>{agent.status}</StatusPill> : <Typography variant="code" sx={{ fontSize: 11, color: 'text.secondary' }}>—</Typography>}</TableCell>
                    <TableCell align="right">
                      <Stack direction="row" sx={{ justifyContent: 'flex-end' }}>
                        <Tooltip title="Run now" disableInteractive>
                          <IconButton size="small" onClick={() => run(j.id)}><PlayArrowIcon fontSize="small" /></IconButton>
                        </Tooltip>
                        <Tooltip title="Delete" disableInteractive>
                          <IconButton size="small" onClick={() => { if (window.confirm(`Delete cron job "${j.name}"?`)) remove(j.id); }}><DeleteOutlineIcon fontSize="small" /></IconButton>
                        </Tooltip>
                      </Stack>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}

        {/* Background (quota-soak) section */}
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mt: 3, mb: 1 }}>
          <Typography sx={{ fontWeight: 700, fontSize: 15 }}>Background</Typography>
          <Typography variant="code" sx={{ color: 'text.secondary', fontSize: 11 }}>local time</Typography>
          <Box sx={{ flex: 1 }} />
          <ToggleButtonGroup size="small" exclusive value={bgView} onChange={(_, v) => v && setBgView(v)}>
            <ToggleButton value="tasks" sx={{ px: 1.5, py: 0.25, textTransform: 'none', fontSize: 12 }}>Tasks</ToggleButton>
            <ToggleButton value="reports" sx={{ px: 1.5, py: 0.25, textTransform: 'none', fontSize: 12 }}>Reports</ToggleButton>
          </ToggleButtonGroup>
        </Stack>

        {!config ? (
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>Loading…</Typography>
        ) : bgView === 'reports' ? (
          reports.length === 0 ? (
            <Box sx={{ py: 3, display: 'grid', placeItems: 'center' }}>
              <EmptyState icon={<DescriptionOutlinedIcon />} title="No reports yet" description="Background runs write a Report.md when they finish — it will show up here." />
            </Box>
          ) : (
            <Stack direction="row" sx={{ height: 420, border: (t) => `1px solid ${t.vars.palette.glass.stroke}`, borderRadius: (t) => `${t.zapac.radius.sm}px` }}>
              <List dense sx={(t) => ({ width: 260, flexShrink: 0, borderRight: `1px solid ${t.vars.palette.glass.stroke}`, overflow: 'auto', py: 0 })}>
                {reports.map((r) => (
                  <ListItemButton key={r.taskId} selected={selReport === r.taskId} onClick={() => openReport(r.taskId)} sx={{ display: 'block' }}>
                    <Typography variant="subtitle2" noWrap>{r.title}</Typography>
                    <Stack direction="row" spacing={1} sx={{ mt: 0.25, alignItems: 'center' }}>
                      <Typography variant="code" sx={{ color: 'text.secondary', fontSize: 11 }} noWrap>{fmtRel(r.concludedAt ?? r.createdAt)}</Typography>
                      <Chip size="small" label={r.status} sx={{ height: 18, fontSize: 10 }} />
                    </Stack>
                  </ListItemButton>
                ))}
              </List>
              <Box sx={{ flex: 1, minWidth: 0, overflow: 'auto', p: 2 }}>
                {!selReport ? (
                  <Box sx={{ height: '100%', display: 'grid', placeItems: 'center' }}>
                    <EmptyState icon={<DescriptionOutlinedIcon />} title="Select a report" description="Pick a background run on the left to read its Report.md." />
                  </Box>
                ) : reportLoading ? (
                  <Typography color="text.secondary">Loading…</Typography>
                ) : reportContent == null ? (
                  <Typography color="text.secondary">No Report.md for this run.</Typography>
                ) : (
                  <MarkdownBody>{reportContent}</MarkdownBody>
                )}
              </Box>
            </Stack>
          )
        ) : (
          <Stack spacing={1.5}>
            {/* Last-tick status */}
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
              {lastTick
                ? `${lastTick.action === 'ran' ? 'ran' : 'skipped'} ${fmtHM(lastTick.at)}${lastTick.reason ? ` — ${lastTick.reason}` : ''}`
                : 'no ticks yet'}
            </Typography>

            {/* Defs table */}
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
              <Typography variant="caption" sx={{ color: 'text.secondary' }}>Tasks</Typography>
              <Box sx={{ flex: 1 }} />
              <Button size="small" startIcon={<AddIcon />} onClick={() => setDefOpen(true)} sx={{ '& .MuiButton-startIcon': { marginRight: 0.5 } }}>Add background task</Button>
            </Stack>
            {(config.defs || []).length === 0 ? (
              <Typography variant="body2" sx={{ color: 'text.secondary' }}>No background tasks. Add one to soak spare quota during the window.</Typography>
            ) : (
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell padding="checkbox" />
                    <TableCell>Title</TableCell>
                    <TableCell>Working dir</TableCell>
                    <TableCell>Cooldown</TableCell>
                    <TableCell>Last run</TableCell>
                    <TableCell align="right" />
                  </TableRow>
                </TableHead>
                <TableBody>
                  {config.defs.map((def) => (
                    <TableRow key={def.id} selected={background?.liveTaskId && def.lastTaskId === background.liveTaskId}>
                      <TableCell padding="checkbox">
                        <Tooltip title={def.enabled ? 'Disable' : 'Enable'} disableInteractive>
                          <Switch size="small" checked={!!def.enabled} onChange={() => toggleDef(def.id, def.enabled)} />
                        </Tooltip>
                      </TableCell>
                      <TableCell><Typography variant="subtitle2" noWrap>{def.title}</Typography></TableCell>
                      <TableCell><Typography variant="code" sx={{ fontSize: 11 }} noWrap>{repoName(def.cwd)}</Typography></TableCell>
                      <TableCell><Typography variant="code" sx={{ fontSize: 11 }} noWrap>{def.cooldownHours}h</Typography></TableCell>
                      <TableCell><Typography variant="code" sx={{ fontSize: 11 }} noWrap>{fmtRel(def.lastRunAt)}</Typography></TableCell>
                      <TableCell align="right">
                        <Stack direction="row" sx={{ justifyContent: 'flex-end' }}>
                          <Tooltip title="Run the scheduler now (picks a ready task, not necessarily this one)" disableInteractive>
                            <IconButton size="small" onClick={runBg}><PlayArrowIcon fontSize="small" /></IconButton>
                          </Tooltip>
                          <Tooltip title="Edit" disableInteractive>
                            <IconButton size="small" onClick={() => setDefOpen(def)}><EditOutlinedIcon fontSize="small" /></IconButton>
                          </Tooltip>
                          <Tooltip title="Delete" disableInteractive>
                            <IconButton size="small" onClick={() => { if (window.confirm(`Delete background task "${def.title}"?`)) removeDef(def.id); }}><DeleteOutlineIcon fontSize="small" /></IconButton>
                          </Tooltip>
                        </Stack>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Stack>
        )}
      </Box>

      <CreateBackgroundDialog
        open={!!defOpen}
        def={typeof defOpen === 'object' ? defOpen : null}
        onClose={() => setDefOpen(false)}
        recent={recent}
        onToast={onToast}
      />
    </Stack>
  );
}
