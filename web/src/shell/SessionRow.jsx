import { getTokens } from '@/theme/contract.js';
import { surface2, navActiveBg, brandGrad } from '@/shell/shellStyles.js';
import { toneHue } from 'phosphor-console-theme/components';
import { useThemeSkin } from '@/theme/index.js';
import { getDomainState } from '@/lib/domainState.js';
import React from 'react';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import ListItemButton from '@mui/material/ListItemButton';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import CallSplitIcon from '@mui/icons-material/CallSplit';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import LinkIcon from '@mui/icons-material/Link';
import HistoryIcon from '@mui/icons-material/History';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import CloseIcon from '@mui/icons-material/Close';
import { StatusPill } from '@/components/StatusPill.jsx';
import { KIND } from '@/lib/agentStatus.js';
import { isCodexModel } from '@/lib/models.js';
import { tildify } from '@/lib/paths.js';
import { fmtTokens } from '@/lib/format.js';

const isLive = (s) => s === 'running' || s === 'idle' || s === 'starting';
// Actively mid-turn (would interrupt work to resume elsewhere). Idle is at the
// prompt — safe to hand off, though the in-app pty still holds the session id.
const isWorking = (s) => s === 'running' || s === 'starting';
// Daemon is loopback on this same machine, so the browser's platform reflects
// the OS the external terminal will open on (wt.exe vs Terminal.app). Unknown
// platform → generic label (no assumption).
const PLATFORM = (typeof navigator !== 'undefined'
  && (navigator.userAgentData?.platform || navigator.platform) || '').toLowerCase();
const TERMINAL_NAME = PLATFORM.includes('mac') ? 'Terminal'
  : PLATFORM.includes('win') ? 'Windows Terminal' : null;

/**
 * One session row in the dock list: name + row actions (transcript/duplicate/
 * fork/restart/reattach/kill), cwd, status pill + turn/token counts, and any live
 * subagent indicator rows nested beneath. Purely presentational — all behaviour
 * arrives as callbacks.
 */
