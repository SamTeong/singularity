import { useState } from 'react';
import { Metric, TerminalPane, renderTerminal, useTelemetryField } from '../../../deck';

interface SessionsViewProps {
  active: boolean;
}

export function SessionsView({ active }: SessionsViewProps) {
  // `.session.active` selection state (source: `$$('.session').forEach(...)`,
  // L918-921). Clicking a session re-runs the terminal typewriter, exactly
  // like the source — it does not change what the terminal types.
  const [selected, setSelected] = useState(0);
  const tokens = useTelemetryField('tokens');

  const selectSession = (index: number) => {
    setSelected(index);
    renderTerminal();
  };

  return (
    <section
      className={'view view-sessions' + (active ? ' active' : '')}
      id="view-sessions"
      role="tabpanel"
      aria-labelledby="tab-sessions"
      hidden={!active}
    >
      <aside className="console-rail">
        <div className="zone-title">LIVE AGENTS · 04</div>
        <button className={'session' + (selected === 0 ? ' active' : '')} onClick={() => selectSession(0)}>
          <span className="s-top">
            E2E-SUITE <span>◉</span>
          </span>
          <span className="s-meta">
            OPUS · <span className="s-turns">18</span> TURNS ·{' '}
            <span className="s-tok">{tokens !== null ? tokens.toFixed(0) + 'K' : '418K'}</span> TOK
          </span>
        </button>
        <button className={'session' + (selected === 1 ? ' active' : '')} onClick={() => selectSession(1)}>
          <span className="s-top">
            HISTORY-CORE <span>○</span>
          </span>
          <span className="s-meta">
            SONNET · <span className="s-turns">9</span> TURNS · <span className="s-tok">124K</span> TOK
          </span>
        </button>
        <button className={'session' + (selected === 2 ? ' active' : '')} onClick={() => selectSession(2)}>
          <span className="s-top">
            USAGE-GRAPH <span>◉</span>
          </span>
          <span className="s-meta">
            CODEX · <span className="s-turns">11</span> TURNS · <span className="s-tok">201K</span> TOK
          </span>
        </button>
        <button className={'session' + (selected === 3 ? ' active' : '')} onClick={() => selectSession(3)}>
          <span className="s-top">
            WIKI-LINKS <span>□</span>
          </span>
          <span className="s-meta">OPUS · REVIEW REQUIRED</span>
        </button>
      </aside>
      <div className="console-main">
        <div className="zone-title">ACTIVE PTY · E2E-SUITE · ~/SINGULARITY/.WORKTREES/9E0B59D</div>
        <TerminalPane />
      </div>
      <aside className="console-side">
        <div className="zone-title">LIVE TELEMETRY</div>
        <Metric label="CONTEXT" pct={42} seg={8} tone="mint" liveKey="ctx" />
        <Metric label="CPU" pct={34} seg={6} tone="blue" liveKey="cpu" />
        <Metric label="MEMORY" pct={61} seg={11} tone="amber" liveKey="mem" />
        {/* The tick never targets `[data-live="use"]` (source setSegments
            calls only ever pass cpu/mem/ctx selectors) — this metric is
            frozen at its authored value forever, in every motion mode. */}
        <Metric label="5H USAGE" pct={19} seg={4} tone="mint" dataLive="use" />
        <div className="logbox" id="eventFeed">
          <b>EVENT FEED</b>
          <br />
          16:21 TASK MOVED → REVIEW
          <br />
          16:18 SESSION RESUMED
          <br />
          16:11 WORKTREE CLEAN
          <br />
          15:52 CRON·02 COMPLETE
        </div>
      </aside>
    </section>
  );
}
