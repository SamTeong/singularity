import React from 'react';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { Meter } from './Meter.jsx';

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
          <Meter size="sm" label="5h" win={u.session} segments={5} windowMs={5 * 3.6e6} />
          <Meter size="sm" label="7d" win={u.weekly} segments={7} windowMs={7 * 24 * 3.6e6} />
          {/* Extra usage ($ overage): monthly budget, not a rolling window → no ticks.
              Keeps the rail non-empty once plan windows null out on overage. */}
          {u.extra?.enabled && u.extra.pctUsed != null && (
            <Meter size="sm" label="$" win={u.extra} segments={1} />
          )}
        </Stack>
      )}
    </Box>
  );
}
