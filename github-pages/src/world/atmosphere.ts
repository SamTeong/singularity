// Ported from docs/one-shot/3d/sample-gitlab-3d-scan.html, L1208-1231.
import * as THREE from 'three';

export interface AtmosphereResult {
  motes: THREE.Points | null;
  moteMat: THREE.PointsMaterial | null;
}

/** Adds the floor grid and (motion permitting) the ambient mote field to
 *  `atmosphere`. `radius` is half the scan's largest XZ extent — see
 *  createWorld.ts's boot() call site, ported from L1633. */
export function addAtmosphere(
  atmosphere: THREE.Group,
  radius: number,
  reducedMotion: boolean,
): AtmosphereResult {
  const grid = new THREE.GridHelper(radius * 14, 56, 0x1d4c33, 0x11291d);
  grid.position.y = 0.015;
  grid.material.transparent = true;
  grid.material.opacity = 0.5;
  grid.material.depthWrite = false;
  atmosphere.add(grid);

  const count = reducedMotion ? 0 : 360;
  if (!count) return { motes: null, moteMat: null };

  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    pos[i * 3] = (Math.random() - 0.5) * radius * 4.2;
    pos[i * 3 + 1] = Math.random() * radius * 1.9;
    pos[i * 3 + 2] = (Math.random() - 0.5) * radius * 4.2;
  }
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const moteMat = new THREE.PointsMaterial({
    color: 0x7cf4ab,
    size: 0.028,
    transparent: true,
    opacity: 0.55,
    sizeAttenuation: true,
    depthWrite: false,
  });
  const motes = new THREE.Points(geo, moteMat);
  motes.name = 'motes';
  atmosphere.add(motes);
  return { motes, moteMat };
}
