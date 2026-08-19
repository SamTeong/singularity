import { useState } from 'react';
import type { ChapterProps } from './types';

const PORTRAITS = `${import.meta.env.BASE_URL}refs/thumbs/`;

interface InspirationSource {
  name: string;
  contribution: string;
  href: string;
  host: string;
  portrait: string;
  portraitAlt: string;
  variant: '' | 'pocock' | 'hannegan';
  index: string;
  platform: 'github' | 'youtube';
}

const SOURCES: readonly InspirationSource[] = [
  {
    name: 'ANDREJ KARPATHY',
    contribution: 'AGENTIC CODING · LLM-NATIVE WORKFLOWS',
    href: 'https://github.com/multica-ai/andrej-karpathy-skills',
    host: 'GITHUB.COM/MULTICA-AI',
    portrait: `${PORTRAITS}inspiration-andrej-karpathy.jpg`,
    portraitAlt: 'Andrej Karpathy',
    variant: '',
    index: '01',
    platform: 'github',
  },
  {
    name: 'MATT POCOCK',
    contribution: 'TYPESCRIPT RIGOR',
    href: 'https://github.com/mattpocock/skills',
    host: 'GITHUB.COM/MATTPOCOCK',
    portrait: `${PORTRAITS}inspiration-matt-pocock.webp`,
    portraitAlt: 'Matt Pocock',
    variant: 'pocock',
    index: '02',
    platform: 'github',
  },
  {
    name: 'NATE HERK',
    contribution: 'AGENT AUTOMATION PATTERNS',
    href: 'https://www.youtube.com/@nateherk',
    host: 'YOUTUBE.COM/@NATEHERK',
    portrait: `${PORTRAITS}inspiration-nate-herk.jpg`,
    portraitAlt: 'Nate Herk',
    variant: '',
    index: '03',
    platform: 'youtube',
  },
  {
    name: 'CHASE HANNEGAN',
    contribution: 'AGENT HARNESS TOOLING',
    href: 'https://www.youtube.com/channel/UCoy6cTJ7Tg0dqS-DI-_REsA',
    host: 'YOUTUBE.COM/CHANNEL',
    portrait: `${PORTRAITS}inspiration-chase-hannegan.jpg`,
    portraitAlt: 'Chase Hannegan presenting an agent orchestration workflow',
    variant: 'hannegan',
    index: '04',
    platform: 'youtube',
  },
];

function PlatformIcon({ platform }: { platform: InspirationSource['platform'] }) {
  if (platform === 'github') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 .7a11.5 11.5 0 0 0-3.64 22.41c.58.11.79-.25.79-.56v-2.24c-3.22.7-3.9-1.37-3.9-1.37-.52-1.34-1.28-1.69-1.28-1.69-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.74-1.55-2.57-.29-5.27-1.28-5.27-5.69 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.47.11-3.05 0 0 .97-.31 3.16 1.18A10.97 10.97 0 0 1 12 6.12c.98 0 1.95.13 2.87.39 2.19-1.49 3.15-1.18 3.15-1.18.63 1.58.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.42-2.71 5.39-5.29 5.68.42.36.79 1.06.79 2.15v3.25c0 .31.21.68.8.56A11.5 11.5 0 0 0 12 .7Z" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M23.5 6.2a3 3 0 0 0-2.1-2.1C19.5 3.6 12 3.6 12 3.6s-7.5 0-9.4.5A3 3 0 0 0 .5 6.2 31 31 0 0 0 0 12a31 31 0 0 0 .5 5.8 3 3 0 0 0 2.1 2.1c1.9.5 9.4.5 9.4.5s7.5 0 9.4-.5a3 3 0 0 0 2.1-2.1A31 31 0 0 0 24 12a31 31 0 0 0-.5-5.8ZM9.6 15.6V8.4l6.3 3.6-6.3 3.6Z" />
    </svg>
  );
}

function Portrait({ source }: { source: InspirationSource }) {
  const [failed, setFailed] = useState(false);

  return (
    <a className="in-portrait" href={source.href} target="_blank" rel="noopener noreferrer">
      {failed ? (
        <span className="in-plate" aria-hidden="true">
          {source.name}
        </span>
      ) : (
        <img src={source.portrait} alt={source.portraitAlt} loading="lazy" onError={() => setFailed(true)} />
      )}
      <span className="in-index" aria-hidden="true">
        SRC·{source.index}
      </span>
    </a>
  );
}

function Source({ source }: { source: InspirationSource }) {
  return (
    <article className={`in-person ${source.variant}`.trimEnd()}>
      <Portrait source={source} />
      <div className="in-record">
        <h3>{source.name}</h3>
        <p>{source.contribution}</p>
        <a className="in-source-link" href={source.href} target="_blank" rel="noopener noreferrer">
          <PlatformIcon platform={source.platform} />
          {source.platform === 'github' ? 'GITHUB' : 'YOUTUBE'} ↗
        </a>
        <span>{source.host}</span>
      </div>
    </article>
  );
}

export function Inspiration({ sectionRef }: ChapterProps) {
  return (
    <section className="chapter inspiration" id="inspiration" aria-labelledby="inspiration-title" ref={sectionRef}>
      <div className="chapter-inner">
        <div className="eyebrow">
          <span className="jp">源泉</span>THE WORK BEHIND THE WORK
        </div>
        <div className="section-head">
          <span className="idx">16</span>
          <span className="jp">源泉</span>
          <h2 id="inspiration-title">INSPIRATION</h2>
        </div>
        <p className="lead">
          Four practitioners shaped how Singularity thinks about agentic coding, TypeScript, automation, and harness
          design. Their work is the source material.
        </p>
        <div className="in-lineup">
          {SOURCES.map((source) => (
            <Source key={source.name} source={source} />
          ))}
        </div>
      </div>
    </section>
  );
}
