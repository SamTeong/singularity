// Task detail panel — right-anchored sheet opened by a Board card click
// (replaces the card → transcript-dock behaviour). Slides in over a scrim,
// dismissible via close / scrim / Escape, with focus trap + focus restore to the
// originating card (MUI Drawer/Modal gives all three). Honours prefers-reduced-
// motion by collapsing the slide transition to an instant state change.
//
// Anatomy mirrors layout-02's `.detail`: head (status pill + short id + close) →
// title → repo/branch → body (3-cell stats grid · Task description · Details dl ·
// Activity stage list) → foot ("View transcript" ghost + "Open session" primary).
//
// Two deliberate departures from the mockup:
//  - The sheet is OPAQUE (`--surface-solid`), not glass. It's the only surface in
//    the shell that stacks over other content; translucency there turns the board
//    behind it into visual noise.
//  - It's anchored to the VIEWPORT, not to `.view-body` as in the mockup. The
//    mockup's sheet is `aria-modal="false"` chrome; this one is a real modal with
//    a focus trap and focus restore, and a trap whose scrim covers only part of
//    the screen invites clicks it then has to yank focus back from. The scrim
//    value is the mockup's, so the shell stays legible behind it.
//
// Phosphor dossier (task 5.4): under the `phosphor` skin the same sheet renders
// as a chamfered fixed console dossier — void surface, orange inner edge,
// semantic status/id stamps, tabular stats, directive/details, ordered
// activity, optional segmented progress, sticky Transcript/Open Session
// actions. The MUI Drawer host (focus trap, scrim, Escape, slots) is shared
// with the ZAPAC branch so all e2e-locked behaviour — role/name, close,
// view-transcript handoff, escape — stays identical; only the paper + body
// presentation branches on `skinId`. Every ZAPAC code path below keeps its
// exact original output (helpers, paper sx, body markup), so the ZAPAC skin
// renders byte-for-byte unchanged.
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import Chip from '@mui/material/Chip';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import Drawer from '@mui/material/Drawer';
import CloseIcon from '@mui/icons-material/Close';
import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined';
import TerminalOutlinedIcon from '@mui/icons-material/TerminalOutlined';
import { StatusPill } from '@/components/StatusPill.jsx';
import { getTokens } from '@/theme/contract.js';
import { stroke2, surface2, chipBg, brandGrad, brandGlow, focusRing, statePill, cardTag, sectionLabel, statusColor, trackColor } from '@/shell/shellStyles.js';
import { repoName } from '@/lib/paths.js';
import { fmtUsd, fmtTokens } from '@/lib/format.js';
import { KIND } from '@/lib/agentStatus.js';
import { useThemeSkin } from '@/theme/index.js';
import { Stamp, toneHue } from 'phosphor-console-theme/components';
import { getDomainState } from '@/lib/domainState.js';
import { COLUMNS as STAGES, COLUMN_DOMAIN as STAGE_DOMAIN, cardDomainId } from '@/features/tasks/taskDomain.js';

// Live agent states — an "Open session" action only makes sense while a real
// claude process is attached (mirrors TasksBoard's LIVE_STATUS).
const LIVE_STATUS = new Set(['starting', 'running', 'idle']);

// STAGES/STAGE_DOMAIN are TasksBoard's COLUMNS/COLUMN_DOMAIN, aliased for this
// file's Activity-list vocabulary — imported from the shared
// `taskDomain.js` (not re-derived here) so a task's stage/tone reads
// identically on the board and in its dossier by construction, not by two
// files staying manually in sync.

// Read the reduced-motion preference once at mount; the panel is short-lived so
// a stale read across a session is fine and avoids a listener + re-render.
const prefersReducedMotion = () =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false;

// ── ZAPAC helpers (unchanged) ──────────────────────────────────────────────────
// Ghost secondary action (.btn-ghost) — surface2 fill, hairline border, hover
// tint + brand border. Matches layout-05's secondary foot button.
const ghostBtn = (t) => ({
  borderRadius: 999, px: '16px', py: '7px',
  background: surface2(t), color: 'text.primary',
  border: `1px solid ${stroke2(t)}`,
  fontWeight: 700, fontSize: 13, textTransform: 'none', lineHeight: 1.2,
  boxShadow: 'none',
  '&:hover': { background: chipBg(t), borderColor: t.vars.palette.primary.main, boxShadow: 'none' },
  '&.Mui-focusVisible': focusRing(t),
});

