// Transcribed from docs/one-shot/3d/sample-gitlab-3d-scan.html, source lines
// 483-493, with the state the source drives imperatively via setPct()/fail()
// (L793-810) lifted into props.
//
// The panel has NO `hidden` attribute in the source markup — it is visible on
// every load, including flat mode, until something dismisses it.
import { pad } from '../../lib/math';

export interface BootPanelProps {
  /** 0-100. Rendered zero-padded, as the source's `pad()` does (L795). */
  progress: number;
  /** The status line under the bar (#sxBootSub). */
  status: string;
  /** Reveals #sxBootErr — the source adds `.show` in fail() at L801. */
  showError: boolean;
  hidden: boolean;
}

export function BootPanel({ progress, status, showError, hidden }: BootPanelProps) {
  return (
    <div className="sx-boot" id="sxBoot" role="status" aria-live="polite" hidden={hidden}>
      <div className="sx-boot-panel">
        <div className="sx-boot-head">
          <span>LOADING SCAN</span>
          <span>11.0MB</span>
        </div>
        <div className="sx-boot-body">
          <div className="sx-boot-pct">
            <span id="sxBootNum">{pad(Math.round(progress))}</span>%
          </div>
          <div className="sx-boot-track" aria-hidden="true">
            <i id="sxBootFill" style={{ width: `${progress}%` }} />
          </div>
          <div className="sx-boot-sub" id="sxBootSub">
            {status}
          </div>
          <div className={showError ? 'sx-boot-err show' : 'sx-boot-err'} id="sxBootErr">
            SCENE UNAVAILABLE. This walkthrough needs WebGL2 and must be served over http(s) — opening the file
            directly from disk blocks the model fetch. The full product deck is readable below.
          </div>
        </div>
      </div>
    </div>
  );
}
