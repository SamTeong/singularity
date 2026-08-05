import { getTokens } from '@/theme/contract.js';
import { brandGrad, brandGlow, surface2, stroke2, chipBg, trackColor, statusColor, focusRing, statePill, cardTag, PAPER_TOOLTIP_SLOTPROPS } from '@/shell/shellStyles.js';
import { useEffect, useRef, useState, useMemo } from 'react';
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
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import HorizontalSplitIcon from '@mui/icons-material/HorizontalSplit';
import StorageOutlinedIcon from '@mui/icons-material/StorageOutlined';
import VerticalSplitIcon from '@mui/icons-material/VerticalSplit';
import { StatusPill } from '@/components/StatusPill.jsx';
import TaskDetailPanel from '@/features/tasks/TaskDetailPanel.jsx';
import TranscriptView from '@/features/transcripts/TranscriptView.jsx';
import { repoName } from '@/lib/paths.js';
import { fmtUsd, fmtTokens } from '@/lib/format.js';
import { KIND } from '@/lib/agentStatus.js';
import { useResizable, ResizeHandle } from '@/hooks/useResizable.jsx';
import { useThemeSkin } from '@/theme/index.js';
import { Stamp, StatusLegend, SegmentBar, toneHue } from 'phosphor-console-theme/components';
import { getDomainState, DOMAIN_STATE_ORDER } from '@/lib/domainState.js';

const COLUMNS = [
  ['todo', 'To-Do'],
  ['inprogress', 'In Progress'],
  ['inreview', 'In Review'],
  ['done', 'Done'],
];

// Column → shared domain-state id (design.md D4) for the Phosphor tone/bilingual
// mapping: todo≈queued/idle, inprogress≈running/nominal, inreview≈review/caution,
// done≈done/merged. TaskDetailPanel's STAGES mirrors this exact correspondence so
// a task's tone reads identically on the board and in its dossier.
const COLUMN_DOMAIN = { todo: 'queued', inprogress: 'running', inreview: 'review', done: 'done' };

// The card-top status pill's legacy 4-value vocabulary (`lib/agentStatus.js`'s
// KIND map, which StatusPill also consumes) mapped onto a DomainStateId for the
// Phosphor card-edge/stamp tone — mirrors StatusPill.jsx's own (private,
// unexported) STATUS_TO_DOMAIN. Kept local rather than duplicating the shared
// domain table itself (`lib/domainState.js`), which this only reads from.
const AGENT_KIND_TO_DOMAIN = { done: 'done', active: 'running', review: 'review', error: 'failed' };

// A card's resting domain-state id: a live agent's own state takes priority
// over the column's resting tone — the same precedence the top-row StatusPill
// (agent status vs. task.state chip) already uses.
const cardDomainId = (task, agent) =>
  agent ? (AGENT_KIND_TO_DOMAIN[KIND[agent.status]] ?? 'review') : (COLUMN_DOMAIN[task.column] ?? 'queued');

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

// layout-02 column-dot colours — a status-ish marker per column (`.col-dot`:
// ink-3 queued · info in-progress · brand review · ok done). ZAPAC-only — the
// Phosphor column head reads its tone from COLUMN_DOMAIN/getDomainState instead
// (see the head render below), so this stays out of the dot's phosphor branch.
const COL_DOT = { todo: 'text.disabled', inprogress: 'info.main', inreview: 'primary.main', done: 'success.main' };

// Segmented-control (Board | History) button styling. `on` marks the active
// segment: surface-solid fill, primary ink, and the card shadow per .seg .on.
// Both buttons stay role=button with aria-pressed so the e2e (getByRole 'Board'
// / 'History') keeps matching — NOT MUI ToggleButton/Tab.
const segBtn = (t, on) => {
  const g = getTokens(t);
  return {
    px: '14px', py: '6px', minWidth: 0, minHeight: 27, borderRadius: 999,
    fontSize: 12, fontWeight: 700, lineHeight: 1.2, letterSpacing: 0,
    color: 'text.disabled', textTransform: 'none',
    border: 'none', boxShadow: 'none', background: 'transparent',
    ...(on && {
      background: t.vars.palette.background.paper,
      color: 'text.primary',
      boxShadow: g.glass.cardShadow,
    }),
    '&:hover': { background: on ? t.vars.palette.background.paper : 'transparent', boxShadow: on ? g.glass.cardShadow : 'none' },
    '&.Mui-focusVisible': focusRing(t),
  };
};

