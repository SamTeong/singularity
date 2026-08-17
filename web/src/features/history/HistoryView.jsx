import { getTokens } from '@/theme/contract.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence, LayoutGroup, useScroll, useTransform, useSpring, useReducedMotion } from 'framer-motion';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import Chip from '@mui/material/Chip';
import TextField from '@mui/material/TextField';
import Snackbar from '@mui/material/Snackbar';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import Popover from '@mui/material/Popover';
import Tabs from '@mui/material/Tabs';
import Tab from '@mui/material/Tab';
import Autocomplete from '@mui/material/Autocomplete';
import Checkbox from '@mui/material/Checkbox';
import RefreshIcon from '@mui/icons-material/Refresh';
import UnfoldLessIcon from '@mui/icons-material/UnfoldLess';
import UnfoldMoreIcon from '@mui/icons-material/UnfoldMore';
import FilterAltIcon from '@mui/icons-material/FilterAlt';
import { EmptyState } from '@/components/EmptyState.jsx';
import TimelineIcon from '@mui/icons-material/Timeline';
import { useAgents } from '@/providers/AgentsProvider.jsx';
import { repoName } from '@/lib/paths.js';
import DayCard, { DayHeader, GapSegment, ShimmerCard, EASE_OUT } from '@/features/history/DayCard.jsx';

// Normalize a cwd for keying: lowercase + forward slashes + stripped tail.
// The agent records the same repo under different spellings across sessions
// (e.g. "C:\\git\\singularity" vs "c:\\git\\singularity" — 380 vs 61 sessions
// in the real archive), so keying on the raw string double-lists one repo.
// Mirrors server/stats.mjs `normCwd`.
const normCwd = (c) => (c || '').toLowerCase().replace(/\\/g, '/').replace(/\/+$/, '');

// The summarizer echoes each project's path back, but an LLM can normalize
// slashes or drop a drive letter — fall back to matching on the repo name.
function bulletsFor(entry, key) {
  const list = entry.projects || [];
  const exact = list.find((p) => normCwd(p.path) === key);
  const byName = exact || list.find((p) => repoName(p.path) === repoName(key));
  return byName?.bullets || [];
}

// Per-cwd split of a day. The server has no per-session token/cost breakdown
// (both are whole-session values already prorated into the day), so a
// project's share of the day's tokens/cost is its share of the day's turns.
function groupByProject(entry) {
  const total = entry.metrics?.turns || 0;
  const map = new Map();
  for (const s of entry.sessions || []) {
    const key = normCwd(s.cwd || s.project || 'unknown');
    let g = map.get(key);
    if (!g) map.set(key, (g = { key, label: repoName(key) || key, bullets: bulletsFor(entry, key), sessions: [], metrics: { sessions: 0, turns: 0, tokens: 0, costUsd: 0, byHarness: {} } }));
    const turns = s.dayTurns ?? s.turns ?? 0;
    const harness = s.source || 'claude';
    const hs = g.metrics.byHarness[harness] || (g.metrics.byHarness[harness] = { sessions: 0, turns: 0 });
    g.sessions.push(s);
    g.metrics.sessions++; g.metrics.turns += turns;
    hs.sessions++; hs.turns += turns;
  }
  const groups = [...map.values()];
  for (const g of groups) {
    const share = total > 0 ? Math.min(1, g.metrics.turns / total) : 1 / (groups.length || 1);
    g.metrics.tokens = Math.round((entry.metrics?.tokens || 0) * share);
    g.metrics.costUsd = Math.round((entry.metrics?.costUsd || 0) * share * 100) / 100;
  }
  return groups.sort((a, b) => b.metrics.turns - a.metrics.turns);
}

// Machine-local calendar day, same convention the daemon buckets by (see
// server/history.mjs) — this runs on the same machine (loopback app).
const todayLocal = () => new Date().toLocaleDateString('en-CA');
const daysAgoLocal = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toLocaleDateString('en-CA'); };

// Rows above this count switch from a plain render to a hand-rolled windowed
// slice (estimated uniform row height, no virtualization dependency).
const WINDOW_THRESHOLD = 60;
const AVG_ROW_PX = 220; // rough header + card row height + gap, for windowing math only

