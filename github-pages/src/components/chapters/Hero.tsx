import type { ChapterProps } from './types';

export function Hero({ sectionRef }: ChapterProps) {
  return (
    // className and id are constant literals on purpose, and no style prop
    // is passed here — Phase 4 adds `.as-panel` to this element's classList
    // and writes width/height/display/opacity on it every frame; a computed
    // className or a style prop would fight that and drop the class.
    <section className="chapter hero" id="hero" aria-labelledby="hero-title" ref={sectionRef}>
      <div className="chapter-inner hero-grid">
        <div>
          <div className="eyebrow"><span className="jp">統合</span>LOCAL AGENT OPERATIONS</div>
          <div className="hero-jp">特異点</div>
          <h1 className="display" id="hero-title">SINGU<span className="mint">LARITY</span></h1>
          <p className="hero-sub">ONE CONTROL PLANE FOR YOUR WHOLE FLEET OF CODING AGENTS.</p>
          <p className="hero-copy">Run live sessions. Turn specs into worktree-backed tasks. Dispatch background jobs. Keep usage, context, transcripts, and the state of every agent in one local command deck.</p>
          <div className="hero-actions">
            <a className="btn primary" href="#control">ENTER CONTROL</a>
            <a className="btn alt" href="#boot">BOOT SEQUENCE</a>
          </div>
        </div>
        <div className="hero-viz" aria-label="Four agent nodes connected to the Singularity control plane" role="img">
          <span className="orbit"></span><span className="orbit o2"></span><span className="orbit o3"></span>
          <span className="cross-x"></span><span className="cross-y"></span>
          <span className="node n1" data-label="SESSION·04"></span><span className="node n2" data-label="TASK·118"></span><span className="node n3" data-label="CRON·02"></span><span className="node n4" data-label="REVIEW·07"></span>
          <span className="core">統</span>
          <div className="hero-meta"><b>DAEMON:</b> 127.0.0.1:4317<br /><b>CHANNEL:</b> WS + REST<br /><b>STATE:</b> NOMINAL</div>
        </div>
      </div>
    </section>
  );
}
