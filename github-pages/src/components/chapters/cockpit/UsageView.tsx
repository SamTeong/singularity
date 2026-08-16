export function UsageView() {
  return (
    <section className="view view-usage" id="view-usage" role="tabpanel" aria-labelledby="tab-usage" hidden>
      <div className="chart-pane">
        <div className="zone-title">FLEET TOKEN VELOCITY · 60 MIN</div>
        <div className="chart-wrap">
          {/* Phase 3: JS draws the trend line into this canvas */}
          <canvas id="usageChart" aria-label="Fleet token usage trend"></canvas>
          <span className="chart-label">
            TOKENS / MIN · <b id="tpmValue">1.2K</b>
          </span>
        </div>
        <div className="usage-totals">
          <div className="usage-total">
            <small>TODAY</small>
            <b id="usdToday">$18.42</b>
          </div>
          <div className="usage-total">
            <small>5H WINDOW</small>
            <b>19%</b>
          </div>
          <div className="usage-total">
            <small>7D WINDOW</small>
            <b>33%</b>
          </div>
        </div>
      </div>
      <aside className="gauge-pane">
        <div className="zone-title">CAPACITY STATUS</div>
        <div className="radial">
          <svg viewBox="0 0 120 120" aria-hidden="true">
            <circle className="track" cx="60" cy="60" r="48" />
            <circle className="value" cx="60" cy="60" r="48" />
          </svg>
          <div className="radial-text">
            <b>81%</b>
            <small>AVAILABLE</small>
          </div>
        </div>
        <div className="metric">
          <div className="metric-row">
            <span>CLAUDE · 5H</span>
            <b>19%</b>
          </div>
          {/* Phase 3: <Segments/> — JS appends 16 <i> children */}
          <div className="segments" data-value="4" data-tone="mint"></div>
        </div>
        <div className="metric">
          <div className="metric-row">
            <span>OLLAMA · 7D</span>
            <b>33%</b>
          </div>
          {/* Phase 3: <Segments/> — JS appends 16 <i> children */}
          <div className="segments" data-value="7" data-tone="blue"></div>
        </div>
      </aside>
    </section>
  );
}
