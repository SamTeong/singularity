// Plans board — plan sessions as cards on a React Flow canvas ("Plans 2D").
// Real data: GET /api/plans/sessions (list) + /api/plans/session?sid= (detail,
// fetched on expand). planBadge is a pure helper from plansMockData.mjs.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ReactFlow, Handle, Position } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardActionArea from '@mui/material/CardActionArea';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Divider from '@mui/material/Divider';
import Collapse from '@mui/material/Collapse';
import IconButton from '@mui/material/IconButton';
import Popover from '@mui/material/Popover';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { useColorScheme } from '@mui/material/styles';
import FilterAltIcon from '@mui/icons-material/FilterAlt';
import ViewCarouselIcon from '@mui/icons-material/ViewCarousel';
import GridViewIcon from '@mui/icons-material/GridView';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import { useSearchParams } from 'react-router-dom';
import { useQueryState, useUpdateQuery } from '@/hooks/useQueryState.js';
import { useCapabilities } from '@/hooks/useCapabilities.js';
import { EmptyState } from '@/components/EmptyState.jsx';
import { planBadge } from './plansMockData.mjs';
import { getTokens } from '@/theme/contract.js';

const NODE_W = 280;
const SESSION_W = 380;
const COLS = 4;
const COL_PITCH = 404;
const ROW_PITCH = 176;
const VP_KEY = 'sing-plans-viewport';
const TIMEFRAME_KEY = 'sing-plans-timeframe';
const DBL_MS = 250;
const RING_RADIUS = 240;
const RING_DRAG_PX = 160;

// Recognised ?preset= values; anything else falls back to the default. Same
// URL contract as History (?preset=7|30|all|custom plus ?from/?to ISO days).
const PRESETS = new Set(['7', '30', 'all', 'custom']);
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const isoDay = (v) => (ISO_DAY.test(v) ? v : '');
const readSavedTimeframe = () => {
  try {
    const saved = JSON.parse(localStorage.getItem(TIMEFRAME_KEY));
    if (saved && PRESETS.has(saved.preset)) {
      return { preset: saved.preset, from: isoDay(saved.from), to: isoDay(saved.to) };
    }
  } catch { /* storage unavailable or invalid */ }
  return { preset: 'all', from: '', to: '' };
};
// mtime (epoch ms) as a local ISO day, for the custom-range string compare.
const localDay = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const BUCKETS = ['active', 'done', 'blocked', 'superseded', 'other'];
const STATUS_COLOR = { active: 'primary', done: 'success', blocked: 'error', superseded: 'warning', other: 'default' };
const statusColor = (s) => STATUS_COLOR[s] ?? 'default';
const dotColor = (s) => (s === 'other' ? 'text.disabled' : `${statusColor(s)}.main`);
const PHASE_GLYPH = { done: '✓', open: '○', skipped: '−' };

// mtime arrives as epoch ms from the server; the date-parse also accepts an ISO
// string, so both shapes render.
const relTime = (ms) => {
  const mins = Math.max(0, Math.round((Date.now() - new Date(ms).getTime()) / 60000));
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
};

const fmtTokens = (n) => (n == null ? null : `${Math.round(n / 1000)}k tokens`);

const noop = () => {};

// Soft depth for board cards floating over the starfield backdrop. `cardShadow`
// is the skin's glass shadow token (a CSS-var reference — see theme/contract.js
// getTokens), so the resting lift reads in both shipped skins. Open cards cast
// deeper; focus-mode-dimmed cards drop the shadow entirely.
const cardDepth = (t, { expanded = false, dimmed = false } = {}) => {
  const rest = getTokens(t).glass.cardShadow ?? '0 2px 8px -4px rgba(0,0,0,.35)';
  const deep = `0 12px 28px -10px rgba(0,0,0,.5), ${rest}`;
  const hover = `0 9px 20px -8px rgba(0,0,0,.42), ${rest}`;
  return {
    transition: 'box-shadow .15s ease',
    boxShadow: dimmed ? 'none' : expanded ? deep : rest,
    ...(dimmed ? {} : { '&:hover': { boxShadow: expanded ? deep : hover } }),
  };
};

// Hover lift for the card's inner action area — never the React Flow node
// wrapper, which React Flow transforms itself. 1px rise; suppressed under
// prefers-reduced-motion (the shadow bump from cardDepth is colour, not motion).
const CARD_LIFT = {
  transition: 'transform .15s ease',
  '@media (hover: hover)': { '&:hover': { transform: 'translateY(-1px)' } },
  '@media (prefers-reduced-motion: reduce)': { transition: 'none', '&:hover': { transform: 'none' } },
};

