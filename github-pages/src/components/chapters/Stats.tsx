// New chapter — not part of the original one-shot scan (docs/one-shot/3d/sample-gitlab-3d-scan.html
// has 7 slides); it reports on building this deck, so the figures below are the project's own
// numbers, not transcribed from source markup.
import type { ChapterProps } from './types';

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
          <span className="idx">14</span>
          <span className="jp">統計</span>
          <h2 id="stats-title">STATS</h2>
        </div>
        <p className="lead">
          These numbers capture what it took to get here. In the 38+ days since the initial commit,
          two developers ran 450+ agent sessions across three harnesses and nine inference models
          to ship 17 pages.
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
            <b className="c-orange">38+</b>
            <small>DAYS SINCE INITIAL COMMIT</small>
          </div>
          <div className="stats-figure">
            <b className="c-red">2</b>
            <small>DEVELOPERS WITH PASSION</small>
          </div>
          <div className="stats-figure">
            <b className="c-amber">3</b>
            <small>AGENT HARNESSES</small>
          </div>
          <div className="stats-figure">
            <b className="c-mint">9</b>
            <small>INFERENCE MODELS</small>
          </div>
          <div className="stats-figure">
            <b className="c-blue">17</b>
            <small>PAGES SHIPPED</small>
          </div>
        </div>
      </div>
    </section>
  );
}
