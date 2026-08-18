// Two reserved screens after the CTA. Not transcribed from anything — they are
// placeholders, deliberately built as real structure with the content left out,
// so that filling one in later is an ordinary React edit inside AppendixBody's
// caller and needs no ledger, camera or CSS change.
//
// PANEL DOM CONTRACT: each appendix is its own component with its own literal
// className/id (invariants I3/I4) rather than one parameterised component
// rendering a computed className — the world writes `.as-panel` into that
// class list every frame, and a React-driven className rewrite would silently
// drop it. Everything BELOW the <section> is shared freely (invariant I7),
// which is what AppendixBody is.
import type { ChapterProps } from './types';

interface Slot {
  key: string;
  hint: string;
}

const SLOTS: readonly Slot[] = [
  { key: 'FIGURE', hint: 'DIAGRAM · TABLE · SCREENSHOT' },
  { key: 'DETAIL', hint: 'THE LONG VERSION OF A DECK CLAIM' },
  { key: 'SOURCE', hint: 'LINK OUT · REPO PATH · TICKET' },
];

interface BodyProps {
  num: string;
  jp: string;
  label: string;
  titleId: string;
  /** One line saying what this appendix is being held for. */
  reservedFor: string;
}

function AppendixBody({ num, jp, label, titleId, reservedFor }: BodyProps) {
  return (
    <div className="chapter-inner">
      <div className="eyebrow">
        <span className="jp">{jp}</span>RESERVED SCREEN · NOT YET WRITTEN
      </div>
      <div className="section-head">
        <span className="idx">{num}</span>
        <span className="jp">{jp}</span>
        <h2 id={titleId}>{label}</h2>
      </div>

      <div className="ax-grid">
        <div>
          <p className="lead">
            This screen is held open for <strong>{reservedFor}</strong>. It tours with the rest of the deck and is
            framed by the camera exactly like a finished chapter — only the content is outstanding.
          </p>
          <div className="ax-slots">
            {SLOTS.map((slot) => (
              <div className="ax-slot" key={slot.key}>
                <span className="ax-key">{slot.key}</span>
                <span className="ax-hint">{slot.hint}</span>
                <span className="stamp c-blue">EMPTY</span>
              </div>
            ))}
          </div>
        </div>

        <div className="ax-plate" role="img" aria-label={`${label} — reserved, no content yet`}>
          <div className="ax-plate-inner">
            <span className="ax-plate-jp" aria-hidden="true">
              {jp}
            </span>
            <span className="ax-plate-num" aria-hidden="true">
              {num}
            </span>
          </div>
          <span className="ax-plate-cap">CONTENT PENDING</span>
        </div>
      </div>

      <div className="ax-foot">
        <span className="ax-good">◉ SLOT REGISTERED</span>
        <span>SCREEN {num} OF 13</span>
        <span className="ax-spacer" />
        <span>EDIT src/components/chapters/Appendix.tsx</span>
      </div>
    </div>
  );
}

export function AppendixA({ sectionRef }: ChapterProps) {
  return (
    <section className="chapter appendix appendix-a" id="appendix-a" aria-labelledby="appendix-a-title" ref={sectionRef}>
      <AppendixBody
        num="12"
        jp="附録"
        label="APPENDIX A"
        titleId="appendix-a-title"
        reservedFor="the working detail behind the pipeline — the experiments that were thrown away, and why"
      />
    </section>
  );
}

export function AppendixB({ sectionRef }: ChapterProps) {
  return (
    <section className="chapter appendix appendix-b" id="appendix-b" aria-labelledby="appendix-b-title" ref={sectionRef}>
      <AppendixBody
        num="13"
        jp="補遺"
        label="APPENDIX B"
        titleId="appendix-b-title"
        reservedFor="everything that arrived after the debrief was given — corrections, follow-ups, and what shipped next"
      />
    </section>
  );
}
