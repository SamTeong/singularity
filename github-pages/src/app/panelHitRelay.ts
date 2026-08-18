// Chromium will not hit-test some CSS3D panels, and this relays their clicks.
//
// Measured with `document.elementsFromPoint` over the centre of every panel
// (viewport 1440x900, one chapter at a time via the rail):
//
//   #chaos  #tasks  #system-design  #take-control  #stats  → the panel and its subtree are hit
//   #orientation  #agent-harness  #fleet-control  #credits   → `#gl` comes back instead, always
//
// The split follows the panel's world matrix, not its content. CSS3DRenderer
// writes `matrix3d(...)` per panel, and the ones that fail are the ones whose
// yaw is near 90° or 270° — so cos(yaw) ~ 0 makes the matrix's 2D part
// [[m11,m21],[m12,m22]] near-singular (det 4.5e-6 for #orientation, 0 for #fleet-control,
// against 9.1e-6 for #take-control, which works). No pointer-events / overflow /
// preserve-3d / perspective combination changes that; it is Chromium giving up
// on inverting the transform, and nothing on our side of it can help.
//
// `getBoundingClientRect()` is still correct on those panels, so rather than a
// transparent proxy element per control (the `.sx-cta` approach, which needs a
// per-frame rect write each and does not scale past one button) this relays the
// click that the canvas DID receive: find the smallest visible in-panel control
// whose rect contains the point, and click it. One listener, no per-frame work,
// nothing added to the composition. It covers every control in every panel —
// the orientation anchors, the six agent-harness buttons, the four fleet-control tabs,
// the session/task rows and the credits source link — and is inert for the panels
// Chromium hit-tests itself, because there the click never reaches the canvas.
//
// The rects are the axis-aligned bounds of a 3D-transformed quad, so they are
// exact only while the panel faces the camera. It always does — the camera
// parks on the panel's own normal — and pointer parallax skews it by a few
// pixels at most.

import { useEffect } from 'react';

const CONTROLS = 'a[href], button';

/** `:hover` cannot be forced from script, so the relay marks its pick with this
 *  class and the four affected rules match `:is(:hover, .hit-hover)`. Without it
 *  a control in one of those panels stays visually inert while the pointer is on
 *  it — which reads as "not clickable", the same bug in a quieter form. */
const HOVER_CLASS = 'hit-hover';

/** Panels mid-fade are still in the DOM at full size; only the one the camera
 *  is parked at should take clicks. */
const MIN_PANEL_OPACITY = 0.5;

function pick(x: number, y: number): HTMLElement | null {
  let best: HTMLElement | null = null;
  let bestArea = Infinity;

  for (const panel of document.querySelectorAll<HTMLElement>('#css3d .chapter.as-panel')) {
    if (panel.style.display === 'none') continue;
    if (Number(panel.style.opacity || '1') < MIN_PANEL_OPACITY) continue;
    const pr = panel.getBoundingClientRect();
    if (x < pr.left || x > pr.right || y < pr.top || y > pr.bottom) continue;

    for (const el of panel.querySelectorAll<HTMLElement>(CONTROLS)) {
      if (el.matches(':disabled')) continue;
      const r = el.getBoundingClientRect();
      // A control inside an inactive tabpanel is display:none, so a zero rect
      // is the whole hidden-subtree test.
      if (r.width === 0 || r.height === 0) continue;
      if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
      // Smallest wins: controls nest (a button inside a card inside a link),
      // and the innermost one is what the pointer is aiming at.
      const area = r.width * r.height;
      if (area < bestArea) {
        bestArea = area;
        best = el;
      }
    }
  }
  return best;
}

/** The canvas is the only element these clicks can land on, so it is also the
 *  only place the relay has to listen — and using it as the gate means flat
 *  mode (no canvas) and a webglcontextlost demotion both switch the relay off
 *  without a mode flag of their own. */
function isCanvas(target: EventTarget | null): target is HTMLCanvasElement {
  return target instanceof HTMLCanvasElement && target.id === 'gl';
}

export function usePanelHitRelay(): void {
  useEffect(() => {
    let hovered: HTMLElement | null = null;
    const setHover = (el: HTMLElement | null): void => {
      if (el === hovered) return;
      hovered?.classList.remove(HOVER_CLASS);
      el?.classList.add(HOVER_CLASS);
      hovered = el;
    };

    const onClick = (e: MouseEvent): void => {
      if (!isCanvas(e.target)) return;
      pick(e.clientX, e.clientY)?.click();
    };
    const onMove = (e: MouseEvent): void => {
      if (!isCanvas(e.target)) {
        // The pointer moved onto the HUD or a panel Chromium hit-tests itself,
        // where the real :hover takes over.
        setHover(null);
        return;
      }
      const hit = pick(e.clientX, e.clientY);
      setHover(hit);
      e.target.style.cursor = hit ? 'pointer' : '';
    };
    // Two ways to leave a marked control without a mousemove over the canvas:
    // the pointer exits the window, or the camera travels to the next chapter
    // under a stationary pointer. Both would otherwise strand the class.
    const clear = (): void => setHover(null);

    document.addEventListener('click', onClick);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseleave', clear);
    window.addEventListener('scroll', clear, { passive: true });
    return () => {
      document.removeEventListener('click', onClick);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseleave', clear);
      window.removeEventListener('scroll', clear);
      clear();
    };
  }, []);
}
