import { useEffect, useRef } from 'react';

// Caveman-dense: generalised double-tap detector for bare modifier keys (Shift,
// Control, Alt, Meta). Two keydowns of `binding.doubleTap` <300ms apart with no
// other key in between and no other modifier held => onFire(). Any other keydown
// resets the timer. Ignore e.repeat (some KBs auto-repeat modifiers) and ignore
// when focus is inside the palette ([data-palette-input]) — palette owns its own
// keys then. binding/onFire stored in refs + empty deps so the listener binds
// once and never re-binds across renders.
const MODIFIER_FLAG = { Shift: 'shiftKey', Control: 'ctrlKey', Alt: 'altKey', Meta: 'metaKey' };

export function useDoubleTap(binding, onFire) {
  const lastTap = useRef(0);
  const bindingRef = useRef(binding);
  const cb = useRef(onFire);
  useEffect(() => { bindingRef.current = binding; });
  useEffect(() => { cb.current = onFire; });
  useEffect(() => {
    const onKeyDown = (e) => {
      const watch = bindingRef.current?.doubleTap;
      if (!watch) return;
      if (e.key === watch) {
        const others = Object.keys(MODIFIER_FLAG).filter((m) => m !== watch);
        if (e.repeat || others.some((m) => e[MODIFIER_FLAG[m]])) { lastTap.current = 0; return; }
        const now = performance.now();
        if (now - lastTap.current < 300) {
          lastTap.current = 0; // reset so a triple-tap doesn't fire twice
          if (!document.activeElement?.closest?.('[data-palette-input]')) cb.current();
        } else {
          lastTap.current = now;
        }
        return;
      }
      lastTap.current = 0; // any other key resets
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
