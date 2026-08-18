import type { ChapterProps } from './types';
import { CHAPTERS } from '../../config/chapters';
import { useConductor } from '../../state/appStore';

export function Orientation({ sectionRef }: ChapterProps) {
  const conductor = useConductor();
  return (
    // className and id are constant literals on purpose, and no style prop
    // is passed here — Phase 4 adds `.as-panel` to this element's classList
    // and writes width/height/display/opacity on it every frame; a computed
    // className or a style prop would fight that and drop the class.
    <section className="chapter orientation" id="orientation" aria-labelledby="orientation-title" ref={sectionRef}>
      <div className="chapter-inner orientation-grid">
        <div>
          <div className="eyebrow"><span className="jp">統合</span>LOCAL AGENT OPERATIONS</div>
          <div className="orientation-jp">特異点</div>
          <h1 className="display" id="orientation-title">SINGU<span className="mint">LARITY</span></h1>
          <p className="orientation-sub">ONE CONTROL PLANE FOR YOUR WHOLE FLEET OF CODING AGENTS.</p>
          <p className="orientation-copy">Run live sessions. Turn specs into worktree-backed tasks. Dispatch background jobs. Keep usage, context, transcripts, and the state of every agent in one local control plane.</p>
          <div className="orientation-actions">
            {/* Both anchors reach the relay in 3D mode (Chromium never hit-tests
                this panel — see panelHitRelay.ts), but `#fleet-control` and `#take-control`
                live in #css3d at position:fixed, so fragment navigation scrolls
                nowhere. Keep the href for the flat page, where conductor is
                null, and hand 3D mode to the conductor. */}
            <a
              className="btn primary"
              href="#chaos"
              onClick={(e) => {
                if (!conductor) return;
                e.preventDefault();
                conductor.goTo(CHAPTERS.findIndex((c) => c.id === 'chaos'));
              }}
            >
              GET STARTED
            </a>
            <a
              className="btn alt"
              id="orientationCta"
              href="#take-control"
              onClick={(e) => {
                if (!conductor) return;
                e.preventDefault();
                conductor.goTo(CHAPTERS.findIndex((c) => c.id === 'take-control'));
              }}
            >
              FULL DIVE
            </a>
          </div>
        </div>
        <div className="orientation-viz" aria-label="Four agent nodes connected to the Singularity control plane" role="img">
          <span className="orbit"></span><span className="orbit o2"></span><span className="orbit o3"></span>
          <span className="cross-x"></span><span className="cross-y"></span>
          <span className="node n1" data-label="SESSION·04"></span><span className="node n2" data-label="TASK·118"></span><span className="node n3" data-label="CRON·02"></span><span className="node n4" data-label="REVIEW·07"></span>
          <span className="core">統</span>
          <div className="orientation-meta"><b>DAEMON:</b> localhost:4317<br /><b>CHANNEL:</b> WS + REST<br /><b>STATE:</b> NOMINAL</div>
        </div>
      </div>
    </section>
  );
}
