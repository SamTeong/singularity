// Transcribed from docs/one-shot/3d/sample-gitlab-3d-scan.html, source lines 695-710.
import type { ChapterProps } from './types';
import { useCopyCommand } from '../../deck';

// Source lines 702-704. Hoisted to a module constant (rather than inline JSX
// text) so the exact three-line string is never re-transcribed: JSX would
// strip the leading/trailing whitespace of each line and join them with a
// single space, collapsing this into one line and breaking the CSS
// `white-space: pre-wrap` layout. Phase 3's copy button imports this same
// constant so the displayed text and the copied text can never drift.
export const INSTALL_COMMAND = `git clone https://github.com/SamTeong/singularity.git
cd singularity
pnpm bootstrap`;

const COPY_STATE_TEXT: Record<'idle' | 'copied' | 'blocked', string> = {
  idle: 'BOOTSTRAP GENERATES LOCAL CONFIG, INSTALLS DEPENDENCIES, AND STARTS THE CONTROL PLANE.',
  copied: 'COMMAND COPIED · PASTE INTO YOUR TERMINAL',
  blocked: 'COPY BLOCKED · SELECT THE COMMAND MANUALLY',
};

export function Cta({ sectionRef }: ChapterProps) {
  const { status, copy } = useCopyCommand(INSTALL_COMMAND);

  return (
    // className/id are constant literals and this section never receives a
    // `style` prop — Phase 4 adds `.as-panel` to classList and writes
    // width/height/display/opacity directly on this node every frame. A
    // React-driven className rewrite would silently drop `.as-panel` and
    // collapse the panel mid-scroll.
    <section className="chapter cta" id="boot" aria-labelledby="boot-title" ref={sectionRef}>
      <div className="chapter-inner">
        <div className="cta-jp">開始</div>
        <h2 className="display" id="boot-title">
          TAKE <span className="mint">CONTROL.</span>
        </h2>
        <p className="cta-sub">FROM ONE TERMINAL TO ONE OPERATIONAL PICTURE.</p>
        <div className="install">
          <div className="install-head">
            <span>BOOT SEQUENCE · FIRST RUN</span>
            <span className="spacer" />
            <button className="copy-btn" id="copyCommand" type="button" onClick={() => void copy()}>
              COPY COMMAND
            </button>
          </div>
          <code id="installCommand">{INSTALL_COMMAND}</code>
        </div>
        <div className="copy-state" id="copyState" role="status" aria-live="polite">
          {COPY_STATE_TEXT[status]}
        </div>
        <div className="cta-actions">
          <a className="btn primary" href="https://github.com/SamTeong/singularity">
            OPEN REPOSITORY
          </a>
          <a className="btn alt" href="#hero">
            RETURN TO ORIENTATION
          </a>
        </div>
        <div className="final-marquee" aria-hidden="true">
          <div className="marquee-track">
            <span>SESSIONS LIVE</span>
            <span>TASKS SYNCHRONIZED</span>
            <span>WORKTREES ISOLATED</span>
            <span>DAEMON LOOPBACK</span>
            <span>CONTEXT ATTACHED</span>
            <span>SESSIONS LIVE</span>
            <span>TASKS SYNCHRONIZED</span>
            <span>WORKTREES ISOLATED</span>
            <span>DAEMON LOOPBACK</span>
            <span>CONTEXT ATTACHED</span>
          </div>
        </div>
      </div>
    </section>
  );
}
