// Transcribed from docs/one-shot/3d/sample-gitlab-3d-scan.html, source lines 670-691.
import type { CSSProperties } from 'react';
import type { ChapterProps } from './types';

export function SystemDesign({ sectionRef }: ChapterProps) {
  return (
    // className/id are constant literals and this section never receives a
    // `style` prop — Phase 4 adds `.as-panel` to classList and writes
    // width/height/display/opacity directly on this node every frame. A
    // React-driven className rewrite would silently drop `.as-panel` and
    // collapse the panel mid-scroll.
    <section className="chapter system-design" id="system-design" aria-labelledby="system-design-title" ref={sectionRef}>
      <div className="chapter-inner system-design-grid">
        <div>
          <div className="eyebrow">
            <span className="jp">局所</span>SYSTEM DESIGN
          </div>
          <h2 className="display" id="system-design-title">
            YOUR MACHINE.<br />
            <span className="mint">YOUR STATE.</span>
            <br />
            YOUR AGENTS.
          </h2>
          <p className="lead">The daemon binds to <strong>localhost only</strong>. It serves the browser shell, manages agent terminals, and keeps owned state under your configured Singularity home.</p>
          <div className="security-list">
            <div className="security-row">
              <span className="key">BIND</span>
              <span className="val">localhost · LOOPBACK ONLY</span>
              <span className="stamp c-mint">LOCKED</span>
            </div>
            <div className="security-row">
              <span className="key">AUTH</span>
              <span className="val">OPTIONAL SING_TOKEN</span>
              <span className="stamp c-blue">AVAILABLE</span>
            </div>
            <div className="security-row">
              <span className="key">WORK</span>
              <span className="val">GIT WORKTREES AT TRUSTED ROOT</span>
              <span className="stamp c-mint">LOCAL</span>
            </div>
            <div className="security-row">
              <span className="key">TRANSCRIPTS</span>
              <span className="val">READ FROM LOCAL AGENT ARCHIVES</span>
              <span className="stamp c-mint">LOCAL</span>
            </div>
          </div>
        </div>
        <div className="architecture" aria-label="Singularity local architecture diagram" role="img">
          <div className="architecture-inner">
            <div className="arch-row">
              <div className="arch-box">
                <span className="jp">画面</span>
                <b>BROWSER SHELL</b>
                <small>REACT · XTERM · MUI</small>
              </div>
              <span className="arch-link" />
              {/* --tone is a CSS custom property, not in the CSSProperties type, hence the cast. */}
              <div className="arch-box" style={{ '--tone': 'var(--blue)' } as CSSProperties}>
                <span className="jp">通信</span>
                <b>WS + REST</b>
                <small>LIVE STATE CHANNEL</small>
              </div>
            </div>
            <div className="loopback">localhost:4317 · LOOPBACK BOUND</div>
            <div className="daemon-core">
              <span className="wire" />
              <div className="daemon">
                <span className="jp">常駐</span>
                <br />
                <b>NODE DAEMON</b>
                <br />
                <small>FASTIFY · WS · NODE-PTY</small>
              </div>
              <span className="wire" />
            </div>
            <div className="arch-row" style={{ marginTop: 22 }}>
              <div className="arch-box" style={{ '--tone': 'var(--amber)' } as CSSProperties}>
                <span className="jp">代理</span>
                <b>CODING AGENTS</b>
                <small>LIVE PTY PROCESSES</small>
              </div>
              <span className="arch-link" />
              <div className="arch-box">
                <span className="jp">分岐</span>
                <b>GIT WORKTREES</b>
                <small>ISOLATED TASK BRANCHES</small>
              </div>
            </div>
            <div className="arch-footer">
              <span><b>STATE:</b> SINGULARITY_HOME/STATE</span>
              <span><b>TRUST:</b> REPO-CONTROLLABLE PERMISSIONS</span>
              <span><b>EXPOSURE:</b> LOOPBACK ONLY</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
