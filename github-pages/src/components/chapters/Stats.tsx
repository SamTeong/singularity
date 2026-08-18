// New chapter — not part of the original one-shot scan (docs/one-shot/3d/sample-gitlab-3d-scan.html
// has 7 slides); it reports on building this deck, so the figures below are the project's own
// numbers, not transcribed from source markup.
import type { ChapterProps } from './types';
import { Metric } from '../../deck';

export function Stats({ sectionRef }: ChapterProps) {
  return (
    // className/id are constant literals and this section never receives a
    // `style` prop — Phase 4 adds `.as-panel` to classList and writes
    // width/height/display/opacity directly on this node every frame. A
    // React-driven className rewrite would silently drop `.as-panel` and
    // collapse the panel mid-scroll.
    <section className="chapter stats" id="stats" aria-labelledby="stats-title" ref={sectionRef}>
      <div className="chapter-inner">
        <div className="section-head">
          <span className="idx">08</span>
          <span className="jp">統計</span>
          <h2 id="stats-title">STATS</h2>
        </div>
        <p className="lead">
          Nine screens, three harnesses, one deck — built the same way as the product it demos:
          spec, task, worktree, agent, review.
        </p>
        <div className="stats-hero">
          <div className="stats-figure">
            <b className="c-blue">$3.9K+</b>
            <small>TOKEN SPEND · ALL HARNESSES</small>
          </div>
          <div className="stats-figure">
            <b className="c-mint">450+</b>
            <small>AGENT SESSIONS</small>
          </div>
          <div className="stats-figure">
            <b className="c-amber">3</b>
            <small>AGENT HARNESSES</small>
          </div>
          <div className="stats-figure">
            <b className="c-mint">9</b>
            <small>INFERENCE MODELS</small>
          </div>
        </div>
        <div className="stats-body">
          {/* Authored totals, not the live 260ms telemetry tick — no `liveKey`, so
              these never get overwritten by useTelemetryField. The split is the
              measured share of metered spend across the two paid harnesses;
              Ollama runs local weights, so its share of *spend* is zero however
              many sessions it serves — hence the label rather than a stray 0%. */}
          <div className="stats-meters">
            <Metric label="CLAUDE CODE · SPEND SHARE" pct={93} seg={15} tone="mint" />
            <Metric label="CODEX · SPEND SHARE" pct={7} seg={1} tone="blue" />
            <div className="stats-note">
              <span className="stamp c-amber">OLLAMA</span>
              <span>LOCAL WEIGHTS · UNMETERED SPEND</span>
            </div>
          </div>
          <div className="stats-roster">
            <div className="roster-group">
              <span className="stamp c-mint">CLAUDE CODE</span>
              <p>OPUS · SONNET · HAIKU</p>
            </div>
            <div className="roster-group">
              <span className="stamp c-blue">CODEX</span>
              <p>SOL · TERRA · LUNA</p>
            </div>
            <div className="roster-group">
              <span className="stamp c-amber">OLLAMA</span>
              <p>GLM-5.2 · KIMI-K2.7 · DEEPSEEK-V4-FLASH</p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
