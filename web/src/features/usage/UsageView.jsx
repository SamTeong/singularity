import { getTokens } from '@/theme/contract.js';
import { useState } from 'react';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import Alert from '@mui/material/Alert';
import CircularProgress from '@mui/material/CircularProgress';
import Collapse from '@mui/material/Collapse';
import IconButton from '@mui/material/IconButton';
import Link from '@mui/material/Link';
import Tooltip from '@mui/material/Tooltip';
import RefreshIcon from '@mui/icons-material/Refresh';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import { statusColor } from '@/shell/shellStyles.js';
import { PHONE_QUERY, TABLET_QUERY } from '@/shell/breakpoints.js';
import { visibleProviders, usd, windowAnchorAvailable, windowAnchored } from '@/lib/usageUtil.js';
import { useCapabilities } from '@/hooks/useCapabilities.js';
import { useAgents } from '@/providers/AgentsProvider.jsx';
import { Meter } from '@/components/Meter.jsx';
import UsageReportView from '@/features/usage/UsageReportView.jsx';

// The daemon owns refresh cadence now: claude/codex check their local files
// every 5s (no network on those ticks) and reach the network at most once
// every 60s per source when that local data has gone stale; ollama (network
// scrape only) checks every 60s. It pushes every changed reading over the WS
// 'usage' frame this view already consumes via useAgents() — there is no
// client-side polling timer here anymore.

// Collapsed/expanded state of the two collapsible panels, so a reload lands
// where the user left it. Absent (or storage blocked) means expanded, the default.
const USAGE_OPEN_KEY = 'sing:usage-open';
const REPORT_OPEN_KEY = 'sing:usage-report-open';

function readPanelOpen(key) {
  try { return localStorage.getItem(key) !== '0'; } catch { return true; }
}

function writePanelOpen(key, open) {
  try { localStorage.setItem(key, open ? '1' : '0'); } catch {
    // Storage unavailable: the toggle still works, it just doesn't outlive the visit.
  }
}

function ollamaFailure(error) {
  if (error === 'no-config' || error === 'auth-expired') return 'Ollama sign-in expired. Connect to continue refreshing.';
  if (error === 'challenge-required') return 'Ollama needs an interactive browser check. Connect and complete it.';
  if (error === 'scrape-incompatible') return 'Ollama settings changed and its usage meter could not be read.';
  return `Ollama usage is currently unavailable${error ? `: ${error}` : '.'}`;
}

// 8px status dot: colour carries severity, the words live in the tooltip.
const dotSx = (kind) => (t) => {
  const c = statusColor(t, kind);
  return { width: 8, height: 8, borderRadius: '50%', background: c, flex: 'none', alignSelf: 'center', boxShadow: `0 0 0 3px color-mix(in srgb, ${c} 22%, transparent)` };
};

const SEVERITY = { ok: 0, info: 0, warn: 1, danger: 2 };
// yyyy-MM-dd HH:mm:ss in local time (the sv-SE locale prints exactly that).
const stamp = (t) => (t ? new Date(t).toLocaleString('sv-SE') : 'never');

