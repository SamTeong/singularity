// Task detail panel — right-anchored glass sheet opened by a Board card click
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
import { StatusPill } from '@zapac/mui-theme';
import { getTokens } from '@/theme/contract.js';
import { stroke2, surface2, chipBg, brandGrad, brandGlow, focusRing, statePill, cardTag, sectionLabel, statusColor, trackColor } from '@/shell/shellStyles.js';
import { repoName } from '@/lib/paths.js';
import { fmtUsd, fmtTokens } from '@/lib/format.js';
import { KIND } from '@/lib/agentStatus.js';

// Live agent states — an "Open session" action only makes sense while a real
// claude process is attached (mirrors TasksBoard's LIVE_STATUS).
const LIVE_STATUS = new Set(['starting', 'running', 'idle']);

// Read the reduced-motion preference once at mount; the panel is short-lived so
// a stale read across a session is fine and avoids a listener + re-render.
const prefersReducedMotion = () =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false;

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

// The board's four columns as an ordered pipeline, for the Activity list.
const STAGES = [['todo', 'To-Do'], ['inprogress', 'In Progress'], ['inreview', 'In Review'], ['done', 'Done']];

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
 *   — the shared openTranscript path (renders the dockable transcript panel).
 * @param {()=>void} props.onClose Close the panel (close button / scrim / Esc).
 */
export default function TaskDetailPanel({ task, agent, stats, onSelect, onViewTranscript, onClose }) {
  const s = stats?.[task.sessionId];
  // Graceful placeholders: a card with no session yet has no stats entry at all
  // (stats?.[undefined] === undefined), so every field degrades to "—".
  const cost = fmtUsd(s?.costUsd) || '—';
  const tokens = s?.tokens > 0 ? fmtTokens(s.tokens) : '—';
  const turns = s?.turns != null ? String(s.turns) : '—';
  const canOpenSession = !!(agent && LIVE_STATUS.has(agent.status) && task.sessionId);
  const reduced = prefersReducedMotion();

  // "View transcript" hands off to the existing dockable transcript panel, then
  // closes this detail panel so the transcript dock becomes the focus — cleaner
  // than stacking two overlays (the panel would otherwise sit over the dock).
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
          sx: (t) => ({
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
        sx={{ px: '18px', pt: '12px', flexShrink: 0, fontWeight: 700, fontSize: 20, letterSpacing: '-0.02em', lineHeight: 1.15, textWrap: 'balance' }}
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
    </Drawer>
  );
}