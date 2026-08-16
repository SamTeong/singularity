// Interfaces for the imperative Three.js world (src/world/) and its React
// mount point. `createWorld(o: WorldOptions): World` is the sole public
// entry point of this directory — every other module here is an internal
// implementation detail consumed only from createWorld.ts and its siblings.

/** App-level render mode. `setMode` (see WorldOptions) must apply the
 *  matching `body.mode-3d` / `body.booting` classes synchronously — the
 *  source's CSS keys visibility of #gl/#css3d/.sx-hud/etc. off those classes
 *  (see chrome.css:70), and buildPanels() measures panel offsetHeight right
 *  after 'mode-3d' should already be in effect (see createWorld.ts:enter3D). */
export type Mode = 'loading' | '3d' | 'flat' | 'error';

/** Mirrors createScrollConductor's `state()` return shape (conductor.ts),
 *  ported from the one-shot's scroll conductor at L1076-1080. */
export interface ConductorState {
  exact: number;
  smooth: number;
  index: number;
  next: number;
  localExact: number;
  smoothIndex: number;
  smoothNext: number;
  localSmooth: number;
  direction: number;
  anchors: number[];
}

export interface WorldOptions {
  /** React-rendered, empty; createWorld creates the #gl canvas and #css3d
   *  CSS3DRenderer host inside it (see createWorld.ts:initThree). A canvas
   *  can only ever bind one live WebGL context, so the world must own and
   *  create its own — never adopt a canvas React already rendered. */
  stage: HTMLElement;
  /** The 7 `.beat` wrapper `<div>`s, index-aligned with CHAPTERS. The
   *  conductor measures/sizes these directly (conductor.ts measure()). */
  beats: HTMLElement[];
  /** The 7 `<section class="chapter …">` elements, index-aligned with
   *  CHAPTERS. The world takes DOM ownership of these via CSS3DObject —
   *  see Beat.tsx's PANEL DOM CONTRACT for the invariants this depends on. */
  panels: HTMLElement[];
  reducedMotion: boolean;
  debug: boolean;
  /** CONTRACT: must apply body classes synchronously before returning —
   *  buildPanels() measures offsetHeight immediately afterward and depends
   *  on `.chapter.as-panel`'s layout already being in effect. */
  setMode(mode: Mode): void;
  onStatus(text: string): void;
  onProgress(pct: number): void;
  onFail(message: string, opts: { showError: boolean }): void;
  /** Every frame, ref writes only — never setState. The world does not
   *  write #sxProgress/#roProg itself; both are derivable from `state`
   *  (state.exact) and the live `scrollY`/`scrollHeight` globals alone, so
   *  the React side owns them. #roFps/#sxDbg/#roScreens need renderer/
   *  camera/bbox internals the world never exposes, so the world writes
   *  those directly via getElementById — see createWorld.ts's report note. */
  onFrame(state: ConductorState): void;
  /** Chapter change only — setState is fine. Also the hook for chapter-id
   *  conditional side effects the source's updateDom() ran inline (L1450-51:
   *  renderTerminal() for 'control', showFlow(0,true) for 'workflow') —
   *  those are src/deck/-owned and must be triggered from here, not from
   *  inside src/world/. */
  onChapter(index: number): void;
  /** Called at the end of enter3D() and onResize()'s measure/restore tail,
   *  once panel/camera layout has just been freshly recomputed. */
  emitRelayout(): void;
}

export interface World {
  /** Fire-and-forget; never throws — failures arrive via onFail. */
  boot(): void;
  /** Rail buttons; no-op before ready. */
  goTo(index: number): void;
  /** Idempotent; restores DOM before disposing GPU resources. */
  destroy(): void;
}
