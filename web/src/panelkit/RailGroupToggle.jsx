import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import UnfoldMoreIcon from '@mui/icons-material/UnfoldMore';
import UnfoldLessIcon from '@mui/icons-material/UnfoldLess';

// One-button expand/collapse-all for grouped rail lists. Generic API: caller
// supplies `allOpen` (every group currently open?) + `onToggle` (flip all) so
// this works for both collapsed-set panels (Hooks/Rules/Memory, default open)
// and expanded-set panels (Wiki/Skills, default folded). Icon + tooltip reflect
// the NEXT action. Disabled when <2 groups (no-op).
export default function RailGroupToggle({ allOpen, onToggle, disabled }) {
  return (
    <Tooltip title={allOpen ? 'Collapse all' : 'Expand all'} placement="bottom" disableInteractive>
      <span>
        <IconButton size="small" onClick={onToggle} disabled={disabled}>
          {allOpen ? <UnfoldLessIcon /> : <UnfoldMoreIcon />}
        </IconButton>
      </span>
    </Tooltip>
  );
}