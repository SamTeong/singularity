import { getTokens } from '@/theme/contract.js';
import { useState, useEffect, useCallback } from 'react';
import DragIndicatorIcon from '@mui/icons-material/DragIndicator';
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
import TableSortLabel from '@mui/material/TableSortLabel';
import Chip from '@mui/material/Chip';
import Badge from '@mui/material/Badge';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlined';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import ScheduleIcon from '@mui/icons-material/Schedule';
import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import HistoryIcon from '@mui/icons-material/History';
import ViewKanbanOutlinedIcon from '@mui/icons-material/ViewKanbanOutlined';
import FlagIcon from '@mui/icons-material/Flag';
import FlagOutlinedIcon from '@mui/icons-material/FlagOutlined';
import { StatusPill } from '@/components/StatusPill.jsx';
import { EmptyState } from '@/components/EmptyState.jsx';
import CreateBackgroundJobDialog from '@/features/automation/CreateBackgroundJobDialog.jsx';
import MarkdownBody from '@/components/MarkdownBody.jsx';
import { useResizable, ResizeHandle } from '@/hooks/useResizable.jsx';
import { repoName } from '@/lib/paths.js';
import { relTime } from '@/lib/format.js';
import { KIND } from '@/lib/agentStatus.js';

// "—" for no timestamp yet (never fired/run), else the shared relTime.
const fmtRel = (ts) => (ts ? relTime(ts) : '—');
const fmtNext = (iso) => {
  if (!iso) return '—';
  const s = Math.round((new Date(iso).getTime() - Date.now()) / 1000);
  // A pushed snapshot can lag the boundary by a tick; never render "in -80s".
  if (s <= 0) return 'due';
  if (s < 60) return `in ${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `in ${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `in ${h}h`;
  return new Date(iso).toLocaleString();
};
const fmtHM = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const fmtWait = (nextDueAt) => `First check in about ${Math.max(0, Math.ceil((nextDueAt - Date.now()) / 60000))} minutes`;

// Automation view: the scheduled cron jobs (top section) plus the background
// quota-soak scheduler (below). Cron rows fire on a cron expr; background jobs are
// picked round-robin during a working-hours window when spare quota is available.
export default function CronJobs({ crons, agents, background, recent, cwd, setCwd, onBrowse, onAdd, onEdit, onToast }) {
  // false (closed) | true (create) | a job object (edit that row)
  const [jobOpen, setJobOpen] = useState(false);
  // Background section subview: 'tasks' (jobs table, default) | 'reports'.
  const [bgView, setBgView] = useState('tasks');
  const [reports, setReports] = useState([]);
  const [selReport, setSelReport] = useState(null); // taskId
  const [reportContent, setReportContent] = useState(null);
  const [reportLoading, setReportLoading] = useState(false);
  const railW = useResizable('sing-cron-w', 260);

  // Fetch on mount + on every bgView change so the unread badge shows even from
  // the Jobs view, and the list refreshes when re-entering Reports.
  const loadReports = useCallback(() =>
    fetch('/api/background/reports').then((r) => r.json()).then((d) => setReports(d.reports || [])).catch(() => onToast?.('Failed to load reports.')),
  [onToast]);
  useEffect(() => { loadReports(); }, [bgView, loadReports]);
  const flaggedReports = reports.filter((r) => r.flagged).length;

  // Shared fetch+toast: parses JSON, toasts `d.error || d.reason` on a non-ok
  // response (runBg legitimately returns `reason`; the rest return `error`),
  // and toasts the network error on a reject. Returns the parsed body so a
  // caller can branch on `d.ok` (e.g. setFlag reloads reports on success).
  const api = useCallback((url, opts) =>
    fetch(url, opts).then((r) => r.json())
      .then((d) => { if (!d.ok) onToast?.(d.error || d.reason); return d; })
      .catch((e) => { onToast?.(e.message); return { ok: false }; }), [onToast]);

  const setFlag = (taskId, flagged) =>
    api(`/api/background/reports/${taskId}/flag`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ flagged }) })
      .then((d) => { if (d.ok) loadReports(); });

  const openReport = (taskId) => {
    setSelReport(taskId);
    setReportContent(null);
    setReportLoading(true);
    fetch(`/api/background/reports/${taskId}`).then((r) => r.json())
      .then((d) => setReportContent(d.ok ? d.content : null))
      .catch(() => setReportContent(null))
      .finally(() => setReportLoading(false));
  };

  const toggle = (id, enabled) =>
    api(`/api/crons/${id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: !enabled }) });
  const run = (id) =>
    api(`/api/crons/${id}/run`, { method: 'POST' });
  const remove = (id) =>
    api(`/api/crons/${id}`, { method: 'DELETE' });

  const runBg = () =>
    api('/api/background/run', { method: 'POST' });
  const toggleJob = (id, enabled) =>
    api(`/api/background/jobs/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: !enabled }) });
  const removeJob = (id) =>
    api(`/api/background/jobs/${id}`, { method: 'DELETE' });
  const saveOrder = (ids) =>
    api('/api/background/reorder', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids }) });

  const config = background?.config;
  const lastTick = background?.lastTick;

  const bgToggle = (
    <Badge color="primary" badgeContent={bgView === 'reports' ? 0 : flaggedReports} max={99} anchorOrigin={{ vertical: 'top', horizontal: 'left' }}>
      <Button size="small"
        startIcon={bgView === 'reports' ? <ViewKanbanOutlinedIcon /> : <HistoryIcon />}
        onClick={() => setBgView((v) => (v === 'reports' ? 'tasks' : 'reports'))}
        sx={{ '& .MuiButton-startIcon': { marginRight: 0.5 } }}>
        {bgView === 'reports' ? 'Jobs' : 'Reports'}
      </Button>
    </Badge>
  );

  // Drag-to-reorder is cosmetic (scheduler still picks oldest-lastRunAt). During
  // a drag we render a local override; a fresh server snapshot (id order changed)
  // clears it. dragId = the row being dragged.
  const jobs = config?.jobs || [];
  const [dragId, setDragId] = useState(null);
  const [localJobs, setLocalJobs] = useState(null);
  const rows = localJobs ?? jobs;
  const idOrder = jobs.map((d) => d.id).join(',');
  // A fresh server snapshot (id order changed) clears the local drag override.
  // Compared against the previous idOrder during render rather than an effect.
  const [prevIdOrder, setPrevIdOrder] = useState(idOrder);
  if (idOrder !== prevIdOrder) {
    setPrevIdOrder(idOrder);
    setLocalJobs(null);
  }

  // Background Jobs table sort: null = source order (jobs/id order, the order
  // the scheduler iterates). Click a header to sort, click again to reverse.
  const [sort, setSort] = useState(null);
  const changeSort = (key) => setSort((p) => p?.key === key ? { key, dir: p.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' });
  const sortValue = (job, key) => {
    switch (key) {
      case 'title': return job.title;
      case 'cwd': return repoName(job.cwd);
      case 'cooldownHours': return job.cooldownHours;
      case 'lastRunAt': return job.lastRunAt ? new Date(job.lastRunAt).getTime() : 0;
      default: return 0;
    }
  };
  const sortedRows = (() => {
    if (!sort) return rows;
    const dir = sort.dir === 'desc' ? -1 : 1;
    return rows.slice().sort((a, b) => {
      const va = sortValue(a, sort.key), vb = sortValue(b, sort.key);
      if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
      return String(va).localeCompare(String(vb)) * dir;
    });
  })();

  const onDragOverRow = (e, overId) => {
    e.preventDefault();
    if (!dragId || dragId === overId) return;
    const from = sortedRows.findIndex((d) => d.id === dragId);
    const to = sortedRows.findIndex((d) => d.id === overId);
    if (from < 0 || to < 0) return;
    const next = sortedRows.slice();
    next.splice(to, 0, next.splice(from, 1)[0]);
    setLocalJobs(next);
  };
  const onDrop = () => {
    setDragId(null);
    if (localJobs) saveOrder(localJobs.map((d) => d.id));
  };

  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* minHeight matches the small-button header bars (button 42 + padding 28 + 1px border)
          so the title centers level with pages carrying a top-right control. */}
      <Stack direction="row" spacing={1.5} sx={{ p: 2, pb: 1.5, alignItems: 'center', flexWrap: 'wrap', minHeight: 71, borderBottom: (t) => `1px solid ${getTokens(t).glass.stroke}` }}>
        <Typography sx={{ fontSize: 20, fontWeight: 600 }}>Automation</Typography>
      </Stack>
      <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto', display: 'flex', flexDirection: 'column', p: 2 }}>
        {/* Scheduled (cron) section */}
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 1 }}>
          <Typography sx={{ fontWeight: 700, fontSize: 15 }}>Scheduled</Typography>
          <Typography variant="code" sx={{ color: 'text.secondary', fontSize: 11 }}>times in UTC</Typography>
          <Box sx={{ flex: 1 }} />
          <Button size="small" startIcon={<AddIcon />} onClick={onAdd} sx={{ '& .MuiButton-startIcon': { marginRight: 0.5 } }}>Scheduled job</Button>
        </Stack>
        {crons.length === 0 ? (
          <Box sx={{ py: 3, display: 'grid', placeItems: 'center' }}>
            <EmptyState icon={<ScheduleIcon />} title="No scheduled jobs" description="Add one to run a prompt on a schedule." />
          </Box>
        ) : (
          <Table size="small" stickyHeader>
            <TableHead>
              <TableRow>
                <TableCell padding="checkbox" />
                <TableCell>Title</TableCell>
                <TableCell>Schedule</TableCell>
                <TableCell>Description</TableCell>
                <TableCell>Model</TableCell>
                <TableCell>Working directory</TableCell>
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
                      <Typography variant="subtitle2" noWrap>{j.title}</Typography>
                    </TableCell>
                    <TableCell>
                      <Typography variant="code" sx={{ fontSize: 11 }} noWrap>{j.cronExpr}</Typography>
                      <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block' }} noWrap>{j.nextFire ? fmtNext(j.nextFire) : (j.enabled ? '—' : 'paused')}</Typography>
                    </TableCell>
                    <TableCell sx={{ maxWidth: 220 }}>
                      <Typography variant="body2" sx={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{j.description}</Typography>
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
                        <Tooltip title="Edit" disableInteractive>
                          <IconButton size="small" onClick={() => onEdit?.(j)}><EditOutlinedIcon fontSize="small" /></IconButton>
                        </Tooltip>
                        <Tooltip title="Delete" disableInteractive>
                          <IconButton size="small" onClick={() => { if (window.confirm(`Delete scheduled job "${j.title}"?`)) remove(j.id); }}><DeleteOutlineIcon fontSize="small" /></IconButton>
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
          <Tooltip
            disableInteractive
            title={
              <Box component="div" sx={{ fontSize: 12 }}>
                Runs jobs automatically using AI capacity you're not otherwise using.<br />
                Every hour, it checks each job for two things:
                <Box component="ol" sx={{ my: 0.5, pl: 2.5 }}>
                  <li>The current time is within the job's allowed days and hours</li>
                  <li>Your AI usage is below the job's start threshold</li>
                </Box>
                If both are true, the job that's waited longest (and isn't on cooldown) starts as a new card on the Tasks board.<br />
                To start a job right away instead of waiting, use "Run now".
              </Box>
            }
          >
            <InfoOutlinedIcon sx={{ fontSize: 16, color: 'text.secondary', cursor: 'help' }} />
          </Tooltip>
          <Typography variant="code" sx={{ color: 'text.secondary', fontSize: 11 }}>times in local time</Typography>
          <Box sx={{ flex: 1 }} />
          {bgView !== 'reports' && (
            <>
              <Tooltip title="Check now and start the next ready job" disableInteractive>
                <Button size="small" startIcon={<PlayArrowIcon />} onClick={runBg} sx={{ '& .MuiButton-startIcon': { marginRight: 0.5 } }}>Run now</Button>
              </Tooltip>
              <Button size="small" startIcon={<AddIcon />} onClick={() => setJobOpen(true)} sx={{ '& .MuiButton-startIcon': { marginRight: 0.5 } }}>Background job</Button>
            </>
          )}
          {bgToggle}
        </Stack>

        {!config ? (
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>Loading…</Typography>
        ) : bgView === 'reports' ? (
          reports.length === 0 ? (
            <Box sx={{ py: 3, display: 'grid', placeItems: 'center' }}>
              <EmptyState icon={<DescriptionOutlinedIcon />} title="No reports yet" description="Background runs write a report when they finish — it will show up here." />
            </Box>
          ) : (
            <Stack direction="row" sx={{ flex: 1, minHeight: 0, border: (t) => `1px solid ${getTokens(t).glass.stroke}`, borderRadius: (t) => `${getTokens(t).radius.sm}px` }}>
              <List dense sx={(t) => ({ width: railW.width, flexShrink: 0, borderRight: `1px solid ${getTokens(t).glass.stroke}`, overflow: 'auto', py: 0 })}>
                {reports.map((r) => (
                  <ListItemButton key={r.taskId} selected={selReport === r.taskId} onClick={() => openReport(r.taskId)} sx={{ display: 'block' }}>
                    <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
                      {r.flagged && <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: 'primary.main', flexShrink: 0 }} />}
                      <Typography variant="subtitle2" noWrap sx={{ flex: 1, minWidth: 0, fontWeight: r.flagged ? 600 : 400 }}>{r.title}</Typography>
                      <Tooltip title={r.flagged ? 'Unflag' : 'Flag'}>
                        <IconButton size="small" sx={{ p: 0.25 }} onClick={(e) => { e.stopPropagation(); setFlag(r.taskId, !r.flagged); }}>
                          {r.flagged ? <FlagIcon fontSize="inherit" /> : <FlagOutlinedIcon fontSize="inherit" />}
                        </IconButton>
                      </Tooltip>
                    </Stack>
                    <Stack direction="row" spacing={1} sx={{ mt: 0.25, alignItems: 'center' }}>
                      <Typography variant="code" sx={{ color: 'text.secondary', fontSize: 11 }} noWrap>{fmtRel(r.concludedAt ?? r.createdAt)}</Typography>
                      <Chip size="small" label={r.status} sx={{ height: 18, fontSize: 10 }} />
                    </Stack>
                  </ListItemButton>
                ))}
              </List>
              <ResizeHandle
                onPointerDown={railW.startDrag}
                onKeyDown={railW.onKeyDown}
                dragging={railW.dragging}
                value={railW.width}
                min={railW.min}
                max={railW.max}
                label="Resize report list"
              />
              <Box sx={{ flex: 1, minWidth: 0, overflow: 'auto', p: 2 }}>
                {!selReport ? (
                  <Box sx={{ height: '100%', display: 'grid', placeItems: 'center' }}>
                    <EmptyState icon={<DescriptionOutlinedIcon />} title="Select a report" description="Pick a background run on the left to read its report." />
                  </Box>
                ) : reportLoading ? (
                  <Typography color="text.secondary">Loading…</Typography>
                ) : reportContent == null ? (
                  <Typography color="text.secondary">No report for this run.</Typography>
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
                ? `${lastTick.action === 'ran' ? 'started' : 'skipped'} ${fmtHM(lastTick.at)}${lastTick.reason ? ` — ${lastTick.reason}` : ''}`
                : fmtWait(background.nextDueAt)}
            </Typography>

            {/* Jobs table */}
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>Jobs</Typography>
            {(config.jobs || []).length === 0 ? (
              <Typography variant="body2" sx={{ color: 'text.secondary' }}>No background jobs yet. Add one to run automatically during its scheduled hours, using spare AI capacity.</Typography>
            ) : (
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell padding="checkbox" />
                    <TableCell padding="checkbox" />
                    <TableCell sortDirection={sort?.key === 'title' ? sort.dir : false}><TableSortLabel active={sort?.key === 'title'} direction={sort?.key === 'title' ? sort.dir : 'asc'} onClick={() => changeSort('title')}>Title</TableSortLabel></TableCell>
                    <TableCell sortDirection={sort?.key === 'cwd' ? sort.dir : false}><TableSortLabel active={sort?.key === 'cwd'} direction={sort?.key === 'cwd' ? sort.dir : 'asc'} onClick={() => changeSort('cwd')}>Working directory</TableSortLabel></TableCell>
                    <TableCell sortDirection={sort?.key === 'cooldownHours' ? sort.dir : false}><TableSortLabel active={sort?.key === 'cooldownHours'} direction={sort?.key === 'cooldownHours' ? sort.dir : 'asc'} onClick={() => changeSort('cooldownHours')}>Cooldown</TableSortLabel></TableCell>
                    <TableCell sortDirection={sort?.key === 'lastRunAt' ? sort.dir : false}><TableSortLabel active={sort?.key === 'lastRunAt'} direction={sort?.key === 'lastRunAt' ? sort.dir : 'asc'} onClick={() => changeSort('lastRunAt')}>Last run</TableSortLabel></TableCell>
                    <TableCell align="right" />
                  </TableRow>
                </TableHead>
                <TableBody>
                  {sortedRows.map((job) => (
                    <TableRow
                      key={job.id}
                      selected={background?.liveTaskId && job.lastTaskId === background.liveTaskId}
                      onDragOver={(e) => onDragOverRow(e, job.id)}
                      onDrop={onDrop}
                      sx={dragId === job.id ? { opacity: 0.4 } : undefined}
                    >
                      <TableCell padding="checkbox">
                        <Tooltip title="Drag to change the order shown here (doesn't change which job runs next)" disableInteractive>
                          <Box
                            draggable
                            onDragStart={() => setDragId(job.id)}
                            onDragEnd={() => setDragId(null)}
                            sx={{ display: 'grid', placeItems: 'center', cursor: 'grab', color: 'text.disabled', '&:active': { cursor: 'grabbing' } }}
                          >
                            <DragIndicatorIcon fontSize="small" />
                          </Box>
                        </Tooltip>
                      </TableCell>
                      <TableCell padding="checkbox">
                        <Tooltip title={job.enabled ? 'Disable' : 'Enable'} disableInteractive>
                          <Switch size="small" checked={!!job.enabled} onChange={() => toggleJob(job.id, job.enabled)} />
                        </Tooltip>
                      </TableCell>
                      <TableCell><Typography variant="subtitle2" noWrap>{job.title}</Typography></TableCell>
                      <TableCell><Typography variant="code" sx={{ fontSize: 11 }} noWrap>{repoName(job.cwd)}</Typography></TableCell>
                      <TableCell><Typography variant="code" sx={{ fontSize: 11 }} noWrap>{job.cooldownHours}h</Typography></TableCell>
                      <TableCell><Typography variant="code" sx={{ fontSize: 11 }} noWrap>{fmtRel(job.lastRunAt)}</Typography></TableCell>
                      <TableCell align="right">
                        <Stack direction="row" sx={{ justifyContent: 'flex-end' }}>
                          <Tooltip title="Edit" disableInteractive>
                            <IconButton size="small" onClick={() => setJobOpen(job)}><EditOutlinedIcon fontSize="small" /></IconButton>
                          </Tooltip>
                          <Tooltip title="Delete" disableInteractive>
                            <IconButton size="small" onClick={() => { if (window.confirm(`Delete background job "${job.title}"?`)) removeJob(job.id); }}><DeleteOutlineIcon fontSize="small" /></IconButton>
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

      <CreateBackgroundJobDialog
        open={!!jobOpen}
        job={typeof jobOpen === 'object' ? jobOpen : null}
        onClose={() => setJobOpen(false)}
        cwd={cwd}
        setCwd={setCwd}
        recent={recent}
        onBrowse={onBrowse}
        onToast={onToast}
      />
    </Box>
  );
}
