import { getTokens } from '@/theme/contract.js';
import { brandGrad, brandGlow, surface2, stroke2, chipBg, trackColor, statusColor, focusRing, statePill, cardTag, PAPER_TOOLTIP_SLOTPROPS } from '@/shell/shellStyles.js';
import { useRef, useState, useMemo } from 'react';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import Chip from '@mui/material/Chip';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import Drawer from '@mui/material/Drawer';
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
import StorageOutlinedIcon from '@mui/icons-material/StorageOutlined';
import { StatusPill } from '@/components/StatusPill.jsx';
import TaskDetailPanel from '@/features/tasks/TaskDetailPanel.jsx';
import TranscriptView from '@/features/transcripts/TranscriptView.jsx';
import { repoName } from '@/lib/paths.js';
import { fmtUsd, fmtTokens } from '@/lib/format.js';
import { KIND } from '@/lib/agentStatus.js';
import { useThemeSkin } from '@/theme/index.js';
import { Stamp, StatusLegend, SegmentBar, toneHue } from 'phosphor-console-theme/components';
import { getDomainState, DOMAIN_STATE_ORDER } from '@/lib/domainState.js';
import { COLUMNS, COLUMN_DOMAIN, cardDomainId } from '@/features/tasks/taskDomain.js';

// Read the reduced-motion preference once at mount for the transcript sheet —
// mirrors TaskDetailPanel.jsx's own helper (kept local rather than shared: a
// one-line media-query read isn't worth a new shared module).
const prefersReducedMotion = () =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false;

