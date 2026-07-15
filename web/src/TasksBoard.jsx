import React, { useState } from 'react';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import Chip from '@mui/material/Chip';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import Table from '@mui/material/Table';
import TableHead from '@mui/material/TableHead';
import TableBody from '@mui/material/TableBody';
import TableRow from '@mui/material/TableRow';
import TableCell from '@mui/material/TableCell';
import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlined';
import OutlinedFlagOutlinedIcon from '@mui/icons-material/OutlinedFlagOutlined';
import HistoryIcon from '@mui/icons-material/History';
import ViewKanbanOutlinedIcon from '@mui/icons-material/ViewKanbanOutlined';
import { StatusPill } from '@zapac/mui-theme';

const COLUMNS = [
  ['todo', 'To-Do'],
  ['inprogress', 'In Progress'],
  ['inreview', 'In Review'],
  ['done', 'Done'],
];
// agent lifecycle -> StatusPill kinds (mirrors KIND in App.jsx)
const KIND = { starting: 'active', running: 'active', idle: 'review', detached: 'review', exited: 'error' };
const repoName = (p) => (p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop();

// Duration/cost/token formatters — fmtTokens mirrors the 1-liner in App.jsx.
const fmtMs = (ms) => {
  if (!ms) return null;
  const m = ms / 60000;
  if (m < 60) return `${m < 10 ? m.toFixed(1) : Math.round(m)}m`;
  return `${(m / 60).toFixed(1)}h`;
};
const fmtUsd = (n) => (n > 0 ? `$${n.toFixed(2)}` : null);
const fmtTokens = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : `${n}`);

