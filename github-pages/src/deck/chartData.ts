// Source L933 (seed), L1576-1577 (per-tick push/shift). A plain mutable
// module-level array — same shape as the source's module-level `chartData`
// — plus a tiny pub/sub so `useUsageChart` can redraw whenever it changes,
// and so a tab switch to "usage" (source L904: `requestAnimationFrame(drawChart)`)
// can ask for a redraw without owning a reference to the canvas.

import { clamp } from '../lib/math';
import { seedChartData } from './data';

export const chartData: number[] = seedChartData(48);

const listeners = new Set<() => void>();

export function subscribeChartData(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Explicit redraw request with no accompanying data change — used for the
 *  tab-switch-to-usage case (source L904) and the world's relayout signal is
 *  handled separately, via appStore's onRelayout, in useUsageChart. */
export function requestChartRedraw(): void {
  listeners.forEach((cb) => cb());
}

/** One 260ms-tick's worth of chart movement (source L1576-1577). Unconditional
 *  — the source mutates chartData every tick regardless of whether the usage
 *  view is visible; only the draw itself is gated (see useUsageChart). */
export function pushChartSample(): void {
  const last = chartData[chartData.length - 1] ?? 0;
  chartData.push(clamp(last + (Math.random() - 0.5) * 9, 18, 72));
  chartData.shift();
  requestChartRedraw();
}
