import React, { useRef, useState } from 'react';
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
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import HorizontalSplitIcon from '@mui/icons-material/HorizontalSplit';
import VerticalSplitIcon from '@mui/icons-material/VerticalSplit';
import { StatusPill } from '@zapac/mui-theme';
import TranscriptView from './TranscriptView.jsx';

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

  // History transcript panel: selecting a row loads its session's transcript
  // read-only, dockable bottom/right, resizable + collapsible, all persisted —
  // mirrors the terminal dock pattern in App.jsx.
  const [selHistId, setSelHistId] = useState(null);
  const [transcript, setTranscript] = useState(null);
  const [loadingT, setLoadingT] = useState(false);
  const [errT, setErrT] = useState(null);
  const [side, setSide] = useState(() => (localStorage.getItem('sing-hist-side') === 'right' ? 'right' : 'bottom'));
  const [panelMin, setPanelMin] = useState(() => localStorage.getItem('sing-hist-min') === '1');
  const [panelH, setPanelH] = useState(() => { const v = Number(localStorage.getItem('sing-hist-h')); return v >= 140 && v <= 2000 ? v : 300; });
  const [panelW, setPanelW] = useState(() => { const v = Number(localStorage.getItem('sing-hist-w')); return v >= 200 && v <= 1600 ? v : 420; });
  const histRef = useRef(null);
  const histReqRef = useRef(0); // guards against a slower stale fetch overwriting a newer selection
  const selRow = history.find((h) => h.id === selHistId) || null;

  const selectHistRow = (h) => {
    if (selHistId === h.id) { setSelHistId(null); return; }
    setSelHistId(h.id);
    setTranscript(null); setErrT(null);
    const seq = ++histReqRef.current;
    if (!h.sessionId) { setErrT('No transcript found for this task.'); return; }
    setLoadingT(true);
    const slug = (h.worktree ?? h.repo).replace(/[^a-zA-Z0-9]/g, '-');
    fetch(`/session?project=${encodeURIComponent(slug)}&id=${encodeURIComponent(h.sessionId)}`)
      .then((r) => r.json())
      .then((d) => { if (seq !== histReqRef.current) return; if (d.ok) setTranscript(d); else setErrT('No transcript found for this task.'); })
      .catch(() => { if (seq === histReqRef.current) setErrT('No transcript found for this task.'); })
      .finally(() => { if (seq === histReqRef.current) setLoadingT(false); });
  };

  const toggleSide = (e) => {
    e.stopPropagation();
    setSide((s) => { const n = s === 'bottom' ? 'right' : 'bottom'; localStorage.setItem('sing-hist-side', n); return n; });
  };
  const togglePanelMin = () => setPanelMin((m) => { const n = !m; localStorage.setItem('sing-hist-min', n ? '1' : '0'); return n; });

  // Drag the panel's inner edge (top when bottom-docked, left when right-docked)
  // to resize — mirrors App.jsx's startDockDrag.
  const startPanelDrag = (e) => {
    e.preventDefault();
    const rect = histRef.current?.getBoundingClientRect();
    if (!rect) return;
    const move = (ev) => {
      if (side === 'bottom') {
        const h = Math.min(rect.height - 140, Math.max(140, rect.bottom - ev.clientY));
        setPanelH(h);
        localStorage.setItem('sing-hist-h', String(Math.round(h)));
      } else {
        const w = Math.min(rect.width - 200, Math.max(200, rect.right - ev.clientX));
        setPanelW(w);
        localStorage.setItem('sing-hist-w', String(Math.round(w)));
      }
    };
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

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
        <Stack ref={histRef} direction={side === 'right' ? 'row' : 'column'} spacing={0} sx={{ flex: 1, minHeight: 0 }}>
          <Box sx={{ flex: 1, minWidth: 0, minHeight: 0, overflow: 'auto' }}>
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
                    <TableRow key={h.id} hover selected={selHistId === h.id} onClick={() => selectHistRow(h)} sx={{ cursor: 'pointer' }}>
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
                            onClick={(e) => {
                              e.stopPropagation();
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

          {selRow && (
            <>
              {/* Drag handle — resize the panel (hidden while minimized). */}
              {!panelMin && (
                <Box
                  onMouseDown={startPanelDrag}
                  sx={{
                    flexShrink: 0,
                    cursor: side === 'bottom' ? 'row-resize' : 'col-resize',
                    ...(side === 'bottom' ? { height: 8, mx: 1 } : { width: 8, my: 1 }),
                  }}
                />
              )}
              <Box
                sx={(t) => ({
                  flexShrink: 0,
                  display: 'flex',
                  flexDirection: 'column',
                  overflow: 'hidden',
                  borderRadius: `${t.zapac.radius.sm}px`,
                  border: `1px solid ${t.vars.palette.glass.stroke}`,
                  ...(side === 'bottom' ? { width: '100%', height: panelMin ? 'auto' : panelH } : { height: '100%', width: panelMin ? 36 : panelW }),
                })}
              >
                {/* Right-docked + collapsed → slim vertical strip: rotated title, stacked icons. */}
                <Stack
                  direction={side === 'right' && panelMin ? 'column' : 'row'} spacing={1} onClick={togglePanelMin}
                  sx={(t) => ({ flexShrink: 0, alignItems: 'center', cursor: 'pointer', userSelect: 'none',
                    ...(side === 'right' && panelMin
                      ? { flex: 1, minHeight: 0, py: 1 }
                      : { px: 1.5, height: 36, borderBottom: panelMin ? 'none' : `1px solid ${t.vars.palette.glass.stroke}` }) })}
                >
                  <Typography variant="subtitle2" noWrap sx={side === 'right' && panelMin ? { flex: 1, minHeight: 0, writingMode: 'vertical-rl' } : { flex: 1, minWidth: 0 }}>{selRow.title}</Typography>
                  <Tooltip title={side === 'bottom' ? 'Dock right' : 'Dock bottom'} disableInteractive>
                    <IconButton size="small" onClick={toggleSide}>
                      {side === 'bottom' ? <VerticalSplitIcon fontSize="small" /> : <HorizontalSplitIcon fontSize="small" />}
                    </IconButton>
                  </Tooltip>
                  {side === 'right'
                    ? (panelMin ? <ChevronLeftIcon sx={{ fontSize: 18, color: 'text.secondary' }} /> : <ChevronRightIcon sx={{ fontSize: 18, color: 'text.secondary' }} />)
                    : (panelMin ? <ExpandMoreIcon sx={{ fontSize: 18, color: 'text.secondary' }} /> : <ExpandLessIcon sx={{ fontSize: 18, color: 'text.secondary' }} />)}
                </Stack>
                <Box sx={{ display: panelMin ? 'none' : 'block', flex: 1, minHeight: 0, overflow: 'auto', p: 2 }}>
                  {loadingT ? (
                    <Typography color="text.secondary">Loading…</Typography>
                  ) : errT ? (
                    <Box sx={{ height: '100%', display: 'grid', placeItems: 'center' }}>
                      <Typography color="text.secondary">{errT}</Typography>
                    </Box>
                  ) : transcript ? (
                    <TranscriptView messages={transcript.messages || []} />
                  ) : null}
                </Box>
              </Box>
            </>
          )}
        </Stack>
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
