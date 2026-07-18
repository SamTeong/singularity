import React, { useEffect, useRef } from 'react';
import { useColorMode } from '@zapac/mui-theme';
import { Terminal as Xterm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

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

export default function Terminal({ agent, visible, sendMsg, onSwitch, registerOutput }) {
  // Terminal palette follows the app's color mode. Use useColorMode().resolved,
  // not theme.palette.mode — under cssVariables the latter is frozen at the
  // default scheme and won't switch with the .dark class.
  const mode = useColorMode().resolved === 'light' ? 'light' : 'dark';
  const hostRef = useRef(null);
  const xtermRef = useRef(null);
  const fitRef = useRef(null);
  const doFitRef = useRef(null);
  const switchRef = useRef(onSwitch);
  switchRef.current = onSwitch;

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

    // Ctrl+C copies when there's a selection, else falls through to SIGINT.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === 'keydown' && e.ctrlKey && e.key === 'c' && term.hasSelection()) {
        navigator.clipboard?.writeText(term.getSelection());
        return false;
      }
      // Alt+Up/Down cycles sessions even while the terminal has focus.
      if (e.type === 'keydown' && e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        switchRef.current?.(e.key === 'ArrowUp' ? -1 : 1);
        return false;
      }
      return true;
    });

    // Right-click = copy selection, else paste (Windows Terminal semantics).
    const onContextMenu = (e) => {
      e.preventDefault();
      if (term.hasSelection()) {
        navigator.clipboard?.writeText(term.getSelection());
        term.clearSelection();
      } else {
        navigator.clipboard?.readText().then((t) => t && term.paste(t)).catch(() => {});
      }
    };
    hostRef.current.addEventListener('contextmenu', onContextMenu);

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
    doFitRef.current = doFit;

    // debounce: sidebar/dock width transitions fire a resize storm mid-animation
    let roTimer = null;
    const ro = new ResizeObserver(() => {
      clearTimeout(roTimer);
      roTimer = setTimeout(doFit, 120);
    });
    ro.observe(hostRef.current);
    // fit to the real host size before replay, so scrollback doesn't render
    // into a default 80x24 and then get reflowed
    doFit();
    sendMsg({ t: 'attach', id: agent.id });
    setTimeout(doFit, 50);

    const host = hostRef.current;
    return () => { clearTimeout(roTimer); ro.disconnect(); host.removeEventListener('contextmenu', onContextMenu); term.dispose(); registerOutput(null); };
  }, [agent.id]);

  // Apply the app theme live — no need to recreate the terminal.
  useEffect(() => {
    if (xtermRef.current) xtermRef.current.options.theme = TERM_THEME[mode] ?? TERM_THEME.dark;
  }, [mode]);

  useEffect(() => {
    if (visible) {
      setTimeout(() => { try { doFitRef.current?.(); xtermRef.current?.focus(); } catch {} }, 0);
    }
  }, [visible]);

  return <div ref={hostRef} className="term" style={{ display: visible ? 'block' : 'none' }} />;
}
