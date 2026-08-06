import { useEffect, useState, useCallback } from 'react';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import Link from '@mui/material/Link';
import Tooltip from '@mui/material/Tooltip';
import RefreshIcon from '@mui/icons-material/Refresh';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ErrorIcon from '@mui/icons-material/Error';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import BuildCircleIcon from '@mui/icons-material/BuildCircle';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import { StatusPill } from '@/components/StatusPill.jsx';
import { getTokens } from '@/theme/contract.js';

const POLL_MS = 30_000; // poll provider status while this page is active

// Statuspage overall indicator → StatusPill kind (done|review|active|error).
const INDICATOR_PILL = { none: 'done', minor: 'review', major: 'error', critical: 'error', maintenance: 'active' };
const INDICATOR_LABEL = {
  none: 'Operational', minor: 'Minor issue', major: 'Major outage',
  critical: 'Critical outage', maintenance: 'Under maintenance',
};

// Per-component status → {color icon, label}. Statuspage statuses.
const COMP = {
  operational: { Icon: CheckCircleIcon, color: 'var(--mui-palette-success-main)', label: 'Operational' },
  degraded_performance: { Icon: WarningAmberIcon, color: 'var(--mui-palette-warning-main)', label: 'Degraded' },
  partial_outage: { Icon: WarningAmberIcon, color: 'var(--mui-palette-warning-main)', label: 'Partial outage' },
  major_outage: { Icon: ErrorIcon, color: 'var(--mui-palette-error-main)', label: 'Major outage' },
  under_maintenance: { Icon: BuildCircleIcon, color: 'var(--mui-palette-info-main)', label: 'Maintenance' },
};

// "x min ago" from an ISO fetchedAt.
function ago(iso) {
  if (!iso) return '';
  const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (m < 1) return 'just now';
  if (m === 1) return '1 min ago';
  return `${m} min ago`;
}

function ProviderCard({ p }) {
  const error = !p?.ok;
  const ind = !error ? p.indicator : 'critical';
  const pill = INDICATOR_PILL[ind] ?? 'review';
  return (
    <Box sx={(t) => ({ p: 2.5, borderRadius: `${getTokens(t).radius.md}px`, border: `1px solid ${getTokens(t).glass.stroke}` })}>
      <Stack direction="row" spacing={1.25} sx={{ mb: 1.5, alignItems: 'center' }}>
        <Typography sx={{ fontSize: 15, fontWeight: 600 }}>{p?.label ?? '—'}</Typography>
        <StatusPill status={pill}>{error ? 'unreachable' : INDICATOR_LABEL[ind] ?? p.description}</StatusPill>
        <Box sx={{ flex: 1 }} />
        {p?.pageUrl && (
          <Tooltip title="Open status page" placement="top">
            <Link href={p.pageUrl} target="_blank" rel="noreferrer" sx={{ display: 'inline-flex', alignItems: 'center' }} color="text.secondary">
              <OpenInNewIcon fontSize="small" />
            </Link>
          </Tooltip>
        )}
      </Stack>

      {error ? (
        <Typography sx={{ fontSize: 13, color: 'text.secondary' }}>Couldn't load this: {p?.error || 'unknown error'}</Typography>
      ) : (
        <>
          <Typography sx={{ fontSize: 13, color: 'text.secondary', mb: p.incidents?.length || p.maintenances?.length ? 1.5 : 2 }}>
            {p.description || INDICATOR_LABEL[ind]}
          </Typography>

          {/* Active incidents / maintenance, most recent first. */}
          {[...(p.incidents || []), ...(p.maintenances || [])].map((it, i) => (
            <Stack key={i} direction="row" spacing={1} sx={{ mb: 1.5, alignItems: 'flex-start' }}>
              <WarningAmberIcon fontSize="small" sx={{ color: 'var(--mui-palette-warning-main)', mt: 0.25 }} />
              <Stack spacing={0.25}>
                <Typography sx={{ fontSize: 13, fontWeight: 600 }}>{it.name}</Typography>
                <Typography variant="code" sx={{ fontSize: 11, color: 'text.secondary' }}>
                  {it.impact} · {it.status}{it.shortlink ? ' · ' : ''}
                  {it.shortlink && <Link href={it.shortlink} target="_blank" rel="noreferrer" sx={{ fontSize: 11 }}>details</Link>}
                </Typography>
              </Stack>
            </Stack>
          ))}

          {/* Per-component status grid. */}
          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 1.25 }}>
            {(p.components || []).map((c, ci) => {
              const m = COMP[c.status] ?? COMP.operational;
              const Icon = m.Icon;
              return (
                // ponytail: Statuspage can return duplicate component names (e.g.
                // two "Login" leaves); name+index keeps keys unique without dropping rows.
                <Stack key={`${c.name}-${ci}`} direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                  <Icon fontSize="small" sx={{ color: m.color }} />
                  <Box sx={{ minWidth: 0 }}>
                    <Typography sx={{ fontSize: 12.5, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.name}</Typography>
                    <Typography sx={{ fontSize: 11, color: 'text.secondary' }}>{m.label}</Typography>
                  </Box>
                </Stack>
              );
            })}
          </Box>
        </>
      )}
    </Box>
  );
}

/**
 * Status — provider availability view. Distinct from Usage (limits) — this is
 * the live health of the upstream provider status pages. Polls /status every
 * 30s while mounted; the shell only mounts it when active, so the poll stops
 * on view switch.
 */
export default function StatusView() {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);

  const pull = useCallback((force = false) => {
    fetch(`/status${force ? '?force=1' : ''}`)
      .then((r) => r.json())
      .then((d) => { setStatus(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  useEffect(() => {
    pull(true);
    const t = setInterval(() => pull(false), POLL_MS);
    return () => clearInterval(t);
  }, [pull]);

  // Most recent fetchedAt across providers → "updated N min ago".
  const freshest = status
    ? Object.values(status).map((p) => p?.fetchedAt).filter(Boolean).sort().at(-1)
    : null;

  return (
    <Stack sx={{ height: '100%', overflow: 'auto', p: 3 }} spacing={2}>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
        <Typography sx={{ fontSize: 20, fontWeight: 600 }}>Provider status</Typography>
        <Box sx={{ flex: 1 }} />
        {freshest && <Typography sx={{ fontSize: 12, color: 'text.secondary' }}>updated {ago(freshest)}</Typography>}
        <Button size="small" startIcon={<RefreshIcon />} disabled={loading && !status} onClick={() => pull(true)} sx={{ '& .MuiButton-startIcon': { marginRight: 0.5 } }}>Refresh</Button>
      </Stack>
      <Typography sx={{ fontSize: 12, color: 'text.secondary' }}>
        Live availability of upstream provider status pages. Polls every 30 seconds while this page is open.
      </Typography>
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 2 }}>
        {loading && !status
          ? [0, 1].map((i) => <Box key={i} sx={(t) => ({ p: 2.5, borderRadius: `${getTokens(t).radius.md}px`, border: `1px solid ${getTokens(t).glass.stroke}` })}><Typography sx={{ fontSize: 13, color: 'text.secondary' }}>Loading…</Typography></Box>)
          : Object.values(status || {}).map((p) => <ProviderCard key={p.key} p={p} />)}
      </Box>
    </Stack>
  );
}