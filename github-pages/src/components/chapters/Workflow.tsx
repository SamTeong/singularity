import type { ChapterProps } from './types';

export function Workflow({ sectionRef }: ChapterProps) {
  return (
    // className and id are constant literals on purpose, and no style prop
    // is passed here — Phase 4 adds `.as-panel` to this element's classList
    // and writes width/height/display/opacity on it every frame; a computed
    // className or a style prop would fight that and drop the class.
    <section className="chapter workflow" id="workflow" aria-labelledby="workflow-title" ref={sectionRef}>
      <div className="chapter-inner">
        <div className="section-head"><span className="idx">02</span><span className="jp">流程</span><h2 id="workflow-title">WORK MOVES. CONTEXT STAYS ATTACHED.</h2></div>
        <p className="lead">A task is not just a card. It binds the requirement, branch, worktree, live session, transcript, and final review into one operational record.</p>
        {/* Phase 3: driven by useFlowStepper — button contents are static
            here; the .done/.now classes and data-step below are the
            initial static markup from the source and are not yet
            interactive (no click handlers, no state). */}
        <div className="flow" role="group" aria-label="Task workflow">
          <button className="flow-item done" data-step="0"><span className="num">01</span><span className="jp">仕様</span><span className="en">SPEC</span></button>
          <button className="flow-item done" data-step="1"><span className="num">02</span><span className="jp">任務</span><span className="en">TASK</span></button>
          <button className="flow-item now" data-step="2"><span className="num">03</span><span className="jp">分岐</span><span className="en">WORKTREE</span></button>
          <button className="flow-item" data-step="3"><span className="num">04</span><span className="jp">実行</span><span className="en">AGENT</span></button>
          <button className="flow-item" data-step="4"><span className="num">05</span><span className="jp">審査</span><span className="en">REVIEW</span></button>
        </div>
        {/* Phase 3: #flowKanji/#flowTitle/#flowText/#flowCode contents below
            are the source's static initial state (step 2 / WORKTREE); the
            next agent replaces the children with state-driven content from
            useFlowStepper while keeping these four ids in place. */}
        <div className="flow-detail" aria-live="polite">
          <div className="flow-detail-inner">
            <div className="flow-kanji" id="flowKanji">分岐</div>
            <div className="flow-copy">
              <h3 id="flowTitle">ISOLATE THE CHANGE</h3>
              <p id="flowText">Singularity creates a dedicated git worktree and branch for the task, so parallel agents can build without colliding with one another or contaminating main.</p>
            </div>
            <div className="flow-code" id="flowCode"><b>PATH:</b> .WORKTREES/9E0B59D<br /><b>BRANCH:</b> TASK/9E0B59D<br /><b>STATE:</b> CLEAN</div>
          </div>
        </div>
      </div>
    </section>
  );
}
