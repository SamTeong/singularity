// Ported from docs/one-shot/3d/sample-gitlab-3d-scan.html, L1149-1666 (the
// Three.js world) and the boot chain at L1602-1666. See the module-level
// comments below for what changed to make this teardown-safe — the source
// never destroyed itself.
import * as THREE from 'three';
import { CSS3DRenderer } from 'three/addons/renderers/CSS3DRenderer.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

import { CHAPTERS, STEPS_BY_INDEX, STEP_BAND_SPAN } from '../config/chapters';
import { clamp, damp, lerp, pad } from '../lib/math';
import { createScrollConductor, type ScrollConductor } from './conductor';
import { anchorOf, framingDistance } from './cameraPath';
import { buildPanel, remeasurePanel, type Panel } from './panels';
import { addAtmosphere } from './atmosphere';
import { drawDebugCurves, updateDebug } from './debug';
import { createHitBridge, type HitBridge } from './hitBridge';
import { clearSpacerHeights } from './spacerLayout';
import { fetchModelBuffer, parseModel, fitModel } from './loadModel';
import type { WorldOptions, World, ConductorState } from './types';

const MODEL_SIZE = 12; // longest bbox axis, in world units
// `import.meta.env.BASE_URL`, never a hardcoded '/scan-atrium.glb' — the site
// deploys to a GitHub Pages project subpath, and an absolute path 404s there.
const MODEL_URL = `${import.meta.env.BASE_URL}scan-atrium.glb`;

// Thrown by ck() to unwind a cancelled boot chain to its one catch site.
// Never surfaced to onFail — it means "a destroy() already happened",
// not "something went wrong".
const CANCELLED = Symbol('world-boot-cancelled');

interface Insertion {
  parent: Node;
  next: ChildNode | null;
}

