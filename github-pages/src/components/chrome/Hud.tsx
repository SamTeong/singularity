// Transcribed from docs/one-shot/3d/sample-gitlab-3d-scan.html, source lines
// 460-468 (Hud) and line 479 (ScrollHint).
export function Hud() {
  return (
    <div className="sx-hud" aria-hidden="true">
      <span className="sx-corner tl" />
      <span className="sx-corner tr" />
      <span className="sx-corner bl" />
      <span className="sx-corner br" />
      <span className="sx-scan" />
      <div className="sx-beat">
        <div className="idx">
          <b id="sxBeatNum">01</b>
          <span className="jp" id="sxBeatJp">
            到着
          </span>
          <span id="sxBeatCode">SCR·01</span>
        </div>
        <h2 id="sxBeatTitle">ORIENTATION</h2>
        <p id="sxBeatSub">SCROLL TO ADVANCE THE WALKTHROUGH</p>
      </div>
    </div>
  );
}

export function ScrollHint() {
  return (
    <p className="sx-hint" aria-hidden="true">
      SCROLL TO TRAVEL · CAMERA ON RAILS
    </p>
  );
}
