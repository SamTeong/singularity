import type { CSSProperties } from 'react';

export function TasksView() {
  return (
    <section className="view view-tasks" id="view-tasks" role="tabpanel" aria-labelledby="tab-tasks" hidden>
      <div className="task-tools">
        {/* Phase 3: `.filter.on` on the first filter is authored, not JS-toggled — active filter state lives here */}
        <button className="filter on">ALL · 07</button>
        <button className="filter">FEATURE</button>
        <button className="filter">BUG</button>
        <span className="spacer"></span>
        <span className="stamp c-mint">BOARD LIVE</span>
      </div>
      <div className="kanban">
        <div className="column">
          <div className="column-head">
            <span>TO-DO 待機</span>
            <span>02</span>
          </div>
          <article className="taskcard">
            <span className="id">TSK·121</span>
            <b>ADD SEARCH TO TRANSCRIPTS</b>
            <span className="meta">MAIN · FEATURE<br />NO SESSION ATTACHED</span>
          </article>
          <article className="taskcard">
            <span className="id">TSK·124</span>
            <b>STATUS PROVIDER RETRY</b>
            <span className="meta">MAIN · RELIABILITY</span>
          </article>
        </div>
        <div className="column">
          <div className="column-head">
            <span>IN PROGRESS 進行</span>
            <span>02</span>
          </div>
          {/* Phase 3: `.taskcard.active` is authored in the markup, not JS-toggled */}
          <article className="taskcard active">
            <span className="id">TSK·118</span>
            <b>USAGE SPARKLINES</b>
            <span className="meta">
              WT/9E0B59D · CODEX<br />
              <span className="t-turns">11</span> TURNS · $<span className="t-usd">4.18</span>
            </span>
          </article>
          <article className="taskcard active">
            <span className="id">TSK·119</span>
            <b>HISTORY CORE SAMPLE</b>
            <span className="meta">WT/DEBA6C3D · SONNET</span>
          </article>
        </div>
        <div className="column">
          <div className="column-head">
            <span>IN REVIEW 審査</span>
            <span>01</span>
          </div>
          <article className="taskcard" style={{ '--tone': 'var(--amber)' } as CSSProperties}>
            <span className="id">TSK·116</span>
            <b>WIKI GRAPH LINKS</b>
            <span className="meta">WT/8AFBF74 · DIFF READY<br />OPERATOR RULING REQUIRED</span>
          </article>
        </div>
        <div className="column">
          <div className="column-head">
            <span>DONE 完了</span>
            <span>02</span>
          </div>
          {/* Phase 3: `.taskcard.done` is authored in the markup, not JS-toggled */}
          <article className="taskcard done">
            <span className="id">TSK·112</span>
            <b>PHOSPHOR THEME</b>
            <span className="meta">MERGED · TRANSCRIPT SAVED</span>
          </article>
          <article className="taskcard done">
            <span className="id">TSK·113</span>
            <b>BACKGROUND DISPATCH</b>
            <span className="meta">MERGED · 14 TESTS PASS</span>
          </article>
        </div>
      </div>
    </section>
  );
}
