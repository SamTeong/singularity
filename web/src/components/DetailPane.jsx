import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';

// Shared "select something on the left" state ladder for a right-hand detail
// pane: empty selection -> loading -> error -> content. Was hand-rolled as a
// `!sel ? … : loading ? … : err ? … : …` ternary in every browse/edit panel.
// `empty` is the EmptyState node to show (falsy when there's a selection).
export default function DetailPane({ empty, loading, error, children }) {
  if (empty) return <Box sx={{ flex: 1, display: 'grid', placeItems: 'center' }}>{empty}</Box>;
  if (loading) return <Box sx={{ flex: 1, display: 'grid', placeItems: 'center' }}><Typography color="text.secondary">Loading…</Typography></Box>;
  if (error) return <Box sx={{ flex: 1, display: 'grid', placeItems: 'center' }}><Typography color="text.secondary">{error}</Typography></Box>;
  return children;
}
