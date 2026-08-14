import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { BokehPass } from 'three/examples/jsm/postprocessing/BokehPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export type ProceduralModelOptions = {
  wireframe?: boolean;
  castShadow?: boolean;
  receiveShadow?: boolean;
  textureSize?: number;
  textureAnisotropy?: number;
  qualityPriority?: 'reference-fidelity' | 'balanced';
};

export type ProceduralModelRuntime = {
  nodes: Record<string, THREE.Object3D>;
  meshes: Record<string, THREE.Mesh>;
  sockets: Record<string, THREE.Object3D>;
  colliders: Record<string, unknown>;
  destructionGroups: Record<string, THREE.Object3D[]>;
};

type SculptMaterialSpec = Record<string, any>;

// bevelEnabled defaults to true on THREE.ExtrudeGeometry and rounds every
// corner — sharp/pointed profiles (blades, fork tines, spikes) need
// bevelEnabled: false plus lineTo()-only path segments near the tip, since a
// curve command cannot produce a true converging point.
function buildExtrudeShape(points: [number, number][], holes?: [number, number][][]): THREE.Shape {
  const shape = new THREE.Shape();
  if (points.length > 0) {
    shape.moveTo(points[0][0], points[0][1]);
    for (let i = 1; i < points.length; i += 1) {
      shape.lineTo(points[i][0], points[i][1]);
    }
  }
  // Cutouts (e.g. an oval wire-cutter hole) as THREE.Path added to shape.holes —
  // dep-free boolean subtraction via the tessellator, no CSG library needed.
  for (const loop of holes ?? []) {
    if (loop.length < 3) continue;
    const path = new THREE.Path();
    path.moveTo(loop[0][0], loop[0][1]);
    for (let i = 1; i < loop.length; i += 1) path.lineTo(loop[i][0], loop[i][1]);
    path.closePath();
    shape.holes.push(path);
  }
  return shape;
}

// Build an N-gon oval loop (for hole authoring from a compact {cx,cy,rx,ry} descriptor).
function ovalLoop(cx: number, cy: number, rx: number, ry: number, seg = 24): [number, number][] {
  const loop: [number, number][] = [];
  for (let i = 0; i < seg; i += 1) {
    const a = (i / seg) * Math.PI * 2;
    loop.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]);
  }
  return loop;
}

function buildExtrudeGeometry(profile: { points: [number, number][]; depth: number; holes?: [number, number][][]; ovalHoles?: { cx: number; cy: number; rx: number; ry: number }[] }): THREE.ExtrudeGeometry {
  const holes = [...(profile.holes ?? []), ...((profile.ovalHoles ?? []).map((o) => ovalLoop(o.cx, o.cy, o.rx, o.ry)))];
  const shape = buildExtrudeShape(profile.points, holes);
  return new THREE.ExtrudeGeometry(shape, {
    depth: profile.depth,
    bevelEnabled: false,
    steps: 1,
  });
}

// Plan 1.3 F.6 — sweep a thin 2D cross-section along a 3D spine so a curved
// form (hooked blade, handle) reads correctly from EVERY camera angle, not just
// the reference angle a flat extrude happens to match. Uses ExtrudeGeometry's
// native extrudePath; bevelEnabled: false keeps sharp tips (same rule as F.5).
function buildCurveSweepGeometry(
  sweep: { spine: [number, number, number][]; crossSection: { points: [number, number][] }; closed?: boolean },
): THREE.ExtrudeGeometry {
  const shape = new THREE.Shape();
  const cs = sweep.crossSection.points;
  if (cs.length > 0) {
    shape.moveTo(cs[0][0], cs[0][1]);
    for (let i = 1; i < cs.length; i += 1) shape.lineTo(cs[i][0], cs[i][1]);
    shape.closePath();
  }
  const spine = sweep.spine.map(([x, y, z]) => new THREE.Vector3(x, y, z));
  const path = new THREE.CatmullRomCurve3(spine, sweep.closed ?? false);
  return new THREE.ExtrudeGeometry(shape, {
    extrudePath: path,
    steps: Math.max(24, spine.length * 8),
    bevelEnabled: false,
  });
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function readLayerNumber(value: unknown, keys: string[], fallback: number): number {
  if (typeof value === 'number') return value;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of keys) {
      if (typeof record[key] === 'number') return record[key] as number;
    }
  }
  return fallback;
}