// Gradient primary action (.btn-primary) — brand-grad fill, white ink, soft
// brand glow, hover lift + stronger glow, focus ring on keyboard focus.
const primaryBtn = (t) => {
  const glow = brandGlow(t);
  return {
    borderRadius: 999, px: '18px', py: '7px', minHeight: 38,
    background: brandGrad(t), color: '#fff',
    fontWeight: 700, fontSize: 13, textTransform: 'none', lineHeight: 1.2,
    border: 'none',
    boxShadow: `0 14px 34px -12px ${glow}`,
    transition: 'transform .18s ease, box-shadow .18s ease',
    '&:hover': { transform: 'translateY(-2px)', boxShadow: `0 20px 44px -14px ${glow}`, background: brandGrad(t) },
    '&.Mui-focusVisible': focusRing(t),
    '&:active': { transform: 'translateY(0)' },
    // The hover lift + glow intensify are motion — suppress the transform under
    // reduced motion (DESIGN §6 "give every animation a prefers-reduced-motion
    // end-state fallback"); keep the shadow/bg colour change, which isn't motion.
    '@media (prefers-reduced-motion: reduce)': { transition: 'none', '&:hover': { transform: 'none' }, '&:active': { transform: 'none' } },
  };
};

// Tag-filter chip (.tag) — mono, surface2/chip bg, stroke2 border, pill;
// selected → brand border + stronger tint.
const tagChip = (t, on) => ({
  height: 22, fontSize: 11, fontWeight: 700, borderRadius: 999,
  fontFamily: (tt) => tt.typography?.code?.fontFamily ?? 'ui-monospace, monospace',
  background: on ? chipBg(t) : surface2(t),
  border: `1px solid ${on ? t.vars.palette.primary.main : stroke2(t)}`,
  color: 'text.secondary',
  '&:hover': { background: chipBg(t) },
});

// Count chip at the right of a column header (`.col-count` — ink-3 on `--chip`).
// The mock's chip fill composites over its ambient glow, which sits behind the
// main panel there; ours has no glow behind that corner, so bare chipBg(t)
// lands ~12 RGB units darker than the mockup. chipBg is shared broadly (focus
// rings, hover fills, tag chips) so we don't bump that token — we tint just
// this fill with a little primary, the same color-mix idiom Sidebar.jsx uses
// for its active nav-item fill. Ink stays ink-3 per `.col-count`.
const countChip = (t) => ({
  ml: 'auto', flexShrink: 0,
  fontSize: 11, fontWeight: 700, lineHeight: 1.45,
  color: 'text.disabled',
  background: `color-mix(in srgb, ${t.vars.palette.primary.main} 12%, ${chipBg(t)})`,
  px: '9px', py: '2px', borderRadius: 999,
});

// ── Phosphor-only chrome (tasks 5.1–5.3) ──────────────────────────────────────
// Hard-edged console equivalents of the ZAPAC helpers above, applied only when
// `phosphor` (skinId === 'phosphor') is true at each call site below — every
// ZAPAC branch keeps calling the original helper unchanged, so its rendered
// output stays byte-for-byte identical. These read `t.nerv.*` directly, which
// is only safe inside that phosphor-gated branch (ZAPAC's theme has no `nerv`).
const segBtnPhosphor = (t, on) => ({
  px: '14px', py: '6px', minWidth: 0, minHeight: 27, borderRadius: 0,
  fontSize: 11, fontWeight: 700, letterSpacing: '.06em', lineHeight: 1.2,
  fontFamily: t.nerv.fonts.mono,
  border: `1px solid ${t.nerv.hue.mint}`,
  color: on ? t.nerv.hue.void : t.nerv.hue.mint,
  background: on ? t.nerv.hue.mint : 'transparent',
  boxShadow: 'none',
  '&:hover': { background: on ? t.nerv.hue.mint : 'rgba(82,242,154,.1)' },
  '&.Mui-focusVisible': { outline: `2px dashed ${t.nerv.hue.amber}`, outlineOffset: 2 },
});

