// Makes in-panel controls clickable when Chromium refuses to hit-test them.
//
// THE PROBLEM, measured. Once CSS3DRenderer has scaled a panel by
// chapter.w / chapter.px (~0.004), Chromium's hit-testing on that subtree is
// unreliable — and it is unreliable PER PANEL, not per element. Probing
// elementFromPoint at the centre of a control:
//
//    cockpit TASKS tab   -> BUTTON.tab   (works, click lands)
//    pipeline card       -> CANVAS       (fails, click hits the WebGL canvas)
//    hero GET STARTED    -> CANVAS       (fails; see chrome.css, hit 0/49)
//
// No pointer-events / overflow / preserve-3d / perspective combination changes
// it (chrome.css documents that dead end). The shipped workaround was one
// hand-placed HUD proxy for the hero's single button, which does not scale to a
// ten-card gallery.
//
// THE FIX. Stop asking the DOM where the pointer is and do the geometry
// ourselves. Each panel is a known rectangle at a known position and
// orientation, so a ray from the camera through the pointer can be intersected
// with it analytically, converted back into the panel's own CSS pixel space, and
// matched against the offset rectangles of its focusable descendants. Three.js
// math replaces Chromium's hit test, so it cannot be flaky.
//
// WHY THIS NEVER DOUBLE-FIRES. The listener is on the CANVAS, not the window.
// When Chromium's own hit-testing succeeds, the click's target is the button
// inside #css3d — which is not a descendant of the canvas, so this listener is
// never called and the native activation stands alone. It only runs in exactly
// the case where the click leaked through to the canvas, which is the broken
// case. That is the whole guard, and it is why no "already handled" flag is
// needed.
import * as THREE from 'three';
import type { Panel } from './panels';

/** What a click may activate. Deliberately narrow: real controls only, so a
 *  stray click on body copy does nothing rather than something surprising. */
const INTERACTIVE = 'button, a[href], [role="tab"], input, select, textarea, summary';

export interface HitBridge {
  dispose(): void;
}

/** Accumulates an element's offset position relative to `root`.
 *
 *  getBoundingClientRect is unusable here — every rect inside the panel is
 *  already through the CSS3D matrix, which is what we are trying to undo. Offset
 *  geometry is in the panel's own untransformed pixel space, which is exactly
 *  the space the ray has been converted into. The section is position:absolute
 *  (CSS3DObject sets that), so it is a valid offsetParent chain terminus. */
function offsetWithin(el: HTMLElement, root: HTMLElement): { x: number; y: number; w: number; h: number } | null {
  let x = 0;
  let y = 0;
  let node: HTMLElement | null = el;
  // Bounded walk: a malformed chain must not spin, and must not silently
  // report coordinates measured against the wrong origin.
  for (let guard = 0; node && node !== root && guard < 64; guard++) {
    x += node.offsetLeft;
    y += node.offsetTop;
    node = node.offsetParent as HTMLElement | null;
  }
  if (node !== root) return null;
  return { x, y, w: el.offsetWidth, h: el.offsetHeight };
}

export function createHitBridge(
  canvas: HTMLCanvasElement,
  camera: THREE.PerspectiveCamera,
  getPanels: () => Panel[],
): HitBridge {
  const ndc = new THREE.Vector2();
  const raycaster = new THREE.Raycaster();
  const centre = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const right = new THREE.Vector3();
  const up = new THREE.Vector3();
  const hit = new THREE.Vector3();
  const delta = new THREE.Vector3();

  function onClick(event: MouseEvent): void {
    ndc.set((event.clientX / innerWidth) * 2 - 1, -(event.clientY / innerHeight) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);

    let best: { el: HTMLElement; area: number; dist: number } | null = null;

    for (const panel of getPanels()) {
      // Only what the reader can actually see. `visible` and the inline display
      // are both written by updateWorld's relevance window every frame.
      if (!panel.group.visible || panel.el.style.display === 'none') continue;

      panel.group.getWorldPosition(centre);
      // The panel's own axes, including any pitch — the group's quaternion is
      // built with Euler order 'YXZ' in buildPanel for exactly this reason.
      normal.set(0, 0, 1).applyQuaternion(panel.group.quaternion);
      right.set(1, 0, 0).applyQuaternion(panel.group.quaternion);
      up.set(0, 1, 0).applyQuaternion(panel.group.quaternion);

      const facing = raycaster.ray.direction.dot(normal);
      if (Math.abs(facing) < 1e-6) continue; // ray parallel to the screen
      const t = delta.copy(centre).sub(raycaster.ray.origin).dot(normal) / facing;
      if (t <= 0) continue; // behind the camera

      hit.copy(raycaster.ray.origin).addScaledVector(raycaster.ray.direction, t);
      delta.copy(hit).sub(centre);
      const lx = delta.dot(right);
      const ly = delta.dot(up);
      const halfW = panel.chapter.w / 2;
      const halfH = panel.worldH / 2;
      if (Math.abs(lx) > halfW || Math.abs(ly) > halfH) continue;

      // World units -> the panel's own CSS pixels. Y flips: world up is +, CSS
      // down is +.
      const pw = panel.el.offsetWidth;
      const ph = panel.el.offsetHeight;
      const px = lx / panel.scale + pw / 2;
      const py = ph / 2 - ly / panel.scale;

      panel.el.querySelectorAll<HTMLElement>(INTERACTIVE).forEach((el) => {
        const r = offsetWithin(el, panel.el);
        if (!r || !r.w || !r.h) return;
        if (px < r.x || px > r.x + r.w || py < r.y || py > r.y + r.h) return;
        const area = r.w * r.h;
        // Smallest match wins, so a button inside a card beats the card, and a
        // nearer panel beats a further one behind it.
        if (!best || t < best.dist - 1e-3 || (Math.abs(t - best.dist) <= 1e-3 && area < best.area)) {
          best = { el, area, dist: t };
        }
      });
    }

    if (!best) return;
    // Focus first so the activated control shows its focus ring and screen
    // readers follow, then activate. `click()` runs the React handler.
    const target = (best as { el: HTMLElement }).el;
    target.focus?.();
    target.click();
  }

  canvas.addEventListener('click', onClick);
  return {
    dispose(): void {
      canvas.removeEventListener('click', onClick);
    },
  };
}
