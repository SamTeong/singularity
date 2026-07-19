import { useState } from 'react';
import Box from '@mui/material/Box';

// Persisted, drag-resizable panel width. `key` = localStorage key, `def` = default px.
// Returns { width, startDrag }; render <ResizeHandle onMouseDown={startDrag}/> as the
// direct sibling immediately AFTER the rail inside its flex row.
export function useResizable(key, def, { min = 200, max = 720 } = {}) {
  const [width, setWidth] = useState(() => {
    const v = Number(localStorage.getItem(key));
    return v >= min && v <= max ? v : def;
  });
  const startDrag = (e) => {
    e.preventDefault();
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
