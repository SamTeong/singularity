import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import Typography from '@mui/material/Typography';
import { useQueryState } from '@/hooks/useQueryState.js';
import { getTokens } from '@/theme/contract.js';
import ShortcutsPanel from './ShortcutsPanel.jsx';
import ModelsPanel from './ModelsPanel.jsx';

const TABS = new Set(['shortcuts', 'models']);

/**
 * Settings — a tab switcher over the per-tab panels (Shortcuts, Models). The
 * active tab lives in the query string (`/settings?tab=models`, absent when it
 * equals the default); an unknown value degrades to the default rather than
 * rendering an empty view. Per-tab action buttons (Reset all, Restore defaults)
 * belong to their panels, not this header.
 */
export default function SettingsView() {
  const [tabParam, setTab] = useQueryState('tab', 'shortcuts');
  const tab = TABS.has(tabParam) ? tabParam : 'shortcuts';

  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <Stack direction="row" spacing={1.5} sx={{ p: 2, pb: 1.5, alignItems: 'center', flexWrap: 'wrap', borderBottom: (t) => `1px solid ${getTokens(t).glass.stroke}` }}>
        <Typography sx={{ fontSize: 20, fontWeight: 600 }}>Settings</Typography>
        <Box sx={{ flex: 1 }} />
      </Stack>
      <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ minHeight: 40, px: 2, borderBottom: (t) => `1px solid ${getTokens(t).glass.stroke}` }}>
        <Tab value="shortcuts" label="Shortcuts" sx={{ minHeight: 40, textTransform: 'none' }} />
        <Tab value="models" label="Models" sx={{ minHeight: 40, textTransform: 'none' }} />
      </Tabs>
      <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        {tab === 'models' ? <ModelsPanel /> : <ShortcutsPanel />}
      </Box>
    </Box>
  );
}