function SessionCard({ data }) {
  const { session, expanded, dimmed, onToggle, onToast, standalone, boardIndex } = data;
  const active = BUCKETS.filter((b) => (session.statusBuckets?.[b] ?? 0) > 0);
  const tokens = fmtTokens(session.contextTokens);
  // d3-zoom's native dblclick.zoom on the canvas ancestor kills propagation
  // before React sees it, so listen in capture phase and stop the event there.
  // The expand/collapse toggle is delayed by DBL_MS and cancelled here: firing
  // it on the first click re-renders mid-gesture, the second mousedown lands
  // on the pane, and the dblclick never reaches the card.
  const cardRef = useRef(null);
  const pendingToggle = useRef(null);
  const [openingFolder, setOpeningFolder] = useState(false);
  useEffect(() => () => clearTimeout(pendingToggle.current), []);
  useEffect(() => {
    const el = cardRef.current;
    if (!el) return undefined;
    const onDbl = (e) => {
      if (e.target.closest('[data-open-session-folder]')) {
        e.stopPropagation();
        return;
      }
      e.stopPropagation();
      clearTimeout(pendingToggle.current);
      window.getSelection()?.removeAllRanges();
      navigator.clipboard?.writeText(session.sid)?.then(() => onToast('Session ID copied'));
    };
    el.addEventListener('dblclick', onDbl, true);
    return () => el.removeEventListener('dblclick', onDbl, true);
  }, [session.sid, onToast]);
  const onClick = () => {
    clearTimeout(pendingToggle.current);
    pendingToggle.current = setTimeout(onToggle, DBL_MS);
  };
  const openFolder = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (openingFolder) return;
    setOpeningFolder(true);
    try {
      const response = await fetch('/api/plans/open', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sid: session.sid }),
      });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || 'Could not open session folder');
      onToast('Opened session folder');
    } catch (error) {
      onToast(error.message || 'Could not open session folder');
    } finally {
      setOpeningFolder(false);
    }
  };
  return (
    <Card
      ref={cardRef}
      variant="outlined"
      className="nopan"
      sx={(t) => ({
        width: standalone ? `min(${SESSION_W}px, calc(100vw - 24px))` : SESSION_W,
        position: 'relative',
        bgcolor: getTokens(t).glass.surface,
        borderColor: expanded ? 'primary.main' : undefined,
        '& .MuiTypography-caption': { fontSize: '0.98rem' },
        '& .MuiChip-label': { fontSize: '0.94rem' },
        '& .MuiChip-root': { height: 'auto', minHeight: 29 },
        '& .MuiSvgIcon-root': { fontSize: '1.5rem' },
        // VERIFY: refine-dim
        opacity: dimmed ? 0.05 : 1,
        pointerEvents: dimmed ? 'none' : 'auto',
        userSelect: 'text',
        ...cardDepth(t, { expanded, dimmed }),
      })}
    >
      {!standalone && <Handle type="source" position={Position.Right} />}
      <CardActionArea
        onClick={onClick}
        aria-expanded={expanded}
        data-board-session={boardIndex}
        sx={{ p: 2.4, pr: 5, userSelect: 'text', ...CARD_LIFT }}
      >
        <Stack spacing={0.75}>
          <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
            <Typography variant="caption" sx={{ fontFamily: 'monospace', color: 'text.secondary' }}>
              {session.sid.slice(0, 8)}
            </Typography>
            <Stack direction="row" spacing={0.5} sx={{ mr: standalone ? 2 : 1.5, transform: standalone ? 'translateY(-2px)' : undefined }}>
              {active.map((s) => (
                <Box key={s} sx={{ width: 10, height: 10, borderRadius: '50%', bgcolor: dotColor(s) }} />
              ))}
            </Stack>
          </Stack>
          <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', minWidth: 0 }}>
            {session.branch && (
              <Chip size="small" variant="outlined" label={session.branch} sx={{ maxWidth: '100%' }} />
            )}
            {tokens && (
              <Typography variant="caption" color="text.secondary" sx={{ whiteSpace: 'nowrap' }}>
                {tokens}
              </Typography>
            )}
          </Stack>
          <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
            <Typography variant="caption" color="text.secondary" sx={{ whiteSpace: 'nowrap' }}>
              {relTime(session.mtime)}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {session.planCount} plan{session.planCount === 1 ? '' : 's'}
              {expanded ? ' · click to collapse' : ' · click to expand'}
            </Typography>
          </Stack>
        </Stack>
      </CardActionArea>
      <Tooltip title="Open session folder in File Explorer">
        <Box component="span" data-open-session-folder sx={{ position: 'absolute', top: standalone ? 10 : 14, right: 16, zIndex: 2, display: 'inline-flex' }}>
          <IconButton
            size="small"
            aria-label="Open session folder"
            disabled={openingFolder}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={openFolder}
            onDoubleClick={(e) => { e.preventDefault(); e.stopPropagation(); }}
          >
            <FolderOpenIcon fontSize="small" />
          </IconButton>
        </Box>
      </Tooltip>
    </Card>
  );
}

function PlanCard({ data }) {
  const { plan, notes, expanded, dimmed, onToggle } = data;
  return (
    <Card
      variant="outlined"
      className="nopan"
      sx={(t) => ({
        width: NODE_W,
        bgcolor: getTokens(t).glass.surface,
        opacity: dimmed ? 0.15 : 1,
        pointerEvents: dimmed ? 'none' : 'auto',
        userSelect: 'text',
        ...cardDepth(t, { expanded, dimmed }),
      })}
    >
      <CardActionArea onClick={onToggle} aria-expanded={expanded} sx={{ p: 2, userSelect: 'text', ...CARD_LIFT }}>
        <Stack spacing={0.5}>
          <Typography variant="subtitle2" sx={{ lineHeight: 1.3 }}>
            {plan.title}
          </Typography>
          <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', minWidth: 0 }}>
            <Chip size="small" variant="outlined" color={statusColor(plan.status)} label={`${planBadge(plan.status)} ${plan.status}`} />
            {plan.currentPhase && (
              <Typography variant="caption" color="text.secondary" noWrap>
                ▸ {plan.currentPhase}
              </Typography>
            )}
          </Stack>
          {plan.objective && (
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}
            >
              {plan.objective}
            </Typography>
          )}
        </Stack>
      </CardActionArea>
      <Collapse in={expanded} unmountOnExit>
        <Divider />
        <Box sx={{ p: 2 }}>
          <Stack spacing={0.25}>
            {plan.phases.map((ph, i) => (
              <Typography
                key={i}
                variant="caption"
                sx={{
                  color: ph.state === 'done' ? 'text.secondary' : 'text.primary',
                  textDecoration: ph.state === 'skipped' ? 'line-through' : 'none',
                }}
              >
                {PHASE_GLYPH[ph.state] ?? '○'} {ph.text}
              </Typography>
            ))}
          </Stack>
          {plan.nextSteps.length > 0 && (
            <Stack spacing={0.25} sx={{ mt: 1 }}>
              <Typography variant="overline" color="text.secondary">
                Next
              </Typography>
              {plan.nextSteps.map((s, i) => (
                <Typography key={i} variant="caption">
                  • {s}
                </Typography>
              ))}
            </Stack>
          )}
          {notes.length > 0 && (
            <Stack direction="row" sx={{ flexWrap: 'wrap', mt: 1, gap: 0.5 }}>
              {notes.map((n) => (
                <Chip key={n.file} size="small" variant="outlined" label={n.title} />
              ))}
            </Stack>
          )}
        </Box>
      </Collapse>
    </Card>
  );
}

