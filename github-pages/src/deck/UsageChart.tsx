// The `<canvas id="usageChart">` (source L936 / cockpit UsageView) plus the
// ref wiring for useUsageChart.ts.

import { useRef } from 'react';
import { useUsageChart } from './useUsageChart';

export function UsageChart() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  useUsageChart(canvasRef);
  return <canvas id="usageChart" ref={canvasRef} aria-label="Fleet token usage trend" />;
}
