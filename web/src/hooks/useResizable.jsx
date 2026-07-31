import { useState } from 'react';
import Box from '@mui/material/Box';
import { getTokens } from '@/theme/contract.js';

const STEP = 16; // layout-02 `makeResizer`'s arrow-key nudge

// Persisted, drag-resizable panel size. `key` = localStorage key, `def` = default px.
// axis:'x' (default) measures width from the handle's parent's left edge — render
// <ResizeHandle axis="x" onMouseDown={startDrag} onKeyDown={onKeyDown}/> as the
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

  const startDrag = (e) => {
    e.preventDefault();
    setDragging(true);
    if (axis === 'y') {
      const rect = containerRef?.current?.getBoundingClientRect();
      if (!rect) { setDragging(false); return; }
      const move = (ev) => commit(Math.min(rect.height - min, Math.max(min, rect.bottom - ev.clientY)));
      const up = () => { setDragging(false); window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
      return;
    }
    const left = e.currentTarget.parentElement?.getBoundingClientRect().left ?? 0;
    const move = (ev) => commit(Math.min(max, Math.max(min, ev.clientX - left)));
    const up = () => { setDragging(false); window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

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

  return { width, startDrag, onKeyDown, dragging, min };
}

/**
 * layout-02 `.dock-handle` / `.list-handle`: a 12px/8px hit strip holding a pill
 * grip (40×4 or 4×40) that fades in on hover/focus/drag and turns brand-coloured.
 * `role="separator"` + `aria-orientation` + `aria-label` + native keyboard focus
 * (arrow-key resizing is wired by the caller via `onKeyDown`, usually
 * {@link useResizable}'s own handler). Extra `sx` merges in (layout-specific
 * margins, etc).
 */
export function ResizeHandle({ axis = 'x', onMouseDown, onKeyDown, dragging, label, sx }) {
  const isY = axis === 'y';
  return (
    <Box
      role="separator"
      aria-orientation={isY ? 'horizontal' : 'vertical'}
      aria-label={label}
      tabIndex={0}
      onMouseDown={onMouseDown}
      onKeyDown={onKeyDown}
      sx={[
        (t) => ({
          position: 'relative',
          flexShrink: 0,
          touchAction: 'none',
          ...(isY ? { height: 12, cursor: 'row-resize' } : { width: 8, cursor: 'col-resize' }),
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
          '&:focus-visible': { outline: 'none' },
          '&:focus-visible::after': { opacity: 1, background: t.vars.palette.primary.main },
          '@media (prefers-reduced-motion: reduce)': { '&::after': { transition: 'none' } },
        }),
        ...(Array.isArray(sx) ? sx : sx ? [sx] : []),
      ]}
    />
  );
}
