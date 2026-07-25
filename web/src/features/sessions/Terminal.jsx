import React, { useEffect, useRef } from 'react';
import { useColorMode } from '@zapac/mui-theme';
import { Terminal as Xterm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { TERM_THEME } from './term-theme.js';

// Machine-output layer — opaque, never glass — but themed light/dark with the
// app. Palette lives in ./term-theme.js (shared with TranscriptView).
// Lines kept in each terminal's buffer. Bounded to cap browser-tab memory across
// a fleet of mounted terminals; past that, history lives in the transcript.
const SCROLLBACK = 5000;

export default function Terminal({ agent, visible, sendMsg, onSwitch, registerOutput, onTopReached }) {
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
  const topRef = useRef(onTopReached);
  topRef.current = onTopReached;

  useEffect(() => {
    const term = new Xterm({
      fontFamily: 'JetBrains Mono, Cascadia Code, Consolas, monospace',
      fontSize: 13,
      cursorBlink: true,
      theme: TERM_THEME[mode] ?? TERM_THEME.dark,
      scrollback: SCROLLBACK,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);
    // GPU renderer — DOM renderer (xterm default) is the choppy-scroll culprit.
    // On WebGL context loss, dispose so xterm falls back to the DOM renderer.
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch {}
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

    // WebGL + scrollback-trim desyncs the .xterm-viewport DOM scrollHeight: the
    // browser clamps wheel-down before the true bottom, so you get stuck a few
    // lines short (arrow keys still snap via scrollOnUserInput). Only when the
    // DOM is maxed but the buffer says there's more below do we force a snap —
    // no interference with scrolling up or through history.
    // ponytail: reactive snap on the stuck state; drop if xterm fixes the desync.
    const viewport = hostRef.current.querySelector('.xterm-viewport');
    const onWheel = (e) => {
      if (e.deltaY <= 0 || !viewport) return;
      requestAnimationFrame(() => {
        const atDomBottom = viewport.scrollTop + viewport.clientHeight >= viewport.scrollHeight - 1;
        const b = term.buffer.active;
        if (atDomBottom && b.viewportY < b.baseY) term.scrollToBottom();
      });
    };
    hostRef.current.addEventListener('wheel', onWheel, { passive: true });

    // Offer the full transcript when the user scrolls to the top of the buffer.
    // Must listen on the DOM viewport, not term.onScroll: xterm fires that with
    // suppressScrollEvent for wheel/scrollbar scrolling, so it never sees a user
    // scroll. The "is there history beyond the ring?" gate is the daemon's
    // cumulative pty byte count (written) vs its ring cap — a deterministic
    // server-side signal, not an xterm-buffer heuristic (the WebGL+trim desync
    // makes the DOM scrollHeight unreliable). Queried on demand at scroll-top;
    // the reply fires the prompt once per mount via `done`.
    let pending = false, done = false;
    const onViewportScroll = () => {
      if (done || pending || !viewport || viewport.scrollTop > 1) return;
      pending = true;
      sendMsg({ t: 'txmeta', id: agent.id });
    };
    viewport?.addEventListener('scroll', onViewportScroll, { passive: true });

    // keystrokes -> daemon
    term.onData((data) => sendMsg({ t: 'input', id: agent.id, data }));

    // daemon output -> xterm; reset lets the app clear before a re-attach replay.
    // meta carries the txmeta reply (written/ringMax) — fires the transcript prompt.
    registerOutput({
      write: (data) => term.write(data),
      reset: () => term.reset(),
      meta: (m) => {
        pending = false;
        if (m.written > m.ringMax) { done = true; topRef.current?.(); }
      },
    });

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
    return () => { clearTimeout(roTimer); ro.disconnect(); host.removeEventListener('contextmenu', onContextMenu); host.removeEventListener('wheel', onWheel); viewport?.removeEventListener('scroll', onViewportScroll); term.dispose(); registerOutput(null); };
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
