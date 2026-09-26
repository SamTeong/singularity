import { useRef, useState } from 'react';
import { getTokens } from '@/theme/contract.js';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import useMediaQuery from '@mui/material/useMediaQuery';
import Typography from '@mui/material/Typography';
import CloseIcon from '@mui/icons-material/Close';
import KeyboardArrowLeftIcon from '@mui/icons-material/KeyboardArrowLeft';
import KeyboardArrowRightIcon from '@mui/icons-material/KeyboardArrowRight';
import { PHONE_QUERY, TABLET_QUERY } from '@/shell/breakpoints.js';

const baseOf = (p) => p.slice(Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')) + 1);

// Horizontal scrollable tab row above the editor. `tabs` = [{path,dirty,...}] —
// basename as the label, full path as title, a dirty dot, a close button.
// Passing `onReorder(fromPath, overPath)` makes the tabs drag-reorderable:
// native HTML5 DnD, live-swapped on dragover (the caller owns the tab order, so
// there's nothing to commit on drop). Omit it and the strip stays static.
//
// Roving tabIndex (WAI-ARIA tabs pattern): only the active tab is in the Tab
// order (tabIndex 0), the rest are -1; ArrowLeft/ArrowRight/Home/End move
// focus *and* selection between tabs (automatic activation — there's no
// separate tabpanel to defer to), Enter/Space activate the focused tab.
// No `aria-controls`: the editor pane below has no single stable element with
// an id to point at (ExplorerPanel renders whichever file is active in the
// same slot, not one per-tab panel), so it's omitted rather than invented.
export default function TabStrip({ tabs, active, onSelect, onClose, onReorder }) {
  const [dragPath, setDragPath] = useState(null);
  const tabRefs = useRef([]);
  // Below 900px an HTML5 drag is not operable by touch, so each tab carries the
  // compact Move left/right pair instead (the same phone||tablet switch the
  // vertical reorder surfaces use, on the horizontal axis).
  const isPhone = useMediaQuery(PHONE_QUERY);
  const isTablet = useMediaQuery(TABLET_QUERY);
  const narrow = isPhone || isTablet;
  const dragProps = onReorder && !narrow ? (tab) => ({
    draggable: true,
    onDragStart: () => setDragPath(tab.path),
    onDragEnd: () => setDragPath(null),
    onDragOver: (e) => {
      e.preventDefault();
      if (dragPath && dragPath !== tab.path) onReorder(dragPath, tab.path);
    },
    onDrop: (e) => { e.preventDefault(); setDragPath(null); },
  }) : () => ({});

  // Adjacent move through the same onReorder seam the drag uses (it is
  // move-to-slot, so moving onto the immediate neighbour is the adjacent swap).
  const moveTab = (i, dir) => {
    const other = tabs[i + dir];
    if (!other) return;
    onReorder(tabs[i].path, other.path);
  };

  const move = (nextIndex) => {
    const tab = tabs[nextIndex];
    if (!tab) return;
    onSelect(tab.path);
    tabRefs.current[nextIndex]?.focus();
  };
  const onKeyDown = (e, i) => {
    if (e.key === 'ArrowRight') { e.preventDefault(); move((i + 1) % tabs.length); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); move((i - 1 + tabs.length) % tabs.length); }
    else if (e.key === 'Home') { e.preventDefault(); move(0); }
    else if (e.key === 'End') { e.preventDefault(); move(tabs.length - 1); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(tabs[i].path); }
  };

  return (
    <Stack direction="row" role="tablist" aria-label="Editor tabs" sx={(t) => ({ flexShrink: 0, overflowX: 'auto', borderBottom: `1px solid ${getTokens(t).glass.stroke}` })}>
      {tabs.map((tab, i) => (
        <Stack key={tab.path} direction="row" spacing={0.5} title={tab.path} onClick={() => onSelect(tab.path)}
          role="tab" aria-selected={tab.path === active} tabIndex={tab.path === active ? 0 : -1}
          ref={(el) => { tabRefs.current[i] = el; }}
          onKeyDown={(e) => onKeyDown(e, i)}
          {...dragProps(tab)}
          sx={(t) => ({
            alignItems: 'center', flexShrink: 0, gap: 0.5, px: 1, py: 0.5, cursor: 'pointer',
            borderRight: `1px solid ${getTokens(t).glass.stroke}`,
            ...(tab.path === dragPath ? { opacity: 0.4 } : null),
            ...(tab.path === active && t.nerv
              ? { bgcolor: t.nerv.hue.mint, color: t.nerv.hue.void, '&:hover': { bgcolor: t.nerv.hue.mintHi }, '& .MuiIconButton-root': { color: 'inherit' } }
              : { bgcolor: tab.path === active ? 'action.selected' : 'transparent' }),
          })}
        >
          {narrow && onReorder && (
            // tabIndex -1 keeps the roving-tabindex contract above intact: the
            // pair is a touch affordance and must not add 2 tab stops per tab.
            // The keyboard reorder path stays the desktop grip / ArrowUp-Down.
            <Stack sx={{ alignItems: 'center' }}>
              <Tooltip title="Move left" disableInteractive>
                <span>
                  <IconButton size="small" tabIndex={-1} aria-label={`Move ${baseOf(tab.path)} left`} sx={{ p: 0.25 }} disabled={i === 0} onClick={(e) => { e.stopPropagation(); moveTab(i, -1); }}>
                    <KeyboardArrowLeftIcon fontSize="small" />
                  </IconButton>
                </span>
              </Tooltip>
              <Tooltip title="Move right" disableInteractive>
                <span>
                  <IconButton size="small" tabIndex={-1} aria-label={`Move ${baseOf(tab.path)} right`} sx={{ p: 0.25 }} disabled={i === tabs.length - 1} onClick={(e) => { e.stopPropagation(); moveTab(i, 1); }}>
                    <KeyboardArrowRightIcon fontSize="small" />
                  </IconButton>
                </span>
              </Tooltip>
            </Stack>
          )}
          {tab.dirty && <Box sx={{ width: 6, height: 6, borderRadius: '50%', bgcolor: 'warning.main', flexShrink: 0 }} />}
          <Typography noWrap sx={{ fontSize: 12, maxWidth: 160 }}>{baseOf(tab.path)}</Typography>
          <IconButton size="small" sx={{ p: 0.25 }} onClick={(e) => { e.stopPropagation(); onClose(tab.path); }}>
            <CloseIcon sx={{ fontSize: 14 }} />
          </IconButton>
        </Stack>
      ))}
    </Stack>
  );
}
