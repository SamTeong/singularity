// Ported from docs/one-shot/3d/sample-gitlab-3d-scan.html, source lines 739-742.

export const pad = (n: number): string => String(n).padStart(2, '0');

export const clamp = (v: number, a: number, b: number): number => Math.min(b, Math.max(a, v));

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

// Frame-rate-independent exponential smoothing. Keep the 1 - exp(-l*dt) form
// exactly — it is what makes the damping rate `l` independent of frame rate.
export const damp = (c: number, t: number, l: number, dt: number): number =>
  c + (t - c) * (1 - Math.exp(-l * dt));

// Smootherstep (6t⁵ − 15t⁴ + 10t³). Zero velocity AND zero acceleration at both
// ends, so motion lingers at the start and end of a transition — the camera
// leaves and arrives almost stationary, which reads as a short pause on each
// slide rather than a pass-through. Used by scrollGlide for every "go to slide"
// hop (autoplay + manual nav).
export const easeInOut = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10);