// Gradient primary action (.btn-primary) — brand-grad fill, white ink, brand
// glow; disabled flattens to surface2 + muted ink so the affordance stays
// visible but reads as unavailable.
const primaryBtn = (t) => {
  const glow = brandGlow(t);
  return {
    borderRadius: 999, px: '18px', py: '7px',
    background: brandGrad(t), color: '#fff',
    fontWeight: 700, fontSize: 13, textTransform: 'none', lineHeight: 1.2,
    border: 'none',
    boxShadow: `0 14px 34px -12px ${glow}`,
    transition: 'transform .18s ease, box-shadow .18s ease',
    '&:hover': { transform: 'translateY(-2px)', boxShadow: `0 20px 44px -14px ${glow}`, background: brandGrad(t) },
    '&.Mui-focusVisible': focusRing(t),
    '&:active': { transform: 'translateY(0)' },
    '&.Mui-disabled': { background: surface2(t), color: 'text.disabled', boxShadow: 'none', transform: 'none' },
    '@media (prefers-reduced-motion: reduce)': { transition: 'none', '&:hover': { transform: 'none' }, '&:active': { transform: 'none' } },
  };
};

// Stat tile (.ds) — recessed surface2 cell, mono uppercase label + display
// value, tabular numerals so live updates don't shift the layout.
const statTile = (t) => ({
  background: surface2(t),
  border: `1px solid ${stroke2(t)}`,
  borderRadius: `${getTokens(t).radius.sm}px`,
  px: '12px', py: '10px',
});

// `.ds-k` — the stat tile's key.
const statKey = {
  fontSize: 10, fontWeight: 700, letterSpacing: '.11em',
  textTransform: 'uppercase', color: 'text.disabled',
};

// `.ds-v` — the stat tile's value: display weight, tabular so live updates
// don't shift the grid.
const statVal = { mt: '5px', fontWeight: 700, fontSize: 18, fontVariantNumeric: 'tabular-nums' };

// Meta dl row — label / value on a hairline divider (layout-05 .detail-meta).
const metaRow = (t) => ({
  display: 'flex', justifyContent: 'space-between', gap: 1.5, alignItems: 'baseline',
  py: 1.125,
  borderBottom: `1px solid ${stroke2(t)}`,
  '&:last-child': { borderBottom: 'none' },
});

/**
 * TaskDetailPanel — a right-sliding glass sheet over a scrim showing one task.
 *
 * @param {object} props
 * @param {object} props.task The LIVE task object (derive it by id in the
 *   parent so the panel reflects live stat/status updates).
 * @param {object|undefined} props.agent The agent bound to `task.sessionId`, if
 *   any — drives the status pill + "Open session" availability.
 * @param {object} [props.stats] The AppShell stats map (id -> session stats).
 * @param {(sessionId:string)=>void} props.onSelect "Open session" handler.
 * @param {(item:object)=>void} props.onViewTranscript "View transcript" handler
 *   — the shared openTranscript path (opens TasksBoard's right-sliding
 *   TranscriptSheet, the second sheet in this feature's right-hand system).
 * @param {()=>void} props.onClose Close the panel (close button / scrim / Esc).
 */
// ── Phosphor-only helpers (task 5.4) ────────────────────────────────────────────
// Hard-edged console equivalents of the ZAPAC helpers above, applied only when
// `phosphor` is true at each call site below — every ZAPAC branch keeps calling
// the original helper unchanged, so its rendered output stays byte-for-byte
// identical. These read `t.nerv.*` directly, which is only safe inside a
// phosphor-gated branch (ZAPAC's theme has no `nerv`).
const statTilePhosphor = (t) => ({
  background: t.nerv.hue.void,
  border: `1px solid ${t.nerv.hue.greenDim}`,
  borderRadius: 0,
  px: '10px', py: '8px',
});

const statKeyPhosphor = (t) => ({
  fontSize: 9, fontWeight: 700, letterSpacing: '.12em',
  textTransform: 'uppercase', color: t.nerv.hue.orange,
  fontFamily: t.nerv.fonts.mono,
});