/** One archive row: a real entry, a still-summarizing placeholder, or both absent (never rendered). */
function Row({ row, expanded, onToggle, onOpenSession, onRegenerate, regenerating, scrollRef, skipEntranceAnim, onArrowNav, headerRef, reduceMotion, revealIndex, compact, projectFilter }) {
  const isGap = row.entry?.llm?.reason === 'empty';
  const showShimmer = row.pending && !row.entry;
  const allGroups = useMemo(() => (row.entry && !showShimmer && !isGap ? groupByProject(row.entry) : []), [row.entry, showShimmer, isGap]);
  // ponytail: project filter is a client-side superset of the server range —
  // a day still renders, only its non-matching cards drop out.
  const groups = useMemo(() => (projectFilter.size ? allGroups.filter((g) => projectFilter.has(g.key)) : allGroups), [allGroups, projectFilter]);
  // Crossfade text + height-settle on placeholder -> resolved: the outer
  // `layout` spring handles height, this inner fade handles the swap.
  const fade = { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 }, transition: { duration: reduceMotion ? 0 : 0.2 } };
  return (
    <motion.div layout={!reduceMotion} transition={{ layout: { type: 'spring', stiffness: 260, damping: 30 } }}>
      {/* popLayout, not "wait": "wait" exits fully before entering, which turns
          a crossfade into a sequential swap with a blank frame between. */}
      <AnimatePresence mode="popLayout" initial={false}>
        {showShimmer ? (
          <motion.div key="pending" {...fade}><ShimmerCard /></motion.div>
        ) : isGap ? (
          <motion.div key="gap" {...fade}><GapSegment date={row.date} /></motion.div>
        ) : (
          <motion.div key="card" {...fade}>
            <Stack spacing={1}>
              <DayHeader
                entry={row.entry}
                expanded={expanded}
                onToggle={onToggle}
                onRegenerate={onRegenerate}
                regenerating={regenerating}
                onArrowNav={onArrowNav}
                headerRef={headerRef}
              />
              {!!groups.length && (
                <Stack direction="row" spacing={2} sx={{ overflowX: 'auto', pb: 1, alignItems: 'stretch' }}>
                  {groups.map((g) => (
                    <DayCard
                      key={g.key}
                      card={g}
                      date={row.date}
                      expanded={expanded}
                      onToggle={onToggle}
                      onOpenSession={onOpenSession}
                      scrollRef={scrollRef}
                      skipEntranceAnim={skipEntranceAnim}
                      revealIndex={revealIndex}
                      compact={compact}
                    />
                  ))}
                </Stack>
              )}
            </Stack>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

/** Sticky 56px gutter: scroll-linked drill head, volume ticks, handoff label. */
function Spine({ scrollRef, rows, activeDate, reduceMotion }) {
  const { scrollYProgress } = useScroll({ container: scrollRef });
  const smoothProgress = useSpring(scrollYProgress, { stiffness: 180, damping: 30 });
  const drillTop = useTransform(smoothProgress, [0, 1], ['0%', '100%']);
  const weekday = activeDate ? new Date(`${activeDate}T00:00:00`).toLocaleDateString(undefined, { weekday: 'short' }) : '';
  const day = activeDate ? new Date(`${activeDate}T00:00:00`).getDate() : '';

  return (
    <Box sx={{ width: 56, flexShrink: 0, position: 'sticky', top: 0, alignSelf: 'flex-start', height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', pt: 1 }}>
      {/* popLayout, not "wait": "wait" exits fully before entering, which turns
          a crossfade into a sequential swap with a blank frame between. */}
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.div
          key={activeDate || 'none'}
          initial={reduceMotion ? { opacity: 1 } : { opacity: 0, y: -6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reduceMotion ? { opacity: 1 } : { opacity: 0, y: 6 }}
          transition={{ duration: reduceMotion ? 0 : 0.18, ease: EASE_OUT }}
        >
          <Stack sx={{ alignItems: 'center', minHeight: 34 }}>
            <Typography sx={{ fontSize: 9, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'text.secondary' }}>{weekday}</Typography>
            <Typography variant="code" sx={{ fontSize: 15, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{day}</Typography>
          </Stack>
        </motion.div>
      </AnimatePresence>

      <Box sx={{ position: 'relative', width: 2, flex: 1, mt: 1, mb: 2, bgcolor: (t) => (reduceMotion ? t.palette.primary.main : getTokens(t).glass.stroke) }}>
        {rows.map((r, i) => r.entry && !r.pending && r.entry.llm?.reason !== 'empty' && (
          <Box
            key={r.date}
            aria-hidden="true"
            sx={{
              position: 'absolute', left: -2, top: `${(i / Math.max(1, rows.length - 1)) * 100}%`,
              width: 6, height: Math.max(2, Math.min(10, 2 + Math.sqrt(r.entry.metrics?.turns || 0))),
              bgcolor: 'text.secondary', opacity: r.date === activeDate ? 0.9 : 0.35,
            }}
          />
        ))}
        {!reduceMotion && (
          // Transform-only travel: the wrapper spans the rail, so translateY in
          // percent of its own height maps 1:1 onto scroll progress. Animating
          // `top` instead would relayout the gutter every frame.
          <motion.div aria-hidden="true" style={{ position: 'absolute', left: -5, top: 0, width: 12, height: '100%', y: drillTop }}>
            <Box sx={{
              width: 12, height: 12, borderRadius: '50%', bgcolor: 'primary.main',
              boxShadow: '0 0 0 4px var(--mui-palette-action-hover)',
              animation: 'sing-history-drillhead 2.4s ease-in-out infinite alternate',
              '@keyframes sing-history-drillhead': { from: { opacity: 0.6 }, to: { opacity: 1 } },
            }} />
          </motion.div>
        )}
      </Box>
    </Box>
  );
}

/**
 * History — a core sample of daily work. Newest day at the surface, scrolling
 * drills backwards through time. Fetches the initial window, then prefers the
 * live WS push (`history` from useAgents, full replacement) once one arrives.
 */
export default function HistoryView({ onOpenSession }) {
  const { history } = useAgents();
  const reduceMotion = useReducedMotion();
  const scrollRef = useRef(null);
  const headerRefs = useRef({});
  const fetchSeq = useRef(0);
  // State, not a ref: DayCard reads this via props, and a ref flip alone
  // wouldn't re-render before the browser's focus()-triggered scroll fires
  // the IntersectionObserver whileInView relies on — the skip would never
  // actually land in time.
  const [keyboardNav, setKeyboardNav] = useState(false);
  const [compact, setCompact] = useState(false); // cards stripped to header + metrics

  const [today, setToday] = useState(null);
  const [fetchedEntries, setFetchedEntries] = useState([]);
  const [fetchedPending, setFetchedPending] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [preset, setPreset] = useState('7'); // '7' | '30' | 'all' | 'custom'
  const [customRange, setCustomRange] = useState({ from: '', to: '' });
  const [expanded, setExpanded] = useState(() => new Set());
  const [regenerating, setRegenerating] = useState(() => new Set());
  const [error, setError] = useState(null);
  const [activeDate, setActiveDate] = useState(null);
  const [focusDate, setFocusDate] = useState(null); // pending keyboard-nav focus target while windowed-out
  const [winRange, setWinRange] = useState([0, Infinity]);
  const [filterAnchor, setFilterAnchor] = useState(null);
  const [filterTab, setFilterTab] = useState('timeframe'); // 'timeframe' | 'projects'
  const [projectFilter, setProjectFilter] = useState(() => new Set()); // cwd keys; empty = all
  // Page-level exit/enter is keyed off the range itself (below) rather than a
  // counter bumped from an effect — same remount trigger, no extra render pass.
  const rangeKey = `${preset}:${customRange.from}:${customRange.to}`;

  // Initial + range-change fetch. The WS push (below) supersedes this once it
  // arrives, but each range change still needs a fresh server round-trip
  // because the WS payload is the *whole* archive, unfiltered.
  useEffect(() => {
    const params = new URLSearchParams();
    if (preset === '7') params.set('days', '7');
    else if (preset === '30') params.set('days', '30');
    else if (preset === 'all') { params.set('from', '1970-01-01'); params.set('to', todayLocal()); }
    else if (preset === 'custom') {
      if (customRange.from) params.set('from', customRange.from);
      if (customRange.to) params.set('to', customRange.to);
    }
    // Staleness guard, not an AbortController: flipping presets quickly can
    // land an older response after a newer one and stomp the right range.
    const mine = ++fetchSeq.current;
    fetch(`/api/history?${params}`).then((r) => r.json()).then((d) => {
      if (!d.ok || mine !== fetchSeq.current) return;
      setToday(d.today);
      setFetchedEntries(d.entries);
      setFetchedPending(d.pending);
      setLoaded(true);
    }).catch(() => { if (mine === fetchSeq.current) setError('Could not load history.'); });
  }, [preset, customRange.from, customRange.to]);

  // Merge: prefer the WS payload (full archive, ascending) over the initial
  // fetch (already server-filtered, descending) once a push has landed, then
  // re-apply the current range filter ourselves so both sources agree.
  const rows = useMemo(() => {
    const raw = history?.entries ?? fetchedEntries;
    const pendingRaw = history?.pending ?? fetchedPending;
    const ascending = [...raw].sort((a, b) => a.date.localeCompare(b.date));
    let windowed = ascending;
    if (preset === '7') windowed = ascending.slice(-7);
    else if (preset === '30') windowed = ascending.slice(-30);
    else if (preset === 'custom') {
      windowed = ascending.filter((e) => (!customRange.from || e.date >= customRange.from) && (!customRange.to || e.date <= customRange.to));
    }
    const entryByDate = new Map(windowed.map((e) => [e.date, e]));
    // Bound pending dates by the same window as entries — a stale global
    // backfill (e.g. left over from a different days= request) shouldn't leak
    // an unrelated placeholder row into this view.
    const pendingInRange = pendingRaw.filter((d) => {
      if (preset === '7') return d >= daysAgoLocal(7);
      if (preset === '30') return d >= daysAgoLocal(30);
      if (preset === 'custom') return (!customRange.from || d >= customRange.from) && (!customRange.to || d <= customRange.to);
      return true;
    });
    const dates = [...new Set([...entryByDate.keys(), ...pendingInRange])].sort();
    const list = dates.map((d) => ({ date: d, entry: entryByDate.get(d) || null, pending: pendingRaw.includes(d) })).reverse();
    if (today) list.unshift({ date: today.date, entry: today, pending: false });
    return list;
  }, [history, fetchedEntries, fetchedPending, today, preset, customRange.from, customRange.to]);

  const archiveMin = rows.length ? rows[rows.length - 1].date : todayLocal();
  const archiveMax = todayLocal();

  // Distinct projects across the in-range days — the Projects tab's source.
  // Keys are normalized cwds, so spelling variants of one repo collapse; if
  // two genuinely-distinct repos still share a repoName, disambiguate with
  // the parent dir so the dropdown never shows two identical labels.
  const projects = useMemo(() => {
    const byKey = new Map();
    for (const r of rows) {
      if (!r.entry || r.entry.llm?.reason === 'empty') continue;
      for (const g of groupByProject(r.entry)) if (!byKey.has(g.key)) byKey.set(g.key, g.label);
    }
    const entries = [...byKey.entries()].map(([key, label]) => ({ key, label }));
    const nameCount = new Map();
    for (const e of entries) nameCount.set(e.label, (nameCount.get(e.label) || 0) + 1);
    for (const e of entries) {
      if (nameCount.get(e.label) > 1) {
        const parts = e.key.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean);
        e.label = `${e.label} · ${parts[parts.length - 2] || e.key}`;
      }
    }
    return entries.sort((a, b) => a.label.localeCompare(b.label));
  }, [rows]);

  // Client-side project filter: empty set passes everything through, so the
  // unfiltered path stays a plain identity (no per-row alloc).
  const viewRows = useMemo(() => {
    if (!projectFilter.size) return rows;
    return rows.filter((r) => r.entry && (r.entry.sessions || []).some((s) => projectFilter.has(normCwd(s.cwd || s.project || 'unknown'))));
  }, [rows, projectFilter]);

  // The funnel tint: any deviation from the plain 7-day default reads as "on".
  const filtersActive = projectFilter.size > 0 || preset !== '7';

  // Windowed render past the threshold — estimated uniform row height, no
  // virtualization dependency. Keyboard nav below can still jump outside the
  // current window; it retries focus once the target re-mounts.
  const windowed = viewRows.length > WINDOW_THRESHOLD;
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !windowed) { setWinRange([0, viewRows.length]); return undefined; }
    let raf = 0;
    const update = () => {
      const top = el.scrollTop, vh = el.clientHeight;
      setWinRange([Math.max(0, Math.floor((top - 800) / AVG_ROW_PX)), Math.min(viewRows.length, Math.ceil((top + vh + 800) / AVG_ROW_PX))]);
    };
    update();
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; update(); }); };
    el.addEventListener('scroll', onScroll);
    return () => el.removeEventListener('scroll', onScroll);
  }, [windowed, viewRows.length]);
  const visibleRows = windowed ? viewRows.slice(winRange[0], winRange[1]) : viewRows;

  // Scrollspy for the spine's sticky-label handoff: the topmost day currently
  // crossing the "active" band (top 30% of the viewport) wins.
  useEffect(() => {
    const root = scrollRef.current;
    const targets = visibleRows.map((r) => [r.date, headerRefs.current[r.date]]).filter(([, el]) => el);
    if (!root || !targets.length) return undefined;
    const seen = new Map();
    const obs = new IntersectionObserver((ents) => {
      for (const en of ents) seen.set(en.target, en.isIntersecting);
      for (const [date, el] of targets) if (seen.get(el)) { setActiveDate(date); return; }
    }, { root, rootMargin: '0px 0px -70% 0px', threshold: 0 });
    for (const [, el] of targets) obs.observe(el);
    if (!activeDate && targets.length) setActiveDate(targets[0][0]);
    return () => obs.disconnect();
    // Re-arm on resolution too, not just on the date set: a day that was a
    // shimmer had no header to observe, and mounting one doesn't change the
    // date list — so without this it would never become the active date.
  }, [visibleRows.map((r) => `${r.date}:${r.entry ? 1 : 0}`).join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keyboard-nav retry: once the windowed-out target re-mounts, focus it.
  useEffect(() => {
    if (!focusDate) return;
    const el = headerRefs.current[focusDate];
    if (el) { el.focus(); setFocusDate(null); }
  }, [focusDate, visibleRows]);

  const moveFocus = useCallback((fromDate, delta) => {
    const idx = viewRows.findIndex((r) => r.date === fromDate);
    // Skip past gap days and unresolved placeholders: neither renders a
    // focusable header, so landing on one strands focus on nothing.
    const focusable = (r) => r.entry && r.entry.llm?.reason !== 'empty';
    let j = idx + delta;
    while (viewRows[j] && !focusable(viewRows[j])) j += delta;
    const next = viewRows[j];
    if (!next) return;
    setKeyboardNav(true);
    setTimeout(() => setKeyboardNav(false), 400);
    const el = headerRefs.current[next.date];
    if (el) { el.focus(); return; }
    const el2 = scrollRef.current;
    if (el2) el2.scrollTop = (idx + delta) * AVG_ROW_PX;
    setFocusDate(next.date);
  }, [viewRows]);

  const toggle = useCallback((date) => setExpanded((s) => {
    const n = new Set(s);
    n.has(date) ? n.delete(date) : n.add(date);
    return n;
  }), []);

  const regenerate = useCallback((date) => {
    setRegenerating((s) => new Set(s).add(date));
    fetch('/api/history/regenerate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ date }) })
      .then((r) => r.json())
      .then((d) => { if (!d.ok) setError(d.error || 'Regenerate failed.'); })
      .catch((e) => setError(e.message))
      .finally(() => setRegenerating((s) => { const n = new Set(s); n.delete(date); return n; }));
  }, []);

  // Eligible for a header-level bulk regenerate: real entries with a summary
  // (skip today — still live — and gap days).
  const regenerableRows = useMemo(
    () => rows.filter((r) => r.entry && !r.entry.live && r.entry.llm?.reason !== 'empty'),
    [rows],
  );
  const anyRegenerating = regenerableRows.some((r) => regenerating.has(r.date));
  const regenerateAll = useCallback(() => {
    for (const r of regenerableRows) regenerate(r.date);
  }, [regenerableRows, regenerate]);

  const setPresetChip = (p) => { setPreset(p); setCustomRange({ from: '', to: '' }); };

  // Collapsing to headers closes the open session panels too — a card cut back
  // to its metrics row shouldn't still have a session list hanging off it.
  const toggleCompact = () => setCompact((c) => { if (!c) setExpanded(new Set()); return !c; });

  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* minHeight matches the small-button header bars (button 42 + padding 28 + 1px border)
          so the title centers level with pages carrying a top-right control. */}
      <Stack direction="row" spacing={1.5} sx={{ p: 2, pb: 1.5, alignItems: 'center', flexWrap: 'wrap', minHeight: 71, borderBottom: (t) => `1px solid ${getTokens(t).glass.stroke}` }}>
        <Typography sx={{ fontSize: 20, fontWeight: 600 }}>History</Typography>
        <Tooltip title="Each card's left edge splits by harness in proportion to that project's turns; its opacity tracks the day's token volume." disableInteractive>
          <Stack direction="row" spacing={1.25} sx={{ alignItems: 'center', ml: 1, cursor: 'help' }}>
            {[['claude', 'primary.main'], ['codex', 'secondary.main']].map(([label, color]) => (
              <Stack key={label} direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
                <Box sx={{ width: 4, height: 12, bgcolor: color }} />
                <Typography sx={{ fontSize: 11, color: 'text.secondary' }}>{label}</Typography>
              </Stack>
            ))}
          </Stack>
        </Tooltip>
        <Box sx={{ flex: 1 }} />
        <Tooltip title={compact ? 'Expand cards' : 'Collapse cards to turns, tokens and cost'} disableInteractive>
          <IconButton size="small" aria-pressed={compact} onClick={toggleCompact}>
            {compact ? <UnfoldMoreIcon fontSize="small" /> : <UnfoldLessIcon fontSize="small" />}
          </IconButton>
        </Tooltip>
        <Tooltip title="Filter" disableInteractive>
          <IconButton
            size="small"
            aria-label="Filter history"
            aria-pressed={filtersActive}
            onClick={(e) => setFilterAnchor(e.currentTarget)}
            color={filtersActive ? 'primary' : 'default'}
          >
            <FilterAltIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Tooltip title={regenerableRows.length ? `Regenerate summaries (${regenerableRows.length} day${regenerableRows.length === 1 ? '' : 's'} in range)` : 'No summaries to regenerate'} disableInteractive>
          <span>
            <IconButton
              size="small"
              disabled={!regenerableRows.length || anyRegenerating}
              onClick={regenerateAll}
            >
              <RefreshIcon
                fontSize="small"
                sx={anyRegenerating ? {
                  animation: 'sing-history-spin 1s linear infinite',
                  '@keyframes sing-history-spin': { from: { transform: 'rotate(0deg)' }, to: { transform: 'rotate(360deg)' } },
                  '@media (prefers-reduced-motion: reduce)': { animation: 'none', opacity: 0.5 },
                } : undefined}
              />
            </IconButton>
          </span>
        </Tooltip>
      </Stack>

      <Box ref={scrollRef} sx={{ flex: 1, minHeight: 0, overflow: 'auto', display: 'flex', position: 'relative' }}>
        <Spine scrollRef={scrollRef} rows={viewRows} activeDate={activeDate} reduceMotion={reduceMotion} />

        <Box sx={{ flex: 1, minWidth: 0, p: 2, pl: 1 }}>
          {!loaded ? (
            <Typography sx={{ color: 'text.secondary' }}>Loading…</Typography>
          ) : viewRows.length === 0 ? (
            <Box sx={{ py: 4, display: 'grid', placeItems: 'center' }}>
              <EmptyState
                icon={<TimelineIcon />}
                title={rows.length ? 'No days match the selected projects' : 'No history in this range'}
                description={rows.length ? 'Clear the project filter, or widen it to more projects.' : 'Pick a wider range, or wait for the daily archive to catch up.'}
              />
            </Box>
          ) : (
            <LayoutGroup>
              <AnimatePresence mode="popLayout" initial={false}>
                <motion.div
                  key={rangeKey}
                  initial={reduceMotion ? { opacity: 1 } : { opacity: 0, y: -8 }}
                  animate={{ opacity: 1, y: 0, transition: { duration: reduceMotion ? 0.05 : 0.29, ease: EASE_OUT } }}
                  // Asymmetric on purpose: leave fast, settle in slower.
                  exit={{ opacity: 0, y: reduceMotion ? 0 : -8, transition: { duration: reduceMotion ? 0.05 : 0.2, ease: EASE_OUT } }}
                >
                  <Stack spacing={3} sx={{ pb: 2 }}>
                    {windowed && winRange[0] > 0 && <Box sx={{ height: winRange[0] * AVG_ROW_PX }} />}
                    {visibleRows.map((row, i) => (
                      <Row
                        key={row.date}
                        revealIndex={i}
                        row={row}
                        expanded={expanded.has(row.date)}
                        onToggle={() => toggle(row.date)}
                        onOpenSession={onOpenSession}
                        onRegenerate={regenerate}
                        regenerating={regenerating.has(row.date)}
                        scrollRef={scrollRef}
                        skipEntranceAnim={keyboardNav || reduceMotion}
                        onArrowNav={(delta) => moveFocus(row.date, delta)}
                        headerRef={(el) => { headerRefs.current[row.date] = el; }}
                        reduceMotion={reduceMotion}
                        compact={compact}
                        projectFilter={projectFilter}
                      />
                    ))}
                    {windowed && winRange[1] < viewRows.length && <Box sx={{ height: (viewRows.length - winRange[1]) * AVG_ROW_PX }} />}
                  </Stack>
                </motion.div>
              </AnimatePresence>
            </LayoutGroup>
          )}
        </Box>
      </Box>

      <Popover
        open={!!filterAnchor}
        anchorEl={filterAnchor}
        onClose={() => setFilterAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
        slotProps={{ paper: { sx: { width: 300, display: 'flex', flexDirection: 'column' } } }}
      >
        <Tabs value={filterTab} onChange={(_, v) => setFilterTab(v)} sx={{ minHeight: 40, px: 1 }}>
          <Tab value="timeframe" label="Timeframe" sx={{ minHeight: 40, textTransform: 'none' }} />
          <Tab value="projects" label="Projects" sx={{ minHeight: 40, textTransform: 'none' }} />
        </Tabs>
        {filterTab === 'timeframe' ? (
          <Stack spacing={1.5} sx={{ p: 2, pt: 1.5 }}>
            <Stack direction="row" spacing={1}>
              {[['7', '7d'], ['30', '30d'], ['all', 'All']].map(([p, label]) => (
                <Chip key={p} label={label} size="small" clickable onClick={() => setPresetChip(p)} color={preset === p ? 'primary' : 'default'} variant={preset === p ? 'filled' : 'outlined'} />
              ))}
            </Stack>
            <TextField
              type="date" size="small" label="From" value={customRange.from}
              slotProps={{ inputLabel: { shrink: true }, htmlInput: { min: archiveMin, max: archiveMax } }}
              onChange={(e) => { setPreset('custom'); setCustomRange((r) => ({ ...r, from: e.target.value })); }}
              sx={{ width: '100%' }}
            />
            <TextField
              type="date" size="small" label="To" value={customRange.to}
              slotProps={{ inputLabel: { shrink: true }, htmlInput: { min: archiveMin, max: archiveMax } }}
              onChange={(e) => { setPreset('custom'); setCustomRange((r) => ({ ...r, to: e.target.value })); }}
              sx={{ width: '100%' }}
            />
          </Stack>
        ) : (
          <Box sx={{ p: 2, pt: 1.5 }}>
            {projects.length === 0 ? (
              <Typography sx={{ color: 'text.secondary', py: 1, fontSize: 13 }}>No projects in this range.</Typography>
            ) : (
              <Autocomplete
                multiple
                size="small"
                disableCloseOnSelect
                options={projects}
                value={projects.filter((p) => projectFilter.has(p.key))}
                onChange={(_, v) => setProjectFilter(new Set(v.map((p) => p.key)))}
                getOptionLabel={(p) => p.label}
                isOptionEqualToValue={(a, b) => a.key === b.key}
                renderOption={({ key, ...props }, option, { selected }) => (
                  <li {...props} key={key}>
                    <Checkbox size="small" checked={selected} style={{ marginRight: 8 }} />
                    {option.label}
                  </li>
                )}
                renderInput={(params) => (
                  <TextField {...params} label="Projects" placeholder="" />
                )}
              />
            )}
          </Box>
        )}
      </Popover>

      <Snackbar open={!!error} autoHideDuration={5000} onClose={() => setError(null)} message={error} anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }} />
    </Box>
  );
}
