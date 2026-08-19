// The two teletypes on the THEMES chapter — one transcript per theme, same
// skill mechanic, two different payloads. Ported from
// docs/one-shot/slides/index.html L803-841 (TERMINALS / typeTerminal).
//
// Module-level, like useTerminal.ts, because the trigger lives outside the
// component: the source starts typing from an IntersectionObserver on the
// section, but a CSS3D panel is reparented out of the scroll flow and never
// intersects anything, so the trigger here is the conductor's chapter change
// (App.tsx's onChapter, the same seam that re-types the cockpit terminal).
//
// The source's stagger — `setTimeout(…, n * 260)` — is preserved, so the
// second terminal starts a beat after the first rather than racing it.

import { useSyncExternalStore } from 'react';
import { REDUCED_MOTION } from '../lib/env';

export type ThemeTerminalId = 'zapac' | 'phosphor';

/** Source L805-808. Each transcript is one prompt row; the leading '›' is
 *  rendered as its own `.prompt` span, exactly as typeTerminal() does. */
const TRANSCRIPTS: Record<ThemeTerminalId, string> = {
  zapac: '/zapac-material-ui create a form using this style',
  phosphor: '/evangelion-mui-theme create a form using this style',
};

const IDS: readonly ThemeTerminalId[] = ['zapac', 'phosphor'];
const CHAR_MS = 42; // source L833
const STAGGER_MS = 260; // source L839

export interface ThemeTerminalSnapshot {
  text: string;
  /** The cursor rides the row currently being typed, and stays on when done. */
  cursor: boolean;
}

const EMPTY: ThemeTerminalSnapshot = { text: '', cursor: false };

let snapshot: Record<ThemeTerminalId, ThemeTerminalSnapshot> = { zapac: EMPTY, phosphor: EMPTY };
const listeners = new Set<() => void>();
const timers: number[] = [];

function notify(): void {
  listeners.forEach((cb) => cb());
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

const getSnapshot = (): Record<ThemeTerminalId, ThemeTerminalSnapshot> => snapshot;

function write(id: ThemeTerminalId, next: ThemeTerminalSnapshot): void {
  snapshot = { ...snapshot, [id]: next };
  notify();
}

function clearTimers(): void {
  timers.forEach((t) => window.clearTimeout(t));
  timers.length = 0;
}

function type(id: ThemeTerminalId): void {
  const body = TRANSCRIPTS[id];
  if (REDUCED_MOTION) {
    write(id, { text: body, cursor: true });
    return;
  }
  write(id, { text: '', cursor: true });
  let i = 0;
  const step = (): void => {
    if (i >= body.length) return;
    write(id, { text: body.slice(0, ++i), cursor: true });
    timers.push(window.setTimeout(step, CHAR_MS));
  };
  step();
}

/** Restart both transcripts from empty. Idempotent and safe to call on every
 *  entry to the chapter — the source re-runs typeTerminal the same way. */
export function runThemeTerminals(): void {
  clearTimers();
  snapshot = { zapac: EMPTY, phosphor: EMPTY };
  notify();
  IDS.forEach((id, n) => {
    if (REDUCED_MOTION) {
      type(id);
      return;
    }
    timers.push(window.setTimeout(() => type(id), n * STAGGER_MS));
  });
}

/** Teardown / leaving 3D: stop the typewriters and blank both panes. */
export function resetThemeTerminals(): void {
  clearTimers();
  snapshot = { zapac: EMPTY, phosphor: EMPTY };
  notify();
}

export function useThemeTerminal(id: ThemeTerminalId): ThemeTerminalSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)[id];
}