// Tag *filter* chip (topbar row) — the vendored FilterChips grammar: orange
// scope chip, solid inversion when active.
const tagChipPhosphor = (t, on) => ({
  height: 22, fontSize: 10, fontWeight: on ? 700 : 400, borderRadius: 0,
  letterSpacing: '.04em', fontFamily: t.nerv.fonts.mono,
  background: on ? t.nerv.hue.orange : 'transparent',
  color: on ? t.nerv.hue.void : t.nerv.hue.orange,
  border: `1px solid ${t.nerv.hue.orange}`,
  '& .MuiChip-deleteIcon': { color: on ? t.nerv.hue.void : t.nerv.hue.orange },
  '&:hover': { background: on ? t.nerv.hue.orange : 'rgba(242,100,0,.12)' },
});

// Read-only card/detail *tag* chip (`.tag` — dim green outline, never orange:
// a category label isn't a chrome-level scope control).
const cardTagPhosphor = (t) => ({
  height: 18, fontSize: 9, borderRadius: 0, letterSpacing: '.04em',
  fontFamily: t.nerv.fonts.mono,
  border: `1px solid ${t.nerv.hue.greenDim}`, color: t.nerv.hue.greenMap, background: 'transparent',
});

export default function TasksBoard({ tasks, history, agents, stats, onSelect, onAdd, onMove, onConclude, onDeleteHistory }) {
  const { skinId } = useThemeSkin();
  const phosphor = skinId === 'phosphor';
  const [dragId, setDragId] = useState(null);
  const [showHistory, setShowHistory] = useState(false);
  const [activeTags, setActiveTags] = useState(() => new Set());
  // Detail panel: a card click opens the right-sliding sheet instead of the
  // transcript dock / terminal select. State is the open task's ID only — the
  // task object is re-derived from `tasks` each render, so the panel reflects
  // live stat/status updates and a different card swaps content (one panel, not
  // two). When the open task leaves the board (concluded, moved to history, or
  // removed) it drops out of `tasks`, so the lookup goes null and the panel
  // unmounts on its own — no closing effect, no stale snapshot to sync.
  const [detailId, setDetailId] = useState(null);
  const liveDetailTask = useMemo(
    () => (detailId ? tasks.find((t) => t.id === detailId) ?? null : null),
    [tasks, detailId],
  );
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

  // Live subtitle for the view topbar: task count + count of agents currently
  // in a live state (starting/running/idle).
  const runningCount = agents.filter((a) => LIVE_STATUS.has(a.status)).length;

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
  const { width: panelH, startDrag: startPanelHeightDrag, onKeyDown: onPanelHeightKeyDown, dragging: panelHeightDragging, max: panelHMax } = useResizable('sing-hist-h', 300, { min: 140, max: 2000, axis: 'y', containerRef: dockRef });
  const [panelWidthDragging, setPanelWidthDragging] = useState(false); // width-drag is bespoke (see below), so it tracks its own dragging flag
  const panelWidthUpRef = useRef(null); // active pointerup cleanup for the bespoke width-drag, so an unmount mid-drag can cancel it
  const PANEL_W_MAX = 1600; // static ceiling — matches the panelW state initializer's clamp
  // Dynamic ceiling (dockRef's own width, minus the 200px floor) for the drag
  // clamp — reads `dockRef.current`, so it's only called from an event handler
  // (react-hooks/refs forbids a ref read during render).
  const panelWidthMax = () => { const rect = dockRef.current?.getBoundingClientRect(); return rect ? rect.width - 200 : PANEL_W_MAX; };
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
    setPanelWidthDragging(true);
    document.body.classList.add('resizing');
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const move = (ev) => {
      const w = Math.min(rect.width - 200, Math.max(200, rect.right - ev.clientX));
      setPanelW(w);
      localStorage.setItem('sing-hist-w', String(Math.round(w)));
    };
    const up = () => {
      setPanelWidthDragging(false);
      document.body.classList.remove('resizing');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      panelWidthUpRef.current = null;
    };
    panelWidthUpRef.current = up;
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  // Cancel an in-flight width-drag if the handle unmounts mid-drag (side/panelMin toggle).
  useEffect(() => () => panelWidthUpRef.current?.(), []);
  // Keyboard mirror of the drag above — ArrowLeft widens (dragging the handle
  // away from the panel's right edge always grows it), ArrowRight narrows. Reads
  // `panelW` from the closure (like useResizable's own onKeyDown) rather than a
  // setState updater, which must stay pure under StrictMode's double-invoke.
  const onPanelWidthKeyDown = (e) => {
    let d = 0;
    if (e.key === 'ArrowLeft') d = 16; else if (e.key === 'ArrowRight') d = -16;
    if (!d) return;
    e.preventDefault();
    const next = Math.min(panelWidthMax(), Math.max(200, panelW + d));
    localStorage.setItem('sing-hist-w', String(Math.round(next)));
    setPanelW(next);
  };
  const startPanelDrag = side === 'bottom' ? startPanelHeightDrag : startPanelWidthDrag;
  const onPanelKeyDown = side === 'bottom' ? onPanelHeightKeyDown : onPanelWidthKeyDown;
  const panelDragging = side === 'bottom' ? panelHeightDragging : panelWidthDragging;
  const panelDragValue = side === 'bottom' ? panelH : panelW;
  const panelDragMin = side === 'bottom' ? 140 : 200;
  const panelDragMax = side === 'bottom' ? panelHMax : PANEL_W_MAX;

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
      {/* Drag handle — resize the panel (hidden while minimized). Same grip +
          a11y + keyboard treatment as the dock/list handles (layout-02
          `.dock-handle`/`.list-handle`). */}
      {!panelMin && (
        <ResizeHandle
          axis={side === 'bottom' ? 'y' : 'x'}
          onPointerDown={startPanelDrag}
          onKeyDown={onPanelKeyDown}
          dragging={panelDragging}
          value={panelDragValue}
          min={panelDragMin}
          max={panelDragMax}
          label="Resize transcript panel"
          sx={side === 'bottom' ? { mx: 1 } : { my: 1 }}
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
    <Stack sx={{ height: '100%' }}>
      {/* layout-02 `.topbar`: 16px/22px, hairline rule under it, actions right. */}
      <Stack
        direction="row"
        spacing={2}
        sx={(t) => ({
          alignItems: 'center', flexWrap: 'wrap', rowGap: 1.5, flexShrink: 0,
          px: '22px', py: '16px', borderBottom: `1px solid ${stroke2(t)}`,
        })}
      >
        <Box sx={{ minWidth: 0, flex: '1 1 auto' }}>
          {/* h3 for the display face; `.view-title` tracks/leads tighter than the
              variant's -0.01em/1.2, so those two stay explicit. Phosphor pairs it
              with the bilingual "任務" caption (design.md's bimodal type rule) —
              added only inside this element, so ZAPAC's rendered text/DOM never
              changes (`{phosphor && …}` is a no-op there). */}
          <Typography variant="h3" sx={{ letterSpacing: '-0.02em', lineHeight: 1 }}>
            Tasks
            {phosphor && (
              <Box component="span" sx={(t) => ({ ml: 1.25, fontFamily: t.nerv.fonts.jp, fontWeight: 800, fontSize: 18, color: t.nerv.hue.orange, letterSpacing: '.16em' })}>
                任務
              </Box>
            )}
          </Typography>
          <Typography sx={(t) => (phosphor
            ? { fontSize: 11, color: t.nerv.hue.greenMap, fontFamily: t.nerv.fonts.mono, letterSpacing: '.08em', mt: 0.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }
            : { fontSize: 12, color: 'text.disabled', mt: 0.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' })}
          >
            {phosphor ? <>ORCHESTRATED:{tasks.length} · RUNNING:{runningCount}</> : <>{tasks.length} tasks · {runningCount} running</>}
          </Typography>
        </Box>
        <Box sx={{ ml: 'auto', display: 'flex', alignItems: 'center', gap: 1.25, flexShrink: 0 }}>
          {/* Segmented Board|History control — two plain Buttons (role=button)
              with aria-pressed, NOT ToggleButton/Tab, so the e2e role/name
              matches stay exact. Both buttons always visible. */}
          <Box sx={(t) => (phosphor
            ? { display: 'flex', border: `1px solid ${t.nerv.hue.mint}` }
            : { display: 'flex', background: surface2(t), border: `1px solid ${stroke2(t)}`, borderRadius: 999, p: '3px' })}
          >
            <Button variant="text" color="inherit" size="small" disableElevation aria-pressed={!showHistory} onClick={() => setShowHistory(false)} sx={(t) => (phosphor ? segBtnPhosphor(t, !showHistory) : segBtn(t, !showHistory))}>Board</Button>
            <Button variant="text" color="inherit" size="small" disableElevation aria-pressed={showHistory} onClick={() => setShowHistory(true)} sx={(t) => (phosphor ? segBtnPhosphor(t, showHistory) : segBtn(t, showHistory))}>History</Button>
          </Box>
          {/* Phosphor: drop the ZAPAC gradient-pill sx entirely and let the
              vendored theme's own `contained` Button override (mint outline,
              fills mint on hover, hard corners, uppercase) carry the button —
              design.md D2 prefers the stock MUI override over a hand-rolled one. */}
          <Button size="small" startIcon={<AddIcon />} onClick={onAdd} sx={(t) => (phosphor ? {} : primaryBtn(t))}>New task</Button>
        </Box>
      </Stack>
      {/* Phosphor-only bilingual status legend (task 5.1) — the centralized
          lifecycle mapping (`lib/domainState.js`), not a second copy of its
          labels/tones. Uses the vendored StatusLegend, which reads `theme.nerv`
          directly, so it must never render under ZAPAC (no `nerv` on that theme). */}
      {phosphor && (
        <Box sx={{ px: '22px', pt: '14px', flexShrink: 0 }}>
          <StatusLegend
            items={DOMAIN_STATE_ORDER.map((id) => {
              const d = getDomainState(id);
              return { jp: d.jp, en: d.en, tone: d.tone, filled: d.filled };
            })}
          />
        </Box>
      )}
      {allTags.length > 0 && (
        <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap', rowGap: 0.5, alignItems: 'center', flexShrink: 0, px: '22px', pt: '14px' }}>
          {allTags.map((tag) => {
            const on = activeTags.has(tag);
            return (
              <Chip
                key={tag}
                size="small"
                label={tag}
                variant="outlined"
                onClick={() => toggleTag(tag)}
                onDelete={on ? () => toggleTag(tag) : undefined}
                sx={(t) => (phosphor ? tagChipPhosphor(t, on) : tagChip(t, on))}
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
              sx={(t) => (phosphor
                ? { height: 22, fontSize: 10, fontWeight: 700, borderRadius: 0, letterSpacing: '.04em', fontFamily: t.nerv.fonts.mono, background: 'transparent', border: `1px solid ${t.nerv.hue.greenDim}`, color: t.nerv.hue.greenMap, ml: 0.5, '&:hover': { borderColor: t.nerv.hue.mint, color: t.nerv.hue.mint } }
                : { height: 22, fontSize: 11, fontWeight: 700, borderRadius: 999, fontFamily: (tt) => tt.typography?.code?.fontFamily ?? 'ui-monospace, monospace', background: 'transparent', border: `1px solid ${stroke2(t)}`, color: 'text.disabled', ml: 0.5, '&:hover': { background: surface2(t) } })}
            />
          )}
        </Stack>
      )}
      {showHistory ? (
        <Stack ref={dockRef} direction={side === 'right' ? 'row' : 'column'} spacing={0} sx={{ flex: 1, minHeight: 0, px: '10px', pt: '6px', pb: '12px' }}>
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
        // layout-02 `.board`: 18px/22px padding, 16px between columns.
        <Stack ref={dockRef} direction={side === 'right' ? 'row' : 'column'} spacing={0} sx={{ flex: 1, minHeight: 0, px: '22px', py: '18px' }}>
          <Stack direction="row" spacing={2} sx={{ flex: 1, minHeight: 0 }}>
          {COLUMNS.map(([col, label]) => {
            const cards = tasks.filter((t) => t.column === col && matchesTags(t));
            const colDom = getDomainState(COLUMN_DOMAIN[col]);
            return (
              // No column chrome — `.col` is a bare flex column; the containment
              // comes from the view's glass pane, not a per-column border. Width
              // tracks the mockup's 270px lane rather than stretching: past ~340px
              // the head's dot and its right-aligned count drift apart and the
              // column stops reading as a lane.
              <Stack
                key={col}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => drop(col)}
                sx={{ flex: '1 1 0', minWidth: 0, maxWidth: 340, minHeight: 0 }}
              >
                {/* `.col-head` — dot + uppercase label, count chip pushed right.
                    The count keeps its parens INSIDE the chip so the header's text
                    content stays exactly "<Label> (<n>)" for tasks.spec.mjs. The
                    count element itself swaps to a vendored Stamp under Phosphor
                    (still rendering exactly "(<n>)", so the enclosing Typography's
                    accessible text is unchanged either way) — task 5.2. */}
                <Typography
                  component="div"
                  sx={{
                    display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0,
                    pt: '2px', px: '6px', pb: '12px',
                    fontSize: 12, fontWeight: 700, letterSpacing: '.1em',
                    textTransform: 'uppercase', color: 'text.secondary',
                  }}
                >
                  {!phosphor && <Box component="span" sx={{ width: 9, height: 9, borderRadius: '50%', flexShrink: 0, bgcolor: COL_DOT[col] }} />}
                  {label}{' '}
                  {phosphor
                    ? <Stamp tone={colDom.tone} filled={colDom.filled} size="sm">({cards.length})</Stamp>
                    : <Box component="span" sx={(t) => countChip(t)}>({cards.length})</Box>}
                </Typography>
                {/* Bilingual column caption (task 5.2) — a separate line below the
                    accessible header above, so it never touches that element's
                    exact "<Label> (<n>)" text. */}
                {phosphor && (
                  <Typography sx={(t) => ({ px: '6px', mt: '-8px', pb: '10px', display: 'flex', alignItems: 'baseline', gap: '6px', color: toneHue(t, colDom.tone) })}>
                    <Box component="span" sx={(t) => ({ fontFamily: t.nerv.fonts.jp, fontWeight: 800, fontSize: 13 })}>{colDom.jp}</Box>
                    <Box component="span" sx={(t) => ({ fontFamily: t.nerv.fonts.mono, fontSize: 9, letterSpacing: '.1em', color: t.nerv.hue.greenMap })}>{colDom.en}</Box>
                  </Typography>
                )}
                {/* Card list scrolls inside the column when it outgrows the pane. */}
                <Stack spacing="11px" sx={(t) => ({
                  flex: 1, minHeight: 0, overflowY: 'auto',
                  pt: '2px', px: '4px', pb: '8px',
                  '&::-webkit-scrollbar': { width: 8 },
                  '&::-webkit-scrollbar-thumb': { background: trackColor(t), borderRadius: 8 },
                })}>
                  {cards.map((task) => {
                    const agent = agents.find((a) => a.id === task.sessionId);
                    const dom = getDomainState(cardDomainId(task, agent));
                    // Board card click now opens the right-sliding detail panel
                    // (the panel's "Open session"/"View transcript" actions re-home
                    // what the card click used to do directly). Done cards and
                    // dead-session cards that previously fell back to the
                    // transcript dock all open the panel too — "View transcript"
                    // there reaches the same dock.
                    const sel = detailId === task.id;
                    const s = stats?.[task.sessionId];
                    const line = statsLine(s);
                    const cost = fmtUsd(s?.costUsd);
                    // `.tcard.live` — a live session tints the card's edge toward info.
                    const live = agent && LIVE_STATUS.has(agent.status);
                    const activate = () => setDetailId(task.id);
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
                        sx={(t) => {
                          const g = getTokens(t);
                          const edge = phosphor
                            ? (sel ? t.nerv.hue.mint : toneHue(t, dom.tone))
                            : (sel
                              ? t.vars.palette.primary.main
                              : live
                                ? `color-mix(in srgb, ${statusColor(t, 'info')} 55%, ${g.glass.stroke})`
                                : g.glass.stroke);
                          return {
                            p: '14px', cursor: 'grab', flexShrink: 0,
                            borderRadius: phosphor ? 0 : `${g.radius.md ?? g.radius.sm}px`,
                            border: `${phosphor && sel ? 2 : 1}px solid ${edge}`,
                            background: phosphor ? t.nerv.hue.void : g.glass.surface,
                            boxShadow: phosphor ? 'none' : g.glass.cardShadow,
                            opacity: dragId === task.id ? 0.4 : 1,
                            transition: phosphor ? 'none' : 'transform .18s ease, border-color .18s ease, box-shadow .18s ease',
                            '&:hover': phosphor ? { borderColor: t.nerv.hue.mint } : { transform: 'translateY(-2px)', borderColor: t.vars.palette.primary.main },
                            // Compose the focus ring ON TOP of the card's elevation — spreading
                            // focusRing alone would replace cardShadow and flatten the card on
                            // keyboard focus. Keep the lift, add the ring.
                            '&:focus-visible': phosphor
                              ? { outline: `2px dashed ${t.nerv.hue.amber}`, outlineOffset: 2 }
                              : { boxShadow: `${g.glass.cardShadow}, 0 0 0 3px ${chipBg(t)}`, borderColor: t.vars.palette.primary.main },
                            '@media (prefers-reduced-motion: reduce)': { transition: 'none', '&:hover': { transform: 'none' } },
                            '& .card-act': { opacity: 0 },
                            '&:hover .card-act': { opacity: 1 },
                            ...(sel && !phosphor && { boxShadow: `${g.glass.cardShadow}, 0 0 0 2px ${chipBg(t)}`, borderColor: t.vars.palette.primary.main }),
                          };
                        }}
                      >
                        {/* Top row: status pill (live agent → StatusPill, else a
                            task.state chip) + mono task-id, mirroring .tcard-top. */}
                        <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center', mb: '9px' }}>
                          {agent
                            ? <StatusPill status={KIND[agent.status] ?? 'review'}>{agent.status}</StatusPill>
                            : (task.state && (phosphor
                              ? <Stamp tone={dom.tone} filled={dom.filled} size="sm">{task.state}</Stamp>
                              : <Chip size="small" label={task.state} sx={(t) => statePill(t)} />))}
                          <Typography variant="code" sx={(t) => (phosphor
                            ? { ml: 'auto', fontSize: 10, color: t.nerv.hue.amber, fontFamily: t.nerv.fonts.mono, letterSpacing: '.06em' }
                            : { ml: 'auto', fontSize: 11, color: 'text.disabled' })}>
                            #{task.id.slice(-4)}
                          </Typography>
                        </Stack>
                        <Stack direction="row" spacing={0.5} sx={{ alignItems: 'flex-start' }}>
                          {/* `.tcard-title` wraps rather than truncating — a task title
                              is the card's payload, and two lines beat an ellipsis. */}
                          <Typography variant="subtitle2" sx={{ flex: 1, minWidth: 0, fontWeight: 700, fontSize: 14, lineHeight: 1.35, letterSpacing: '-.01em' }}>{task.title}</Typography>
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
                        {/* `.tcard-repo` — repo icon + mono "<repo> · <branch>". */}
                        <Stack direction="row" spacing="6px" sx={{ alignItems: 'center', mt: '10px', minWidth: 0 }}>
                          <StorageOutlinedIcon sx={{ fontSize: 13, opacity: 0.8, color: 'text.secondary', flexShrink: 0 }} />
                          <Typography variant="code" sx={(t) => (phosphor
                            ? { color: t.nerv.hue.greenMap, fontSize: 10, minWidth: 0, fontFamily: t.nerv.fonts.mono, letterSpacing: '.04em' }
                            : { color: 'text.secondary', fontSize: 11, minWidth: 0 })} noWrap>
                            {repoName(task.repo)}{task.branch ? ` · ${task.branch}` : ''}
                          </Typography>
                        </Stack>
                        {/* `.tcard-foot` — tags left, spend right. The fuller
                            active/API/token breakdown rides along in the tooltip
                            rather than crowding a 270px card. */}
                        {phosphor && s?.turns > 0 && task.orchestratorMaxTurns > 0 && (
                          <Box sx={{ mt: '10px' }}>
                            <SegmentBar
                              value={Math.min(100, Math.round((s.turns / task.orchestratorMaxTurns) * 100))}
                              tone={dom.tone}
                              height={5}
                              sx={{ width: '100%' }}
                            />
                            <Typography sx={(t) => ({ mt: '3px', fontSize: 9, color: t.nerv.hue.greenMap, fontFamily: t.nerv.fonts.mono, letterSpacing: '.04em' })}>
                              {s.turns}/{task.orchestratorMaxTurns} TURNS
                            </Typography>
                          </Box>
                        )}
                        {((task.tags || []).length > 0 || cost) && (
                          <Stack direction="row" spacing="8px" sx={{ mt: '11px', alignItems: 'center' }}>
                            <Stack direction="row" spacing="6px" sx={{ flexWrap: 'wrap', rowGap: '6px', alignItems: 'center', minWidth: 0 }}>
                              {(task.tags || []).map((tag) => <Chip key={tag} size="small" label={tag} sx={(t) => (phosphor ? cardTagPhosphor(t) : cardTag(t))} />)}
                            </Stack>
                            {cost && (
                              <Tooltip title={`${line || cost}\nActive = time the agent spent working · API = time waiting on the AI model · tokens = amount of text processed`} disableInteractive slotProps={PAPER_TOOLTIP_SLOTPROPS}>
                                <Typography variant="code" sx={(t) => (phosphor
                                  ? { ml: 'auto', flexShrink: 0, fontSize: 10, fontWeight: 500, color: t.nerv.hue.amber, fontFamily: t.nerv.fonts.mono }
                                  : { ml: 'auto', flexShrink: 0, fontSize: 11, fontWeight: 500, color: 'text.secondary' })}>
                                  {cost}
                                </Typography>
                              </Tooltip>
                            )}
                          </Stack>
                        )}
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
      {/* Right-sliding detail panel — one at a time, driven by the live task
          (liveDetailTask is null when the open task leaves the board, which the
          effect above turns into a close). Rendered last so it overlays above
          the board columns + the transcript dock regardless of dock side. */}
      {liveDetailTask && (
        <TaskDetailPanel
          task={liveDetailTask}
          agent={agents.find((a) => a.id === liveDetailTask.sessionId)}
          stats={stats}
          onSelect={onSelect}
          onViewTranscript={openTranscript}
          onClose={() => setDetailId(null)}
        />
      )}
    </Stack>
  );
}
