// Ported from docs/one-shot/3d/sample-gitlab-3d-scan.html, L1037-1146
// (createScrollConductor). Native scroll is the exact state; a damped copy
// drives the camera only. Adapted from
// build-threejs-scroll-worlds/references/scroll-conductor.js.
//
// Two deliberate additions over the source, both required by this port's
// React lifecycle (the source never tore itself down):
//
//  - `weights`/`applySpacerHeights`: the source's standalone `sizeBeats()` is
//    folded into measure() so spacer-height-setting and anchor measurement
//    always share one `innerHeight` snapshot — see measure() below.
//  - `stop()`: a real teardown the source never needed. Order matters at
//    call time (see createWorld.ts's destroy()) — stop() must run before
//    the DOM the conductor's listeners/ResizeObserver reference is touched.
import { clamp, damp } from '../lib/math';
import { scrollGlide } from '../lib/scrollGlide';
import { applySpacerHeights } from './spacerLayout';
import type { ConductorState } from './types';

export interface ScrollConductorOptions {
  sections: HTMLElement[];
  weights: number[];
  damping: number;
  reducedMotion: boolean;
  onUpdate?: (state: ConductorState, dt: number) => void;
  onChapterChange?: (index: number, state: ConductorState) => void;
}

export interface ScrollConductor {
  start(): void;
  stop(): void;
  measure(): void;
  getState(): ConductorState;
  goTo(index: number): void;
  /** Inverse of progressAt — lets a resize restore the same story position
   *  after the spacers are re-measured against the new viewport height, and
   *  lets in-chapter step controls move the scroll position that drives them.
   *  `smooth` is for the latter only: a resize must land instantly, before
   *  the next measure. */
  setProgress(p: number, smooth?: boolean): void;
  /** The scroll offset a story position sits at — what setProgress would
   *  scroll to. Public so a caller that animates the scroll itself (the
   *  autoplay tour) can aim at the same place. */
  topAt(p: number): number;
}

// Manual "go to slide" (rail click, arrow keys) used to lean on the browser's
// native smooth-scroll, which decelerates INTO a slide but accelerates OUT of
// one instantly — a lurch on departure. scrollGlide gives it the same
// smootherstep ease-in/out the autoplay tour uses, so both legs are gentle.
// A ceiling caps cross-deck jumps so a click from chapter 01 to the last screen
// doesn't take whole seconds; the floor keeps short hops unhurried.
const GO_TO_PX_PER_SECOND = 700;
const GO_TO_MIN_MS = 450;
const GO_TO_MAX_MS = 1200;
const GO_TO_HANDOVER_PX = 40;

