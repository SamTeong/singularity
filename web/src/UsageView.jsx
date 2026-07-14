import React from 'react';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import Alert from '@mui/material/Alert';
import RefreshIcon from '@mui/icons-material/Refresh';
import { useTheme } from '@mui/material/styles';
import { PROVIDERS, fmtReset, meterColor } from './usageUtil.js';

const fmtWall = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
};

function Bar({ label, win }) {
  const t = useTheme();
  if (!win) return null;
  const pct = win.pctUsed;
  return (
    <Box>
      <Typography sx={{ fontSize: 13, mb: 0.5 }}>{label}</Typography>
      <Box sx={(th) => ({ height: 10, borderRadius: 5, bgcolor: th.vars.palette.glass.stroke, overflow: 'hidden' })}>
        <Box sx={{ width: `${Math.min(100, pct ?? 0)}%`, height: '100%', bgcolor: meterColor(t, pct), transition: 'width .3s' }} />
      </Box>
      <Typography variant="code" sx={{ display: 'block', fontSize: 12, color: 'text.secondary', mt: 0.5 }}>
        {pct == null ? '—' : `${pct}% used`}{win.resetsAt ? ` · resets in ${fmtReset(win.resetsAt)}` : ''}
      </Typography>
      {win.resetsAt && (
        <Typography variant="code" sx={{ display: 'block', fontSize: 10, color: 'text.disabled' }}>{fmtWall(win.resetsAt)}</Typography>
      )}
      {win.models?.length > 0 && (
        <Stack direction="row" spacing={1} flexWrap="wrap" sx={{ mt: 0.5 }}>
          {win.models.map((m) => (
            <Typography key={m.model} variant="code" sx={{ fontSize: 10, color: 'text.secondary' }}>
              {m.model}: {m.pctUsed != null ? `${m.pctUsed}%` : `${m.requests} req`}
            </Typography>
          ))}
        </Stack>
      )}
    </Box>
  );
}

function ProviderCard({ label, u }) {
  const authHelp = {
    // Browser mode (error 'no-login') vs manual-cookie mode need different fixes.
    ollama: u?.error === 'no-login'
      ? 'Automation browser not signed in — run `npm run ollama-login` and complete the ollama.com login once.'
      : 'Populate ~/.singularity/ollama.json with a fresh { cookie, userAgent } from a logged-in ollama.com session (cf_clearance expires — re-paste periodically). Or switch to browser mode: {"mode":"browser"} + `npm run ollama-login`.',
    claude: 'OAuth token missing/expired — run `claude /login`.',
  };
  return (
    <Box sx={(t) => ({ p: 2, borderRadius: `${t.zapac.radius.md}px`, border: `1px solid ${t.vars.palette.glass.stroke}` })}>
      <Stack direction="row" spacing={1} alignItems="baseline" sx={{ mb: 1.5 }}>
        <Typography sx={{ fontSize: 15, fontWeight: 600 }}>{label}</Typography>
        {u?.plan && <Typography variant="code" sx={{ fontSize: 11, px: 0.75, py: 0.25, borderRadius: 1, bgcolor: 'action.selected', color: 'text.secondary', textTransform: 'capitalize' }}>{u.plan}</Typography>}
      </Stack>

      {!u ? (
        <Typography sx={{ fontSize: 13, color: 'text.secondary' }}>Loading…</Typography>
      ) : u.ok ? (
        <Stack spacing={2}>
          <Bar label="Session (5h)" win={u.session} />
          <Bar label="Weekly (7d)" win={u.weekly} />
          {u.extra?.enabled && (
            <Typography variant="code" sx={{ fontSize: 12, color: 'text.secondary' }}>
              Extra usage: {u.extra.used ?? '—'} / {u.extra.monthlyLimit ?? '—'}
            </Typography>
          )}
        </Stack>
      ) : (
        <Alert severity={u.needsAuth ? 'warning' : 'info'} sx={{ py: 0.5 }}>
          {u.needsAuth ? authHelp[label.toLowerCase()] : `Unavailable: ${u.error || 'unknown error'}`}
        </Alert>
      )}
    </Box>
  );
}

// Full usage view (main pane). Both providers side by side, manual force-refresh.
export default function UsageView({ usage, onRefresh }) {
  return (
    <Stack sx={{ height: '100%', p: 3, minHeight: 0, overflow: 'auto' }} spacing={2}>
      <Stack direction="row" alignItems="center" spacing={1.5}>
        <Typography sx={{ fontSize: 20, fontWeight: 600 }}>Usage</Typography>
        <Box sx={{ flex: 1 }} />
        <Button size="small" startIcon={<RefreshIcon />} onClick={() => onRefresh(true)} sx={{ '& .MuiButton-startIcon': { marginRight: 0.5 } }}>Refresh</Button>
      </Stack>
      <Typography sx={{ fontSize: 12, color: 'text.secondary' }}>
        Account-wide 5-hour session and 7-day weekly limits. Cached ~60s; Refresh forces a live pull.
      </Typography>
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 2 }}>
        {PROVIDERS.map((p) => <ProviderCard key={p.key} label={p.label} u={usage?.[p.key]} />)}
      </Box>
    </Stack>
  );
}
