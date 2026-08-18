// New slide — no upstream mockup to transcribe from; follows the shape of
// the other chapters (see CLAUDE.md's "Add a slide" runbook).
import type { ChapterProps } from './types';

export function Credits({ sectionRef }: ChapterProps) {
  return (
    // className/id are constant literals and this section never receives a
    // `style` prop — Phase 4 adds `.as-panel` to classList and writes
    // width/height/display/opacity directly on this node every frame. A
    // React-driven className rewrite would silently drop `.as-panel` and
    // collapse the panel mid-scroll.
    <section className="chapter credits" id="credits" aria-labelledby="credits-title" ref={sectionRef}>
      <div className="chapter-inner">
        <div className="section-head">
          <span className="idx">09</span>
          <span className="jp">謝辞</span>
          <h2 id="credits-title">CREDITS</h2>
        </div>
        <p className="lead">
          Every project sits in a landscape of related tools, borrowed ideas, and people willing to look at the work
          and say what doesn't hold up yet.
        </p>
        <div className="credits-groups">
          <div className="credits-group">
            <div className="credits-label c-orange">LANDSCAPE · PRIOR ART</div>
            <div className="credits-rows">
              <div className="credits-row">
                <span className="credits-name">CONDUCTOR</span>
                <span className="credits-desc">PARALLEL GIT-WORKTREE AGENT ORCHESTRATOR</span>
              </div>
              <div className="credits-row">
                <span className="credits-name">BUZZ</span>
                <span className="credits-desc">PARALLEL MULTI-AGENT CODING SURFACE</span>
              </div>
            </div>
          </div>
          <div className="credits-group">
            <div className="credits-label c-mint">INSPIRED BY</div>
            <div className="credits-rows">
              <div className="credits-row">
                <span className="credits-name">ANDREJ KARPATHY</span>
                <span className="credits-desc">AGENTIC CODING · LLM-NATIVE WORKFLOWS</span>
              </div>
              <div className="credits-row">
                <span className="credits-name">MATT POCOCK</span>
                <span className="credits-desc">TYPESCRIPT RIGOR</span>
              </div>
              <div className="credits-row">
                <span className="credits-name">NATE HERK</span>
                <span className="credits-desc">AGENT AUTOMATION PATTERNS</span>
              </div>
              <div className="credits-row">
                <span className="credits-name">CHASE HANNEGAN</span>
                <span className="credits-desc">AGENT HARNESS TOOLING</span>
              </div>
            </div>
          </div>
          <div className="credits-group">
            <div className="credits-label c-blue">ADVISORS</div>
            <p className="credits-note">Counsel on scope, direction, and blind spots, freely given.</p>
            <div className="credits-row credits-row-plain">
              <span className="credits-name">KEVIN LIM</span>
              <span className="credits-name">MIN SOE ZAN</span>
            </div>
          </div>
        </div>
        <div className="credits-actions">
          <a className="btn alt" href="https://github.com/SamTeong/singularity">
            VIEW SOURCE
          </a>
        </div>
      </div>
    </section>
  );
}
