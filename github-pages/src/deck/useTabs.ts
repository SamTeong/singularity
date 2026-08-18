// Source L890-917 — the console's roving-tabindex tablist.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { seekStep, useScrollStep } from './useScrollStep';

export type FleetControlView = 'sessions' | 'tasks' | 'automation' | 'usage';

const VIEWS: readonly FleetControlView[] = ['sessions', 'tasks', 'automation', 'usage'];

export interface UseTabsResult {
  view: FleetControlView;
  views: readonly FleetControlView[];
  select: (view: FleetControlView, focus?: boolean) => void;
  registerTab: (view: FleetControlView) => (el: HTMLButtonElement | null) => void;
  handleKeyDown: (event: KeyboardEvent<HTMLButtonElement>, view: FleetControlView) => void;
}

export function useTabs(): UseTabsResult {
  const [view, setView] = useState<FleetControlView>('sessions');
  const tabRefs = useRef<Record<FleetControlView, HTMLButtonElement | null>>({
    sessions: null,
    tasks: null,
    automation: null,
    usage: null,
  });

  // In 3D the reader's scroll position picks the view (see useScrollStep):
  // one band of the fleet-control chapter's local progress per tab.
  const scrollStep = useScrollStep('fleet-control');
  useEffect(() => {
    if (scrollStep !== null) setView(VIEWS[scrollStep]);
  }, [scrollStep]);

  const select = useCallback((next: FleetControlView, focus = false) => {
    // Scroll owns the view in 3D, so a click scrolls to that tab's band and
    // the effect above applies it — setting state here too would only be
    // undone at the next band crossing. seekStep is false in flat mode.
    if (!seekStep('fleet-control', VIEWS.indexOf(next))) setView(next);
    // Source L896: `if (on && focus) tab.focus()`, called synchronously in
    // the handler. The target element already exists in the DOM (all four
    // tabs render unconditionally) and `tabIndex={-1}` elements stay
    // programmatically focusable, so there is no need to wait for the
    // commit that flips `aria-selected`/`tabIndex` onto it.
    if (focus) tabRefs.current[next]?.focus();
  }, []);

  const registerTab = useCallback(
    (id: FleetControlView) => (el: HTMLButtonElement | null) => {
      tabRefs.current[id] = el;
    },
    [],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>, id: FleetControlView) => {
      const i = VIEWS.indexOf(id);
      if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
        event.preventDefault();
        const d = event.key === 'ArrowRight' ? 1 : -1;
        select(VIEWS[(i + d + VIEWS.length) % VIEWS.length], true);
      } else if (event.key === 'Home') {
        event.preventDefault();
        select(VIEWS[0], true);
      } else if (event.key === 'End') {
        event.preventDefault();
        select(VIEWS[VIEWS.length - 1], true);
      }
    },
    [select],
  );

  return { view, views: VIEWS, select, registerTab, handleKeyDown };
}
