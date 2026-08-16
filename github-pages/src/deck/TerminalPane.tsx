// The `.terminal` markup (source's `<div class="terminal">` block inside
// `.console-main`), driven by useTerminal.ts.

import { useLayoutEffect, useRef } from 'react';
import { useTerminalSnapshot } from './useTerminal';

export function TerminalPane() {
  const { rows, cursor } = useTerminalSnapshot();
  const bodyRef = useRef<HTMLDivElement | null>(null);

  // useLayoutEffect, not a plain effect and never wrapped in a transition:
  // the scroll pin (source L887: `host.scrollTop = host.scrollHeight`) must
  // run before the browser paints the pre-scroll frame. A transition would
  // let that frame paint first.
  useLayoutEffect(() => {
    const host = bodyRef.current;
    if (host) host.scrollTop = host.scrollHeight;
  }, [rows, cursor]);

  return (
    <div className="terminal" aria-label="Live agent terminal">
      <div className="terminal-head">
        STDOUT // CLAUDE CODE PTY
        <span className="dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
      </div>
      <div className="terminal-body" id="terminalBody" aria-live="polite" ref={bodyRef}>
        {rows.map((row) => (
          <div key={row.id} className={'term-row ' + row.kind}>
            {row.text.startsWith('›') ? (
              <>
                <span className="prompt">›</span>
                <span>{row.text.slice(1).trim()}</span>
              </>
            ) : (
              <span>{row.text}</span>
            )}
          </div>
        ))}
        {cursor && <span className="term-cursor" />}
      </div>
      <div className="terminal-foot">
        <span>MODEL: OPUS</span>
        <span>MODE: AGENT</span>
        <span>LINK: LIVE</span>
      </div>
    </div>
  );
}
