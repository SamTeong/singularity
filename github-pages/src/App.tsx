// Source: docs/one-shot/3d/sample-gitlab-3d-scan.html, document body,
// lines 443-715, plus the bootstrap gate at L1653-1666 and fail() at L798-810.
// Composition and the mode state machine only.
//
// This file must never contain scene construction, render-loop logic, GLTF
// loading, camera maths, or postprocessing. That all lives in src/world/ and is
// mounted here, not authored here.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';

import { SkipLink } from './components/chrome/SkipLink'; // source L443
import { ScrollProgress } from './components/chrome/ScrollProgress'; // L444
import { TopBar } from './components/chrome/TopBar'; // L446-455
import { Hud, ScrollHint } from './components/chrome/Hud'; // L460-468, L479
import { Readout } from './components/chrome/Readout'; // L470-476
import { ChapterRail } from './components/chrome/ChapterRail'; // L478
import { DebugPanel } from './components/chrome/DebugPanel'; // L481
import { BootPanel } from './components/chrome/BootPanel'; // L483-493
import { FlatNote } from './components/chrome/FlatNote'; // L495
import { Lightbox } from './components/chrome/Lightbox';
import { SiteFooter } from './components/chrome/SiteFooter'; // L715
import { Chapters } from './components/chapters/Chapters'; // L497-713
import { ThreeWorld } from './world/ThreeWorld';

import { CHAPTERS } from './config/chapters';
import { NARROW, REDUCED_MOTION, DEBUG } from './lib/env';
import { clamp } from './lib/math';
import { probeInitialMode } from './app/probe';
import { visibleChapter } from './app/chapterPosition';
import {
  AUTOPLAY_DEFAULT_DWELL_MS,
  AUTOPLAY_DWELL_STEP_MS,
  AUTOPLAY_MAX_DWELL_MS,
  AUTOPLAY_MIN_DWELL_MS,
  useAutoplay,
} from './app/useAutoplay';
import { useBodyMode } from './app/useBodyMode';
import { useElementRegistry } from './app/useElementRegistry';
import { usePanelHitRelay } from './app/panelHitRelay';
import { armScrollRestore, restoreScroll } from './app/scrollRestore';
import * as appStore from './state/appStore';
import { renderTerminal } from './deck/useTerminal';
import { requestFlowReset } from './deck/useFlowStepper';
import { driveFromScroll, resetStage } from './deck/pipelineStage';
import { runThemeTerminals } from './deck/useThemeTerminals';
import { closeLightbox } from './deck/lightbox';
import { stepAt } from './deck/useScrollStep';
import type { ConductorState, Mode, World } from './world/types';

/** Source L803: fail(showError) auto-hides the boot box after 9s. */
const BOOT_ERROR_LINGER_MS = 9000;
/** Source L1642: on success the box is dismissed 700ms after the deck mounts. */
const BOOT_SUCCESS_LINGER_MS = 700;

/** The PIPELINE chapter's ledger position. Resolved once from CHAPTERS rather
 *  than written as a literal, so reordering the deck cannot silently point the
 *  scroll-driven stage selector at the wrong chapter. */
const PIPELINE_INDEX = CHAPTERS.findIndex((c) => c.id === 'pipeline');

