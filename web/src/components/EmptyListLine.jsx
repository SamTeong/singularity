import Typography from '@mui/material/Typography';

// Shared "empty list" line for the rail panels: one typography (fontSize 13,
// p: 2, text.secondary) and one wording scheme ("No <noun>."). Use for the
// panel-empty state at the bottom of a rail list, not the per-group/per-scope
// mini-empties inside the tree.
export default function EmptyListLine({ children }) {
  return <Typography sx={{ p: 2, color: 'text.secondary', fontSize: 13 }}>{children}</Typography>;
}