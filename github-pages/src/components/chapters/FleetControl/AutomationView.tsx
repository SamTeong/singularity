interface AutomationViewProps {
  active: boolean;
}

export function AutomationView({ active }: AutomationViewProps) {
  return (
    <section
      className={'view view-automation' + (active ? ' active' : '')}
      id="view-automation"
      role="tabpanel"
      aria-labelledby="tab-automation"
      hidden={!active}
    >
      <div className="auto-main">
        <div className="zone-title">BACKGROUND DISPATCH · LIVE PIPELINE</div>
        <div className="pipeline" aria-label="Automation pipeline">
          {/* `.pipe-step.done` / `.pipe-step.now` are authored in the source
              markup and never touched by JS there either — static forever. */}
          <div className="pipe-step done">
            <div className="pipe-node">01</div>
            <div className="pipe-label">PICK</div>
          </div>
          <div className="pipe-step done">
            <div className="pipe-node">02</div>
            <div className="pipe-label">WORKTREE</div>
          </div>
          <div className="pipe-step now">
            <div className="pipe-node">03</div>
            <div className="pipe-label">DISPATCH</div>
          </div>
          <div className="pipe-step">
            <div className="pipe-node">04</div>
            <div className="pipe-label">VERIFY</div>
          </div>
          <div className="pipe-step">
            <div className="pipe-node">05</div>
            <div className="pipe-label">REVIEW</div>
          </div>
        </div>
        <div className="job">
          <span className="job-id">BGA·02</span>
          <span className="job-name">PICK READY · LABEL AGENT-OK</span>
          <span className="stamp c-blue blink">RUNNING</span>
        </div>
        <div className="job">
          <span className="job-id">CRN·01</span>
          <span className="job-name">NIGHTLY REVIEW · 02:00 UTC</span>
          <span className="job-state">SCHEDULED</span>
        </div>
        <div className="job">
          <span className="job-id">CRN·04</span>
          <span className="job-name">JOURNAL SYNC · 06:30 UTC</span>
          <span className="job-state">NOMINAL</span>
        </div>
      </div>
      <aside className="auto-side">
        <div className="zone-title">DISPATCH RECEIPT</div>
        <div className="receipt">
          <div className="line">
            <span>TASK SELECTED</span>
            <span className="dots"></span>
            <span className="ok">OK</span>
          </div>
          <div className="line">
            <span>WORKTREE CREATED</span>
            <span className="dots"></span>
            <span className="ok">OK</span>
          </div>
          <div className="line">
            <span>CONTEXT ATTACHED</span>
            <span className="dots"></span>
            <span className="ok">06</span>
          </div>
          <div className="line">
            <span>AGENT SPAWNED</span>
            <span className="dots"></span>
            <span className="ok">PID 4821</span>
          </div>
          <div className="line">
            <span>STATE CHANNEL</span>
            <span className="dots"></span>
            <span className="ok">LIVE</span>
          </div>
        </div>
      </aside>
    </section>
  );
}