function hexToRgb(hex: string): [number, number, number] {
  const normalized = /^#[0-9a-f]{3}$/i.test(hex)
    ? '#' + hex.slice(1).split('').map((part) => part + part).join('')
    : hex;
  const value = /^#[0-9a-f]{6}$/i.test(normalized) ? Number.parseInt(normalized.slice(1), 16) : 0x8a7a5f;
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function materialPalette(spec: SculptMaterialSpec): string[] {
  const palette = spec.colorVariation?.palette;
  if (Array.isArray(palette) && palette.length > 0) return palette.filter((value) => typeof value === 'string');
  const secondary = spec.albedo?.secondary;
  const colors = [spec.baseColor ?? spec.color ?? spec.albedo?.dominant, ...(Array.isArray(secondary) ? secondary : [])];
  return colors.filter((value): value is string => typeof value === 'string' && value.startsWith('#'));
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function smoothCurve(value: number): number {
  return value * value * (3 - 2 * value);
}

function periodicHash(x: number, y: number, seed: number, periodX: number, periodY: number): number {
  const wrappedX = ((x % periodX) + periodX) % periodX;
  const wrappedY = ((y % periodY) + periodY) % periodY;
  let value = Math.imul(wrappedX + seed * 17, 374761393) ^ Math.imul(wrappedY + seed * 31, 668265263);
  value = Math.imul(value ^ (value >>> 13), 1274126177);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967295;
}

function periodicValueNoise(u: number, v: number, seed: number, periodX: number, periodY: number): number {
  const x = u * periodX;
  const y = v * periodY;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = smoothCurve(x - x0);
  const ty = smoothCurve(y - y0);
  const a = periodicHash(x0, y0, seed, periodX, periodY);
  const b = periodicHash(x0 + 1, y0, seed, periodX, periodY);
  const c = periodicHash(x0, y0 + 1, seed, periodX, periodY);
  const d = periodicHash(x0 + 1, y0 + 1, seed, periodX, periodY);
  return THREE.MathUtils.lerp(THREE.MathUtils.lerp(a, b, tx), THREE.MathUtils.lerp(c, d, tx), ty);
}

type SurfaceBand = {
  frequency: number;
  amplitude: number;
  stretchX: number;
  stretchY: number;
  ridge: boolean;
};

function surfaceBands(spec: SculptMaterialSpec): SurfaceBand[] {
  const source = Array.isArray(spec.surfaceFrequencyBands) ? spec.surfaceFrequencyBands : [];
  const parsed = source.flatMap((item: unknown) => {
    if (!item || typeof item !== 'object') return [];
    const band = item as Record<string, unknown>;
    const frequency = typeof band.frequency === 'number' ? band.frequency : 0;
    const amplitude = typeof band.amplitude === 'number' ? band.amplitude : 0;
    if (frequency <= 0 || amplitude <= 0) return [];
    const stretch = Array.isArray(band.stretch) ? band.stretch : [1, 1];
    const description = `${String(band.pattern ?? '')} ${String(band.role ?? '')}`.toLowerCase();
    return [{
      frequency,
      amplitude,
      stretchX: typeof stretch[0] === 'number' ? Math.max(0.1, stretch[0]) : 1,
      stretchY: typeof stretch[1] === 'number' ? Math.max(0.1, stretch[1]) : 1,
      ridge: /(ridge|groove|grain|fiber|striated|crack)/.test(description),
    }];
  });
  return parsed.length > 0 ? parsed : [
    { frequency: 2, amplitude: 0.42, stretchX: 1, stretchY: 1, ridge: false },
    { frequency: 12, amplitude: 0.22, stretchX: 1, stretchY: 1, ridge: false },
    { frequency: 56, amplitude: 0.08, stretchX: 1, stretchY: 1, ridge: false },
  ];
}

function sampleSurface(u: number, v: number, bands: SurfaceBand[], seed: number): number {
  let value = 0;
  let weight = 0;
  for (let index = 0; index < bands.length; index += 1) {
    const band = bands[index];
    const periodX = Math.max(1, Math.round(band.frequency * band.stretchX));
    const periodY = Math.max(1, Math.round(band.frequency * band.stretchY));
    let sample = periodicValueNoise(u, v, seed + index * 1013, periodX, periodY);
    if (band.ridge) sample = 1 - Math.abs(sample * 2 - 1);
    value += sample * band.amplitude;
    weight += band.amplitude;
  }
  return weight > 0 ? clamp01(value / weight) : 0.5;
}

function mixPalette(colors: [number, number, number][], value: number): [number, number, number] {
  if (colors.length === 1) return colors[0];
  const scaled = clamp01(value) * (colors.length - 1);
  const index = Math.min(colors.length - 2, Math.floor(scaled));
  const mix = scaled - index;
  const a = colors[index];
  const b = colors[index + 1];
  return [
    Math.round(THREE.MathUtils.lerp(a[0], b[0], mix)),
    Math.round(THREE.MathUtils.lerp(a[1], b[1], mix)),
    Math.round(THREE.MathUtils.lerp(a[2], b[2], mix)),
  ];
}

type ColorGradientStop = { offset: number; color: string };
type ColorGradientSpec = {
  type: 'linear' | 'radial';
  axis: [number, number];
  stops: ColorGradientStop[];
};

function parseRgba(value: string): [number, number, number] {
  const match = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(value);
  if (!match) return [138, 122, 95];
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

// Analytical per-pixel gradient sample. The extraction schema's colorGradient carries
// exact rgba(...) stop colors (see extract_part_color_recipe.py), so this samples the
// same trend directly in JS math rather than round-tripping through a Canvas 2D
// createLinearGradient/createRadialGradient object — same visual result, and it composes
// directly with the existing noise/height-correlated colorVariation blend below.
function sampleColorGradient(gradient: ColorGradientSpec, u: number, v: number): [number, number, number] {
  const stops = gradient.stops.length >= 2 ? gradient.stops : [{ offset: 0, color: 'rgba(138,122,95,1)' }, { offset: 1, color: 'rgba(138,122,95,1)' }];
  let t: number;
  if (gradient.type === 'radial') {
    const [cx, cy] = gradient.axis;
    const dx = u - cx;
    const dy = v - cy;
    const maxRadius = Math.max(0.001, Math.hypot(Math.max(cx, 1 - cx), Math.max(cy, 1 - cy)));
    t = clamp01(Math.hypot(dx, dy) / maxRadius);
  } else {
    const [ax, ay] = gradient.axis;
    const projection = (u - 0.5) * ax + (v - 0.5) * ay;
    const maxProjection = 0.5 * (Math.abs(ax) + Math.abs(ay)) || 0.5;
    t = clamp01(projection / maxProjection + 0.5);
  }
  const scaled = t * (stops.length - 1);
  const index = Math.min(stops.length - 2, Math.max(0, Math.floor(scaled)));
  const mix = scaled - index;
  const a = parseRgba(stops[index].color);
  const b = parseRgba(stops[index + 1].color);
  return [
    THREE.MathUtils.lerp(a[0], b[0], mix),
    THREE.MathUtils.lerp(a[1], b[1], mix),
    THREE.MathUtils.lerp(a[2], b[2], mix),
  ];
}

function writePixel(data: Uint8ClampedArray, offset: number, red: number, green: number, blue: number): void {
  data[offset] = Math.max(0, Math.min(255, Math.round(red)));
  data[offset + 1] = Math.max(0, Math.min(255, Math.round(green)));
  data[offset + 2] = Math.max(0, Math.min(255, Math.round(blue)));
  data[offset + 3] = 255;
}

function makeCanvas(size: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  return canvas;
}

function createMapTexture(
  canvas: HTMLCanvasElement,
  colorSpace: THREE.ColorSpace,
  spec: SculptMaterialSpec,
  options: ProceduralModelOptions,
): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(canvas);
  const projection = spec.textureProjection && typeof spec.textureProjection === 'object' ? spec.textureProjection : {};
  const repeat = Array.isArray(projection.repeat) ? projection.repeat : [2, 2];
  texture.colorSpace = colorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(
    typeof repeat[0] === 'number' ? repeat[0] : 2,
    typeof repeat[1] === 'number' ? repeat[1] : 2,
  );
  texture.anisotropy = Math.max(1, Math.round(options.textureAnisotropy ?? projection.anisotropy ?? 8));
  texture.needsUpdate = true;
  return texture;
}

type ProceduralTextureSet = {
  albedo: THREE.Texture;
  roughness: THREE.Texture;
  height: THREE.Texture;
  normal: THREE.Texture;
  ao: THREE.Texture;
  source: 'reference-pixel-extraction' | 'procedural';
};

function referenceMapUrl(spec: SculptMaterialSpec, channel: string): string | null {
  const reference = spec.referencePbr;
  if (!reference || typeof reference !== 'object') return null;
  if (reference.usable === false) return null;
  const confidence = typeof reference.confidence === 'number'
    ? reference.confidence
    : (typeof reference.estimatedFidelity === 'number' ? reference.estimatedFidelity : 0);
  const threshold = typeof reference.targetThreshold === 'number' ? reference.targetThreshold : 0.7;
  if (confidence < threshold) return null;
  const maps = reference.maps;
  if (!maps || typeof maps !== 'object') return null;
  const map = (maps as Record<string, unknown>)[channel];
  if (!map || typeof map !== 'object') return null;
  const record = map as Record<string, unknown>;
  const url = typeof record.url === 'string' && record.url.trim() ? record.url : record.path;
  return typeof url === 'string' && url.trim() ? url : null;
}

function createLoadedMapTexture(
  url: string,
  colorSpace: THREE.ColorSpace,
  spec: SculptMaterialSpec,
  options: ProceduralModelOptions,
): THREE.Texture {
  const texture = new THREE.TextureLoader().load(url);
  const projection = spec.textureProjection && typeof spec.textureProjection === 'object' ? spec.textureProjection : {};
  const repeat = Array.isArray(projection.repeat) ? projection.repeat : [1, 1];
  texture.colorSpace = colorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(
    typeof repeat[0] === 'number' ? repeat[0] : 1,
    typeof repeat[1] === 'number' ? repeat[1] : 1,
  );
  texture.anisotropy = Math.max(1, Math.round(options.textureAnisotropy ?? projection.anisotropy ?? 8));
  texture.needsUpdate = true;
  return texture;
}

function makeReferenceTextureSet(spec: SculptMaterialSpec, options: ProceduralModelOptions): ProceduralTextureSet | null {
  const albedo = referenceMapUrl(spec, 'albedo');
  const roughness = referenceMapUrl(spec, 'roughness');
  const height = referenceMapUrl(spec, 'height');
  const normal = referenceMapUrl(spec, 'normal');
  const ao = referenceMapUrl(spec, 'ao');
  if (!albedo || !roughness || !height || !normal || !ao) return null;
  return {
    albedo: createLoadedMapTexture(albedo, THREE.SRGBColorSpace, spec, options),
    roughness: createLoadedMapTexture(roughness, THREE.NoColorSpace, spec, options),
    height: createLoadedMapTexture(height, THREE.NoColorSpace, spec, options),
    normal: createLoadedMapTexture(normal, THREE.NoColorSpace, spec, options),
    ao: createLoadedMapTexture(ao, THREE.NoColorSpace, spec, options),
    source: 'reference-pixel-extraction',
  };
}

function makeProceduralTextureSet(
  id: string,
  spec: SculptMaterialSpec,
  options: ProceduralModelOptions,
): ProceduralTextureSet | null {
  if (typeof document === 'undefined') return null;
  const qualityFirst = (options.qualityPriority ?? 'reference-fidelity') === 'reference-fidelity';
  const requested = options.textureSize ?? spec.textureResolution;
  const requestedSize = typeof requested === 'number' && Number.isFinite(requested)
    ? requested
    : (qualityFirst ? 1024 : 512);
  const size = Math.max(256, Math.min(2048, 2 ** Math.round(Math.log2(requestedSize))));
  const canvases = {
    albedo: makeCanvas(size),
    roughness: makeCanvas(size),
    height: makeCanvas(size),
    normal: makeCanvas(size),
    ao: makeCanvas(size),
  };
  const contexts = {
    albedo: canvases.albedo.getContext('2d'),
    roughness: canvases.roughness.getContext('2d'),
    height: canvases.height.getContext('2d'),
    normal: canvases.normal.getContext('2d'),
    ao: canvases.ao.getContext('2d'),
  };
  if (!contexts.albedo || !contexts.roughness || !contexts.height || !contexts.normal || !contexts.ao) return null;
  const images = {
    albedo: contexts.albedo.createImageData(size, size),
    roughness: contexts.roughness.createImageData(size, size),
    height: contexts.height.createImageData(size, size),
    normal: contexts.normal.createImageData(size, size),
    ao: contexts.ao.createImageData(size, size),
  };
  const seed = hashString(id);
  const bands = surfaceBands(spec);
  const heightField = new Float32Array(size * size);
  const roughnessField = new Float32Array(size * size);
  const palette = materialPalette(spec);
  const fallback = typeof spec.baseColor === 'string' ? spec.baseColor : '#8A7A5F';
  const colors = (palette.length >= 2 ? palette : [fallback, '#6E614B', '#A08F70']).map(hexToRgb);
  const baseRoughness = clamp01(readLayerNumber(spec.roughness, ['base'], 0.76));
  const roughnessVariation = clamp01(readLayerNumber(spec.roughness, ['variation'], 0.18));
  const colorAmplitude = clamp01(readLayerNumber(spec.colorVariation, ['amplitude', 'variation'], 0.18));
  const heightCorrelation = clamp01(readLayerNumber(spec.colorVariation, ['heightCorrelation'], 0.3));
  const colorGradient: ColorGradientSpec | undefined = spec.colorGradient;
  for (let y = 0; y < size; y += 1) {
    const v = y / size;
    for (let x = 0; x < size; x += 1) {
      const u = x / size;
      const index = y * size + x;
      const height = sampleSurface(u, v, bands, seed + 101);
      const roughNoise = sampleSurface(u, v, bands, seed + 7001);
      const colorNoise = sampleSurface(u, v, bands, seed + 15013);
      heightField[index] = height;
      roughnessField[index] = clamp01(baseRoughness + (roughNoise - 0.5) * roughnessVariation * 2);
      let color: [number, number, number];
      if (colorGradient) {
        // Evidence-derived spatial gradient (Plan 1.3 Workstream C) takes priority
        // over the noise-based palette blend below — it is a measured trend, not a guess.
        color = sampleColorGradient(colorGradient, u, v);
      } else {
        const paletteValue = clamp01(
          0.5 + (colorNoise - 0.5) * colorAmplitude * 2 + (height - 0.5) * heightCorrelation
        );
        color = mixPalette(colors, paletteValue);
      }
      writePixel(images.albedo.data, index * 4, color[0], color[1], color[2]);
    }
  }
  const normalStrength = Math.max(0.05, readLayerNumber(spec.normal, ['strength', 'amplitude'], 0.35));
  const aoStrength = clamp01(readLayerNumber(spec.ambientOcclusion, ['cavityStrength', 'strength'], 0.35));
  for (let y = 0; y < size; y += 1) {
    const up = ((y - 1 + size) % size) * size;
    const down = ((y + 1) % size) * size;
    for (let x = 0; x < size; x += 1) {
      const left = (x - 1 + size) % size;
      const right = (x + 1) % size;
      const index = y * size + x;
      const center = heightField[index];
      const dx = (heightField[y * size + right] - heightField[y * size + left]) * normalStrength * 6;
      const dy = (heightField[down + x] - heightField[up + x]) * normalStrength * 6;
      const inverseLength = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      const normalX = -dx * inverseLength;
      const normalY = -dy * inverseLength;
      const normalZ = inverseLength;
      const neighborAverage = (
        heightField[y * size + left] + heightField[y * size + right]
        + heightField[up + x] + heightField[down + x]
      ) * 0.25;
      const cavity = Math.max(0, neighborAverage - center);
      const ao = clamp01(1 - aoStrength * (cavity * 12 + (1 - center) * 0.16));
      const offset = index * 4;
      const heightByte = center * 255;
      const roughnessByte = roughnessField[index] * 255;
      writePixel(images.height.data, offset, heightByte, heightByte, heightByte);
      writePixel(images.roughness.data, offset, roughnessByte, roughnessByte, roughnessByte);
      writePixel(
        images.normal.data, offset,
        (normalX * 0.5 + 0.5) * 255,
        (normalY * 0.5 + 0.5) * 255,
        (normalZ * 0.5 + 0.5) * 255,
      );
      writePixel(images.ao.data, offset, ao * 255, ao * 255, ao * 255);
    }
  }
  contexts.albedo.putImageData(images.albedo, 0, 0);
  contexts.roughness.putImageData(images.roughness, 0, 0);
  contexts.height.putImageData(images.height, 0, 0);
  contexts.normal.putImageData(images.normal, 0, 0);
  contexts.ao.putImageData(images.ao, 0, 0);
  return {
    albedo: createMapTexture(canvases.albedo, THREE.SRGBColorSpace, spec, options),
    roughness: createMapTexture(canvases.roughness, THREE.NoColorSpace, spec, options),
    height: createMapTexture(canvases.height, THREE.NoColorSpace, spec, options),
    normal: createMapTexture(canvases.normal, THREE.NoColorSpace, spec, options),
    ao: createMapTexture(canvases.ao, THREE.NoColorSpace, spec, options),
    source: 'procedural',
  };
}

function createSculptMaterial(id: string, spec: SculptMaterialSpec, options: ProceduralModelOptions): THREE.MeshPhysicalMaterial {
  const textures = makeReferenceTextureSet(spec, options) ?? makeProceduralTextureSet(id, spec, options);
  const material = new THREE.MeshPhysicalMaterial({
    color: textures ? 0xffffff : new THREE.Color(typeof spec.baseColor === 'string' ? spec.baseColor : '#8A7A5F'),
    roughness: textures ? 1 : clamp01(readLayerNumber(spec.roughness, ['base'], 0.76)),
    metalness: clamp01(readLayerNumber(spec.metalness, ['base'], 0.0)),
    clearcoat: clamp01(readLayerNumber(spec.clearcoat, ['base', 'amount'], 0)),
    clearcoatRoughness: clamp01(readLayerNumber(spec.clearcoatRoughness, ['base'], 0.25)),
    transmission: clamp01(readLayerNumber(spec.transmission, ['base', 'amount'], 0)),
    ior: Math.max(1, readLayerNumber(spec.ior, ['base', 'value'], 1.5)),
    thickness: Math.max(0, readLayerNumber(spec.thickness, ['base', 'amount'], 0)),
    attenuationDistance: Math.max(0.001, readLayerNumber(spec.attenuationDistance, ['base', 'value'], Infinity)),
    attenuationColor: new THREE.Color(typeof spec.attenuationColor === 'string' ? spec.attenuationColor : '#ffffff'),
    sheen: clamp01(readLayerNumber(spec.sheen, ['base', 'amount'], 0)),
    sheenColor: new THREE.Color(typeof spec.sheenColor === 'string' ? spec.sheenColor : '#ffffff'),
    sheenRoughness: clamp01(readLayerNumber(spec.sheenRoughness, ['base'], 1.0)),
    iridescence: clamp01(readLayerNumber(spec.iridescence, ['base', 'amount'], 0)),
    iridescenceIOR: Math.max(1, readLayerNumber(spec.iridescenceIOR, ['base', 'value'], 1.3)),
    anisotropy: clamp01(readLayerNumber(spec.anisotropy, ['base', 'amount'], 0)),
    anisotropyRotation: readLayerNumber(spec.anisotropy, ['rotation'], 0),
    specularIntensity: clamp01(readLayerNumber(spec.specularIntensity, ['base'], 1.0)),
    specularColor: new THREE.Color(typeof spec.specularColor === 'string' ? spec.specularColor : '#ffffff'),
    emissive: new THREE.Color(typeof spec.emissive === 'string' ? spec.emissive : '#000000'),
    emissiveIntensity: Math.max(0, readLayerNumber(spec.emissiveIntensity, ['base'], 1.0)),
    opacity: clamp01(readLayerNumber(spec.opacity, ['base'], 1)),
    transparent: readLayerNumber(spec.transmission, ['base', 'amount'], 0) > 0 || readLayerNumber(spec.opacity, ['base'], 1) < 1,
    alphaTest: Math.max(0, readLayerNumber(spec.alpha, ['cutoff', 'alphaTest'], 0)),
    wireframe: options.wireframe ?? false,
    side: spec.doubleSided === true ? THREE.DoubleSide : THREE.FrontSide,
  });
  if (textures) {
    material.map = textures.albedo;
    material.roughnessMap = textures.roughness;
    material.normalMap = textures.normal;
    material.normalScale.setScalar(Math.max(0.05, readLayerNumber(spec.normal, ['strength', 'amplitude'], 0.35)));
    material.aoMap = textures.ao;
    material.aoMap.channel = 0;
    material.aoMapIntensity = readLayerNumber(spec.ambientOcclusion, ['cavityStrength', 'strength'], 0.35);
    const bumpScale = Math.max(0, readLayerNumber(spec.bump, ['amplitude', 'strength'], 0));
    if (bumpScale > 0) {
      material.bumpMap = textures.height;
      material.bumpScale = bumpScale;
    }
    const displacementScale = Math.max(0, readLayerNumber(spec.displacement, ['amplitude', 'strength'], 0));
    if (displacementScale > 0) {
      material.displacementMap = textures.height;
      material.displacementScale = displacementScale;
      material.displacementBias = -displacementScale * 0.5;
    }
  }
  material.envMapIntensity = readLayerNumber(spec, ['envMapIntensity'], 0.8);
  material.userData.sculptMaterial = spec;
  material.userData.proceduralMapsIndependent = true;
  material.userData.pbrTextureSource = textures?.source ?? 'flat-fallback';
  material.userData.referencePbr = spec.referencePbr ?? null;
  material.needsUpdate = true;
  return material;
}

type AttachmentEndpoint = {
  start: THREE.Vector3;
  midpoint: THREE.Vector3;
  quaternion: THREE.Quaternion;
  length: number;
  baseRadius: number;
  endRadius: number;
};

function readVector3(value: unknown, fallback: [number, number, number]): THREE.Vector3 {
  if (Array.isArray(value) && value.length === 3 && value.every((item) => typeof item === 'number')) {
    return new THREE.Vector3(value[0], value[1], value[2]);
  }
  return new THREE.Vector3(fallback[0], fallback[1], fallback[2]);
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function makeAttachmentEndpoint(attachment: unknown): AttachmentEndpoint | null {
  if (!attachment || typeof attachment !== 'object') return null;
  const record = attachment as Record<string, unknown>;
  const start = readVector3(record.localStart, [0, 0, 0]);
  const end = readVector3(record.localEnd, [0, 1, 0]);
  const delta = end.clone().sub(start);
  const length = delta.length();
  if (length <= 0.0001) return null;
  const direction = delta.clone().normalize();
  const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
  const baseRadius = Math.max(0.005, readNumber(record.baseRadius, 0.06));
  const endRadius = Math.max(0.003, readNumber(record.endRadius, baseRadius * 0.55));
  return {
    start,
    midpoint: delta.multiplyScalar(0.5),
    quaternion,
    length,
    baseRadius,
    endRadius,
  };
}

// Generated from ObjectSculptSpec target: NERV-style Tactical Command Room
// Sculpt build pass: blockout
// This factory is intentionally pass-gated. Finish browser screenshot review before unlocking deeper passes.
export function createNERVStyleTacticalCommandRoomModel(options: ProceduralModelOptions = {}): THREE.Group {
  const root = new THREE.Group();
  root.name = "NERV-style Tactical Command Room";
  root.userData.reconstructionEvidence = {"itemFamily": null, "subtype": null, "componentAdapter": null, "route": null, "exactnessTier": null, "referenceCamera": {"solved": false, "fovDegrees": 40.0, "aspect": 1.0, "orientation": {"yaw": 0.0, "pitch": 0.0, "roll": 0.0}, "positionHint": [0.0, 0.0, 3.0], "note": "For likeness work, solve the reference camera (forge/stage1_intake/solve_camera_pose.py) so the review render aligns with the photo and the reference can be projected. Confirm by overlay review."}, "approximationNotes": []};

  const materialMap: Record<string, THREE.Material> = {};
  materialMap["structuralSteel"] = createSculptMaterial(
    "structuralSteel",
    {"id": "structuralSteel", "name": "Painted structural steel", "type": "standard", "shaderModel": "MeshStandardMaterial", "baseColor": "#3A4249", "color": "#3A4249", "albedo": {"dominant": "#231E19", "secondary": ["#11100D", "#080503", "#4D2C1C"], "samplingNotes": "Reference-derived from foreground pixels; de-lit to reduce baked shadows/highlights.", "map": {"path": "/Users/jaar/conductor/workspaces/singularity/bucharest/.img2threejs-work/pbr-evidence/structuralSteel/structuralsteel_albedo.png", "url": "structuralsteel_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}}, "colorVariation": {"palette": ["#231E19", "#11100D", "#080503", "#4D2C1C", "#3C5754"], "pattern": "reference-derived pixel palette", "amplitude": 0.096, "heightCorrelation": 0.42}, "metalness": 0.6, "roughness": {"base": 0.733, "variation": 0.177, "map": {"path": "/Users/jaar/conductor/workspaces/singularity/bucharest/.img2threejs-work/pbr-evidence/structuralSteel/structuralsteel_roughness.png", "url": "structuralsteel_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "localResponse": "reference-derived roughness estimate; cavities and textured zones trend rougher, bright highlights trend smoother"}, "textureResolution": 1024, "textureProjection": {"mode": "generated-canvas", "repeat": [1, 1], "anisotropy": 8, "texelDensityIntent": "generated CanvasTexture per material, procedural (no photo bake)"}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.36, "role": "reference-derived broad albedo and height breakup"}, {"id": "meso", "frequency": 14.0, "amplitude": 0.35, "role": "reference-derived cracks, ridges, pores, grain, or leaf clusters"}, {"id": "micro", "frequency": 72.0, "amplitude": 0.14, "role": "reference-derived micro highlight breakup under grazing light"}], "emissive": null, "emissiveIntensity": 0.0, "clearcoat": 0.0, "localOverrides": [{"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}], "notes": "dark blue-grey satin steel; procedural CanvasTexture panel-seam pattern for meso normal-ish variation", "referencePbr": {"version": "1.0", "sourceImage": "/Users/jaar/conductor/workspaces/singularity/bucharest/.img2threejs-work/detail-inventory/zone-r0c0.png", "extractor": "stage1_intake/extract_pbr_evidence.py", "method": "single-image pixel evidence with de-lighting estimate; not photogrammetry", "usable": true, "verdict": "pass", "confidence": 0.846, "estimatedFidelity": 0.846, "targetThreshold": 0.5, "hardLimit": "A single image cannot uniquely recover true albedo/roughness/normal/AO; maps are reference-derived estimates.", "maps": {"albedo": {"path": "/Users/jaar/conductor/workspaces/singularity/bucharest/.img2threejs-work/pbr-evidence/structuralSteel/structuralsteel_albedo.png", "url": "structuralsteel_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "/Users/jaar/conductor/workspaces/singularity/bucharest/.img2threejs-work/pbr-evidence/structuralSteel/structuralsteel_roughness.png", "url": "structuralsteel_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "/Users/jaar/conductor/workspaces/singularity/bucharest/.img2threejs-work/pbr-evidence/structuralSteel/structuralsteel_height.png", "url": "structuralsteel_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "/Users/jaar/conductor/workspaces/singularity/bucharest/.img2threejs-work/pbr-evidence/structuralSteel/structuralsteel_normal.png", "url": "structuralsteel_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "/Users/jaar/conductor/workspaces/singularity/bucharest/.img2threejs-work/pbr-evidence/structuralSteel/structuralsteel_ao.png", "url": "structuralsteel_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "diagnostics": {"sourceWidth": 469, "sourceHeight": 256, "mapSize": 1024, "cropBBoxPixels": {"x": 0, "y": 0, "width": 469, "height": 256}, "mask": {"backgroundColor": "#121413", "backgroundNoise": 9.95, "transparentPixelFraction": 0.0, "foregroundCoverage": 0.5113}, "mapStats": {"valueRange": 0.2278, "heightP90Gradient": 0.08494, "roughnessBase": 0.733, "roughnessVariation": 0.177, "normalStrength": 0.256, "blurRadius": 21}, "palette": ["#231E19", "#11100D", "#080503", "#4D2C1C", "#3C5754"]}, "warnings": ["single-image inverse rendering cannot prove true physical PBR; confidence is capped", "low value range weakens height/roughness inference"]}, "normal": {"pattern": "reference-derived height-gradient normal map", "strength": 0.256, "map": {"path": "/Users/jaar/conductor/workspaces/singularity/bucharest/.img2threejs-work/pbr-evidence/structuralSteel/structuralsteel_normal.png", "url": "structuralsteel_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "heightSource": {"path": "/Users/jaar/conductor/workspaces/singularity/bucharest/.img2threejs-work/pbr-evidence/structuralSteel/structuralsteel_height.png", "url": "structuralsteel_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "space": "tangent"}, "bump": {"pattern": "reference-derived height field", "amplitude": 0.038, "map": {"path": "/Users/jaar/conductor/workspaces/singularity/bucharest/.img2threejs-work/pbr-evidence/structuralSteel/structuralsteel_height.png", "url": "structuralsteel_height.png", "channel": "height", "source": "reference-pixel-extraction"}}, "ambientOcclusion": {"cavityStrength": 0.38, "contactShadowBias": 0.35, "map": {"path": "/Users/jaar/conductor/workspaces/singularity/bucharest/.img2threejs-work/pbr-evidence/structuralSteel/structuralsteel_ao.png", "url": "structuralsteel_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}, "notes": "Reference-derived cavity estimate from local height minima; verify against grazing-light screenshot."}, "shaderNotes": ["Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps."]},
    options
  );
  materialMap["accentTrim"] = createSculptMaterial(
    "accentTrim",
    {"id": "accentTrim", "name": "Burnt-orange structural accent", "type": "standard", "shaderModel": "MeshStandardMaterial", "baseColor": "#F26400", "color": "#F26400", "albedo": {"dominant": "#231E19", "secondary": ["#11100D", "#080503", "#4D2C1C"], "samplingNotes": "Reference-derived from foreground pixels; de-lit to reduce baked shadows/highlights.", "map": {"path": "/Users/jaar/conductor/workspaces/singularity/bucharest/.img2threejs-work/pbr-evidence/accentTrim/accenttrim_albedo.png", "url": "accenttrim_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}}, "colorVariation": {"palette": ["#231E19", "#11100D", "#080503", "#4D2C1C", "#3C5754"], "pattern": "reference-derived pixel palette", "amplitude": 0.096, "heightCorrelation": 0.42}, "metalness": 0.3, "roughness": {"base": 0.733, "variation": 0.177, "map": {"path": "/Users/jaar/conductor/workspaces/singularity/bucharest/.img2threejs-work/pbr-evidence/accentTrim/accenttrim_roughness.png", "url": "accenttrim_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "localResponse": "reference-derived roughness estimate; cavities and textured zones trend rougher, bright highlights trend smoother"}, "textureResolution": 1024, "textureProjection": {"mode": "generated-canvas", "repeat": [1, 1], "anisotropy": 8, "texelDensityIntent": "generated CanvasTexture per material, procedural (no photo bake)"}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.36, "role": "reference-derived broad albedo and height breakup"}, {"id": "meso", "frequency": 14.0, "amplitude": 0.35, "role": "reference-derived cracks, ridges, pores, grain, or leaf clusters"}, {"id": "micro", "frequency": 72.0, "amplitude": 0.14, "role": "reference-derived micro highlight breakup under grazing light"}], "emissive": null, "emissiveIntensity": 0.0, "clearcoat": 0.0, "localOverrides": [{"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}], "notes": "thin edge/trim treatment only, applied to beams/stair stringers/wall capitals -- not a fill color", "referencePbr": {"version": "1.0", "sourceImage": "/Users/jaar/conductor/workspaces/singularity/bucharest/.img2threejs-work/detail-inventory/zone-r0c0.png", "extractor": "stage1_intake/extract_pbr_evidence.py", "method": "single-image pixel evidence with de-lighting estimate; not photogrammetry", "usable": true, "verdict": "pass", "confidence": 0.846, "estimatedFidelity": 0.846, "targetThreshold": 0.4, "hardLimit": "A single image cannot uniquely recover true albedo/roughness/normal/AO; maps are reference-derived estimates.", "maps": {"albedo": {"path": "/Users/jaar/conductor/workspaces/singularity/bucharest/.img2threejs-work/pbr-evidence/accentTrim/accenttrim_albedo.png", "url": "accenttrim_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "/Users/jaar/conductor/workspaces/singularity/bucharest/.img2threejs-work/pbr-evidence/accentTrim/accenttrim_roughness.png", "url": "accenttrim_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "/Users/jaar/conductor/workspaces/singularity/bucharest/.img2threejs-work/pbr-evidence/accentTrim/accenttrim_height.png", "url": "accenttrim_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "/Users/jaar/conductor/workspaces/singularity/bucharest/.img2threejs-work/pbr-evidence/accentTrim/accenttrim_normal.png", "url": "accenttrim_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "/Users/jaar/conductor/workspaces/singularity/bucharest/.img2threejs-work/pbr-evidence/accentTrim/accenttrim_ao.png", "url": "accenttrim_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "diagnostics": {"sourceWidth": 469, "sourceHeight": 256, "mapSize": 1024, "cropBBoxPixels": {"x": 0, "y": 0, "width": 469, "height": 256}, "mask": {"backgroundColor": "#121413", "backgroundNoise": 9.95, "transparentPixelFraction": 0.0, "foregroundCoverage": 0.5113}, "mapStats": {"valueRange": 0.2278, "heightP90Gradient": 0.08494, "roughnessBase": 0.733, "roughnessVariation": 0.177, "normalStrength": 0.256, "blurRadius": 21}, "palette": ["#231E19", "#11100D", "#080503", "#4D2C1C", "#3C5754"]}, "warnings": ["single-image inverse rendering cannot prove true physical PBR; confidence is capped", "low value range weakens height/roughness inference"]}, "normal": {"pattern": "reference-derived height-gradient normal map", "strength": 0.256, "map": {"path": "/Users/jaar/conductor/workspaces/singularity/bucharest/.img2threejs-work/pbr-evidence/accentTrim/accenttrim_normal.png", "url": "accenttrim_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "heightSource": {"path": "/Users/jaar/conductor/workspaces/singularity/bucharest/.img2threejs-work/pbr-evidence/accentTrim/accenttrim_height.png", "url": "accenttrim_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "space": "tangent"}, "bump": {"pattern": "reference-derived height field", "amplitude": 0.038, "map": {"path": "/Users/jaar/conductor/workspaces/singularity/bucharest/.img2threejs-work/pbr-evidence/accentTrim/accenttrim_height.png", "url": "accenttrim_height.png", "channel": "height", "source": "reference-pixel-extraction"}}, "ambientOcclusion": {"cavityStrength": 0.38, "contactShadowBias": 0.35, "map": {"path": "/Users/jaar/conductor/workspaces/singularity/bucharest/.img2threejs-work/pbr-evidence/accentTrim/accenttrim_ao.png", "url": "accenttrim_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}, "notes": "Reference-derived cavity estimate from local height minima; verify against grazing-light screenshot."}, "shaderNotes": ["Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps."]},
    options
  );
  materialMap["consoleDeck"] = createSculptMaterial(
    "consoleDeck",
    {"id": "consoleDeck", "name": "Console/dais composite deck", "type": "standard", "shaderModel": "MeshStandardMaterial", "baseColor": "#2E6F6B", "color": "#2E6F6B", "albedo": {"dominant": "#253B3B", "secondary": ["#18201F", "#437677", "#43524F"], "samplingNotes": "Reference-derived from foreground pixels; de-lit to reduce baked shadows/highlights.", "map": {"path": "/Users/jaar/conductor/workspaces/singularity/bucharest/.img2threejs-work/pbr-evidence/consoleDeck/consoledeck_albedo.png", "url": "consoledeck_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}}, "colorVariation": {"palette": ["#253B3B", "#18201F", "#437677", "#43524F", "#080D0C"], "pattern": "reference-derived pixel palette", "amplitude": 0.16, "heightCorrelation": 0.42}, "metalness": 0.1, "roughness": {"base": 0.75, "variation": 0.191, "map": {"path": "/Users/jaar/conductor/workspaces/singularity/bucharest/.img2threejs-work/pbr-evidence/consoleDeck/consoledeck_roughness.png", "url": "consoledeck_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "localResponse": "reference-derived roughness estimate; cavities and textured zones trend rougher, bright highlights trend smoother"}, "textureResolution": 1024, "textureProjection": {"mode": "generated-canvas", "repeat": [1, 1], "anisotropy": 8, "texelDensityIntent": "generated CanvasTexture per material, procedural (no photo bake)"}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.414, "role": "reference-derived broad albedo and height breakup"}, {"id": "meso", "frequency": 14.0, "amplitude": 0.35, "role": "reference-derived cracks, ridges, pores, grain, or leaf clusters"}, {"id": "micro", "frequency": 72.0, "amplitude": 0.14, "role": "reference-derived micro highlight breakup under grazing light"}], "emissive": null, "emissiveIntensity": 0.0, "clearcoat": 0.0, "localOverrides": [{"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}], "notes": "satin-gloss dielectric deck laminate", "referencePbr": {"version": "1.0", "sourceImage": "/Users/jaar/conductor/workspaces/singularity/bucharest/.img2threejs-work/detail-inventory/zone-r1c1.png", "extractor": "stage1_intake/extract_pbr_evidence.py", "method": "single-image pixel evidence with de-lighting estimate; not photogrammetry", "usable": true, "verdict": "pass", "confidence": 0.86, "estimatedFidelity": 0.86, "targetThreshold": 0.5, "hardLimit": "A single image cannot uniquely recover true albedo/roughness/normal/AO; maps are reference-derived estimates.", "maps": {"albedo": {"path": "/Users/jaar/conductor/workspaces/singularity/bucharest/.img2threejs-work/pbr-evidence/consoleDeck/consoledeck_albedo.png", "url": "consoledeck_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "/Users/jaar/conductor/workspaces/singularity/bucharest/.img2threejs-work/pbr-evidence/consoleDeck/consoledeck_roughness.png", "url": "consoledeck_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "/Users/jaar/conductor/workspaces/singularity/bucharest/.img2threejs-work/pbr-evidence/consoleDeck/consoledeck_height.png", "url": "consoledeck_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "/Users/jaar/conductor/workspaces/singularity/bucharest/.img2threejs-work/pbr-evidence/consoleDeck/consoledeck_normal.png", "url": "consoledeck_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "/Users/jaar/conductor/workspaces/singularity/bucharest/.img2threejs-work/pbr-evidence/consoleDeck/consoledeck_ao.png", "url": "consoledeck_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "diagnostics": {"sourceWidth": 469, "sourceHeight": 256, "mapSize": 1024, "cropBBoxPixels": {"x": 0, "y": 0, "width": 469, "height": 256}, "mask": {"backgroundColor": "#161A1B", "backgroundNoise": 30.676, "transparentPixelFraction": 0.0, "foregroundCoverage": 0.756}, "mapStats": {"valueRange": 0.3821, "heightP90Gradient": 0.09516, "roughnessBase": 0.75, "roughnessVariation": 0.191, "normalStrength": 0.268, "blurRadius": 21}, "palette": ["#253B3B", "#18201F", "#437677", "#43524F", "#080D0C"]}, "warnings": ["single-image inverse rendering cannot prove true physical PBR; confidence is capped"]}, "normal": {"pattern": "reference-derived height-gradient normal map", "strength": 0.268, "map": {"path": "/Users/jaar/conductor/workspaces/singularity/bucharest/.img2threejs-work/pbr-evidence/consoleDeck/consoledeck_normal.png", "url": "consoledeck_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "heightSource": {"path": "/Users/jaar/conductor/workspaces/singularity/bucharest/.img2threejs-work/pbr-evidence/consoleDeck/consoledeck_height.png", "url": "consoledeck_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "space": "tangent"}, "bump": {"pattern": "reference-derived height field", "amplitude": 0.043, "map": {"path": "/Users/jaar/conductor/workspaces/singularity/bucharest/.img2threejs-work/pbr-evidence/consoleDeck/consoledeck_height.png", "url": "consoledeck_height.png", "channel": "height", "source": "reference-pixel-extraction"}}, "ambientOcclusion": {"cavityStrength": 0.38, "contactShadowBias": 0.35, "map": {"path": "/Users/jaar/conductor/workspaces/singularity/bucharest/.img2threejs-work/pbr-evidence/consoleDeck/consoledeck_ao.png", "url": "consoledeck_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}, "notes": "Reference-derived cavity estimate from local height minima; verify against grazing-light screenshot."}, "shaderNotes": ["Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps."]},
    options
  );
  materialMap["screenEmissive"] = createSculptMaterial(
    "screenEmissive",
    {"id": "screenEmissive", "name": "Screen / emblem emissive panel", "type": "physical", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#0A0F0C", "color": "#0A0F0C", "albedo": {"dominant": "#231E19", "secondary": ["#11100D", "#080503", "#4D2C1C"], "samplingNotes": "Reference-derived from foreground pixels; de-lit to reduce baked shadows/highlights.", "map": {"path": "/Users/jaar/conductor/workspaces/singularity/bucharest/.img2threejs-work/pbr-evidence/screenEmissive/screenemissive_albedo.png", "url": "screenemissive_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}}, "colorVariation": {"palette": ["#231E19", "#11100D", "#080503", "#4D2C1C", "#3C5754"], "pattern": "reference-derived pixel palette", "amplitude": 0.096, "heightCorrelation": 0.42}, "metalness": 0.4, "roughness": {"base": 0.733, "variation": 0.177, "map": {"path": "/Users/jaar/conductor/workspaces/singularity/bucharest/.img2threejs-work/pbr-evidence/screenEmissive/screenemissive_roughness.png", "url": "screenemissive_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "localResponse": "reference-derived roughness estimate; cavities and textured zones trend rougher, bright highlights trend smoother"}, "textureResolution": 1024, "textureProjection": {"mode": "generated-canvas", "repeat": [1, 1], "anisotropy": 8, "texelDensityIntent": "generated CanvasTexture per material, procedural (no photo bake)"}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.36, "role": "reference-derived broad albedo and height breakup"}, {"id": "meso", "frequency": 14.0, "amplitude": 0.35, "role": "reference-derived cracks, ridges, pores, grain, or leaf clusters"}, {"id": "micro", "frequency": 72.0, "amplitude": 0.14, "role": "reference-derived micro highlight breakup under grazing light"}], "emissive": "#52F29A", "emissiveIntensity": 1.6, "clearcoat": 0.0, "localOverrides": [{"id": "screenEmissive-hotspot", "target": "wallScreenGrid instances", "param": "emissiveIntensity", "range": [0.8, 2.4], "rule": "randomized per-instance within range, seeded, mixed mid-value cyan-green with occasional near-white hot screens"}, {"id": "screenEmissive-emblem", "target": "logoEmblemPanel", "param": "emissiveIntensity", "value": 2.0}], "notes": "near-black bezel + generated-canvas emissive inner panel; per-instance brightness/hue varied via localOverrides", "referencePbr": {"version": "1.0", "sourceImage": "/Users/jaar/conductor/workspaces/singularity/bucharest/.img2threejs-work/detail-inventory/zone-r0c0.png", "extractor": "stage1_intake/extract_pbr_evidence.py", "method": "single-image pixel evidence with de-lighting estimate; not photogrammetry", "usable": true, "verdict": "pass", "confidence": 0.846, "estimatedFidelity": 0.846, "targetThreshold": 0.5, "hardLimit": "A single image cannot uniquely recover true albedo/roughness/normal/AO; maps are reference-derived estimates.", "maps": {"albedo": {"path": "/Users/jaar/conductor/workspaces/singularity/bucharest/.img2threejs-work/pbr-evidence/screenEmissive/screenemissive_albedo.png", "url": "screenemissive_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "/Users/jaar/conductor/workspaces/singularity/bucharest/.img2threejs-work/pbr-evidence/screenEmissive/screenemissive_roughness.png", "url": "screenemissive_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "/Users/jaar/conductor/workspaces/singularity/bucharest/.img2threejs-work/pbr-evidence/screenEmissive/screenemissive_height.png", "url": "screenemissive_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "/Users/jaar/conductor/workspaces/singularity/bucharest/.img2threejs-work/pbr-evidence/screenEmissive/screenemissive_normal.png", "url": "screenemissive_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "/Users/jaar/conductor/workspaces/singularity/bucharest/.img2threejs-work/pbr-evidence/screenEmissive/screenemissive_ao.png", "url": "screenemissive_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "diagnostics": {"sourceWidth": 469, "sourceHeight": 256, "mapSize": 1024, "cropBBoxPixels": {"x": 0, "y": 0, "width": 469, "height": 256}, "mask": {"backgroundColor": "#121413", "backgroundNoise": 9.95, "transparentPixelFraction": 0.0, "foregroundCoverage": 0.5113}, "mapStats": {"valueRange": 0.2278, "heightP90Gradient": 0.08494, "roughnessBase": 0.733, "roughnessVariation": 0.177, "normalStrength": 0.256, "blurRadius": 21}, "palette": ["#231E19", "#11100D", "#080503", "#4D2C1C", "#3C5754"]}, "warnings": ["single-image inverse rendering cannot prove true physical PBR; confidence is capped", "low value range weakens height/roughness inference"]}, "normal": {"pattern": "reference-derived height-gradient normal map", "strength": 0.256, "map": {"path": "/Users/jaar/conductor/workspaces/singularity/bucharest/.img2threejs-work/pbr-evidence/screenEmissive/screenemissive_normal.png", "url": "screenemissive_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "heightSource": {"path": "/Users/jaar/conductor/workspaces/singularity/bucharest/.img2threejs-work/pbr-evidence/screenEmissive/screenemissive_height.png", "url": "screenemissive_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "space": "tangent"}, "bump": {"pattern": "reference-derived height field", "amplitude": 0.038, "map": {"path": "/Users/jaar/conductor/workspaces/singularity/bucharest/.img2threejs-work/pbr-evidence/screenEmissive/screenemissive_height.png", "url": "screenemissive_height.png", "channel": "height", "source": "reference-pixel-extraction"}}, "ambientOcclusion": {"cavityStrength": 0.38, "contactShadowBias": 0.35, "map": {"path": "/Users/jaar/conductor/workspaces/singularity/bucharest/.img2threejs-work/pbr-evidence/screenEmissive/screenemissive_ao.png", "url": "screenemissive_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}, "notes": "Reference-derived cavity estimate from local height minima; verify against grazing-light screenshot."}, "shaderNotes": ["Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps."]},
    options
  );
  materialMap["pitGlass"] = createSculptMaterial(
    "pitGlass",
    {"id": "pitGlass", "name": "Floor-pit glossy composite", "type": "physical", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#04100E", "color": "#04100E", "albedo": {"dominant": "#2B3532", "secondary": ["#3B4741", "#1C221E", "#080C0A"], "samplingNotes": "Reference-derived from foreground pixels; de-lit to reduce baked shadows/highlights.", "map": {"path": "/Users/jaar/conductor/workspaces/singularity/bucharest/.img2threejs-work/pbr-evidence/pitGlass/pitglass_albedo.png", "url": "pitglass_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}}, "colorVariation": {"palette": ["#2B3532", "#3B4741", "#1C221E", "#080C0A", "#6B7A6E"], "pattern": "reference-derived pixel palette", "amplitude": 0.163, "heightCorrelation": 0.42}, "metalness": 0.05, "roughness": {"base": 0.728, "variation": 0.156, "map": {"path": "/Users/jaar/conductor/workspaces/singularity/bucharest/.img2threejs-work/pbr-evidence/pitGlass/pitglass_roughness.png", "url": "pitglass_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "localResponse": "reference-derived roughness estimate; cavities and textured zones trend rougher, bright highlights trend smoother"}, "textureResolution": 1024, "textureProjection": {"mode": "generated-canvas", "repeat": [1, 1], "anisotropy": 8, "texelDensityIntent": "generated CanvasTexture per material, procedural (no photo bake)"}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.416, "role": "reference-derived broad albedo and height breakup"}, {"id": "meso", "frequency": 14.0, "amplitude": 0.35, "role": "reference-derived cracks, ridges, pores, grain, or leaf clusters"}, {"id": "micro", "frequency": 72.0, "amplitude": 0.14, "role": "reference-derived micro highlight breakup under grazing light"}], "emissive": null, "emissiveIntensity": 0.0, "clearcoat": 0.6, "localOverrides": [{"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}], "notes": "glossy-dark dielectric, faint reflective cue on the inner slope facets", "referencePbr": {"version": "1.0", "sourceImage": "/Users/jaar/conductor/workspaces/singularity/bucharest/.img2threejs-work/detail-inventory/zone-r2c1.png", "extractor": "stage1_intake/extract_pbr_evidence.py", "method": "single-image pixel evidence with de-lighting estimate; not photogrammetry", "usable": true, "verdict": "pass", "confidence": 0.86, "estimatedFidelity": 0.86, "targetThreshold": 0.5, "hardLimit": "A single image cannot uniquely recover true albedo/roughness/normal/AO; maps are reference-derived estimates.", "maps": {"albedo": {"path": "/Users/jaar/conductor/workspaces/singularity/bucharest/.img2threejs-work/pbr-evidence/pitGlass/pitglass_albedo.png", "url": "pitglass_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "/Users/jaar/conductor/workspaces/singularity/bucharest/.img2threejs-work/pbr-evidence/pitGlass/pitglass_roughness.png", "url": "pitglass_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "/Users/jaar/conductor/workspaces/singularity/bucharest/.img2threejs-work/pbr-evidence/pitGlass/pitglass_height.png", "url": "pitglass_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "/Users/jaar/conductor/workspaces/singularity/bucharest/.img2threejs-work/pbr-evidence/pitGlass/pitglass_normal.png", "url": "pitglass_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "/Users/jaar/conductor/workspaces/singularity/bucharest/.img2threejs-work/pbr-evidence/pitGlass/pitglass_ao.png", "url": "pitglass_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "diagnostics": {"sourceWidth": 469, "sourceHeight": 256, "mapSize": 1024, "cropBBoxPixels": {"x": 0, "y": 0, "width": 469, "height": 256}, "mask": {"backgroundColor": "#0E1313", "backgroundNoise": 47.927, "transparentPixelFraction": 0.0, "foregroundCoverage": 0.5937}, "mapStats": {"valueRange": 0.3891, "heightP90Gradient": 0.07865, "roughnessBase": 0.728, "roughnessVariation": 0.156, "normalStrength": 0.248, "blurRadius": 21}, "palette": ["#2B3532", "#3B4741", "#1C221E", "#080C0A", "#6B7A6E"]}, "warnings": ["single-image inverse rendering cannot prove true physical PBR; confidence is capped"]}, "normal": {"pattern": "reference-derived height-gradient normal map", "strength": 0.248, "map": {"path": "/Users/jaar/conductor/workspaces/singularity/bucharest/.img2threejs-work/pbr-evidence/pitGlass/pitglass_normal.png", "url": "pitglass_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "heightSource": {"path": "/Users/jaar/conductor/workspaces/singularity/bucharest/.img2threejs-work/pbr-evidence/pitGlass/pitglass_height.png", "url": "pitglass_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "space": "tangent"}, "bump": {"pattern": "reference-derived height field", "amplitude": 0.035, "map": {"path": "/Users/jaar/conductor/workspaces/singularity/bucharest/.img2threejs-work/pbr-evidence/pitGlass/pitglass_height.png", "url": "pitglass_height.png", "channel": "height", "source": "reference-pixel-extraction"}}, "ambientOcclusion": {"cavityStrength": 0.38, "contactShadowBias": 0.35, "map": {"path": "/Users/jaar/conductor/workspaces/singularity/bucharest/.img2threejs-work/pbr-evidence/pitGlass/pitglass_ao.png", "url": "pitglass_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}, "notes": "Reference-derived cavity estimate from local height minima; verify against grazing-light screenshot."}, "shaderNotes": ["Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps."]},
    options
  );
  materialMap["darkMatte"] = createSculptMaterial(
    "darkMatte",
    {"id": "darkMatte", "name": "Dark matte (chairs / cart bodies)", "type": "standard", "shaderModel": "MeshStandardMaterial", "baseColor": "#15181A", "color": "#15181A", "albedo": {"dominant": "#253B3B", "secondary": ["#18201F", "#437677", "#43524F"], "samplingNotes": "Reference-derived from foreground pixels; de-lit to reduce baked shadows/highlights.", "map": {"path": "/Users/jaar/conductor/workspaces/singularity/bucharest/.img2threejs-work/pbr-evidence/darkMatte/darkmatte_albedo.png", "url": "darkmatte_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}}, "colorVariation": {"palette": ["#253B3B", "#18201F", "#437677", "#43524F", "#080D0C"], "pattern": "reference-derived pixel palette", "amplitude": 0.16, "heightCorrelation": 0.42}, "metalness": 0.05, "roughness": {"base": 0.75, "variation": 0.191, "map": {"path": "/Users/jaar/conductor/workspaces/singularity/bucharest/.img2threejs-work/pbr-evidence/darkMatte/darkmatte_roughness.png", "url": "darkmatte_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "localResponse": "reference-derived roughness estimate; cavities and textured zones trend rougher, bright highlights trend smoother"}, "textureResolution": 1024, "textureProjection": {"mode": "generated-canvas", "repeat": [1, 1], "anisotropy": 8, "texelDensityIntent": "generated CanvasTexture per material, procedural (no photo bake)"}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.414, "role": "reference-derived broad albedo and height breakup"}, {"id": "meso", "frequency": 14.0, "amplitude": 0.35, "role": "reference-derived cracks, ridges, pores, grain, or leaf clusters"}, {"id": "micro", "frequency": 72.0, "amplitude": 0.14, "role": "reference-derived micro highlight breakup under grazing light"}], "emissive": null, "emissiveIntensity": 0.0, "clearcoat": 0.0, "localOverrides": [{"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}], "notes": "matte fabric/plastic for task chairs and satellite cart bodies", "referencePbr": {"version": "1.0", "sourceImage": "/Users/jaar/conductor/workspaces/singularity/bucharest/.img2threejs-work/detail-inventory/zone-r1c1.png", "extractor": "stage1_intake/extract_pbr_evidence.py", "method": "single-image pixel evidence with de-lighting estimate; not photogrammetry", "usable": true, "verdict": "pass", "confidence": 0.86, "estimatedFidelity": 0.86, "targetThreshold": 0.4, "hardLimit": "A single image cannot uniquely recover true albedo/roughness/normal/AO; maps are reference-derived estimates.", "maps": {"albedo": {"path": "/Users/jaar/conductor/workspaces/singularity/bucharest/.img2threejs-work/pbr-evidence/darkMatte/darkmatte_albedo.png", "url": "darkmatte_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "/Users/jaar/conductor/workspaces/singularity/bucharest/.img2threejs-work/pbr-evidence/darkMatte/darkmatte_roughness.png", "url": "darkmatte_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "/Users/jaar/conductor/workspaces/singularity/bucharest/.img2threejs-work/pbr-evidence/darkMatte/darkmatte_height.png", "url": "darkmatte_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "/Users/jaar/conductor/workspaces/singularity/bucharest/.img2threejs-work/pbr-evidence/darkMatte/darkmatte_normal.png", "url": "darkmatte_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "/Users/jaar/conductor/workspaces/singularity/bucharest/.img2threejs-work/pbr-evidence/darkMatte/darkmatte_ao.png", "url": "darkmatte_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "diagnostics": {"sourceWidth": 469, "sourceHeight": 256, "mapSize": 1024, "cropBBoxPixels": {"x": 0, "y": 0, "width": 469, "height": 256}, "mask": {"backgroundColor": "#161A1B", "backgroundNoise": 30.676, "transparentPixelFraction": 0.0, "foregroundCoverage": 0.756}, "mapStats": {"valueRange": 0.3821, "heightP90Gradient": 0.09516, "roughnessBase": 0.75, "roughnessVariation": 0.191, "normalStrength": 0.268, "blurRadius": 21}, "palette": ["#253B3B", "#18201F", "#437677", "#43524F", "#080D0C"]}, "warnings": ["single-image inverse rendering cannot prove true physical PBR; confidence is capped"]}, "normal": {"pattern": "reference-derived height-gradient normal map", "strength": 0.268, "map": {"path": "/Users/jaar/conductor/workspaces/singularity/bucharest/.img2threejs-work/pbr-evidence/darkMatte/darkmatte_normal.png", "url": "darkmatte_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "heightSource": {"path": "/Users/jaar/conductor/workspaces/singularity/bucharest/.img2threejs-work/pbr-evidence/darkMatte/darkmatte_height.png", "url": "darkmatte_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "space": "tangent"}, "bump": {"pattern": "reference-derived height field", "amplitude": 0.043, "map": {"path": "/Users/jaar/conductor/workspaces/singularity/bucharest/.img2threejs-work/pbr-evidence/darkMatte/darkmatte_height.png", "url": "darkmatte_height.png", "channel": "height", "source": "reference-pixel-extraction"}}, "ambientOcclusion": {"cavityStrength": 0.38, "contactShadowBias": 0.35, "map": {"path": "/Users/jaar/conductor/workspaces/singularity/bucharest/.img2threejs-work/pbr-evidence/darkMatte/darkmatte_ao.png", "url": "darkmatte_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}, "notes": "Reference-derived cavity estimate from local height minima; verify against grazing-light screenshot."}, "shaderNotes": ["Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps."]},
    options
  );

  const nodes: Record<string, THREE.Object3D> = { root };
  const meshes: Record<string, THREE.Mesh> = {};
  const sockets: Record<string, THREE.Object3D> = {};
  const colliders: Record<string, unknown> = {};
  const destructionGroups: Record<string, THREE.Object3D[]> = {};

  const attachment_root_0 = null;
  const endpoint_root_0 = makeAttachmentEndpoint(attachment_root_0);
  const node_root_0 = new THREE.Group();
  node_root_0.name = "NERV-style Tactical Command Room__pivot";
  if (endpoint_root_0) {
    node_root_0.position.copy(endpoint_root_0.start);
    node_root_0.rotation.set(0, 0, 0);
    node_root_0.scale.set(1, 1, 1);
  } else {
    node_root_0.position.set(0.0, 0.0, 0.0);
    node_root_0.rotation.set(0.0, 0.0, 0.0);
    node_root_0.scale.set(1.0, 1.0, 1.0);
  }
  node_root_0.userData.sculptComponent = {"id": "root", "name": "NERV-style Tactical Command Room", "level": "macro", "role": "body", "importance": 1.0, "confidence": 0.7, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Top-level Group; not a single mesh -- pure organizational root for the whole composite set.", "geometryDescriptor": {"topologyIntent": "macro-scale box block, chamfer-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.02, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": null, "attachment": null, "dimensions": {"width": 14.0, "height": 11.0, "depth": 14.0, "units": "meters", "confidence": 0.7}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-structure", "pivot": {"mode": "base", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "simplified box proxy; static set-dressing does not need a tight collider"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "structuralSteel"}}, "material": "structuralSteel", "materialLayers": ["structuralSteel"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.5, "microRoughness": 0.3, "bumpAmplitude": 0.02, "normalPattern": "panel-seam", "displacementPattern": "", "occlusionPattern": "cavity darkening at seams", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["image-analysis.md#layer-3", "di.json"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(58, 66, 73, 1.0)", "secondaryAlbedo": "rgba(10, 15, 12, 0.85)", "materialClass": "unknown", "materialClassConfidence": 0.4, "notes": "organizational root Group; not an independently textured surface"}};
  node_root_0.userData.actionProfile = {"animationRole": "static-structure", "pivot": {"mode": "base", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "simplified box proxy; static set-dressing does not need a tight collider"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "structuralSteel"}};
  (nodes["root"] ?? root).add(node_root_0);
  nodes["root"] = node_root_0;
  const mesh_root_0Geometry = endpoint_root_0
    ? new THREE.CylinderGeometry(endpoint_root_0.endRadius, endpoint_root_0.baseRadius, endpoint_root_0.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  const mesh_root_0 = new THREE.Mesh(
    mesh_root_0Geometry,
    materialMap["structuralSteel"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_root_0.name = "NERV-style Tactical Command Room";
  if (endpoint_root_0) {
    mesh_root_0.position.copy(endpoint_root_0.midpoint);
    mesh_root_0.quaternion.copy(endpoint_root_0.quaternion);
  }
  mesh_root_0.castShadow = options.castShadow ?? true;
  mesh_root_0.receiveShadow = options.receiveShadow ?? true;
  mesh_root_0.userData.sculptComponent = {"id": "root", "name": "NERV-style Tactical Command Room", "level": "macro", "role": "body", "importance": 1.0, "confidence": 0.7, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Top-level Group; not a single mesh -- pure organizational root for the whole composite set.", "geometryDescriptor": {"topologyIntent": "macro-scale box block, chamfer-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.02, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": null, "attachment": null, "dimensions": {"width": 14.0, "height": 11.0, "depth": 14.0, "units": "meters", "confidence": 0.7}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-structure", "pivot": {"mode": "base", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "simplified box proxy; static set-dressing does not need a tight collider"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "structuralSteel"}}, "material": "structuralSteel", "materialLayers": ["structuralSteel"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.5, "microRoughness": 0.3, "bumpAmplitude": 0.02, "normalPattern": "panel-seam", "displacementPattern": "", "occlusionPattern": "cavity darkening at seams", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["image-analysis.md#layer-3", "di.json"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(58, 66, 73, 1.0)", "secondaryAlbedo": "rgba(10, 15, 12, 0.85)", "materialClass": "unknown", "materialClassConfidence": 0.4, "notes": "organizational root Group; not an independently textured surface"}};
  node_root_0.add(mesh_root_0);
  meshes["root"] = mesh_root_0;
  colliders["root"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "simplified box proxy; static set-dressing does not need a tight collider"};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_root_0);

  const attachment_roomShell_1 = null;
  const endpoint_roomShell_1 = makeAttachmentEndpoint(attachment_roomShell_1);
  const node_roomShell_1 = new THREE.Group();
  node_roomShell_1.name = "Room shell (floor + rear/side structure)__pivot";
  if (endpoint_roomShell_1) {
    node_roomShell_1.position.copy(endpoint_roomShell_1.start);
    node_roomShell_1.rotation.set(0, 0, 0);
    node_roomShell_1.scale.set(1, 1, 1);
  } else {
    node_roomShell_1.position.set(0.0, -0.2, 0.0);
    node_roomShell_1.rotation.set(0.0, 0.0, 0.0);
    node_roomShell_1.scale.set(1.0, 1.0, 1.0);
  }
  node_roomShell_1.userData.sculptComponent = {"id": "roomShell", "name": "Room shell (floor + rear/side structure)", "level": "macro", "role": "structural", "importance": 0.7, "confidence": 0.6, "primitive": "box", "topologyClass": "conforming-shell", "topologyRationale": "Open-top, open-front rectangular shell inferred from the dollhouse-cutaway framing; back/ceiling/camera-side walls are the unresolved sides flagged in Layer 8 and are intentionally omitted rather than invented. (topologyClass normalized to the spec's fixed enum.)", "geometryDescriptor": {"topologyIntent": "macro-scale box block, chamfer-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.02, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 14.0, "height": 0.4, "depth": 14.0, "units": "meters", "confidence": 0.6}, "transform": {"position": [0, -0.2, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-structure", "pivot": {"mode": "base", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "simplified box proxy; static set-dressing does not need a tight collider"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "roomShell", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "structuralSteel"}}, "material": "structuralSteel", "materialLayers": ["structuralSteel"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "det-structural-column-panel-seam", "description": "tileable riveted/paneled plate-seam normal detail"}], "surfaceDetail": {"macroRoughness": 0.5, "microRoughness": 0.3, "bumpAmplitude": 0.02, "normalPattern": "panel-seam", "displacementPattern": "", "occlusionPattern": "cavity darkening at seams", "edgeWearPattern": "", "notes": "floor slab only; walls represented by the flanking macro parts (monitor towers, columns) rather than a literal box wall"}, "evidenceRefs": ["image-analysis.md#layer-3", "di.json"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(58, 66, 73, 1.0)", "secondaryAlbedo": "rgba(10, 15, 12, 0.85)", "materialClass": "metal", "materialClassConfidence": 0.65, "notes": "derived from material 'structuralSteel' baseColor + di.json zone evidence"}};
  node_roomShell_1.userData.actionProfile = {"animationRole": "static-structure", "pivot": {"mode": "base", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "simplified box proxy; static set-dressing does not need a tight collider"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "roomShell", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "structuralSteel"}};
  (nodes["root"] ?? root).add(node_roomShell_1);
  nodes["roomShell"] = node_roomShell_1;
  const mesh_roomShell_1Geometry = endpoint_roomShell_1
    ? new THREE.CylinderGeometry(endpoint_roomShell_1.endRadius, endpoint_roomShell_1.baseRadius, endpoint_roomShell_1.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  const mesh_roomShell_1 = new THREE.Mesh(
    mesh_roomShell_1Geometry,
    materialMap["structuralSteel"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_roomShell_1.name = "Room shell (floor + rear/side structure)";
  if (endpoint_roomShell_1) {
    mesh_roomShell_1.position.copy(endpoint_roomShell_1.midpoint);
    mesh_roomShell_1.quaternion.copy(endpoint_roomShell_1.quaternion);
  }
  mesh_roomShell_1.castShadow = options.castShadow ?? true;
  mesh_roomShell_1.receiveShadow = options.receiveShadow ?? true;
  mesh_roomShell_1.userData.sculptComponent = {"id": "roomShell", "name": "Room shell (floor + rear/side structure)", "level": "macro", "role": "structural", "importance": 0.7, "confidence": 0.6, "primitive": "box", "topologyClass": "conforming-shell", "topologyRationale": "Open-top, open-front rectangular shell inferred from the dollhouse-cutaway framing; back/ceiling/camera-side walls are the unresolved sides flagged in Layer 8 and are intentionally omitted rather than invented. (topologyClass normalized to the spec's fixed enum.)", "geometryDescriptor": {"topologyIntent": "macro-scale box block, chamfer-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.02, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 14.0, "height": 0.4, "depth": 14.0, "units": "meters", "confidence": 0.6}, "transform": {"position": [0, -0.2, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-structure", "pivot": {"mode": "base", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "simplified box proxy; static set-dressing does not need a tight collider"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "roomShell", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "structuralSteel"}}, "material": "structuralSteel", "materialLayers": ["structuralSteel"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "det-structural-column-panel-seam", "description": "tileable riveted/paneled plate-seam normal detail"}], "surfaceDetail": {"macroRoughness": 0.5, "microRoughness": 0.3, "bumpAmplitude": 0.02, "normalPattern": "panel-seam", "displacementPattern": "", "occlusionPattern": "cavity darkening at seams", "edgeWearPattern": "", "notes": "floor slab only; walls represented by the flanking macro parts (monitor towers, columns) rather than a literal box wall"}, "evidenceRefs": ["image-analysis.md#layer-3", "di.json"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(58, 66, 73, 1.0)", "secondaryAlbedo": "rgba(10, 15, 12, 0.85)", "materialClass": "metal", "materialClassConfidence": 0.65, "notes": "derived from material 'structuralSteel' baseColor + di.json zone evidence"}};
  node_roomShell_1.add(mesh_roomShell_1);
  meshes["roomShell"] = mesh_roomShell_1;
  colliders["roomShell"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "simplified box proxy; static set-dressing does not need a tight collider"};
  destructionGroups["roomShell"] ??= [];
  destructionGroups["roomShell"].push(node_roomShell_1);

  const attachment_centralDais_2 = null;
  const endpoint_centralDais_2 = makeAttachmentEndpoint(attachment_centralDais_2);
  const node_centralDais_2 = new THREE.Group();
  node_centralDais_2.name = "Central raised command dais__pivot";
  if (endpoint_centralDais_2) {
    node_centralDais_2.position.copy(endpoint_centralDais_2.start);
    node_centralDais_2.rotation.set(0, 0, 0);
    node_centralDais_2.scale.set(1, 1, 1);
  } else {
    node_centralDais_2.position.set(0.0, 0.55, 0.6);
    node_centralDais_2.rotation.set(0.0, 0.0, 0.0);
    node_centralDais_2.scale.set(1.0, 1.0, 1.0);
  }
  node_centralDais_2.userData.sculptComponent = {"id": "centralDais", "name": "Central raised command dais", "level": "macro", "role": "body", "importance": 1.0, "confidence": 0.75, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "Bevelled octagonal deck read directly off the silhouette (Layer 2) -- an extruded octagon profile with a chamfered top edge, not a boolean-cut box. (topologyClass normalized to the spec's fixed enum.)", "geometryDescriptor": {"topologyIntent": "macro-scale extrude block, chamfer-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.02, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 6.4, "height": 1.1, "depth": 4.6, "units": "meters", "confidence": 0.75}, "transform": {"position": [0, 0.55, 0.6], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-structure", "pivot": {"mode": "base", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "simplified box proxy; static set-dressing does not need a tight collider"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "centralDais", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "consoleDeck"}}, "material": "consoleDeck", "materialLayers": ["consoleDeck"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "det-dais-guardrail-lip", "description": "raised bevelled guard-rail lip around the octagonal deck edge"}], "surfaceDetail": {"macroRoughness": 0.5, "microRoughness": 0.3, "bumpAmplitude": 0.02, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "cavity darkening at seams", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["image-analysis.md#layer-3", "di.json"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(46, 111, 107, 1.0)", "secondaryAlbedo": "rgba(46, 111, 107, 0.85)", "materialClass": "plastic", "materialClassConfidence": 0.65, "notes": "derived from material 'consoleDeck' baseColor + di.json zone evidence"}};
  node_centralDais_2.userData.actionProfile = {"animationRole": "static-structure", "pivot": {"mode": "base", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "simplified box proxy; static set-dressing does not need a tight collider"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "centralDais", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "consoleDeck"}};
  (nodes["root"] ?? root).add(node_centralDais_2);
  nodes["centralDais"] = node_centralDais_2;
  const mesh_centralDais_2Geometry = endpoint_centralDais_2
    ? new THREE.CylinderGeometry(endpoint_centralDais_2.endRadius, endpoint_centralDais_2.baseRadius, endpoint_centralDais_2.length, 32, 12)
    : buildExtrudeGeometry({"points": [[-0.3, -0.3], [0.3, -0.3], [0.3, 0.3], [-0.3, 0.3]], "depth": 0.1});
  const mesh_centralDais_2 = new THREE.Mesh(
    mesh_centralDais_2Geometry,
    materialMap["consoleDeck"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_centralDais_2.name = "Central raised command dais";
  if (endpoint_centralDais_2) {
    mesh_centralDais_2.position.copy(endpoint_centralDais_2.midpoint);
    mesh_centralDais_2.quaternion.copy(endpoint_centralDais_2.quaternion);
  }
  mesh_centralDais_2.castShadow = options.castShadow ?? true;
  mesh_centralDais_2.receiveShadow = options.receiveShadow ?? true;
  mesh_centralDais_2.userData.sculptComponent = {"id": "centralDais", "name": "Central raised command dais", "level": "macro", "role": "body", "importance": 1.0, "confidence": 0.75, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "Bevelled octagonal deck read directly off the silhouette (Layer 2) -- an extruded octagon profile with a chamfered top edge, not a boolean-cut box. (topologyClass normalized to the spec's fixed enum.)", "geometryDescriptor": {"topologyIntent": "macro-scale extrude block, chamfer-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.02, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 6.4, "height": 1.1, "depth": 4.6, "units": "meters", "confidence": 0.75}, "transform": {"position": [0, 0.55, 0.6], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-structure", "pivot": {"mode": "base", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "simplified box proxy; static set-dressing does not need a tight collider"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "centralDais", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "consoleDeck"}}, "material": "consoleDeck", "materialLayers": ["consoleDeck"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "det-dais-guardrail-lip", "description": "raised bevelled guard-rail lip around the octagonal deck edge"}], "surfaceDetail": {"macroRoughness": 0.5, "microRoughness": 0.3, "bumpAmplitude": 0.02, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "cavity darkening at seams", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["image-analysis.md#layer-3", "di.json"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(46, 111, 107, 1.0)", "secondaryAlbedo": "rgba(46, 111, 107, 0.85)", "materialClass": "plastic", "materialClassConfidence": 0.65, "notes": "derived from material 'consoleDeck' baseColor + di.json zone evidence"}};
  node_centralDais_2.add(mesh_centralDais_2);
  meshes["centralDais"] = mesh_centralDais_2;
  colliders["centralDais"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "simplified box proxy; static set-dressing does not need a tight collider"};
  destructionGroups["centralDais"] ??= [];
  destructionGroups["centralDais"].push(node_centralDais_2);

  const attachment_logoMonument_3 = null;
  const endpoint_logoMonument_3 = makeAttachmentEndpoint(attachment_logoMonument_3);
  const node_logoMonument_3 = new THREE.Group();
  node_logoMonument_3.name = "Central logo monument__pivot";
  if (endpoint_logoMonument_3) {
    node_logoMonument_3.position.copy(endpoint_logoMonument_3.start);
    node_logoMonument_3.rotation.set(0, 0, 0);
    node_logoMonument_3.scale.set(1, 1, 1);
  } else {
    node_logoMonument_3.position.set(0.0, 3.8, -3.8);
    node_logoMonument_3.rotation.set(0.0, 0.0, 0.0);
    node_logoMonument_3.scale.set(1.0, 1.0, 1.0);
  }
  node_logoMonument_3.userData.sculptComponent = {"id": "logoMonument", "name": "Central logo monument", "level": "macro", "role": "structural", "importance": 0.85, "confidence": 0.65, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Tall plinth+shaft+backlit-panel stack directly behind the dais; the emblem itself is authored generic/abstract per the projection-route skip reason (no reproduction of the source mark).", "geometryDescriptor": {"topologyIntent": "macro-scale box block, chamfer-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.02, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 2.6, "height": 6.5, "depth": 1.4, "units": "meters", "confidence": 0.65}, "transform": {"position": [0, 3.8, -3.8], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-structure", "pivot": {"mode": "base", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "simplified box proxy; static set-dressing does not need a tight collider"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "logoMonument", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "structuralSteel"}}, "material": "structuralSteel", "materialLayers": ["structuralSteel"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "det-logo-emblem-glyph", "description": "abstract angular emissive emblem + text plate, generic (non-reproduction)"}], "surfaceDetail": {"macroRoughness": 0.5, "microRoughness": 0.3, "bumpAmplitude": 0.02, "normalPattern": "panel-seam", "displacementPattern": "", "occlusionPattern": "cavity darkening at seams", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["image-analysis.md#layer-3", "di.json"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(58, 66, 73, 1.0)", "secondaryAlbedo": "rgba(10, 15, 12, 0.85)", "materialClass": "metal", "materialClassConfidence": 0.65, "notes": "derived from material 'structuralSteel' baseColor + di.json zone evidence"}};
  node_logoMonument_3.userData.actionProfile = {"animationRole": "static-structure", "pivot": {"mode": "base", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "simplified box proxy; static set-dressing does not need a tight collider"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "logoMonument", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "structuralSteel"}};
  (nodes["root"] ?? root).add(node_logoMonument_3);
  nodes["logoMonument"] = node_logoMonument_3;
  const mesh_logoMonument_3Geometry = endpoint_logoMonument_3
    ? new THREE.CylinderGeometry(endpoint_logoMonument_3.endRadius, endpoint_logoMonument_3.baseRadius, endpoint_logoMonument_3.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  const mesh_logoMonument_3 = new THREE.Mesh(
    mesh_logoMonument_3Geometry,
    materialMap["structuralSteel"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_logoMonument_3.name = "Central logo monument";
  if (endpoint_logoMonument_3) {
    mesh_logoMonument_3.position.copy(endpoint_logoMonument_3.midpoint);
    mesh_logoMonument_3.quaternion.copy(endpoint_logoMonument_3.quaternion);
  }
  mesh_logoMonument_3.castShadow = options.castShadow ?? true;
  mesh_logoMonument_3.receiveShadow = options.receiveShadow ?? true;
  mesh_logoMonument_3.userData.sculptComponent = {"id": "logoMonument", "name": "Central logo monument", "level": "macro", "role": "structural", "importance": 0.85, "confidence": 0.65, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Tall plinth+shaft+backlit-panel stack directly behind the dais; the emblem itself is authored generic/abstract per the projection-route skip reason (no reproduction of the source mark).", "geometryDescriptor": {"topologyIntent": "macro-scale box block, chamfer-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.02, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 2.6, "height": 6.5, "depth": 1.4, "units": "meters", "confidence": 0.65}, "transform": {"position": [0, 3.8, -3.8], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-structure", "pivot": {"mode": "base", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "simplified box proxy; static set-dressing does not need a tight collider"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "logoMonument", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "structuralSteel"}}, "material": "structuralSteel", "materialLayers": ["structuralSteel"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "det-logo-emblem-glyph", "description": "abstract angular emissive emblem + text plate, generic (non-reproduction)"}], "surfaceDetail": {"macroRoughness": 0.5, "microRoughness": 0.3, "bumpAmplitude": 0.02, "normalPattern": "panel-seam", "displacementPattern": "", "occlusionPattern": "cavity darkening at seams", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["image-analysis.md#layer-3", "di.json"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(58, 66, 73, 1.0)", "secondaryAlbedo": "rgba(10, 15, 12, 0.85)", "materialClass": "metal", "materialClassConfidence": 0.65, "notes": "derived from material 'structuralSteel' baseColor + di.json zone evidence"}};
  node_logoMonument_3.add(mesh_logoMonument_3);
  meshes["logoMonument"] = mesh_logoMonument_3;
  colliders["logoMonument"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "simplified box proxy; static set-dressing does not need a tight collider"};
  destructionGroups["logoMonument"] ??= [];
  destructionGroups["logoMonument"].push(node_logoMonument_3);

  const attachment_viceCommandPlatform_left_4 = null;
  const endpoint_viceCommandPlatform_left_4 = makeAttachmentEndpoint(attachment_viceCommandPlatform_left_4);
  const node_viceCommandPlatform_left_4 = new THREE.Group();
  node_viceCommandPlatform_left_4.name = "Vice-command platform (left)__pivot";
  if (endpoint_viceCommandPlatform_left_4) {
    node_viceCommandPlatform_left_4.position.copy(endpoint_viceCommandPlatform_left_4.start);
    node_viceCommandPlatform_left_4.rotation.set(0, 0, 0);
    node_viceCommandPlatform_left_4.scale.set(1, 1, 1);
  } else {
    node_viceCommandPlatform_left_4.position.set(-5.6, 0.35, 3.6);
    node_viceCommandPlatform_left_4.rotation.set(0.0, 0.0, 0.0);
    node_viceCommandPlatform_left_4.scale.set(1.0, 1.0, 1.0);
  }
  node_viceCommandPlatform_left_4.userData.sculptComponent = {"id": "viceCommandPlatform.left", "name": "Vice-command platform (left)", "level": "macro", "role": "structural", "importance": 0.55, "confidence": 0.6, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "Lower-tier bevelled rounded-rect platform, mirrors the dais language at smaller scale. (topologyClass normalized to the spec's fixed enum.)", "geometryDescriptor": {"topologyIntent": "macro-scale extrude block, chamfer-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.02, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 2.6, "height": 0.7, "depth": 2.2, "units": "meters", "confidence": 0.6}, "transform": {"position": [-5.6, 0.35, 3.6], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-structure", "pivot": {"mode": "base", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "simplified box proxy; static set-dressing does not need a tight collider"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "viceCommandPlatform.left", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "consoleDeck"}}, "material": "consoleDeck", "materialLayers": ["consoleDeck"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "det-vice-command-desk-wing", "description": "winged desk silhouette flanking a smaller centered console"}], "surfaceDetail": {"macroRoughness": 0.5, "microRoughness": 0.3, "bumpAmplitude": 0.02, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "cavity darkening at seams", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["image-analysis.md#layer-3", "di.json"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(46, 111, 107, 1.0)", "secondaryAlbedo": "rgba(46, 111, 107, 0.85)", "materialClass": "plastic", "materialClassConfidence": 0.65, "notes": "derived from material 'consoleDeck' baseColor + di.json zone evidence"}};
  node_viceCommandPlatform_left_4.userData.actionProfile = {"animationRole": "static-structure", "pivot": {"mode": "base", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "simplified box proxy; static set-dressing does not need a tight collider"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "viceCommandPlatform.left", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "consoleDeck"}};
  (nodes["root"] ?? root).add(node_viceCommandPlatform_left_4);
  nodes["viceCommandPlatform.left"] = node_viceCommandPlatform_left_4;
  const mesh_viceCommandPlatform_left_4Geometry = endpoint_viceCommandPlatform_left_4
    ? new THREE.CylinderGeometry(endpoint_viceCommandPlatform_left_4.endRadius, endpoint_viceCommandPlatform_left_4.baseRadius, endpoint_viceCommandPlatform_left_4.length, 32, 12)
    : buildExtrudeGeometry({"points": [[-0.3, -0.3], [0.3, -0.3], [0.3, 0.3], [-0.3, 0.3]], "depth": 0.1});
  const mesh_viceCommandPlatform_left_4 = new THREE.Mesh(
    mesh_viceCommandPlatform_left_4Geometry,
    materialMap["consoleDeck"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_viceCommandPlatform_left_4.name = "Vice-command platform (left)";
  if (endpoint_viceCommandPlatform_left_4) {
    mesh_viceCommandPlatform_left_4.position.copy(endpoint_viceCommandPlatform_left_4.midpoint);
    mesh_viceCommandPlatform_left_4.quaternion.copy(endpoint_viceCommandPlatform_left_4.quaternion);
  }
  mesh_viceCommandPlatform_left_4.castShadow = options.castShadow ?? true;
  mesh_viceCommandPlatform_left_4.receiveShadow = options.receiveShadow ?? true;
  mesh_viceCommandPlatform_left_4.userData.sculptComponent = {"id": "viceCommandPlatform.left", "name": "Vice-command platform (left)", "level": "macro", "role": "structural", "importance": 0.55, "confidence": 0.6, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "Lower-tier bevelled rounded-rect platform, mirrors the dais language at smaller scale. (topologyClass normalized to the spec's fixed enum.)", "geometryDescriptor": {"topologyIntent": "macro-scale extrude block, chamfer-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.02, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 2.6, "height": 0.7, "depth": 2.2, "units": "meters", "confidence": 0.6}, "transform": {"position": [-5.6, 0.35, 3.6], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-structure", "pivot": {"mode": "base", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "simplified box proxy; static set-dressing does not need a tight collider"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "viceCommandPlatform.left", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "consoleDeck"}}, "material": "consoleDeck", "materialLayers": ["consoleDeck"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "det-vice-command-desk-wing", "description": "winged desk silhouette flanking a smaller centered console"}], "surfaceDetail": {"macroRoughness": 0.5, "microRoughness": 0.3, "bumpAmplitude": 0.02, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "cavity darkening at seams", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["image-analysis.md#layer-3", "di.json"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(46, 111, 107, 1.0)", "secondaryAlbedo": "rgba(46, 111, 107, 0.85)", "materialClass": "plastic", "materialClassConfidence": 0.65, "notes": "derived from material 'consoleDeck' baseColor + di.json zone evidence"}};
  node_viceCommandPlatform_left_4.add(mesh_viceCommandPlatform_left_4);
  meshes["viceCommandPlatform.left"] = mesh_viceCommandPlatform_left_4;
  colliders["viceCommandPlatform.left"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "simplified box proxy; static set-dressing does not need a tight collider"};
  destructionGroups["viceCommandPlatform.left"] ??= [];
  destructionGroups["viceCommandPlatform.left"].push(node_viceCommandPlatform_left_4);

  const attachment_viceCommandPlatform_right_5 = null;
  const endpoint_viceCommandPlatform_right_5 = makeAttachmentEndpoint(attachment_viceCommandPlatform_right_5);
  const node_viceCommandPlatform_right_5 = new THREE.Group();
  node_viceCommandPlatform_right_5.name = "Vice-command platform (right)__pivot";
  if (endpoint_viceCommandPlatform_right_5) {
    node_viceCommandPlatform_right_5.position.copy(endpoint_viceCommandPlatform_right_5.start);
    node_viceCommandPlatform_right_5.rotation.set(0, 0, 0);
    node_viceCommandPlatform_right_5.scale.set(1, 1, 1);
  } else {
    node_viceCommandPlatform_right_5.position.set(5.6, 0.35, 3.6);
    node_viceCommandPlatform_right_5.rotation.set(0.0, 0.0, 0.0);
    node_viceCommandPlatform_right_5.scale.set(1.0, 1.0, 1.0);
  }
  node_viceCommandPlatform_right_5.userData.sculptComponent = {"id": "viceCommandPlatform.right", "name": "Vice-command platform (right)", "level": "macro", "role": "structural", "importance": 0.55, "confidence": 0.6, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "Lower-tier bevelled rounded-rect platform, mirrors the dais language at smaller scale. (topologyClass normalized to the spec's fixed enum.)", "geometryDescriptor": {"topologyIntent": "macro-scale extrude block, chamfer-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.02, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 2.6, "height": 0.7, "depth": 2.2, "units": "meters", "confidence": 0.6}, "transform": {"position": [5.6, 0.35, 3.6], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-structure", "pivot": {"mode": "base", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "simplified box proxy; static set-dressing does not need a tight collider"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "viceCommandPlatform.right", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "consoleDeck"}}, "material": "consoleDeck", "materialLayers": ["consoleDeck"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "det-vice-command-desk-wing", "description": "winged desk silhouette flanking a smaller centered console"}], "surfaceDetail": {"macroRoughness": 0.5, "microRoughness": 0.3, "bumpAmplitude": 0.02, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "cavity darkening at seams", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["image-analysis.md#layer-3", "di.json"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(46, 111, 107, 1.0)", "secondaryAlbedo": "rgba(46, 111, 107, 0.85)", "materialClass": "plastic", "materialClassConfidence": 0.65, "notes": "derived from material 'consoleDeck' baseColor + di.json zone evidence"}};
  node_viceCommandPlatform_right_5.userData.actionProfile = {"animationRole": "static-structure", "pivot": {"mode": "base", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "simplified box proxy; static set-dressing does not need a tight collider"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "viceCommandPlatform.right", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "consoleDeck"}};
  (nodes["root"] ?? root).add(node_viceCommandPlatform_right_5);
  nodes["viceCommandPlatform.right"] = node_viceCommandPlatform_right_5;
  const mesh_viceCommandPlatform_right_5Geometry = endpoint_viceCommandPlatform_right_5
    ? new THREE.CylinderGeometry(endpoint_viceCommandPlatform_right_5.endRadius, endpoint_viceCommandPlatform_right_5.baseRadius, endpoint_viceCommandPlatform_right_5.length, 32, 12)
    : buildExtrudeGeometry({"points": [[-0.3, -0.3], [0.3, -0.3], [0.3, 0.3], [-0.3, 0.3]], "depth": 0.1});
  const mesh_viceCommandPlatform_right_5 = new THREE.Mesh(
    mesh_viceCommandPlatform_right_5Geometry,
    materialMap["consoleDeck"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_viceCommandPlatform_right_5.name = "Vice-command platform (right)";
  if (endpoint_viceCommandPlatform_right_5) {
    mesh_viceCommandPlatform_right_5.position.copy(endpoint_viceCommandPlatform_right_5.midpoint);
    mesh_viceCommandPlatform_right_5.quaternion.copy(endpoint_viceCommandPlatform_right_5.quaternion);
  }
  mesh_viceCommandPlatform_right_5.castShadow = options.castShadow ?? true;
  mesh_viceCommandPlatform_right_5.receiveShadow = options.receiveShadow ?? true;
  mesh_viceCommandPlatform_right_5.userData.sculptComponent = {"id": "viceCommandPlatform.right", "name": "Vice-command platform (right)", "level": "macro", "role": "structural", "importance": 0.55, "confidence": 0.6, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "Lower-tier bevelled rounded-rect platform, mirrors the dais language at smaller scale. (topologyClass normalized to the spec's fixed enum.)", "geometryDescriptor": {"topologyIntent": "macro-scale extrude block, chamfer-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.02, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 2.6, "height": 0.7, "depth": 2.2, "units": "meters", "confidence": 0.6}, "transform": {"position": [5.6, 0.35, 3.6], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-structure", "pivot": {"mode": "base", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "simplified box proxy; static set-dressing does not need a tight collider"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "viceCommandPlatform.right", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "consoleDeck"}}, "material": "consoleDeck", "materialLayers": ["consoleDeck"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "det-vice-command-desk-wing", "description": "winged desk silhouette flanking a smaller centered console"}], "surfaceDetail": {"macroRoughness": 0.5, "microRoughness": 0.3, "bumpAmplitude": 0.02, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "cavity darkening at seams", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["image-analysis.md#layer-3", "di.json"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(46, 111, 107, 1.0)", "secondaryAlbedo": "rgba(46, 111, 107, 0.85)", "materialClass": "plastic", "materialClassConfidence": 0.65, "notes": "derived from material 'consoleDeck' baseColor + di.json zone evidence"}};
  node_viceCommandPlatform_right_5.add(mesh_viceCommandPlatform_right_5);
  meshes["viceCommandPlatform.right"] = mesh_viceCommandPlatform_right_5;
  colliders["viceCommandPlatform.right"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "simplified box proxy; static set-dressing does not need a tight collider"};
  destructionGroups["viceCommandPlatform.right"] ??= [];
  destructionGroups["viceCommandPlatform.right"].push(node_viceCommandPlatform_right_5);

  const attachment_staircase_left_6 = null;
  const endpoint_staircase_left_6 = makeAttachmentEndpoint(attachment_staircase_left_6);
  const node_staircase_left_6 = new THREE.Group();
  node_staircase_left_6.name = "Staircase (left)__pivot";
  if (endpoint_staircase_left_6) {
    node_staircase_left_6.position.copy(endpoint_staircase_left_6.start);
    node_staircase_left_6.rotation.set(0, 0, 0);
    node_staircase_left_6.scale.set(1, 1, 1);
  } else {
    node_staircase_left_6.position.set(-4.4, 2.5, -1.2);
    node_staircase_left_6.rotation.set(0.0, 0.12, 0.0);
    node_staircase_left_6.scale.set(1.0, 1.0, 1.0);
  }
  node_staircase_left_6.userData.sculptComponent = {"id": "staircase.left", "name": "Staircase (left)", "level": "macro", "role": "structural", "importance": 0.75, "confidence": 0.6, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Stringer + tread-run silhouette (Layer 3 meso: 2 flights meeting a mid-landing); individual treads are hand-authored as a linear repeat in code rather than the spec's radial-only repetitionSystem emitter (documented in risks).", "geometryDescriptor": {"topologyIntent": "macro-scale box block, chamfer-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.02, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 1.6, "height": 5.0, "depth": 3.2, "units": "meters", "confidence": 0.6}, "transform": {"position": [-4.4, 2.5, -1.2], "rotation": [0, 0.12, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-structure", "pivot": {"mode": "base", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "simplified box proxy; static set-dressing does not need a tight collider"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "staircase.left", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "structuralSteel"}}, "material": "structuralSteel", "materialLayers": ["structuralSteel"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "det-stair-handrail-tube", "description": "thin tubular handrail with vertical baluster repeat"}], "surfaceDetail": {"macroRoughness": 0.5, "microRoughness": 0.3, "bumpAmplitude": 0.02, "normalPattern": "panel-seam", "displacementPattern": "", "occlusionPattern": "cavity darkening at seams", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["image-analysis.md#layer-3", "di.json"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(58, 66, 73, 1.0)", "secondaryAlbedo": "rgba(10, 15, 12, 0.85)", "materialClass": "metal", "materialClassConfidence": 0.65, "notes": "derived from material 'structuralSteel' baseColor + di.json zone evidence"}};
  node_staircase_left_6.userData.actionProfile = {"animationRole": "static-structure", "pivot": {"mode": "base", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "simplified box proxy; static set-dressing does not need a tight collider"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "staircase.left", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "structuralSteel"}};
  (nodes["root"] ?? root).add(node_staircase_left_6);
  nodes["staircase.left"] = node_staircase_left_6;
  const mesh_staircase_left_6Geometry = endpoint_staircase_left_6
    ? new THREE.CylinderGeometry(endpoint_staircase_left_6.endRadius, endpoint_staircase_left_6.baseRadius, endpoint_staircase_left_6.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  const mesh_staircase_left_6 = new THREE.Mesh(
    mesh_staircase_left_6Geometry,
    materialMap["structuralSteel"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_staircase_left_6.name = "Staircase (left)";
  if (endpoint_staircase_left_6) {
    mesh_staircase_left_6.position.copy(endpoint_staircase_left_6.midpoint);
    mesh_staircase_left_6.quaternion.copy(endpoint_staircase_left_6.quaternion);
  }
  mesh_staircase_left_6.castShadow = options.castShadow ?? true;
  mesh_staircase_left_6.receiveShadow = options.receiveShadow ?? true;
  mesh_staircase_left_6.userData.sculptComponent = {"id": "staircase.left", "name": "Staircase (left)", "level": "macro", "role": "structural", "importance": 0.75, "confidence": 0.6, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Stringer + tread-run silhouette (Layer 3 meso: 2 flights meeting a mid-landing); individual treads are hand-authored as a linear repeat in code rather than the spec's radial-only repetitionSystem emitter (documented in risks).", "geometryDescriptor": {"topologyIntent": "macro-scale box block, chamfer-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.02, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 1.6, "height": 5.0, "depth": 3.2, "units": "meters", "confidence": 0.6}, "transform": {"position": [-4.4, 2.5, -1.2], "rotation": [0, 0.12, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-structure", "pivot": {"mode": "base", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "simplified box proxy; static set-dressing does not need a tight collider"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "staircase.left", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "structuralSteel"}}, "material": "structuralSteel", "materialLayers": ["structuralSteel"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "det-stair-handrail-tube", "description": "thin tubular handrail with vertical baluster repeat"}], "surfaceDetail": {"macroRoughness": 0.5, "microRoughness": 0.3, "bumpAmplitude": 0.02, "normalPattern": "panel-seam", "displacementPattern": "", "occlusionPattern": "cavity darkening at seams", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["image-analysis.md#layer-3", "di.json"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(58, 66, 73, 1.0)", "secondaryAlbedo": "rgba(10, 15, 12, 0.85)", "materialClass": "metal", "materialClassConfidence": 0.65, "notes": "derived from material 'structuralSteel' baseColor + di.json zone evidence"}};
  node_staircase_left_6.add(mesh_staircase_left_6);
  meshes["staircase.left"] = mesh_staircase_left_6;
  colliders["staircase.left"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "simplified box proxy; static set-dressing does not need a tight collider"};
  destructionGroups["staircase.left"] ??= [];
  destructionGroups["staircase.left"].push(node_staircase_left_6);

  const attachment_staircase_right_7 = null;
  const endpoint_staircase_right_7 = makeAttachmentEndpoint(attachment_staircase_right_7);
  const node_staircase_right_7 = new THREE.Group();
  node_staircase_right_7.name = "Staircase (right)__pivot";
  if (endpoint_staircase_right_7) {
    node_staircase_right_7.position.copy(endpoint_staircase_right_7.start);
    node_staircase_right_7.rotation.set(0, 0, 0);
    node_staircase_right_7.scale.set(1, 1, 1);
  } else {
    node_staircase_right_7.position.set(4.4, 2.5, -1.2);
    node_staircase_right_7.rotation.set(0.0, -0.12, 0.0);
    node_staircase_right_7.scale.set(1.0, 1.0, 1.0);
  }
  node_staircase_right_7.userData.sculptComponent = {"id": "staircase.right", "name": "Staircase (right)", "level": "macro", "role": "structural", "importance": 0.75, "confidence": 0.6, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Stringer + tread-run silhouette (Layer 3 meso: 2 flights meeting a mid-landing); individual treads are hand-authored as a linear repeat in code rather than the spec's radial-only repetitionSystem emitter (documented in risks).", "geometryDescriptor": {"topologyIntent": "macro-scale box block, chamfer-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.02, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 1.6, "height": 5.0, "depth": 3.2, "units": "meters", "confidence": 0.6}, "transform": {"position": [4.4, 2.5, -1.2], "rotation": [0, -0.12, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-structure", "pivot": {"mode": "base", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "simplified box proxy; static set-dressing does not need a tight collider"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "staircase.right", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "structuralSteel"}}, "material": "structuralSteel", "materialLayers": ["structuralSteel"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "det-stair-handrail-tube", "description": "thin tubular handrail with vertical baluster repeat"}], "surfaceDetail": {"macroRoughness": 0.5, "microRoughness": 0.3, "bumpAmplitude": 0.02, "normalPattern": "panel-seam", "displacementPattern": "", "occlusionPattern": "cavity darkening at seams", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["image-analysis.md#layer-3", "di.json"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(58, 66, 73, 1.0)", "secondaryAlbedo": "rgba(10, 15, 12, 0.85)", "materialClass": "metal", "materialClassConfidence": 0.65, "notes": "derived from material 'structuralSteel' baseColor + di.json zone evidence"}};
  node_staircase_right_7.userData.actionProfile = {"animationRole": "static-structure", "pivot": {"mode": "base", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "simplified box proxy; static set-dressing does not need a tight collider"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "staircase.right", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "structuralSteel"}};
  (nodes["root"] ?? root).add(node_staircase_right_7);
  nodes["staircase.right"] = node_staircase_right_7;
  const mesh_staircase_right_7Geometry = endpoint_staircase_right_7
    ? new THREE.CylinderGeometry(endpoint_staircase_right_7.endRadius, endpoint_staircase_right_7.baseRadius, endpoint_staircase_right_7.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  const mesh_staircase_right_7 = new THREE.Mesh(
    mesh_staircase_right_7Geometry,
    materialMap["structuralSteel"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_staircase_right_7.name = "Staircase (right)";
  if (endpoint_staircase_right_7) {
    mesh_staircase_right_7.position.copy(endpoint_staircase_right_7.midpoint);
    mesh_staircase_right_7.quaternion.copy(endpoint_staircase_right_7.quaternion);
  }
  mesh_staircase_right_7.castShadow = options.castShadow ?? true;
  mesh_staircase_right_7.receiveShadow = options.receiveShadow ?? true;
  mesh_staircase_right_7.userData.sculptComponent = {"id": "staircase.right", "name": "Staircase (right)", "level": "macro", "role": "structural", "importance": 0.75, "confidence": 0.6, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Stringer + tread-run silhouette (Layer 3 meso: 2 flights meeting a mid-landing); individual treads are hand-authored as a linear repeat in code rather than the spec's radial-only repetitionSystem emitter (documented in risks).", "geometryDescriptor": {"topologyIntent": "macro-scale box block, chamfer-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.02, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 1.6, "height": 5.0, "depth": 3.2, "units": "meters", "confidence": 0.6}, "transform": {"position": [4.4, 2.5, -1.2], "rotation": [0, -0.12, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-structure", "pivot": {"mode": "base", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "simplified box proxy; static set-dressing does not need a tight collider"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "staircase.right", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "structuralSteel"}}, "material": "structuralSteel", "materialLayers": ["structuralSteel"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "det-stair-handrail-tube", "description": "thin tubular handrail with vertical baluster repeat"}], "surfaceDetail": {"macroRoughness": 0.5, "microRoughness": 0.3, "bumpAmplitude": 0.02, "normalPattern": "panel-seam", "displacementPattern": "", "occlusionPattern": "cavity darkening at seams", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["image-analysis.md#layer-3", "di.json"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(58, 66, 73, 1.0)", "secondaryAlbedo": "rgba(10, 15, 12, 0.85)", "materialClass": "metal", "materialClassConfidence": 0.65, "notes": "derived from material 'structuralSteel' baseColor + di.json zone evidence"}};
  node_staircase_right_7.add(mesh_staircase_right_7);
  meshes["staircase.right"] = mesh_staircase_right_7;
  colliders["staircase.right"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "simplified box proxy; static set-dressing does not need a tight collider"};
  destructionGroups["staircase.right"] ??= [];
  destructionGroups["staircase.right"].push(node_staircase_right_7);

  const attachment_catwalk_left_8 = {"parentSocket": "root", "localStart": [-1.5, 0.0, 0.0], "localEnd": [1.5, 0.0, 0.0], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.05, "gapTolerance": 0.01, "notes": "truss bridges from this staircase's mid-landing to the opposite staircase's mid-landing"};
  const endpoint_catwalk_left_8 = makeAttachmentEndpoint(attachment_catwalk_left_8);
  const node_catwalk_left_8 = new THREE.Group();
  node_catwalk_left_8.name = "Catwalk / bridge truss (left)__pivot";
  if (endpoint_catwalk_left_8) {
    node_catwalk_left_8.position.copy(endpoint_catwalk_left_8.start);
    node_catwalk_left_8.rotation.set(0, 0, 0);
    node_catwalk_left_8.scale.set(1, 1, 1);
  } else {
    node_catwalk_left_8.position.set(-3.0, 4.6, -3.2);
    node_catwalk_left_8.rotation.set(0.0, 0.12, 0.0);
    node_catwalk_left_8.scale.set(1.0, 1.0, 1.0);
  }
  node_catwalk_left_8.userData.sculptComponent = {"id": "catwalk.left", "name": "Catwalk / bridge truss (left)", "level": "macro", "role": "structural", "importance": 0.7, "confidence": 0.55, "primitive": "curve-sweep", "topologyClass": "assembled-solid", "topologyRationale": "Truncated-triangular truss (top chord + diagonal web + bottom chord) bridging the stair mid-landing to the room's mid-height, matching Layer 2's lofted-beam read. (topologyClass normalized to the spec's fixed enum.)", "geometryDescriptor": {"topologyIntent": "macro-scale curve-sweep block, chamfer-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.02, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": {"parentSocket": "root", "localStart": [-1.5, 0.0, 0.0], "localEnd": [1.5, 0.0, 0.0], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.05, "gapTolerance": 0.01, "notes": "truss bridges from this staircase's mid-landing to the opposite staircase's mid-landing"}, "dimensions": {"width": 3.0, "height": 0.6, "depth": 1.0, "units": "meters", "confidence": 0.55}, "transform": {"position": [-3.0, 4.6, -3.2], "rotation": [0, 0.12, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-structure", "pivot": {"mode": "base", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "simplified box proxy; static set-dressing does not need a tight collider"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "catwalk.left", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "structuralSteel"}}, "material": "structuralSteel", "materialLayers": ["structuralSteel"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "det-catwalk-truss-web", "description": "diagonal web between top/bottom chord"}], "surfaceDetail": {"macroRoughness": 0.5, "microRoughness": 0.3, "bumpAmplitude": 0.02, "normalPattern": "panel-seam", "displacementPattern": "", "occlusionPattern": "cavity darkening at seams", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["image-analysis.md#layer-3", "di.json"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(58, 66, 73, 1.0)", "secondaryAlbedo": "rgba(10, 15, 12, 0.85)", "materialClass": "metal", "materialClassConfidence": 0.65, "notes": "derived from material 'structuralSteel' baseColor + di.json zone evidence"}};
  node_catwalk_left_8.userData.actionProfile = {"animationRole": "static-structure", "pivot": {"mode": "base", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "simplified box proxy; static set-dressing does not need a tight collider"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "catwalk.left", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "structuralSteel"}};
  (nodes["root"] ?? root).add(node_catwalk_left_8);
  nodes["catwalk.left"] = node_catwalk_left_8;
  const mesh_catwalk_left_8Geometry = endpoint_catwalk_left_8
    ? new THREE.CylinderGeometry(endpoint_catwalk_left_8.endRadius, endpoint_catwalk_left_8.baseRadius, endpoint_catwalk_left_8.length, 32, 12)
    : buildCurveSweepGeometry({"spine": [[-0.5, -0.4, 0.0], [-0.1, 0.1, 0.0], [0.3, 0.2, 0.0], [0.6, -0.1, 0.0]], "crossSection": {"points": [[-0.04, -0.02], [0.04, -0.02], [0.04, 0.02], [-0.04, 0.02]]}, "closed": false});
  const mesh_catwalk_left_8 = new THREE.Mesh(
    mesh_catwalk_left_8Geometry,
    materialMap["structuralSteel"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_catwalk_left_8.name = "Catwalk / bridge truss (left)";
  if (endpoint_catwalk_left_8) {
    mesh_catwalk_left_8.position.copy(endpoint_catwalk_left_8.midpoint);
    mesh_catwalk_left_8.quaternion.copy(endpoint_catwalk_left_8.quaternion);
  }
  mesh_catwalk_left_8.castShadow = options.castShadow ?? true;
  mesh_catwalk_left_8.receiveShadow = options.receiveShadow ?? true;
  mesh_catwalk_left_8.userData.sculptComponent = {"id": "catwalk.left", "name": "Catwalk / bridge truss (left)", "level": "macro", "role": "structural", "importance": 0.7, "confidence": 0.55, "primitive": "curve-sweep", "topologyClass": "assembled-solid", "topologyRationale": "Truncated-triangular truss (top chord + diagonal web + bottom chord) bridging the stair mid-landing to the room's mid-height, matching Layer 2's lofted-beam read. (topologyClass normalized to the spec's fixed enum.)", "geometryDescriptor": {"topologyIntent": "macro-scale curve-sweep block, chamfer-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.02, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": {"parentSocket": "root", "localStart": [-1.5, 0.0, 0.0], "localEnd": [1.5, 0.0, 0.0], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.05, "gapTolerance": 0.01, "notes": "truss bridges from this staircase's mid-landing to the opposite staircase's mid-landing"}, "dimensions": {"width": 3.0, "height": 0.6, "depth": 1.0, "units": "meters", "confidence": 0.55}, "transform": {"position": [-3.0, 4.6, -3.2], "rotation": [0, 0.12, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-structure", "pivot": {"mode": "base", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "simplified box proxy; static set-dressing does not need a tight collider"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "catwalk.left", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "structuralSteel"}}, "material": "structuralSteel", "materialLayers": ["structuralSteel"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "det-catwalk-truss-web", "description": "diagonal web between top/bottom chord"}], "surfaceDetail": {"macroRoughness": 0.5, "microRoughness": 0.3, "bumpAmplitude": 0.02, "normalPattern": "panel-seam", "displacementPattern": "", "occlusionPattern": "cavity darkening at seams", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["image-analysis.md#layer-3", "di.json"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(58, 66, 73, 1.0)", "secondaryAlbedo": "rgba(10, 15, 12, 0.85)", "materialClass": "metal", "materialClassConfidence": 0.65, "notes": "derived from material 'structuralSteel' baseColor + di.json zone evidence"}};
  node_catwalk_left_8.add(mesh_catwalk_left_8);
  meshes["catwalk.left"] = mesh_catwalk_left_8;
  colliders["catwalk.left"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "simplified box proxy; static set-dressing does not need a tight collider"};
  destructionGroups["catwalk.left"] ??= [];
  destructionGroups["catwalk.left"].push(node_catwalk_left_8);

  const attachment_catwalk_right_9 = {"parentSocket": "root", "localStart": [-1.5, 0.0, 0.0], "localEnd": [1.5, 0.0, 0.0], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.05, "gapTolerance": 0.01, "notes": "truss bridges from this staircase's mid-landing to the opposite staircase's mid-landing"};
  const endpoint_catwalk_right_9 = makeAttachmentEndpoint(attachment_catwalk_right_9);
  const node_catwalk_right_9 = new THREE.Group();
  node_catwalk_right_9.name = "Catwalk / bridge truss (right)__pivot";
  if (endpoint_catwalk_right_9) {
    node_catwalk_right_9.position.copy(endpoint_catwalk_right_9.start);
    node_catwalk_right_9.rotation.set(0, 0, 0);
    node_catwalk_right_9.scale.set(1, 1, 1);
  } else {
    node_catwalk_right_9.position.set(3.0, 4.6, -3.2);
    node_catwalk_right_9.rotation.set(0.0, -0.12, 0.0);
    node_catwalk_right_9.scale.set(1.0, 1.0, 1.0);
  }
  node_catwalk_right_9.userData.sculptComponent = {"id": "catwalk.right", "name": "Catwalk / bridge truss (right)", "level": "macro", "role": "structural", "importance": 0.7, "confidence": 0.55, "primitive": "curve-sweep", "topologyClass": "assembled-solid", "topologyRationale": "Truncated-triangular truss (top chord + diagonal web + bottom chord) bridging the stair mid-landing to the room's mid-height, matching Layer 2's lofted-beam read. (topologyClass normalized to the spec's fixed enum.)", "geometryDescriptor": {"topologyIntent": "macro-scale curve-sweep block, chamfer-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.02, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": {"parentSocket": "root", "localStart": [-1.5, 0.0, 0.0], "localEnd": [1.5, 0.0, 0.0], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.05, "gapTolerance": 0.01, "notes": "truss bridges from this staircase's mid-landing to the opposite staircase's mid-landing"}, "dimensions": {"width": 3.0, "height": 0.6, "depth": 1.0, "units": "meters", "confidence": 0.55}, "transform": {"position": [3.0, 4.6, -3.2], "rotation": [0, -0.12, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-structure", "pivot": {"mode": "base", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "simplified box proxy; static set-dressing does not need a tight collider"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "catwalk.right", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "structuralSteel"}}, "material": "structuralSteel", "materialLayers": ["structuralSteel"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "det-catwalk-truss-web", "description": "diagonal web between top/bottom chord"}], "surfaceDetail": {"macroRoughness": 0.5, "microRoughness": 0.3, "bumpAmplitude": 0.02, "normalPattern": "panel-seam", "displacementPattern": "", "occlusionPattern": "cavity darkening at seams", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["image-analysis.md#layer-3", "di.json"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(58, 66, 73, 1.0)", "secondaryAlbedo": "rgba(10, 15, 12, 0.85)", "materialClass": "metal", "materialClassConfidence": 0.65, "notes": "derived from material 'structuralSteel' baseColor + di.json zone evidence"}};
  node_catwalk_right_9.userData.actionProfile = {"animationRole": "static-structure", "pivot": {"mode": "base", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "simplified box proxy; static set-dressing does not need a tight collider"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "catwalk.right", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "structuralSteel"}};
  (nodes["root"] ?? root).add(node_catwalk_right_9);
  nodes["catwalk.right"] = node_catwalk_right_9;
  const mesh_catwalk_right_9Geometry = endpoint_catwalk_right_9
    ? new THREE.CylinderGeometry(endpoint_catwalk_right_9.endRadius, endpoint_catwalk_right_9.baseRadius, endpoint_catwalk_right_9.length, 32, 12)
    : buildCurveSweepGeometry({"spine": [[-0.5, -0.4, 0.0], [-0.1, 0.1, 0.0], [0.3, 0.2, 0.0], [0.6, -0.1, 0.0]], "crossSection": {"points": [[-0.04, -0.02], [0.04, -0.02], [0.04, 0.02], [-0.04, 0.02]]}, "closed": false});
  const mesh_catwalk_right_9 = new THREE.Mesh(
    mesh_catwalk_right_9Geometry,
    materialMap["structuralSteel"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_catwalk_right_9.name = "Catwalk / bridge truss (right)";
  if (endpoint_catwalk_right_9) {
    mesh_catwalk_right_9.position.copy(endpoint_catwalk_right_9.midpoint);
    mesh_catwalk_right_9.quaternion.copy(endpoint_catwalk_right_9.quaternion);
  }
  mesh_catwalk_right_9.castShadow = options.castShadow ?? true;
  mesh_catwalk_right_9.receiveShadow = options.receiveShadow ?? true;
  mesh_catwalk_right_9.userData.sculptComponent = {"id": "catwalk.right", "name": "Catwalk / bridge truss (right)", "level": "macro", "role": "structural", "importance": 0.7, "confidence": 0.55, "primitive": "curve-sweep", "topologyClass": "assembled-solid", "topologyRationale": "Truncated-triangular truss (top chord + diagonal web + bottom chord) bridging the stair mid-landing to the room's mid-height, matching Layer 2's lofted-beam read. (topologyClass normalized to the spec's fixed enum.)", "geometryDescriptor": {"topologyIntent": "macro-scale curve-sweep block, chamfer-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.02, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": {"parentSocket": "root", "localStart": [-1.5, 0.0, 0.0], "localEnd": [1.5, 0.0, 0.0], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.05, "gapTolerance": 0.01, "notes": "truss bridges from this staircase's mid-landing to the opposite staircase's mid-landing"}, "dimensions": {"width": 3.0, "height": 0.6, "depth": 1.0, "units": "meters", "confidence": 0.55}, "transform": {"position": [3.0, 4.6, -3.2], "rotation": [0, -0.12, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-structure", "pivot": {"mode": "base", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "simplified box proxy; static set-dressing does not need a tight collider"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "catwalk.right", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "structuralSteel"}}, "material": "structuralSteel", "materialLayers": ["structuralSteel"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "det-catwalk-truss-web", "description": "diagonal web between top/bottom chord"}], "surfaceDetail": {"macroRoughness": 0.5, "microRoughness": 0.3, "bumpAmplitude": 0.02, "normalPattern": "panel-seam", "displacementPattern": "", "occlusionPattern": "cavity darkening at seams", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["image-analysis.md#layer-3", "di.json"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(58, 66, 73, 1.0)", "secondaryAlbedo": "rgba(10, 15, 12, 0.85)", "materialClass": "metal", "materialClassConfidence": 0.65, "notes": "derived from material 'structuralSteel' baseColor + di.json zone evidence"}};
  node_catwalk_right_9.add(mesh_catwalk_right_9);
  meshes["catwalk.right"] = mesh_catwalk_right_9;
  colliders["catwalk.right"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "simplified box proxy; static set-dressing does not need a tight collider"};
  destructionGroups["catwalk.right"] ??= [];
  destructionGroups["catwalk.right"].push(node_catwalk_right_9);

  const attachment_floorPit_10 = null;
  const endpoint_floorPit_10 = makeAttachmentEndpoint(attachment_floorPit_10);
  const node_floorPit_10 = new THREE.Group();
  node_floorPit_10.name = "Sunken octagonal floor pit__pivot";
  if (endpoint_floorPit_10) {
    node_floorPit_10.position.copy(endpoint_floorPit_10.start);
    node_floorPit_10.rotation.set(0, 0, 0);
    node_floorPit_10.scale.set(1, 1, 1);
  } else {
    node_floorPit_10.position.set(0.0, -0.7, 2.6);
    node_floorPit_10.rotation.set(0.0, 0.0, 0.0);
    node_floorPit_10.scale.set(1.0, 1.0, 1.0);
  }
  node_floorPit_10.userData.sculptComponent = {"id": "floorPit", "name": "Sunken octagonal floor pit", "level": "macro", "role": "structural", "importance": 0.9, "confidence": 0.65, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "Bevelled walkway rim around a faceted inward-sloping sunken octagon -- the single most identity-defining negative-space feature (Layer 7). (topologyClass normalized to the spec's fixed enum.)", "geometryDescriptor": {"topologyIntent": "macro-scale extrude block, chamfer-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.02, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 5.2, "height": 1.4, "depth": 5.2, "units": "meters", "confidence": 0.65}, "transform": {"position": [0, -0.7, 2.6], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-structure", "pivot": {"mode": "base", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "simplified box proxy; static set-dressing does not need a tight collider"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "floorPit", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "pitGlass"}}, "material": "pitGlass", "materialLayers": ["pitGlass"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "det-pit-inner-slope-facets", "description": "faceted glossy-dark inward-sloping inner walls"}, {"id": "det-floor-pit-emitter-strip", "description": "flush emissive strip at the very bottom center"}], "surfaceDetail": {"macroRoughness": 0.5, "microRoughness": 0.3, "bumpAmplitude": 0.02, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "cavity darkening at seams", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["image-analysis.md#layer-3", "di.json"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(4, 16, 14, 1.0)", "secondaryAlbedo": "rgba(4, 16, 14, 0.85)", "materialClass": "glass", "materialClassConfidence": 0.65, "notes": "derived from material 'pitGlass' baseColor + di.json zone evidence"}};
  node_floorPit_10.userData.actionProfile = {"animationRole": "static-structure", "pivot": {"mode": "base", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "simplified box proxy; static set-dressing does not need a tight collider"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "floorPit", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "pitGlass"}};
  (nodes["root"] ?? root).add(node_floorPit_10);
  nodes["floorPit"] = node_floorPit_10;
  const mesh_floorPit_10Geometry = endpoint_floorPit_10
    ? new THREE.CylinderGeometry(endpoint_floorPit_10.endRadius, endpoint_floorPit_10.baseRadius, endpoint_floorPit_10.length, 32, 12)
    : buildExtrudeGeometry({"points": [[-0.3, -0.3], [0.3, -0.3], [0.3, 0.3], [-0.3, 0.3]], "depth": 0.1});
  const mesh_floorPit_10 = new THREE.Mesh(
    mesh_floorPit_10Geometry,
    materialMap["pitGlass"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_floorPit_10.name = "Sunken octagonal floor pit";
  if (endpoint_floorPit_10) {
    mesh_floorPit_10.position.copy(endpoint_floorPit_10.midpoint);
    mesh_floorPit_10.quaternion.copy(endpoint_floorPit_10.quaternion);
  }
  mesh_floorPit_10.castShadow = options.castShadow ?? true;
  mesh_floorPit_10.receiveShadow = options.receiveShadow ?? true;
  mesh_floorPit_10.userData.sculptComponent = {"id": "floorPit", "name": "Sunken octagonal floor pit", "level": "macro", "role": "structural", "importance": 0.9, "confidence": 0.65, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "Bevelled walkway rim around a faceted inward-sloping sunken octagon -- the single most identity-defining negative-space feature (Layer 7). (topologyClass normalized to the spec's fixed enum.)", "geometryDescriptor": {"topologyIntent": "macro-scale extrude block, chamfer-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.02, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 5.2, "height": 1.4, "depth": 5.2, "units": "meters", "confidence": 0.65}, "transform": {"position": [0, -0.7, 2.6], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-structure", "pivot": {"mode": "base", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "simplified box proxy; static set-dressing does not need a tight collider"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "floorPit", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "pitGlass"}}, "material": "pitGlass", "materialLayers": ["pitGlass"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "det-pit-inner-slope-facets", "description": "faceted glossy-dark inward-sloping inner walls"}, {"id": "det-floor-pit-emitter-strip", "description": "flush emissive strip at the very bottom center"}], "surfaceDetail": {"macroRoughness": 0.5, "microRoughness": 0.3, "bumpAmplitude": 0.02, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "cavity darkening at seams", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["image-analysis.md#layer-3", "di.json"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(4, 16, 14, 1.0)", "secondaryAlbedo": "rgba(4, 16, 14, 0.85)", "materialClass": "glass", "materialClassConfidence": 0.65, "notes": "derived from material 'pitGlass' baseColor + di.json zone evidence"}};
  node_floorPit_10.add(mesh_floorPit_10);
  meshes["floorPit"] = mesh_floorPit_10;
  colliders["floorPit"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "simplified box proxy; static set-dressing does not need a tight collider"};
  destructionGroups["floorPit"] ??= [];
  destructionGroups["floorPit"].push(node_floorPit_10);

  const attachment_monitorWallTower_left_11 = null;
  const endpoint_monitorWallTower_left_11 = makeAttachmentEndpoint(attachment_monitorWallTower_left_11);
  const node_monitorWallTower_left_11 = new THREE.Group();
  node_monitorWallTower_left_11.name = "Monitor-wall tower (left)__pivot";
  if (endpoint_monitorWallTower_left_11) {
    node_monitorWallTower_left_11.position.copy(endpoint_monitorWallTower_left_11.start);
    node_monitorWallTower_left_11.rotation.set(0, 0, 0);
    node_monitorWallTower_left_11.scale.set(1, 1, 1);
  } else {
    node_monitorWallTower_left_11.position.set(-6.4, 4.0, -1.0);
    node_monitorWallTower_left_11.rotation.set(0.0, -0.55, 0.06);
    node_monitorWallTower_left_11.scale.set(1.0, 1.0, 1.0);
  }
  node_monitorWallTower_left_11.userData.sculptComponent = {"id": "monitorWallTower.left", "name": "Monitor-wall tower (left)", "level": "macro", "role": "structural", "importance": 0.9, "confidence": 0.6, "primitive": "box", "topologyClass": "conforming-shell", "topologyRationale": "Raked backing wall (leans inward toward the room's central axis at the top) carrying the tiled screen grid -- the second most identity-defining feature (Layer 7). Screen tiles are hand-authored as a 2D grid loop, not the spec's radial-only repetitionSystem. (topologyClass normalized to the spec's fixed enum.)", "geometryDescriptor": {"topologyIntent": "macro-scale box block, chamfer-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.02, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.5, "height": 8.0, "depth": 8.0, "units": "meters", "confidence": 0.6}, "transform": {"position": [-6.4, 4.0, -1.0], "rotation": [0, -0.55, 0.06], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-structure", "pivot": {"mode": "base", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "simplified box proxy; static set-dressing does not need a tight collider"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "monitorWallTower.left", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "structuralSteel"}}, "material": "structuralSteel", "materialLayers": ["structuralSteel"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "det-screen-tile-grid", "description": "non-uniform tiled grid of individually framed rectangular screens"}, {"id": "det-wall-tower-rake", "description": "wall leans inward toward the room's central axis at the top"}], "surfaceDetail": {"macroRoughness": 0.5, "microRoughness": 0.3, "bumpAmplitude": 0.02, "normalPattern": "panel-seam", "displacementPattern": "", "occlusionPattern": "cavity darkening at seams", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["image-analysis.md#layer-3", "di.json"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(58, 66, 73, 1.0)", "secondaryAlbedo": "rgba(10, 15, 12, 0.85)", "materialClass": "metal", "materialClassConfidence": 0.65, "notes": "derived from material 'structuralSteel' baseColor + di.json zone evidence"}};
  node_monitorWallTower_left_11.userData.actionProfile = {"animationRole": "static-structure", "pivot": {"mode": "base", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "simplified box proxy; static set-dressing does not need a tight collider"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "monitorWallTower.left", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "structuralSteel"}};
  (nodes["root"] ?? root).add(node_monitorWallTower_left_11);
  nodes["monitorWallTower.left"] = node_monitorWallTower_left_11;
  const mesh_monitorWallTower_left_11Geometry = endpoint_monitorWallTower_left_11
    ? new THREE.CylinderGeometry(endpoint_monitorWallTower_left_11.endRadius, endpoint_monitorWallTower_left_11.baseRadius, endpoint_monitorWallTower_left_11.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  const mesh_monitorWallTower_left_11 = new THREE.Mesh(
    mesh_monitorWallTower_left_11Geometry,
    materialMap["structuralSteel"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_monitorWallTower_left_11.name = "Monitor-wall tower (left)";
  if (endpoint_monitorWallTower_left_11) {
    mesh_monitorWallTower_left_11.position.copy(endpoint_monitorWallTower_left_11.midpoint);
    mesh_monitorWallTower_left_11.quaternion.copy(endpoint_monitorWallTower_left_11.quaternion);
  }
  mesh_monitorWallTower_left_11.castShadow = options.castShadow ?? true;
  mesh_monitorWallTower_left_11.receiveShadow = options.receiveShadow ?? true;
  mesh_monitorWallTower_left_11.userData.sculptComponent = {"id": "monitorWallTower.left", "name": "Monitor-wall tower (left)", "level": "macro", "role": "structural", "importance": 0.9, "confidence": 0.6, "primitive": "box", "topologyClass": "conforming-shell", "topologyRationale": "Raked backing wall (leans inward toward the room's central axis at the top) carrying the tiled screen grid -- the second most identity-defining feature (Layer 7). Screen tiles are hand-authored as a 2D grid loop, not the spec's radial-only repetitionSystem. (topologyClass normalized to the spec's fixed enum.)", "geometryDescriptor": {"topologyIntent": "macro-scale box block, chamfer-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.02, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.5, "height": 8.0, "depth": 8.0, "units": "meters", "confidence": 0.6}, "transform": {"position": [-6.4, 4.0, -1.0], "rotation": [0, -0.55, 0.06], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-structure", "pivot": {"mode": "base", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "simplified box proxy; static set-dressing does not need a tight collider"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "monitorWallTower.left", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "structuralSteel"}}, "material": "structuralSteel", "materialLayers": ["structuralSteel"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "det-screen-tile-grid", "description": "non-uniform tiled grid of individually framed rectangular screens"}, {"id": "det-wall-tower-rake", "description": "wall leans inward toward the room's central axis at the top"}], "surfaceDetail": {"macroRoughness": 0.5, "microRoughness": 0.3, "bumpAmplitude": 0.02, "normalPattern": "panel-seam", "displacementPattern": "", "occlusionPattern": "cavity darkening at seams", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["image-analysis.md#layer-3", "di.json"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(58, 66, 73, 1.0)", "secondaryAlbedo": "rgba(10, 15, 12, 0.85)", "materialClass": "metal", "materialClassConfidence": 0.65, "notes": "derived from material 'structuralSteel' baseColor + di.json zone evidence"}};
  node_monitorWallTower_left_11.add(mesh_monitorWallTower_left_11);
  meshes["monitorWallTower.left"] = mesh_monitorWallTower_left_11;
  colliders["monitorWallTower.left"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "simplified box proxy; static set-dressing does not need a tight collider"};
  destructionGroups["monitorWallTower.left"] ??= [];
  destructionGroups["monitorWallTower.left"].push(node_monitorWallTower_left_11);

  const attachment_monitorWallTower_right_12 = null;
  const endpoint_monitorWallTower_right_12 = makeAttachmentEndpoint(attachment_monitorWallTower_right_12);
  const node_monitorWallTower_right_12 = new THREE.Group();
  node_monitorWallTower_right_12.name = "Monitor-wall tower (right)__pivot";
  if (endpoint_monitorWallTower_right_12) {
    node_monitorWallTower_right_12.position.copy(endpoint_monitorWallTower_right_12.start);
    node_monitorWallTower_right_12.rotation.set(0, 0, 0);
    node_monitorWallTower_right_12.scale.set(1, 1, 1);
  } else {
    node_monitorWallTower_right_12.position.set(6.4, 4.0, -1.0);
    node_monitorWallTower_right_12.rotation.set(0.0, 0.55, -0.06);
    node_monitorWallTower_right_12.scale.set(1.0, 1.0, 1.0);
  }
  node_monitorWallTower_right_12.userData.sculptComponent = {"id": "monitorWallTower.right", "name": "Monitor-wall tower (right)", "level": "macro", "role": "structural", "importance": 0.9, "confidence": 0.6, "primitive": "box", "topologyClass": "conforming-shell", "topologyRationale": "Raked backing wall (leans inward toward the room's central axis at the top) carrying the tiled screen grid -- the second most identity-defining feature (Layer 7). Screen tiles are hand-authored as a 2D grid loop, not the spec's radial-only repetitionSystem. (topologyClass normalized to the spec's fixed enum.)", "geometryDescriptor": {"topologyIntent": "macro-scale box block, chamfer-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.02, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.5, "height": 8.0, "depth": 8.0, "units": "meters", "confidence": 0.6}, "transform": {"position": [6.4, 4.0, -1.0], "rotation": [0, 0.55, -0.06], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-structure", "pivot": {"mode": "base", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "simplified box proxy; static set-dressing does not need a tight collider"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "monitorWallTower.right", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "structuralSteel"}}, "material": "structuralSteel", "materialLayers": ["structuralSteel"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "det-screen-tile-grid", "description": "non-uniform tiled grid of individually framed rectangular screens"}, {"id": "det-wall-tower-rake", "description": "wall leans inward toward the room's central axis at the top"}], "surfaceDetail": {"macroRoughness": 0.5, "microRoughness": 0.3, "bumpAmplitude": 0.02, "normalPattern": "panel-seam", "displacementPattern": "", "occlusionPattern": "cavity darkening at seams", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["image-analysis.md#layer-3", "di.json"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(58, 66, 73, 1.0)", "secondaryAlbedo": "rgba(10, 15, 12, 0.85)", "materialClass": "metal", "materialClassConfidence": 0.65, "notes": "derived from material 'structuralSteel' baseColor + di.json zone evidence"}};
  node_monitorWallTower_right_12.userData.actionProfile = {"animationRole": "static-structure", "pivot": {"mode": "base", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "simplified box proxy; static set-dressing does not need a tight collider"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "monitorWallTower.right", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "structuralSteel"}};
  (nodes["root"] ?? root).add(node_monitorWallTower_right_12);
  nodes["monitorWallTower.right"] = node_monitorWallTower_right_12;
  const mesh_monitorWallTower_right_12Geometry = endpoint_monitorWallTower_right_12
    ? new THREE.CylinderGeometry(endpoint_monitorWallTower_right_12.endRadius, endpoint_monitorWallTower_right_12.baseRadius, endpoint_monitorWallTower_right_12.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  const mesh_monitorWallTower_right_12 = new THREE.Mesh(
    mesh_monitorWallTower_right_12Geometry,
    materialMap["structuralSteel"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_monitorWallTower_right_12.name = "Monitor-wall tower (right)";
  if (endpoint_monitorWallTower_right_12) {
    mesh_monitorWallTower_right_12.position.copy(endpoint_monitorWallTower_right_12.midpoint);
    mesh_monitorWallTower_right_12.quaternion.copy(endpoint_monitorWallTower_right_12.quaternion);
  }
  mesh_monitorWallTower_right_12.castShadow = options.castShadow ?? true;
  mesh_monitorWallTower_right_12.receiveShadow = options.receiveShadow ?? true;
  mesh_monitorWallTower_right_12.userData.sculptComponent = {"id": "monitorWallTower.right", "name": "Monitor-wall tower (right)", "level": "macro", "role": "structural", "importance": 0.9, "confidence": 0.6, "primitive": "box", "topologyClass": "conforming-shell", "topologyRationale": "Raked backing wall (leans inward toward the room's central axis at the top) carrying the tiled screen grid -- the second most identity-defining feature (Layer 7). Screen tiles are hand-authored as a 2D grid loop, not the spec's radial-only repetitionSystem. (topologyClass normalized to the spec's fixed enum.)", "geometryDescriptor": {"topologyIntent": "macro-scale box block, chamfer-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.02, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.5, "height": 8.0, "depth": 8.0, "units": "meters", "confidence": 0.6}, "transform": {"position": [6.4, 4.0, -1.0], "rotation": [0, 0.55, -0.06], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-structure", "pivot": {"mode": "base", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.6}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "simplified box proxy; static set-dressing does not need a tight collider"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "monitorWallTower.right", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "structuralSteel"}}, "material": "structuralSteel", "materialLayers": ["structuralSteel"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "det-screen-tile-grid", "description": "non-uniform tiled grid of individually framed rectangular screens"}, {"id": "det-wall-tower-rake", "description": "wall leans inward toward the room's central axis at the top"}], "surfaceDetail": {"macroRoughness": 0.5, "microRoughness": 0.3, "bumpAmplitude": 0.02, "normalPattern": "panel-seam", "displacementPattern": "", "occlusionPattern": "cavity darkening at seams", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["image-analysis.md#layer-3", "di.json"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(58, 66, 73, 1.0)", "secondaryAlbedo": "rgba(10, 15, 12, 0.85)", "materialClass": "metal", "materialClassConfidence": 0.65, "notes": "derived from material 'structuralSteel' baseColor + di.json zone evidence"}};
  node_monitorWallTower_right_12.add(mesh_monitorWallTower_right_12);
  meshes["monitorWallTower.right"] = mesh_monitorWallTower_right_12;
  colliders["monitorWallTower.right"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "simplified box proxy; static set-dressing does not need a tight collider"};
  destructionGroups["monitorWallTower.right"] ??= [];
  destructionGroups["monitorWallTower.right"].push(node_monitorWallTower_right_12);

  root.userData.sculptRuntime = { nodes, meshes, sockets, colliders, destructionGroups } satisfies ProceduralModelRuntime;
  root.userData.lookDevTargets = {"qualityPriority": "reference-fidelity", "materialPass": {"albedoPaletteRequired": true, "roughnessVariationRequired": true, "normalOrBumpRequired": true, "localOverridesRequired": true, "minimumTextureResolution": 1024, "preferredTextureResolution": 2048, "independentMapChannels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "requiredSurfaceFrequencyBands": ["macro", "meso", "micro"], "geometryReliefRequiredWhenSilhouetteAffected": true, "referencePbrExtraction": {"requiredWhenSourceImagePresent": true, "targetThreshold": 0.7, "stopOnLowConfidence": true, "script": "forge/stage1_intake/extract_pbr_evidence.py", "acceptedLimitation": "single-image extraction is reference-derived inference, not exact photogrammetry"}, "mustAvoid": ["single flat albedo per material", "uniform roughness", "albedo texture reused as roughness/height/normal/AO", "single-frequency random noise", "plastic-looking smooth bark, stone, cloth, foliage, or aged material", "local color/detail described only in prose without material masks", "claiming exact PBR recovery when confidence is below the target threshold"]}, "lightingPass": {"requiredTerms": ["key light", "fill light", "rim or environment light", "exposure", "tone mapping", "background", "contact shadow"], "mustAvoid": ["ambient-only lighting", "flat value range", "missing contact shadow", "reference lighting copied without separating material readability"]}, "screenshotReview": ["Compare albedo palette and local color zones.", "Compare roughness/normal/bump response under light.", "Compare cavity dirt, edge wear, stains, moss, scratches, or other local masks.", "Compare key/fill/rim structure, exposure, tone mapping, background, and contact shadows.", "Capture a neutral-light render to verify material readability without reference lighting.", "Capture a grazing-light close-up to expose flat normals, uniform roughness, tiling, and plastic highlights.", "Capture a reference-matched render from the same camera framing as the source."]};
  root.userData.actionReadiness = {
    note: 'Use root.userData.sculptRuntime.nodes for transforms, sockets for attachments, colliders for physics proxies, and destructionGroups for breakable sets.',
  };
  return root;
}

export function createNERVStyleTacticalCommandRoomLookDevLights(
  mode: 'neutral' | 'grazing' | 'reference' = 'neutral',
): THREE.Group {
  const lights = new THREE.Group();
  lights.name = "NERV-style Tactical Command Room look-dev lights";
  const hemi = new THREE.HemisphereLight(
    mode === 'reference' ? 0xfff0d6 : 0xf2f4ff,
    0x363b42,
    mode === 'grazing' ? 0.28 : mode === 'reference' ? 0.72 : 0.85,
  );
  lights.add(hemi);
  const key = new THREE.DirectionalLight(
    mode === 'reference' ? 0xffcf8a : 0xfff4e8,
    mode === 'grazing' ? 4.2 : mode === 'reference' ? 2.6 : 2.15,
  );
  if (mode === 'grazing') key.position.set(7.5, 1.1, 4.0);
  else if (mode === 'reference') key.position.set(-4.5, 7.5, 5.0);
  else key.position.set(-4.0, 6.0, 5.5);
  key.castShadow = true;
  key.shadow.mapSize.set(4096, 4096);
  key.shadow.bias = -0.00025;
  key.shadow.normalBias = 0.018;
  key.shadow.radius = 7;
  key.shadow.blurSamples = 24;
  key.shadow.camera.near = 0.5;
  key.shadow.camera.far = 30;
  key.shadow.camera.left = -2.6;
  key.shadow.camera.right = 2.6;
  key.shadow.camera.top = 2.6;
  key.shadow.camera.bottom = -2.6;
  key.shadow.camera.updateProjectionMatrix();
  lights.add(key);
  const fill = new THREE.DirectionalLight(0xa8c4ff, mode === 'grazing' ? 0.12 : 0.42);
  fill.position.set(4.0, 3.0, 3.5);
  lights.add(fill);
  const rim = new THREE.DirectionalLight(0xfff1c4, mode === 'grazing' ? 0.28 : 0.85);
  rim.position.set(0.5, 4.5, -6.0);
  lights.add(rim);
  lights.userData.reviewMode = mode;
  lights.userData.lightingFromPhoto = [{"role": "practical/emissive", "source": "screens + logo emblem", "colorHex": "#52F29A", "note": "self-lit scene: the emissive screens and emblem are the dominant light sources, not an external key light"}, {"role": "fill", "source": "cool ambient", "colorHex": "#3A5344", "intensityNote": "low, keeps structural steel legible without washing out emissive contrast"}, {"role": "rim", "source": "orange accent bounce", "colorHex": "#F26400", "intensityNote": "sparse, only visible on trim edges"}, {"role": "camera/exposure", "source": "ACES filmic tone mapping, exposure ~1.1-1.3", "note": "self-lit emissive scene needs filmic tone mapping to keep screen hot-spots from clipping while structural steel stays legible; contact/ground shadow (SSAO-equivalent cavity darkening) at floor-pit rim and stair/catwalk footings"}];
  lights.userData.lookDevTargets = {"qualityPriority": "reference-fidelity", "materialPass": {"albedoPaletteRequired": true, "roughnessVariationRequired": true, "normalOrBumpRequired": true, "localOverridesRequired": true, "minimumTextureResolution": 1024, "preferredTextureResolution": 2048, "independentMapChannels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "requiredSurfaceFrequencyBands": ["macro", "meso", "micro"], "geometryReliefRequiredWhenSilhouetteAffected": true, "referencePbrExtraction": {"requiredWhenSourceImagePresent": true, "targetThreshold": 0.7, "stopOnLowConfidence": true, "script": "forge/stage1_intake/extract_pbr_evidence.py", "acceptedLimitation": "single-image extraction is reference-derived inference, not exact photogrammetry"}, "mustAvoid": ["single flat albedo per material", "uniform roughness", "albedo texture reused as roughness/height/normal/AO", "single-frequency random noise", "plastic-looking smooth bark, stone, cloth, foliage, or aged material", "local color/detail described only in prose without material masks", "claiming exact PBR recovery when confidence is below the target threshold"]}, "lightingPass": {"requiredTerms": ["key light", "fill light", "rim or environment light", "exposure", "tone mapping", "background", "contact shadow"], "mustAvoid": ["ambient-only lighting", "flat value range", "missing contact shadow", "reference lighting copied without separating material readability"]}, "screenshotReview": ["Compare albedo palette and local color zones.", "Compare roughness/normal/bump response under light.", "Compare cavity dirt, edge wear, stains, moss, scratches, or other local masks.", "Compare key/fill/rim structure, exposure, tone mapping, background, and contact shadows.", "Capture a neutral-light render to verify material readability without reference lighting.", "Capture a grazing-light close-up to expose flat normals, uniform roughness, tiling, and plastic highlights.", "Capture a reference-matched render from the same camera framing as the source."]};
  return lights;
}

// PBR materials (clearcoat/iridescence/transmission/anisotropy) need an environment
// map to visually behave as intended — call this once per renderer and assign the
// result to scene.environment before rendering. No external HDR asset required.
export function createNERVStyleTacticalCommandRoomEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const texture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
  return texture;
}

// Plan 1.3 §3.2 — auto-framing by bounding box. The Divine Eye can only compare a
// render to the reference if the object is FRAMED consistently (an object framed
// differently scores as wrong even when its shape is right). This positions the camera
// deterministically from the object's bounding box so it fills the frame at a stable
// margin, and sets near/far to the object scale. Call after adding the model to the
// scene, and again on resize (after updating camera.aspect).
export function frameNERVStyleTacticalCommandRoomCamera(
  camera: THREE.PerspectiveCamera,
  object: THREE.Object3D,
  options: { margin?: number; azimuthDeg?: number; elevationDeg?: number } = {},
): void {
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const margin = options.margin ?? 1.15;
  const maxDim = Math.max(size.x, size.y, size.z) * margin;
  const fov = (camera.fov * Math.PI) / 180;
  // distance so the largest object dimension fits vertically in the frame
  const distance = (maxDim / 2) / Math.tan(fov / 2);
  const az = ((options.azimuthDeg ?? 0) * Math.PI) / 180;
  const el = ((options.elevationDeg ?? 0) * Math.PI) / 180;
  const dir = new THREE.Vector3(
    Math.sin(az) * Math.cos(el),
    Math.sin(el),
    Math.cos(az) * Math.cos(el),
  );
  camera.position.copy(center).addScaledVector(dir, distance);
  camera.near = Math.max(0.01, distance - maxDim);
  camera.far = distance + maxDim * 2;
  camera.lookAt(center);
  camera.updateProjectionMatrix();
}

// Plan 1.3 §3.2c — PRESENTATION composer (DOF + bloom). CRITICAL (R-POSTFX): this is
// for the showcase/hero render ONLY. The Divine Eye's EVALUATION render MUST use a
// plain renderer with NO composer — bloom blows highlights and DOF blurs edges, which
// would corrupt the deterministic IoU/DCD/edge/blowout signals. Enable dof/bloom ONLY
// when the reference photo actually exhibits them (detect_reference_effects.py authorizes).
export function createNERVStyleTacticalCommandRoomPresentationComposer(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  options: { dof?: boolean; bloom?: boolean; bloomStrength?: number; dofFocus?: number; dofAperture?: number } = {},
): EffectComposer {
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  if (options.dof) {
    composer.addPass(new BokehPass(scene, camera, {
      focus: options.dofFocus ?? 10.0,
      aperture: options.dofAperture ?? 0.0002,
      maxblur: 0.01,
    }));
  }
  if (options.bloom) {
    const size = new THREE.Vector2();
    renderer.getSize(size);
    composer.addPass(new UnrealBloomPass(size, options.bloomStrength ?? 0.4, 0.4, 0.85));
  }
  return composer;
}

export function configureNERVStyleTacticalCommandRoomRenderer(renderer: THREE.WebGLRenderer): void {
  // Load-bearing for view-dependent finishes (anodized / Doppler): without ACES + sRGB
  // the environment reflection reads flat/washed instead of a believable metal response.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
}

export function createNERVStyleTacticalCommandRoomInspectControls(
  camera: THREE.Camera,
  domElement: HTMLElement,
): OrbitControls {
  // View-dependent finishes only read correctly once the user orbits — their color
  // comes from the environment reflection, not albedo, so free rotation matters here.
  const controls = new OrbitControls(camera, domElement);
  controls.enableDamping = true;
  controls.minDistance = 1.0;
  controls.maxDistance = 8.0;
  controls.autoRotate = false;
  return controls;
}
