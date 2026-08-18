// Ported from docs/one-shot/3d/sample-gitlab-3d-scan.html, L1251-1273.
import * as THREE from 'three';
import type { ChapterEntry } from '../config/chapters';

/** Top bar + chapter caption own ~16% of the viewport height, so a screen only
 *  gets to "fill" 84% of it before it's considered framed. Recomputed on
 *  resize via framingDistance(), so framing survives any aspect — including
 *  portrait phones. */
export const VSAFE = 0.84;

/** Anchors are fractions of the scan's fitted bounding box (see loadModel.ts
 *  fitModel), resolved to world space so retuning MODEL_SIZE never
 *  invalidates the CHAPTERS ledger's `u` fields. */
export function anchorOf(chapter: ChapterEntry, bbox: THREE.Box3): THREE.Vector3 {
  const halfX = (bbox.max.x - bbox.min.x) / 2;
  const halfZ = (bbox.max.z - bbox.min.z) / 2;
  const height = bbox.max.y - bbox.min.y;
  return new THREE.Vector3(chapter.u[0] * halfX, chapter.u[1] * height, chapter.u[2] * halfZ);
}

/** True face normal, pitch included, so the camera parks square-on to a
 *  tilted screen instead of just its horizontal projection. Euler order is
 *  'YXZ' (yaw first, then pitch about the panel's own horizontal axis) —
 *  under the default XYZ order a pitch on a yawed panel becomes a roll. */
export function normalOf(chapter: ChapterEntry): THREE.Vector3 {
  const e = new THREE.Euler((chapter.pitch || 0) * (Math.PI / 180), chapter.yaw * (Math.PI / 180), 0, 'YXZ');
  return new THREE.Vector3(0, 0, 1).applyEuler(e);
}

/** Distance at which a screen of (w x h) fills `fill` of the frame. */
export function framingDistance(camera: THREE.PerspectiveCamera, w: number, h: number, fill: number): number {
  const vHalf = (camera.fov * Math.PI) / 360;
  const dV = h / 2 / Math.tan(vHalf) / (fill * VSAFE);
  const hHalf = Math.atan(Math.tan(vHalf) * camera.aspect);
  const dH = w / 2 / Math.tan(hHalf) / fill;
  return Math.max(dV, dH);
}
