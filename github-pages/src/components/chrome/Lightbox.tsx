// The pipeline gallery's artefact viewer. Transcribed from
// docs/one-shot/slides/index.html L696-714 (markup) and L932-998 (behaviour).
//
// Mounted as app-level chrome, a sibling of <Deck/>, NOT inside the pipeline
// chapter where the source puts it. `position:fixed` resolves against the
// nearest transformed ancestor, and every chapter is inside a CSS3D subtree
// that is transformed every frame — an in-chapter lightbox would be painted
// into the panel at ~0.004 scale and rotated with it. See deck/lightbox.ts.
import { useEffect, useRef } from 'react';
import { PIPELINE_STEPS } from '../../deck/pipelineData';
import { useLightbox, closeLightbox, stepLightbox } from '../../deck/lightbox';

export function Lightbox() {
  const { open, step: stepIndex, item: itemIndex } = useLightbox();
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const step = PIPELINE_STEPS[stepIndex];
  const item = step?.items[itemIndex];

  // Source L993-998 — Escape closes, arrows browse. Bound to the document
  // rather than the dialog: focus can legitimately be inside the <iframe>,
  // where a React onKeyDown on the wrapper would never fire.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeLightbox();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        stepLightbox(1);
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        stepLightbox(-1);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  // Source L944: focus lands on CLOSE, so the dialog is immediately dismissible
  // from the keyboard and the tab ring starts inside it.
  useEffect(() => {
    if (open) closeRef.current?.focus();
  }, [open]);

  // Unmounted while closed rather than hidden: that is what stops a playing
  // <video> and unloads the <iframe>, which is the whole job of the source's
  // `lbBody.innerHTML = ""` on close (L950).
  if (!open || !item) return null;

  const count = step.items.length;

  return (
    <div
      className="lb"
      role="dialog"
      aria-modal="true"
      aria-label="Reference viewer"
      onClick={(e) => {
        if (e.target === e.currentTarget) closeLightbox();
      }}
    >
      <div className="lb-frame">
        <div className="lb-head">
          <span className="jp">{step.jp}</span>
          <h2>{item.label}</h2>
          <span className="lb-path">{item.src}</span>
          <span className="stamp c-amber">
            {itemIndex + 1} / {count}
          </span>
        </div>

        <div className="lb-body">
          {item.kind === 'video' ? (
            <video
              // Keyed by src so switching clips remounts the element instead of
              // leaving the previous one's decoded buffer and currentTime.
              key={item.src}
              src={item.src}
              autoPlay
              loop
              muted
              playsInline
              controls
              // Source L971 — open on the frame the thumbnail was cut from,
              // then let it loop the whole clip.
              onLoadedMetadata={(e) => {
                if (item.at) e.currentTarget.currentTime = item.at;
              }}
            />
          ) : (
            <iframe key={item.src} src={item.src} title={item.label} />
          )}
        </div>

        <div className="lb-foot">
          <button className="lb-btn" type="button" onClick={() => stepLightbox(-1)} disabled={count < 2}>
            ‹ PREV
          </button>
          <button className="lb-btn" type="button" onClick={() => stepLightbox(1)} disabled={count < 2}>
            NEXT ›
          </button>
          <span className="lb-spacer" />
          <span>ESC TO CLOSE · ← → TO BROWSE</span>
          <a className="lb-btn hot" href={item.src} target="_blank" rel="noopener">
            OPEN DIRECTLY ↗
          </a>
          <button className="lb-btn" type="button" ref={closeRef} onClick={closeLightbox}>
            CLOSE ✕
          </button>
        </div>
      </div>
    </div>
  );
}
