import Box from '@mui/material/Box';

// Inline-SVG sparkline over a 0-100 value series: faint 25/50/75 grid (behind),
// a dotted 90% threshold line, then the data polyline on top. Values are
// percentages, so the y-scale is fixed 0-100 (grid + threshold read absolutely).
const SPARK_Y = (p, h) => h - (p / 100) * h; // pct -> svg y

// `capacity` = full sample count for the selected window, so the x-axis spans
// the whole window even when under-filled: newest sample sits at the right edge,
// older ones step left, leaving blank space on the left until data accumulates.
export default function Sparkline({ values, color, capacity, width = 180, height = 44 }) {
  const cap = Math.max(capacity || values.length, 2);
  const n = values.length;
  const points = n >= 2
    ? values.map((v, i) => `${width * (1 - (n - 1 - i) / (cap - 1))},${SPARK_Y(Math.min(100, Math.max(0, v)), height)}`).join(' ')
    : '';
  const refY = SPARK_Y(90, height);
  return (
    <Box component="svg" viewBox={`0 0 ${width} ${height}`} width={width} height={height} sx={{ display: 'block', overflow: 'visible' }}>
      {/* Grid — horizontal at 25/50/75%, vertical at width quarters (~7.5-min marks over 30 min). */}
      {[25, 50, 75].map((p) => (
        <line key={`h${p}`} x1={0} y1={SPARK_Y(p, height)} x2={width} y2={SPARK_Y(p, height)} stroke="var(--mui-palette-divider)" strokeWidth={0.5} />
      ))}
      {[0.25, 0.5, 0.75].map((f) => (
        <line key={`v${f}`} x1={f * width} y1={0} x2={f * width} y2={height} stroke="var(--mui-palette-divider)" strokeWidth={0.5} />
      ))}
      {/* 90% threshold. */}
      <line x1={0} y1={refY} x2={width} y2={refY} stroke="var(--mui-palette-warning-main)" strokeWidth={0.75} strokeDasharray="3 2" opacity={0.8} />
      <text x={width} y={refY - 2} textAnchor="end" fontSize={8} fill="var(--mui-palette-warning-main)" opacity={0.9}>90%</text>
      {points && (
        <polyline
          points={points}
          fill="none"
          stroke={color}
          strokeWidth={1.5}
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      )}
    </Box>
  );
}
