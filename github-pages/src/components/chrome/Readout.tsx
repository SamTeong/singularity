// Transcribed from docs/one-shot/3d/sample-gitlab-3d-scan.html, source lines 470-476.
export function Readout() {
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
        <b id="roProg">0.00</b>
      </div>
      <div>
        <span>LINK</span>
        <b>127.0.0.1</b>
      </div>
    </div>
  );
}
