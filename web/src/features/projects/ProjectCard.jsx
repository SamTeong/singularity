import { useCallback, useEffect, useState } from 'react';
import { getTokens } from '@/theme/contract.js';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import Chip from '@mui/material/Chip';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlined';
import RefreshIcon from '@mui/icons-material/Refresh';
import { repoName, tildify } from '@/lib/paths.js';

// Tiny relative-time formatter — the codebase has no existing helper for
// this (checked: no `fromNow`/`RelativeTimeFormat` under web/src).
function fmtRelative(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.round(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.round(hr / 24)}d ago`;
}

// A working-tree count chip: dimmed (not hidden) at zero, so the card's chip
// row keeps a stable layout across repos.
function CountChip({ label, n }) {
  return <Chip label={`${label} ${n}`} size="small" sx={{ height: 20, fontSize: 11, opacity: n ? 1 : 0.4 }} />;
}

// A titled compact bullet list — same list styling as History's per-project
// bullets (DayCard.jsx).
function SummarySection({ title, bullets }) {
  return (
    <Box>
      <Typography sx={{ fontSize: 11, fontWeight: 600, color: 'text.secondary' }}>{title}</Typography>
      <Box component="ul" sx={{ m: 0, mt: 0.25, pl: 2, '& li + li': { mt: '0.4em' } }}>
        {bullets.map((b, i) => (
          <Typography key={i} component="li" sx={{ fontSize: 13, lineHeight: 1.4, color: 'text.secondary', '&::marker': { color: 'text.disabled' } }}>{b}</Typography>
        ))}
      </Box>
    </Box>
  );
}

/**
 * ProjectsView card: one git repo toplevel, its status fetched on mount and
 * whenever `refreshKey` changes (header's refresh-all, no polling).
 */
export default function ProjectCard({ path, refreshKey, onDelete, draggable, onDragStart, onDragEnd, onDragOver, onDrop }) {
  const [status, setStatus] = useState(null);
  const [phase, setPhase] = useState('loading'); // 'loading' | 'ok' | 'error'
  const [summary, setSummary] = useState(null);
  const [summaryPhase, setSummaryPhase] = useState('loading'); // 'loading' | 'ok' | 'error'

  const load = useCallback(() => {
    fetch(`/api/projects/status?path=${encodeURIComponent(path)}`)
      .then((r) => { if (!r.ok) throw new Error('unavailable'); return r.json(); })
      .then((d) => { setStatus(d); setPhase('ok'); })
      .catch(() => setPhase('error'));
    // Loads independently of status: a slow LLM summary must never hold up
    // the status chips above.
    fetch(`/api/projects/summary?path=${encodeURIComponent(path)}`)
      .then((r) => { if (!r.ok) throw new Error('unavailable'); return r.json(); })
      .then((d) => { setSummary(d); setSummaryPhase('ok'); })
      .catch(() => setSummaryPhase('error'));
  }, [path]);

  useEffect(() => { load(); }, [load, refreshKey]);

  return (
    <Box
      data-testid="project-card"
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDrop={onDrop}
      sx={(t) => ({
        p: 1.5, borderRadius: `${getTokens(t).radius.md ?? getTokens(t).radius.sm}px`,
        border: `1px solid ${getTokens(t).glass.stroke}`, cursor: 'grab', minWidth: 0,
      })}
    >
      <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-start' }}>
        <Box sx={{ minWidth: 0, flex: 1 }}>
          <Typography sx={{ fontWeight: 600, fontSize: 15, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {repoName(path)}
          </Typography>
          <Typography sx={{ fontSize: 11, color: 'text.secondary', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {tildify(path)}
          </Typography>
        </Box>
        <Tooltip title="Refresh project" disableInteractive>
          <IconButton size="small" aria-label="Refresh project" onClick={load}><RefreshIcon fontSize="small" /></IconButton>
        </Tooltip>
        <Tooltip title="Remove project" disableInteractive>
          <IconButton size="small" aria-label="Remove project" onClick={() => onDelete(path)}><DeleteOutlineIcon fontSize="small" /></IconButton>
        </Tooltip>
      </Stack>

      {phase === 'error' && <Typography sx={{ mt: 1.5, fontSize: 13, color: 'text.secondary' }}>unavailable</Typography>}
      {phase === 'loading' && !status && <Typography sx={{ mt: 1.5, fontSize: 13, color: 'text.secondary' }}>Loading…</Typography>}
      {status && (
        <Stack spacing={1} sx={{ mt: 1.5 }}>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 0.5 }}>
            <Chip label={status.branch || 'detached'} size="small" color="primary" variant="outlined" sx={{ height: 20, fontSize: 11 }} />
            {status.upstream ? (
              <>
                <Typography sx={{ fontSize: 11, color: 'text.secondary' }}>{status.upstream}</Typography>
                <Typography sx={{ fontSize: 11 }}>↑{status.ahead} ↓{status.behind}</Typography>
              </>
            ) : (
              <Chip label="no upstream" size="small" sx={{ height: 20, fontSize: 11 }} />
            )}
          </Stack>
          <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap', rowGap: 0.5 }}>
            <CountChip label="staged" n={status.staged} />
            <CountChip label="modified" n={status.modified} />
            <CountChip label="untracked" n={status.untracked} />
            <CountChip label="conflicted" n={status.conflicted} />
            <CountChip label="stash" n={status.stash} />
          </Stack>
          {status.lastCommit && (
            <Typography sx={{ fontSize: 12, color: 'text.secondary', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {status.lastCommit.subject} · {fmtRelative(status.lastCommit.date)}
            </Typography>
          )}

          {summaryPhase === 'error' && <Typography sx={{ fontSize: 12, color: 'text.secondary' }}>summary unavailable</Typography>}
          {summaryPhase === 'loading' && !summary && <Typography sx={{ fontSize: 12, color: 'text.secondary' }}>Summarizing…</Typography>}
          {summary && (
            <Stack spacing={0.75}>
              {!!summary.committed?.length && (
                <SummarySection title={summary.scope === 'unpushed' ? 'Unpushed' : 'Recent commits'} bullets={summary.committed} />
              )}
              {summary.uncommitted?.length ? (
                <SummarySection title="Uncommitted" bullets={summary.uncommitted} />
              ) : (
                <Typography sx={{ fontSize: 13, color: 'text.secondary' }}>Working tree clean</Typography>
              )}
              <Typography sx={{ fontSize: 11, color: 'text.disabled' }}>summary: {summary.source === 'llm' ? summary.model : 'git'}</Typography>
            </Stack>
          )}
        </Stack>
      )}
    </Box>
  );
}
