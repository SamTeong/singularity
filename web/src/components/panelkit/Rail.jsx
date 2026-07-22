import { getTokens } from '@/theme/contract.js';
import { useState } from 'react';
import Stack from '@mui/material/Stack';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import { useResizable, ResizeHandle } from '@/hooks/useResizable.jsx';

// Collapsible + drag-resizable left rail shell shared by the file-browser panels.
// Owns the collapsed state and persisted width; renders the outer column, the
// collapsed expand button, and the sibling resize handle. `children` is a
// render-prop given `collapse` so each panel keeps its own header/list markup
// and wires its chevron-left button.
export default function Rail({ storageKey, defaultWidth, collapsedTitle, children }) {
  const [collapsed, setCollapsed] = useState(false);
  const railW = useResizable(storageKey, defaultWidth);
  return (
    <>
      <Stack sx={(t) => ({ width: collapsed ? 40 : railW.width, flexShrink: 0, borderRight: `1px solid ${getTokens(t).glass.stroke}`, minHeight: 0, transition: 'width .2s ease' })}>
        {collapsed ? (
          <Tooltip title={collapsedTitle} placement="right" disableInteractive>
            <IconButton size="small" onClick={() => setCollapsed(false)} sx={{ m: 0.5 }}><ChevronRightIcon /></IconButton>
          </Tooltip>
        ) : children({ collapse: () => setCollapsed(true) })}
      </Stack>
      {!collapsed && <ResizeHandle onMouseDown={railW.startDrag} />}
    </>
  );
}
