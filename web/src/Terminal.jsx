import React, { useEffect, useRef } from 'react';
import { Terminal as Xterm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

export default function Terminal({ agent, visible, sendMsg, registerOutput }) {
  const hostRef = useRef(null);
  const xtermRef = useRef(null);
  const fitRef = useRef(null);

  useEffect(() => {
    const term = new Xterm({
      fontFamily: 'Cascadia Code, Consolas, monospace',
      fontSize: 13,
      cursorBlink: true,
      theme: { background: '#0b0e14', foreground: '#c8d3e0' },
      scrollback: 10000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);
    xtermRef.current = term;
    fitRef.current = fit;

    // keystrokes -> daemon
    term.onData((data) => sendMsg({ t: 'input', id: agent.id, data }));

    // daemon output -> xterm
    registerOutput((data) => term.write(data));

    const doFit = () => {
      try {
        fit.fit();
        sendMsg({ t: 'resize', id: agent.id, cols: term.cols, rows: term.rows });
      } catch {}
    };
    const ro = new ResizeObserver(doFit);
    ro.observe(hostRef.current);
    // attach to replay any existing scrollback + trigger initial resize sync
    sendMsg({ t: 'attach', id: agent.id });
    setTimeout(doFit, 50);

    return () => { ro.disconnect(); term.dispose(); };
  }, [agent.id]);

  useEffect(() => {
    if (visible) {
      setTimeout(() => { try { fitRef.current?.fit(); xtermRef.current?.focus(); } catch {} }, 0);
    }
  }, [visible]);

  return <div ref={hostRef} className="term" style={{ display: visible ? 'block' : 'none' }} />;
}
