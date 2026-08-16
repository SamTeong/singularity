import { Metric, UsageChart, useTelemetryField } from '../../../deck';

interface UsageViewProps {
  active: boolean;
}

export function UsageView({ active }: UsageViewProps) {
  const today = useTelemetryField('today');
  const tpm = useTelemetryField('tpm');

  return (
    <section
      className={'view view-usage' + (active ? ' active' : '')}
      id="view-usage"
      role="tabpanel"
      aria-labelledby="tab-usage"
      hidden={!active}
    >
      <div className="chart-pane">
        <div className="zone-title">FLEET TOKEN VELOCITY · 60 MIN</div>
        <div className="chart-wrap">
          <UsageChart />
          <span className="chart-label">
            TOKENS / MIN · <b id="tpmValue">{tpm !== null ? tpm.toFixed(1) + 'K' : '1.2K'}</b>
          </span>
        </div>
        <div className="usage-totals">
          <div className="usage-total">
            <small>TODAY</small>
            <b id="usdToday">{today !== null ? '$' + today.toFixed(2) : '$18.42'}</b>
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
        <Metric label="CLAUDE · 5H" pct={19} seg={4} tone="mint" />
        <Metric label="OLLAMA · 7D" pct={33} seg={7} tone="blue" />
      </aside>
    </section>
  );
}
