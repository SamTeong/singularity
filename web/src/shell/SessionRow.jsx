import { getTokens } from '@/theme/contract.js';
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
import CloseIcon from '@mui/icons-material/Close';
import { StatusPill } from '@zapac/mui-theme';
import { KIND } from '@/lib/agentStatus.js';
import { tildify } from '@/lib/paths.js';
import { fmtTokens } from '@/lib/format.js';

const isLive = (s) => s === 'running' || s === 'idle' || s === 'starting';

/**
 * One session row in the dock list: name + row actions (duplicate/fork/restart/
 * reattach/kill), cwd, status pill + turn/token counts, and any live subagent
 * indicator rows nested beneath. Purely presentational — all behaviour arrives
 * as callbacks.
 */
export default function SessionRow({
  agent, selected, onSelect, stats, subagents = [], dragging, dragHandlers,
  onDuplicate, onFork, onRespawn, onReattach, onKill,
}) {
  const a = agent;
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
        sx={{ borderRadius: (t) => `${getTokens(t).radius.sm}px`, mb: 0.5, flexDirection: 'column', alignItems: 'stretch', gap: 0.5, opacity: dragging ? 0.4 : 1, '& .row-act': { opacity: a.status === 'detached' ? 1 : 0 }, '&:hover .row-act': { opacity: 1 } }}
      >
        {/* Row 1: name (left) + actions (right). */}
        <Stack direction="row" sx={{ alignItems: 'center', minWidth: 0 }}>
          <Typography variant="subtitle2" noWrap sx={{ flex: 1, minWidth: 0 }}>{a.name}</Typography>
          <Stack direction="row" className="row-act" sx={{ flexShrink: 0, transition: 'opacity .15s' }}>
            <Tooltip title="Duplicate (config only)" disableInteractive>
              <IconButton size="small" onClick={(e) => { e.stopPropagation(); onDuplicate(); }}><ContentCopyIcon fontSize="small" /></IconButton>
            </Tooltip>
            <Tooltip title="Fork (config + conversation)" disableInteractive>
              <IconButton size="small" onClick={(e) => { e.stopPropagation(); onFork(); }}><CallSplitIcon fontSize="small" /></IconButton>
            </Tooltip>
            {isLive(a.status) && (
              <Tooltip title="Restart (kill + resume, keeps conversation)" disableInteractive>
                <IconButton size="small" sx={{ color: 'error.main', '&:hover': { color: 'error.main' } }} onClick={(e) => { e.stopPropagation(); onRespawn(); }}><RestartAltIcon fontSize="small" /></IconButton>
              </Tooltip>
            )}
            {a.status === 'detached' && (
              <Tooltip title="Reattach (claude --resume)" disableInteractive>
                <IconButton size="small" onClick={(e) => { e.stopPropagation(); onReattach(); }}><LinkIcon fontSize="small" /></IconButton>
              </Tooltip>
            )}
            <Tooltip title={a.status === 'running' || a.status === 'starting' ? 'Kill' : 'Remove'} disableInteractive>
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
      {/* Live subagents (Task tool) — indicator only, no PTY to attach. */}
      {subagents.map((sub) => (
        <Stack key={sub.id} direction="row" spacing={0.75} sx={{ alignItems: 'center', pl: 2.5, pr: 1, py: 0.25, minWidth: 0 }}>
          <Box sx={{ width: 6, height: 6, borderRadius: '50%', flexShrink: 0, bgcolor: sub.running ? 'success.main' : 'text.disabled', animation: sub.running ? 'sing-sub-pulse 1.4s ease-in-out infinite' : 'none', '@keyframes sing-sub-pulse': { '0%,100%': { opacity: 1 }, '50%': { opacity: 0.35 } }, '@media (prefers-reduced-motion: reduce)': { animation: 'none' } }} />
          <Typography variant="code" noWrap sx={{ fontSize: 11, color: 'text.secondary', flex: 1, minWidth: 0 }}>{sub.title || sub.agentId}</Typography>
        </Stack>
      ))}
    </React.Fragment>
  );
}
