import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import { useCapabilities } from '@/hooks/useCapabilities.js';

// Shared tool picker (claude vs codex) for the create dialogs. Codex is gated
// on CODEX_BIN being set (reported via /capabilities.codexSpawn). Default
// 'claude'; the Codex button is disabled when unavailable. caps is null while
// loading → treat as available (matches ModelSelect's convention so a fetch
// glitch never hides a working feature).
export default function ToolSelect({ tool, setTool }) {
  const caps = useCapabilities();
  const codexAvailable = caps ? caps.codexSpawn?.available !== false : true;
  return (
    <ToggleButtonGroup
      value={tool}
      exclusive
      size="small"
      color="primary"
      onChange={(_, v) => { if (v) setTool(v); }}
      sx={{ alignSelf: 'flex-start' }}
    >
      <ToggleButton value="claude" sx={{ px: 1, fontSize: 11, textTransform: 'none' }}>Claude</ToggleButton>
      <ToggleButton value="codex" disabled={!codexAvailable} sx={{ px: 1, fontSize: 11, textTransform: 'none' }}>Codex</ToggleButton>
    </ToggleButtonGroup>
  );
}