export default function App() {
  // Lazy initializer: the probe MUST run before the first paint, because
  // `body.booting #scroll .chapter { visibility: hidden }` would otherwise
  // flash a blank page at every narrow/unsupported visitor.
  const [mode, setMode] = useState<Mode>(probeInitialMode);
  const [chapterIndex, setChapterIndexState] = useState<number | null>(null);

  // <ThreeWorld/> sits before <Chapters/> in the tree (source body order: #gl and
  // #css3d are at L457-458, the deck at L497). React attaches refs and runs
  // layout effects in one tree-order pass, so on the first commit ThreeWorld's
  // effect would run before Chapters' section/spacer refs exist. Deferring its mount
  // by exactly one commit keeps the source's DOM order AND lets destroy() stay
  // a layout-effect cleanup, which it must be.
  const [registriesReady, setRegistriesReady] = useState(false);
  useEffect(() => setRegistriesReady(true), []);

  // Chromium refuses to hit-test some panels — see panelHitRelay.ts.
  usePanelHitRelay();

  // A React SPA is an empty #root when the browser applies its saved scroll
  // offset, so the browser's own restoration always lands at 0 — see
  // scrollRestore.ts. We record the position and re-apply it ourselves once the
  // document is at its final height: ThreeWorld does that right after sizing
  // the spacers; in flat mode the deck's natural height is final at first paint.
  useEffect(() => armScrollRestore(), []);

  const [bootProgress, setBootProgress] = useState(0);
  const [bootStatus, setBootStatus] = useState('FETCHING GEOMETRY BUFFER…');
  const [bootShowError, setBootShowError] = useState(false);
  const [bootHidden, setBootHidden] = useState(false);

  const isFlat = mode === 'flat' || mode === 'error';

  // Hands-free tour — off until the reader asks for it (see useAutoplay).
  const [autoplay, setAutoplay] = useState(false);
  const [autoplayDwellMs, setAutoplayDwellMs] = useState(AUTOPLAY_DEFAULT_DWELL_MS);
  useEffect(() => {
    if (!autoplay) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        event.defaultPrevented ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        (target instanceof HTMLElement &&
          (target.isContentEditable || ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName)))
      ) {
        return;
      }
      const key = event.key.toLowerCase();
      if (key !== 'd' && key !== 's') return;
      event.preventDefault();
      const delta = key === 'd' ? -AUTOPLAY_DWELL_STEP_MS : AUTOPLAY_DWELL_STEP_MS;
      setAutoplayDwellMs((ms) => clamp(ms + delta, AUTOPLAY_MIN_DWELL_MS, AUTOPLAY_MAX_DWELL_MS));
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [autoplay]);
  useAutoplay(autoplay, !isFlat, autoplayDwellMs, () => setAutoplay(false));

  useBodyMode(mode);

  // Flat mode has no ThreeWorld to restore for it, and the deck's natural
  // height is already final at first paint.
  const flatRestored = useRef(false);
  useEffect(() => {
    if (!isFlat || flatRestored.current) return;
    flatRestored.current = true;
    restoreScroll();
  }, [isFlat]);

  // Per-frame write targets. Refs, never state — onFrame runs at 60fps.
  const progressBarRef = useRef<HTMLDivElement | null>(null);
  const progReadoutRef = useRef<HTMLElement | null>(null);

  const sections = useElementRegistry();
  const spacers = useElementRegistry();

  const worldRef = useRef<World | null>(null);
  const bootTimer = useRef<number | undefined>(undefined);

  // ---- callbacks handed to the world -------------------------------------
  // All stable: ThreeWorld's mount effect captures props once and never
  // re-reads them, so a fresh closure per render would simply be ignored.

  const setModeSync = useCallback((next: Mode) => {
    // Synchronous by contract. buildPanels() measures offsetHeight immediately
    // after setMode('3d') returns, and `.chapter.as-panel` changes padding/
    // overflow/flex while `body.booting` changes visibility — measuring under
    // the wrong class state silently corrupts every camera waypoint.
    // Legal here: only ever called from async continuations and native event
    // handlers, never during render.
    flushSync(() => setMode(next));
  }, []);

  const onStatus = useCallback((text: string) => setBootStatus(text), []);
  const onProgress = useCallback((pct: number) => setBootProgress(clamp(pct, 0, 100)), []);

  const onFail = useCallback((message: string, opts: { showError: boolean }) => {
    // Source fail() at L798-810.
    setBootStatus(message);
    setBootShowError(opts.showError);
    window.clearTimeout(bootTimer.current);
    if (opts.showError) {
      bootTimer.current = window.setTimeout(() => setBootHidden(true), BOOT_ERROR_LINGER_MS);
    } else {
      setBootHidden(true);
    }
    // flushSync so a webglcontextlost demotion completes inside the event
    // handler: one commit runs ThreeWorld's layout cleanup (world.destroy() →
    // restoreDom() puts the 9 sections back in their spacers and clears
    // as-panel + the inline styles + spacer heights), removes the stage div, and
    // drops body.mode-3d so the CSS reveals the flat deck.
    flushSync(() => setMode(opts.showError ? 'error' : 'flat'));
  }, []);

  const onFrame = useCallback((state: ConductorState) => {
    // Ref writes only. Source L1435-1437 — note the bar uses raw scrollY, NOT
    // conductor progress; preserved deliberately.
    const max = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
    if (progressBarRef.current) {
      progressBarRef.current.style.width = clamp(window.scrollY / max, 0, 1) * 100 + '%';
    }
    if (progReadoutRef.current) {
      progReadoutRef.current.textContent = state.exact.toFixed(2);
    }
    // Scroll drives the pipeline chapter's five-stage selector. Safe to call
    // every frame: the store only notifies when the integer stage changes
    // (~5 times per traversal), so this is not a 60fps setState.
    if (PIPELINE_INDEX >= 0) driveFromScroll(state.smooth, PIPELINE_INDEX);
    // The one exception to "ref writes only": the in-chapter step (fleet
    // control's tabs, the tasks flow) is a scroll band, and the components
    // that render it are React. Safe because the signal is written ONLY when
    // the quantised band changes — a few times per chapter, not per frame.
    const step = stepAt(state.index, state.localExact);
    if (step !== null) {
      const current = appStore.getChapterStep();
      if (!current || current.chapter !== state.index || current.step !== step) {
        appStore.setChapterStep({ chapter: state.index, step });
      }
    }
  }, []);

  // Set while a mode toggle is in flight. Toggling rebuilds the document
  // height from scratch — 3D sizes the spacers by chapter weight, flat uses
  // the deck's natural height — so a raw scrollY means nothing across the
  // switch. The chapter the reader was on does, so that is what is carried.
  const pendingChapter = useRef<number | null>(null);

  const toggleMode = useCallback(() => {
    setMode((current) => {
      if (current === 'flat') {
        // In flat mode nothing tracks the chapter (the world owns that signal
        // and is not running), so it is measured off the layout instead.
        pendingChapter.current = visibleChapter();
        setBootHidden(false);
        setBootShowError(false);
        setBootProgress(0);
        setBootStatus('FETCHING GEOMETRY BUFFER…');
        return 'loading';
      }
      pendingChapter.current = appStore.getChapterIndex() ?? 0;
      return 'flat';
    });
  }, []);

  // Landing side of a 3D → flat toggle. The sections are back in their spacers
  // by now (world.destroy() → restoreDom() runs in the same mutation phase),
  // so the chapter the reader was on can simply be scrolled to.
  useEffect(() => {
    if (!isFlat || pendingChapter.current === null) return;
    const id = CHAPTERS[pendingChapter.current]?.id;
    pendingChapter.current = null;
    document.getElementById(id ?? '')?.scrollIntoView({ block: 'start', behavior: 'instant' });
  }, [isFlat]);

  const onChapter = useCallback((index: number) => {
    // Source updateDom() at L1440-1452. The HUD/rail writes are React state;
    // the two deck side effects go through module-level seams so src/world/
    // never imports src/deck/.
    setChapterIndexState(index);
    appStore.setChapterIndex(index);
    // Landing side of a flat → 3D toggle. This is the first callback after
    // conductor.start() (createWorld's enter3D tail), which is the earliest
    // point goTo() is not a no-op.
    if (pendingChapter.current !== null) {
      const target = pendingChapter.current;
      pendingChapter.current = null;
      if (target !== index) worldRef.current?.goTo(target);
    }
    const c = CHAPTERS[index];
    if (!c) return;
    if (c.id === 'fleet-control') renderTerminal(); // L1450
    if (c.id === 'tasks') requestFlowReset(); // L1451 (itself gated on !RM)
    // The two theme teletypes. The source fires these from an
    // IntersectionObserver on the section (slides/index.html L837-841), which
    // can never fire here — a CSS3D panel is reparented out of the scroll flow
    // and intersects nothing. Chapter entry is the equivalent seam.
    if (c.id === 'themes') runThemeTerminals();
  }, []);

  const onReady = useCallback((world: World) => {
    worldRef.current = world;
    // Makes the rail buttons live. Null in flat mode, which is what keeps them
    // inert there — the source's `conductor && conductor.goTo(i)` guard.
    appStore.setConductor({
      goTo: (i: number) => world.goTo(i),
      seek: (p: number) => world.seek(p),
      topAt: (p: number) => world.topAt(p),
    });
  }, []);

  // Dismiss the boot panel shortly after the deck mounts (source L1642).
  useEffect(() => {
    if (mode !== '3d') return;
    const id = window.setTimeout(() => setBootHidden(true), BOOT_SUCCESS_LINGER_MS);
    return () => window.clearTimeout(id);
  }, [mode]);

  // Leaving 3D tears down the cross-layer handles the world registered.
  useEffect(() => {
    if (mode === '3d') return;
    worldRef.current = null;
    appStore.setConductor(null);
    appStore.setChapterIndex(null);
    appStore.setChapterStep(null);
    setChapterIndexState(null);
    // Nothing is driving these any more. The pipeline stage falls back to
    // stage 01 and becomes click-only. The teletypes get run once here rather
    // than reset: flat mode has no chapter changes to trigger them, and two
    // permanently empty terminal panes would be missing content, not a
    // degraded animation. The lightbox must close — it owns `body.overflow`,
    // and leaving it locked on a demotion makes the flat deck unscrollable.
    resetStage();
    runThemeTerminals();
    closeLightbox();
  }, [mode]);

  useEffect(() => () => window.clearTimeout(bootTimer.current), []);

  const worldProps = useMemo(
    () => ({ reducedMotion: REDUCED_MOTION, debug: DEBUG }),
    [],
  );

  const activeChapter = chapterIndex === null ? null : (CHAPTERS[chapterIndex] ?? null);

  return (
    <>
      <SkipLink />
      <ScrollProgress barRef={progressBarRef} />
      <TopBar
        chapter={activeChapter}
        is3D={!isFlat}
        canToggle={mode !== 'error' && !NARROW}
        onToggle={toggleMode}
        autoplay={autoplay}
        onToggleAutoplay={() => setAutoplay((on) => !on)}
        autoplayDwellMs={autoplayDwellMs}
        onAutoplayDwellChange={setAutoplayDwellMs}
      />
      {/* Never React.lazy/Suspense — a Suspense boundary above the chapters
          would violate PANEL DOM CONTRACT invariant I1. ThreeWorld reaches
          Three.js only through a dynamic import(), so flat mode never fetches
          the ~600KB chunk. */}
      {!isFlat && registriesReady && (
        <ThreeWorld
          {...worldProps}
          getSpacers={spacers.ordered}
          getPanels={sections.ordered}
          setMode={setModeSync}
          onStatus={onStatus}
          onProgress={onProgress}
          onFail={onFail}
          onFrame={onFrame}
          onChapter={onChapter}
          emitRelayout={appStore.emitRelayout}
          onReady={onReady}
        />
      )}
      <Hud chapter={activeChapter} />
      <Readout progRef={progReadoutRef} />
      <ChapterRail />
      <ScrollHint />
      <DebugPanel />
      <BootPanel
        progress={bootProgress}
        status={bootStatus}
        showError={bootShowError}
        hidden={bootHidden}
      />
      <FlatNote visible={isFlat} variant={NARROW ? 'narrow' : 'default'} />
      <Chapters sectionRefs={sections.refs} spacerRefs={spacers.refs} />
      {/* Sibling of <Chapters/>, never inside it — a `position:fixed` modal
          rendered inside a chapter would be captured by the CSS3D subtree's
          transform. See deck/lightbox.ts. */}
      <Lightbox />
      <SiteFooter />
    </>
  );
}
