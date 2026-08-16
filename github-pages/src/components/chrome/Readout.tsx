// Transcribed from docs/one-shot/3d/sample-gitlab-3d-scan.html, source lines 470-476.
//
// #roProg is written EVERY FRAME by the world's onFrame callback (source
// L1437), so it takes a ref, not state. #roScreens, #roFps and #sxDbg are
// written directly by the world — they need renderer/bbox internals that never
// cross into React. SCAN and LINK are permanently static.
import type { Ref } from 'react';

export function Readout({ progRef }: { progRef?: Ref<HTMLElement> }) {
  return (
    <div className="sx-readout" id="sxReadout" aria-hidden="true">
      <div>
        <span>SCAN</span>
        <b>25.6K TRI</b>
      </div>
      <div>
        <span>SCREENS</span>
        <b id="roScreens">07</b>
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
        <b>127.0.0.1</b>
      </div>
    </div>
  );
}
