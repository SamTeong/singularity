import { useState } from 'react';
import type { ChapterProps } from './types';

const SHOTS = `${import.meta.env.BASE_URL}refs/thumbs/`;

interface Alternative {
  name: string;
  jp: string;
  variant: '' | 'buzz' | 'grokbot';
  desc: string;
  href: string;
  host: string;
  shot: string;
  shotAlt: string;
  deployment: string;
  workflow: string;
}

const ALTERNATIVES: readonly Alternative[] = [
  {
    name: 'CONDUCTOR',
    jp: '指揮',
    variant: '',
    desc: 'Parallel coding workspaces for delegating software tasks to coding agents.',
    href: 'https://www.conductor.build/',
    host: 'conductor.build',
    shot: `${SHOTS}alternative-conductor.webp`,
    shotAlt: 'Conductor showing a coding-agent workspace beside a pull request',
    deployment: 'MANAGED CLOUD',
    workflow: 'ISOLATED AGENT WORKSPACES',
  },
  {
    name: 'BUZZ',
    jp: '蜂群',
    variant: 'buzz',
    desc: 'A self-hostable workspace where people and agents collaborate in shared rooms.',
    href: 'https://github.com/block/buzz',
    host: 'github.com/block/buzz',
    shot: `${SHOTS}alternative-buzz.png`,
    shotAlt: 'Buzz channel where people and an agent coordinate a release plan',
    deployment: 'SELF-HOSTED RELAY',
    workflow: 'HUMANS + AGENTS IN SHARED ROOMS',
  },
  {
    name: 'GROKBOT',
    jp: '自律',
    variant: 'grokbot',
    desc: 'Specialist bots that carry out recurring business work through a shared chat interface.',
    href: 'https://x.ai/bot',
    host: 'x.ai/bot',
    shot: `${SHOTS}alternative-grokbot.png`,
    shotAlt: 'GrokBot workspace with specialist agents coordinating a sales workflow',
    deployment: 'MANAGED SERVICE',
    workflow: 'SPECIALIST BUSINESS AGENTS',
  },
];

function Shot({ alternative }: { alternative: Alternative }) {
  const [failed, setFailed] = useState(false);

  return (
    <a className="ac-shot" href={alternative.href} target="_blank" rel="noopener noreferrer">
      {failed ? (
        <span className="ac-plate" aria-hidden="true">
          {alternative.name}
        </span>
      ) : (
        <img
          src={alternative.shot}
          alt={alternative.shotAlt}
          loading="lazy"
          onError={() => setFailed(true)}
        />
      )}
      <span className="ac-peek">OPEN ↗</span>
    </a>
  );
}

function Card({ alternative }: { alternative: Alternative }) {
  return (
    <article className={`ac-card ${alternative.variant}`.trimEnd()}>
      <div className="ac-head">
        <span className="ac-mark" aria-hidden="true" />
        <h3>{alternative.name}</h3>
        <span className="ac-jp" aria-hidden="true">
          {alternative.jp}
        </span>
      </div>
      <p className="ac-desc">{alternative.desc}</p>
      <Shot alternative={alternative} />
      <dl className="ac-spec">
        <div className="ac-row">
          <dt>Deployment</dt>
          <dd>{alternative.deployment}</dd>
        </div>
        <div className="ac-row">
          <dt>Workflow</dt>
          <dd>{alternative.workflow}</dd>
        </div>
      </dl>
      <div className="ac-cta">
        <a className="btn" href={alternative.href} target="_blank" rel="noopener noreferrer">
          VIEW {alternative.name} ↗
        </a>
        <span>{alternative.host}</span>
      </div>
    </article>
  );
}

export function Alternatives({ sectionRef }: ChapterProps) {
  return (
    <section className="chapter alternatives" id="alternatives" aria-labelledby="alternatives-title" ref={sectionRef}>
      <div className="chapter-inner">
        <div className="eyebrow">
          <span className="jp">比較</span>THREE TAKES ON AGENT COORDINATION
        </div>
        <div className="section-head">
          <span className="idx">13</span>
          <span className="jp">比較</span>
          <h2 id="alternatives-title">ALTERNATIVES</h2>
        </div>
        <p className="lead">
          Conductor organizes coding agents in cloud workspaces. Buzz brings people and agents into shared rooms.
          GrokBot applies specialist agents to recurring business work.
        </p>
        <div className="ac-grid">
          {ALTERNATIVES.map((alternative) => (
            <Card key={alternative.name} alternative={alternative} />
          ))}
        </div>
      </div>
    </section>
  );
}
