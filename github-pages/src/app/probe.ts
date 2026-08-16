// Capability probe, ported from the one-shot's entry gate (source L1653-1666).
//
// This module must NEVER import `three` (directly or transitively). It runs on
// every load, including in flat mode, where the whole point is that the ~600 KB
// Three.js chunk is never fetched.

import { NARROW } from '../lib/env';
import type { Mode } from '../world/types';

/**
 * Decides the starting mode BEFORE the first paint.
 *
 * Must be called from a lazy `useState` initializer, not an effect: `body.booting
 * #scroll .chapter { visibility: hidden }` (source L119) hides the entire deck
 * while loading, so starting at 'loading' and only then discovering the viewport
 * is narrow would flash a blank page at every mobile visitor.
 *
 * Source order is preserved — WebGL2 first (L1654), then the narrow-viewport
 * gate (L1656) — because a narrow device without WebGL2 should report the more
 * specific failure.
 */
export function probeInitialMode(): Mode {
  if (!window.WebGL2RenderingContext) return 'error';

  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl2');
  if (!gl) return 'error';

  // The source leaks this probe context on every load. Browsers cap live WebGL
  // contexts (~16 in Chrome) and a lost one still counts until released, so a
  // few HMR cycles would exhaust the pool and make the NEXT getContext('webgl2')
  // return null — which this very function would then report as "no WebGL2".
  gl.getExtension('WEBGL_lose_context')?.loseContext();

  // Deliberate, not a limitation: below 900px the deck's own max-width:720px
  // rules stack every layout, making each screen 3-6x taller than wide, and no
  // square-on framing keeps that readable. The flat deck is the better
  // composition there and is a complete experience.
  if (NARROW) return 'flat';

  return 'loading';
}
