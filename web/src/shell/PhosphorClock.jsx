/**
 * PhosphorClock — a lightweight seven-segment wall clock for the Phosphor
 * masthead, replacing the vendored `SevenSegClock`.
 *
 * The vendored component's `useNow()` hook fires `setInterval(..., 500)` and
 * calls `setState` twice per tick (once for `now`, once for a `tick` boolean
 * that drives the colon blink). That's ~120 React re-renders/minute of an
 * SVG-heavy component mounted permanently in the masthead, and each render
 * cascades through the Phosphor theme's heavy component-override style
 * recalculation — a continuous, visible cost on every Phosphor page
 * (particularly the wiki, where it competed with Cytoscape for main-thread
 * time). This replacement cuts that to the minimum:
 *
 *   - 1 Hz tick (only when the displayed seconds value actually changes —
 *     at most one render/second, half the vendored rate).
 *   - CSS keyframe colon blink (`nervBlink`, already registered globally by
 *     the vendored `cssBaseline`) — zero React state for blinking, so the
 *     1 Hz render carries no `tick` state at all.
 *   - Pauses the interval when `document.hidden` (Page Visibility API) — no
 *     renders at all when the tab is in the background.
 *   - Honors `prefers-reduced-motion`: holds the colons lit (the same
 *     contract the vendored components follow).
 *
 * The segment geometry (SEGMAP/SEGPTS) is static data copied from the
 * vendored `clock.tsx` — it's not theme code, so this doesn't modify the
 * vendored tarball (design.md D2). Colors read `theme.nerv.hue.*` exactly as
 * the vendored component does, so the visual output is identical.
 */
import { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import { useTheme } from '@mui/material/styles';

const SEGMAP = {
  0: 'abcdef', 1: 'bc', 2: 'abged', 3: 'abgcd', 4: 'fgbc',
  5: 'afgcd', 6: 'afgedc', 7: 'abc', 8: 'abcdefg', 9: 'abcfgd',
};
const SEGPTS = {
  a: '7,4 10.5,0.5 29.5,0.5 33,4 29.5,7.5 10.5,7.5',
  b: '36,7 39.5,10.5 39.5,27.5 36,31 32.5,27.5 32.5,10.5',
  c: '36,33 39.5,36.5 39.5,53.5 36,57 32.5,53.5 32.5,36.5',
  d: '7,60 10.5,56.5 29.5,56.5 33,60 29.5,63.5 10.5,63.5',
  e: '4,33 7.5,36.5 7.5,53.5 4,57 0.5,53.5 0.5,36.5',
  f: '4,7 7.5,10.5 7.5,27.5 4,31 0.5,27.5 0.5,10.5',
  g: '7,32 10.5,28.5 29.5,28.5 33,32 29.5,35.5 10.5,35.5',
};

const pad2 = (n) => String(n).padStart(2, '0');
const reducedMotion = () =>
  typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

function Digit({ value, w, h, on, off, glow }) {
  const lit = SEGMAP[value] ?? '';
  return (
    <svg width={w} height={h} viewBox="0 0 46 64" style={glow ? { filter: 'drop-shadow(0 0 3px rgba(242,100,0,.85)) drop-shadow(0 0 8px rgba(242,100,0,.4))' } : undefined}>
      {'abcdefg'.split('').map((k) => (
        <polygon key={k} points={SEGPTS[k]} transform="translate(6,0) skewX(-6)" fill={lit.includes(k) ? on : off} />
      ))}
    </svg>
  );
}

/**
 * A 1 Hz, visibility-aware wall clock rendering the vendored `countdown`
 * variant's glowing orange seven-segment readout (HH:MM:SS). Colons blink
 * via the global `nervBlink` CSS keyframe (registered by the Phosphor
 * `CssBaseline`), not React state — so the only re-render is once per
 * second when the digits actually change, and never when the tab is hidden.
 *
 * @param {Object} props
 * @param {import('@mui/material/styles').SxProps} [props.sx]
 */
export default function PhosphorClock({ sx }) {
  const t = useTheme();
  const [digits, setDigits] = useState(() => {
    const d = new Date();
    return (pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds())).split('').map(Number);
  });

  useEffect(() => {
    let id;
    const tick = () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      const d = new Date();
      setDigits((pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds())).split('').map(Number));
    };
    // Align to the next second boundary, then tick every 1000ms. A naive
    // `setInterval(fn, 1000)` started mid-second drifts; aligning first
    // keeps the readout within ~1ms of the wall clock.
    const untilNext = 1000 - (Date.now() % 1000);
    const startup = setTimeout(() => {
      tick();
      id = setInterval(tick, 1000);
    }, untilNext);
    const onVisibility = () => { if (!document.hidden) tick(); };
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearTimeout(startup);
      if (id) clearInterval(id);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  const reduced = reducedMotion();
  const colonStyle = reduced
    ? { opacity: 1 }
    : { animation: 'nervBlink 1000ms steps(1, jump-none) infinite' };

  return (
    <Box sx={[{ display: 'flex', alignItems: 'center', gap: '4px' }, ...(Array.isArray(sx) ? sx : [sx])]}>
      {digits.map((d, i) => (
        <Box key={i} sx={{ display: 'contents' }}>
          <Digit value={d} w={20} h={30} on={t.nerv.hue.orange} off="rgba(242,100,0,.07)" glow />
          {(i === 1 || i === 3) && (
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: '6px', mx: '1px', ...colonStyle }}>
              <Box sx={{ width: 4, height: 4, background: t.nerv.hue.orange, boxShadow: `0 0 4px ${t.nerv.hue.orange}` }} />
              <Box sx={{ width: 4, height: 4, background: t.nerv.hue.orange, boxShadow: `0 0 4px ${t.nerv.hue.orange}` }} />
            </Box>
          )}
        </Box>
      ))}
    </Box>
  );
}