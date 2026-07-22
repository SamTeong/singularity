/**
 * SkinSwitcher — registry-driven skin picker, rendered as a section of MenuItems.
 *
 * Enumerates `useThemeSkin().skins` and lets the user switch the active skin.
 * Renders `null` when fewer than two skins are registered, so the app's menu is
 * unchanged until a second skin (e.g. Phosphor Console) is registered — at which
 * point this section appears automatically, no call-site changes needed.
 *
 * Designed to live inside a MUI `<Menu>`: it emits a leading `<Divider>`, a small
 * caption, and one checkable `<MenuItem>` per skin.
 */
import Divider from '@mui/material/Divider';
import MenuItem from '@mui/material/MenuItem';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import Typography from '@mui/material/Typography';
import CheckIcon from '@mui/icons-material/Check';
import PaletteIcon from '@mui/icons-material/Palette';
import { useThemeSkin } from './AppThemeProvider.jsx';

export default function SkinSwitcher({ onSelect }) {
  const { skinId, setSkin, skins } = useThemeSkin();
  if (skins.length < 2) return null;

  return (
    <>
      <Divider />
      <Typography sx={{ px: 2, py: 0.5, fontSize: 11, color: 'text.secondary' }}>Theme skin</Typography>
      {skins.map((skin) => {
        const active = skin.id === skinId;
        return (
          <MenuItem
            key={skin.id}
            selected={active}
            onClick={() => { setSkin(skin.id); onSelect?.(); }}
          >
            <ListItemIcon>
              {active ? <CheckIcon fontSize="small" /> : <PaletteIcon fontSize="small" />}
            </ListItemIcon>
            <ListItemText primary={skin.label} secondary={skin.description} />
          </MenuItem>
        );
      })}
    </>
  );
}
