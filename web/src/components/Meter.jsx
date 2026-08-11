import { getTokens, getRoles } from '@/theme/contract.js';
import { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { useTheme } from '@mui/material/styles';
import { meterColor, segTicks, fmtReset } from '@/lib/usageUtil.js';

// ponytail: the "now" marker teal isn't in the zapac palette (checked cmTheme.js
// + the @zapac/mui-theme palette — no clean extension point for a one-off
// accent), so it stays one shared literal here instead of two.
const NOW_MARKER = '#2dd4bf';

// A framed skin (Phosphor) has its own hard-edged, semantic palette; ZAPAC is
// the glass default. Same discriminator `shellStyles.glass()` uses.
const isFramed = (th) => !!getRoles(th).shell?.frameBorderWidth;

const fmtWall = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
};

// Usage meter: fill + segment ticks + a "now" marker at the current point in
// the rolling window. size="sm" (UsagePill, collapsed rail) is a compact
// label/track/pct row; size="lg" (UsageView, main pane) is a labeled block
// with the %-used/reset line, wall-clock reset time, and per-model breakdown
// below the track.
export function Meter({ size = 'lg', label, win, segments, windowMs, dp = 0 }) {
  const t = useTheme();
  // "Now" marker position needs the current wall-clock time, which can't be read
  // impurely during render — subscribe to the system clock instead (ticks are
  // coarse; the marker only needs to be roughly right).
  const [now, setNow] = useState(() => Date.now());
  // Only tick the clock when a "now" marker will actually be rendered — most
  // Meter instances (no windowMs/resetsAt) never read `now` at all.
  const needsNow = !!(windowMs && win?.resetsAt);
  useEffect(() => {
    if (!needsNow) return;
    const id = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(id);
  }, [needsNow]);
  if (size === 'lg' && !win) return null;
  const pct = win?.pctUsed;
  // "Now" marker: track spans the rolling window ending at resetsAt, so now
  // sits at (1 - remaining/windowMs) from the left. Clamp to keep it on track.
  const nowPct = needsNow
    ? Math.min(100, Math.max(0, (1 - (new Date(win.resetsAt).getTime() - now) / windowMs) * 100))
    : null;
  const sm = size === 'sm';

  const track = (
    <Box sx={{ position: 'relative', flex: sm ? 1 : undefined }}>
      <Box sx={(th) => ({
        position: 'relative',
        height: sm ? 5 : 10,
        // Hard edge under a framed skin — a pill track reads as a ZAPAC leftover.
        borderRadius: isFramed(th) ? 0 : (sm ? 3 : 5),
        // The EMPTY part of the bar. Under ZAPAC `glass.stroke` is a barely-there
        // hairline, so an unfilled track reads as empty. Under Phosphor that same
        // token is SAFETY ORANGE, which (a) uses orange as a data surface, which
        // design.md D4 reserves for chrome, and (b) made every provider look
        // maxed out — "Codex 0% used" rendered as a completely full orange bar.
        // `roles.chrome.track` is the skin's actual track hue.
        bgcolor: isFramed(th) ? getRoles(th).chrome.track : getTokens(th).glass.stroke,
        overflow: 'hidden',
      })}
      >
        <Box sx={{ width: `${Math.min(100, pct ?? 0)}%`, height: '100%', bgcolor: meterColor(t, pct), transition: 'width .3s' }} />
        {segments > 1 && (
          <Box sx={(th) => ({ position: 'absolute', inset: 0, pointerEvents: 'none', backgroundImage: segTicks(th.vars.palette.background.paper, segments) })} />
        )}
      </Box>
      {/* Marker sits outside the clipped track so it can overhang top/bottom. */}
      {nowPct != null && (
        // The teal literal is off-palette for Phosphor (its hues are mint/blue/
        // amber/red/orange); use the console's bright neutral there instead.
        <Box sx={(th) => ({ position: 'absolute', top: sm ? -2.5 : -3, bottom: sm ? -2.5 : -3, left: `${nowPct}%`, width: sm ? 1.5 : 2, ml: sm ? '-0.75px' : '-1px', borderRadius: isFramed(th) ? 0 : 1, bgcolor: isFramed(th) ? th.nerv.hue.paper : NOW_MARKER, pointerEvents: 'none' })} />
      )}
    </Box>
  );

  if (sm) {
    return (
      <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
        {/* `minWidth`, not `width`. UsagePill's labels ("5h", "7d", "$") are
            narrower than 16px so they still occupy the same 16px box as before,
            but the sidebar rail passes provider names ("CLAUDE", "OLLAMA"),
            which a fixed 16px box cannot hold — they overflowed and were
            overlapped by the track. `nowrap` stops them wrapping instead. */}
        <Typography variant="code" sx={{ minWidth: 16, flex: 'none', whiteSpace: 'nowrap', fontSize: 10, color: 'text.secondary' }}>{label}</Typography>
        {track}
        <Typography variant="code" sx={{ width: 34, textAlign: 'right', fontSize: 10, color: 'text.secondary' }}>
          {pct == null ? '—' : `${Math.round(pct)}%`}
        </Typography>
      </Stack>
    );
  }

  return (
    <Box>
      <Typography sx={{ fontSize: 13, mb: 0.5 }}>{label}</Typography>
      {track}
      <Typography variant="code" sx={{ display: 'block', fontSize: 12, color: 'text.secondary', mt: 0.5 }}>
        {pct == null ? '—' : `${pct.toFixed(dp)}% used`}{win.resetsAt ? ` · resets in ${fmtReset(win.resetsAt)}` : ''}
      </Typography>
      {win.resetsAt && (
        <Typography variant="code" sx={{ display: 'block', fontSize: 10, color: 'text.disabled' }}>{fmtWall(win.resetsAt)}</Typography>
      )}
      {win.models?.length > 0 && (
        <Stack direction="row" spacing={1} sx={{ mt: 0.5, flexWrap: 'wrap' }}>
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
