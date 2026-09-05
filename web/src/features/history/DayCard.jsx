import { getTokens } from '@/theme/contract.js';
import { useRef } from 'react';
import { motion, AnimatePresence, useScroll, useTransform, useSpring, useReducedMotion } from 'framer-motion';
import { matches } from '@/lib/keys.js';
import { useKeys } from '@/providers/KeysProvider.jsx';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import Chip from '@mui/material/Chip';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import RefreshIcon from '@mui/icons-material/Refresh';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import { fmtUsd, fmtTokens } from '@/lib/format.js';

// motion.create() over a plain motion.article: the card needs `sx` (MUI's styling
// prop, unsupported on bare motion.<tag> primitives) alongside layout/reveal.
const MotionArticle = motion.create(Box);
const MotionBox = motion.create(Box);

export const EASE_OUT = [0.16, 1, 0.3, 1];
const SPRING_EXPAND = { type: 'spring', stiffness: 320, damping: 34, mass: 0.9 };

// Fixed per-project card width — the day row is a horizontal stack of these.
export const CARD_WIDTH = 300;
// Collapsed cards carry a label and one metrics line — narrower, so more of
// the day's projects fit before the row starts scrolling.
const COMPACT_WIDTH = 210;

// Card min-height scales with turns, sqrt-damped so a 10x day isn't 10x tall.
const cardHeight = (turns) => Math.round(Math.min(220, Math.max(88, 88 + 16 * Math.sqrt(turns || 0))));
// Density-band opacity from token volume — flatter than linear so a huge day
// doesn't just read as "100% opaque" next to a merely-large one.
const densityOpacity = (tokens) => Math.min(1, 0.14 + 0.86 * Math.min(1, (tokens || 0) / 150_000));

