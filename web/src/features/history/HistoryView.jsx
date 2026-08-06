import { getTokens } from '@/theme/contract.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence, LayoutGroup, useScroll, useTransform, useSpring, useReducedMotion } from 'framer-motion';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import Chip from '@mui/material/Chip';
import TextField from '@mui/material/TextField';
import Snackbar from '@mui/material/Snackbar';
import { EmptyState } from '@zapac/mui-theme';
import TimelineIcon from '@mui/icons-material/Timeline';
import { useAgents } from '@/providers/AgentsProvider.jsx';
import DayCard, { GapSegment, ShimmerCard } from '@/features/history/DayCard.jsx';

// Machine-local calendar day, same convention the daemon buckets by (see
// server/history.mjs) — this runs on the same machine (loopback app).
const todayLocal = () => new Date().toLocaleDateString('en-CA');
const daysAgoLocal = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toLocaleDateString('en-CA'); };

// Rows above this count switch from a plain render to a hand-rolled windowed
// slice (estimated uniform row height, no virtualization dependency).
const WINDOW_THRESHOLD = 60;
const AVG_ROW_PX = 190; // rough card height + gap, for windowing math only

/** One archive row: a real entry, a still-summarizing placeholder, or both absent (never rendered). */
function Row({ row, expanded, onToggle, onOpenSession, onRegenerate, regenerating, scrollRef, skipEntranceAnim, onArrowNav, headerRef, reduceMotion }) {
  const isGap = row.entry?.llm?.reason === 'empty';
  const showShimmer = row.pending && !row.entry;
  // Crossfade text + height-settle on placeholder -> resolved: the outer
  // `layout` spring handles height, this inner fade handles the swap.
  const fade = { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 }, transition: { duration: reduceMotion ? 0 : 0.2 } };
  return (
    <motion.div layout={!reduceMotion} transition={{ layout: { type: 'spring', stiffness: 260, damping: 30 } }}>
      <AnimatePresence mode="wait" initial={false}>
        {showShimmer ? (
          <motion.div key="pending" {...fade}><ShimmerCard /></motion.div>
        ) : isGap ? (
          <motion.div key="gap" {...fade}><GapSegment date={row.date} /></motion.div>
        ) : (
          <motion.div key="card" {...fade}>
            <DayCard
              entry={row.entry}
              expanded={expanded}
              onToggle={onToggle}
              onOpenSession={onOpenSession}
              onRegenerate={onRegenerate}
              regenerating={regenerating}
              scrollRef={scrollRef}
              skipEntranceAnim={skipEntranceAnim}
              onArrowNav={onArrowNav}
              headerRef={headerRef}
            />
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
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={activeDate || 'none'}
          initial={reduceMotion ? { opacity: 1 } : { opacity: 0, y: -6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reduceMotion ? { opacity: 1 } : { opacity: 0, y: 6 }}
          transition={{ duration: reduceMotion ? 0 : 0.18, ease: 'easeOut' }}
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
  // State, not a ref: DayCard reads this via props, and a ref flip alone
  // wouldn't re-render before the browser's focus()-triggered scroll fires
  // the IntersectionObserver whileInView relies on — the skip would never
  // actually land in time.
  const [keyboardNav, setKeyboardNav] = useState(false);

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
  const [renderKey, setRenderKey] = useState(0); // bumped on range change → page-level exit/enter

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
    fetch(`/history?${params}`).then((r) => r.json()).then((d) => {
      if (!d.ok) return;
      setToday(d.today);
      setFetchedEntries(d.entries);
      setFetchedPending(d.pending);
      setLoaded(true);
    }).catch(() => setError('Could not load history.'));
    setRenderKey((k) => k + 1);
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

  // Windowed render past the threshold — estimated uniform row height, no
  // virtualization dependency. Keyboard nav below can still jump outside the
  // current window; it retries focus once the target re-mounts.
  const windowed = rows.length > WINDOW_THRESHOLD;
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !windowed) { setWinRange([0, rows.length]); return undefined; }
    let raf = 0;
    const update = () => {
      const top = el.scrollTop, vh = el.clientHeight;
      setWinRange([Math.max(0, Math.floor((top - 800) / AVG_ROW_PX)), Math.min(rows.length, Math.ceil((top + vh + 800) / AVG_ROW_PX))]);
    };
    update();
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; update(); }); };
    el.addEventListener('scroll', onScroll);
    return () => el.removeEventListener('scroll', onScroll);
  }, [windowed, rows.length]);
  const visibleRows = windowed ? rows.slice(winRange[0], winRange[1]) : rows;

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
  }, [visibleRows.map((r) => r.date).join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keyboard-nav retry: once the windowed-out target re-mounts, focus it.
  useEffect(() => {
    if (!focusDate) return;
    const el = headerRefs.current[focusDate];
    if (el) { el.focus(); setFocusDate(null); }
  }, [focusDate, visibleRows]);

  const moveFocus = useCallback((fromDate, delta) => {
    const idx = rows.findIndex((r) => r.date === fromDate);
    const next = rows[idx + delta];
    if (!next) return;
    setKeyboardNav(true);
    setTimeout(() => setKeyboardNav(false), 400);
    const el = headerRefs.current[next.date];
    if (el) { el.focus(); return; }
    const el2 = scrollRef.current;
    if (el2) el2.scrollTop = (idx + delta) * AVG_ROW_PX;
    setFocusDate(next.date);
  }, [rows]);

  const toggle = useCallback((date) => setExpanded((s) => {
    const n = new Set(s);
    n.has(date) ? n.delete(date) : n.add(date);
    return n;
  }), []);

  const regenerate = useCallback((date) => {
    setRegenerating((s) => new Set(s).add(date));
    fetch('/history/regenerate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ date }) })
      .then((r) => r.json())
      .then((d) => { if (!d.ok) setError(d.error || 'Regenerate failed.'); })
      .catch((e) => setError(e.message))
      .finally(() => setRegenerating((s) => { const n = new Set(s); n.delete(date); return n; }));
  }, []);

  const setPresetChip = (p) => { setPreset(p); setCustomRange({ from: '', to: '' }); };

  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <Stack direction="row" spacing={1.5} sx={{ p: 2, pb: 1.5, alignItems: 'center', flexWrap: 'wrap', borderBottom: (t) => `1px solid ${getTokens(t).glass.stroke}` }}>
        <Typography sx={{ fontSize: 20, fontWeight: 600 }}>History</Typography>
        <Box sx={{ flex: 1 }} />
        {[['7', '7d'], ['30', '30d'], ['all', 'All']].map(([p, label]) => (
          <Chip key={p} label={label} size="small" clickable onClick={() => setPresetChip(p)} color={preset === p ? 'primary' : 'default'} variant={preset === p ? 'filled' : 'outlined'} />
        ))}
        <TextField
          type="date" size="small" label="From" value={customRange.from}
          slotProps={{ inputLabel: { shrink: true }, htmlInput: { min: archiveMin, max: archiveMax } }}
          onChange={(e) => { setPreset('custom'); setCustomRange((r) => ({ ...r, from: e.target.value })); }}
          sx={{ width: 150 }}
        />
        <TextField
          type="date" size="small" label="To" value={customRange.to}
          slotProps={{ inputLabel: { shrink: true }, htmlInput: { min: archiveMin, max: archiveMax } }}
          onChange={(e) => { setPreset('custom'); setCustomRange((r) => ({ ...r, to: e.target.value })); }}
          sx={{ width: 150 }}
        />
      </Stack>

      <Box ref={scrollRef} sx={{ flex: 1, minHeight: 0, overflow: 'auto', display: 'flex' }}>
        <Spine scrollRef={scrollRef} rows={rows} activeDate={activeDate} reduceMotion={reduceMotion} />

        <Box sx={{ flex: 1, minWidth: 0, p: 2, pl: 1 }}>
          {!loaded ? (
            <Typography sx={{ color: 'text.secondary' }}>Loading…</Typography>
          ) : rows.length === 0 ? (
            <Box sx={{ py: 4, display: 'grid', placeItems: 'center' }}>
              <EmptyState icon={<TimelineIcon />} title="No history in this range" description="Pick a wider range, or wait for the daily archive to catch up." />
            </Box>
          ) : (
            <LayoutGroup>
              <AnimatePresence mode="popLayout" initial={false}>
                <motion.div
                  key={renderKey}
                  initial={reduceMotion ? { opacity: 1 } : { opacity: 0, y: -8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -8 }}
                  transition={{ duration: reduceMotion ? 0.05 : 0.2, ease: 'easeOut' }}
                >
                  <Stack spacing={3} sx={{ pb: 2 }}>
                    {windowed && winRange[0] > 0 && <Box sx={{ height: winRange[0] * AVG_ROW_PX }} />}
                    {visibleRows.map((row) => (
                      <Row
                        key={row.date}
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
                      />
                    ))}
                    {windowed && winRange[1] < rows.length && <Box sx={{ height: (rows.length - winRange[1]) * AVG_ROW_PX }} />}
                  </Stack>
                </motion.div>
              </AnimatePresence>
            </LayoutGroup>
          )}
        </Box>
      </Box>

      <Snackbar open={!!error} autoHideDuration={5000} onClose={() => setError(null)} message={error} anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }} />
    </Box>
  );
}
