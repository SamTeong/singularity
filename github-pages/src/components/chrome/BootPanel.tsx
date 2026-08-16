// Transcribed from docs/one-shot/3d/sample-gitlab-3d-scan.html, source lines 483-493.
// No `hidden` attribute in the source markup — the boot panel is visible on
// every load until Phase 5's JS dismisses it. Reproduced verbatim.
export function BootPanel() {
  return (
    <div className="sx-boot" id="sxBoot" role="status" aria-live="polite">
      <div className="sx-boot-panel">
        <div className="sx-boot-head">
          <span>LOADING SCAN</span>
          <span>11.0MB</span>
        </div>
        <div className="sx-boot-body">
          <div className="sx-boot-pct">
            <span id="sxBootNum">00</span>%
          </div>
          <div className="sx-boot-track" aria-hidden="true">
            <i id="sxBootFill" />
          </div>
          <div className="sx-boot-sub" id="sxBootSub">
            FETCHING GEOMETRY BUFFER…
          </div>
          <div className="sx-boot-err" id="sxBootErr">
            SCENE UNAVAILABLE. This walkthrough needs WebGL2 and must be served over http(s) — opening the file
            directly from disk blocks the model fetch. The full product deck is readable below.
          </div>
        </div>
      </div>
    </div>
  );
}
