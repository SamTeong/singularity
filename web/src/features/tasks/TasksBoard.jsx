import { getTokens } from '@/theme/contract.js';
import React, { useRef, useState, useMemo } from 'react';
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
import TableSortLabel from '@mui/material/TableSortLabel';
import AddIcon from '@mui/icons-material/Add';
import CloseIcon from '@mui/icons-material/Close';
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
import TranscriptView from '@/features/transcripts/TranscriptView.jsx';
import { repoName } from '@/lib/paths.js';
import { fmtUsd, fmtTokens } from '@/lib/format.js';
import { KIND } from '@/lib/agentStatus.js';
import { useResizable } from '@/hooks/useResizable.jsx';

const COLUMNS = [
  ['todo', 'To-Do'],
  ['inprogress', 'In Progress'],
  ['inreview', 'In Review'],
  ['done', 'Done'],
];

// Duration formatter — cost/token formatters live in format.js.
const fmtMs = (ms) => {
  if (!ms) return null;
  const m = ms / 60000;
  if (m < 60) return `${m < 10 ? m.toFixed(1) : Math.round(m)}m`;
  return `${(m / 60).toFixed(1)}h`;
};

// Card stats line: "18m busy · 12m api · $0.84 · 350k tok" — omits null/zero parts.
function statsLine(s) {
  if (!s) return null;
  const parts = [
    s.busyMs > 0 && `${fmtMs(s.busyMs)} active`,
    s.apiMs > 0 && `${fmtMs(s.apiMs)} API`,
    fmtUsd(s.costUsd),
    s.tokens > 0 && `${fmtTokens(s.tokens)} tokens`,
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
  const [activeTags, setActiveTags] = useState(() => new Set());
  // History table sort: click a header to sort, click again to reverse. Numeric
  // fields compare by value, strings by localeCompare. Default = newest first.
  const [sort, setSort] = useState({ key: 'concludedAt', dir: 'desc' });
  const changeSort = (key) => setSort((p) => p.key === key ? { key, dir: p.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' });

  // Distinct tags across live tasks + history (union, deduped, sorted). The filter
  // pill row is shared by Board and History; OR semantics — a task matches if it
  // carries ANY active tag; empty active-set shows everything.
  const allTags = useMemo(() => {
    const s = new Set();
    for (const t of tasks) (t.tags || []).forEach((x) => s.add(x));
    for (const h of history) (h.tags || []).forEach((x) => s.add(x));
    return [...s].sort();
  }, [tasks, history]);
  const matchesTags = (item) => activeTags.size === 0 || (item.tags || []).some((t) => activeTags.has(t));
  const toggleTag = (tag) => setActiveTags((prev) => {
    const n = new Set(prev);
    if (n.has(tag)) n.delete(tag); else n.add(tag);
    return n;
  });

  // Sort value per header key. Numeric fields fall back to 0; strings to ''.
  const sortValue = (h, key) => {
    const s = h.finalStats;
    switch (key) {
      case 'title': return h.title;
      case 'repo': return repoName(h.repo);
      case 'branch': return h.branch || '';
      case 'outcome': return h.outcome;
      case 'busyMs': return s?.busyMs ?? 0;
      case 'apiMs': return s?.apiMs ?? 0;
      case 'costUsd': return s?.costUsd ?? 0;
      case 'tokens': return s?.tokens ?? 0;
      case 'concludedAt': return h.concludedAt ? new Date(h.concludedAt).getTime() : 0;
      default: return 0;
    }
  };
  const sortedHistory = useMemo(() => {
    const dir = sort.dir === 'desc' ? -1 : 1;
    return history.filter(matchesTags).slice().sort((a, b) => {
      const va = sortValue(a, sort.key), vb = sortValue(b, sort.key);
      if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
      return String(va).localeCompare(String(vb)) * dir;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [history, activeTags, sort]);

  // Transcript panel: selecting a History row — or a Done-column card — loads its
  // session's transcript read-only, dockable bottom/right, resizable + collapsible,
  // all persisted — mirrors the terminal dock pattern in App.jsx. Driven by a
  // generic item {id,title,sessionId,worktree,repo} so both entry points share it.
  const [tx, setTx] = useState(null);
  const [transcript, setTranscript] = useState(null);
  const [loadingT, setLoadingT] = useState(false);
  const [errT, setErrT] = useState(null);
  const [side, setSide] = useState(() => (localStorage.getItem('sing-hist-side') === 'right' ? 'right' : 'bottom'));
  const [panelMin, setPanelMin] = useState(() => localStorage.getItem('sing-hist-min') === '1');
  const [panelW, setPanelW] = useState(() => { const v = Number(localStorage.getItem('sing-hist-w')); return v >= 200 && v <= 1600 ? v : 420; });
  const dockRef = useRef(null);
  // Panel height (bottom-docked) is a drag-resizable axis:'y' — mirrors App.jsx's dock.
  const { width: panelH, startDrag: startPanelHeightDrag } = useResizable('sing-hist-h', 300, { min: 140, max: 2000, axis: 'y', containerRef: dockRef });
  const histReqRef = useRef(0); // guards against a slower stale fetch overwriting a newer selection

  const openTranscript = (item) => {
    if (tx?.id === item.id) { setTx(null); return; }
    setTx(item);
    setTranscript(null); setErrT(null);
    const seq = ++histReqRef.current;
    if (!item.sessionId) { setErrT('No transcript found for this task.'); return; }
    setLoadingT(true);
    const slug = (item.worktree ?? item.repo).replace(/[^a-zA-Z0-9]/g, '-');
    fetch(`/session?project=${encodeURIComponent(slug)}&id=${encodeURIComponent(item.sessionId)}`)
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
  // to resize. Height reuses useResizable (mirrors App.jsx's dock); width stays
  // bespoke — it's anchored to the panel's right edge, not the left.
  const startPanelWidthDrag = (e) => {
    e.preventDefault();
    const rect = dockRef.current?.getBoundingClientRect();
    if (!rect) return;
    const move = (ev) => {
      const w = Math.min(rect.width - 200, Math.max(200, rect.right - ev.clientX));
      setPanelW(w);
      localStorage.setItem('sing-hist-w', String(Math.round(w)));
    };
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };
  const startPanelDrag = side === 'bottom' ? startPanelHeightDrag : startPanelWidthDrag;

  const drop = (col) => {
    const t = tasks.find((x) => x.id === dragId);
    setDragId(null);
    if (!t || t.column === col) return;
    if (col === 'done') {
      const agent = agents.find((a) => a.id === t.sessionId);
      if (agent && LIVE_STATUS.has(agent.status) && !window.confirm(`Move "${t.title}" to Done? This will stop the AI agent currently working on it.`)) return;
    }
    onMove(t.id, col);
  };

  // Shared dockable transcript panel — rendered in both the History table view
  // and the board view (for a selected Done card). Reads the generic `tx` item.
  const dock = tx && (
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
          borderRadius: `${getTokens(t).radius.sm}px`,
          border: `1px solid ${getTokens(t).glass.stroke}`,
          ...(side === 'bottom' ? { width: '100%', height: panelMin ? 'auto' : panelH } : { height: '100%', width: panelMin ? 36 : panelW }),
        })}
      >
        {/* Right-docked + collapsed → slim vertical strip: rotated title, stacked icons. */}
        <Stack
          direction={side === 'right' && panelMin ? 'column' : 'row'} spacing={1} role="button" tabIndex={0}
          aria-label={panelMin ? `Expand ${tx.title} transcript` : `Collapse ${tx.title} transcript`}
          onClick={togglePanelMin}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); togglePanelMin(e); } }}
          sx={(t) => ({ flexShrink: 0, alignItems: 'center', cursor: 'pointer', userSelect: 'none',
            ...(side === 'right' && panelMin
              ? { flex: 1, minHeight: 0, py: 1 }
              : { px: 1.5, height: 36, borderBottom: panelMin ? 'none' : `1px solid ${getTokens(t).glass.stroke}` }) })}
        >
          <Typography variant="subtitle2" noWrap sx={side === 'right' && panelMin ? { flex: 1, minHeight: 0, writingMode: 'vertical-rl' } : { flex: 1, minWidth: 0 }}>{tx.title}</Typography>
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
  );

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
      {allTags.length > 0 && (
        <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap', rowGap: 0.5, alignItems: 'center' }}>
          {allTags.map((tag) => {
            const on = activeTags.has(tag);
            return (
              <Chip
                key={tag}
                size="small"
                label={tag}
                variant={on ? 'filled' : 'outlined'}
                color={on ? 'primary' : 'default'}
                onClick={() => toggleTag(tag)}
                onDelete={on ? () => toggleTag(tag) : undefined}
                sx={{ height: 22, fontSize: 11 }}
              />
            );
          })}
          {activeTags.size > 0 && (
            <Chip
              size="small"
              label="Clear all"
              variant="outlined"
              onClick={() => setActiveTags(new Set())}
              onDelete={() => setActiveTags(new Set())}
              deleteIcon={<CloseIcon />}
              sx={{ height: 22, fontSize: 11, ml: 0.5, color: 'text.secondary' }}
            />
          )}
        </Stack>
      )}
      {showHistory ? (
        <Stack ref={dockRef} direction={side === 'right' ? 'row' : 'column'} spacing={0} sx={{ flex: 1, minHeight: 0 }}>
          <Box sx={{ flex: 1, minWidth: 0, minHeight: 0, overflow: 'auto' }}>
            <Table size="small" stickyHeader>
              <TableHead>
                <TableRow>
                  <TableCell sortDirection={sort.key === 'title' ? sort.dir : false}><TableSortLabel active={sort.key === 'title'} direction={sort.dir} onClick={() => changeSort('title')}>Title</TableSortLabel></TableCell>
                  <TableCell sortDirection={sort.key === 'repo' ? sort.dir : false}><TableSortLabel active={sort.key === 'repo'} direction={sort.dir} onClick={() => changeSort('repo')}>Repo</TableSortLabel></TableCell>
                  <TableCell sortDirection={sort.key === 'branch' ? sort.dir : false}><TableSortLabel active={sort.key === 'branch'} direction={sort.dir} onClick={() => changeSort('branch')}>Branch</TableSortLabel></TableCell>
                  <TableCell sortDirection={sort.key === 'outcome' ? sort.dir : false}><TableSortLabel active={sort.key === 'outcome'} direction={sort.dir} onClick={() => changeSort('outcome')}>Outcome</TableSortLabel></TableCell>
                  <TableCell sortDirection={sort.key === 'busyMs' ? sort.dir : false}><TableSortLabel active={sort.key === 'busyMs'} direction={sort.dir} onClick={() => changeSort('busyMs')}>Busy</TableSortLabel></TableCell>
                  <TableCell sortDirection={sort.key === 'apiMs' ? sort.dir : false}><Tooltip title="Time spent waiting for the AI model to respond" disableInteractive><TableSortLabel active={sort.key === 'apiMs'} direction={sort.dir} onClick={() => changeSort('apiMs')}>API time</TableSortLabel></Tooltip></TableCell>
                  <TableCell sortDirection={sort.key === 'costUsd' ? sort.dir : false}><TableSortLabel active={sort.key === 'costUsd'} direction={sort.dir} onClick={() => changeSort('costUsd')}>Cost</TableSortLabel></TableCell>
                  <TableCell sortDirection={sort.key === 'tokens' ? sort.dir : false}><TableSortLabel active={sort.key === 'tokens'} direction={sort.dir} onClick={() => changeSort('tokens')}>Tokens</TableSortLabel></TableCell>
                  <TableCell sortDirection={sort.key === 'concludedAt' ? sort.dir : false}><TableSortLabel active={sort.key === 'concludedAt'} direction={sort.dir} onClick={() => changeSort('concludedAt')}>Concluded</TableSortLabel></TableCell>
                  <TableCell />
                </TableRow>
              </TableHead>
              <TableBody>
                {sortedHistory.map((h) => {
                  const s = h.finalStats;
                  return (
                    <TableRow key={h.id} hover selected={tx?.id === h.id} onClick={() => openTranscript({ id: h.id, title: h.title, sessionId: h.sessionId, worktree: h.worktree, repo: h.repo })} sx={{ cursor: 'pointer' }}>
                      <TableCell>
                        {h.title}
                        {(h.tags || []).length > 0 && (
                          <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap', rowGap: 0.5, mt: 0.5 }}>
                            {h.tags.map((tag) => <Chip key={tag} size="small" label={tag} sx={{ height: 18, fontSize: 10 }} />)}
                          </Stack>
                        )}
                      </TableCell>
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
          {dock}
        </Stack>
      ) : (
        <Stack ref={dockRef} direction={side === 'right' ? 'row' : 'column'} spacing={0} sx={{ flex: 1, minHeight: 0 }}>
          <Stack direction="row" spacing={1} sx={{ flex: 1, minHeight: 0 }}>
          {COLUMNS.map(([col, label]) => {
            const cards = tasks.filter((t) => t.column === col && matchesTags(t));
            return (
              <Stack
                key={col}
                spacing={0.75}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => drop(col)}
                sx={(t) => ({
                  flex: 1, minWidth: 0, minHeight: 0,
                  borderRadius: `${getTokens(t).radius.sm}px`,
                  border: `1px solid ${getTokens(t).glass.stroke}`,
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
                    // Done cards open the transcript dock; a live session selects the
                    // terminal; a card whose session already exited (nothing to attach)
                    // also falls back to the transcript so it's still viewable.
                    const usesTx = col === 'done' || !(agent && LIVE_STATUS.has(agent.status));
                    const sel = usesTx ? tx?.id === task.id : task.sessionId === activeId;
                    const line = statsLine(stats?.[task.sessionId]);
                    const activate = () => (usesTx
                      ? openTranscript({ id: task.id, title: task.title, sessionId: task.sessionId, worktree: task.worktree, repo: task.repo })
                      : onSelect(task.sessionId));
                    return (
                      <Box
                        key={task.id}
                        draggable
                        onDragStart={() => setDragId(task.id)}
                        onDragEnd={() => setDragId(null)}
                        role="button"
                        tabIndex={0}
                        aria-label={task.title}
                        onClick={activate}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); } }}
                        sx={(t) => ({
                          p: 1, cursor: 'pointer', flexShrink: 0,
                          borderRadius: `${getTokens(t).radius.sm}px`,
                          border: `1px solid ${sel ? t.vars.palette.primary.main : getTokens(t).glass.stroke}`,
                          background: getTokens(t).glass.surface,
                          opacity: dragId === task.id ? 0.4 : 1,
                          '& .card-act': { opacity: 0 },
                          '&:hover .card-act': { opacity: 1 },
                        })}
                      >
                        <Stack direction="row" spacing={0.5} sx={{ alignItems: 'flex-start' }}>
                          <Typography variant="subtitle2" sx={{ flex: 1, minWidth: 0 }} noWrap>{task.title}</Typography>
                          <Stack direction="row" className="card-act" sx={{ transition: 'opacity .15s' }}>
                            {col === 'done' && (
                              <Tooltip title={task.branch ? 'Remove (temporary work folder already gone; your changes are saved)' : 'Remove (moves to history)'} disableInteractive>
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
                            <Tooltip title={task.branch ? 'Abandon task (deletes the temporary work folder, keeps your saved changes)' : 'Abandon task (leaves the work folder untouched)'} disableInteractive>
                              <IconButton
                                size="small"
                                sx={{ mt: -0.5, mr: -0.5 }}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  if (window.confirm(task.branch ? `Abandon task "${task.title}"? Its temporary work folder is deleted; your saved changes (branch ${task.branch}) are kept.` : `Abandon task "${task.title}"? Its work folder is left untouched.`)) onConclude(task.id, 'abandoned');
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
                          <Tooltip title="Active = time the agent spent working · API = time waiting on the AI model · tokens = amount of text processed" disableInteractive>
                            <Typography variant="code" sx={{ color: 'text.secondary', fontSize: 11, display: 'block' }} noWrap>
                              {line}
                            </Typography>
                          </Tooltip>
                        )}
                        <Stack direction="row" spacing={0.5} sx={{ mt: 0.5, flexWrap: 'wrap', rowGap: 0.5, alignItems: 'center' }}>
                          {task.state && <Chip size="small" label={task.state} sx={{ height: 20, fontSize: 11 }} />}
                          {(task.tags || []).map((tag) => <Chip key={tag} size="small" label={tag} sx={{ height: 20, fontSize: 11 }} />)}
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
          {dock}
        </Stack>
      )}
    </Stack>
  );
}
