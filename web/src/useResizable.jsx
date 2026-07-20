import { useState } from 'react';
import Box from '@mui/material/Box';

// Persisted, drag-resizable panel size. `key` = localStorage key, `def` = default px.
// axis:'x' (default) measures width from the handle's parent's left edge — render
// <ResizeHandle onMouseDown={startDrag}/> as the direct sibling immediately AFTER
// the rail inside its flex row. axis:'y' measures height up from the bottom of
// `containerRef`'s element, clamped so it never eats more than `containerRef`'s
// height minus `min` (leaves room for whatever sits above the resized panel).
export function useResizable(key, def, { min = 200, max = 720, axis = 'x', containerRef } = {}) {
  const [width, setWidth] = useState(() => {
    const v = Number(localStorage.getItem(key));
    return v >= min && v <= max ? v : def;
  });
  const startDrag = (e) => {
    e.preventDefault();
    if (axis === 'y') {
      const rect = containerRef?.current?.getBoundingClientRect();
      if (!rect) return;
      const move = (ev) => {
        const h = Math.min(rect.height - min, Math.max(min, rect.bottom - ev.clientY));
        setWidth(h);
        localStorage.setItem(key, String(Math.round(h)));
      };
      const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
      return;
    }
    const left = e.currentTarget.parentElement?.getBoundingClientRect().left ?? 0;
    const move = (ev) => {
      const w = Math.min(max, Math.max(min, ev.clientX - left));
      setWidth(w);
      localStorage.setItem(key, String(Math.round(w)));
    };
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };
  return { width, startDrag };
}

export function ResizeHandle({ onMouseDown }) {
  return <Box onMouseDown={onMouseDown} sx={{ width: 6, flexShrink: 0, cursor: 'col-resize' }} />;
}