// Card stats line: "18m busy · 12m api · $0.84 · 350k tok" — omits null/zero parts.
function statsLine(s) {
  if (!s) return null;
  const parts = [
    s.busyMs > 0 && `${fmtMs(s.busyMs)} busy`,
    s.apiMs > 0 && `${fmtMs(s.apiMs)} api`,
    fmtUsd(s.costUsd),
    s.tokens > 0 && `${fmtTokens(s.tokens)} tok`,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
}

// Kanban board (top pane of the Tasks view). Columns are fixed; cards move via
// the daemon (agent curls) or a manual drag (override). Dragging into Done
// kills the task's live agent session server-side, so that drop is confirmed.
// Clicking a card selects its session's terminal below.
// Header toggles to a History table (concluded tasks — completed or abandoned).
const LIVE_STATUS = new Set(['starting', 'running', 'idle']);

export default function TasksBoard({ tasks, history, agents, stats, activeId, onSelect, onAdd, onMove, onConclude, onDeleteHistory }) {
  const [dragId, setDragId] = useState(null);
  const [showHistory, setShowHistory] = useState(false);

  const drop = (col) => {
    const t = tasks.find((x) => x.id === dragId);
    setDragId(null);
    if (!t || t.column === col) return;
    if (col === 'done') {
      const agent = agents.find((a) => a.id === t.sessionId);
      if (agent && LIVE_STATUS.has(agent.status) && !window.confirm(`Move "${t.title}" to Done? Its live agent session will be ended.`)) return;
    }
    onMove(t.id, col);
  };

  return (
    <Stack sx={{ height: '100%', p: 1.5, pb: 1 }} spacing={1}>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
        <Typography sx={{ fontWeight: 700, fontSize: 15 }}>Tasks</Typography>
        <Box sx={{ flex: 1 }} />
        <Button size="small" startIcon={showHistory ? <ViewKanbanOutlinedIcon /> : <HistoryIcon />} onClick={() => setShowHistory((v) => !v)} sx={{ '& .MuiButton-startIcon': { marginRight: 0.5 } }}>
          {showHistory ? 'Board' : 'History'}
        </Button>
        <Button size="small" startIcon={<AddIcon />} onClick={onAdd} sx={{ '& .MuiButton-startIcon': { marginRight: 0.5 } }}>Task</Button>
      </Stack>
      {showHistory ? (
        <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
          <Table size="small" stickyHeader>
            <TableHead>
              <TableRow>
                <TableCell>Title</TableCell>
                <TableCell>Repo</TableCell>
                <TableCell>Branch</TableCell>
                <TableCell>Outcome</TableCell>
                <TableCell>Busy</TableCell>
                <TableCell>API</TableCell>
                <TableCell>Cost</TableCell>
                <TableCell>Tokens</TableCell>
                <TableCell>Concluded</TableCell>
                <TableCell />
              </TableRow>
            </TableHead>
            <TableBody>
              {history.map((h) => {
                const s = h.finalStats;
                return (
                  <TableRow key={h.id}>
                    <TableCell>{h.title}</TableCell>
                    <TableCell>{repoName(h.repo)}</TableCell>
                    <TableCell>{h.branch || '—'}</TableCell>
                    <TableCell><Chip size="small" label={h.outcome} sx={{ height: 20, fontSize: 11 }} /></TableCell>
                    <TableCell>{fmtMs(s?.busyMs) || '—'}</TableCell>
                    <TableCell>{fmtMs(s?.apiMs) || '—'}</TableCell>
                    <TableCell>{fmtUsd(s?.costUsd) || '—'}</TableCell>
                    <TableCell>{s?.tokens > 0 ? fmtTokens(s.tokens) : '—'}</TableCell>
                    <TableCell>{new Date(h.concludedAt).toLocaleString()}</TableCell>
                    <TableCell align="right">
                      <Tooltip title="Delete permanently" disableInteractive>
                        <IconButton
                          size="small"
                          onClick={() => {
                            if (window.confirm(`Permanently delete "${h.title}" from history?`)) onDeleteHistory(h.id);
                          }}
                        >
                          <DeleteOutlineIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Box>
      ) : (
        <Stack direction="row" spacing={1} sx={{ flex: 1, minHeight: 0 }}>
          {COLUMNS.map(([col, label]) => {
            const cards = tasks.filter((t) => t.column === col);
            return (
              <Stack
                key={col}
                spacing={0.75}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => drop(col)}
                sx={(t) => ({
                  flex: 1, minWidth: 0, minHeight: 0,
                  borderRadius: `${t.zapac.radius.sm}px`,
                  border: `1px solid ${t.vars.palette.glass.stroke}`,
                  p: 0.75,
                })}
              >
                <Typography variant="overline" sx={{ px: 0.5, lineHeight: 1.6, color: 'text.secondary' }}>
                  {label} ({cards.length})
                </Typography>
                {/* Card list scrolls inside the column when it outgrows the pane. */}
                <Stack spacing={0.75} sx={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
                  {cards.map((task) => {
                    const agent = agents.find((a) => a.id === task.sessionId);
                    const sel = task.sessionId === activeId;
                    const line = statsLine(stats?.[task.sessionId]);
                    return (
                      <Box
                        key={task.id}
                        draggable
                        onDragStart={() => setDragId(task.id)}
                        onDragEnd={() => setDragId(null)}
                        onClick={() => onSelect(task.sessionId)}
                        sx={(t) => ({
                          p: 1, cursor: 'pointer', flexShrink: 0,
                          borderRadius: `${t.zapac.radius.sm}px`,
                          border: `1px solid ${sel ? t.vars.palette.primary.main : t.vars.palette.glass.stroke}`,
                          background: t.vars.palette.glass.surface,
                          opacity: dragId === task.id ? 0.4 : 1,
                          '& .card-act': { opacity: 0 },
                          '&:hover .card-act': { opacity: 1 },
                        })}
                      >
                        <Stack direction="row" spacing={0.5} sx={{ alignItems: 'flex-start' }}>
                          <Typography variant="subtitle2" sx={{ flex: 1, minWidth: 0 }} noWrap>{task.title}</Typography>
                          <Stack direction="row" className="card-act" sx={{ transition: 'opacity .15s' }}>
                            {col === 'done' && (
                              <Tooltip title={task.branch ? 'Remove (worktree already gone; branch kept)' : 'Remove (moves to history)'} disableInteractive>
                                <IconButton
                                  size="small"
                                  sx={{ mt: -0.5 }}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    if (window.confirm(`Remove task "${task.title}"? It moves to history.`)) onConclude(task.id, 'completed');
                                  }}
                                >
                                  <DeleteOutlineIcon fontSize="small" />
                                </IconButton>
                              </Tooltip>
                            )}
                            <Tooltip title={task.branch ? 'Abandon task (removes worktree, keeps branch)' : 'Abandon task (working directory left untouched)'} disableInteractive>
                              <IconButton
                                size="small"
                                sx={{ mt: -0.5, mr: -0.5 }}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  if (window.confirm(task.branch ? `Abandon task "${task.title}"? The worktree is removed; branch ${task.branch} is kept.` : `Abandon task "${task.title}"? The working directory is left untouched.`)) onConclude(task.id, 'abandoned');
                                }}
                              >
                                <OutlinedFlagOutlinedIcon fontSize="small" />
                              </IconButton>
                            </Tooltip>
                          </Stack>
                        </Stack>
                        <Typography variant="code" sx={{ color: 'text.secondary', fontSize: 11, display: 'block' }} noWrap>
                          {repoName(task.repo)}{task.branch ? ` · ${task.branch}` : ''}
                        </Typography>
                        {line && (
                          <Typography variant="code" sx={{ color: 'text.secondary', fontSize: 11, display: 'block' }} noWrap>
                            {line}
                          </Typography>
                        )}
                        <Stack direction="row" spacing={0.5} sx={{ mt: 0.5, flexWrap: 'wrap', rowGap: 0.5, alignItems: 'center' }}>
                          {task.state && <Chip size="small" label={task.state} sx={{ height: 20, fontSize: 11 }} />}
                          {agent && <StatusPill status={KIND[agent.status] ?? 'review'}>{agent.status}</StatusPill>}
                        </Stack>
                      </Box>
                    );
                  })}
                </Stack>
              </Stack>
            );
          })}
        </Stack>
      )}
    </Stack>
  );
}