// Column-head inner-row cap (task 1) — see the column-head comment below for
// why this exists.
const COL_HEAD_MAX_W = 340;

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
// `height` (not `minHeight`) — box-sizing:border-box (CssBaseline) means an
// explicit height lands at the same rendered box regardless of border width,
// which minHeight can't guarantee against the New Task button's own 2px
// `contained`-variant border (fix 1: shared control height under Phosphor).
const PHOSPHOR_CONTROL_H = 32;
const segBtnPhosphor = (t, on) => ({
  px: '14px', py: '6px', minWidth: 0, height: PHOSPHOR_CONTROL_H, borderRadius: 0,
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
//
// Fixed defect (design.md D4 — active/selected controls invert to void
// content on their fill): this Chip never sets a `color` prop, so it falls
// back to the vendored theme's `MuiChip.defaultProps.color = 'success'`,
// which stamps a `.MuiChip-colorSuccess` class carrying its own
// `{ color: hue.mint }` rule (phosphor-console-theme/theme/components/
// dataDisplay.ts). That selector chains the chip's root class with
// `.MuiChip-colorSuccess` (two classes) against this sx's single emotion
// class, so it always wins on specificity regardless of source order — the
// active chip rendered mint text on its orange fill instead of the required
// void inversion. Re-declaring the same two-class selector here (plus
// `!important`, since equal-specificity ordering isn't guaranteed) restores
// the intended void/orange text without touching the vendored theme.
//
// Fragility note: this is pinned against `phosphor-console-theme@0.1.0`
// (vendor/phosphor-console-theme-0.1.0.tgz — see package.json). If that
// package is ever upgraded and the active tag chip goes back to mint-on-
// orange, check `theme/components/dataDisplay.ts`'s `MuiChip` override first
// — either `defaultProps.color` changed away from `'success'`, or the
// `.MuiChip-colorSuccess` rule's own selector/specificity changed, and this
// override needs updating (or dropping, if MUI's `color` prop is set
// explicitly instead — see whether that's now viable).
const tagChipPhosphor = (t, on) => ({
  height: 22, fontSize: 10, fontWeight: on ? 700 : 400, borderRadius: 0,
  letterSpacing: '.04em', fontFamily: t.nerv.fonts.mono,
  background: on ? t.nerv.hue.orange : 'transparent',
  color: on ? t.nerv.hue.void : t.nerv.hue.orange,
  border: `1px solid ${t.nerv.hue.orange}`,
  '&.MuiChip-colorSuccess': { color: `${on ? t.nerv.hue.void : t.nerv.hue.orange} !important` },
  '& .MuiChip-deleteIcon': { color: on ? t.nerv.hue.void : t.nerv.hue.orange },
  '&:hover': { background: on ? t.nerv.hue.orange : 'rgba(242,100,0,.12)' },
});

// Read-only card/detail *tag* chip (`.tag` — dim green outline, never orange:
// a category label isn't a chrome-level scope control).
//
// Same `.MuiChip-colorSuccess` specificity defect as `tagChipPhosphor` above
// (see its comment): no `color` prop is passed, so the vendored theme's
// `MuiChip.defaultProps.color = 'success'` applies and its two-class
// `.MuiChip-colorSuccess` rule (mint) beats this single-class `sx` override
// regardless of source order. Without the same `!important` re-declaration,
// this chip renders mint instead of the intended dim green.
const cardTagPhosphor = (t) => ({
  height: 18, fontSize: 9, borderRadius: 0, letterSpacing: '.04em',
  fontFamily: t.nerv.fonts.mono,
  border: `1px solid ${t.nerv.hue.greenDim}`, color: t.nerv.hue.greenMap, background: 'transparent',
  '&.MuiChip-colorSuccess': { color: `${t.nerv.hue.greenMap} !important` },
});

/**
 * TranscriptSheet — a read-only transcript viewer opened from a History table
 * row, or handed off from TaskDetailPanel's "View transcript" action. Built on
 * the same right-sliding-glass-sheet-over-scrim system as TaskDetailPanel (MUI
 * Drawer, `anchor="right"`, scrim, close affordances, entrance motion) so the
 * two right-hand sheets in this feature read as one system, not two competing
 * overlay idioms — but deliberately wider: it hosts a wall of `pre-wrap`
 * monospace transcript content (messages, tool I/O) that wraps hard at
 * TaskDetailPanel's metadata-panel width, so it scales up through the sm–lg
 * breakpoints instead of matching. Replaces the old dockable/resizable/
 * collapsible transcript panel entirely — no side, no minimize, no
 * drag-resize; just open, read, close.
 *
 * @param {object} props
 * @param {{id:string,title:string,sessionId?:string}} props.item The generic
 *   item threaded through TasksBoard's `openTranscript` (a History row or a
 *   task handed off from TaskDetailPanel).
 * @param {boolean} props.loading
 * @param {string|null} props.error
 * @param {object|null} props.transcript `{ messages: [...] }` once loaded.
 * @param {()=>void} props.onClose Close the sheet (close button / scrim / Esc).
 */
function TranscriptSheet({ item, loading, error, transcript, onClose }) {
  const { skinId } = useThemeSkin();
  const phosphor = skinId === 'phosphor';
  const reduced = prefersReducedMotion();

  return (
    <Drawer
      open
      anchor="right"
      onClose={onClose}
      disablePortal={false}
      // Collapsing the slide transition to 0 lets the open/close state change
      // still occur under reduced motion without animating the sheet — same
      // treatment as TaskDetailPanel.
      transitionDuration={reduced ? 0 : undefined}
      slotProps={{
        paper: {
          role: 'dialog',
          'aria-label': 'Transcript',
          sx: (t) => (phosphor
            ? {
              // Phosphor — same chamfered void dossier treatment as
              // TaskDetailPanel's phosphor sheet, but wider: transcript
              // content is monospace and wraps hard at the detail panel's
              // 400px, so this scales up through sm–lg instead of matching.
              width: { xs: '92vw', sm: 560, md: 720, lg: 860 },
              maxWidth: '90vw',
              background: t.nerv.hue.void,
              backgroundImage: 'none',
              display: 'flex', flexDirection: 'column', overflow: 'hidden',
              border: 'none',
              borderLeft: `1px solid ${t.nerv.hue.orange}`,
              borderRadius: 0,
              clipPath: t.nerv.chamfer(),
              boxShadow: 'none',
            }
            : {
              // ZAPAC — `.detail`'s opaque surface-solid sheet, same shadow
              // language as TaskDetailPanel but wider: transcript content is
              // monospace and wraps hard at the detail panel's 400px, so
              // this scales up through sm–lg instead of matching.
              width: { xs: '92vw', sm: 560, md: 720, lg: 860 },
              maxWidth: '90vw',
              background: t.vars.palette.background.paper,
              backgroundImage: 'none',
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
              border: 'none',
              borderLeft: `1px solid ${getTokens(t).glass.stroke}`,
              borderRadius: 0,
              boxShadow: '-30px 0 70px -34px rgba(40,20,60,.55)',
            }),
        },
        backdrop: {
          'aria-hidden': true,
          sx: { background: 'rgba(10,6,20,.34)' },
        },
      }}
    >
      {phosphor ? (
        <>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center', px: '16px', pt: '14px', flexShrink: 0 }}>
            <Typography sx={(t) => ({ flex: 1, minWidth: 0, fontSize: 10, color: t.nerv.hue.orange, fontFamily: t.nerv.fonts.mono, letterSpacing: '.1em' })}>
              記録 · TRANSCRIPT
            </Typography>
            <IconButton size="small" aria-label="Close" onClick={onClose} sx={(t) => ({ color: t.nerv.hue.orange, '&:hover': { color: t.nerv.hue.mint }, '&.Mui-focusVisible': { outline: `2px dashed ${t.nerv.hue.amber}`, outlineOffset: 2 } })}>
              <CloseIcon fontSize="small" />
            </IconButton>
          </Stack>
          <Typography
            component="h2"
            noWrap
            sx={(t) => ({
              px: '16px', pt: '6px', flexShrink: 0,
              fontFamily: t.nerv.fonts.display, fontWeight: 700, fontSize: 18,
              color: t.nerv.hue.mintHi, letterSpacing: '.01em', lineHeight: 1.2,
            })}
          >
            {item.title}
          </Typography>
          <Box sx={{ flex: 1, minHeight: 0, overflowY: 'auto', px: '16px', pt: '14px', pb: '16px' }}>
            {loading ? (
              <Typography sx={(t) => ({ color: t.nerv.hue.greenMap, fontFamily: t.nerv.fonts.mono, fontSize: 12 })}>Loading…</Typography>
            ) : error ? (
              <Box sx={{ height: '100%', display: 'grid', placeItems: 'center' }}>
                <Typography sx={(t) => ({ color: t.nerv.hue.greenMap, fontFamily: t.nerv.fonts.mono, fontSize: 12 })}>{error}</Typography>
              </Box>
            ) : transcript ? (
              <TranscriptView messages={transcript.messages || []} />
            ) : null}
          </Box>
        </>
      ) : (
        <>
          <Stack direction="row" spacing={1.25} sx={{ alignItems: 'center', px: '18px', pt: '16px', flexShrink: 0 }}>
            <Typography
              component="h2"
              variant="h3"
              noWrap
              sx={{ flex: 1, minWidth: 0, letterSpacing: '-0.02em', lineHeight: 1.15 }}
            >
              {item.title}
            </Typography>
            <IconButton size="small" aria-label="Close" onClick={onClose}>
              <CloseIcon fontSize="small" />
            </IconButton>
          </Stack>
          <Box sx={{ flex: 1, minHeight: 0, overflowY: 'auto', px: '18px', pt: '16px', pb: '18px' }}>
            {loading ? (
              <Typography color="text.secondary">Loading…</Typography>
            ) : error ? (
              <Box sx={{ height: '100%', display: 'grid', placeItems: 'center' }}>
                <Typography color="text.secondary">{error}</Typography>
              </Box>
            ) : transcript ? (
              <TranscriptView messages={transcript.messages || []} />
            ) : null}
          </Box>
        </>
      )}
    </Drawer>
  );
}

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

  // Transcript sheet: selecting a History row — or handing off from
  // TaskDetailPanel's "View transcript" — loads its session's transcript
  // read-only into the right-sliding TranscriptSheet modal above. Driven by a
  // generic item {id,title,sessionId,worktree,repo} so both entry points share it.
  const [tx, setTx] = useState(null);
  const [transcript, setTranscript] = useState(null);
  const [loadingT, setLoadingT] = useState(false);
  const [errT, setErrT] = useState(null);
  const histReqRef = useRef(0); // guards against a slower stale fetch overwriting a newer selection

  const openTranscript = (item) => {
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
          <Button size="small" startIcon={<AddIcon />} onClick={onAdd} sx={(t) => (phosphor ? { height: PHOSPHOR_CONTROL_H } : primaryBtn(t))}>New task</Button>
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
        <Box sx={{ flex: 1, minWidth: 0, minHeight: 0, overflow: 'auto', px: '10px', pt: '6px', pb: '12px' }}>
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
      ) : (
        // layout-02 `.board`: columns now flex to fill the full board width
        // (Task 1) — px/spacing scale up at wide breakpoints so the extra
        // desktop real estate becomes breathing room between lanes, not a
        // fixed 16px gap that would otherwise look cramped once the columns
        // stop capping out at 340px.
        <Stack direction="row" spacing={{ xs: 2, lg: 3, xl: 4 }} sx={{ flex: 1, minHeight: 0, px: { xs: '22px', xl: '32px' }, py: { xs: '18px', xl: '24px' } }}>
          {COLUMNS.map(([col, label]) => {
            const cards = tasks.filter((t) => t.column === col && matchesTags(t));
            const colDom = getDomainState(COLUMN_DOMAIN[col]);
            return (
              // No column chrome — `.col` is a bare flex column; the containment
              // comes from the view's glass pane, not a per-column border.
              // Columns now share the board's full width (Task 1) instead of
              // capping out at the mockup's 270px lane, so on a wide monitor
              // each column just gets more room for its card list. Only the
              // head row below keeps a width cap — past ~340px the dot/label
              // and its right-aligned count (or, under Phosphor, the
              // label+kanji and its stamped count) drift apart far enough that
              // the head stops reading as one grouped unit — so the cap moved
              // from the column to the head's own inner row, which still
              // reads as a lane regardless of how wide the column grows.
              <Stack
                key={col}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => drop(col)}
                sx={{ flex: '1 1 0', minWidth: 0, minHeight: 0 }}
              >
                {/* `.col-head` (peg lines 275-279, fix 2) — under Phosphor this is
                    now ONE flex row: the English label (`.ct`, orange) + the
                    kanji caption (`.cjp`, tone-coloured) on the left, the
                    stamped count pushed right, a green-dim rule beneath. The
                    accessible name lock ("<Label> (<n>)" — tasks.spec.mjs) can
                    no longer come from plain text content once the kanji sits
                    inline in the same element (it would read "To-Do待機(2)"),
                    so this row carries `role="group"` + an explicit
                    `aria-label` instead — a proper ARIA name computation
                    rather than incidental textContent parsing, but still the
                    exact same locked string. ZAPAC keeps the original
                    dot+label+count Typography untouched (task 5.2). The
                    green-dim rule below is drawn on this OUTER element so it
                    still spans the column's full width (reading as one lane
                    divider); the label+kanji+count trio sits in an INNER row
                    capped at COL_HEAD_MAX_W so the two stay optically grouped
                    on a wide lane instead of the count drifting off to the
                    far right. */}
                {phosphor ? (
                  <Box
                    role="group"
                    aria-label={`${label} (${cards.length})`}
                    sx={(t) => ({
                      pb: '5px', px: '6px', mb: '9px', flexShrink: 0,
                      borderBottom: `1px solid ${t.nerv.hue.greenDim}`,
                    })}
                  >
                    <Box sx={{ display: 'flex', alignItems: 'baseline', gap: '8px', maxWidth: COL_HEAD_MAX_W }}>
                      <Box component="span" sx={(t) => ({
                        fontFamily: t.nerv.fonts.display, fontWeight: 700, fontSize: 12,
                        letterSpacing: '.13em', color: t.nerv.hue.orange, textTransform: 'uppercase',
                      })}
                      >
                        {label}
                      </Box>
                      <Box component="span" sx={(t) => ({
                        fontFamily: t.nerv.fonts.jp, fontWeight: 800, fontSize: 12,
                        textTransform: 'none', letterSpacing: '.14em', color: toneHue(t, colDom.tone),
                      })}
                      >
                        {colDom.jp}
                      </Box>
                      <Stamp tone={colDom.tone} filled={colDom.filled} size="sm" sx={{ ml: 'auto' }}>
                        ({cards.length})
                      </Stamp>
                    </Box>
                  </Box>
                ) : (
                  <Typography
                    component="div"
                    sx={{
                      display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0,
                      maxWidth: COL_HEAD_MAX_W,
                      pt: '2px', px: '6px', pb: '12px',
                      fontSize: 12, fontWeight: 700, letterSpacing: '.1em',
                      textTransform: 'uppercase', color: 'text.secondary',
                    }}
                  >
                    <Box component="span" sx={{ width: 9, height: 9, borderRadius: '50%', flexShrink: 0, bgcolor: COL_DOT[col] }} />
                    {label}{' '}
                    <Box component="span" sx={(t) => countChip(t)}>({cards.length})</Box>
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
                    // Every read of `dom` below is gated behind `phosphor` — skip
                    // the cardDomainId/getDomainState lookups entirely under ZAPAC
                    // (the default skin), where the result is never used but this
                    // ran on every card on every render (agents/stats poll tick).
                    const dom = phosphor ? getDomainState(cardDomainId(task, agent)) : null;
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
                            task.state chip) + mono task-id, mirroring .tcard-top.
                            Fix 3 (peg lines 654-676): under Phosphor the pill's
                            label is the shared domain-state bilingual pair
                            (e.g. "審査 REVIEW"), not the task's own free-text
                            `state`/`agent.status` string — sourced from
                            `lib/domainState.js` (already resolved above as
                            `dom`), never a second hardcoded copy. ZAPAC keeps
                            the original literal status word untouched. */}
                        <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center', mb: '9px' }}>
                          {agent
                            ? <StatusPill status={KIND[agent.status] ?? 'review'}>{phosphor ? `${dom.jp} ${dom.en}` : agent.status}</StatusPill>
                            : (task.state && (phosphor
                              ? <Stamp tone={dom.tone} filled={dom.filled} size="sm">{`${dom.jp} ${dom.en}`}</Stamp>
                              : <Chip size="small" label={task.state} sx={(t) => statePill(t)} />))}
                          <Typography variant="code" sx={(t) => (phosphor
                            ? { ml: 'auto', fontSize: 10, color: t.nerv.hue.amber, fontFamily: t.nerv.fonts.mono, letterSpacing: '.08em', whiteSpace: 'nowrap' }
                            : { ml: 'auto', fontSize: 11, color: 'text.disabled' })}>
                            #{task.id.slice(-4)}
                          </Typography>
                        </Stack>
                        <Stack direction="row" spacing={0.5} sx={{ alignItems: 'flex-start' }}>
                          {/* `.tcard-title` wraps rather than truncating — a task title
                              is the card's payload, and two lines beat an ellipsis.
                              Fix 3: under Phosphor the title is the bright paper
                              ink in the condensed display face (peg line 292-293),
                              not the ZAPAC subtitle2 default — ZAPAC's own size/
                              weight/leading/tracking stay untouched. */}
                          <Typography
                            variant="subtitle2"
                            sx={(t) => (phosphor
                              ? { flex: 1, minWidth: 0, fontFamily: t.nerv.fonts.display, fontWeight: 700, fontSize: 14, lineHeight: 1.22, letterSpacing: '.02em', color: t.nerv.hue.paper }
                              : { flex: 1, minWidth: 0, fontWeight: 700, fontSize: 14, lineHeight: 1.35, letterSpacing: '-.01em' })}
                          >
                            {task.title}
                          </Typography>
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
                        {/* `.tcard-repo` — ZAPAC: repo icon + mono "<repo> · <branch>".
                            Phosphor (fix 3, peg line 294-295/641): repo/branch
                            render as plain "REPO:<value>"/"BRANCH:<value>" TEXT,
                            not an icon+chip line — label in green-map, value in
                            amber at font-weight 400. `textTransform: uppercase`
                            is CSS-only (the underlying repoName()/branch text is
                            untouched, so e2e text matches on the real value keep
                            working). */}
                        {phosphor ? (
                          <Typography
                            component="div"
                            sx={(t) => ({
                              mt: '10px', fontSize: 9, letterSpacing: '.06em', lineHeight: 1.4,
                              color: t.nerv.hue.greenMap, fontFamily: t.nerv.fonts.mono, textTransform: 'uppercase',
                            })}
                          >
                            REPO:<Box component="b" sx={(t) => ({ color: t.nerv.hue.amber, fontWeight: 400 })}>{repoName(task.repo)}</Box>
                            {task.branch && (
                              <>
                                <br />
                                BRANCH:<Box component="b" sx={(t) => ({ color: t.nerv.hue.amber, fontWeight: 400 })}>{task.branch}</Box>
                              </>
                            )}
                          </Typography>
                        ) : (
                          <Stack direction="row" spacing="6px" sx={{ alignItems: 'center', mt: '10px', minWidth: 0 }}>
                            <StorageOutlinedIcon sx={{ fontSize: 13, opacity: 0.8, color: 'text.secondary', flexShrink: 0 }} />
                            <Typography variant="code" sx={{ color: 'text.secondary', fontSize: 11, minWidth: 0 }} noWrap>
                              {repoName(task.repo)}{task.branch ? ` · ${task.branch}` : ''}
                            </Typography>
                          </Stack>
                        )}
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
      )}
      {/* Right-sliding detail panel — one at a time, driven by the live task
          (liveDetailTask is null when the open task leaves the board, which the
          effect above turns into a close). Rendered last so it overlays above
          the board/history content regardless of which is showing. */}
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
      {/* Transcript sheet — the second right-sliding overlay in this feature
          (task 2), opened from a History row or handed off from
          TaskDetailPanel's "View transcript". Independent of `liveDetailTask`
          above; in normal use only one of the two is ever open at a time
          (the handoff closes the detail panel in the same batch it opens
          this), but nothing stops both from existing side by side if that
          ever changes. */}
      {tx && (
        <TranscriptSheet
          item={tx}
          loading={loadingT}
          error={errT}
          transcript={transcript}
          onClose={() => setTx(null)}
        />
      )}
    </Stack>
  );
}
