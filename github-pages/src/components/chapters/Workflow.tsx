import { Fragment } from 'react';
import type { ChapterProps } from './types';
import { useFlowStepper } from '../../deck';

function flowItemClass(i: number, current: number): string {
  return 'flow-item' + (i < current ? ' done' : i === current ? ' now' : '');
}

export function Workflow({ sectionRef }: ChapterProps) {
  const { index, step, show } = useFlowStepper();

  return (
    // className and id are constant literals on purpose, and no style prop
    // is passed here — Phase 4 adds `.as-panel` to this element's classList
    // and writes width/height/display/opacity on it every frame; a computed
    // className or a style prop would fight that and drop the class.
    <section className="chapter workflow" id="workflow" aria-labelledby="workflow-title" ref={sectionRef}>
      <div className="chapter-inner">
        <div className="section-head"><span className="idx">05</span><span className="jp">流程</span><h2 id="workflow-title">WORK MOVES. CONTEXT STAYS ATTACHED.</h2></div>
        <p className="lead">A task is not just a card. It binds the requirement, branch, worktree, live session, transcript, and final review into one operational record.</p>
        <div className="flow" role="group" aria-label="Task workflow">
          <button className={flowItemClass(0, index)} data-step="0" onClick={() => show(0, true)}>
            <span className="num">01</span><span className="jp">仕様</span><span className="en">SPEC</span>
          </button>
          <button className={flowItemClass(1, index)} data-step="1" onClick={() => show(1, true)}>
            <span className="num">02</span><span className="jp">任務</span><span className="en">TASK</span>
          </button>
          <button className={flowItemClass(2, index)} data-step="2" onClick={() => show(2, true)}>
            <span className="num">03</span><span className="jp">分岐</span><span className="en">WORKTREE</span>
          </button>
          <button className={flowItemClass(3, index)} data-step="3" onClick={() => show(3, true)}>
            <span className="num">04</span><span className="jp">実行</span><span className="en">AGENT</span>
          </button>
          <button className={flowItemClass(4, index)} data-step="4" onClick={() => show(4, true)}>
            <span className="num">05</span><span className="jp">審査</span><span className="en">REVIEW</span>
          </button>
        </div>
        <div className="flow-detail" aria-live="polite">
          <div className="flow-detail-inner">
            <div className="flow-kanji" id="flowKanji">{step.kanji}</div>
            <div className="flow-copy">
              <h3 id="flowTitle">{step.title}</h3>
              <p id="flowText">{step.text}</p>
            </div>
            <div className="flow-code" id="flowCode">
              {step.code.map(([label, value], i) => (
                <Fragment key={label}>
                  {i > 0 && <br />}
                  <b>{label}</b>{' ' + value}
                </Fragment>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
