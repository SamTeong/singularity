// Streaming fetch + GLTFLoader.parse, replacing the source's `loader.load()`
// (L1602-1651). xhr.total is 0 on a gzip/br-encoded response — the browser
// reports the *decoded* size for XHR progress events, which it can't know
// ahead of time under compression, so the source's progress bar silently
// freezes. fetch()'s `content-length` header instead reports the size of the
// bytes actually on the wire, so a manual reader over the stream gives
// accurate, monotonic progress throughout the download.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';

// Cached only in dev: React StrictMode double-invokes the mount effect, and
// without this the second mount would refetch the same ~11.5 MB model.
// Production never double-mounts, and holding an 11.5 MB buffer alive for
// the page's whole lifetime there would be pure waste — so nothing is
// retained outside dev builds. Never cache the *parsed* GLTF: mount #1's
// destroy() already disposed its geometries/materials/textures, so a second
// mount must always parse (and own) a fresh scene graph from the raw bytes.
let cachedBuffer: ArrayBuffer | null = null;

export async function fetchModelBuffer(
  url: string,
  onProgress: (loaded: number, total: number) => void,
): Promise<ArrayBuffer> {
  if (import.meta.env.DEV && cachedBuffer) {
    onProgress(cachedBuffer.byteLength, cachedBuffer.byteLength);
    return cachedBuffer;
  }

  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`model fetch failed: ${res.status} ${res.statusText}`);
  }
  const total = Number(res.headers.get('content-length')) || 0;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    onProgress(loaded, total);
  }

  const merged = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const buffer = merged.buffer;

  if (import.meta.env.DEV) cachedBuffer = buffer;
  return buffer;
}

/** `buffer.slice(0)` hands GLTFLoader its own copy — parse() may detach/
 *  transfer typed-array views into it, and the dev cache above must keep the
 *  original intact for a StrictMode second mount to reuse. */
export function parseModel(buffer: ArrayBuffer): Promise<GLTF> {
  const loader = new GLTFLoader();
  return new Promise((resolve, reject) => {
    loader.parse(buffer.slice(0), '', resolve, reject);
  });
}

/** Fit the scan: scale longest axis to `modelSize`, centre on XZ, drop to
 *  y = 0. Ported from L1235-1249. */
export function fitModel(root: THREE.Object3D, modelSize: number): THREE.Box3 {
  root.updateMatrixWorld(true);
  let box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  root.scale.setScalar(modelSize / maxDim);
  root.updateMatrixWorld(true);
  box = new THREE.Box3().setFromObject(root);
  const centre = box.getCenter(new THREE.Vector3());
  root.position.x -= centre.x;
  root.position.z -= centre.z;
  root.position.y -= box.min.y;
  root.updateMatrixWorld(true);
  return new THREE.Box3().setFromObject(root);
}
