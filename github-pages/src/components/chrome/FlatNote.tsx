// Transcribed from docs/one-shot/3d/sample-gitlab-3d-scan.html, source line 495,
// plus the narrow-viewport copy override the source applies via innerHTML at
// L1661. Rendered as JSX rather than dangerouslySetInnerHTML.
//
// Visibility is the flat-mode signal: hidden by default in the markup, unhidden
// by fail() at L807.

interface FlatNoteProps {
  visible: boolean;
  /** 'narrow' is the ≤900px gate (source L1656-1661), which is a deliberate
   *  composition choice rather than a failure — hence its own wording. */
  variant: 'default' | 'narrow';
}

export function FlatNote({ visible, variant }: FlatNoteProps) {
  return (
    <p className="sx-flat-note" id="sxFlatNote" hidden={!visible}>
      {variant === 'narrow' ? (
        <>
          FLAT MODE · <b>THE 3D WALKTHROUGH NEEDS A WIDER VIEWPORT</b> — SERVING THE DECK AS A STANDARD PAGE
        </>
      ) : (
        <>
          FLAT MODE · <b>3D WALKTHROUGH UNAVAILABLE</b> — SERVING THE DECK AS A STANDARD PAGE
        </>
      )}
    </p>
  );
}