export function createWorld(o: WorldOptions): World {
  // ---- lifecycle flags -----------------------------------------------
  let destroyed = false;
  let cancelled = false;
  let ready = false;
  let rafId = 0;

  // ---- DOM the world owns (see WorldOptions.stage doc in types.ts) ----
  let canvas: HTMLCanvasElement | null = null;
  let cssHost: HTMLDivElement | null = null;

  // ---- three.js state ---------------------------------------------------
  let renderer: THREE.WebGLRenderer | undefined;
  let cssRenderer: CSS3DRenderer | undefined;
  let scene: THREE.Scene | undefined;
  let camera: THREE.PerspectiveCamera | undefined;
  let composer: EffectComposer | undefined;
  let bloomPass: UnrealBloomPass | undefined;
  let clock: THREE.Clock | undefined;
  let pathRig: THREE.Group | undefined;
  let inputRig: THREE.Group | undefined;
  let worldRoot: THREE.Group | undefined;
  let panelsGroup: THREE.Group | undefined;
  let atmosphereGroup: THREE.Group | undefined;
  let motes: THREE.Points | null = null;
  let moteMat: THREE.PointsMaterial | null = null;
  let modelRoot: THREE.Object3D | undefined;
  let bbox: THREE.Box3 | null = null;
  let curvePos: THREE.CatmullRomCurve3 | undefined;
  let curveTarget: THREE.CatmullRomCurve3 | undefined;
  let orientations: THREE.Quaternion[] = [];
  let debugGroup: THREE.Group | null = null;
  let hitBridge: HitBridge | null = null;

  let panels: Panel[] = [];
  let waypoints: THREE.Vector3[] = [];
  let targets: THREE.Vector3[] = [];
  let insertionPoints: Insertion[] = [];
  let conductor: ScrollConductor | null = null;
  let lastState: ConductorState | null = null;

  const pointer = { x: 0, y: 0, tx: 0, ty: 0 };
  let mobile = matchMedia('(max-width: 900px)').matches;

  // fps counter starts its clock at world-creation time, not at first
  // animate() — matches the source, whose `fpsLast` is a module-level
  // `performance.now()` set well before the model finishes loading. The
  // first post-boot readout is briefly low as a result; that is the
  // source's own behaviour, not a bug this port introduces.
  let fpsLast = performance.now();
  let frames = 0;

  const tmpPos = new THREE.Vector3();
  const tmpTarget = new THREE.Vector3();
  const UP = new THREE.Vector3(0, 1, 0);
  const lookMatrix = new THREE.Matrix4();
  const forwardVec = new THREE.Vector3();
  const worldState = { fog: 0.05, bloom: 0.62, motes: 0.85, exposure: 1.06 };

  function ck(): void {
    if (destroyed || cancelled) throw CANCELLED;
  }

  // ============================================================ INIT
  function onPointerMove(e: PointerEvent): void {
    pointer.tx = (e.clientX / innerWidth - 0.5) * 2;
    pointer.ty = (e.clientY / innerHeight - 0.5) * 2;
  }

  function onContextLost(e: Event): void {
    e.preventDefault();
    ready = false;
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
    o.onFail('GRAPHICS CONTEXT LOST · DECK CONTINUES BELOW', { showError: true });
  }

  function addWorldListeners(): void {
    addEventListener('resize', onResize, { passive: true });
    if (!o.reducedMotion && !matchMedia('(pointer: coarse)').matches) {
      addEventListener('pointermove', onPointerMove, { passive: true });
    }
    canvas?.addEventListener('webglcontextlost', onContextLost);
  }

  function removeWorldListeners(): void {
    removeEventListener('resize', onResize);
    removeEventListener('pointermove', onPointerMove);
    canvas?.removeEventListener('webglcontextlost', onContextLost);
  }

  // A <canvas> can only ever have one live WebGL context — getContext on one
  // that already has one returns the existing context, and after
  // forceContextLoss() a permanently dead one. React StrictMode double-mounts
  // in dev, so the world must create its own virgin canvas every time rather
  // than adopting anything React rendered.
  function initThree(): void {
    canvas = document.createElement('canvas');
    canvas.id = 'gl';
    canvas.setAttribute('aria-hidden', 'true');
    cssHost = document.createElement('div');
    cssHost.id = 'css3d';
    o.stage.append(canvas, cssHost);

    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, mobile ? 1.35 : 1.6));
    renderer.setSize(innerWidth, innerHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    // The scan is KHR_materials_unlit with a baked albedo — filmic tone
    // mapping would grey it out, so the scan opts out per-material below.
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;

    cssRenderer = new CSS3DRenderer({ element: cssHost });
    cssRenderer.setSize(innerWidth, innerHeight);

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x070908);
    scene.fog = new THREE.FogExp2(0x070908, 0.05);

    camera = new THREE.PerspectiveCamera(42, innerWidth / innerHeight, 0.08, 600);
    inputRig = new THREE.Group();
    pathRig = new THREE.Group();
    inputRig.add(camera);
    pathRig.add(inputRig);
    scene.add(pathRig);

    worldRoot = new THREE.Group();
    worldRoot.name = 'world';
    panelsGroup = new THREE.Group();
    panelsGroup.name = 'panels';
    atmosphereGroup = new THREE.Group();
    atmosphereGroup.name = 'atmosphere';
    worldRoot.add(panelsGroup, atmosphereGroup);
    scene.add(worldRoot);

    composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    bloomPass = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.62, 0.34, 0.62);
    composer.addPass(bloomPass);
    composer.addPass(new OutputPass());

    clock = new THREE.Clock();
    addWorldListeners();
  }

  // ============================================================ PANELS
  function buildPanels(): void {
    insertionPoints = o.panels.map((el) => {
      const parent = el.parentNode;
      if (!parent) throw new Error('[world] panel element is not attached to the DOM');
      return { parent, next: el.nextSibling };
    });
    panels = CHAPTERS.map((chapter, i) => buildPanel(chapter, o.panels[i], mobile, bbox!, panelsGroup!));
    const roScreens = document.getElementById('roScreens');
    if (roScreens) roScreens.textContent = pad(panels.length);
  }

  // Waypoints are derived, not authored: each is the anchor pushed out along
  // the screen normal by the distance that frames it. Rebuilt whenever
  // aspect changes, so a resize never leaves a panel half out of frame.
  function buildCurves(): void {
    waypoints = [];
    targets = [];
    orientations = [];
    panels.forEach((panel) => {
      const { chapter, worldH, normal } = panel;
      const anchor = anchorOf(chapter, bbox!);
      const d = framingDistance(camera!, chapter.w, worldH, chapter.fill);
      panel.frameDist = d;
      const waypoint = anchor.clone().addScaledVector(normal, d).add(new THREE.Vector3(0, chapter.lift || 0, 0));
      waypoints.push(waypoint);
      targets.push(anchor.clone());
      // The exact orientation this chapter is composed at: square-on to its
      // screen. Interpolating BETWEEN these is what updateWorld does, instead
      // of re-deriving a look-at every frame — see the note there.
      lookMatrix.lookAt(waypoint, anchor, UP);
      orientations.push(new THREE.Quaternion().setFromRotationMatrix(lookMatrix));
    });
    curvePos = new THREE.CatmullRomCurve3(waypoints, false, 'centripetal', 0.5);
    curveTarget = new THREE.CatmullRomCurve3(targets, false, 'centripetal', 0.5);
    if (o.debug) {
      debugGroup = drawDebugCurves(atmosphereGroup!, curvePos, curveTarget, panels, debugGroup);
    }
  }

  // ============================================================ PER-FRAME

  /** Eases the camera into and out of every waypoint.
   *
   *  Without this the camera crosses a chapter at whatever constant speed the
   *  scroll is producing and arrives at each composition still moving, which is
   *  what "drifting" or "never settling" looks like. Applying an ease to the
   *  FRACTIONAL part of the progress — leaving the integer part untouched, so
   *  chapter i still resolves to exactly waypoint i — makes the dolly decelerate
   *  as it reaches a screen and accelerate away from it. Same total travel, same
   *  reversibility, same scroll position ⇒ same state; only the distribution of
   *  speed within a segment changes.
   *
   *  Blended rather than pure smoothstep: at SETTLE = 1 the derivative is zero
   *  at every waypoint, which reads as the camera sticking to each screen and
   *  makes a fast scroll feel unresponsive. 0.62 keeps a floor of motion through
   *  the waypoint while still clearly settling.
   *
   *  Not applied to `resolveWorld` — fog, bloom and exposure interpolate on the
   *  raw progress, because easing those too would make the atmosphere visibly
   *  lurch at each seam. */
  const SETTLE = 0.62;
  function easeSettle(progress: number): number {
    const i = Math.floor(progress);
    const t = progress - i;
    // smoothstep: 3t² - 2t³, zero derivative at both ends
    const eased = t * t * (3 - 2 * t);
    return i + lerp(t, eased, SETTLE);
  }

  function resolveWorld(progress: number): void {
    const i = clamp(Math.floor(progress), 0, CHAPTERS.length - 1);
    const j = Math.min(CHAPTERS.length - 1, i + 1);
    const t = clamp(progress - i, 0, 1);
    const a = CHAPTERS[i].world;
    const b = CHAPTERS[j].world;
    worldState.fog = lerp(a.fog, b.fog, t);
    worldState.bloom = lerp(a.bloom, b.bloom, t);
    worldState.motes = lerp(a.motes, b.motes, t);
    worldState.exposure = lerp(a.exposure, b.exposure, t);
    (scene!.fog as THREE.FogExp2).density = worldState.fog;
    bloomPass!.strength = worldState.bloom;
    renderer!.toneMappingExposure = worldState.exposure;
    if (moteMat) moteMat.opacity = 0.55 * worldState.motes;
  }

  /** Scroll progress with the stepped chapters' dwell taken out of it. */
  function dwellProgress(s: number): number {
    const i = Math.floor(s);
    const steps = STEPS_BY_INDEX[i] ?? 0;
    if (!steps) return s;
    const local = s - i;
    if (local <= STEP_BAND_SPAN) return i;
    return i + (local - STEP_BAND_SPAN) / (1 - STEP_BAND_SPAN);
  }

  function updateWorld(state: ConductorState): void {
    lastState = state;
    // Story position, not scroll position: a chapter with in-chapter steps
    // (see config's `steps`) holds the camera still for the first
    // STEP_BAND_SPAN of its segment, which is exactly the stretch its steps
    // are read on — the panel being stepped through must not sail past while
    // the reader is working the tabs. The remaining scroll carries the whole
    // journey to the next chapter. Everything downstream of here — camera,
    // atmosphere, panel opacity — reads this, so the dwell is total. The dwell
    // is taken out BEFORE the easing: easeSettle shapes the approach to a
    // chapter, and there is nothing to shape while the camera is parked.
    const story = dwellProgress(state.smooth);

    // CatmullRomCurve3.getPoint(t) maps t to SEGMENT INDEX, so dividing by
    // (N-1) lands chapter i exactly on waypoint i — that correspondence is
    // what makes every composition reproducible, and it must survive the
    // easing below.
    const last = CHAPTERS.length - 1;
    const eased = easeSettle(story);
    const qi = clamp(Math.floor(eased), 0, last);
    const qj = Math.min(last, qi + 1);
    const t = clamp(eased - qi, 0, 1);

    // getPoint maps its parameter to control-point INDEX, so dividing by
    // (N - 1) lands chapter i exactly on waypoint i.
    const p = eased / Math.max(1, last);
    curvePos!.getPoint(clamp(p, 0, 1), tmpPos);
    // Feeds the debug readout only — orientation is slerped, not looked-at.
    curveTarget!.getPoint(clamp(p, 0, 1), tmpTarget);
    pathRig!.position.copy(tmpPos);

    // ORIENTATION IS SLERPED BETWEEN THE TWO BRACKETING CHAPTERS, not derived
    // from a look-at at the target curve. That matters because the target curve
    // can pass arbitrarily close to the camera: `workflow` and `local` face
    // opposite ways across the atrium, and between them the interpolated target
    // comes within 0.84 world units of the interpolated camera position. A
    // look-at over a direction vector that short is a singularity — a tiny
    // positional change swings the view through a huge angle, which is the
    // whip/jank you see at that seam. Slerping two fixed, already-composed
    // orientations cannot do that: it is a bounded, constant-rate rotation
    // along the shortest arc, and at t=0/1 it reproduces each chapter's
    // authored framing exactly.
    if (orientations[qi] && orientations[qj]) {
      pathRig!.quaternion.slerpQuaternions(orientations[qi], orientations[qj], t);
      // On a `via` manoeuvre, hold the segment's look target through the middle
      // of the turn. The plain slerp above is the base and still owns both
      // ends, so each chapter's framing is reproduced exactly; `hold` peaks at
      // the midpoint, which is precisely where the base slerp is least
      // trustworthy (antiparallel framings have no well-defined halfway
      // orientation — that is what this exists to replace).
    }
    resolveWorld(story);

    // Relevance window: only the current chapter and its neighbours stay
    // mounted, and only while they are actually in front of the camera.
    // CSS3DRenderer rewrites element.style.display from each CSS3DObject's
    // own `visible` flag, so hiding the parent group is not enough — the
    // object must be flagged too.
    forwardVec.set(0, 0, -1).applyQuaternion(pathRig!.quaternion);
    panels.forEach((panel, i) => {
      const near = 1 - Math.abs(i - story);
      const toPanel = panel.group.position.clone().sub(tmpPos);
      const on = near > 0.001 && toPanel.dot(forwardVec) > 0;
      panel.group.visible = on;
      panel.css.visible = on;
      panel.el.style.display = on ? '' : 'none';
      if (!on) return;
      const dist = toPanel.length();
      const byDist = clamp(1 - (dist / (panel.frameDist || dist) - 1) / 1.6, 0.12, 1);
      const fade = Math.min(byDist, clamp(near * 1.6, 0, 1));
      panel.el.style.opacity = String(fade);
      panel.frameMat.opacity = 0.35 + 0.55 * fade;
    });

    // #sxProgress/#roProg are intentionally NOT written here — both are
    // derivable outside the world from `state.exact` and the live
    // scrollY/scrollHeight globals, so the React side (Phase 5) owns them
    // via onFrame. See types.ts's WorldOptions.onFrame doc.
    o.onFrame(state);
  }

  function writeDebug(): void {
    const el = document.getElementById('sxDbg');
    if (!el || !lastState || !camera || !pathRig || !renderer) return;
    updateDebug(el, {
      state: lastState,
      camera,
      pathRig,
      target: tmpTarget,
      rendererInfo: renderer.info,
      worldState,
      bbox,
      chapterId: CHAPTERS[Math.round(lastState.exact)]?.id,
    });
  }

  function animate(): void {
    rafId = requestAnimationFrame(animate);
    if (!ready || document.hidden) return;
    const dt = Math.min(clock!.getDelta(), 1 / 30);

    // clamped pointer parallax — ambience on its own rig, never story state
    pointer.x = damp(pointer.x, pointer.tx, 3.4, dt);
    pointer.y = damp(pointer.y, pointer.ty, 3.4, dt);
    const settle = lastState ? 1 - Math.abs(0.5 - (lastState.localSmooth || 0)) * 1.2 : 1;
    inputRig!.position.set(pointer.x * 0.16 * settle, -pointer.y * 0.1 * settle, 0);

    if (motes) motes.rotation.y += dt * 0.012;
    composer!.render();
    cssRenderer!.render(scene!, camera!);

    frames++;
    const now = performance.now();
    if (now - fpsLast > 500) {
      // #roFps/#sxDbg need renderer/camera/bbox internals the world never
      // hands to React, so — unlike #sxProgress/#roProg — the world writes
      // these two directly, exactly as the source did via `$('#roFps')`.
      const fpsEl = document.getElementById('roFps');
      if (fpsEl) fpsEl.textContent = Math.round((frames * 1000) / (now - fpsLast)) + ' FPS';
      frames = 0;
      fpsLast = now;
      if (o.debug) writeDebug();
    }
  }

  // ============================================================ RESIZE
  function onResize(): void {
    const wasMobile = mobile;
    mobile = matchMedia('(max-width: 900px)').matches;
    camera!.aspect = innerWidth / innerHeight;
    camera!.updateProjectionMatrix();
    renderer!.setPixelRatio(Math.min(devicePixelRatio || 1, mobile ? 1.35 : 1.6));
    renderer!.setSize(innerWidth, innerHeight);
    cssRenderer!.setSize(innerWidth, innerHeight);
    composer!.setSize(innerWidth, innerHeight);
    bloomPass!.setSize(innerWidth, innerHeight);
    if (!ready) return;
    if (wasMobile !== mobile) {
      panels.forEach((panel) => remeasurePanel(panel, mobile));
    }
    buildCurves();
    const before = conductor ? conductor.getState().exact : 0;
    conductor?.measure();
    conductor?.setProgress(before);
    o.emitRelayout();
  }

  // ============================================================ ENTER 3D
  function enter3D(): void {
    // SYNCHRONOUS: buildPanels() measures offsetHeight right after this
    // returns, and needs body.mode-3d already applied / body.booting
    // already removed — `.chapter.as-panel` changes padding/overflow/flex.
    // Measuring under the wrong class state makes every worldH wrong, which
    // propagates through framingDistance() into every camera waypoint.
    o.setMode('3d');
    buildPanels();
    buildCurves();
    ready = true; // before start() — updateWorld fires on the first tick
    conductor = createScrollConductor({
      sections: o.spacers,
      weights: CHAPTERS.map((c) => c.weight),
      // 3.8, down from the source's 5.2. The damped copy of scroll progress is
      // what the camera rides (the exact copy still drives navigation, the HUD
      // and interaction gating), so a lower rate buys a longer, smoother glide
      // at the cost of trailing scroll slightly further. Below ~3 it starts to
      // feel disconnected from the wheel; above ~5 the easing in easeSettle is
      // wasted because the follow snaps through it.
      damping: 3.8,
      reducedMotion: o.reducedMotion,
      onUpdate: updateWorld,
      onChapterChange: (index) => o.onChapter(index),
    });
    conductor.start();
    // After buildPanels(), so getPanels() can never see a half-built list.
    // Reads `panels` through a closure rather than a snapshot because
    // remeasurePanel mutates entries in place on a breakpoint change.
    hitBridge = createHitBridge(canvas!, camera!, () => panels);
    o.onChapter(0);
    o.emitRelayout();
  }

  // ============================================================ BOOT
  async function bootChain(): Promise<void> {
    o.onStatus('FETCHING GEOMETRY BUFFER…');
    await document.fonts?.ready?.catch?.(() => {});
    ck();

    if (!window.WebGL2RenderingContext || !document.createElement('canvas').getContext('webgl2')) {
      o.onFail('WEBGL2 UNAVAILABLE IN THIS BROWSER', { showError: true });
      return;
    }

    initThree();
    ck();

    const buffer = await fetchModelBuffer(MODEL_URL, (loaded, total) => {
      if (total) o.onProgress((loaded / total) * 100);
    });
    ck();

    const gltf = await parseModel(buffer);
    ck();

    modelRoot = gltf.scene;
    const maxAniso = renderer!.capabilities.getMaxAnisotropy();
    modelRoot.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (!mesh.isMesh) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      mats.forEach((mat) => {
        if (!mat) return;
        // Unlit, baked albedo (KHR_materials_unlit -> MeshBasicMaterial).
        const m = mat as THREE.MeshBasicMaterial;
        m.toneMapped = false;
        // The bake is near-white. Untinted it sits above the bloom
        // threshold and the whole building glows, so multiply it down into
        // the deck's palette instead of fighting it in post.
        m.color.setHex(0x54655c);
        m.side = THREE.DoubleSide;
        if (m.map) {
          m.map.anisotropy = Math.min(8, maxAniso);
          m.map.needsUpdate = true;
        }
        m.needsUpdate = true;
      });
    });
    bbox = fitModel(modelRoot, MODEL_SIZE);
    worldRoot!.add(modelRoot);
    const atm = addAtmosphere(atmosphereGroup!, Math.max(bbox.max.x - bbox.min.x, bbox.max.z - bbox.min.z) / 2, o.reducedMotion);
    motes = atm.motes;
    moteMat = atm.moteMat;
    ck();

    o.onStatus('COMPILING SHADERS…');
    o.onProgress(100);
    if (typeof renderer!.compileAsync === 'function') {
      try {
        await renderer!.compileAsync(scene!, camera!);
      } catch {
        // Non-fatal — the first real frame will just compile lazily.
      }
    }
    ck();

    // Derived, not hardcoded. The source hardcodes '07 SCREENS' at L1640 even
    // though it computes #roScreens two lines earlier — that goes stale the
    // moment a chapter is added or removed, which is a routine edit here.
    //
    // CHAPTERS.length, NOT panels.length: this line runs before enter3D() ->
    // buildPanels() has populated `panels`, so the latter reads 0 here.
    o.onStatus(`DECK MOUNTED · ${pad(CHAPTERS.length)} SCREENS`);
    enter3D();
    ck();
    animate();
  }

  function boot(): void {
    bootChain().catch((err: unknown) => {
      if (err === CANCELLED) return;
      console.error('[world] boot failed', err);
      o.onFail('MODEL FETCH FAILED · SERVE OVER HTTP(S)', { showError: true });
    });
  }

  // ============================================================ DESTROY
  function restoreDom(): void {
    panels.forEach((panel, i) => {
      // CSS3DObject's constructor registers a `removed` listener that calls
      // element.remove() — group.remove(css) below takes the <section> out
      // of the document entirely, not back to its original parent. Restore
      // it explicitly at the exact offset captured before buildPanel ever
      // touched it.
      panel.group.remove(panel.css);
      const el = panel.el;
      const insertion = insertionPoints[i];
      if (insertion) {
        const { parent, next } = insertion;
        if (next && next.parentNode === parent) {
          parent.insertBefore(el, next);
        } else {
          parent.appendChild(el);
        }
      }
      el.classList.remove('as-panel');
      el.style.removeProperty('width');
      el.style.removeProperty('height');
      el.style.removeProperty('display');
      el.style.removeProperty('opacity');
      // CSS3DObject's own constructor mutations — inverse them too, or a
      // stray inline `position:absolute` overrides `.chapter{position:
      // relative}` and breaks flat-mode layout after teardown.
      el.style.removeProperty('position');
      el.style.removeProperty('pointer-events');
      el.style.removeProperty('user-select');
      el.removeAttribute('draggable');
      // CSS3DRenderer writes the object's matrix onto the element every frame
      // (`transform: translate(-50%,-50%) matrix3d(...)`, plus the -webkit-
      // prefixed form). Leaving it behind scales each section to ~0.004 and
      // translates it out of the viewport, so the restored flat deck renders
      // BLANK — visible only in a screenshot, never in a DOM assertion that
      // checks width/height/display/opacity.
      el.style.removeProperty('transform');
      el.style.removeProperty('-webkit-transform');
      el.style.removeProperty('transform-style');
      el.style.removeProperty('-webkit-transform-style');
      // Belt and braces: if the world ever ends up as the only author of the
      // style attribute, drop it wholesale rather than leaving `style=""`.
      if (el.getAttribute('style')?.trim() === '') el.removeAttribute('style');
    });
    clearSpacerHeights(o.spacers);
  }

  function disposeSceneObjects(): void {
    if (!scene) return;
    scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const material = mesh.material;
      if (!material) return;
      const materials = Array.isArray(material) ? material : [material];
      materials.forEach((m) => {
        Object.values(m).forEach((value: unknown) => {
          if (value && typeof value === 'object' && 'isTexture' in value) {
            (value as THREE.Texture).dispose();
          }
        });
        m.dispose();
      });
    });
    panels.forEach((p) => p.frameMat.dispose());
  }

  function destroy(): void {
    if (destroyed) return; // idempotent
    destroyed = true;
    cancelled = true;
    ready = false;

    // Loops first — one more animate()/conductor tick would rewrite
    // style.display on DOM restoreDom() is about to move.
    try {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
    } catch (err) {
      console.error('[world] destroy: cancelAnimationFrame failed', err);
    }
    try {
      conductor?.stop();
    } catch (err) {
      console.error('[world] destroy: conductor.stop failed', err);
    }

    try {
      removeWorldListeners();
      hitBridge?.dispose();
      hitBridge = null;
    } catch (err) {
      console.error('[world] destroy: removeWorldListeners failed', err);
    }

    // MUST run before anything that can throw — a lost context makes every
    // GPU disposal below throw, and that must never skip DOM restoration.
    try {
      restoreDom();
    } catch (err) {
      console.error('[world] destroy: restoreDom failed', err);
    }

    try {
      if (cssHost) {
        cssHost.remove();
        cssHost = null;
      }
    } catch (err) {
      console.error('[world] destroy: css3d host removal failed', err);
    }

    try {
      disposeSceneObjects();
    } catch (err) {
      console.error('[world] destroy: scene disposal failed', err);
    }
    try {
      moteMat?.dispose();
    } catch (err) {
      console.error('[world] destroy: moteMat dispose failed', err);
    }
    try {
      bloomPass?.dispose();
    } catch (err) {
      console.error('[world] destroy: bloomPass dispose failed', err);
    }
    try {
      composer?.dispose();
    } catch (err) {
      console.error('[world] destroy: composer dispose failed', err);
    }
    try {
      renderer?.dispose();
    } catch (err) {
      console.error('[world] destroy: renderer dispose failed', err);
    }
    try {
      // Mandatory, not hygiene: browsers cap live WebGL contexts (~16) and
      // renderer.dispose() alone does not release the drawing buffer.
      // Without this a few StrictMode/HMR cycles exhaust the pool and the
      // next getContext('webgl2') returns null.
      renderer?.forceContextLoss();
    } catch (err) {
      console.error('[world] destroy: forceContextLoss failed', err);
    }

    try {
      if (canvas) {
        canvas.remove();
        canvas = null;
      }
    } catch (err) {
      console.error('[world] destroy: canvas removal failed', err);
    }

    renderer = undefined;
    cssRenderer = undefined;
    scene = undefined;
    camera = undefined;
    composer = undefined;
    bloomPass = undefined;
    clock = undefined;
    pathRig = undefined;
    inputRig = undefined;
    worldRoot = undefined;
    panelsGroup = undefined;
    atmosphereGroup = undefined;
    motes = null;
    moteMat = null;
    modelRoot = undefined;
    bbox = null;
    curvePos = undefined;
    curveTarget = undefined;
    orientations = [];
    debugGroup = null;
    panels = [];
    waypoints = [];
    targets = [];
    insertionPoints = [];
    conductor = null;
    lastState = null;
  }

  // ============================================================ PUBLIC API
  function goTo(index: number): void {
    if (!ready || !conductor) return;
    conductor.goTo(index);
  }

  function seek(progress: number): void {
    if (!ready || !conductor) return;
    conductor.setProgress(progress, true);
  }

  function topAt(progress: number): number {
    if (!ready || !conductor) return 0;
    return conductor.topAt(progress);
  }

  return { boot, goTo, seek, topAt, destroy };
}
