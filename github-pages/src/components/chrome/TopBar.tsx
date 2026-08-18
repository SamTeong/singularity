// Transcribed from docs/one-shot/3d/sample-gitlab-3d-scan.html, source lines 446-455.
import type { ChapterEntry } from '../../config/chapters';

interface TopBarProps {
  /** null before the conductor starts and forever in flat mode — the source
   *  never calls updateDom() on those paths, so the authored markup stands.
   *  For chapter 0 the computed string happens to be identical, but the two
   *  states are still distinct and are reproduced as such. */
  chapter: ChapterEntry | null;
  /** 3D walkthrough active or booting. */
  is3D: boolean;
  /** False where 3D is not an option at all — narrow viewports and machines
   *  without WebGL2 — so the toggle is absent rather than offering a mode the
   *  reader cannot have. */
  canToggle: boolean;
  onToggle: () => void;
  /** Hands-free tour running. */
  autoplay: boolean;
  onToggleAutoplay: () => void;
}

export function TopBar({
  chapter,
  is3D,
  canToggle,
  onToggle,
  autoplay,
  onToggleAutoplay,
}: TopBarProps) {
  return (
    <header className="sx-topbar">
      <span className="sx-brand">
        <span className="sx-mark" aria-hidden="true" />
        <span className="sx-name">SINGULARITY</span>
      </span>
      <span className="sx-note" id="sxNote">
        {/* source L1443: 'CH·' + c.num + ' ' + c.jp + ' — ' + c.title */}
        {chapter ? `CH·${chapter.num} ${chapter.jp} — ${chapter.title}` : 'CH·01 到着 — ORIENTATION'}
      </span>
      {/* Deliberate deviation from the source (L450-454): the original has three
          links — COMMAND ROOM and EVA-01 point at sibling one-shot HTML files
          that do not exist on the deployed site, so only REPOSITORY is kept.
          Do not "restore" the other two; they would 404. */}
      <nav className="sx-links" aria-label="Related scenes">
        <a href="https://github.com/SamTeong/singularity">REPOSITORY ↗</a>
      </nav>
      <button
        type="button"
        className={'sx-mode' + (autoplay ? ' on' : '')}
        onClick={onToggleAutoplay}
        aria-pressed={autoplay}
        aria-label="Toggle the hands-free tour"
      >
        AUTO <b>{autoplay ? 'ON' : 'OFF'}</b>
      </button>
      {canToggle && (
        <button
          type="button"
          className="sx-mode"
          onClick={onToggle}
          aria-pressed={is3D}
          aria-label="Toggle the 3D walkthrough"
        >
          MODE <b>{is3D ? '3D' : '2D'}</b>
        </button>
      )}
    </header>
  );
}
