export function SessionsView() {
  return (
    <section className="view view-sessions active" id="view-sessions" role="tabpanel" aria-labelledby="tab-sessions">
      <aside className="console-rail">
        <div className="zone-title">LIVE AGENTS · 04</div>
        {/* Phase 3: `.session.active` on the first button is authored, not JS-toggled — selection state lives here */}
        <button className="session active">
          <span className="s-top">E2E-SUITE <span>◉</span></span>
          <span className="s-meta">OPUS · <span className="s-turns">18</span> TURNS · <span className="s-tok">418K</span> TOK</span>
        </button>
        <button className="session">
          <span className="s-top">HISTORY-CORE <span>○</span></span>
          <span className="s-meta">SONNET · <span className="s-turns">9</span> TURNS · <span className="s-tok">124K</span> TOK</span>
        </button>
        <button className="session">
          <span className="s-top">USAGE-GRAPH <span>◉</span></span>
          <span className="s-meta">CODEX · <span className="s-turns">11</span> TURNS · <span className="s-tok">201K</span> TOK</span>
        </button>
        <button className="session">
          <span className="s-top">WIKI-LINKS <span>□</span></span>
          <span className="s-meta">OPUS · REVIEW REQUIRED</span>
        </button>
      </aside>
      <div className="console-main">
        <div className="zone-title">ACTIVE PTY · E2E-SUITE · ~/SINGULARITY/.WORKTREES/9E0B59D</div>
        <div className="terminal" aria-label="Live agent terminal">
          <div className="terminal-head">
            STDOUT // CLAUDE CODE PTY
            <span className="dots" aria-hidden="true">
              <i></i>
              <i></i>
              <i></i>
            </span>
          </div>
          {/* Phase 3: JS types the live PTY stream into this node; empty at first paint */}
          <div className="terminal-body" id="terminalBody" aria-live="polite"></div>
          <div className="terminal-foot">
            <span>MODEL: OPUS</span>
            <span>MODE: AGENT</span>
            <span>LINK: LIVE</span>
          </div>
        </div>
      </div>
      <aside className="console-side">
        <div className="zone-title">LIVE TELEMETRY</div>
        <div className="metric">
          <div className="metric-row">
            <span>CONTEXT</span>
            <b>42%</b>
          </div>
          {/* Phase 3: <Segments/> — JS appends 16 <i> children */}
          <div className="segments" data-value="8" data-tone="mint" data-live="ctx"></div>
        </div>
        <div className="metric">
          <div className="metric-row">
            <span>CPU</span>
            <b>34%</b>
          </div>
          {/* Phase 3: <Segments/> — JS appends 16 <i> children */}
          <div className="segments" data-value="6" data-tone="blue" data-live="cpu"></div>
        </div>
        <div className="metric">
          <div className="metric-row">
            <span>MEMORY</span>
            <b>61%</b>
          </div>
          {/* Phase 3: <Segments/> — JS appends 16 <i> children */}
          <div className="segments" data-value="11" data-tone="amber" data-live="mem"></div>
        </div>
        <div className="metric">
          <div className="metric-row">
            <span>5H USAGE</span>
            <b>19%</b>
          </div>
          {/* Phase 3: <Segments/> — JS appends 16 <i> children */}
          <div className="segments" data-value="4" data-tone="mint" data-live="use"></div>
        </div>
        <div className="logbox" id="eventFeed">
          <b>EVENT FEED</b>
          <br />
          16:21 TASK MOVED → REVIEW<br />
          16:18 SESSION RESUMED<br />
          16:11 WORKTREE CLEAN<br />
          15:52 CRON·02 COMPLETE
        </div>
      </aside>
    </section>
  );
}
