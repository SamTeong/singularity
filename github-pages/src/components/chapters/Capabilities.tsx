// Transcribed from docs/one-shot/3d/sample-gitlab-3d-scan.html, source lines 651-666.
import { useState } from 'react';
import type { CSSProperties } from 'react';
import type { ChapterProps } from './types';

export function Capabilities({ sectionRef }: ChapterProps) {
  // Source L925-929: clicking the pinned module unpins it; clicking another
  // moves the pin. `aria-pressed` drives both the styling and the
  // `::after{content:"PINNED"}` badge.
  const [pinned, setPinned] = useState<number | null>(null);
  const togglePin = (i: number) => setPinned((p) => (p === i ? null : i));

  return (
    // className/id are constant literals and this section never receives a
    // `style` prop — Phase 4 adds `.as-panel` to classList and writes
    // width/height/display/opacity directly on this node every frame. A
    // React-driven className rewrite would silently drop `.as-panel` and
    // collapse the panel mid-scroll.
    <section className="chapter capabilities" id="systems" aria-labelledby="systems-title" ref={sectionRef}>
      <div className="chapter-inner">
        <div className="section-head">
          <span className="idx">03</span>
          <span className="jp">系統</span>
          <h2 id="systems-title">EVERYTHING AROUND THE WORK.</h2>
        </div>
        <p className="lead">
          Agents need more than a terminal. Singularity keeps the operational surfaces around them visible, editable,
          and close at hand.
        </p>
        <div className="modules">
          <button
            className="module"
            aria-pressed={pinned === 0}
            style={{ '--tone': 'var(--blue)' } as CSSProperties}
            onClick={() => togglePin(0)}
          >
            <span className="glyph">自</span>
            <span className="code">SYS·01</span>
            <h3>AUTOMATION</h3>
            <p>Schedule cron jobs or let a background dispatcher pick eligible tasks and launch agents.</p>
            <span className="module-foot">
              <span>CRON + QUEUE</span>
              <span className="stamp c-blue">LIVE</span>
            </span>
          </button>
          <button
            className="module"
            aria-pressed={pinned === 1}
            style={{ '--tone': 'var(--orange)' } as CSSProperties}
            onClick={() => togglePin(1)}
          >
            <span className="glyph">設</span>
            <span className="code">SYS·02</span>
            <h3>CONFIG + HOOKS</h3>
            <p>Inspect and edit project or local settings, hooks, rules, and agent skill scopes.</p>
            <span className="module-foot">
              <span>VALIDATED EDITS</span>
              <span className="stamp c-mint">READY</span>
            </span>
          </button>
          <button className="module" aria-pressed={pinned === 2} onClick={() => togglePin(2)}>
            <span className="glyph">記</span>
            <span className="code">SYS·03</span>
            <h3>MEMORY + SKILLS</h3>
            <p>Keep project memory and reusable instructions discoverable instead of repasting context.</p>
            <span className="module-foot">
              <span>LOCAL FILES</span>
              <span className="stamp c-mint">INDEXED</span>
            </span>
          </button>
          <button
            className="module"
            aria-pressed="false"
            style={{ '--tone': 'var(--amber)' } as CSSProperties}
          >
            <span className="glyph">消</span>
            <span className="code">SYS·04</span>
            <h3>USAGE</h3>
            <p>Read five-hour and seven-day windows, per-session tokens, turns, and cost reporting.</p>
            <span className="module-foot">
              <span>FLEET METRICS</span>
              <span className="stamp c-amber">19%</span>
            </span>
          </button>
          <button className="module" aria-pressed="false" style={{ '--tone': 'var(--blue)' } as CSSProperties}>
            <span className="glyph">履</span>
            <span className="code">SYS·05</span>
            <h3>HISTORY</h3>
            <p>Review daily work by session, then drill directly into the transcript that produced it.</p>
            <span className="module-foot">
              <span>DAILY RECORD</span>
              <span className="stamp c-blue">SYNCED</span>
            </span>
          </button>
          <button className="module" aria-pressed="false">
            <span className="glyph">記</span>
            <span className="code">SYS·06</span>
            <h3>TRANSCRIPTS</h3>
            <p>Search, inspect, and resume past local agent conversations without leaving the deck.</p>
            <span className="module-foot">
              <span>LOCAL ARCHIVE</span>
              <span className="stamp c-mint">READY</span>
            </span>
          </button>
          <button
            className="module"
            aria-pressed="false"
            style={{ '--tone': 'var(--orange)' } as CSSProperties}
          >
            <span className="glyph">文</span>
            <span className="code">SYS·07</span>
            <h3>WIKI + EXPLORER</h3>
            <p>Browse linked documentation and edit repository files in the same operational shell.</p>
            <span className="module-foot">
              <span>GRAPH + TREE</span>
              <span className="stamp c-mint">OPEN</span>
            </span>
          </button>
          <button
            className="module"
            aria-pressed="false"
            style={{ '--tone': 'var(--red-hi)' } as CSSProperties}
          >
            <span className="glyph">状</span>
            <span className="code">SYS·08</span>
            <h3>STATUS + PROCESSES</h3>
            <p>Watch provider availability, daemon health, CPU, memory, and every running agent process.</p>
            <span className="module-foot">
              <span>OBSERVABILITY</span>
              <span className="stamp c-mint">NOMINAL</span>
            </span>
          </button>
        </div>
      </div>
    </section>
  );
}