function PlanStackNode({ data }) {
  const { plans, notes, sid, openPlan, onTogglePlan } = data;
  return (
    <Box sx={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: 1.5 }}>
      <Handle type="target" position={Position.Left} />
      {plans.map((plan) => {
        const key = `${sid}:${plan.file}`;
        return <PlanCard key={key} data={{
          plan,
          notes: notes.filter((note) => !note.plan || note.plan === plan.file),
          expanded: openPlan === key,
          dimmed: false,
          onToggle: () => onTogglePlan(key),
        }} />;
      })}
    </Box>
  );
}

// Placeholder node under an expanded session while its detail request is in
// flight, or when it failed (retry re-runs the fetch).
function InfoCard({ data }) {
  const { loading, error, onRetry, standalone } = data;
  return (
    <Card variant="outlined" sx={(t) => ({ width: NODE_W, p: 1.5, bgcolor: getTokens(t).glass.surface, ...cardDepth(t, { expanded: true }) })}>
      {!standalone && <Handle type="target" position={Position.Left} />}
      {loading ? (
        <Stack sx={{ alignItems: 'center', py: 1 }}>
          <CircularProgress size={20} />
        </Stack>
      ) : (
        <Stack spacing={1} sx={{ alignItems: 'center', py: 0.5 }}>
          <Typography variant="caption" color="error">
            {error}
          </Typography>
          <Button size="small" variant="outlined" onClick={onRetry}>
            Retry
          </Button>
        </Stack>
      )}
    </Card>
  );
}

const nodeTypes = { session: SessionCard, planStack: PlanStackNode, info: InfoCard };

