import React, { useEffect, useRef } from 'react';
import { Terminal as Xterm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { useColorMode } from '@zapac/mui-theme';

// Machine-output layer — opaque, never glass — but themed light/dark with the
// app. xterm's default 16-color ANSI palette is built for a dark background and
// goes low-contrast on white, so each mode ships its own tuned palette on the
// zapac field colors (purple-black / periwinkle-lilac).
const TERM_THEME = {
  dark: {
    background: '#0b0813', foreground: '#d9d2ee',
    cursor: '#985b9c', cursorAccent: '#0b0813', selectionBackground: '#985b9c55',
    black: '#0b0813', red: '#ff6b81', green: '#2ec76f', yellow: '#f2a33c',
    blue: '#5b8bff', magenta: '#c58cff', cyan: '#33b5e0', white: '#b6afd4',
    brightBlack: '#7d7699', brightRed: '#ff8fa0', brightGreen: '#5fe0a0', brightYellow: '#ffc46b',
    brightBlue: '#84a8ff', brightMagenta: '#d9b0ff', brightCyan: '#66cdf0', brightWhite: '#f3f0ff',
  },
  light: {
    background: '#f3f0fb', foreground: '#181320',
    cursor: '#834f88', cursorAccent: '#f3f0fb', selectionBackground: '#985b9c33',
    black: '#181320', red: '#b00020', green: '#088043', yellow: '#8a6d00',
    blue: '#3c69c8', magenta: '#834f88', cyan: '#007299', white: '#524b62',
    brightBlack: '#736c88', brightRed: '#d32f2f', brightGreen: '#2e9e5b', brightYellow: '#a67c00',
    brightBlue: '#4f7fd8', brightMagenta: '#985b9c', brightCyan: '#0090c0', brightWhite: '#181320',
  },
};

export default function Terminal({ agent, visible, sendMsg, registerOutput }) {
  const { mode } = useColorMode();
  const hostRef = useRef(null);
  const xtermRef = useRef(null);
  const fitRef = useRef(null);

  useEffect(() => {
    const term = new Xterm({
      fontFamily: 'JetBrains Mono, Cascadia Code, Consolas, monospace',
      fontSize: 13,
      cursorBlink: true,
      theme: TERM_THEME[mode] ?? TERM_THEME.dark,
      scrollback: 10000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);
    xtermRef.current = term;
    fitRef.current = fit;

    // keystrokes -> daemon
    term.onData((data) => sendMsg({ t: 'input', id: agent.id, data }));

    // daemon output -> xterm; reset lets the app clear before a re-attach replay
    registerOutput({ write: (data) => term.write(data), reset: () => term.reset() });

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

    return () => { ro.disconnect(); term.dispose(); registerOutput(null); };
  }, [agent.id]);

  // Follow the app color mode live — no need to recreate the terminal.
  useEffect(() => {
    if (xtermRef.current) xtermRef.current.options.theme = TERM_THEME[mode] ?? TERM_THEME.dark;
  }, [mode]);

  useEffect(() => {
    if (visible) {
      setTimeout(() => { try { fitRef.current?.fit(); xtermRef.current?.focus(); } catch {} }, 0);
    }
  }, [visible]);

  return <div ref={hostRef} className="term" style={{ display: visible ? 'block' : 'none' }} />;
}