function ProviderCard({ sourceKey, label, usageUrl, u, onConnect, connecting, connectState, refreshing, anchor, onPoke }) {
  const isOllama = label.toLowerCase() === 'ollama';
  // Manual anchor poke, the same in-flight shape as the header's refresh: the
  // button reads as motion while the daemon runs the prompt (90s timeout).
  const [poking, setPoking] = useState(false);
  const poke = () => {
    setPoking(true);
    Promise.resolve(onPoke()).finally(() => setPoking(false));
  };
  const anchored = windowAnchored(u?.session, anchor?.lastAnchorAt);
  const showAnchor = anchor && windowAnchorAvailable(sourceKey, u?.session);
  // Anchor (enabled via the daemon's WINDOW_ANCHOR in .env) folds into the
  // header dot: 'Skipped' is a success — real work anchored the window before
  // the timer fired — so a failed poke is red and an unarmed anchor amber.
  const anchorOn = showAnchor && anchor.enabled;
  const anchorKind = anchor?.lastResult === 'Error' ? 'danger' : anchor?.nextAnchorAt ? 'ok' : 'warn';
  const anchorLine = `Window anchor: ${anchor?.lastResult ?? 'Never'}: Last ${stamp(anchor?.lastAnchorAt)}${anchor?.lastError ? ` — ${anchor.lastError}` : ''}`;
  const nextLine = `Next ${anchor?.nextAnchorAt ? stamp(anchor.nextAnchorAt) : 'not armed'}`;
  const stale = !u?.ok || !!u?.stale;
  // The dot carries the same three-way read the rail's daemon footer uses
  // (statusColor): stale-but-usable is amber, a failed read is red, fresh is the
  // nominal mint. The words live in the tooltip — colour is never the only cue.
  const usageKind = stale ? (u?.ok ? 'warn' : 'danger') : 'ok';
  const statusKind = anchorOn && SEVERITY[anchorKind] > SEVERITY[usageKind] ? anchorKind : usageKind;
  const statusText = stale ? (u?.ok ? 'Stale' : 'Update failed') : 'Up-to-date';
  const statusLines = [`5h/7d usage: ${statusText}: Last ${stamp(u?.fetchedAt)}`, ...(anchorOn ? [anchorLine, nextLine] : [])];
  const authHelp = {
    ollama: ollamaFailure(u?.error),
    claude: 'No usage data yet — run Claude Code to update.',
    codex: 'No usage data yet — run Codex to update.',
  };
  return (
    <Box sx={(t) => ({ p: 2, borderRadius: `${getTokens(t).radius.md}px`, border: `1px solid ${getTokens(t).glass.stroke}` })}>
      <Stack direction="row" spacing={1} sx={{ mb: 1.5, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <Typography sx={{ fontSize: 15, fontWeight: 600 }}>{label}</Typography>
        {u?.plan && <Typography variant="code" sx={{ fontSize: 11, px: 0.75, py: 0.25, borderRadius: 1, bgcolor: 'action.selected', color: 'text.secondary', textTransform: 'capitalize' }}>{u.plan}</Typography>}
        {/* Jump-out sits right of the plan pill. alignSelf overrides the header
            Stack's baseline alignment — an icon has no text baseline of its
            own to sit on. */}
        {usageUrl && (
          <Tooltip title="Open usage page" placement="top">
            <Link href={usageUrl} target="_blank" rel="noreferrer" sx={{ display: 'inline-flex', alignItems: 'center', alignSelf: 'center' }} color="text.secondary">
              <OpenInNewIcon fontSize="small" />
            </Link>
          </Tooltip>
        )}
        {/* This card's last successful read, on demand instead of a stamped line:
            a timestamp is the only feedback that the daemon's own cadence is firing (and
            that a Codex record is a day old), but it costs the header ~150px it
            does not have at 320px. Same affordance as the Automation page. */}
        {u?.fetchedAt && !refreshing && (
          <Tooltip disableInteractive={!(anchorOn && anchor.lastError)} title={<>{statusLines.map((l) => <div key={l}>{l}</div>)}</>}>
            <Box role="img" data-status={statusKind} aria-label={`${label} status — ${statusLines.join(' · ')}`} sx={dotSx(statusKind)} />
          </Tooltip>
        )}
        {refreshing && <CircularProgress size={14} sx={{ alignSelf: 'center' }} />}
        <Box sx={{ flex: 1 }} />
        {/* Manual anchor: the daemon pokes regardless of WINDOW_ANCHOR. Hidden
            once the window is anchored — the prompt would just burn tokens
            against a window whose reset is already pinned. */}
        {showAnchor && !anchored && (
          <Button size="small" disabled={poking} onClick={poke} sx={{ alignSelf: 'center' }}>
            {poking ? 'Anchoring…' : 'Anchor'}
          </Button>
        )}
        {isOllama && !(u?.ok && !u?.stale) && (
          <Button size="small" onClick={onConnect} disabled={connecting}>{connecting ? 'Connecting…' : 'Connect'}</Button>
        )}
      </Stack>

      {!u ? (
        <Typography sx={{ fontSize: 13, color: 'text.secondary' }}>Loading…</Typography>
      ) : u.ok ? (
        <Stack spacing={2}>
          {/* Phone + tablet: the two rolling-window meters share a row
              (half-width columns); desktop stacks them with room for the full
              reset stamp. Query literals, not theme.breakpoints — the skins
              ship different breakpoint pixels (breakpoints.js). */}
          <Box sx={{ display: 'grid', gap: 2, [`@media ${PHONE_QUERY}, ${TABLET_QUERY}`]: { gridTemplateColumns: '1fr 1fr' } }}>
            <Meter size="lg" label="5h" win={u.session} segments={5} windowMs={5 * 3.6e6} />
            <Meter size="lg" label="7d" win={u.weekly} segments={7} windowMs={7 * 24 * 3.6e6} />
          </Box>
          {/* Extra usage ($ overage): monthly $ budget, not a rolling window → no
              ticks. Draw as a meter so the view isn't blank when plan windows null
              out on overage; $ amounts under the bar. */}
          {u.extra?.enabled && u.extra.pctUsed != null && (
            <Box>
              <Meter size="lg" label="Extra usage ($)" win={u.extra} segments={1} dp={1} />
              <Typography variant="code" sx={{ display: 'block', fontSize: 12, color: 'text.secondary', mt: 0.5 }}>
                {usd(u.extra.used)} / {usd(u.extra.monthlyLimit)}
              </Typography>
            </Box>
          )}
          {/* The header's info icon carries this card's last-read time, so what is
              left here is the rolled-over reading: Codex logs limits only on a real
              turn, so after a reset with no turns since, these bars show a window
              that already rolled over — otherwise Refresh looks broken when it
              faithfully returns the same old record. */}
          {label.toLowerCase() === 'codex' && u.weekly?.resetsAt && new Date(u.weekly.resetsAt) < new Date() && (
            <Typography sx={{ fontSize: 12, color: 'text.secondary' }}>
              Window has since reset, run Codex to update.
            </Typography>
          )}
          {isOllama && u.stale && (
            <Alert severity={u.needsAuth ? 'warning' : 'info'} sx={{ py: 0.5 }}>
              Last successful usage from {u.fetchedAt ? new Date(u.fetchedAt).toLocaleString() : 'an earlier refresh'}. {ollamaFailure(u.error)}
            </Alert>
          )}
          {!isOllama && u.stale && (
            <Alert severity={u.needsAuth ? 'warning' : 'info'} sx={{ py: 0.5 }}>
              Last successful usage from {u.fetchedAt ? new Date(u.fetchedAt).toLocaleString() : 'an earlier refresh'}. {label} refresh failed{u.error ? `: ${u.error}` : '.'}
            </Alert>
          )}
        </Stack>
      ) : (
        <Alert severity={u.needsAuth ? 'warning' : 'info'} sx={{ py: 0.5 }}>
          {u.needsAuth ? authHelp[label.toLowerCase()] : `Couldn't load this: ${u.error || 'unknown error'}`}
        </Alert>
      )}
      {isOllama && connectState === 'connecting' && <Alert severity="info" sx={{ py: 0.5, mt: 1 }}>Opening the managed Ollama browser for sign-in…</Alert>}
      {isOllama && connectState === 'success' && <Alert severity="success" sx={{ py: 0.5, mt: 1 }}>Ollama connection verified.</Alert>}
      {isOllama && connectState === 'failure' && !u?.stale && <Alert severity="warning" sx={{ py: 0.5, mt: 1 }}>{ollamaFailure(u?.error)}</Alert>}
      {/* Outside the ok/error branches on purpose: the sampler stops precisely
          when a scrape fails, so at that moment this card is rendering the error
          Alert — a note nested in the ok branch would never be seen. */}
      {u?.historyPaused && (
        <Typography sx={{ fontSize: 12, color: 'text.secondary', mt: 1 }}>
          History sampling stopped after {u.historyPaused.error} — press Refresh to resume.
        </Typography>
      )}
    </Box>
  );
}

// Full usage view (main pane). Both providers side by side, manual force-refresh.
export default function UsageView({ usage, onRefresh }) {
  const [open, setOpen] = useState(() => readPanelOpen(USAGE_OPEN_KEY));
  const toggleOpen = () => setOpen((o) => { writePanelOpen(USAGE_OPEN_KEY, !o); return !o; });
  const [reportOpen, setReportOpen] = useState(() => readPanelOpen(REPORT_OPEN_KEY));
  const toggleReport = () => setReportOpen((o) => { writePanelOpen(REPORT_OPEN_KEY, !o); return !o; });
  const caps = useCapabilities();
  const { connectOllamaUsage, windowAnchor, pokeWindowAnchor } = useAgents();
  const [connectState, setConnectState] = useState(null);
  const connectOllama = async () => {
    setConnectState('connecting');
    const result = await connectOllamaUsage();
    setConnectState(result.ok ? 'success' : 'failure');
  };
  // The header's Refresh is a full-document force pull — all three sources at
  // once — so the spinner belongs on every card, not on one. onRefresh resolves
  // when the read lands (a failed read resolves too), so it cannot stick.
  const [refreshingAll, setRefreshingAll] = useState(false);
  const refreshAll = async () => {
    setRefreshingAll(true);
    try { await onRefresh(true); } finally { setRefreshingAll(false); }
  };
  return (
    <Stack sx={{ height: '100%', minHeight: 0, overflowY: 'auto' }}>
      <Stack direction="row" spacing={1.5} sx={{ flexShrink: 0, p: 2, pb: 1.5, alignItems: 'center', flexWrap: 'wrap', borderBottom: (t) => `1px solid ${getTokens(t).glass.stroke}` }}>
        <IconButton
          size="small"
          onClick={toggleOpen}
          aria-label={open ? 'Collapse usage' : 'Expand usage'}
          sx={{ transform: open ? 'rotate(0deg)' : 'rotate(-90deg)', transition: 'transform .2s' }}
        >
          <ExpandMoreIcon />
        </IconButton>
        <Typography sx={{ fontSize: 20, fontWeight: 600 }}>Usage</Typography>
        <Box sx={{ flex: 1 }} />
        <Button size="small" disabled={refreshingAll} startIcon={refreshingAll ? <CircularProgress size={14} color="inherit" /> : <RefreshIcon />} onClick={refreshAll} sx={{ '& .MuiButton-startIcon': { marginRight: 0.5 } }}>Refresh</Button>
      </Stack>
      {/* Never shrinks: the provider cards are short and always relevant, and
          capping them clipped a card mid-meter, which read as the report panel
          overlapping this one. The pane scrolls instead (outer Stack). */}
      <Box sx={{ flexShrink: 0, p: 2, flexGrow: reportOpen ? 0 : 1 }}>
        <Collapse in={open}>
          <Stack spacing={2}>
            <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 2 }}>
              {visibleProviders(caps).map((p) => (
                <ProviderCard key={p.key} sourceKey={p.key} label={p.label} usageUrl={p.usageUrl} u={usage?.[p.key]} onConnect={p.key === 'ollama' ? connectOllama : undefined} connecting={p.key === 'ollama' && connectState === 'connecting'} connectState={p.key === 'ollama' ? connectState : null} refreshing={refreshingAll} anchor={windowAnchor?.[p.key]} onPoke={() => pokeWindowAnchor(p.key)} />
              ))}
            </Box>
          </Stack>
        </Collapse>
      </Box>
      {/* Usage report (harness-usage-report skill) fills the rest of the pane, but only while expanded. */}
      {/* Proportional basis, not the bare 240px floor: the summary above takes
          its natural height first, so on any real viewport there is no leftover
          left to grow into and the report would sit pinned at 240. */}
      <Box sx={{ flexGrow: reportOpen ? 1 : 0, flexShrink: 0, flexBasis: reportOpen ? 'clamp(240px, 55vh, 640px)' : 'auto', minHeight: reportOpen ? 240 : 0 }}>
        <UsageReportView open={reportOpen} onToggle={toggleReport} />
      </Box>
    </Stack>
  );
}
