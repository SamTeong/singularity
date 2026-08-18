// Transcribed from docs/one-shot/slides/index.html, section #spec (L604-666)
// plus the ledger it builds at L909-929.
//
// Section class is `.openspec`, not the source's `.spec`. In the source `.spec`
// is declared twice — once as the section (L302) and once as the key/value
// table inside a theme card (L198) — so the section silently inherits
// `margin-top:17px;border-top:1px dotted` from the table rule. That collision
// is not reproduced: the section is `.openspec` here and the table is
// `.tc-spec` in Themes.tsx.
import type { ReactNode } from 'react';
import type { ChapterProps } from './types';

interface Artifact {
  glyph: string;
  file: string;
  kind: string;
  body: ReactNode;
  /** The one currently being worked. */
  now?: boolean;
}

const ARTIFACTS: readonly Artifact[] = [
  { glyph: '提', file: 'proposal.md', kind: 'why', body: <>What’s broken, and <b>what will change.</b></> },
  { glyph: '設', file: 'design.md', kind: 'how', body: <>The decisions, <b>settled before the diff.</b></> },
  { glyph: '仕', file: 'specs/…/spec.md', kind: 'what', body: <>The behaviour, as <b>checkable requirements.</b></> },
  {
    glyph: '任',
    file: 'tasks.md',
    kind: 'the work',
    body: <>Ordered checkboxes. <b>Stop anytime, resume anywhere.</b></>,
    now: true,
  },
];

/** Source L913-922 — transcribed from
 *  openspec/changes/archive/2026-08-11-implement-phosphor-theme/tasks.md.
 *  Eight groups, 46 tasks, all closed. One fixed-width tick per task, so a
 *  longer bar genuinely means more work. */
const GROUPS: readonly (readonly [string, string, number])[] = [
  ['1', 'Theme contract and semantic foundation', 6],
  ['2', 'Skin-neutral shared presentation primitives', 5],
  ['3', 'Phosphor application frame and masthead', 5],
  ['4', 'Sidebar and overflow navigation', 5],
  ['5', 'Tasks board and task dossier', 6],
  ['6', 'Session dock, terminal, and transcripts', 7],
  ['7', 'Cross-view quality audit', 6],
  ['8', 'Automated and visual verification', 6],
];

const TOTAL = GROUPS.reduce((n, [, , count]) => n + count, 0);

export function OpenSpec({ sectionRef }: ChapterProps) {
  // className/id are constant literals and this section never receives a
  // `style` prop — see the PANEL DOM CONTRACT at the top of Beat.tsx.
  return (
    <section className="chapter openspec" id="openspec" aria-labelledby="openspec-title" ref={sectionRef}>
      <div className="chapter-inner">
        <div className="eyebrow">
          <span className="jp">仕様</span>ONE-SHOT → SPEC → SHIPPED
        </div>
        <div className="section-head">
          <span className="idx">10</span>
          <span className="jp">仕様</span>
          <h2 id="openspec-title">OPENSPEC SHIPS THE ONE-SHOT</h2>
        </div>
        <p className="lead">
          A one-shot is a picture of the idea — one afternoon, one file. Landing it in the app is a different job:{' '}
          <strong>many files, many sittings, and it has to be checked.</strong> OpenSpec writes that down before the
          code.
        </p>

        <div className="os-grid">
          <div>
            <div className="os-artifacts">
              {ARTIFACTS.map((a) => (
                <article className={`os-artifact${a.now ? ' now' : ''}`} key={a.file}>
                  <span className="os-glyph" aria-hidden="true">
                    {a.glyph}
                  </span>
                  <div>
                    <div className="os-f">
                      {a.file}
                      <small>{a.kind}</small>
                    </div>
                    <p>{a.body}</p>
                  </div>
                </article>
              ))}
            </div>
            <p className="os-kicker">
              This one is real, and archived: <b>{TOTAL} tasks · {GROUPS.length} groups · 2 spec deltas</b>. Twelve of
              them are audit and verification — and the final task is a side-by-side against{' '}
              <b>the one-shot that started it.</b>
            </p>
          </div>

          <div>
            <div className="os-ledger">
              <div className="os-ledger-inner">
                <div className="os-ledger-head">
                  <span className="jp" aria-hidden="true">
                    任
                  </span>
                  <span className="os-t">
                    IMPLEMENT-PHOSPHOR-THEME
                    <small>openspec/changes/archive/2026-08-11 · tasks.md</small>
                  </span>
                  <span className="stamp c-mint">
                    {TOTAL} / {TOTAL}
                  </span>
                </div>
                <div className="os-ledger-body">
                  {GROUPS.map(([n, name, count]) => (
                    <div className="os-grp" key={n}>
                      <span className="os-tick" aria-hidden="true">
                        ✓
                      </span>
                      <span className="os-name">
                        <b>{n}.</b>
                        {name}
                      </span>
                      <span className="os-segments" aria-hidden="true">
                        {Array.from({ length: count }, (_, i) => (
                          <i key={i} />
                        ))}
                      </span>
                      <span className="os-n">
                        {count}/{count}
                      </span>
                    </div>
                  ))}
                </div>
                <div className="os-ledger-foot">
                  <span className="os-good">◉ ARCHIVED · ALL GROUPS CLOSED</span>
                  <span>
                    {GROUPS.length} GROUPS · {TOTAL} TASKS
                  </span>
                  <span className="os-spacer" />
                  <span>0 REMAINING</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
