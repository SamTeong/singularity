import React from 'react';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { useTheme } from '@mui/material/styles';
import { meterColor, segTicks } from './usageUtil.js';

// One 5h/7d bar: label · track · pct.
export function Meter({ label, win, segments, windowMs }) {
  const t = useTheme();
  const pct = win?.pctUsed;
  // "Now" marker: track spans the rolling window ending at resetsAt.
  const nowPct = windowMs && win?.resetsAt
    ? Math.min(100, Math.max(0, (1 - (new Date(win.resetsAt).getTime() - Date.now()) / windowMs) * 100))
    : null;
  return (
    <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
      <Typography variant="code" sx={{ width: 16, fontSize: 10, color: 'text.secondary' }}>{label}</Typography>
      <Box sx={{ position: 'relative', flex: 1 }}>
        <Box sx={(th) => ({ position: 'relative', height: 5, borderRadius: 3, bgcolor: th.vars.palette.glass.stroke, overflow: 'hidden' })}>
          <Box sx={{ width: `${Math.min(100, pct ?? 0)}%`, height: '100%', bgcolor: meterColor(t, pct), transition: 'width .3s' }} />
          {segments > 1 && (
            <Box sx={(th) => ({ position: 'absolute', inset: 0, pointerEvents: 'none', backgroundImage: segTicks(th.vars.palette.background.paper, segments) })} />
          )}
        </Box>
        {/* Marker outside the clipped track so it can overhang top/bottom. */}
        {nowPct != null && (
          <Box sx={{ position: 'absolute', top: -2.5, bottom: -2.5, left: `${nowPct}%`, width: 1.5, ml: '-0.75px', borderRadius: 1, bgcolor: '#2dd4bf', pointerEvents: 'none' }} />
        )}
      </Box>
      <Typography variant="code" sx={{ width: 34, textAlign: 'right', fontSize: 10, color: 'text.secondary' }}>
        {pct == null ? '—' : `${Math.round(pct)}%`}
      </Typography>
    </Stack>
  );
}

export function ProviderRow({ label, u }) {
  if (!u) return (
    <Box><Typography variant="code" sx={{ fontSize: 11, color: 'text.secondary' }}>{label}: …</Typography></Box>
  );
  const bad = !u.ok;
  return (
    <Box>
      <Stack direction="row" spacing={0.75} sx={{ mb: 0.25, alignItems: 'center' }}>
        <Typography sx={{ fontSize: 11, fontWeight: 600 }}>{label}</Typography>
        {u.plan && <Typography variant="code" sx={{ fontSize: 9, px: 0.5, borderRadius: 1, bgcolor: 'action.selected', color: 'text.secondary', textTransform: 'capitalize' }}>{u.plan}</Typography>}
      </Stack>
      {bad ? (
        <Typography variant="code" sx={{ fontSize: 10, color: u.needsAuth ? 'warning.main' : 'text.disabled' }}>
          {u.needsAuth ? 'sign in →' : (u.error || 'unavailable')}
        </Typography>
      ) : (
        <Stack spacing={0.4}>
          <Meter label="5h" win={u.session} segments={5} windowMs={5 * 3.6e6} />
          <Meter label="7d" win={u.weekly} segments={7} windowMs={7 * 24 * 3.6e6} />
          {/* Extra usage ($ overage): monthly budget, not a rolling window → no ticks.
              Keeps the rail non-empty once plan windows null out on overage. */}
          {u.extra?.enabled && u.extra.pctUsed != null && (
            <Meter label="$" win={u.extra} segments={1} />
          )}
        </Stack>
      )}
    </Box>
  );
}