const statValPhosphor = (t) => ({
  mt: '4px', fontWeight: 700, fontSize: 16, fontVariantNumeric: 'tabular-nums',
  color: t.nerv.hue.mint, fontFamily: t.nerv.fonts.mono,
});

// Phosphor meta row — KEY:VALUE spec row (orange key on dashed green-rule,
// mint value), mirroring the vendored DossierSheet's row grammar without
// importing the full sheet (which assumes a static spec, not a live dossier).
const metaRowPhosphor = (t) => ({
  display: 'grid', gridTemplateColumns: '110px 1fr', gap: 1.25, py: '7px',
  borderBottom: `1px dashed ${t.nerv.hue.greenDim}`,
  '&:last-child': { borderBottom: 'none' },
});

const metaKeyPhosphor = (t) => ({
  color: t.nerv.hue.orange, letterSpacing: '.06em', textTransform: 'uppercase',
  fontSize: 10, fontFamily: t.nerv.fonts.mono,
});

const metaValPhosphor = (t) => ({
  color: t.nerv.hue.mint, opacity: 0.85, fontSize: 11,
  fontFamily: t.nerv.fonts.mono, textAlign: 'right', wordBreak: 'break-word',
});

// Phosphor ghost/primary foot buttons — hard-edged console equivalents of the
// ZAPAC ghost/primary actions. The "Open session" primary uses mint inversion
// (design.md D4 active state) when enabled; disabled falls back to outline +
// dim ink so the affordance stays visible but reads unavailable.
const ghostBtnPhosphor = (t) => ({
  borderRadius: 0, px: '14px', py: '6px',
  background: 'transparent', color: t.nerv.hue.orange,
  border: `1px solid ${t.nerv.hue.orange}`,
  fontWeight: 700, fontSize: 11, letterSpacing: '.06em', textTransform: 'none',
  fontFamily: t.nerv.fonts.mono, lineHeight: 1.2, boxShadow: 'none',
  '&:hover': { background: 'rgba(242,100,0,.12)', boxShadow: 'none' },
  '&.Mui-focusVisible': { outline: `2px dashed ${t.nerv.hue.amber}`, outlineOffset: 2 },
});

const primaryBtnPhosphor = (t) => ({
  borderRadius: 0, px: '16px', py: '6px',
  background: t.nerv.hue.mint, color: t.nerv.hue.void,
  border: `1px solid ${t.nerv.hue.mint}`,
  fontWeight: 700, fontSize: 11, letterSpacing: '.06em', textTransform: 'none',
  fontFamily: t.nerv.fonts.mono, lineHeight: 1.2, boxShadow: 'none',
  transition: 'none',
  '&:hover': { background: t.nerv.hue.mintHi, boxShadow: 'none' },
  '&.Mui-focusVisible': { outline: `2px dashed ${t.nerv.hue.amber}`, outlineOffset: 2 },
  '&.Mui-disabled': {
    background: 'transparent', color: t.nerv.hue.greenDim,
    borderColor: t.nerv.hue.greenDim, boxShadow: 'none',
  },
  '@media (prefers-reduced-motion: reduce)': { transition: 'none' },
});

// Card/detail tag chip under Phosphor — dim green outline (a category label is
// not chrome-level scope), matching TasksBoard's `cardTagPhosphor`.
//
// `.MuiChip-colorSuccess` override (see TasksBoard.jsx's `tagChipPhosphor` for
// the full explanation): no `color` prop is passed, so the vendored theme's
// `MuiChip.defaultProps.color = 'success'` stamps a `.MuiChip-colorSuccess`
// class that outranks this single-class `sx` on specificity — without
// re-declaring it here (with `!important`), the chip renders mint instead of
// dim green.
const cardTagPhosphor = (t) => ({
  height: 18, fontSize: 9, borderRadius: 0, letterSpacing: '.04em',
  fontFamily: t.nerv.fonts.mono,
  border: `1px solid ${t.nerv.hue.greenDim}`, color: t.nerv.hue.greenMap, background: 'transparent',
  '&.MuiChip-colorSuccess': { color: `${t.nerv.hue.greenMap} !important` },
});

