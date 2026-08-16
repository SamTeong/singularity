// Ported from docs/one-shot/3d/sample-gitlab-3d-scan.html, L1359-1375
// (drawDebugCurves) and L1523-1536 (updateDebug). Only active when
// WorldOptions.debug is true — see createWorld.ts's buildCurves()/animate().
import * as THREE from 'three';
import type { Panel } from './panels';
import type { ConductorState } from './types';

/** Draws the position/target CatmullRom curves plus a wireframe box per
 *  panel. `prev`, if given, is removed and its own line/box geometries are
 *  left to the caller (createWorld.ts's disposeSceneObjects at teardown) —
 *  matches the source, which never disposed these on rebuild either. */
export function drawDebugCurves(
  atmosphere: THREE.Group,
  curvePos: THREE.CatmullRomCurve3,
  curveTarget: THREE.CatmullRomCurve3,
  panels: Panel[],
  prev: THREE.Group | null,
): THREE.Group {
  if (prev) atmosphere.remove(prev);
  const debugLines = new THREE.Group();
  ([
    [curvePos, 0x5090d0],
    [curveTarget, 0xf26400],
  ] as const).forEach(([curve, color]) => {
    const pts = curve.getPoints(220);
    debugLines.add(
      new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color })),
    );
  });
  panels.forEach(({ group, chapter, worldH }) => {
    const box = new THREE.Box3().setFromCenterAndSize(group.position, new THREE.Vector3(chapter.w, worldH, 0.2));
    debugLines.add(new THREE.Box3Helper(box, 0x52f29a));
  });
  atmosphere.add(debugLines);
  return debugLines;
}

export interface DebugFrameInfo {
  state: Pick<ConductorState, 'exact' | 'smooth' | 'direction'>;
  camera: THREE.PerspectiveCamera;
  pathRig: THREE.Group;
  target: THREE.Vector3;
  rendererInfo: THREE.WebGLInfo;
  worldState: { fog: number; bloom: number };
  bbox: THREE.Box3 | null;
  chapterId: string | undefined;
}

export function updateDebug(el: HTMLElement, info: DebugFrameInfo): void {
  const { state, camera, pathRig, target, rendererInfo, worldState, bbox, chapterId } = info;
  const p = pathRig.position;
  el.textContent =
    'exact   ' + state.exact.toFixed(3) + '   smooth ' + state.smooth.toFixed(3) + '\n' +
    'dir     ' + state.direction + '   chapter ' + (chapterId ?? '') + '\n' +
    'camera  ' + [p.x, p.y, p.z].map((v) => v.toFixed(2)).join(', ') + '\n' +
    'target  ' + [target.x, target.y, target.z].map((v) => v.toFixed(2)).join(', ') + '\n' +
    'fov     ' + camera.fov + '   aspect ' + camera.aspect.toFixed(2) + '\n' +
    'calls   ' + rendererInfo.render.calls + '   tris ' + rendererInfo.render.triangles + '\n' +
    'fog     ' + worldState.fog.toFixed(3) + '   bloom ' + worldState.bloom.toFixed(2) + '\n' +
    'bbox    ' + (bbox ? bbox.max.toArray().map((v) => v.toFixed(2)).join(', ') : '—');
}