export default function PlansView({ onToast }) {
  const [list, setList] = useState(null);
  // Feature gate (below): no SING_PLANS_ROOT in .env = daemon answers disabled
  // and /capabilities carries the hint. caps null (loading/glitch) = available,
  // per the useCapabilities contract.
  const [listError, setListError] = useState(null);
  const [listNonce, setListNonce] = useState(0);
  const [openSession, setOpenSession] = useState(null);
  const [openPlan, setOpenPlan] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailErr, setDetailErr] = useState(null);
  const [retry, setRetry] = useState(0);
  const [status, setStatus] = useQueryState('status', 'all');
  const [layout, setLayout] = useQueryState('layout', 'carousel');
  const carousel = layout === 'carousel';
  const [deckPosition, setDeckPosition] = useState(0);
  const [ringDragging, setRingDragging] = useState(false);
  const dragRef = useRef(null);
  const ringRef = useRef(null);
  const boardRef = useRef(null);
  const planStackRef = useRef(null);
  const initialSelectionRef = useRef(false);
  const suppressClickRef = useRef(false);
  const caps = useCapabilities();
  const { mode, systemMode } = useColorScheme();
  const boardColorMode = (mode === 'system' ? systemMode : mode) === 'dark' ? 'dark' : 'light';
  const [searchParams] = useSearchParams();
  const [savedTimeframe, setSavedTimeframe] = useState(readSavedTimeframe);
  // Timeframe in the URL, same contract as History: ?preset=7|30|all|custom
  // plus ?from/?to ISO days. An unrecognised preset degrades to the default.
  const timeframeInUrl = ['preset', 'from', 'to'].some((key) => searchParams.has(key));
  const urlPreset = searchParams.get('preset') ?? 'all';
  const urlTimeframe = {
    preset: PRESETS.has(urlPreset) ? urlPreset : 'all',
    from: isoDay(searchParams.get('from')),
    to: isoDay(searchParams.get('to')),
  };
  if (timeframeInUrl && (savedTimeframe.preset !== urlTimeframe.preset
    || savedTimeframe.from !== urlTimeframe.from || savedTimeframe.to !== urlTimeframe.to)) {
    setSavedTimeframe(urlTimeframe);
  }
  const { preset, from, to } = timeframeInUrl ? urlTimeframe : savedTimeframe;
  const updateQuery = useUpdateQuery();
  const [filterAnchor, setFilterAnchor] = useState(null);
  const filtersActive = preset !== 'all';
  // Date.now() is impure during render — capture it once per mount for the cutoffs.
  const [now] = useState(() => Date.now());
  // last pan/zoom survives refresh via localStorage; when absent, fitView
  const [initialViewport, setInitialViewport] = useState(() => {
    try {
      const vp = JSON.parse(localStorage.getItem(VP_KEY));
      if (vp && Number.isFinite(vp.x) && Number.isFinite(vp.y) && Number.isFinite(vp.zoom)) return vp;
    } catch { /* parse miss = fresh fit */ }
    return null;
  });

  useEffect(() => {
    try {
      localStorage.setItem(TIMEFRAME_KEY, JSON.stringify(savedTimeframe));
    } catch { /* storage unavailable — timeframe still works for this visit */ }
  }, [savedTimeframe]);

  // VERIFY: refine-fetch
  useEffect(() => {
    let cancelled = false;
    fetch('/api/plans/sessions')
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((j) => {
        if (!cancelled) setList(j);
      })
      .catch((e) => {
        if (!cancelled) setListError(String(e.message || e));
      });
    return () => {
      cancelled = true;
    };
  }, [listNonce]);

  useEffect(() => {
    if (!openSession) return undefined;
    let cancelled = false;
    fetch('/api/plans/session?sid=' + encodeURIComponent(openSession))
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((j) => {
        if (cancelled) return;
        setDetail(j);
        setDetailErr(null);
      })
      .catch((e) => {
        if (!cancelled) setDetailErr({ sid: openSession, message: String(e.message || e) });
      });
    return () => {
      cancelled = true;
    };
  }, [openSession, retry]);

  const retryList = useCallback(() => {
    setListError(null);
    setListNonce((n) => n + 1);
  }, []);

  const toggleSession = useCallback((sid) => {
    setOpenSession((cur) => (cur === sid ? null : sid));
    setOpenPlan(null);
  }, []);
  const togglePlan = useCallback((key) => setOpenPlan((cur) => (cur === key ? null : key)), []);

  // VERIFY: refine-filter
  const sessions = useMemo(() => {
    const rows = list ?? [];
    const kept = status === 'all' ? rows : rows.filter((s) => (s.statusBuckets?.[status] ?? 0) > 0);
    const cutoff = preset === '7' ? now - 7 * 86400e3 : preset === '30' ? now - 30 * 86400e3 : null;
    // mtime can be epoch ms or ISO string (see relTime) — normalize before comparing.
    const inRange = (ms) => {
      const t = new Date(ms).getTime();
      if (cutoff != null) return t >= cutoff;
      if (preset === 'custom') return (!from || localDay(t) >= from) && (!to || localDay(t) <= to);
      return true;
    };
    return kept.filter((s) => inRange(s.mtime)).sort((a, b) => b.mtime - a.mtime);
  }, [list, status, preset, from, to, now]);
  useEffect(() => {
    if (initialSelectionRef.current || list == null || sessions.length === 0) return undefined;
    initialSelectionRef.current = true;
    setOpenSession(sessions[0].sid);
  }, [list, sessions]);
  useEffect(() => {
    if (!openSession) return undefined;
    const index = sessions.findIndex((s) => s.sid === openSession);
    if (index < 0) return undefined;
    if (!carousel) {
      const board = boardRef.current;
      if (!board) return undefined;
      const focusSelected = (force = false) => {
        const active = document.activeElement;
        if (!force && active !== document.body && !active?.matches('[data-board-session]')) return;
        board.querySelector(`[data-board-session="${index}"]`)?.focus();
      };
      focusSelected(true);
      const observer = new MutationObserver(() => focusSelected());
      observer.observe(board, { childList: true, subtree: true });
      const frame = requestAnimationFrame(() => focusSelected());
      return () => {
        cancelAnimationFrame(frame);
        observer.disconnect();
      };
    }
    let secondFrame;
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        if (document.activeElement?.closest('.react-flow__node-planStack, [data-plan-card]')) return;
        ringRef.current?.querySelector('[aria-current="true"] .MuiCardActionArea-root')?.focus();
      });
    });
    return () => {
      cancelAnimationFrame(firstFrame);
      cancelAnimationFrame(secondFrame);
    };
  }, [openSession, sessions, carousel]);
  const currentDeckIndex = sessions.length
    ? ((Math.round(deckPosition) % sessions.length) + sessions.length) % sessions.length
    : 0;
  const moveDeck = (delta) => {
    setDeckPosition((position) => Math.round(position) + delta);
    setOpenSession(null);
    setOpenPlan(null);
  };
  const onRingKeyDown = (e) => {
    if (openSession !== sessions[currentDeckIndex]?.sid
      || !e.target.closest('[aria-current="true"] .MuiCardActionArea-root')) return;
    if (e.key === 'ArrowDown') {
      const firstPlan = planStackRef.current?.querySelector('[data-plan-card] .MuiCardActionArea-root');
      if (firstPlan) {
        e.preventDefault();
        firstPlan.focus();
      }
      return;
    }
    if (sessions.length <= 1) return;
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const delta = e.key === 'ArrowRight' ? 1 : -1;
    setDeckPosition((position) => Math.round(position) + delta);
    setOpenSession(sessions[(currentDeckIndex + delta + sessions.length) % sessions.length].sid);
    setOpenPlan(null);
    const ring = e.currentTarget;
    requestAnimationFrame(() => ring.querySelector('[aria-current="true"] .MuiCardActionArea-root')?.focus());
  };
  const onPlanKeyDown = (e) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    const cards = [...e.currentTarget.querySelectorAll('[data-plan-card] .MuiCardActionArea-root')];
    const index = cards.indexOf(e.target);
    if (index < 0) return;
    e.preventDefault();
    if (e.key === 'ArrowUp' && index === 0) {
      ringRef.current?.querySelector('[aria-current="true"] .MuiCardActionArea-root')?.focus();
    } else {
      cards[index + (e.key === 'ArrowDown' ? 1 : -1)]?.focus();
    }
  };
  const onBoardKeyDown = (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    const planStack = e.target.closest('.react-flow__node-planStack');
    if (planStack) {
      const cards = [...planStack.querySelectorAll('.MuiCardActionArea-root')];
      const index = cards.indexOf(e.target);
      if (index < 0 || (e.key === 'ArrowLeft' && index !== 0) || e.key === 'ArrowRight') return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'ArrowLeft') {
        const sessionIndex = sessions.findIndex((s) => s.sid === openSession);
        boardRef.current?.querySelector(`[data-board-session="${sessionIndex}"]`)?.focus();
      } else {
        cards[index + (e.key === 'ArrowDown' ? 1 : -1)]?.focus();
      }
      return;
    }
    const index = Number(e.target.dataset.boardSession);
    if (!Number.isInteger(index) || e.target.dataset.boardSession === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'ArrowRight' && openSession === sessions[index].sid) {
      const firstPlan = boardRef.current?.querySelector('.react-flow__node-planStack .MuiCardActionArea-root');
      if (firstPlan) {
        firstPlan.focus();
        return;
      }
    }
    const next = e.key === 'ArrowLeft' ? (index % COLS ? index - 1 : -1)
      : e.key === 'ArrowRight' ? (index % COLS < COLS - 1 ? index + 1 : -1)
        : index + (e.key === 'ArrowDown' ? COLS : -COLS);
    if (next < 0 || next >= sessions.length) return;
    setOpenSession(sessions[next].sid);
    setOpenPlan(null);
  };
  const onRingPointerDown = (e) => {
    if (e.button !== 0) return;
    dragRef.current = { x: e.clientX, position: deckPosition, last: deckPosition, moved: false };
  };
  const onRingPointerMove = (e) => {
    const drag = dragRef.current;
    if (!drag) return;
    const distance = e.clientX - drag.x;
    if (!drag.moved && Math.abs(distance) < 8) return;
    if (!drag.moved) {
      drag.moved = true;
      setRingDragging(true);
      e.currentTarget.setPointerCapture(e.pointerId);
    }
    e.preventDefault();
    drag.last = drag.position - distance / RING_DRAG_PX;
    setDeckPosition(drag.last);
  };
  const onRingPointerEnd = (e) => {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    if (!drag.moved) return;
    setRingDragging(false);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    setDeckPosition(Math.round(drag.last));
    if (Math.round(drag.last) !== Math.round(drag.position)) {
      setOpenSession(null);
      setOpenPlan(null);
    }
    suppressClickRef.current = true;
    setTimeout(() => { suppressClickRef.current = false; }, 0);
  };

  // Detail counts only when it belongs to the open session — a stale row from a
  // previously expanded session is ignored rather than cleared in an effect.
  const openDetail = detail && detail.sid === openSession ? detail : null;
  const openErr = detailErr && detailErr.sid === openSession ? detailErr.message : null;
  const detailLoading = openSession !== null && openDetail == null && openErr == null;
  const selectedSessionVisible = sessions.some((s) => s.sid === openSession);

  const { nodes, edges } = useMemo(() => {
    const ns = [];
    const es = [];
    sessions.forEach((s, i) => {
      const x = (i % COLS) * COL_PITCH;
      const y = Math.floor(i / COLS) * ROW_PITCH;
      const expanded = openSession === s.sid;
      ns.push({
        id: s.sid,
        type: 'session',
        position: { x, y },
        draggable: false,
        data: {
          session: s, expanded, dimmed: openSession !== null && !expanded,
          onToggle: () => toggleSession(s.sid), onToast,
          boardIndex: i,
        },
      });
      if (!expanded) return;
      if (openDetail == null) {
        ns.push({
          id: `${s.sid}:info`,
          type: 'info',
          position: { x: x + COL_PITCH, y },
          draggable: false,
          zIndex: 10,
          data: { loading: detailLoading, error: openErr, onRetry: () => setRetry((n) => n + 1) },
        });
        return;
      }
      const key = `${s.sid}:plans`;
      ns.push({
        id: key,
        type: 'planStack',
        position: { x: x + COL_PITCH, y },
        draggable: false,
        zIndex: 10,
        data: {
          plans: openDetail.plans,
          notes: openDetail.notes,
          sid: s.sid,
          openPlan,
          onTogglePlan: togglePlan,
        },
      });
      es.push({ id: `e-${key}`, source: s.sid, target: key, type: 'default' });
    });
    return { nodes: ns, edges: es };
  }, [sessions, openSession, openPlan, openDetail, detailLoading, openErr, toggleSession, togglePlan, onToast]);

  if (caps?.plans?.available === false) {
    return (
      <Box sx={{ height: '100%', display: 'grid', placeItems: 'center' }}>
        <EmptyState
          title="Plans disabled"
          description={caps.plans.hint ?? 'Set SING_PLANS_ROOT in .env to enable the Plans view.'}
        />
      </Box>
    );
  }

  return (
    <Box ref={boardRef} onKeyDownCapture={carousel ? undefined : onBoardKeyDown} sx={{ position: 'relative', width: '100%', height: '100%' }}>
      {/* Milky-way backdrop: pure-CSS star layers behind the canvas. Three
          repeating star fields drift at different speeds (parallax) over a
          blurred galactic band; pointer-events none so it never eats pan. */}
      <Box
        aria-hidden
        sx={(t) => ({
          position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none',
          background: t.palette.mode === 'dark' ? 'linear-gradient(165deg, rgba(15,25,60,.45), rgba(40,20,80,.30) 55%, rgba(8,15,35,.45))' : 'transparent',
          // galactic band
          '& .sing-mw-band': {
            position: 'absolute', inset: '-25%', transform: 'rotate(-28deg)',
            background: 'linear-gradient(90deg, transparent 20%, rgba(140,120,220,.16) 42%, rgba(200,190,255,.10) 50%, rgba(140,120,220,.16) 58%, transparent 80%)',
            filter: 'blur(28px)',
            animation: 'sing-mw-band 90s ease-in-out infinite alternate',
          },
          // near stars (brighter, coarse) + far stars (dim, dense) + mid layer
          '& .sing-mw-stars': {
            position: 'absolute', inset: 0,
            backgroundImage:
              'radial-gradient(1.2px 1.2px at 186.8px 0.6px, rgba(255,255,255,0.5), transparent 55%),' +
              'radial-gradient(1.3px 1.3px at 75.1px 8.4px, rgba(210,225,255,0.5), transparent 55%),' +
              'radial-gradient(1.3px 1.3px at 147.2px 16.5px, rgba(255,240,220,0.8), transparent 55%),' +
              'radial-gradient(2px 2px at 181.1px 20.2px, rgba(255,240,220,0.5), transparent 55%),' +
              'radial-gradient(2.5px 2.5px at 98.7px 32.2px, rgba(255,255,255,1), transparent 55%),' +
              'radial-gradient(1.4px 1.4px at 170.5px 36px, rgba(255,255,255,0.6), transparent 55%),' +
              'radial-gradient(1.5px 1.5px at 54.6px 57.1px, rgba(255,255,255,0.5), transparent 55%),' +
              'radial-gradient(1.9px 1.9px at 314.3px 66.5px, rgba(255,240,220,0.5), transparent 55%),' +
              'radial-gradient(2.7px 2.7px at 1px 71.4px, rgba(255,240,220,0.9), transparent 55%),' +
              'radial-gradient(1.9px 1.9px at 63.3px 74.6px, rgba(210,225,255,0.8), transparent 55%),' +
              'radial-gradient(2.8px 2.8px at 117.7px 76.8px, rgba(255,240,220,0.9), transparent 55%),' +
              'radial-gradient(1.1px 1.1px at 110.2px 89.1px, rgba(255,255,255,0.6), transparent 55%),' +
              'radial-gradient(2.8px 2.8px at 65.7px 91.7px, rgba(255,240,220,0.9), transparent 55%),' +
              'radial-gradient(1.9px 1.9px at 79.7px 100.5px, rgba(255,240,220,0.4), transparent 55%),' +
              'radial-gradient(1.4px 1.4px at 106.8px 111.8px, rgba(255,240,220,0.7), transparent 55%),' +
              'radial-gradient(1.9px 1.9px at 93.4px 119.3px, rgba(255,240,220,0.6), transparent 55%),' +
              'radial-gradient(1.2px 1.2px at 20.7px 136.7px, rgba(255,240,220,0.5), transparent 55%),' +
              'radial-gradient(2.2px 2.2px at 391.8px 241.5px, rgba(210,225,255,0.6), transparent 55%),' +
              'radial-gradient(1.8px 1.8px at 261.1px 260.5px, rgba(210,225,255,0.4), transparent 55%),' +
              'radial-gradient(1.1px 1.1px at 105.2px 263.7px, rgba(255,240,220,0.5), transparent 55%),' +
              'radial-gradient(2.1px 2.1px at 23px 275.1px, rgba(255,255,255,0.5), transparent 55%),' +
              'radial-gradient(1.5px 1.5px at 389.3px 281.7px, rgba(210,225,255,0.8), transparent 55%),' +
              'radial-gradient(2.3px 2.3px at 166.9px 286.1px, rgba(210,225,255,0.5), transparent 55%),' +
              'radial-gradient(1.5px 1.5px at 144px 290.7px, rgba(255,255,255,0.7), transparent 55%)',
            backgroundSize: '400px 300px',
            animation: 'sing-mw-drift 240s linear infinite, sing-mw-twinkle 7s ease-in-out infinite',
          },
          '& .sing-mw-far': {
            position: 'absolute', inset: 0,
            backgroundImage:
              'radial-gradient(0.7px 0.7px at 79.4px 0.3px, rgba(255,255,255,0.6), transparent 55%),' +
              'radial-gradient(0.9px 0.9px at 7.5px 1.5px, rgba(255,255,255,0.3), transparent 55%),' +
              'radial-gradient(0.9px 0.9px at 142.6px 3.4px, rgba(255,240,220,0.5), transparent 55%),' +
              'radial-gradient(0.7px 0.7px at 87.3px 3.9px, rgba(255,240,220,0.6), transparent 55%),' +
              'radial-gradient(1.2px 1.2px at 241.5px 7.6px, rgba(210,225,255,0.7), transparent 55%),' +
              'radial-gradient(0.8px 0.8px at 67.1px 10.9px, rgba(255,240,220,0.3), transparent 55%),' +
              'radial-gradient(0.6px 0.6px at 81.2px 13.7px, rgba(255,240,220,0.6), transparent 55%),' +
              'radial-gradient(1.4px 1.4px at 245.2px 19.2px, rgba(210,225,255,0.7), transparent 55%),' +
              'radial-gradient(0.7px 0.7px at 55.1px 22.3px, rgba(255,255,255,0.6), transparent 55%),' +
              'radial-gradient(1.3px 1.3px at 56.4px 26.9px, rgba(255,240,220,0.6), transparent 55%),' +
              'radial-gradient(0.9px 0.9px at 15.7px 27.2px, rgba(210,225,255,0.5), transparent 55%),' +
              'radial-gradient(0.8px 0.8px at 101.5px 28.6px, rgba(210,225,255,0.4), transparent 55%),' +
              'radial-gradient(0.8px 0.8px at 35.5px 35.8px, rgba(255,255,255,0.7), transparent 55%),' +
              'radial-gradient(1.5px 1.5px at 54.2px 37px, rgba(210,225,255,0.5), transparent 55%),' +
              'radial-gradient(0.9px 0.9px at 213.6px 54.3px, rgba(255,255,255,0.6), transparent 55%),' +
              'radial-gradient(0.7px 0.7px at 68px 58.4px, rgba(255,240,220,0.6), transparent 55%),' +
              'radial-gradient(0.6px 0.6px at 122.8px 58.8px, rgba(210,225,255,0.5), transparent 55%),' +
              'radial-gradient(0.8px 0.8px at 135.1px 61.9px, rgba(255,240,220,0.5), transparent 55%),' +
              'radial-gradient(1px 1px at 212.1px 64.8px, rgba(255,255,255,0.6), transparent 55%),' +
              'radial-gradient(0.9px 0.9px at 58.3px 66px, rgba(255,255,255,0.7), transparent 55%),' +
              'radial-gradient(0.7px 0.7px at 5.7px 68.2px, rgba(255,255,255,0.4), transparent 55%),' +
              'radial-gradient(1px 1px at 158.1px 78.4px, rgba(210,225,255,0.5), transparent 55%),' +
              'radial-gradient(0.9px 0.9px at 247.4px 93.2px, rgba(255,255,255,0.6), transparent 55%),' +
              'radial-gradient(0.9px 0.9px at 194.3px 99.2px, rgba(255,240,220,0.7), transparent 55%),' +
              'radial-gradient(0.7px 0.7px at 208.8px 100.5px, rgba(255,255,255,0.6), transparent 55%),' +
              'radial-gradient(0.7px 0.7px at 18.3px 109.5px, rgba(255,255,255,0.6), transparent 55%),' +
              'radial-gradient(0.7px 0.7px at 242.7px 123.2px, rgba(255,255,255,0.4), transparent 55%),' +
              'radial-gradient(0.7px 0.7px at 82.7px 155.5px, rgba(255,255,255,0.5), transparent 55%),' +
              'radial-gradient(0.6px 0.6px at 54.6px 161.8px, rgba(255,255,255,0.5), transparent 55%),' +
              'radial-gradient(0.7px 0.7px at 2.1px 164.7px, rgba(210,225,255,0.7), transparent 55%),' +
              'radial-gradient(1px 1px at 171.4px 165px, rgba(255,255,255,0.5), transparent 55%),' +
              'radial-gradient(0.7px 0.7px at 179.3px 169.5px, rgba(255,240,220,0.7), transparent 55%),' +
              'radial-gradient(1px 1px at 251.9px 171.4px, rgba(255,255,255,0.5), transparent 55%),' +
              'radial-gradient(1.4px 1.4px at 66.2px 176.8px, rgba(255,255,255,0.7), transparent 55%),' +
              'radial-gradient(1px 1px at 259.9px 187.7px, rgba(210,225,255,0.6), transparent 55%),' +
              'radial-gradient(0.7px 0.7px at 244.6px 190.3px, rgba(255,255,255,0.7), transparent 55%),' +
              'radial-gradient(0.6px 0.6px at 147.9px 191.3px, rgba(210,225,255,0.4), transparent 55%),' +
              'radial-gradient(0.8px 0.8px at 119.3px 192.3px, rgba(255,255,255,0.7), transparent 55%)',
            backgroundSize: '260px 200px',
            animation: 'sing-mw-drift-far 420s linear infinite',
          },
          '@keyframes sing-mw-drift': {
            from: { backgroundPosition: '0 0' },
            to: { backgroundPosition: '400px 300px' },
          },
          '@keyframes sing-mw-drift-far': {
            from: { backgroundPosition: '0 0' },
            to: { backgroundPosition: '-260px -200px' },
          },
          '@keyframes sing-mw-twinkle': {
            '0%, 100%': { opacity: 0.8 },
            '50%': { opacity: 1 },
          },
          '@keyframes sing-mw-band': {
            from: { transform: 'rotate(-28deg) translateX(-2%)' },
            to: { transform: 'rotate(-28deg) translateX(2%)' },
          },
          '@media (prefers-reduced-motion: reduce)': {
            '& .sing-mw-band, & .sing-mw-stars, & .sing-mw-far': { animation: 'none' },
          },
        })}
      >
        <Box className="sing-mw-band" />
        <Box className="sing-mw-far" />
        <Box className="sing-mw-stars" />
      </Box>
      {!carousel && <ReactFlow
        colorMode={boardColorMode}
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        style={{ backgroundColor: 'transparent' }}
        onNodesChange={noop}
        // VERIFY: refine-panondrag
        panOnDrag={[0, 1, 2]}
        panOnScroll={false}
        zoomOnScroll
        zoomOnPinch
        fitView={initialViewport == null}
        defaultViewport={initialViewport ?? undefined}
        onMoveEnd={(_, vp) => {
          setInitialViewport(vp);
          try {
            localStorage.setItem(VP_KEY, JSON.stringify(vp));
          } catch { /* storage full/blocked — viewport just won't persist */ }
        }}
        fitViewOptions={{ padding: 0.2 }}
        nodesDraggable={false}
        onPaneClick={() => {
          // one click per level: collapse open plan first, then the session
          if (openPlan != null) setOpenPlan(null);
          else setOpenSession(null);
        }}
        minZoom={0.2}
        maxZoom={1.5}
        proOptions={{ hideAttribution: true }}
      />}
      {carousel && (
        <Box sx={{ position: 'absolute', inset: 0, pt: 7, pb: 2, overflowY: 'auto' }}>
          <Stack direction="row" sx={{ px: 2, justifyContent: 'flex-end' }}>
            <Stack direction="row" sx={{ alignItems: 'center' }}>
              <IconButton size="small" aria-label="Previous session" disabled={sessions.length <= 1} onClick={() => moveDeck(-1)}>
                <ChevronLeftIcon fontSize="small" />
              </IconButton>
              <Typography variant="caption" sx={{ minWidth: 42, textAlign: 'center' }}>
                {sessions.length ? `${currentDeckIndex + 1} / ${sessions.length}` : '0 / 0'}
              </Typography>
              <IconButton size="small" aria-label="Next session" disabled={sessions.length <= 1} onClick={() => moveDeck(1)}>
                <ChevronRightIcon fontSize="small" />
              </IconButton>
            </Stack>
          </Stack>
          {sessions.length === 0 ? (
            <Typography variant="body2" color="text.secondary" sx={{ px: 2, py: 3 }}>
              No sessions match the filters.
            </Typography>
          ) : (
            <Box
              ref={ringRef}
              role="region"
              aria-label="Session carousel"
              onKeyDown={onRingKeyDown}
              onPointerDown={onRingPointerDown}
              onPointerMove={onRingPointerMove}
              onPointerUp={onRingPointerEnd}
              onPointerCancel={onRingPointerEnd}
              onClickCapture={(e) => {
                if (!suppressClickRef.current) return;
                e.preventDefault();
                e.stopPropagation();
                suppressClickRef.current = false;
              }}
              sx={{
                position: 'relative', height: { xs: 150, sm: 156 }, overflow: 'hidden',
                perspective: '1200px', touchAction: 'pan-y', cursor: 'grab',
                '&:active': { cursor: 'grabbing' },
              }}
            >
              {sessions.map((s, i) => {
                const angle = (i - deckPosition) * 360 / sessions.length;
                const facing = Math.cos(angle * Math.PI / 180);
                return (
                  <Box
                    key={s.sid}
                    aria-current={i === currentDeckIndex ? 'true' : undefined}
                    aria-hidden={facing <= 0}
                    inert={facing <= 0}
                    onClickCapture={(e) => {
                      if (i === currentDeckIndex) return;
                      e.preventDefault();
                      e.stopPropagation();
                      const forward = (i - currentDeckIndex + sessions.length) % sessions.length;
                      moveDeck(forward <= sessions.length / 2 ? forward : forward - sessions.length);
                    }}
                    sx={{
                      position: 'absolute', top: 0, left: '50%',
                      zIndex: Math.round((facing + 1) * 100),
                      transform: `translateX(-50%) rotateY(${angle}deg) translateZ(${RING_RADIUS}px) scale(.8)`,
                      opacity: Math.max(0.3, (facing + 1) / 2),
                      transition: ringDragging ? 'none' : 'transform .35s ease, opacity .35s ease',
                      backfaceVisibility: 'hidden',
                      '@media (prefers-reduced-motion: reduce)': { transition: 'none' },
                    }}
                  >
                    <SessionCard data={{
                      session: s, expanded: openSession === s.sid, dimmed: false, standalone: true,
                      onToggle: () => toggleSession(s.sid), onToast,
                    }} />
                  </Box>
                );
              })}
            </Box>
          )}
          {selectedSessionVisible && (
            <Box sx={{ mt: 2 }}>
              <Box
                ref={planStackRef}
                role="region"
                aria-label="Plans in selected session"
                onKeyDown={onPlanKeyDown}
                sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1.5, px: 2, pb: 3 }}
              >
                {openDetail == null ? (
                  <InfoCard data={{ loading: detailLoading, error: openErr, onRetry: () => setRetry((n) => n + 1), standalone: true }} />
                ) : openDetail.plans.map((p) => {
                  const key = `${openSession}:${p.file}`;
                  return (
                    <Box key={key} data-plan-card>
                      <PlanCard data={{
                        plan: p,
                        notes: openDetail.notes.filter((n) => !n.plan || n.plan === p.file),
                        expanded: openPlan === key,
                        dimmed: false,
                        onToggle: () => togglePlan(key),
                      }} />
                    </Box>
                  );
                })}
              </Box>
            </Box>
          )}
        </Box>
      )}
      <Stack
        direction="row"
        spacing={0.5}
        sx={{
          position: 'absolute', top: 8, left: 8, zIndex: 5, gap: 0.5,
          ...(carousel
            ? { right: 88, overflowX: 'auto', flexWrap: 'nowrap', '& .MuiChip-root': { flexShrink: 0 } }
            : { flexWrap: 'wrap' }),
        }}
      >
        {['all', ...BUCKETS].map((b) => (
          <Chip
            key={b}
            size="small"
            label={b}
            color={status === b ? 'primary' : 'default'}
            variant={status === b ? 'filled' : 'outlined'}
            onClick={() => setStatus(b)}
          />
        ))}
      </Stack>
      <Tooltip title={carousel ? 'Board view' : 'Carousel view'} disableInteractive>
        <IconButton
          size="small"
          aria-label={carousel ? 'Switch to board view' : 'Switch to carousel view'}
          aria-pressed={carousel}
          onClick={() => {
            if (!carousel && openSession != null) {
              const index = sessions.findIndex((s) => s.sid === openSession);
              if (index >= 0) setDeckPosition(index);
            }
            setLayout(carousel ? 'board' : 'carousel');
          }}
          sx={{ position: 'absolute', top: 8, right: 48, zIndex: 5 }}
        >
          {carousel ? <GridViewIcon fontSize="small" /> : <ViewCarouselIcon fontSize="small" />}
        </IconButton>
      </Tooltip>
      <Tooltip title="Filter" disableInteractive>
        <IconButton
          size="small"
          aria-label="Filter plans"
          aria-pressed={filtersActive}
          color={filtersActive ? 'primary' : 'default'}
          onClick={(e) => setFilterAnchor(e.currentTarget)}
          sx={{ position: 'absolute', top: 8, right: 8, zIndex: 5 }}
        >
          <FilterAltIcon fontSize="small" />
        </IconButton>
      </Tooltip>
      <Popover
        open={!!filterAnchor}
        anchorEl={filterAnchor}
        onClose={() => setFilterAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
        slotProps={{ paper: { sx: { width: 260 } } }}
      >
        <Stack spacing={1.5} sx={{ p: 2 }}>
          <Stack direction="row" spacing={1}>
            {[['7', '7d'], ['30', '30d'], ['all', 'All']].map(([p, label]) => (
              <Chip
                key={p}
                label={label}
                size="small"
                clickable
                onClick={() => {
                  const next = { preset: p, from: '', to: '' };
                  setSavedTimeframe(next);
                  updateQuery({ preset: p === 'all' ? null : p, from: null, to: null });
                }}
                color={preset === p ? 'primary' : 'default'}
                variant={preset === p ? 'filled' : 'outlined'}
              />
            ))}
          </Stack>
          <TextField
            type="date"
            size="small"
            label="From"
            value={preset === 'custom' ? from : ''}
            slotProps={{ inputLabel: { shrink: true } }}
            onChange={(e) => {
              const next = { preset: 'custom', from: e.target.value || '', to };
              setSavedTimeframe(next);
              updateQuery({ preset: 'custom', from: next.from || null, to: to || null });
            }}
            sx={{ width: '100%' }}
          />
          <TextField
            type="date"
            size="small"
            label="To"
            value={preset === 'custom' ? to : ''}
            slotProps={{ inputLabel: { shrink: true } }}
            onChange={(e) => {
              const next = { preset: 'custom', from, to: e.target.value || '' };
              setSavedTimeframe(next);
              updateQuery({ preset: 'custom', from: from || null, to: next.to || null });
            }}
            sx={{ width: '100%' }}
          />
        </Stack>
      </Popover>
      {list == null && listError == null && (
        <Box sx={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', zIndex: 20 }}>
          <CircularProgress />
        </Box>
      )}
      {listError != null && (
        <Box sx={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', zIndex: 20 }}>
          <Stack spacing={1} sx={{ alignItems: 'center' }}>
            <Typography variant="body2" color="error">
              {listError}
            </Typography>
            <Button size="small" variant="outlined" onClick={retryList}>
              Retry
            </Button>
          </Stack>
        </Box>
      )}
    </Box>
  );
}
