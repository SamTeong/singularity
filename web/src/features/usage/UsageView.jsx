import { getTokens } from '@/theme/contract.js';
import { useState } from 'react';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import Alert from '@mui/material/Alert';
import Collapse from '@mui/material/Collapse';
import IconButton from '@mui/material/IconButton';
import RefreshIcon from '@mui/icons-material/Refresh';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { visibleProviders, usd } from '@/lib/usageUtil.js';
import { useCapabilities } from '@/hooks/useCapabilities.js';
import { Meter } from '@/components/Meter.jsx';
import UsageReportView from '@/features/usage/UsageReportView.jsx';

function ProviderCard({ label, u }) {
  const authHelp = {
    // Browser mode (error 'no-login') vs manual-cookie mode need different fixes.
    ollama: u?.error === 'no-login'
      ? 'Fresh auth required. Run "npm run ollama-login" in a terminal, then log in to ollama.com when the browser opens.'
      : 'Fresh auth required. Run "npm run ollama-login" in a terminal, or paste a fresh cookie and browser ID from a logged-in ollama.com tab into state/ollama.json.',
    claude: 'No usage data yet — run Claude Code to update.',
    codex: 'No usage data yet — run Codex to update.',
  };
  return (
    <Box sx={(t) => ({ p: 2, borderRadius: `${getTokens(t).radius.md}px`, border: `1px solid ${getTokens(t).glass.stroke}` })}>
      <Stack direction="row" spacing={1} sx={{ mb: 1.5, alignItems: 'baseline' }}>
        <Typography sx={{ fontSize: 15, fontWeight: 600 }}>{label}</Typography>
        {u?.plan && <Typography variant="code" sx={{ fontSize: 11, px: 0.75, py: 0.25, borderRadius: 1, bgcolor: 'action.selected', color: 'text.secondary', textTransform: 'capitalize' }}>{u.plan}</Typography>}
      </Stack>

      {!u ? (
        <Typography sx={{ fontSize: 13, color: 'text.secondary' }}>Loading…</Typography>
      ) : u.ok ? (
        <Stack spacing={2}>
          <Meter size="lg" label="Session (5h)" win={u.session} segments={5} windowMs={5 * 3.6e6} />
          <Meter size="lg" label="Weekly (7d)" win={u.weekly} segments={7} windowMs={7 * 24 * 3.6e6} />
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
          {/* Codex data is push-only (last rollout log write) and can be a day
              stale — show when it's from, unlike the other two live-fetched
              providers. */}
          {label.toLowerCase() === 'codex' && (
            <Typography sx={{ fontSize: 12, color: 'text.secondary' }}>
              Last updated on {new Date(u.fetchedAt).toLocaleString()}
              {/* Reading outlives its own window: Codex logs limits only on a real
                  turn, so after a reset with no turns since, these bars show a
                  window that already rolled over — otherwise Refresh looks broken
                  when it faithfully returns the same old record. */}
              {u.weekly?.resetsAt && new Date(u.weekly.resetsAt) < new Date() &&
                ', window has since reset, run Codex to update.'}
            </Typography>
          )}
        </Stack>
      ) : (
        <Alert severity={u.needsAuth ? 'warning' : 'info'} sx={{ py: 0.5 }}>
          {u.needsAuth ? authHelp[label.toLowerCase()] : `Couldn't load this: ${u.error || 'unknown error'}`}
        </Alert>
      )}
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
  const [open, setOpen] = useState(true);
  const caps = useCapabilities();
  return (
    <Stack sx={{ height: '100%', minHeight: 0 }}>
      <Stack sx={{ p: 3, pb: 2, flexShrink: 0 }} spacing={2}>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
          <IconButton
            size="small"
            onClick={() => setOpen((o) => !o)}
            aria-label={open ? 'Collapse usage' : 'Expand usage'}
            sx={{ transform: open ? 'rotate(0deg)' : 'rotate(-90deg)', transition: 'transform .2s' }}
          >
            <ExpandMoreIcon />
          </IconButton>
          <Typography sx={{ fontSize: 20, fontWeight: 600 }}>Usage</Typography>
          <Box sx={{ flex: 1 }} />
          <Button size="small" startIcon={<RefreshIcon />} onClick={() => onRefresh(true)} sx={{ '& .MuiButton-startIcon': { marginRight: 0.5 } }}>Refresh</Button>
        </Stack>
        <Collapse in={open}>
          <Stack spacing={2}>
            <Typography sx={{ fontSize: 12, color: 'text.secondary' }}>
              Shows the usage limits for your whole account: a 5-hour session limit and a 7-day weekly limit. This updates on its own about once a minute — press Refresh to check right now.
            </Typography>
            <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 2 }}>
              {visibleProviders(caps).map((p) => <ProviderCard key={p.key} label={p.label} u={usage?.[p.key]} />)}
            </Box>
          </Stack>
        </Collapse>
      </Stack>
      {/* Usage report (harness-usage-report skill) fills the rest of the pane. */}
      <Box sx={(t) => ({ flex: 1, minHeight: 0, borderTop: `1px solid ${getTokens(t).glass.stroke}` })}>
        <UsageReportView />
      </Box>
    </Stack>
  );
}