export function createScrollConductor(opts: ScrollConductorOptions): ScrollConductor {
  const { sections: els, weights, damping, reducedMotion, onUpdate, onChapterChange } = opts;

  let anchors: number[] = [];
  let exact = 0;
  let smooth = 0;
  let direction = 0;
  let prevY = 0;
  let active = -1;
  let running = false;
  let frame = 0;
  let lastTime = 0;
  let dirty = true;
  let activeGlide: (() => void) | null = null;
  let widthAtMeasure = 0;
  let ro: ResizeObserver | null = null;

  const maxScroll = (): number => Math.max(1, document.documentElement.scrollHeight - innerHeight);

  function measure(): void {
    // ONE innerHeight snapshot drives both the spacer heights and the anchor
    // maths below — reading it twice risks the layout shifting between the
    // two reads (the spacer heights themselves change scrollHeight).
    const vh = innerHeight;
    applySpacerHeights(els, weights, vh);
    const max = Math.max(1, document.documentElement.scrollHeight - vh);
    widthAtMeasure = innerWidth;
    anchors = els.map((el, i) => {
      if (i === 0) return 0;
      if (i === els.length - 1) return max;
      return clamp(el.offsetTop + el.offsetHeight * 0.5 - vh * 0.5, 0, max);
    });
    for (let i = 1; i < anchors.length; i++) anchors[i] = Math.max(anchors[i], anchors[i - 1] + 1);
    dirty = true;
  }

  function progressAt(y: number): number {
    if (!anchors.length) measure();
    y = clamp(y, 0, maxScroll());
    if (y <= anchors[0]) return 0;
    for (let i = 0; i < anchors.length - 1; i++) {
      if (y <= anchors[i + 1]) {
        const span = Math.max(1, anchors[i + 1] - anchors[i]);
        return i + clamp((y - anchors[i]) / span, 0, 1);
      }
    }
    return anchors.length - 1;
  }

  function segment(p: number): { index: number; next: number; local: number } {
    const last = els.length - 1;
    const i = clamp(Math.floor(p), 0, last);
    const next = Math.min(last, i + 1);
    return { index: i, next, local: next === i ? 0 : clamp(p - i, 0, 1) };
  }

  function state(): ConductorState {
    const e = segment(exact);
    const s = segment(smooth);
    return {
      exact,
      smooth,
      index: e.index,
      next: e.next,
      localExact: e.local,
      smoothIndex: s.index,
      smoothNext: s.next,
      localSmooth: s.local,
      direction,
      anchors,
    };
  }

  function readScroll(): void {
    const y = scrollY;
    const d = y - prevY;
    if (Math.abs(d) > 0.25) direction = d > 0 ? 1 : -1;
    prevY = y;
    exact = progressAt(y);
    dirty = true;
  }

  function tick(now: number): void {
    if (!running) return;
    const dt = lastTime ? Math.min((now - lastTime) / 1000, 1 / 30) : 1 / 60;
    lastTime = now;
    const prevSmooth = smooth;
    smooth = reducedMotion ? exact : damp(smooth, exact, damping, dt);
    if (Math.abs(smooth - exact) < 0.0001) smooth = exact;
    const s = state();
    if (s.index !== active) {
      active = s.index;
      onChapterChange?.(active, s);
    }
    if (dirty || smooth !== prevSmooth) {
      dirty = false;
      onUpdate?.(s, dt);
    }
    frame = requestAnimationFrame(tick);
  }

  function onResize(): void {
    const widthChanged = innerWidth !== widthAtMeasure;
    // Mobile URL-bar show/hide fires a resize with no width change — ignore
    // it on coarse pointers so the story doesn't jump on every scroll.
    if (matchMedia('(pointer: coarse)').matches && !widthChanged) return;
    measure();
    readScroll();
  }

  function onVisibility(): void {
    if (document.hidden) {
      cancelAnimationFrame(frame);
      frame = 0;
      lastTime = 0;
      return;
    }
    if (running && !frame) frame = requestAnimationFrame(tick);
    readScroll();
  }

  function start(): void {
    if (running) return;
    running = true;
    measure();
    prevY = scrollY;
    exact = smooth = progressAt(prevY);
    addEventListener('scroll', readScroll, { passive: true });
    addEventListener('resize', onResize, { passive: true });
    addEventListener('orientationchange', onResize, { passive: true });
    addEventListener('pageshow', onResize);
    addEventListener('hashchange', onResize);
    document.addEventListener('visibilitychange', onVisibility);
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => {
        measure();
        readScroll();
      });
      els.forEach((el) => ro?.observe(el));
    }
    active = -1;
    lastTime = 0;
    frame = requestAnimationFrame(tick);
  }

  function stop(): void {
    running = false;
    activeGlide?.();
    activeGlide = null;
    if (frame) {
      cancelAnimationFrame(frame);
      frame = 0;
    }
    removeEventListener('scroll', readScroll);
    removeEventListener('resize', onResize);
    removeEventListener('orientationchange', onResize);
    removeEventListener('pageshow', onResize);
    removeEventListener('hashchange', onResize);
    document.removeEventListener('visibilitychange', onVisibility);
    if (ro) {
      ro.disconnect();
      ro = null;
    }
  }

  function goTo(i: number): void {
    i = clamp(Math.round(i), 0, anchors.length - 1);
    const to = anchors[i];
    if (reducedMotion) {
      activeGlide?.();
      activeGlide = null;
      scrollTo({ top: to, behavior: 'auto' });
      return;
    }
    // Cancel any in-flight glide before starting the next — a rapid sequence
    // of rail clicks would otherwise stack competing rAF loops on the same
    // scroll position. scrollGlide's ease-in/out means the camera leaves and
    // arrives at near-zero velocity (see lib/scrollGlide); the passive scroll
    // listener still feeds `exact` frame by frame, so the damped camera
    // follows this the same way it followed the native smooth-scroll.
    activeGlide?.();
    activeGlide = scrollGlide(to, {
      rate: GO_TO_PX_PER_SECOND,
      minMs: GO_TO_MIN_MS,
      maxMs: GO_TO_MAX_MS,
      handoverPx: GO_TO_HANDOVER_PX,
    });
  }

  function topAt(p: number): number {
    if (!anchors.length) measure();
    p = clamp(p, 0, anchors.length - 1);
    const i = clamp(Math.floor(p), 0, anchors.length - 2);
    return anchors.length < 2 ? 0 : Math.round(anchors[i] + (p - i) * (anchors[i + 1] - anchors[i]));
  }

  function setProgress(p: number, smooth = false): void {
    const top = topAt(p);
    const animate = smooth && !reducedMotion;
    scrollTo({ top, behavior: animate ? 'smooth' : 'instant' });
    // A smooth scroll is still animating here, so scrollY is the pre-animation
    // value — the passive scroll listener picks up the real position frame by
    // frame. Reading it now would only rewind `exact` to where we started.
    if (!animate) readScroll();
  }

  return { start, stop, measure, getState: state, goTo, setProgress, topAt };
}
