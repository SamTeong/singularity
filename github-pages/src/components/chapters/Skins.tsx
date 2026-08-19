// Reworked from the original transcription of docs/one-shot/slides/index.html,
// section #system (L490-515), which showed three equal argument cards. The
// business point this slide has to make is narrower than that: ZAPAC and
// Phosphor are not two products, they are one component system proven twice —
// so the slide is a left-to-right proof rather than three peers. Read it in one
// pass: 01 no system → 02 ZAPAC → 03 Phosphor → the conclusion on the right.
//
// LAYOUT — why the three stages live inside one framed rig rather than sitting
// loose in a five-column grid (which is what the first pass did, and it read as
// four unrelated things floating in a large dark field):
//
//   .sp-rig       one bevelled console frame, the same device vocabulary as
//                 `.architecture` in system-design and `.console` in
//                 fleet-control. It is what makes 01/02/03 read as ONE
//                 experiment with three renders — the border is the argument.
//   .sp-stages    the three stages as cells of that frame, divided by its own
//                 internal rules, all three viewports stretched to one height so
//                 the row reads as a row and not three ragged columns.
//   .sp-claim     outside the frame, to the right: the business conclusion is a
//                 statement ABOUT the evidence, not another piece of it.
//
// COPY IS DELIBERATELY THIN. This is a slide read in about five seconds from
// across a room, so each element gets one label and no second sentence — the
// mini-app text is interface furniture, not reading matter. Earlier passes
// also carried per-stage footnotes, a pivot list between 02/03, token specs on
// every fragment, a rig-head meta block and a duplicate kicker sub-line — all
// of it said again what the diagram already showed. If something here needs
// explaining in a sentence, the diagram is wrong; fix the diagram.
//
// Every child class is prefixed `sp-` (skins-proof) and scoped under `.skins`,
// the same collision-avoidance the `themes` chapter uses for its own
// generic-sounding names (see the note at the top of themes.css) — bare
// `.num`/`.stage`/`.mini` all mean, or could mean, something unrelated
// elsewhere in the deck.
import type { ChapterProps } from './types';

/** 01's fragments: four UI pieces that agree on nothing. Each carries its own
 *  font stack, radius, colour and rotation from CSS — the clash IS the point,
 *  so they are positioned by class (`f1`-`f4`) like the reference sprawl's
 *  chaos-cards rather than flowed. */
const FRAGMENTS = ['BUTTON', 'Card', 'NAV', 'form'] as const;

const TOKEN_AXES = ['COLOR', 'TYPE', 'SPACING', 'RADIUS', 'EFFECTS'] as const;

/** Identical markup for both skins — that repetition IS the argument. Only
 *  `variant` changes, and it changes nothing but which custom properties, type
 *  stack and radii the card resolves to (see .sp-mini.zapac / .phosphor in
 *  skins.css). Decorative, hence aria-hidden: the stage header carries the
 *  content. */
function MiniApp({ variant, label }: { variant: 'zapac' | 'phosphor'; label: string }) {
  return (
    <div className={`sp-mini ${variant}`} aria-hidden="true">
      <div className="sp-mini-head">
        <span className="sp-mini-dots">
          <i />
          <i />
          <i />
        </span>
        <span className="sp-mini-label">{label}</span>
      </div>
      <div className="sp-mini-nav">
        <span className="on">Overview</span>
        <span>Tasks</span>
      </div>
      <div className="sp-mini-body">
        <div className="sp-mini-stat">
          <span className="sp-mini-k">Active agents</span>
          <b>12</b>
        </div>
        <span className="sp-mini-bar">
          <i className="on" />
          <i className="on" />
          <i className="on" />
          <i />
          <i />
        </span>
        <div className="sp-mini-row">
          <span>Task 118</span>
          <em>Running</em>
        </div>
      </div>
      <span className="sp-mini-btn">Add tasks</span>
    </div>
  );
}

export function Skins({ sectionRef }: ChapterProps) {
  // className/id are constant literals and this section never receives a
  // `style` prop — the world adds `.as-panel` to classList and writes
  // width/height/display/opacity on this node every frame. See the PANEL DOM
  // CONTRACT at the top of Spacer.tsx.
  return (
    <section className="chapter skins" id="skins" aria-label="One system, two skins" ref={sectionRef}>
      <div className="chapter-inner">
        <div className="eyebrow">
          <span className="jp">乱 → 意匠 → 燐光</span>ONE SYSTEM, PROVEN TWICE
        </div>
        <div className="sp-grid">
          <div className="sp-rig" aria-label="One component system rendered three ways" role="group">
            <div className="sp-rig-head">
              <span className="sp-rig-mono jp" aria-hidden="true">
                証
              </span>
              <span className="sp-rig-title">ONE SYSTEM, TWO SKINS</span>
            </div>

            <div className="sp-stages">
              <div className="sp-stage sp-stage-broken">
                <div className="sp-stage-head">
                  <span className="sp-num">01</span>
                  <span className="jp" aria-hidden="true">
                    乱
                  </span>
                  <b>NO SYSTEM</b>
                </div>
                <div className="sp-sprawl" aria-hidden="true">
                  {FRAGMENTS.map((label, i) => (
                    <span className={`sp-frag f${i + 1}`} key={label}>
                      {label}
                    </span>
                  ))}
                  <span className="sp-hazard" />
                </div>
              </div>

              <div className="sp-stage">
                <div className="sp-stage-head">
                  <span className="sp-num">02</span>
                  <span className="jp" aria-hidden="true">
                    意匠
                  </span>
                  <b>ZAPAC</b>
                </div>
                <MiniApp variant="zapac" label="ZAPAC" />
              </div>

              <div className="sp-stage">
                <div className="sp-stage-head">
                  <span className="sp-num">03</span>
                  <span className="jp" aria-hidden="true">
                    燐光
                  </span>
                  <b>PHOSPHOR</b>
                </div>
                <MiniApp variant="phosphor" label="PHOSPHOR" />
              </div>
            </div>
          </div>

          <div className="sp-claim">
            <div className="sp-claim-tag">
              <span className="stamp c-orange">CONCLUSION</span>
              <span className="jp" aria-hidden="true">
                結論
              </span>
            </div>
            <h3 className="display">
              IF WE CAN <span className="orange">SKIN THIS</span>
              <br />
              WE CAN SKIN <span className="mint">YOURS.</span>
            </h3>
            <p className="sp-tagline">SWAP THE DESIGN TOKENS. KEEP THE SYSTEM.</p>

            <div className="sp-pipe" aria-label="Your design tokens applied to the same system" role="img">
              <div className="sp-pipe-box sp-pipe-in">
                <span className="jp" aria-hidden="true">
                  貴社
                </span>
                <b>YOUR DESIGN TOKENS</b>
                <div className="sp-pipe-axes">
                  {TOKEN_AXES.map((axis) => (
                    <span key={axis}>{axis}</span>
                  ))}
                </div>
              </div>
              <span className="sp-pipe-link" />
              <div className="sp-pipe-box sp-pipe-out">
                <b>SAME SYSTEM</b>
                <small>NO APPLICATION REWRITE</small>
              </div>
            </div>
          </div>
        </div>

        <p className="skin-kicker">
          <b>ZAPAC</b> proves consistency. <b>PHOSPHOR</b> proves adaptability.
        </p>
      </div>
    </section>
  );
}
