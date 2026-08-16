// Source: docs/one-shot/3d/sample-gitlab-3d-scan.html, document body,
// lines 443-715. Composition only, in the exact source body order.
//
// This file must never contain scene construction, render-loop logic, GLTF
// loading, camera maths, or postprocessing. That all lives in src/world/
// (Phase 4) and is mounted here, not authored here.
//
// Phase 2 renders the flat deck only: no `body.mode-3d` / `body.booting`
// classes. The mode state machine (and dismissing the boot panel, which the
// source markup at L483 shows visible by default) lands in Phase 5.

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
import { Deck } from './components/chapters/Deck'; // L497-713

export default function App() {
  return (
    <>
      <SkipLink />
      <ScrollProgress />
      <TopBar />
      {/* ThreeWorld mounts here in Phase 4 */}
      <Hud />
      <Readout />
      <ChapterRail />
      <ScrollHint />
      <DebugPanel />
      <BootPanel />
      <FlatNote />
      <Deck />
      <SiteFooter />
    </>
  );
}