export default function TaskDetailPanel({ task, agent, stats, onSelect, onViewTranscript, onClose }) {
  const { skinId } = useThemeSkin();
  const phosphor = skinId === 'phosphor';
  const s = stats?.[task.sessionId];
  // Graceful placeholders: a card with no session yet has no stats entry at all
  // (stats?.[undefined] === undefined), so every field degrades to "—".
  const cost = fmtUsd(s?.costUsd) || '—';
  const tokens = s?.tokens > 0 ? fmtTokens(s.tokens) : '—';
  const turns = s?.turns != null ? String(s.turns) : '—';
  const canOpenSession = !!(agent && LIVE_STATUS.has(agent.status) && task.sessionId);
  const reduced = prefersReducedMotion();

  // The task's resting domain-state — same precedence as the board's own
  // card edge (a live agent's own state takes priority over the column's
  // resting tone), via the shared `cardDomainId` so a task reads the same
  // tone on the board and in its dossier by construction (design.md D4 "one
  // stable hue"), not by two independently-written mappings staying in sync.
  const dom = getDomainState(cardDomainId(task, agent));

  // "View transcript" hands off to TasksBoard's TranscriptSheet, then closes
  // this detail panel so the transcript sheet becomes the focus — cleaner than
  // stacking two right-hand overlays at once.
  const handleViewTranscript = () => {
    onViewTranscript({ id: task.id, title: task.title, sessionId: task.sessionId, worktree: task.worktree, repo: task.repo });
    onClose();
  };

  return (
    <Drawer
      open
      anchor="right"
      onClose={onClose}
      disablePortal={false}
      // Collapsing the slide transition to 0 lets the open/close state change
      // still occur under reduced motion without animating the sheet.
      transitionDuration={reduced ? 0 : undefined}
      slotProps={{
        paper: {
          role: 'dialog',
          'aria-label': 'Task detail',
          sx: (t) => (phosphor
            ? {
              // Phosphor dossier — chamfered fixed sheet: void surface, the
              // inner (left) edge is a safety-orange rule (chrome only), no
              // elevation shadow. Width matches the ZAPAC sheet so the e2e's
              // dialog geometry stays stable across skins.
              width: { xs: '88vw', sm: 400 },
              background: t.nerv.hue.void,
              backgroundImage: 'none',
              display: 'flex', flexDirection: 'column', overflow: 'hidden',
              border: 'none',
              borderLeft: `1px solid ${t.nerv.hue.orange}`,
              borderRadius: 0,
              // The chamfer this sheet is named for. `nerv.chamfer()` cuts the
              // top-right and bottom-left corners — for a right-anchored sheet
              // that puts one cut on the outer top edge and one on the inner
              // bottom edge, the hero-panel signature from the one-shot. Only a
              // 16px corner triangle is removed and all content is inset well
              // past it, so the sticky footer actions and their focus rings are
              // untouched.
              clipPath: t.nerv.chamfer(),
              boxShadow: 'none',
            }
            : {
              // `.detail`: opaque surface-solid, only the inner (left) edge drawn,
              // and a long soft shadow cast leftward over the board.
              width: { xs: '88vw', sm: 400 },
              background: t.vars.palette.background.paper,
              backgroundImage: 'none', // MUI Paper's default elevation overlay
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
          {/* Phosphor dossier head — semantic status Stamp + amber mono id + the
              close affordance. The Stamp carries the task's resting domain tone
              (the same tone its board card's edge reads), so the state is
              conveyed by text + tone, never color alone. */}
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center', px: '16px', pt: '14px', flexShrink: 0 }}>
            {agent
              ? <StatusPill status={KIND[agent.status] ?? 'review'}>{agent.status}</StatusPill>
              : (task.state && <Stamp tone={dom.tone} filled={dom.filled} size="sm">{task.state}</Stamp>)}
            <Typography sx={(t) => ({ fontSize: 10, color: t.nerv.hue.amber, fontFamily: t.nerv.fonts.mono, letterSpacing: '.06em' })}>
              #{task.id.slice(-4)}
            </Typography>
            <Box sx={{ ml: 'auto' }}>
              <IconButton size="small" aria-label="Close" onClick={onClose} sx={(t) => ({ color: t.nerv.hue.orange, '&:hover': { color: t.nerv.hue.mint }, '&.Mui-focusVisible': { outline: `2px dashed ${t.nerv.hue.amber}`, outlineOffset: 2 } })}>
                <CloseIcon fontSize="small" />
              </IconButton>
            </Box>
          </Stack>

          {/* Bilingual title — Mincho task title (the content, not chrome, so
              it keeps its original case) with an orange 指令 caption per
              design.md's bimodal type rule. */}
          <Typography
            component="h2"
            sx={(t) => ({
              px: '16px', pt: '10px', flexShrink: 0,
              fontFamily: t.nerv.fonts.display, fontWeight: 700, fontSize: 18,
              color: t.nerv.hue.mintHi, letterSpacing: '.01em', lineHeight: 1.2,
              textWrap: 'balance',
            })}
          >
            {task.title}
          </Typography>
          <Typography sx={(t) => ({ px: '16px', pt: '4px', flexShrink: 0, fontSize: 10, color: t.nerv.hue.orange, fontFamily: t.nerv.fonts.mono, letterSpacing: '.1em' })} component="div">
            指令 · DIRECTIVE
          </Typography>
          <Typography sx={(t) => ({ px: '16px', pt: '8px', flexShrink: 0, color: t.nerv.hue.greenMap, fontSize: 10, fontFamily: t.nerv.fonts.mono, letterSpacing: '.04em' })} noWrap>
            {repoName(task.repo)}{task.branch ? ` · ${task.branch}` : ''}
          </Typography>

          {/* Body — tabular stats · directive/description · KEY:VALUE details ·
              ordered activity. Scrolls when it outgrows the sheet. */}
          <Box sx={{ flex: 1, minHeight: 0, overflowY: 'auto', px: '16px', pt: '14px', pb: '16px', display: 'flex', flexDirection: 'column', gap: '18px' }}>
            <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '8px' }}>
              <Box sx={(t) => statTilePhosphor(t)}>
                <Typography sx={(t) => statKeyPhosphor(t)}>Cost</Typography>
                <Typography sx={(t) => statValPhosphor(t)} noWrap>{cost}</Typography>
              </Box>
              <Box sx={(t) => statTilePhosphor(t)}>
                <Typography sx={(t) => statKeyPhosphor(t)}>Tokens</Typography>
                <Typography sx={(t) => statValPhosphor(t)} noWrap>{tokens}</Typography>
              </Box>
              <Box sx={(t) => statTilePhosphor(t)}>
                <Typography sx={(t) => statKeyPhosphor(t)}>Turns</Typography>
                <Typography sx={(t) => statValPhosphor(t)} noWrap>{turns}</Typography>
              </Box>
            </Box>

            {task.description && (
              <Box>
                <Typography sx={(t) => ({ fontSize: 10, fontWeight: 700, letterSpacing: '.12em', textTransform: 'uppercase', color: t.nerv.hue.orange, fontFamily: t.nerv.fonts.mono, mb: '8px' })}>Task</Typography>
                <Typography
                  sx={(t) => ({
                    fontSize: 12, lineHeight: 1.6, color: t.nerv.hue.mint, whiteSpace: 'pre-wrap',
                    maxHeight: 220, overflowY: 'auto', pr: 0.5,
                    '&::-webkit-scrollbar': { width: 6 },
                    '&::-webkit-scrollbar-thumb': { background: t.nerv.hue.greenDim, borderRadius: 0 },
                  })}
                >
                  {task.description}
                </Typography>
              </Box>
            )}

            <Box>
              <Typography sx={(t) => ({ fontSize: 10, fontWeight: 700, letterSpacing: '.12em', textTransform: 'uppercase', color: t.nerv.hue.orange, fontFamily: t.nerv.fonts.mono, mb: '8px' })}>Details</Typography>
              <Box>
                <Box sx={(t) => metaRowPhosphor(t)}>
                  <Typography sx={(t) => metaKeyPhosphor(t)}>Model</Typography>
                  <Typography sx={(t) => metaValPhosphor(t)}>{task.model || '—'}</Typography>
                </Box>
                <Box sx={(t) => metaRowPhosphor(t)}>
                  <Typography sx={(t) => metaKeyPhosphor(t)}>Branch</Typography>
                  <Typography sx={(t) => metaValPhosphor(t)}>{task.branch || '—'}</Typography>
                </Box>
                <Box sx={(t) => metaRowPhosphor(t)}>
                  <Typography sx={(t) => metaKeyPhosphor(t)}>Created</Typography>
                  <Typography sx={(t) => metaValPhosphor(t)}>
                    {task.createdAt ? new Date(task.createdAt).toLocaleString() : '—'}
                  </Typography>
                </Box>
                <Box sx={(t) => metaRowPhosphor(t)}>
                  <Typography sx={(t) => metaKeyPhosphor(t)}>Tags</Typography>
                  <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap', rowGap: 0.5, justifyContent: 'flex-end' }}>
                    {(task.tags || []).length > 0
                      ? task.tags.map((tag) => <Chip key={tag} size="small" label={tag} sx={(t) => cardTagPhosphor(t)} />)
                      : <Typography sx={(t) => ({ fontSize: 11, fontFamily: t.nerv.fonts.mono, color: t.nerv.hue.greenMap })}>—</Typography>}
                  </Stack>
                </Box>
              </Box>
            </Box>

            {/* Activity — the board pipeline with the task's current column
                marked. Hard-edged console equivalent of the ZAPAC timeline:
                a filled tone-hue stamp for the current stage, a dim outline
                stamp for completed stages, and a bare dim label for future
                ones. Stage membership is all the board models, so there are no
                per-stage timestamps to show. */}
            <Box>
              <Typography sx={(t) => ({ fontSize: 10, fontWeight: 700, letterSpacing: '.12em', textTransform: 'uppercase', color: t.nerv.hue.orange, fontFamily: t.nerv.fonts.mono, mb: '8px' })}>Activity</Typography>
              <Box component="ol" sx={{ listStyle: 'none', m: 0, p: 0 }}>
                {STAGES.map(([id, label], i) => {
                  const at = STAGES.findIndex(([c]) => c === task.column);
                  const state = i < at ? 'done' : i === at ? 'cur' : 'future';
                  const stageDom = getDomainState(STAGE_DOMAIN[id]);
                  return (
                    <Box
                      component="li"
                      key={id}
                      sx={{
                        display: 'flex', gap: '8px', alignItems: 'center',
                        pb: '8px',
                      }}
                    >
                      <Box
                        aria-hidden
                        sx={(t) => ({
                          width: 10, height: 10, flexShrink: 0,
                          border: `1px solid ${state === 'future' ? t.nerv.hue.greenDim : toneHue(t, stageDom.tone)}`,
                          background: state === 'cur' ? toneHue(t, stageDom.tone)
                            : state === 'done' ? toneHue(t, stageDom.tone)
                            : 'transparent',
                          opacity: state === 'done' ? 0.5 : 1,
                        })}
                      />
                      <Typography sx={(t) => ({
                        fontSize: 11, fontFamily: t.nerv.fonts.mono, letterSpacing: '.04em',
                        color: state === 'future' ? t.nerv.hue.greenDim
                          : state === 'cur' ? toneHue(t, stageDom.tone)
                          : t.nerv.hue.greenMap,
                      })}>
                        {label}
                      </Typography>
                    </Box>
                  );
                })}
              </Box>
            </Box>
          </Box>

          {/* Sticky foot — View transcript (ghost) + Open session (primary).
              The accessible names are exactly the button text — the e2e locks
              onto them. Hard-edged console chrome: orange rule above, void
              surface, no elevation. */}
          <Stack direction="row" spacing={1.25} sx={(t) => ({ flexShrink: 0, justifyContent: 'flex-end', px: 2.5, py: 1.75, borderTop: `1px solid ${t.nerv.hue.orange}`, background: t.nerv.hue.void })}>
            <Button
              size="small"
              variant="text"
              startIcon={<DescriptionOutlinedIcon />}
              onClick={handleViewTranscript}
              sx={(t) => ghostBtnPhosphor(t)}
            >
              View transcript
            </Button>
            <Button
              size="small"
              variant="contained"
              startIcon={<TerminalOutlinedIcon />}
              disabled={!canOpenSession}
              onClick={() => onSelect(task.sessionId)}
              sx={(t) => primaryBtnPhosphor(t)}
            >
              Open session
            </Button>
          </Stack>
        </>
      ) : (
        <>
          {/* Head: status pill + short id + close (.detail-head). */}
          <Stack direction="row" spacing={1.25} sx={{ alignItems: 'center', px: '18px', pt: '16px', flexShrink: 0 }}>
            {agent
              ? <StatusPill status={KIND[agent.status] ?? 'review'}>{agent.status}</StatusPill>
              : (task.state && <Chip size="small" label={task.state} sx={(t) => statePill(t)} />)}
            <Typography variant="code" sx={{ fontSize: 12, color: 'text.disabled' }}>#{task.id.slice(-4)}</Typography>
            <Box sx={{ ml: 'auto' }}>
              <IconButton size="small" aria-label="Close" onClick={onClose}>
                <CloseIcon fontSize="small" />
              </IconButton>
            </Box>
          </Stack>

          {/* `.detail-title` wraps — a truncated task title defeats the panel's point. */}
          <Typography
            component="h2"
            variant="h3"
            sx={{ px: '18px', pt: '12px', flexShrink: 0, letterSpacing: '-0.02em', lineHeight: 1.15, textWrap: 'balance' }}
          >
            {task.title}
          </Typography>

          <Typography variant="code" sx={{ px: '18px', pt: '9px', flexShrink: 0, color: 'text.secondary', fontSize: 12 }} noWrap>
            {repoName(task.repo)}{task.branch ? ` · ${task.branch}` : ''}
          </Typography>

          {/* Body: stats grid · description · meta dl · activity. Scrolls when it
              outgrows the sheet. */}
          <Box sx={{ flex: 1, minHeight: 0, overflowY: 'auto', px: '18px', pt: '16px', pb: '18px', display: 'flex', flexDirection: 'column', gap: '20px' }}>
            <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '10px' }}>
              <Box sx={(t) => statTile(t)}>
                <Typography sx={statKey}>Cost</Typography>
                <Typography sx={statVal} noWrap>{cost}</Typography>
              </Box>
              <Box sx={(t) => statTile(t)}>
                <Typography sx={statKey}>Tokens</Typography>
                <Typography sx={statVal} noWrap>{tokens}</Typography>
              </Box>
              <Box sx={(t) => statTile(t)}>
                <Typography sx={statKey}>Turns</Typography>
                <Typography sx={statVal} noWrap>{turns}</Typography>
              </Box>
            </Box>

            {/* `.detail-sec` "Task" — the brief the agent was given. Only rendered when
                the task carries one (tasks created outside the dialog may not). The
                mockup assumes a short paragraph; a real brief can run to dozens of
                lines, so it scrolls within a capped block rather than pushing Details
                and Activity off the sheet. */}
            {task.description && (
              <Box>
                <Typography sx={{ ...sectionLabel(), mb: '11px' }}>Task</Typography>
                <Typography
                  sx={(t) => ({
                    fontSize: 13, lineHeight: 1.6, color: 'text.secondary', whiteSpace: 'pre-wrap',
                    maxHeight: 220, overflowY: 'auto', pr: 0.5,
                    '&::-webkit-scrollbar': { width: 6 },
                    '&::-webkit-scrollbar-thumb': { background: trackColor(t), borderRadius: 6 },
                  })}
                >
                  {task.description}
                </Typography>
              </Box>
            )}

            <Box>
              <Typography sx={{ ...sectionLabel(), mb: '11px' }}>Details</Typography>
              <Box>
                <Box sx={(t) => metaRow(t)}>
                  <Typography sx={{ fontSize: 12, color: 'text.disabled' }}>Model</Typography>
                  <Typography variant="code" sx={{ fontSize: 12, textAlign: 'right', minWidth: 0, wordBreak: 'break-word' }}>{task.model || '—'}</Typography>
                </Box>
                <Box sx={(t) => metaRow(t)}>
                  <Typography sx={{ fontSize: 12, color: 'text.disabled' }}>Branch</Typography>
                  <Typography variant="code" sx={{ fontSize: 12, textAlign: 'right', minWidth: 0, wordBreak: 'break-word' }}>{task.branch || '—'}</Typography>
                </Box>
                <Box sx={(t) => metaRow(t)}>
                  <Typography sx={{ fontSize: 12, color: 'text.disabled' }}>Created</Typography>
                  <Typography variant="code" sx={{ fontSize: 12, textAlign: 'right', minWidth: 0 }}>
                    {task.createdAt ? new Date(task.createdAt).toLocaleString() : '—'}
                  </Typography>
                </Box>
                <Box sx={(t) => metaRow(t)}>
                  <Typography sx={{ fontSize: 12, color: 'text.disabled', flexShrink: 0 }}>Tags</Typography>
                  <Stack direction="row" spacing={0.75} sx={{ flexWrap: 'wrap', rowGap: 0.75, justifyContent: 'flex-end' }}>
                    {(task.tags || []).length > 0
                      ? task.tags.map((tag) => <Chip key={tag} size="small" label={tag} sx={(t) => cardTag(t)} />)
                      : <Typography variant="code" sx={{ fontSize: 12 }}>—</Typography>}
                  </Stack>
                </Box>
              </Box>
            </Box>

            {/* `.detail-sec` "Activity" / `.timeline` — the board pipeline with the
                task's current column marked. Stage membership is all the board
                models, so there are no per-stage timestamps to show. */}
            <Box>
              <Typography sx={{ ...sectionLabel(), mb: '11px' }}>Activity</Typography>
              <Box component="ol" sx={{ listStyle: 'none', m: 0, p: 0 }}>
                {STAGES.map(([id, label], i) => {
                  const at = STAGES.findIndex(([c]) => c === task.column);
                  const state = i < at ? 'done' : i === at ? 'cur' : 'future';
                  const last = i === STAGES.length - 1;
                  return (
                    <Box
                      component="li"
                      key={id}
                      sx={(t) => ({
                        display: 'flex', gap: '11px', alignItems: 'flex-start',
                        position: 'relative', pb: last ? 0 : '15px',
                        // Connector between dots, tinted for the stages already passed.
                        ...(last ? null : {
                          '&::before': {
                            content: '""', position: 'absolute', left: '6px', top: '15px', bottom: '-1px',
                            width: '2px', background: state === 'done' ? statusColor(t, 'ok') : getTokens(t).glass.stroke,
                          },
                        }),
                      })}
                    >
                      <Box
                        aria-hidden
                        sx={(t) => {
                          const ok = statusColor(t, 'ok');
                          const info = statusColor(t, 'info');
                          return {
                            width: 14, height: 14, flexShrink: 0, mt: '1px', borderRadius: '50%',
                            position: 'relative', zIndex: 1,
                            border: `2px solid ${state === 'done' ? ok : state === 'cur' ? info : getTokens(t).glass.stroke}`,
                            background: state === 'done' ? ok : state === 'cur' ? info : t.vars.palette.background.paper,
                            ...(state === 'cur' ? { boxShadow: `0 0 0 4px color-mix(in srgb, ${info} 22%, transparent)` } : null),
                          };
                        }}
                      />
                      <Typography sx={{ fontSize: 13, color: state === 'future' ? 'text.disabled' : 'text.primary' }}>
                        {label}
                      </Typography>
                    </Box>
                  );
                })}
              </Box>
            </Box>
          </Box>

          {/* Foot: View transcript (ghost) + Open session (primary). The accessible
              names are exactly the button text — Group 6's e2e locks onto them. */}
          <Stack direction="row" spacing={1.25} sx={(t) => ({ flexShrink: 0, justifyContent: 'flex-end', px: 3, py: 2, borderTop: `1px solid ${stroke2(t)}`, background: surface2(t) })}>
            <Button
              size="small"
              variant="text"
              startIcon={<DescriptionOutlinedIcon />}
              onClick={handleViewTranscript}
              sx={(t) => ghostBtn(t)}
            >
              View transcript
            </Button>
            <Button
              size="small"
              variant="contained"
              startIcon={<TerminalOutlinedIcon />}
              disabled={!canOpenSession}
              onClick={() => onSelect(task.sessionId)}
              sx={(t) => primaryBtn(t)}
            >
              Open session
            </Button>
          </Stack>
        </>
      )}
    </Drawer>
  );
}