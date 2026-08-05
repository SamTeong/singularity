import Box from '@mui/material/Box';
import InputBase from '@mui/material/InputBase';
import { useTheme } from '@mui/material/styles';
import SearchRoundedIcon from '@mui/icons-material/SearchRounded';
import { SearchInput as ZapacSearchInput } from '@zapac/mui-theme';
import { useThemeSkin } from '@/theme/index.js';
import { getRoles } from '@/theme/contract.js';

const phosphorPillSx = (roles, sx) => ({
  display: 'flex',
  alignItems: 'center',
  gap: 1,
  height: 36,
  minWidth: 220,
  px: 1.25,
  borderRadius: 0,
  background: roles.shell.panel,
  border: `1px solid ${roles.chrome.stroke2}`,
  transition: `border-color ${roles.motion.durations.fast}ms ${roles.motion.transition}`,
  '&:focus-within': { borderColor: roles.status.nominal },
  ...sx,
});

const phosphorShortcutHint = (shortcut, roles) => (
  <Box
    component="kbd"
    sx={{
      fontSize: 10,
      fontWeight: 700,
      px: 0.75,
      py: 0.25,
      borderRadius: 0,
      flex: 'none',
      color: roles.status.idle,
      border: `1px solid ${roles.chrome.stroke2}`,
    }}
  >
    {shortcut}
  </Box>
);

/**
 * SearchInput — skin-neutral command-bar search field/trigger (task 2.2,
 * design.md D3). Same prop shape as the ZAPAC-owned `@zapac/mui-theme`
 * `SearchInput` it replaces (used today only through
 * `components/panelkit/RailSearch.jsx`): `placeholder`, `value`, `onChange`,
 * `onClick`, `shortcut`, `sx`. Passing `onClick` renders it as a button
 * trigger instead of an inline text field, same as the vendored version.
 *
 * Resolution strategy: branches on {@link useThemeSkin} rather than resolving
 * purely through tokens/roles, because the ZAPAC pill is a glass recipe
 * (`backdropFilter: blur(...)`, `var(--mui-palette-glass-*)`, brand focus
 * ring) with no Phosphor equivalent — Phosphor has no glass at all. Under
 * Phosphor this renders as a native hard-edged MUI `InputBase` (its
 * uppercase/mono/placeholder styling already comes free from the theme's
 * `MuiInputBase` override — see the `phosphor-console` skill's "Stock MUI
 * just works") inside a chrome-stroked box with no blur, resolving its
 * border/focus/idle colors through `getRoles(theme)`.
 *
 * @param {Object} props
 * @param {string} [props.placeholder='Search…']
 * @param {string} [props.value]
 * @param {(value: string) => void} [props.onChange]
 * @param {() => void} [props.onClick] renders as a button trigger instead of a text field
 * @param {string} [props.shortcut='⌘K']
 * @param {object} [props.sx]
 */
export function SearchInput({ placeholder = 'Search…', value, onChange, onClick, shortcut = '⌘K', sx }) {
  const { skinId } = useThemeSkin();
  const theme = useTheme();

  if (skinId !== 'phosphor') {
    return (
      <ZapacSearchInput
        placeholder={placeholder}
        value={value}
        onChange={onChange}
        onClick={onClick}
        shortcut={shortcut}
        sx={sx}
      />
    );
  }

  const roles = getRoles(theme);
  const iconSx = { fontSize: 19, flex: 'none', color: roles.status.idle };

  if (onClick) {
    return (
      <Box
        component="button"
        type="button"
        onClick={onClick}
        aria-label={placeholder}
        sx={{
          ...phosphorPillSx(roles, sx),
          cursor: 'pointer',
          textAlign: 'left',
          font: 'inherit',
          color: 'inherit',
          '&:hover': { borderColor: roles.chrome.stroke },
          '&:focus-visible': { outline: 'none', borderColor: roles.status.nominal },
        }}
      >
        <SearchRoundedIcon sx={iconSx} />
        <Box component="span" sx={{ flex: 1, fontSize: 14, color: 'text.secondary' }}>
          {placeholder}
        </Box>
        {shortcut && phosphorShortcutHint(shortcut, roles)}
      </Box>
    );
  }

  return (
    <Box sx={phosphorPillSx(roles, sx)}>
      <SearchRoundedIcon sx={iconSx} />
      <InputBase
        value={value}
        onChange={(e) => onChange?.(e.target.value)}
        placeholder={placeholder}
        sx={{ flex: 1, fontSize: 14 }}
      />
      {shortcut && phosphorShortcutHint(shortcut, roles)}
    </Box>
  );
}
