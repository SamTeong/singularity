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
import { SiteFooter } from './components/chrome/SiteFooter'; // L715
import { Chapters } from './components/chapters/Chapters'; // L497-713
import { ThreeWorld } from './world/ThreeWorld';

import { CHAPTERS } from './config/chapters';
import { NARROW, REDUCED_MOTION, DEBUG } from './lib/env';
import { clamp } from './lib/math';
import { probeInitialMode } from './app/probe';
import { useBodyMode } from './app/useBodyMode';
import { useElementRegistry } from './app/useElementRegistry';
import { usePanelHitRelay } from './app/panelHitRelay';
import { armScrollRestore, restoreScroll } from './app/scrollRestore';
import * as appStore from './state/appStore';
import { renderTerminal } from './deck/useTerminal';
import { requestFlowReset } from './deck/useFlowStepper';
import type { ConductorState, Mode, World } from './world/types';

/** Source L803: fail(showError) auto-hides the boot box after 9s. */
const BOOT_ERROR_LINGER_MS = 9000;
/** Source L1642: on success the box is dismissed 700ms after the deck mounts. */
const BOOT_SUCCESS_LINGER_MS = 700;

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

  // Chromium refuses to hit-test three of the seven panels — see panelHitRelay.ts.
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
    // restoreDom() puts the 7 sections back in their spacers and clears
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
  }, []);

  const onChapter = useCallback((index: number) => {
    // Source updateDom() at L1440-1452. The HUD/rail writes are React state;
    // the two deck side effects go through module-level seams so src/world/
    // never imports src/deck/.
    setChapterIndexState(index);
    appStore.setChapterIndex(index);
    const c = CHAPTERS[index];
    if (!c) return;
    if (c.id === 'fleet-control') renderTerminal(); // L1450
    if (c.id === 'tasks') requestFlowReset(); // L1451 (itself gated on !RM)
  }, []);

  const onReady = useCallback((world: World) => {
    worldRef.current = world;
    // Makes the rail buttons live. Null in flat mode, which is what keeps them
    // inert there — the source's `conductor && conductor.goTo(i)` guard.
    appStore.setConductor({ goTo: (i: number) => world.goTo(i) });
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
    setChapterIndexState(null);
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
      <TopBar chapter={activeChapter} />
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
      <SiteFooter />
    </>
  );
}
