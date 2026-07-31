// Task detail panel — right-anchored glass sheet opened by a Board card click
// (replaces the card → transcript-dock behaviour). Slides in over a scrim,
// dismissible via close / scrim / Escape, with focus trap + focus restore to the
// originating card (MUI Drawer/Modal gives all three). Honours prefers-reduced-
// motion by collapsing the slide transition to an instant state change.
//
// Anatomy mirrors docs/one-shot/layout-05.html's `.detail`: head (status pill +
// short id + close) → title → repo/branch → body (3-cell stats grid + a meta
// dl) → foot ("View transcript" ghost + "Open session" primary). The look is
// the layout-02 glass recipe (shellStyles) so the panel reads as one system
// with the restyled shell.
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
import { glass, stroke2, surface2, chipBg, brandGrad, focusRing } from '@/shell/shellStyles.js';
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
  const glow = t?.palette?.mode === 'dark' ? 'rgba(170,65,175,.5)' : 'rgba(170,65,175,.3)';
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
  border: `1px solid ${getTokens(t).glass.stroke}`,
  borderRadius: `${getTokens(t).radius.sm}px`,
  px: 1.75, py: 1.5,
});

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
          sx: (t) => {
            const g = getTokens(t);
            // Spread glass() FIRST so its `border` shorthand doesn't clobber the
            // edge overrides below — a right-anchored sheet should read as a
            // floating panel with only the inner (left) edge delineated, not a
            // full-border card. (Object spread order: later keys win.)
            return {
              ...glass(t),
              width: { xs: '92vw', sm: 440 },
              maxWidth: 460,
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
              border: 'none',
              borderLeft: `1px solid ${g.glass.stroke}`,
              borderRadius: 0,
            };
          },
        },
        backdrop: {
          'aria-hidden': true,
          sx: { background: 'rgba(6,5,14,.6)', backdropFilter: 'blur(3px)' },
        },
      }}
    >
      {/* Head: status pill + short id + close (.detail-head). */}
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', px: 3, pt: 2.5 }}>
        {agent
          ? <StatusPill status={KIND[agent.status] ?? 'review'}>{agent.status}</StatusPill>
          : (task.state && <Chip size="small" label={task.state} sx={{ height: 20, fontSize: 11 }} />)}
        <Typography variant="code" sx={{ fontSize: 12, color: 'text.disabled' }}>#{task.id.slice(-4)}</Typography>
        <Box sx={{ ml: 'auto' }}>
          <IconButton size="small" aria-label="Close" onClick={onClose}>
            <CloseIcon fontSize="small" />
          </IconButton>
        </Box>
      </Stack>

      <Typography sx={{ px: 3, pt: 1.5, fontWeight: 700, fontSize: 22, letterSpacing: '-0.02em', lineHeight: 1.2 }} noWrap>
        {task.title}
      </Typography>

      <Typography variant="code" sx={{ px: 3, pt: 1.125, color: 'text.secondary', fontSize: 12 }} noWrap>
        {repoName(task.repo)}{task.branch ? ` · ${task.branch}` : ''}
      </Typography>

      {/* Body: stats grid + meta dl. Scrolls when it outgrows the sheet. */}
      <Box sx={{ flex: 1, minHeight: 0, overflowY: 'auto', px: 3, py: 2.5, display: 'flex', flexDirection: 'column', gap: 2.75 }}>
        <Box sx={(t) => ({ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 1.5 })}>
          <Box sx={(t) => statTile(t)}>
            <Typography variant="code" sx={{ fontSize: 10, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'text.disabled' }}>Cost</Typography>
            <Typography sx={{ mt: 0.5, fontWeight: 700, fontSize: 20, fontVariantNumeric: 'tabular-nums' }} noWrap>{cost}</Typography>
          </Box>
          <Box sx={(t) => statTile(t)}>
            <Typography variant="code" sx={{ fontSize: 10, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'text.disabled' }}>Tokens</Typography>
            <Typography sx={{ mt: 0.5, fontWeight: 700, fontSize: 20, fontVariantNumeric: 'tabular-nums' }} noWrap>{tokens}</Typography>
          </Box>
          <Box sx={(t) => statTile(t)}>
            <Typography variant="code" sx={{ fontSize: 10, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'text.disabled' }}>Turns</Typography>
            <Typography sx={{ mt: 0.5, fontWeight: 700, fontSize: 20, fontVariantNumeric: 'tabular-nums' }} noWrap>{turns}</Typography>
          </Box>
        </Box>

        <Box>
          <Typography variant="code" sx={{ fontSize: 10, fontWeight: 500, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'text.disabled', mb: 1.5 }}>Details</Typography>
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
              <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap', rowGap: 0.5, justifyContent: 'flex-end' }}>
                {(task.tags || []).length > 0
                  ? task.tags.map((tag) => <Chip key={tag} size="small" label={tag} sx={{ height: 20, fontSize: 11 }} />)
                  : <Typography variant="code" sx={{ fontSize: 12 }}>—</Typography>}
              </Stack>
            </Box>
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