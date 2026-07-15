import React from 'react';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import Tooltip from '@mui/material/Tooltip';
import { useTheme } from '@mui/material/styles';
import { PROVIDERS, fmtReset, meterColor } from './usageUtil.js';

// One 5h/7d bar: label · track · pct.
function Meter({ label, win }) {
  const t = useTheme();
  const pct = win?.pctUsed;
  return (
    <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
      <Typography variant="code" sx={{ width: 16, fontSize: 10, color: 'text.secondary' }}>{label}</Typography>
      <Box sx={(th) => ({ flex: 1, height: 5, borderRadius: 3, bgcolor: th.vars.palette.glass.stroke, overflow: 'hidden' })}>
        <Box sx={{ width: `${Math.min(100, pct ?? 0)}%`, height: '100%', bgcolor: meterColor(t, pct), transition: 'width .3s' }} />
      </Box>
      <Typography variant="code" sx={{ width: 34, textAlign: 'right', fontSize: 10, color: 'text.secondary' }}>
        {pct == null ? '—' : `${Math.round(pct)}%`}
      </Typography>
    </Stack>
  );
}

function ProviderRow({ label, u }) {
  if (!u) return (
    <Box><Typography variant="code" sx={{ fontSize: 11, color: 'text.secondary' }}>{label}: …</Typography></Box>
  );
  const bad = !u.ok;
  return (
    <Box>
      <Stack direction="row" spacing={0.75} sx={{ mb: 0.25, alignItems: 'center' }}>
        <Typography sx={{ fontSize: 11, fontWeight: 600 }}>{label}</Typography>
        {u.plan && <Typography variant="code" sx={{ fontSize: 9, px: 0.5, borderRadius: 1, bgcolor: 'action.selected', color: 'text.secondary', textTransform: 'capitalize' }}>{u.plan}</Typography>}
        <Box sx={{ flex: 1 }} />
        {!bad && u.weekly?.resetsAt && (
          <Typography variant="code" sx={{ fontSize: 9, color: 'text.secondary' }}>7d {fmtReset(u.weekly.resetsAt)}</Typography>
        )}
      </Stack>
      {bad ? (
        <Typography variant="code" sx={{ fontSize: 10, color: u.needsAuth ? 'warning.main' : 'text.disabled' }}>
          {u.needsAuth ? 'sign in →' : (u.error || 'unavailable')}
        </Typography>
      ) : (
        <Stack spacing={0.4}>
          <Meter label="5h" win={u.session} />
          <Meter label="7d" win={u.weekly} />
        </Stack>
      )}
    </Box>
  );
}

// Compact sidebar usage indicator (expanded rail only). Click opens the Usage
// view and forces a refresh.
export default function UsagePill({ usage, onOpen }) {
  return (
    <Tooltip title="Usage — click for details" placement="right" disableInteractive>
      <Box
        onClick={onOpen}
        sx={(t) => ({
          cursor: 'pointer', px: 1.25, py: 1, borderRadius: `${t.zapac.radius.sm}px`,
          border: `1px solid ${t.vars.palette.glass.stroke}`,
          '&:hover': { borderColor: t.vars.palette.text.disabled },
        })}
      >
        <Stack spacing={1}>
          {PROVIDERS.map((p) => <ProviderRow key={p.key} label={p.label} u={usage?.[p.key]} />)}
        </Stack>
      </Box>
    </Tooltip>
  );
}
