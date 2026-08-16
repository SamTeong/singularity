// Source L856-888. A module-level store (there is only ever one
// `.terminal-body` in the deck) rather than component state, because both
// the typewriter (renderTerminal, triggered on mount / tab switch / session
// switch) and the 260ms live tick (pushTerm, in useTelemetryEngine) need to
// mutate the same row list from outside the component that renders it.

import { useSyncExternalStore } from 'react';
import { REDUCED_MOTION } from '../lib/env';
import { termRows as TERM_ROWS } from './data';
import type { TermKind } from './data';

export interface TerminalRow {
  id: number;
  kind: TermKind;
  text: string;
}

interface TerminalSnapshot {
  rows: TerminalRow[];
  cursor: boolean;
}

let nextId = 0;
let snapshot: TerminalSnapshot = { rows: [], cursor: false };
const listeners = new Set<() => void>();

function notify(): void {
  listeners.forEach((cb) => cb());
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function getSnapshot(): TerminalSnapshot {
  return snapshot;
}

/**
 * Source L874-888. The cap is 14 ROWS, not 13: the source removes the
 * cursor element before the trim loop and re-appends it after (L878,
 * L885-886), so `host.children.length > 14` during trimming counts rows
 * only. Here the cursor is tracked separately from `rows` (never mixed into
 * the array), so `slice(-14)` reproduces that count exactly without needing
 * the remove/re-append dance.
 *
 * Row ids are monotonically increasing, not array indices — with index keys
 * every trim would make React rewrite the text of all 14 surviving rows
 * instead of removing the one that fell off, which matters once this
 * becomes a CSS3D-composited layer ticking at 4Hz.
 */
export function pushTerm(kind: TermKind, text: string, trim = true): void {
  const rows = [...snapshot.rows, { id: nextId++, kind, text }];
  snapshot = { rows: trim ? rows.slice(-14) : rows, cursor: snapshot.cursor };
  notify();
}

let renderTimer = 0;

/** Source L856-873. Clears the terminal and re-types `termRows` one at a
 *  time, `115ms` apart — `0ms` (still async, still one microtask/macrotask
 *  per row, exactly like the source) under reduced motion. */
export function renderTerminal(): void {
  window.clearTimeout(renderTimer);
  snapshot = { rows: [], cursor: false };
  notify();
  let i = 0;
  const step = () => {
    if (i >= TERM_ROWS.length) {
      snapshot = { ...snapshot, cursor: true };
      notify();
      return;
    }
    const [kind, text] = TERM_ROWS[i++];
    pushTerm(kind, text, false);
    renderTimer = window.setTimeout(step, REDUCED_MOTION ? 0 : 115);
  };
  step();
}

export function useTerminalSnapshot(): TerminalSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot);
}