const fmtDateLabel = (date) => new Date(`${date}T00:00:00`).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
export const fmtDateShort = (date) => new Date(`${date}T00:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });

/** Compact metric: 11px uppercase-tracked label over a tabular-figures value. */
function Metric({ label, value }) {
  if (value == null) return null;
  return (
    <Box sx={{ minWidth: 0 }}>
      <Typography sx={{ fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'text.secondary', lineHeight: 1.3 }}>{label}</Typography>
      <Typography variant="code" sx={{ fontSize: 13, fontVariantNumeric: 'tabular-nums', lineHeight: 1.3 }} noWrap>{value}</Typography>
    </Box>
  );
}

function SessionRow({ s, onOpen }) {
  const isCodex = s.source === 'codex';
  const open = () => onOpen(s);
  return (
    <Box
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } }}
      sx={(t) => ({
        display: 'flex', alignItems: 'center', gap: 1, px: 1, py: 0.75, borderRadius: `${getTokens(t).radius.sm}px`, cursor: 'pointer',
        '@media (hover: hover) and (pointer: fine)': { '&:hover': { bgcolor: 'action.hover' } },
        '&:active': { transform: 'scale(0.97)', transition: 'transform 120ms ease-out' },
        '&:focus-visible': { outline: `2px solid ${t.palette.primary.main}`, outlineOffset: 2 },
      })}
    >
      <Box sx={{ width: 6, height: 6, flexShrink: 0, bgcolor: isCodex ? 'secondary.main' : 'primary.main', transform: 'rotate(45deg)' }} aria-hidden="true" />
      <Typography variant="body2" noWrap title={s.title || s.blurb || s.id} sx={{ flex: 1, minWidth: 0 }}>{s.title || s.blurb || s.id}</Typography>
      <Typography variant="code" sx={{ fontSize: 11, color: 'text.secondary', fontVariantNumeric: 'tabular-nums' }}>{s.dayTurns ?? s.turns}t</Typography>
      <PlayArrowIcon sx={{ fontSize: 14, color: 'text.disabled' }} />
    </Box>
  );
}

// Compressed gap-day segment: no card, a hairline on the timeline. Absence is
// information — a day the archive knows about but has nothing to say about.
export function GapSegment({ date }) {
  return (
    <Box aria-label={`${fmtDateLabel(date)}, no work`} sx={{ height: 20, display: 'flex', alignItems: 'center', pl: 1, opacity: 0.5 }}>
      <Box sx={(t) => ({ flex: 1, height: 1, bgcolor: getTokens(t).glass.stroke })} />
    </Box>
  );
}

// Shimmering placeholder for a day still being summarized (pending backfill,
// or an in-flight regenerate). CSS-driven — never a JS animation loop.
export function ShimmerCard() {
  return (
    <Box
      aria-busy="true"
      sx={(t) => ({
        minHeight: 96, maxWidth: 720, borderRadius: `${getTokens(t).radius.md}px`, border: `1px solid ${getTokens(t).glass.stroke}`,
        background: 'linear-gradient(100deg, transparent 35%, var(--mui-palette-action-hover) 50%, transparent 65%)',
        backgroundSize: '200% 100%', animation: 'sing-history-shimmer 1.6s linear infinite',
        '@keyframes sing-history-shimmer': { from: { backgroundPosition: '150% 0' }, to: { backgroundPosition: '-50% 0' } },
        '@media (prefers-reduced-motion: reduce)': { animation: 'none', background: 'var(--mui-palette-action-hover)' },
      })}
    />
  );
}

/**
 * Day-level row header: date, live status, the day's aggregate metrics, and
 * (once summarized) the digest text, topics and provenance/regenerate
 * controls. Sits above the horizontal stack of per-project `DayCard`s and
 * owns the row's single expand/collapse toggle + keyboard nav.
 */
export function DayHeader({ entry, expanded, onToggle, onRegenerate, regenerating, onArrowNav, headerRef }) {
  const reduceMotion = useReducedMotion();
  const { keys } = useKeys();
  const m = entry.metrics || {};
  const isToday = !!entry.live;
  const panelId = `history-day-${entry.date}`;
  const sessionsLabel = `${m.sessions || 0} session${m.sessions === 1 ? '' : 's'}`;
  const ariaLabel = `${fmtDateLabel(entry.date)}, ${sessionsLabel}`;

  const onHeaderKeyDown = (e) => {
    // a11y: role="button" must always activate on Enter/Space (WCAG) — the custom dayToggle binding is additive, never a replacement.
    if (matches(keys.dayToggle, e) || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); }
    else if (matches(keys.dayNext, e)) { e.preventDefault(); onArrowNav(1); }
    else if (matches(keys.dayPrev, e)) { e.preventDefault(); onArrowNav(-1); }
  };

  return (
    <MotionBox
      layout={reduceMotion ? false : 'position'}
      ref={headerRef}
      role="button"
      tabIndex={0}
      aria-expanded={expanded}
      aria-controls={panelId}
      aria-label={ariaLabel}
      onClick={onToggle}
      onKeyDown={onHeaderKeyDown}
      sx={{ display: 'flex', flexDirection: 'column', gap: 0.5, px: 0.5, pb: 1, cursor: 'pointer', '&:focus-visible': { outline: (t) => `2px solid ${t.palette.primary.main}`, outlineOffset: -2 } }}
    >
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
        <Typography sx={{ fontWeight: 700, fontSize: 14 }}>{fmtDateShort(entry.date)}</Typography>
        {isToday && <Chip label="Live" size="small" color="success" sx={{ height: 18, fontSize: 10 }} />}
        <Typography variant="code" sx={{ fontSize: 11, color: 'text.secondary' }}>{sessionsLabel}</Typography>
        <Stack direction="row" spacing={2.5} sx={{ ml: 1 }}>
          <Metric label="Turns" value={m.turns} />
          <Metric label="Tokens" value={fmtTokens(m.tokens || 0)} />
          <Metric label="Cost" value={fmtUsd(m.costUsd) ?? '—'} />
        </Stack>
        <Box sx={{ flex: 1 }} />
        {!isToday && (
          <>
            <Typography variant="code" sx={{ fontSize: 11, color: 'text.secondary' }}>
              {entry.llm?.ok
                ? `summarized by: ${entry.llm.provider === 'anthropic-oauth' ? 'claude' : entry.llm.provider ?? 'auto'}`
                : entry.llm?.reason === 'trivial' ? 'summarized by: auto — trivial day'
                : entry.llm?.reason === 'no-summariser' ? 'no summariser configured — see Settings ▸ Models'
                : 'summary unavailable'}
            </Typography>
            {!!entry.llm?.dropped?.length && (
              <Tooltip title={`Dropped from digest: ${entry.llm.dropped.join(', ')}`} disableInteractive>
                <Typography variant="code" sx={{ fontSize: 11, color: 'warning.main', cursor: 'help' }}>{entry.llm.dropped.length} dropped</Typography>
              </Tooltip>
            )}
            <Tooltip title="Regenerate summary" disableInteractive>
              <IconButton size="small" disabled={regenerating} onClick={(e) => { e.stopPropagation(); onRegenerate(entry.date); }}>
                <RefreshIcon
                  fontSize="small"
                  sx={regenerating ? {
                    animation: 'sing-history-spin 1s linear infinite',
                    '@keyframes sing-history-spin': { from: { transform: 'rotate(0deg)' }, to: { transform: 'rotate(360deg)' } },
                    '@media (prefers-reduced-motion: reduce)': { animation: 'none', opacity: 0.5 },
                  } : undefined}
                />
              </IconButton>
            </Tooltip>
          </>
        )}
      </Stack>

      {/* The day's narrative lives in each project card's bullets — the header
          carries only date, status, metrics and topics. */}
      {isToday && (
        <Typography sx={{ fontSize: 13, color: 'text.secondary', fontStyle: 'italic' }}>In progress — updates as you work.</Typography>
      )}

      {!!entry.topics?.length && (
        <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap', mt: 0.5 }}>
          {entry.topics.map((topic) => <Chip key={topic} label={topic} size="small" variant="outlined" sx={{ height: 20, fontSize: 11 }} />)}
        </Stack>
      )}
    </MotionBox>
  );
}

/**
 * One project's card within a day: a stratum whose height (turns) and
 * density-band opacity (tokens) encode volume at a glance. Collapses to just
 * the header row; expands in place to that project's sessions for the day.
 */
export default function DayCard({ card, date, expanded, onToggle, onOpenSession, scrollRef, skipEntranceAnim, revealIndex = 0, compact = false }) {
  const reduceMotion = useReducedMotion();
  const { keys } = useKeys();
  const bandRef = useRef(null);

  const { scrollYProgress } = useScroll({ target: bandRef, container: scrollRef, offset: ['start end', 'end start'] });
  const rawParallax = useTransform(scrollYProgress, [0, 1], ['-3%', '3%']);
  const parallaxY = useSpring(rawParallax, { stiffness: 180, damping: 30 });

  const m = card.metrics || {};
  const bullets = (card.bullets || []).slice(0, 3);
  const claudeTurns = m.byHarness?.claude?.turns || 0;
  const codexTurns = m.byHarness?.codex?.turns || 0;
  const harnessTotal = claudeTurns + codexTurns || 1;
  const claudePct = (claudeTurns / harnessTotal) * 100;
  // Compact strips the bullets, so the turns-scaled min-height would leave a
  // tall empty box — let the header row size the card instead.
  const height = compact ? 0 : cardHeight(m.turns);
  const density = densityOpacity(m.tokens);
  const panelId = `history-day-${date}-${card.key}`;
  const sessionsLabel = `${m.sessions || 0} session${m.sessions === 1 ? '' : 's'}`;
  const ariaLabel = `${card.label}, ${fmtDateShort(date)}, ${sessionsLabel}${m.costUsd != null ? `, ${fmtUsd(m.costUsd) || '$0.00'}` : ''}`;

  const noTransform = reduceMotion;
  const variants = {
    hidden: noTransform ? { opacity: 0 } : { opacity: 0, y: 16, scale: 0.985 },
    visible: { opacity: 1, y: 0, scale: 1 },
  };
  const revealProps = skipEntranceAnim
    ? { initial: false, animate: 'visible' }
    : { initial: 'hidden', whileInView: 'visible', viewport: { once: true, margin: '-10% 0px' } };

  const onHeaderKeyDown = (e) => {
    // a11y: role="button" must always activate on Enter/Space (WCAG) — the custom dayToggle binding is additive, never a replacement.
    if (matches(keys.dayToggle, e) || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); }
  };

  return (
    <MotionArticle
      component="article"
      layout={!reduceMotion}
      variants={variants}
      {...revealProps}
      transition={{
        duration: reduceMotion ? 0.01 : 0.29,
        ease: EASE_OUT,
        // 60ms stagger, capped at 8 so a card deep in the list doesn't sit
        // behind a half-second delay before it reveals.
        delay: reduceMotion || skipEntranceAnim ? 0 : Math.min(revealIndex, 7) * 0.06,
        layout: reduceMotion ? { duration: 0 } : SPRING_EXPAND,
      }}
      aria-label={ariaLabel}
      sx={{ width: compact ? COMPACT_WIDTH : CARD_WIDTH, flexShrink: 0, alignSelf: 'stretch' }}
    >
      {/* Hover/press live on an inner element, not the motion one: framer writes
          transform inline for the reveal + layout animations, and an inline
          style beats any stylesheet rule — the lift would never fire. */}
      <Box sx={(t) => ({
        position: 'relative', height: '100%', minHeight: height, borderRadius: `${getTokens(t).radius.md}px`,
        border: `1px solid ${getTokens(t).glass.stroke}`, overflow: 'hidden',
        transition: 'transform 160ms ease-out, box-shadow 160ms ease-out',
        '@media (hover: hover) and (pointer: fine)': { '&:hover': { transform: 'translateY(-2px)', boxShadow: '0 8px 24px rgba(0,0,0,.18)' } },
        '&:active': { transform: 'scale(0.97)', transition: 'transform 120ms ease-out' },
        '@media (prefers-reduced-motion: reduce)': { transition: 'none' },
      })}>
      {/* Density band: leading-edge harness split, opacity from token volume, ~0.94x parallax rate. */}
      <motion.div ref={bandRef} style={{ position: 'absolute', insetInlineStart: 0, top: -8, bottom: -8, width: 4, y: reduceMotion ? 0 : parallaxY }}>
        <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
          <Box sx={{ flexBasis: `${claudePct}%`, bgcolor: 'primary.main', opacity: density }} />
          <Box sx={{ flexBasis: `${100 - claudePct}%`, bgcolor: 'secondary.main', opacity: density }} />
        </Box>
      </motion.div>

      {/* layout="position" so the parent's FLIP height animation translates this
          block instead of scale-stretching its text and chips. */}
      <MotionBox
        layout={reduceMotion ? false : 'position'}
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        aria-controls={panelId}
        onClick={onToggle}
        onKeyDown={onHeaderKeyDown}
        sx={{ p: compact ? 1 : 2, pl: compact ? 1.5 : 2.5, display: 'flex', flexDirection: 'column', gap: compact ? 0.25 : 1, cursor: 'pointer', '&:focus-visible': { outline: (t) => `2px solid ${t.palette.primary.main}`, outlineOffset: -2 } }}
      >
        <Stack direction="row" spacing={1} sx={{ alignItems: 'baseline' }}>
          <Typography sx={{ fontWeight: 700, fontSize: compact ? 13 : 14 }} noWrap title={card.key}>{card.label}</Typography>
          <Box sx={{ flex: 1 }} />
          <Typography variant="code" sx={{ fontSize: 11, color: 'text.secondary' }}>{compact ? `${m.sessions || 0}s` : sessionsLabel}</Typography>
        </Stack>

        {compact ? (
          // One tabular line instead of three labelled metrics — the labels are
          // the same on every card, so at this density they're just noise.
          <Typography variant="code" title="turns · tokens · cost" noWrap sx={{ fontSize: 11.5, color: 'text.secondary', fontVariantNumeric: 'tabular-nums' }}>
            {`${m.turns || 0}t · ${fmtTokens(m.tokens || 0)} · ${fmtUsd(m.costUsd) ?? '—'}`}
          </Typography>
        ) : (
          <Stack direction="row" spacing={2.5} sx={{ mt: 0.5 }}>
            <Metric label="Turns" value={m.turns} />
            <Metric label="Tokens" value={fmtTokens(m.tokens || 0)} />
            <Metric label="Cost" value={fmtUsd(m.costUsd) ?? '—'} />
          </Stack>
        )}

        {/* 0.7em ≈ half a 1.45 line — bullets read as separate points, not a block */}
        {!compact && !!bullets.length && (
          <Box component="ul" sx={{ m: 0, mt: 0.5, pl: 2, '& li + li': { mt: '0.7em' } }}>
            {/* index key: bullets are positional strings, and two sessions with
                the same title (or an LLM repeating itself) collide on value */}
            {bullets.map((b, i) => (
              <Typography key={i} component="li" sx={{ fontSize: 13, lineHeight: 1.45, color: 'text.secondary', '&::marker': { color: 'text.disabled' } }}>{b}</Typography>
            ))}
          </Box>
        )}
      </MotionBox>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            id={panelId}
            role="region"
            aria-label={`Sessions — ${card.label}`}
            initial={reduceMotion ? { opacity: 1 } : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={reduceMotion ? { opacity: 1 } : { opacity: 0 }}
            transition={{ duration: reduceMotion ? 0 : 0.18 }}
          >
            <Box sx={{ px: 1.5, pb: 1.5 }}>
              <motion.div
                initial={reduceMotion ? false : 'hidden'}
                animate="visible"
                variants={{ hidden: {}, visible: { transition: { staggerChildren: reduceMotion ? 0 : 0.04 } } }}
              >
                {(card.sessions || []).map((s) => (
                  <motion.div key={s.id} variants={{ hidden: noTransform ? { opacity: 0 } : { opacity: 0, y: 8 }, visible: { opacity: 1, y: 0 } }}>
                    <SessionRow s={s} onOpen={(sess) => onOpenSession({ project: sess.project, id: sess.id, cwd: sess.cwd, source: sess.source, mtime: Date.now() })} />
                  </motion.div>
                ))}
              </motion.div>
            </Box>
          </motion.div>
        )}
      </AnimatePresence>
      </Box>
    </MotionArticle>
  );
}
