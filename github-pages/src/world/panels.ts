// Ported from docs/one-shot/3d/sample-gitlab-3d-scan.html, L1275-1338 (panel +
// chrome construction) and L1466-1478 (the onResize mobile-breakpoint
// re-measure block). The CHAPTERS.forEach shell itself stays in
// createWorld.ts, which supplies each chapter's real DOM node from
// WorldOptions.panels and captures its {parent, next} insertion point for
// restoreDom() before this module ever touches the element.
import * as THREE from 'three';
import { CSS3DObject } from 'three/addons/renderers/CSS3DRenderer.js';
import type { ChapterEntry } from '../config/chapters';
import { anchorOf, normalOf } from './cameraPath';

export interface Panel {
  chapter: ChapterEntry;
  group: THREE.Group;
  el: HTMLElement;
  css: CSS3DObject;
  frameMat: THREE.MeshBasicMaterial;
  worldH: number;
  scale: number;
  normal: THREE.Vector3;
  /** Rebuilds the chrome geometry (backing plate, frame bars, corner ticks,
   *  floor strut) for a new panel height `h`. Disposes the previous chrome's
   *  geometries (not frameMat/backMat — those are shared and reused). */
  rescale: (h: number) => void;
  /** Set by createWorld.ts's buildCurves() once camera framing is known;
   *  0 until then (falsy, same as the source's `undefined` — see
   *  createWorld.ts updateWorld()'s `panel.frameDist || dist` fallback). */
  frameDist: number;
}

function buildChrome(
  chapter: ChapterEntry,
  group: THREE.Group,
  anchor: THREE.Vector3,
  frameMat: THREE.MeshBasicMaterial,
  backMat: THREE.MeshBasicMaterial,
  h: number,
  prev: THREE.Group | null,
): THREE.Group {
  if (prev) {
    prev.traverse((n) => {
      if (n instanceof THREE.Mesh) n.geometry.dispose();
    });
    group.remove(prev);
  }
  const chrome = new THREE.Group();
  const fw = chapter.w * 1.045;
  const fh = h * 1.06;
  const bar = 0.028;
  const tick = 0.16;

  const back = new THREE.Mesh(new THREE.PlaneGeometry(fw, fh), backMat);
  back.position.z = -0.03;
  chrome.add(back);

  ([
    [fw, bar, 0, fh / 2],
    [fw, bar, 0, -fh / 2],
    [bar, fh, -fw / 2, 0],
    [bar, fh, fw / 2, 0],
  ] as const).forEach(([w, hh, x, y]) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, hh), frameMat);
    m.position.set(x, y, -0.02);
    chrome.add(m);
  });

  ([
    [-1, 1],
    [1, 1],
    [-1, -1],
    [1, -1],
  ] as const).forEach(([sx, sy]) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(tick, tick), frameMat);
    m.position.set(sx * (fw / 2 + tick * 0.4), sy * (fh / 2 + tick * 0.4), -0.02);
    chrome.add(m);
  });

  const strutH = Math.max(0.4, anchor.y - h / 2);
  const strut = new THREE.Mesh(new THREE.PlaneGeometry(0.02, strutH), frameMat);
  strut.position.set(0, -fh / 2 - strutH / 2, -0.02);
  chrome.add(strut);

  group.add(chrome);
  return chrome;
}

/** Builds one panel: sizes+classes the real chapter <section> (`el`), reads
 *  its content-driven offsetHeight (never a guess — a hard-coded box clips
 *  the console's status row on the widest chapter), mounts it as a
 *  CSS3DObject, and adds the bloomed WebGL chrome behind it. */
export function buildPanel(
  chapter: ChapterEntry,
  el: HTMLElement,
  mobile: boolean,
  bbox: THREE.Box3,
  panelsGroup: THREE.Group,
): Panel {
  const pw = mobile ? chapter.pxm : chapter.px;
  el.classList.add('as-panel');
  el.style.width = pw + 'px';
  el.style.height = 'auto';
  const ph = el.offsetHeight;
  el.style.height = ph + 'px';
  const scale = chapter.w / pw;
  const worldH = ph * scale;

  const group = new THREE.Group();
  const anchor = anchorOf(chapter, bbox);
  group.position.copy(anchor);
  // YXZ: yaw first, then pitch about the panel's own horizontal axis. Under
  // the default XYZ order a pitch on a yawed panel becomes a roll.
  group.rotation.set((chapter.pitch || 0) * (Math.PI / 180), chapter.yaw * (Math.PI / 180), 0, 'YXZ');

  const css = new CSS3DObject(el);
  css.scale.setScalar(scale);
  group.add(css);

  const frameMat = new THREE.MeshBasicMaterial({
    color: chapter.tone,
    transparent: true,
    opacity: 0.85,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const backMat = new THREE.MeshBasicMaterial({
    color: 0x050706,
    transparent: true,
    opacity: 0.9,
    side: THREE.DoubleSide,
    depthWrite: false,
  });

  let chrome: THREE.Group | null = null;
  const rescale = (h: number): void => {
    chrome = buildChrome(chapter, group, anchor, frameMat, backMat, h, chrome);
  };
  rescale(worldH);

  panelsGroup.add(group);
  return {
    chapter,
    group,
    el,
    css,
    frameMat,
    worldH,
    scale,
    normal: normalOf(chapter),
    rescale,
    frameDist: 0,
  };
}

/** Ported from the source's onResize() mobile-breakpoint-crossed block
 *  (L1466-1478) — re-measures a single panel against the opposite px/pxm
 *  width after the responsive breakpoint has been crossed. */
export function remeasurePanel(panel: Panel, mobile: boolean): void {
  const { chapter, el, css } = panel;
  const pw = mobile ? chapter.pxm : chapter.px;
  el.style.width = pw + 'px';
  el.style.height = 'auto';
  const ph = el.offsetHeight;
  el.style.height = ph + 'px';
  const scale = chapter.w / pw;
  css.scale.setScalar(scale);
  panel.scale = scale;
  panel.worldH = ph * scale;
  panel.rescale(panel.worldH);
}
