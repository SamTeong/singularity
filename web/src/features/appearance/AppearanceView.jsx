import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import ButtonBase from '@mui/material/ButtonBase';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import RadioButtonUncheckedIcon from '@mui/icons-material/RadioButtonUnchecked';
import LightModeIcon from '@mui/icons-material/LightMode';
import DarkModeIcon from '@mui/icons-material/DarkMode';
import { useColorMode } from '@zapac/mui-theme';
import { useThemeSkin } from '@/theme/AppThemeProvider.jsx';
import { getTokens } from '@/theme/contract.js';

/** One selectable skin card — a radio in the theme radiogroup. */
function SkinCard({ skin, active, onSelect }) {
  const Preview = skin.Preview;
  return (
    <ButtonBase
      role="radio"
      aria-checked={active}
      onClick={onSelect}
      sx={(t) => ({
        flex: '0 0 240px',
        maxWidth: '100%',
        textAlign: 'left',
        alignItems: 'flex-start',
        justifyContent: 'flex-start',
        p: 2,
        borderRadius: `${getTokens(t).radius.md ?? 8}px`,
        border: `1px solid ${active ? t.vars.palette.primary.main : t.vars.palette.divider}`,
        bgcolor: active ? 'action.selected' : 'transparent',
        transition: 'border-color .15s, background-color .15s',
        '&:hover': { bgcolor: 'action.hover' },
      })}
    >
      <Stack spacing={1} sx={{ width: '100%' }}>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
          {active
            ? <CheckCircleIcon fontSize="small" sx={{ color: 'primary.main' }} />
            : <RadioButtonUncheckedIcon fontSize="small" sx={{ color: 'text.disabled' }} />}
          <Typography sx={{ fontWeight: 700 }}>{skin.label}</Typography>
        </Stack>
        {skin.description && (
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>{skin.description}</Typography>
        )}
        {Preview && <Preview />}
      </Stack>
    </ButtonBase>
  );
}

/**
 * Appearance — the theme settings view. Picks the active skin (ZAPAC / Phosphor
 * Console / …) and, for skins that support it, toggles light/dark. Reads the
 * registry through {@link useThemeSkin}; the colour-mode toggle is delegated so
 * the shell can prompt to respawn live sessions after a change.
 */
export default function AppearanceView({ onToggleColorMode }) {
  const { skinId, setSkin, skins } = useThemeSkin();
  const { resolved } = useColorMode();
  const activeSkin = skins.find((s) => s.id === skinId);
  const supportsColorMode = activeSkin?.supportsColorMode !== false;

  return (
    <Box sx={{ height: '100%', overflow: 'auto', p: 3 }}>
      <Typography variant="h6" sx={{ fontWeight: 700 }}>Appearance</Typography>
      <Typography variant="body2" sx={{ color: 'text.secondary', mt: 0.5, mb: 3 }}>
        Choose a visual theme for the interface.
      </Typography>

      {/* Theme skin */}
      <Typography component="h2" sx={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'text.secondary', mb: 1 }}>
        Theme
      </Typography>
      <Stack
        direction="row"
        role="radiogroup"
        aria-label="Theme skin"
        sx={{ flexWrap: 'wrap', gap: 2, mb: 4 }}
      >
        {skins.map((skin) => (
          <SkinCard key={skin.id} skin={skin} active={skin.id === skinId} onSelect={() => setSkin(skin.id)} />
        ))}
      </Stack>

      {/* Color mode */}
      <Typography component="h2" sx={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'text.secondary', mb: 1 }}>
        Color mode
      </Typography>
      {supportsColorMode ? (
        <ToggleButtonGroup
          value={resolved}
          exclusive
          onChange={(_e, val) => { if (val && val !== resolved) onToggleColorMode(); }}
          aria-label="Color mode"
          size="small"
        >
          <ToggleButton value="light" aria-label="Light mode" sx={{ px: 2, gap: 0.75 }}>
            <LightModeIcon fontSize="small" /> Light
          </ToggleButton>
          <ToggleButton value="dark" aria-label="Dark mode" sx={{ px: 2, gap: 0.75 }}>
            <DarkModeIcon fontSize="small" /> Dark
          </ToggleButton>
        </ToggleButtonGroup>
      ) : (
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
          {activeSkin?.label ?? 'This theme'} is dark-only.
        </Typography>
      )}
    </Box>
  );
}
