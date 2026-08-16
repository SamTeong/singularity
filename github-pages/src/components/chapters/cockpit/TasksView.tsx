import { useState } from 'react';
import type { CSSProperties } from 'react';
import { useTelemetryField } from '../../../deck';

interface TasksViewProps {
  active: boolean;
}

export function TasksView({ active }: TasksViewProps) {
  // Only TSK·118's turns/cost are live (source: `$$('.t-turns')[0]`,
  // `$$('.t-usd')[0]` — the first match only). Every other card's numbers
  // stay frozen literals.
  const turns = useTelemetryField('turns');
  const usd = useTelemetryField('usd');
  // Source L922-924: clicking a filter just moves `.on` to it — no actual
  // filtering of the kanban board.
  const [filter, setFilter] = useState<'all' | 'feature' | 'bug'>('all');

  return (
    <section
      className={'view view-tasks' + (active ? ' active' : '')}
      id="view-tasks"
      role="tabpanel"
      aria-labelledby="tab-tasks"
      hidden={!active}
    >
      <div className="task-tools">
        <button className={'filter' + (filter === 'all' ? ' on' : '')} onClick={() => setFilter('all')}>
          ALL · 07
        </button>
        <button className={'filter' + (filter === 'feature' ? ' on' : '')} onClick={() => setFilter('feature')}>
          FEATURE
        </button>
        <button className={'filter' + (filter === 'bug' ? ' on' : '')} onClick={() => setFilter('bug')}>
          BUG
        </button>
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
            <span className="meta">
              MAIN · FEATURE
              <br />
              NO SESSION ATTACHED
            </span>
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
          <article className="taskcard active">
            <span className="id">TSK·118</span>
            <b>USAGE SPARKLINES</b>
            <span className="meta">
              WT/9E0B59D · CODEX
              <br />
              <span className="t-turns">{turns !== null ? turns : 11}</span> TURNS · $
              <span className="t-usd">{usd !== null ? usd.toFixed(2) : '4.18'}</span>
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
            <span className="meta">
              WT/8AFBF74 · DIFF READY
              <br />
              OPERATOR RULING REQUIRED
            </span>
          </article>
        </div>
        <div className="column">
          <div className="column-head">
            <span>DONE 完了</span>
            <span>02</span>
          </div>
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
