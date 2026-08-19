// Transcribed from docs/one-shot/slides/index.html, section #pipeline
// (L517-539) plus its behaviour at L843-904 (track construction, selectStep).
//
// Section class is `.phospipe`, not `.pipeline`: `.pipeline` is already a
// layout class inside the FLEET CONTROL chapter (styles/chapters/fleet-control.css
// sets `display:grid;grid-template-columns:repeat(5,1fr)` on it), and putting
// that on a <section> would blow the whole panel apart. The DOM id stays
// `pipeline`, which is what the ledger's `id` and any in-page anchor use.
//
// Stage selection is driven by the scroll conductor's step bands (see
// deck/useScrollStep.ts) — the same system fleet-control's tabs and the tasks
// flow use — with clicks and arrow keys as an override, so the chapter still
// tells its story when Chromium refuses to hit-test the CSS3D panel.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { ChapterProps } from './types';
import { PIPELINE_STEPS, PHOSPHOR_TOKENS } from '../../deck/pipelineData';
import type { DescRun, PipelineItem } from '../../deck/pipelineData';
import { useScrollStep, seekStep } from '../../deck/useScrollStep';
import { openLightbox } from '../../deck/lightbox';

/** Renders the stage blurb's [text | code] runs — the source sets this with
 *  innerHTML, which this port does not use anywhere. */
function Desc({ runs }: { runs: readonly DescRun[] }) {
  return (
    <>
      {runs.map((run, i) =>
        'code' in run ? <code key={i}>{run.code}</code> : <span key={i}>{run.text}</span>,
      )}
    </>
  );
}

/** The gallery thumbnails are copied into public/refs by scripts/copy-model.mjs.
 *  A checkout without them must not render a row of broken-image glyphs, so a
 *  failed load falls back to a captioned plate that still reads as an artefact. */
function Thumb({ item }: { item: PipelineItem }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <span className="pp-plate" aria-hidden="true">
        {item.kind === 'video' ? 'CLIP' : 'PAGE'}
      </span>
    );
  }
  return <img src={item.img} alt={`${item.label} — screenshot`} loading="lazy" onError={() => setFailed(true)} />;
}

