// Transcribed from docs/one-shot/3d/sample-gitlab-3d-scan.html, source lines 470-476.
//
// #roProg is written EVERY FRAME by the world's onFrame callback (source
// L1437), so it takes a ref, not state. #roFps and #sxDbg are written directly
// by the world — they need renderer internals that never cross into React, and
// #roScreens is rewritten by it too, over the ledger-derived value rendered
// here for flat mode. SCAN and LINK are permanently static.
import type { Ref } from 'react';
import { CHAPTERS } from '../../config/chapters';

export function Readout({ progRef }: { progRef?: Ref<HTMLElement> }) {
  return (
    <div className="sx-readout" id="sxReadout" aria-hidden="true">
      <div>
        <span>SCAN</span>
        <b>25.6K TRI</b>
      </div>
      <div>
        <span>SCREENS</span>
        {/* Pre-3D value: the world rewrites this with panels.length once the
            model is fitted, but flat mode never boots the world, so derive it
            from the ledger rather than hardcoding a count that goes stale the
            next time a chapter is added. */}
        <b id="roScreens">{String(CHAPTERS.length).padStart(2, '0')}</b>
      </div>
      <div>
        <span>RENDER</span>
        <b id="roFps">— FPS</b>
      </div>
      <div>
        <span>PROGRESS</span>
        <b id="roProg" ref={progRef}>0.00</b>
      </div>
      <div>
        <span>LINK</span>
        <b>localhost</b>
      </div>
    </div>
  );
}
