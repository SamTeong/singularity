// Transcribed from docs/one-shot/slides/index.html, section #skill (L541-602)
// plus its teletypes at L803-841.
//
// Section class is `.themes`, not the source's `.skill` — `.skill` reads as a
// singular thing and this chapter is the pair. All rules are scoped under
// `.themes` in styles/chapters/themes.css.
//
// The terminal rows reuse `.term-row` / `.prompt` / `.term-cursor` from
// cockpit.css rather than redeclaring them: the source's two stylesheets
// declare those three classes identically (amber on a dotted amber panel), so
// a second copy here would be a silent duplicate waiting to drift.
import { useState } from 'react';
import type { ChapterProps } from './types';
import { useThemeTerminal } from '../../deck/useThemeTerminals';
import type { ThemeTerminalId } from '../../deck/useThemeTerminals';

const SHOTS = `${import.meta.env.BASE_URL}refs/thumbs/`;

interface ThemeCard {
  id: ThemeTerminalId;
  /** `phos` swaps the card's accent from orange to mint. */
  variant: '' | 'phos';
  name: string;
  jp: string;
  glyph: string;
  filled: boolean;
  desc: string;
  href: string;
  host: string;
  shot: string;
  shotAlt: string;
  theme: { lead: string; rest: string };
  skill: string;
  cta: string;
  ctaAlt: boolean;
}

const CARDS: readonly ThemeCard[] = [
  {
    id: 'zapac',
    variant: '',
    name: 'ZAPAC',
    jp: '意匠',
    glyph: '',
    filled: false,
    desc: 'Glass-over-gradient on the Zühlke purple→cyan identity.',
    href: 'https://agentic-zuhlke.pages.codehub.zuehlke.com/zapac-material-ui/',
    host: 'agentic-zuhlke.pages.codehub.zuehlke.com',
    shot: `${SHOTS}theme-zapac.jpg`,
    shotAlt: 'ZAPAC design system — component previews landing page',
    theme: { lead: 'ZAPAC MUI theme', rest: ' — brand tokens, light + dark' },
    skill: '/zapac-material-ui',
    cta: 'VIEW ZAPAC ↗',
    ctaAlt: false,
  },
  {
    id: 'phosphor',
    variant: 'phos',
    name: 'Phosphor Console',
    jp: '燐光',
    glyph: '✓',
    filled: true,
    desc: 'NERV/MAGI tactical CRT command deck',
    href: 'https://shocknawe.github.io/evangelion-mui-theme/',
    host: 'shocknawe.github.io/evangelion-mui-theme',
    shot: `${SHOTS}theme-phosphor.jpg`,
    shotAlt: 'Phosphor Console design system — component previews landing page',
    theme: { lead: 'Evangelion MUI theme', rest: ' — dark-only, scanlines' },
    skill: '/evangelion-mui-theme',
    cta: 'VIEW PHOSPHOR ↗',
    ctaAlt: true,
  },
];

/** Same fallback contract as the pipeline gallery: public/refs is produced by
 *  scripts/copy-model.mjs, and a checkout without it shows a plate, never a
 *  broken-image glyph. */
function Shot({ card }: { card: ThemeCard }) {
  const [failed, setFailed] = useState(false);
  return (
    <a className="tc-shot" href={card.href} target="_blank" rel="noopener">
      {failed ? (
        <span className="tc-plate" aria-hidden="true">
          {card.name.toUpperCase()}
        </span>
      ) : (
        <img src={card.shot} alt={card.shotAlt} loading="lazy" onError={() => setFailed(true)} />
      )}
      <span className="tc-peek">COMPONENTS ↗</span>
    </a>
  );
}

function Terminal({ id, label }: { id: ThemeTerminalId; label: string }) {
  const { text, cursor } = useThemeTerminal(id);
  return (
    <div className="tc-term" aria-label={label}>
      <div className="tc-term-head">
        CHAT
        <span className="tc-dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
      </div>
      <div className="tc-term-body" aria-live="polite">
        <div className="term-row ">
          <span className="prompt">›</span>
          <span>{text}</span>
          {cursor && <span className="term-cursor" style={{ marginTop: '2px' }} />}
        </div>
      </div>
    </div>
  );
}

function Card({ card }: { card: ThemeCard }) {
  return (
    <section className={`tc-card ${card.variant}`.trimEnd()} aria-label={`${card.name} theme and skill`}>
      <div className="tc-head">
        <span className={`tc-glyph${card.filled ? ' filled' : ''}`} aria-hidden="true">
          {card.glyph}
        </span>
        <h3>{card.name}</h3>
        <span className="tc-jp" aria-hidden="true">
          {card.jp}
        </span>
      </div>
      <p className="tc-desc">{card.desc}</p>

      <Shot card={card} />

      {/* <div className="tc-spec">
        <div className="tc-row">
          <span className="tc-k">Theme</span>
          <span className="tc-v">
            <b>{card.theme.lead}</b>
            {card.theme.rest}
          </span>
        </div>
        <div className="tc-row">
          <span className="tc-k">Skill</span>
          <span className="tc-v">
            <code>{card.skill}</code>
          </span>
        </div>
      </div> */}

      <Terminal id={card.id} label={`${card.name} skill in use`} />

      <div className="tc-cta">
        <a className={`btn${card.ctaAlt ? ' alt' : ''}`} href={card.href} target="_blank" rel="noopener">
          {card.cta}
        </a>
        <span className="tc-host">{card.host}</span>
      </div>
    </section>
  );
}

export function Themes({ sectionRef }: ChapterProps) {
  // className/id are constant literals and this section never receives a
  // `style` prop — see the PANEL DOM CONTRACT at the top of Beat.tsx.
  return (
    <section className="chapter themes" id="themes" aria-labelledby="themes-title" ref={sectionRef}>
      <div className="chapter-inner">
        <div className="eyebrow">
          <span className="jp">技能</span>TEACH IT ONCE, NOT EVERY PROMPT
        </div>
        <div className="section-head">
          <span className="idx">09</span>
          <span className="jp">技能</span>
          <h2 id="themes-title">TWO THEMES, TWO SKILLS</h2>
        </div>
        <p className="lead">
          We used <strong>two theme specific AI skills</strong> to skin the system — so staying on-brand stops taking effort. Both theme ship this way: run the skill, and the
          agent already knows the component library.
        </p>

        {/* Source `.duo` is `1fr auto 1fr` with the rule as a real middle grid
            item, so the divider stretches to whichever column is taller. Kept
            literally rather than faked with a ::before on the second card. */}
        <div className="tc-duo">
          <Card card={CARDS[0]} />
          <div className="tc-divider" aria-hidden="true" />
          <Card card={CARDS[1]} />
        </div>
      </div>
    </section>
  );
}
