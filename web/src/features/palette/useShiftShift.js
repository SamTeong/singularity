import { useEffect, useRef } from 'react';

// Caveman-dense: double-Shift detector. Two bare Shift keydowns <300ms with
// no other key in between and no other modifier held => onOpen(). Any non-Shift
// keydown resets the timer. Ignore e.repeat (some KBs auto-repeat Shift) and
// ignore when focus is inside the palette ([data-palette-input]) — palette owns
// its own keys then. onOpen stored in a ref + empty deps so the listener binds
// once and never re-binds across renders.
export function useShiftShift(onOpen) {
  const lastShift = useRef(0);
  const cb = useRef(onOpen);
  cb.current = onOpen;
  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key === 'Shift') {
        if (e.repeat || e.ctrlKey || e.altKey || e.metaKey) { lastShift.current = 0; return; }
        const now = performance.now();
        if (now - lastShift.current < 300) {
          lastShift.current = 0; // reset so a triple-Shift doesn't fire twice
          if (!document.activeElement?.closest?.('[data-palette-input]')) cb.current();
        } else {
          lastShift.current = now;
        }
        return;
      }
      lastShift.current = 0; // any other key resets
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
