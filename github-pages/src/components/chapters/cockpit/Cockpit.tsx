import { useEffect, useMemo, useRef } from 'react';
import type { Ref, RefCallback } from 'react';
import type { ChapterProps } from '../types';
import { SessionsView } from './SessionsView';
import { TasksView } from './TasksView';
import { AutomationView } from './AutomationView';
import { UsageView } from './UsageView';
import { useTabs, useUptime, useTelemetryEngine, renderTerminal, requestChartRedraw } from '../../../deck';

// Merges the external `sectionRef` (populated by Phase 4/5 once the world
// adopts this node as a CSS3DObject) with a ref local to this component
// (needed so useTelemetryEngine can read `#control`'s inline `style.display`
// — see the comment there). Deck.tsx does not currently pass `sectionRef` at
// all (Phase 2 left it wired but unused), so the local ref is what makes the
// engine's guard functional today; it keeps working once Phase 4/5 start
// passing a real ref through too.
function mergeRefs<T>(...refs: Array<Ref<T> | undefined>): RefCallback<T> {
  return (node) => {
    for (const ref of refs) {
      if (!ref) continue;
      if (typeof ref === 'function') ref(node);
      else (ref as { current: T | null }).current = node;
    }
  };
}

export function Cockpit({ sectionRef }: ChapterProps) {
  const localSectionRef = useRef<HTMLElement | null>(null);
  const mergedSectionRef = useMemo(() => mergeRefs(sectionRef, localSectionRef), [sectionRef]);

  const { view, select, registerTab, handleKeyDown } = useTabs();
  const uptime = useUptime();

  useTelemetryEngine({ sectionRef: localSectionRef, view });

  // Source L903-904 (`selectView`) plus L1023 (the bare `renderTerminal()`
  // call at module load): switching to "sessions" re-runs the terminal
  // typewriter, switching to "usage" asks the chart to redraw next frame.
  // Since `view` starts as "sessions", this effect running on mount also
  // covers the source's initial `renderTerminal()` call — no separate
  // mount-only effect needed.
  useEffect(() => {
    if (view === 'sessions') renderTerminal();
    if (view === 'usage') requestAnimationFrame(requestChartRedraw);
  }, [view]);

  return (
    // className and id are constant literals, and this element never receives a
    // `style` prop, on purpose: in Phase 4 the Three.js CSS3DObject layer adds
    // `.as-panel` to this section's classList and writes width/height/display/
    // opacity to its style every frame. A dynamic className would be rewritten
    // wholesale by React on every render and silently drop `.as-panel`,
    // collapsing the panel mid-scroll.
    <section className="chapter cockpit" id="control" aria-labelledby="control-title" ref={mergedSectionRef}>
      <div className="intro">
        <div className="section-head">
          <span className="idx">04</span>
          <span className="jp">制御</span>
          <h2 id="control-title">THE WHOLE FLEET. ONE CONTROL PLANE.</h2>
        </div>
        <p className="lead">
          The control plane does not replace your tools. It connects them. Switch between sessions, tasks,
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
            <b>LINK:</b> localhost<br />
            <b>PORT:</b> 4317<br />
            <b>UPTIME:</b> <span id="uptime">{uptime}</span>
          </div>
        </div>
        <div className="console-tabs" role="tablist" aria-label="Control plane views">
          <button
            className="tab"
            id="tab-sessions"
            role="tab"
            aria-selected={view === 'sessions'}
            aria-controls="view-sessions"
            data-view="sessions"
            tabIndex={view === 'sessions' ? 0 : -1}
            ref={registerTab('sessions')}
            onClick={() => select('sessions')}
            onKeyDown={(e) => handleKeyDown(e, 'sessions')}
          >
            SESSIONS 会話
          </button>
          <button
            className="tab"
            id="tab-tasks"
            role="tab"
            aria-selected={view === 'tasks'}
            aria-controls="view-tasks"
            data-view="tasks"
            tabIndex={view === 'tasks' ? 0 : -1}
            ref={registerTab('tasks')}
            onClick={() => select('tasks')}
            onKeyDown={(e) => handleKeyDown(e, 'tasks')}
          >
            TASKS 任務
          </button>
          <button
            className="tab"
            id="tab-automation"
            role="tab"
            aria-selected={view === 'automation'}
            aria-controls="view-automation"
            data-view="automation"
            tabIndex={view === 'automation' ? 0 : -1}
            ref={registerTab('automation')}
            onClick={() => select('automation')}
            onKeyDown={(e) => handleKeyDown(e, 'automation')}
          >
            AUTOMATION 自動
          </button>
          <button
            className="tab"
            id="tab-usage"
            role="tab"
            aria-selected={view === 'usage'}
            aria-controls="view-usage"
            data-view="usage"
            tabIndex={view === 'usage' ? 0 : -1}
            ref={registerTab('usage')}
            onClick={() => select('usage')}
            onKeyDown={(e) => handleKeyDown(e, 'usage')}
          >
            USAGE 消費
          </button>
        </div>
        <div className="console-body">
          <SessionsView active={view === 'sessions'} />
          <TasksView active={view === 'tasks'} />
          <AutomationView active={view === 'automation'} />
          <UsageView active={view === 'usage'} />
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
