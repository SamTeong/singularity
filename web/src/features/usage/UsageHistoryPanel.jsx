import { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import Collapse from '@mui/material/Collapse';
import Tabs from '@mui/material/Tabs';
import Tab from '@mui/material/Tab';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import TimelineIcon from '@mui/icons-material/Timeline';
import { LineChart } from '@mui/x-charts/LineChart';
import { useDrawingArea, useXScale, useYScale } from '@mui/x-charts/hooks';
import { stepTicks, firstTickOfEachLocalDate } from './stepTicks.mjs';

// Seconds between re-fetches; 'off' fetches only on open, tab change or view
// return. The daemon samples claude/codex every 5s and ollama every 60s, so a
// faster rate would only re-read the same points.
const RATES = ['off', '10', '30', '60'];

const hhmm = (d) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const hourLabel = (d) => `${d.getHours() % 12 || 12}${d.getHours() < 12 ? 'am' : 'pm'}`;
const dayLabel = (d) => `${d.toLocaleDateString([], { weekday: 'short' })} ${d.getDate()}`;
const HOUR = 3.6e6;
// Grid step per window: 5h every 30 min (labels on the hour), 7d every 6h (labels at local midnight).
const STEP = { '5h': HOUR / 2, '7d': 6 * HOUR };

// Highest total point; `>=` keeps the most recent on ties.
const peakPoint = (points) => points.reduce((best, p) => (!best || p.pct >= best.pct ? p : best), null);

// Dot + caption at the peak point. Flips below near the top edge and anchors inward near the side edges.
function PeakLabel({ point }) {
  const xs = useXScale();
  const ys = useYScale();
  const { left, top, width } = useDrawingArea();
  const x = xs(new Date(point.ts));
  const y = ys(point.pct);
  const text = `${Math.round(point.pct)}%`;
  const below = y - top < 20;
  const anchor = x - left < 20 ? 'start' : left + width - x < 20 ? 'end' : 'middle';
  return (
    <g data-testid="usage-peak">
      <circle cx={x} cy={y} r={3} style={{ fill: 'var(--mui-palette-primary-main)' }} />
      <text x={x} y={below ? y + 15 : y - 8} textAnchor={anchor} fontSize={11} style={{ fill: 'var(--mui-palette-text-primary)' }}>{text}</text>
    </g>
  );
}

// Current 5h or 7d window per provider (GET /api/usage/history). 5h: Claude/Codex
// stack an estimated per-session split; Ollama has no per-session data, so it is
// the account % line only. 7d is the account weekly % line for every provider.
// Polls only while open AND the Usage view is showing:
// the shell keeps this view mounted (hidden) across navigation.
export default function UsageHistoryPanel({ open, onToggle, active, providers }) {
  const [tab, setTab] = useState(providers[0]?.key ?? 'claude');
  const provider = providers.some((p) => p.key === tab) ? tab : providers[0]?.key;
  const [rate, setRate] = useState('10');
  const [win, setWin] = useState('5h');
  const [doc, setDoc] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!open || !active || !provider) return undefined;
    let alive = true;
    const load = () => fetch(`/api/usage/history?provider=${provider}${win === '7d' ? '&window=7d' : ''}`)
      .then((r) => r.json())
      .then((d) => { if (!alive) return; if (d.points) { setDoc(d); setError(null); } else setError(d.error || 'history unavailable'); })
      .catch((e) => alive && setError(e.message));
    load();
    // A backgrounded tab skips ticks; the next visible tick catches up.
    const id = rate === 'off' ? null : setInterval(() => { if (!document.hidden) load(); }, Number(rate) * 1000);
    return () => { alive = false; clearInterval(id); };
  }, [open, active, provider, rate, win]);

  const d = doc?.provider === provider && doc.window === win ? doc : null;
  const times = d?.points.map((p) => new Date(p.ts)) ?? [];
  const series = !d ? [] : d.estimated
    ? d.sessions.map((s) => ({ id: s.id, label: s.label, data: d.points.map((p) => p.sessions[s.id] ?? 0), area: true, stack: 'total', showMark: false, valueFormatter: (v) => `${v}%` }))
    : [{ id: 'total', label: `${win} %`, data: d.points.map((p) => p.pct), showMark: false, valueFormatter: (v) => `${v}%` }];
  const ticks = d ? stepTicks(new Date(d.windowStart).getTime(), new Date(d.resetsAt).getTime(), STEP[win]) : [];
  const dateLabelTicks = firstTickOfEachLocalDate(ticks);

  return (
    <Box>
      <Stack direction="row" spacing={1} useFlexGap sx={{ px: 3, py: 1.25, alignItems: 'center', flexWrap: 'wrap' }}>
        <IconButton
          size="small"
          onClick={onToggle}
          aria-label={`${open ? 'Collapse' : 'Expand'} ${win} history`}
          sx={{ transform: open ? 'rotate(0deg)' : 'rotate(-90deg)', transition: 'transform .2s' }}
        >
          <ExpandMoreIcon />
        </IconButton>
        <TimelineIcon sx={{ fontSize: 18, color: 'text.secondary' }} />
        <Typography variant="subtitle2" sx={{ flex: 1 }}>{win} history</Typography>
        <ToggleButtonGroup size="small" exclusive value={win} onChange={(_e, v) => v && setWin(v)} aria-label="History window">
          {Object.keys(STEP).map((w) => <ToggleButton key={w} value={w} sx={{ py: 0.25, px: 1, fontSize: 12 }}>{w}</ToggleButton>)}
        </ToggleButtonGroup>
        <ToggleButtonGroup size="small" exclusive value={rate} onChange={(_e, v) => v && setRate(v)} aria-label="History refresh interval">
          {RATES.map((r) => <ToggleButton key={r} value={r} sx={{ py: 0.25, px: 1, fontSize: 12 }}>{r === 'off' ? 'Off' : `${r}s`}</ToggleButton>)}
        </ToggleButtonGroup>
      </Stack>
      <Collapse in={open} unmountOnExit>
        <Box sx={{ px: 2, pb: 2 }}>
          <Tabs value={provider ?? false} onChange={(_e, v) => setTab(v)} sx={{ minHeight: 36, '& .MuiTab-root': { minHeight: 36, py: 0.5 } }}>
            {providers.map((p) => <Tab key={p.key} value={p.key} label={p.label} />)}
          </Tabs>
          {error && <Typography sx={{ py: 1, color: 'error.main', fontSize: 13 }}>{error}</Typography>}
          {!d ? (
            !error && <Typography sx={{ py: 2, fontSize: 13, color: 'text.secondary' }}>Loading…</Typography>
          ) : d.points.length === 0 ? (
            <Typography sx={{ py: 2, fontSize: 13, color: 'text.secondary' }}>No usage in the current {win} window yet.</Typography>
          ) : (
            <Box role="figure" aria-label={`${win} history chart`}>
              <LineChart
                height={260}
                series={series}
                xAxis={[{
                  data: times, scaleType: 'time', min: new Date(d.windowStart), max: new Date(d.resetsAt),
                  tickInterval: ticks,
                  tickLabelInterval: win === '7d' ? (v) => dateLabelTicks.has(v.getTime()) : (v) => v.getMinutes() === 0,
                  valueFormatter: win === '7d'
                    ? (v, ctx) => (ctx.location === 'tick' ? dayLabel(v) : `${dayLabel(v)} ${hhmm(v)}`)
                    : (v, ctx) => (ctx.location === 'tick' ? hourLabel(v) : hhmm(v)),
                }]}
                yAxis={[{ min: 0, max: 100, tickInterval: [0, 20, 40, 60, 80, 100], valueFormatter: (v) => `${v}%` }]}
                grid={{ horizontal: true, vertical: true }}
              >
                <PeakLabel point={peakPoint(d.points)} />
              </LineChart>
            </Box>
          )}
        </Box>
      </Collapse>
    </Box>
  );
}
