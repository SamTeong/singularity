import type { ChapterProps } from './types';

export function Chaos({ sectionRef }: ChapterProps) {
  return (
    // className and id are constant literals on purpose, and no style prop
    // is passed here — Phase 4 adds `.as-panel` to this element's classList
    // and writes width/height/display/opacity on it every frame; a computed
    // className or a style prop would fight that and drop the class.
    <section className="chapter chaos" id="chaos" aria-labelledby="chaos-title" ref={sectionRef}>
      <div className="chapter-inner chaos-grid">
        <div>
          <div className="eyebrow"><span className="jp">混沌</span>CHAOS DETECTED</div>
          <h2 className="display" id="chaos-title">ONE TERMINAL WAS <span className="orange">FINE.</span><br />THEN THERE WERE SEVEN.</h2>
          <p className="lead">Sessions multiply. Branches drift. Reviews wait in windows you forgot were open. <strong>The problem is no longer writing code. It is knowing what each agent is doing, what it costs, and what needs your decision.</strong></p>
          <div className="chaos-stats" aria-label="Example fleet status">
            <div className="stat"><span className="label">LIVE SESSIONS</span><span className="value">04</span><span className="foot">2 RUN · 1 IDLE · 1 REVIEW</span></div>
            <div className="stat"><span className="label">OPEN WORKTREES</span><span className="value">07</span><span className="foot">3 READY FOR RULING</span></div>
            <div className="stat"><span className="label">CONTEXT SWITCHES</span><span className="value">∞</span><span className="foot">WITHOUT A CONTROL PLANE</span></div>
          </div>
        </div>
        <div className="chaos-frame" aria-label="Disconnected agent terminals before Singularity" role="img">
          <div className="chaos-frame-inner">
            <div className="hazard"></div>
            <div className="chaos-card cc1"><b>TERMINAL·03</b><small>BRANCH UNKNOWN<br />LAST OUTPUT 14M AGO</small></div>
            <div className="chaos-card cc2"><b>AGENT·OPUS</b><small>WAITING FOR APPROVAL<br />COST STATE UNREAD</small></div>
            <div className="chaos-card cc3"><b>WORKTREE·9E0B</b><small>17 FILES CHANGED<br />REVIEW NOT OPENED</small></div>
            <div className="chaos-card cc4"><b>SESSION·7FE8</b><small>CONTEXT 42K / 1.0M<br />STATUS IDLE</small></div>
            <div className="chaos-alert">POOR OPERATIONAL VISIBILITY</div>
          </div>
        </div>
      </div>
    </section>
  );
}
