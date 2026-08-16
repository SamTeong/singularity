import type { ChapterProps } from '../types';
import { SessionsView } from './SessionsView';
import { TasksView } from './TasksView';
import { AutomationView } from './AutomationView';
import { UsageView } from './UsageView';

export function Cockpit({ sectionRef }: ChapterProps) {
  return (
    // className and id are constant literals, and this element never receives a
    // `style` prop, on purpose: in Phase 4 the Three.js CSS3DObject layer adds
    // `.as-panel` to this section's classList and writes width/height/display/
    // opacity to its style every frame. A dynamic className would be rewritten
    // wholesale by React on every render and silently drop `.as-panel`,
    // collapsing the panel mid-scroll.
    <section className="chapter cockpit" id="control" aria-labelledby="control-title" ref={sectionRef}>
      <div className="intro">
        <div className="section-head">
          <span className="idx">01</span>
          <span className="jp">制御</span>
          <h2 id="control-title">THE WHOLE FLEET. ONE LIVE DECK.</h2>
        </div>
        <p className="lead">
          The cockpit does not replace your tools. It connects them. Switch the live preview between sessions, tasks,
          automation, and usage.
        </p>
      </div>
      <div className="console" aria-label="Interactive Singularity control plane preview">
        <div className="console-head">
          <span className="console-mono">特</span>
          <div className="console-title">
            SINGULARITY · FLEET CONTROL<small>LOCAL WEB SHELL // LOOPBACK NODE DAEMON</small>
          </div>
          <div className="console-meta">
            <b>LINK:</b> 127.0.0.1<br />
            <b>PORT:</b> 4317<br />
            <b>UPTIME:</b> <span id="uptime">02:41:09</span>
          </div>
        </div>
        <div className="console-tabs" role="tablist" aria-label="Control plane views">
          {/* Phase 3: click/keyboard tab switching + aria-selected/tabIndex state */}
          <button className="tab" id="tab-sessions" role="tab" aria-selected="true" aria-controls="view-sessions" data-view="sessions">
            SESSIONS 会話
          </button>
          <button className="tab" id="tab-tasks" role="tab" aria-selected="false" aria-controls="view-tasks" data-view="tasks" tabIndex={-1}>
            TASKS 任務
          </button>
          <button
            className="tab"
            id="tab-automation"
            role="tab"
            aria-selected="false"
            aria-controls="view-automation"
            data-view="automation"
            tabIndex={-1}
          >
            AUTOMATION 自動
          </button>
          <button className="tab" id="tab-usage" role="tab" aria-selected="false" aria-controls="view-usage" data-view="usage" tabIndex={-1}>
            USAGE 消費
          </button>
        </div>
        <div className="console-body">
          <SessionsView />
          <TasksView />
          <AutomationView />
          <UsageView />
        </div>
        <div className="console-status">
          <span className="good">◉ DAEMON ONLINE</span>
          <span>AGENTS 04</span>
          <span>TASKS 07</span>
          <span>WORKTREES 05</span>
          <span className="spacer"></span>
          <span>LOCAL STATE · NO CLOUD TENANT</span>
        </div>
      </div>
    </section>
  );
}
