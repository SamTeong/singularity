import { useState } from 'react';
import type { ChapterProps } from './types';

const PORTRAITS = `${import.meta.env.BASE_URL}refs/thumbs/`;

interface Developer {
  name: string;
  contribution: string;
  href: string;
  portrait: string;
  index: string;
}

const DEVELOPERS: readonly Developer[] = [
  {
    name: 'SAM TEONG',
    contribution: 'DESIGN · ENGINEERING · SHIP',
    href: 'https://www.linkedin.com/in/sam-teong/',
    portrait: `${PORTRAITS}dev-sam-teong.jpg`,
    index: '01',
  },
  {
    name: 'JAIRUS ARAGON',
    contribution: 'UI DESIGN · UX',
    href: 'https://www.linkedin.com/in/aragonjairus/',
    portrait: `${PORTRAITS}dev-jairus-aragon.jpg`,
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

function DeveloperPortrait({ developer }: { developer: Developer }) {
  const [failed, setFailed] = useState(false);

  return (
    <a className="devby-portrait" href={developer.href} target="_blank" rel="noopener noreferrer">
      {failed ? (
        <span className="devby-plate" aria-hidden="true">
          {developer.name}
        </span>
      ) : (
        <img src={developer.portrait} alt={developer.name} loading="lazy" onError={() => setFailed(true)} />
      )}
      <span className="devby-index" aria-hidden="true">
        DEV·{developer.index}
      </span>
    </a>
  );
}

export function DevelopedBy({ sectionRef }: ChapterProps) {
  return (
    // className/id are constant literals and this section never receives a
    // `style` prop — Phase 4 adds `.as-panel` to classList and writes
    // width/height/display/opacity directly on this node every frame.
    <section className="chapter developed-by" id="developed-by" aria-labelledby="developed-by-title" ref={sectionRef}>
      <div className="chapter-inner">
        <div className="section-head">
          <span className="idx">12</span>
          <span className="jp">開発</span>
          <h2 id="developed-by-title">DEVELOPED BY</h2>
        </div>
        <p className="lead">Two people, one repo, nights and weekends. Singularity was designed, built and shipped by:</p>
        <div className="devby-lineup">
          {DEVELOPERS.map((developer) => (
            <article className="devby-person" key={developer.name}>
              <DeveloperPortrait developer={developer} />
              <div className="devby-record">
                <span>DEVELOPER</span>
                <h3>{developer.name}</h3>
                <p>{developer.contribution}</p>
                <a className="devby-source-link" href={developer.href} target="_blank" rel="noopener noreferrer">
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
