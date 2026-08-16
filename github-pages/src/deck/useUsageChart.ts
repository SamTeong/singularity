// Source L931-976. Sizing rule for every canvas/geometry read anywhere in
// src/deck/: use `offsetWidth`/`offsetHeight`, never `getBoundingClientRect()`.
// Once the cockpit section is mounted as a CSS3DObject (Phase 4), an
// ancestor carries a `matrix3d` transform, and getBoundingClientRect() would
// return the CSS3D-projected screen bounds — which change every frame and
// collapse toward zero at oblique camera angles. offsetWidth/offsetHeight
// are layout-box geometry and are transform-independent. The source
// comments this at L931-932; that comment (and this rule) carries across
// the whole directory.

import { useEffect } from 'react';
import type { RefObject } from 'react';
import { chartData } from './chartData';
import { subscribeChartData } from './chartData';
import { onRelayout } from '../state/appStore';

function drawChart(canvas: HTMLCanvasElement): void {
  const view = canvas.closest('.view') as HTMLElement | null;
  if (view && view.hidden) return; // source L937-938
  const W = canvas.offsetWidth;
  const H = canvas.offsetHeight;
  if (!W || !H) return;

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  ctx.strokeStyle = 'rgba(36,108,60,.55)';
  ctx.lineWidth = 1;
  for (let y = H * 0.25; y < H; y += H * 0.25) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
    ctx.stroke();
  }

  ctx.fillStyle = 'rgba(60,156,108,.55)';
  for (let x = 26; x < W; x += 56) {
    for (let y = 28; y < H; y += 72) ctx.fillRect(x, y, 1.5, 1.5);
  }

  const pts: Array<[number, number]> = chartData.map((v, i) => [
    (i / (chartData.length - 1)) * W,
    H - (v / 80) * H,
  ]);

  const gradient = ctx.createLinearGradient(0, 0, 0, H);
  gradient.addColorStop(0, 'rgba(82,242,154,.3)');
  gradient.addColorStop(1, 'rgba(82,242,154,0)');
  ctx.beginPath();
  ctx.moveTo(0, H);
  pts.forEach(([x, y]) => ctx.lineTo(x, y));
  ctx.lineTo(W, H);
  ctx.closePath();
  ctx.fillStyle = gradient;
  ctx.fill();

  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.strokeStyle = '#52F29A';
  ctx.lineWidth = 2;
  ctx.shadowColor = '#52F29A';
  ctx.shadowBlur = 6;
  ctx.stroke();
  ctx.shadowBlur = 0;

  const [lx, ly] = pts[pts.length - 1];
  ctx.fillStyle = '#7CF4AB';
  ctx.beginPath();
  ctx.arc(lx - 2, ly, 4, 0, Math.PI * 2);
  ctx.fill();
}

/** Mounts the chart's redraw wiring on `canvasRef`. Redraws on: every
 *  chartData mutation or explicit redraw request (chartData.ts's shared
 *  bus — covers both the 260ms tick and the tab-switch-to-usage rAF call),
 *  appStore's onRelayout (the world's buildPanels()/onResize(), which never
 *  fire a window resize event), and a real window `resize` (which is what
 *  covers flat mode, where nothing ever calls emitRelayout()). */
export function useUsageChart(canvasRef: RefObject<HTMLCanvasElement | null>): void {
  useEffect(() => {
    const redraw = () => {
      if (canvasRef.current) drawChart(canvasRef.current);
    };
    redraw();
    const offChartData = subscribeChartData(redraw);
    const offRelayout = onRelayout(redraw);
    window.addEventListener('resize', redraw);
    return () => {
      offChartData();
      offRelayout();
      window.removeEventListener('resize', redraw);
    };
  }, [canvasRef]);
}
