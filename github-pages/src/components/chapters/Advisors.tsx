import { useState } from 'react';
import type { ChapterProps } from './types';

const PORTRAITS = `${import.meta.env.BASE_URL}refs/thumbs/`;

interface Advisor {
  name: string;
  contribution: string;
  href: string;
  portrait: string;
  index: string;
}

const ADVISORS: readonly Advisor[] = [
  {
    name: 'KEVIN LIN',
    contribution: 'AI STEWARDSHIP · ARCHITECTURE',
    href: 'https://www.linkedin.com/in/kevinlinyun/',
    portrait: `${PORTRAITS}advisor-kevin-lin.jpg`,
    index: '01',
  },
  {
    name: 'MIN SOE ZAN',
    contribution: 'UI DESIGN',
    href: 'https://www.linkedin.com/in/minsoezan/',
    portrait: `${PORTRAITS}advisor-min-soe-zan.jpg`,
    index: '02',
  },
];

function LinkedInIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M20.45 20.45h-3.56v-5.57c0-1.33-.03-3.04-1.85-3.04-1.85 0-2.14 1.45-2.14 2.94v5.67H9.34V8.98h3.42v1.57h.05c.47-.9 1.64-1.85 3.37-1.85 3.6 0 4.27 2.37 4.27 5.46v6.29ZM5.32 7.41a2.06 2.06 0 1 1 0-4.12 2.06 2.06 0 0 1 0 4.12Zm1.78 13.04H3.54V8.98H7.1v11.47ZM22.23 0H1.77C.79 0 0 .77 0 1.72v20.56C0 23.23.79 24 1.77 24h20.46c.98 0 1.77-.77 1.77-1.72V1.72C24 .77 23.21 0 22.23 0Z" />
    </svg>
  );
}

function AdvisorPortrait({ advisor }: { advisor: Advisor }) {
  const [failed, setFailed] = useState(false);

  return (
    <a className="advisors-portrait" href={advisor.href} target="_blank" rel="noopener noreferrer">
      {failed ? (
        <span className="advisors-plate" aria-hidden="true">
          {advisor.name}
        </span>
      ) : (
        <img src={advisor.portrait} alt={advisor.name} loading="lazy" onError={() => setFailed(true)} />
      )}
      <span className="advisors-index" aria-hidden="true">
        ADV·{advisor.index}
      </span>
    </a>
  );
}

export function Advisors({ sectionRef }: ChapterProps) {
  return (
    // className/id are constant literals and this section never receives a
    // `style` prop — Phase 4 adds `.as-panel` to classList and writes
    // width/height/display/opacity directly on this node every frame.
    <section className="chapter advisors" id="advisors" aria-labelledby="advisors-title" ref={sectionRef}>
      <div className="chapter-inner">
        <div className="section-head">
          <span className="idx">16</span>
          <span className="jp">謝辞</span>
          <h2 id="advisors-title">SPECIAL THANKS</h2>
        </div>
        <p className="lead">
          Singularity also owes its shape to people willing to look at the work and say what doesn't hold up yet.
        </p>
        <div className="advisors-lineup">
          {ADVISORS.map((advisor) => (
            <article className="advisors-person" key={advisor.name}>
              <AdvisorPortrait advisor={advisor} />
              <div className="advisors-record">
                <span>ADVISOR · COUNSEL</span>
                <h3>{advisor.name}</h3>
                <p>{advisor.contribution}</p>
                <a className="advisors-source-link" href={advisor.href} target="_blank" rel="noopener noreferrer">
                  <LinkedInIcon />
                  LINKEDIN ↗
                </a>
              </div>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
