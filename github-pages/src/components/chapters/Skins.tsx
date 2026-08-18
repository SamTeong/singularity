// Transcribed from docs/one-shot/slides/index.html, section #system (L490-515).
//
// The source class for a beat card is `.beat`, which is already taken here:
// `.beat` is the conductor's own scroll-wrapper div (Beat.tsx), and
// `body.mode-3d .beat{pointer-events:none}` would make every card inert in 3D.
// Renamed to `.skin-card` throughout, and every rule in styles/chapters/skins.css
// is scoped under `.skins` so nothing else can collide either.
import type { ReactNode } from 'react';
import type { ChapterProps } from './types';

interface Argument {
  tone: '' | 'warm' | 'cool';
  num: string;
  jp: string;
  title: string;
  body: ReactNode;
}

/** Three beats, read left to right — the order IS the argument, which is why
 *  the eyebrow spells it out (乱 chaos → 意匠 design → 燐光 phosphor). */
const ARGUMENT: readonly Argument[] = [
  {
    tone: 'warm',
    num: '01',
    jp: '乱',
    title: 'DESIGN SYSTEMS FIRST',
    body: (
      <>
        Ten screens, ten different looks. <b>Different fonts, different buttons, different everything.</b> it’s just
        what happens when there’s no design system.
      </>
    ),
  },
  {
    tone: '',
    num: '02',
    jp: '意匠',
    title: 'ZAPAC CAME FIRST',
    body: (
      <>
        <b>One theme, on-brand, every time</b> — shipped with a skill any dev on the team can run. Being on-brand stops
        being effort and starts being the default.
      </>
    ),
  },
  {
    tone: 'cool',
    num: '03',
    jp: '燐光',
    title: 'THEN, PHOSPHOR',
    body: (
      <>
        A second skin with a CRT glow — <b>for the prototypes that get to feel nostalgic, not just correct.</b> Same
        system underneath, but a different vibe
      </>
    ),
  },
];

export function Skins({ sectionRef }: ChapterProps) {
  // className/id are constant literals and this section never receives a
  // `style` prop — the world adds `.as-panel` to classList and writes
  // width/height/display/opacity on this node every frame. See the PANEL DOM
  // CONTRACT at the top of Beat.tsx.
  return (
    <section className="chapter skins" id="skins" aria-labelledby="skins-title" ref={sectionRef}>
      <div className="chapter-inner">
        <div className="eyebrow">
          <span className="jp">乱 → 意匠 → 燐光</span>THE ORDER IS THE WHOLE POINT
        </div>
        <div className="section-head">
          <span className="idx">07</span>
          <span className="jp">体系</span>
          <h2 id="skins-title">ONE SYSTEM, TWO SKINS</h2>
        </div>

        <div className="skin-beats">
          {ARGUMENT.map((a) => (
            <article className={`skin-card ${a.tone}`.trimEnd()} key={a.num}>
              <div className="sc-head">
                <span className="sc-num">{a.num}</span>
                <span className="jp">{a.jp}</span>
              </div>
              <h3>{a.title}</h3>
              <p>{a.body}</p>
            </article>
          ))}
        </div>

        <p className="skin-kicker">
          <b>built </b>ZAPAC <b>as a default, added </b>Phosphor <b> for nostalgia</b>
        </p>
      </div>
    </section>
  );
}
