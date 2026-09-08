import Box from '@mui/material/Box';

// Phase 3's one narrow representation for dense tables: below 900px a table
// with eight-plus columns is neither crushed to 320px nor clipped — it keeps a
// legible minimum width inside its own labelled, keyboard-focusable horizontal
// scroll region, so every column (including the right-hand action cell) stays
// reachable. Sorting, tooltips and row actions are the desktop ones, untouched.
//
// `narrow` false renders the children with no wrapper at all, so desktop keeps
// its existing DOM and layout exactly.
//
// `children` must be the MUI `Table` itself (it renders `<table>` as this box's
// direct child): the `minWidth` below is scoped to `& > table`, so wrapping a
// `TableContainer`, a `Box` or a fragment silently loses the minimum width and
// the region collapses back to clipping with no error.
export default function TableScroller({ narrow, label, minWidth = 720, children }) {
  if (!narrow) return children;
  return (
    <Box
      role="region"
      aria-label={`${label} (scrolls horizontally)`}
      tabIndex={0}
      // `flexShrink: 0`: a scroll container's automatic minimum size is 0, so
      // inside a column flex parent (the Automation page) this box would
      // otherwise be squashed to zero height by its own overflowing table.
      sx={{ maxWidth: '100%', maxHeight: '100%', flexShrink: 0, overflow: 'auto', '& > table': { minWidth } }}
    >
      {children}
    </Box>
  );
}