export default function SessionRow({
  agent, selected, onSelect, stats, subagents = [], dragging, dragHandlers,
  onViewTranscript, onDuplicate, onFork, onRespawn, onReattach, onOpenExternal, onKill,
}) {
  const a = agent;
  const { skinId } = useThemeSkin();
  // Composition-owner branch (design.md D1/D4): ZAPAC's selected row is a
  // brand-gradient accent stripe; Phosphor's is the vendored roster grammar's
  // figure/ground inversion — a thicker semantic-hue border + inset glow (the
  // same "current console" recipe as the house `AgentCard`/`ModuleCard`
  // `selected` prop), never the ZAPAC gradient. ZAPAC's own branch is
  // untouched byte-for-byte.
  const phosphor = skinId === 'phosphor';
  // Fork clones the source's claude transcript into a new session log (see
  // reg.fork). Codex writes its own rollout and mints its own thread uuid — no
  // log to clone, no id to pin — so forking one silently degrades to Duplicate.
  // Hide the action rather than offer one that doesn't fork.
  const codex = a.tool === 'codex' || isCodexModel(a.model);
  return (
    <React.Fragment>
      <ListItemButton
        selected={selected}
        onClick={onSelect}
        draggable
        onDragStart={dragHandlers.onDragStart}
        onDragOver={dragHandlers.onDragOver}
        onDrop={dragHandlers.onDrop}
        onDragEnd={dragHandlers.onDragEnd}
        sx={(t) => ({
          borderRadius: `${getTokens(t).radius.sm}px`, mb: 0.5, flexDirection: 'column', alignItems: 'stretch', gap: 0.5,
          opacity: dragging ? 0.4 : 1, position: 'relative',
          ...(phosphor
            ? {
                border: `1px solid ${t.nerv.hue.greenDim}`,
                '&:hover': { borderColor: t.nerv.hue.mint },
                '&.Mui-selected': {
                  background: 'transparent',
                  border: `2px solid ${t.nerv.hue.mint}`,
                  boxShadow: 'inset 0 0 12px rgba(82,242,154,.12)',
                  '&:hover': { background: 'transparent', borderColor: t.nerv.hue.mint },
                },
              }
            : {
                '&:hover': { background: surface2(t) },
                '&.Mui-selected': { background: navActiveBg(t), '&:hover': { background: navActiveBg(t) } },
                '&.Mui-selected::before': { content: '""', position: 'absolute', left: 0, top: 8, bottom: 8, width: 3, borderRadius: '0 3px 3px 0', background: brandGrad(t) },
              }),
          '& .row-act': { opacity: a.status === 'detached' ? 1 : 0 }, '&:hover .row-act': { opacity: 1 },
        })}
      >
        {/* Row 1: name (left) + actions (right). */}
        <Stack direction="row" sx={{ alignItems: 'center', minWidth: 0 }}>
          <Typography variant="subtitle2" noWrap sx={(t) => ({ flex: 1, minWidth: 0, color: phosphor && selected ? t.nerv.hue.mint : undefined })}>{a.title}</Typography>
          <Stack direction="row" className="row-act" sx={{ flexShrink: 0, transition: 'opacity .15s' }}>
            <Tooltip title="View transcript — the full conversation, beyond what the terminal keeps" disableInteractive>
              <IconButton size="small" onClick={(e) => { e.stopPropagation(); onViewTranscript(); }}><HistoryIcon fontSize="small" /></IconButton>
            </Tooltip>
            <Tooltip title="Duplicate — start a new session with the same settings" disableInteractive>
              <IconButton size="small" onClick={(e) => { e.stopPropagation(); onDuplicate(); }}><ContentCopyIcon fontSize="small" /></IconButton>
            </Tooltip>
            {!codex && (
              <Tooltip title="Fork — start a new session that continues this conversation" disableInteractive>
                <IconButton size="small" onClick={(e) => { e.stopPropagation(); onFork(); }}><CallSplitIcon fontSize="small" /></IconButton>
              </Tooltip>
            )}
            {!isWorking(a.status) && (
              <Tooltip title={TERMINAL_NAME ? `Open in ${TERMINAL_NAME} — resume this session in an external terminal` : 'Open in external terminal — resume this session'} disableInteractive>
                <IconButton size="small" onClick={(e) => { e.stopPropagation(); onOpenExternal(); }}><OpenInNewIcon fontSize="small" /></IconButton>
              </Tooltip>
            )}
            {isLive(a.status) && (
              <Tooltip title="Restart — stop and resume this session, keeping the conversation" disableInteractive>
                <IconButton size="small" sx={{ color: 'error.main', '&:hover': { color: 'error.main' } }} onClick={(e) => { e.stopPropagation(); onRespawn(); }}><RestartAltIcon fontSize="small" /></IconButton>
              </Tooltip>
            )}
            {a.status === 'detached' && (
              <Tooltip title="Resume — reconnect to this conversation" disableInteractive>
                <IconButton size="small" onClick={(e) => { e.stopPropagation(); onReattach(); }}><LinkIcon fontSize="small" /></IconButton>
              </Tooltip>
            )}
            <Tooltip title={a.status === 'running' || a.status === 'starting' ? 'Stop' : 'Remove'} disableInteractive>
              <IconButton size="small" sx={{ color: 'error.main', '&:hover': { color: 'error.main' } }} onClick={(e) => { e.stopPropagation(); onKill(); }}><CloseIcon fontSize="small" /></IconButton>
            </Tooltip>
          </Stack>
        </Stack>
        {/* Row 2: cwd + status/tokens, full width. */}
        <Typography variant="code" sx={{ color: 'text.secondary', fontSize: 11 }} noWrap>{tildify(a.cwd)}</Typography>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
          <StatusPill status={KIND[a.status] ?? 'review'}>{a.status}</StatusPill>
          {stats?.turns > 0 && (
            <Typography variant="code" sx={{ color: 'text.secondary', fontSize: 11 }}>
              {stats.turns} turns · {fmtTokens(stats.tokens)} tok
            </Typography>
          )}
        </Stack>
      </ListItemButton>
      {/* Live subagents (Task tool) — indicator only, no PTY to attach. Dot
          color/label come from the centralized domain-state mapping
          (lib/domainState.js) rather than an ad-hoc success/disabled color, so
          a subagent reads the same "running"/"queued" vocabulary as every
          other status surface. `aria-label` conveys the state as text (not
          color/animation alone) without changing either skin's pixels. */}
      {subagents.map((sub) => {
        const domain = getDomainState(sub.running ? 'running' : 'queued');
        return (
          <Stack
            key={sub.id}
            direction="row"
            spacing={0.75}
            role="status"
            aria-label={`${sub.title || sub.agentId} — ${domain.srLabel}`}
            sx={{ alignItems: 'center', pl: 2.5, pr: 1, py: 0.25, minWidth: 0 }}
          >
            <Box
              aria-hidden
              sx={(t) => ({
                width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
                bgcolor: phosphor ? toneHue(t, domain.tone) : (sub.running ? 'success.main' : 'text.disabled'),
                animation: sub.running
                  ? (phosphor ? 'sing-sub-blink 1s steps(1, jump-none) infinite' : 'sing-sub-pulse 1.4s ease-in-out infinite')
                  : 'none',
                '@keyframes sing-sub-pulse': { '0%,100%': { opacity: 1 }, '50%': { opacity: 0.35 } },
                '@keyframes sing-sub-blink': { '0%,49%': { opacity: 1 }, '50%,100%': { opacity: 0 } },
                '@media (prefers-reduced-motion: reduce)': { animation: 'none' },
              })}
            />
            <Typography variant="code" noWrap sx={{ fontSize: 11, color: 'text.secondary', flex: 1, minWidth: 0 }}>{sub.title || sub.agentId}</Typography>
          </Stack>
        );
      })}
    </React.Fragment>
  );
}
