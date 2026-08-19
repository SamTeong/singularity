// Reworked from the original transcription of docs/one-shot/slides/index.html,
// section #system (L490-515), which showed three equal argument cards. The
// business point this slide has to make is narrower than that: ZAPAC and
// Phosphor are not two products, they are one component system proven twice —
// so the slide is now a left-to-right proof rather than three peers. Read it
// in one pass: 01 no system → 02 ZAPAC → (same components, different tokens)
// → 03 Phosphor → the business conclusion.
//
// Every child class below is prefixed `sp-` (skins-proof) and scoped under
// `.skins`, the same collision-avoidance the `themes` chapter uses for its
// own generic-sounding names (see the note at the top of themes.css) — bare
// `.num`/`.divider`/`.arrow` all mean something unrelated elsewhere in the deck.
import type { ChapterProps } from './types';

const FRAGMENTS = [
  { label: 'BTN', tone: 'red' },
  { label: 'CARD', tone: 'blue' },
  { label: 'NAV', tone: 'amber' },
  { label: 'FORM', tone: 'teal' },
] as const;

const PIVOT = ['SAME COMPONENTS', 'SAME BEHAVIOUR', 'DIFFERENT TOKENS'] as const;

const TOKEN_AXES = 'COLOR · TYPE · SPACING · RADIUS · EFFECTS';

/** Identical markup for both skins — that repetition IS the argument. Only
 *  `variant` changes, and it changes nothing but which CSS custom properties
 *  and type stack the card resolves to (see .sp-mini.zapac / .phosphor in
 *  skins.css). Decorative: the real content is the caption below each card. */
function MiniApp({ variant, label }: { variant: 'zapac' | 'phosphor'; label: string }) {
  return (
    <div className={`sp-mini ${variant}`} aria-hidden="true">
      <div className="sp-mini-head">
        <span className="sp-mini-dot" />
        <span className="sp-mini-dot" />
        <span className="sp-mini-dot" />
        <span className="sp-mini-label">{label}</span>
      </div>
      <div className="sp-mini-nav">
        <span>Overview</span>
        <span>Tasks</span>
        <span>Usage</span>
      </div>
      <div className="sp-mini-stat">
        <span>ACTIVE AGENTS</span>
        <b>12</b>
      </div>
      <span className="sp-mini-btn">RUN SKILL</span>
    </div>
  );
}

export function Skins({ sectionRef }: ChapterProps) {
  // className/id are constant literals and this section never receives a
  // `style` prop — the world adds `.as-panel` to classList and writes
  // width/height/display/opacity on this node every frame. See the PANEL DOM
  // CONTRACT at the top of Spacer.tsx.
  return (
    <section className="chapter skins" id="skins" aria-labelledby="skins-title" ref={sectionRef}>
      <div className="chapter-inner">
        <div className="eyebrow">
          <span className="jp">乱 → 意匠 → 燐光</span>ONE SYSTEM, PROVEN TWICE
        </div>
        <div className="section-head">
          <span className="idx">07</span>
          <span className="jp">体系</span>
          <h2 id="skins-title">ONE SYSTEM, TWO SKINS</h2>
        </div>

        <div className="skins-proof">
          <div className="sp-col">
            <div className="sp-tag">
              <span className="sp-num">01</span>
              <span className="jp">乱</span>
            </div>
            <div className="sp-frag" aria-hidden="true">
              {FRAGMENTS.map((f) => (
                <span className={`sp-chip ${f.tone}`} key={f.label}>
                  {f.label}
                </span>
              ))}
            </div>
            <p className="sp-caption">WITHOUT A SYSTEM</p>
          </div>

          <div className="sp-col">
            <div className="sp-tag">
              <span className="sp-num">02</span>
              <span className="jp">意匠</span>
            </div>
            <MiniApp variant="zapac" label="ZAPAC" />
            <p className="sp-caption">THE DEFAULT</p>
          </div>

          <div className="sp-arrow" aria-hidden="true">
            <span className="sp-arrow-glyph">→</span>
            <ul>
              {PIVOT.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>

          <div className="sp-col">
            <div className="sp-tag">
              <span className="sp-num">03</span>
              <span className="jp">燐光</span>
            </div>
            <MiniApp variant="phosphor" label="PHOSPHOR" />
            <p className="sp-caption">THE STRESS TEST</p>
          </div>

          <div className="sp-claim">
            <h3 className="display">
              IF WE CAN
              <br />
              <span className="orange">SKIN THIS,</span>
              <br />
              WE CAN SKIN
              <br />
              <span className="mint">YOURS.</span>
            </h3>
            <p className="sp-tagline">Swap the design tokens. Keep the system.</p>
            <div className="sp-flow">
              <span>YOUR DESIGN TOKENS</span>
              <span className="sp-flow-arrow">↓</span>
              <span className="sp-flow-tokens">{TOKEN_AXES}</span>
              <span className="sp-flow-arrow">↓</span>
              <span>SAME COMPONENT SYSTEM</span>
            </div>
          </div>
        </div>

        <p className="skin-kicker">
          <b>ZAPAC</b> proves consistency. <b>PHOSPHOR</b> proves adaptability.
          <span className="skin-kicker-sub">same components // different tokens</span>
        </p>
      </div>
    </section>
  );
}
