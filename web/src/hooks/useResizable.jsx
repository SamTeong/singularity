import { useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import { getTokens } from '@/theme/contract.js';
import { focusRing } from '@/shell/shellStyles.js';

const STEP = 16; // layout-02 `makeResizer`'s arrow-key nudge

// Persisted, drag-resizable panel size. `key` = localStorage key, `def` = default px.
// axis:'x' (default) measures width from the handle's parent's left edge — render
// <ResizeHandle axis="x" onPointerDown={startDrag} onKeyDown={onKeyDown}/> as the
// direct sibling immediately AFTER the rail inside its flex row. axis:'y'
// measures height up from the bottom of `containerRef`'s element, clamped so it
// never eats more than `containerRef`'s height minus `min` (leaves room for
// whatever sits above the resized panel).
export function useResizable(key, def, { min = 200, max = 720, axis = 'x', containerRef } = {}) {
  const [width, setWidth] = useState(() => {
    const v = Number(localStorage.getItem(key));
    return v >= min && v <= max ? v : def;
  });
  const [dragging, setDragging] = useState(false);
  // Holds the active drag's cleanup fn so an unmount mid-drag (dockMin/panelMin
  // toggle, view switch) can cancel it — otherwise the window listener survives,
  // keeps writing localStorage, and `dragging` sticks true.
  const upRef = useRef(null);

  const commit = (v) => {
    setWidth(v);
    localStorage.setItem(key, String(Math.round(v)));
  };

  // axis:'y' has a dynamic ceiling (the container's own height, minus `min` so
  // the panel above it never fully collapses) — mirrors the drag clamp below.
  const upperBound = () => {
    if (axis !== 'y') return max;
    const rect = containerRef?.current?.getBoundingClientRect();
    return rect ? rect.height - min : max;
  };

  // Pointer events (not mouse) so a touch-drag actually works under
  // touchAction:'none' below, and setPointerCapture keeps the drag tracking
  // even once the pointer leaves the thin handle strip.
  const startDrag = (e) => {
    e.preventDefault();
    setDragging(true);
    document.body.classList.add('resizing');
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const finish = () => {
      setDragging(false);
      document.body.classList.remove('resizing');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      upRef.current = null;
    };
    let move;
    if (axis === 'y') {
      const rect = containerRef?.current?.getBoundingClientRect();
      if (!rect) { setDragging(false); document.body.classList.remove('resizing'); return; }
      move = (ev) => commit(Math.min(rect.height - min, Math.max(min, rect.bottom - ev.clientY)));
    } else {
      const left = e.currentTarget.parentElement?.getBoundingClientRect().left ?? 0;
      move = (ev) => commit(Math.min(max, Math.max(min, ev.clientX - left)));
    }
    upRef.current = finish;
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
  };

  // Cancel an in-flight drag if the handle unmounts mid-drag.
  useEffect(() => () => upRef.current?.(), []);

  // Keyboard-accessible resize (layout-02 `makeResizer`): arrow keys nudge by
  // 16px, same clamp as drag. axis:'y' grows *upward* on ArrowUp (mirrors
  // dragging up); axis:'x' grows rightward on ArrowRight.
  const onKeyDown = (e) => {
    let d = 0;
    if (axis === 'y') { if (e.key === 'ArrowUp') d = STEP; else if (e.key === 'ArrowDown') d = -STEP; }
    else { if (e.key === 'ArrowRight') d = STEP; else if (e.key === 'ArrowLeft') d = -STEP; }
    if (!d) return;
    e.preventDefault();
    commit(Math.min(upperBound(), Math.max(min, width + d)));
  };

  // `max` is the static configured ceiling, not `upperBound()` — the dynamic
  // axis:'y' bound reads `containerRef.current` (only safe in an event handler
  // or effect, per react-hooks/refs), so it stays scoped to commit/onKeyDown.
  // A caller threading this into ResizeHandle's aria-valuemax gets a slightly
  // loose (but never wrong) upper bound for axis:'y' rather than a tight one.
  return { width, startDrag, onKeyDown, dragging, min, max };
}

/**
 * layout-02 `.dock-handle` / `.list-handle`: a 12px/8px hit strip holding a pill
 * grip (40×4 or 4×40) that fades in on hover/focus/drag and turns brand-coloured.
 * `role="separator"` + `aria-orientation` + `aria-label` + native keyboard focus
 * (arrow-key resizing is wired by the caller via `onKeyDown`, usually
 * {@link useResizable}'s own handler), plus `aria-valuenow/min/max` when the
 * caller passes `value`/`min`/`max` — a focusable `separator` is a widget role,
 * so it needs value semantics (axe `aria-required-attr`).
 *
 * When `label` is omitted the grip renders decorative instead (`aria-hidden`,
 * no `role`, no `tabIndex`) — a missing label must never produce an unnamed
 * focusable separator. Extra `sx` merges in (layout-specific margins, etc).
 */
export function ResizeHandle({ axis = 'x', onPointerDown, onKeyDown, dragging, label, value, min, max, sx }) {
  const isY = axis === 'y';
  const decorative = !label;
  return (
    <Box
      {...(decorative
        ? { 'aria-hidden': true }
        : {
            role: 'separator',
            'aria-orientation': isY ? 'horizontal' : 'vertical',
            'aria-label': label,
            tabIndex: 0,
            onKeyDown,
            ...(value != null && { 'aria-valuenow': Math.round(value) }),
            ...(min != null && { 'aria-valuemin': Math.round(min) }),
            ...(max != null && { 'aria-valuemax': Math.round(max) }),
          })}
      onPointerDown={onPointerDown}
      sx={[
        (t) => ({
          position: 'relative',
          flexShrink: 0,
          touchAction: 'none',
          ...(isY ? { height: 12, cursor: 'row-resize' } : { width: 8, cursor: 'col-resize', mx: '-4px', zIndex: 1 }),
          '&::after': {
            content: '""',
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%,-50%)',
            borderRadius: 999,
            ...(isY ? { width: 40, height: 4 } : { width: 4, height: 40 }),
            background: dragging ? t.vars.palette.primary.main : getTokens(t).glass.stroke,
            opacity: dragging ? 1 : 0,
            transition: 'opacity .18s ease, background .18s ease',
          },
          '&:hover::after': { opacity: 1, background: t.vars.palette.primary.main },
          '&:focus-visible': focusRing(t),
          '&:focus-visible::after': { opacity: 1, background: t.vars.palette.primary.main },
          '@media (prefers-reduced-motion: reduce)': { '&::after': { transition: 'none' } },
        }),
        ...(Array.isArray(sx) ? sx : sx ? [sx] : []),
      ]}
    />
  );
}
