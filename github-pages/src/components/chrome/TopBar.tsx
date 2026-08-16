// Transcribed from docs/one-shot/3d/sample-gitlab-3d-scan.html, source lines 446-455.
export function TopBar() {
  return (
    <header className="sx-topbar">
      <span className="sx-brand">
        <span className="sx-mark" aria-hidden="true" />
        <span className="sx-name">SINGULARITY</span>
      </span>
      <span className="sx-ver">走査甲板 · SCANNED DECK</span>
      <span className="sx-note" id="sxNote">
        CH·01 到着 — ORIENTATION
      </span>
      {/* Deliberate deviation from the source (L450-454): the original has three
          links — COMMAND ROOM and EVA-01 point at sibling one-shot HTML files
          that do not exist on the deployed site, so only REPOSITORY is kept.
          Do not "restore" the other two; they would 404. */}
      <nav className="sx-links" aria-label="Related scenes">
        <a href="https://github.com/SamTeong/singularity">REPOSITORY ↗</a>
      </nav>
    </header>
  );
}
