import Box from '@mui/material/Box';
import { useTheme } from '@mui/material/styles';

// Hub-and-spoke brand mark: one gradient daemon hub, six radiating agent nodes.
// Spokes/nodes take a theme-following neutral; the gradient is reserved to the
// hub (identity). `active` pulses a radar-ping halo when any agent is running.
const LOGO_NODES = [-90, -30, 30, 90, 150, 210].map((a) => {
  const r = (a * Math.PI) / 180;
  return [+(16 + 11 * Math.cos(r)).toFixed(2), +(16 + 11 * Math.sin(r)).toFixed(2)];
});

export default function Logo({ active }) {
  const t = useTheme();
  const line = t.vars.palette.text.secondary;
  const nodeFill = t.vars.palette.background.default;
  return (
    <Box
      component="svg"
      viewBox="0 0 32 32"
      role="img"
      aria-label="Singularity"
      sx={{ width: 30, height: 30, flexShrink: 0, filter: 'drop-shadow(0 0 5px rgba(152,91,156,0.55))' }}
    >
      <defs>
        <linearGradient id="sing-grad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#aa41af" />
          <stop offset="55%" stopColor="#3c69c8" />
          <stop offset="100%" stopColor="#00a5e6" />
        </linearGradient>
      </defs>
      {LOGO_NODES.map(([x, y], i) => (
        <line key={`s${i}`} x1="16" y1="16" x2={x} y2={y} stroke={line} strokeWidth="1.2" strokeLinecap="round" />
      ))}
      {active && (
        <Box
          component="circle"
          cx="16" cy="16" r="3" fill="url(#sing-grad)"
          sx={{
            transformBox: 'fill-box', transformOrigin: 'center',
            animation: 'sing-ping 2s cubic-bezier(0,0,0.2,1) infinite',
            '@keyframes sing-ping': { '0%': { transform: 'scale(1)', opacity: 0.5 }, '70%,100%': { transform: 'scale(2.6)', opacity: 0 } },
            '@media (prefers-reduced-motion: reduce)': { animation: 'none', opacity: 0 },
          }}
        />
      )}
      <circle cx="16" cy="16" r="5.2" fill="none" stroke="url(#sing-grad)" strokeWidth="1.4" />
      <circle cx="16" cy="16" r="3" fill="url(#sing-grad)" />
      {LOGO_NODES.map(([x, y], i) => (
        <circle key={`n${i}`} cx={x} cy={y} r="2.4" fill={nodeFill} stroke={line} strokeWidth="1.3" />
      ))}
    </Box>
  );
}