export function Pipeline({ sectionRef }: ChapterProps) {
  // In 3D the reader's scroll position picks the stage (see useScrollStep):
  // one band of the pipeline chapter's local progress per stage. In flat mode
  // there is no conductor, so a local state fallback keeps the stage
  // click-driven exactly as before — the same shape useTabs uses for the
  // fleet-control tabs.
  const [stage, setStage] = useState(0);
  const scrollStep = useScrollStep('pipeline');
  useEffect(() => {
    if (scrollStep !== null) setStage(scrollStep);
  }, [scrollStep]);

  const step = PIPELINE_STEPS[stage];
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const select = useCallback((next: number, focus = false) => {
    // Scroll owns the stage in 3D, so a click scrolls to that stage's band and
    // the effect above applies it — setting state here too would only be
    // undone at the next band crossing. seekStep is false in flat mode.
    if (!seekStep('pipeline', next)) setStage(next);
    if (focus) tabRefs.current[next]?.focus();
  }, []);

  const onKeyDown = useCallback((event: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const last = PIPELINE_STEPS.length - 1;
    let next = -1;
    if (event.key === 'ArrowRight') next = i === last ? 0 : i + 1;
    else if (event.key === 'ArrowLeft') next = i === 0 ? last : i - 1;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = last;
    if (next < 0) return;
    event.preventDefault();
    select(next, true);
  }, [select]);

  return (
    // className/id are constant literals and this section never receives a
    // `style` prop — see the PANEL DOM CONTRACT at the top of Beat.tsx.
    <section className="chapter phospipe" id="pipeline" aria-labelledby="pipeline-title" ref={sectionRef}>
      <div className="chapter-inner">
        <div className="eyebrow">
          <span className="jp">経路</span>08 PAGES · 34 EXPERIMENTS · 23 REFERENCES
        </div>
        <div className="section-head">
          <span className="idx">08</span>
          <span className="jp">経路</span>
          <h2 id="pipeline-title">THE PHOSPHOR PIPELINE</h2>
        </div>
        <p className="lead">
          From an Evangelion mood board to a production dark theme, in five stages. Every stage below still has its
          artifacts — <strong>scroll through the stages, then open the real thing.</strong>
        </p>

        <div className="pp-track" role="tablist" aria-label="Five-stage design pipeline">
          {PIPELINE_STEPS.map((s, i) => (
            <button
              key={s.n}
              type="button"
              className="pp-step"
              // Node state is derived from the reader's position, not the
              // static `done` flag: stages already scrolled past are finished
              // (green filled), the current stage is blue, upcoming stages are
              // idle (green outline) — the same three states as the fleet
              // control automation pipeline.
              data-state={i < stage ? 'done' : i === stage ? 'now' : 'idle'}
              role="tab"
              id={`pp-tab-${s.n}`}
              aria-controls="pp-gallery"
              aria-selected={i === stage}
              tabIndex={i === stage ? 0 : -1}
              ref={(el) => {
                tabRefs.current[i] = el;
              }}
              onClick={() => select(i)}
              onKeyDown={(e) => onKeyDown(e, i)}
            >
              {s.here && <span className="stamp c-mint pp-here">YOU ARE HERE</span>}
              <span className="pp-node">{s.n}</span>
              <span className="jp">{s.jp}</span>
              <span className="pp-en">{s.title}</span>
              <span className="pp-val">
                {s.v}
                <small>{s.k}</small>
              </span>
            </button>
          ))}
        </div>

        <div className="pp-stagebar">
          <div className="pp-stagebar-inner">
            <span className="pp-stage-jp">{step.jp}</span>
            <div>
              <h3>
                {step.n} · {step.title}
              </h3>
              <p>
                <Desc runs={step.desc} />
              </p>
            </div>
            <div className="pp-hint">
              <b>CLICK A CARD</b>
              <br />
              OPENS THE LIVE ARTEFACT
            </div>
          </div>
        </div>

        <div
          className="pp-gallery"
          id="pp-gallery"
          role="tabpanel"
          aria-labelledby={`pp-tab-${step.n}`}
          aria-label="Artefacts for the selected stage"
          // The source sets the gallery's min column width inline
          // (`gallery.style.setProperty('--card', …)`). Here it is a data
          // attribute resolved in CSS instead, because panel mode has to be
          // able to override it: a panel's height is measured ONCE, so all
          // five stages must render at the same height inside it, and an
          // inline custom property would outrank any stylesheet rule trying
          // to normalise them. See `--card` in styles/chapters/pipeline.css
          // and the panel-mode block in styles/panel.css.
          data-stage={step.n}
        >
          {step.swatches ? (
            <>
              <div className="pp-younote">
                <span className="jp">主</span>
                <p>
                  You are looking at the output. <b>This page renders in the Phosphor token set</b> — same variables,
                  same CRT overlay, same chamfered frames the MUI theme ships to the Singularity UI.
                </p>
              </div>
              <div className="pp-swatches">
                {PHOSPHOR_TOKENS.map(([name, hex]) => (
                  <div className="pp-sw" key={hex}>
                    <div className="pp-chip" style={{ background: hex }} />
                    <span className="pp-sw-n">{name}</span>
                    <span className="pp-sw-h">{hex}</span>
                  </div>
                ))}
              </div>
            </>
          ) : (
            step.items.map((item, j) => (
              <button
                key={item.label}
                type="button"
                className={`pp-card${item.kind === 'video' ? ' playable' : ''}${item.wide ? ' wide' : ''}`}
                onClick={() => openLightbox(stage, j)}
              >
                <span className="pp-shot">
                  <span className={`pp-badge ${item.kind === 'video' ? 'c-amber' : 'c-mint'}`}>{item.tag}</span>
                  <Thumb item={item} />
                </span>
                <span className="pp-cap">
                  <b>{item.label}</b>
                  <span className="pp-open">{item.kind === 'video' ? 'PLAY ›' : 'OPEN ›'}</span>
                </span>
              </button>
            ))
          )}
        </div>
      </div>
    </section>
  );
}
