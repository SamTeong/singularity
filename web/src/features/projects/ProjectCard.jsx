import { useEffect, useRef, useState } from 'react';
import { getTokens } from '@/theme/contract.js';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import Chip from '@mui/material/Chip';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlined';
import RefreshIcon from '@mui/icons-material/Refresh';
import DragIndicatorIcon from '@mui/icons-material/DragIndicator';
import KeyboardArrowUpIcon from '@mui/icons-material/KeyboardArrowUp';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import CloudDownloadOutlinedIcon from '@mui/icons-material/CloudDownloadOutlined';
import CallMergeIcon from '@mui/icons-material/CallMerge';
import SyncIcon from '@mui/icons-material/Sync';
import AddCircleOutlineIcon from '@mui/icons-material/AddCircleOutlined';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import NoteAddOutlinedIcon from '@mui/icons-material/NoteAddOutlined';
import ReportProblemOutlinedIcon from '@mui/icons-material/ReportProblemOutlined';
import Inventory2OutlinedIcon from '@mui/icons-material/Inventory2Outlined';
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

// Collapsed-card twin of CountChip: icon + number, label in the tooltip.
const COUNT_ICONS = [
  ['staged', AddCircleOutlineIcon], ['modified', EditOutlinedIcon], ['untracked', NoteAddOutlinedIcon],
  ['conflicted', ReportProblemOutlinedIcon], ['stash', Inventory2OutlinedIcon],
];
function CountIcons({ status }) {
  return (
    <Stack direction="row" spacing={1} sx={{ alignItems: 'center', ml: 'auto !important' }}>
      {COUNT_ICONS.map(([label, Icon]) => (
        <Tooltip key={label} title={`${label} ${status[label]}`} disableInteractive>
          <Stack direction="row" spacing={0.25} sx={{ alignItems: 'center', color: 'text.secondary', opacity: status[label] ? 1 : 0.4 }}>
            <Icon sx={{ fontSize: 14 }} />
            <Typography sx={{ fontSize: 11 }}>{status[label]}</Typography>
          </Stack>
        </Tooltip>
      ))}
    </Stack>
  );
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
 * whenever `refreshKey` changes (header's refresh-all, no polling). Starts
 * collapsed (header + branch line); clicking the card's blank space toggles
 * the working-tree counts, last commit and summary. The (LLM) summary is
 * fetched only once expanded, and re-fetched after a refresh when next shown.
 */
export default function ProjectCard({ path, refreshKey, expandAll, onDelete, onDragStart, onDragEnd, onDragOver, onDrop, narrow, onMove, canUp, canDown }) {
  const [status, setStatus] = useState(null);
  const [phase, setPhase] = useState('loading'); // 'loading' | 'ok' | 'error'
  const [summary, setSummary] = useState(null);
  const [summaryPhase, setSummaryPhase] = useState('loading'); // 'loading' | 'ok' | 'error'
  const [expanded, setExpanded] = useState(false);
  // Buttons, the drag grip and a text selection keep their own meaning.
  const toggle = (e) => {
    if (e.target.closest('button, [draggable="true"]') || window.getSelection()?.toString()) return;
    setExpanded((x) => !x);
  };

  // Header's expand/collapse-all — skip n=0 (initial) so cards still start collapsed.
  useEffect(() => { if (expandAll.n) setExpanded(expandAll.on); }, [expandAll]); // eslint-disable-line react-hooks/set-state-in-effect

  // Bumped by the card's own refresh / git ops; refreshKey is refresh-all.
  const [reloadN, setReloadN] = useState(0);
  const load = () => setReloadN((n) => n + 1);

  useEffect(() => {
    fetch(`/api/projects/status?path=${encodeURIComponent(path)}`)
      .then((r) => { if (!r.ok) throw new Error('unavailable'); return r.json(); })
      .then((d) => { setStatus(d); setPhase('ok'); })
      .catch(() => setPhase('error'));
  }, [path, refreshKey, reloadN]);

  // Loads independently of status: a slow LLM summary must never hold up the
  // status chips above. Skipped while collapsed; `summaryFor` remembers which
  // refresh generation was fetched so re-expanding doesn't re-request.
  const summaryKey = `${path}|${refreshKey}|${reloadN}`;
  const summaryFor = useRef(null);
  useEffect(() => {
    if (!expanded || summaryFor.current === summaryKey) return;
    summaryFor.current = summaryKey;
    fetch(`/api/projects/summary?path=${encodeURIComponent(path)}`)
      .then((r) => { if (!r.ok) throw new Error('unavailable'); return r.json(); })
      .then((d) => { setSummary(d); setSummaryPhase('ok'); })
      .catch(() => setSummaryPhase('error'));
  }, [expanded, summaryKey, path]);

  // Plain git (daemon shells out, no agent); reload status either way.
  const [gitBusy, setGitBusy] = useState(false);
  const [gitError, setGitError] = useState(null);
  const runGit = (op) => {
    setGitBusy(true);
    setGitError(null);
    fetch('/api/projects/git', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path, op }) })
      .then((r) => r.json())
      .then((d) => { if (!d.ok) setGitError(d.error || `git ${op} failed`); })
      .catch(() => setGitError(`git ${op} failed`))
      .finally(() => { setGitBusy(false); load(); });
  };

  return (
    <Box
      data-testid="project-card"
      aria-expanded={expanded}
      tabIndex={0}
      onClick={toggle}
      onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setExpanded((x) => !x); } }}
      onDragOver={onDragOver}
      onDrop={onDrop}
      sx={(t) => ({
        p: 1.5, borderRadius: `${getTokens(t).radius.md ?? getTokens(t).radius.sm}px`,
        border: `1px solid ${getTokens(t).glass.stroke}`, minWidth: 0, cursor: 'pointer',
      })}
    >
      <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-start' }}>
        {narrow ? (
          // Below 900px an HTML5 drag is not operable by touch, so the grip is
          // replaced by the compact Move pair — the card itself never drags, it
          // only carries the drop target and click-to-expand, so the buttons
          // stopPropagation.
          <Stack sx={{ alignItems: 'center', mt: 0.25 }}>
            <Tooltip title="Move up" disableInteractive>
              <span>
                <IconButton size="small" aria-label={`Move ${repoName(path)} up`} sx={{ p: 0.25 }} disabled={!canUp} onClick={(e) => { e.stopPropagation(); onMove(-1); }}>
                  <KeyboardArrowUpIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
            <Tooltip title="Move down" disableInteractive>
              <span>
                <IconButton size="small" aria-label={`Move ${repoName(path)} down`} sx={{ p: 0.25 }} disabled={!canDown} onClick={(e) => { e.stopPropagation(); onMove(1); }}>
                  <KeyboardArrowDownIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
          </Stack>
        ) : (
          <Tooltip title="Drag to change the order" disableInteractive>
            <Box
              draggable
              onDragStart={onDragStart}
              onDragEnd={onDragEnd}
              sx={{ display: 'grid', placeItems: 'center', cursor: 'grab', color: 'text.disabled', mt: 0.25, '&:active': { cursor: 'grabbing' } }}
            >
              <DragIndicatorIcon fontSize="small" />
            </Box>
          </Tooltip>
        )}
        <Box sx={{ minWidth: 0, flex: 1 }}>
          <Typography sx={{ fontWeight: 600, fontSize: 15, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {repoName(path)}
          </Typography>
          <Typography sx={{ fontSize: 11, color: 'text.secondary', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {tildify(path)}
          </Typography>
        </Box>
        <Tooltip title="git fetch" disableInteractive>
          <span><IconButton size="small" aria-label="git fetch" disabled={gitBusy} onClick={() => runGit('fetch')}><CloudDownloadOutlinedIcon fontSize="small" /></IconButton></span>
        </Tooltip>
        <Tooltip title="git rebase" disableInteractive>
          <span><IconButton size="small" aria-label="git rebase" disabled={gitBusy} onClick={() => runGit('rebase')}><CallMergeIcon fontSize="small" /></IconButton></span>
        </Tooltip>
        <Tooltip title="git fetch + rebase" disableInteractive>
          <span><IconButton size="small" aria-label="git fetch + rebase" disabled={gitBusy} onClick={() => runGit('sync')}><SyncIcon fontSize="small" /></IconButton></span>
        </Tooltip>
        <Tooltip title="Refresh project" disableInteractive>
          <IconButton size="small" aria-label="Refresh project" onClick={() => { setGitError(null); load(); }}><RefreshIcon fontSize="small" /></IconButton>
        </Tooltip>
        <Tooltip title="Remove project" disableInteractive>
          <IconButton size="small" aria-label="Remove project" onClick={() => onDelete(path)}><DeleteOutlineIcon fontSize="small" /></IconButton>
        </Tooltip>
      </Stack>

      {gitError && <Typography role="alert" sx={{ mt: 1.5, fontSize: 12, color: 'error.main', overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>{gitError}</Typography>}
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
            {!expanded && <CountIcons status={status} />}
          </Stack>
          {expanded && (<>
            <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap', rowGap: 0.5 }}>
              <CountChip label="staged" n={status.staged} />
              <CountChip label="modified" n={status.modified} />
              <CountChip label="untracked" n={status.untracked} />
              <CountChip label="conflicted" n={status.conflicted} />
              <CountChip label="stash" n={status.stash} />
            </Stack>
            {status.lastCommit && (
              <Typography sx={{ fontSize: 12, color: 'text.secondary', overflowWrap: 'anywhere' }}>
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
                {!!summary.uncommitted?.length && <SummarySection title="Uncommitted" bullets={summary.uncommitted} />}
                {summary.source === 'llm' && <Typography sx={{ fontSize: 11, color: 'text.disabled' }}>summary: {summary.model}</Typography>}
              </Stack>
            )}
          </>)}
        </Stack>
      )}
    </Box>
  );
}
