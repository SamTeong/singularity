// Source L890-917 — the console's roving-tabindex tablist.

import { useCallback, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';

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

  const select = useCallback((next: FleetControlView, focus = false) => {
    setView(next);
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
