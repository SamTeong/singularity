import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { useTheme } from '@mui/material/styles';
import { EmptyState as ZapacEmptyState } from '@zapac/mui-theme';
import { useThemeSkin } from '@/theme/index.js';
import { getRoles } from '@/theme/contract.js';

/**
 * EmptyState — skin-neutral "nothing to show yet" affordance (task 2.2,
 * design.md D3): an icon tile, a title naming what will appear, an optional
 * explanatory sentence, and an optional action. Same prop shape as the
 * ZAPAC-owned `@zapac/mui-theme` `EmptyState` it replaces at every call site
 * (`icon`, `title`, `description`, `action`, `dense`).
 *
 * Resolution strategy: branches on {@link useThemeSkin} rather than resolving
 * purely through tokens/roles, because the ZAPAC version's icon tile reads
 * `var(--mui-palette-brand-ink)` / `var(--mui-palette-glass-chip)` — one-off
 * brand/glass colors with no `getRoles()` counterpart (see
 * `theme/contract.js`'s `StatusRole`/`ChromeRole` docs, which deliberately
 * exclude brand-ink and glass). Delegating straight to the vendored ZAPAC
 * component keeps that branch byte-for-byte identical. Under Phosphor, this
 * inherits native Phosphor MUI `Typography` presentation (no glass, no
 * vendored atom needed — a plain bordered tile matches the "border + glow +
 * hue only" depth model) with a hard-edged, chrome-stroked icon tile in place
 * of ZAPAC's glass chip.
 *
 * @param {Object} props
 * @param {import('react').ReactNode} props.icon
 * @param {import('react').ReactNode} props.title
 * @param {import('react').ReactNode} [props.description]
 * @param {import('react').ReactNode} [props.action]
 * @param {boolean} [props.dense=false]
 */
export function EmptyState({ icon, title, description, action, dense = false }) {
  const { skinId } = useThemeSkin();
  const theme = useTheme();

  if (skinId !== 'phosphor') {
    return <ZapacEmptyState icon={icon} title={title} description={description} action={action} dense={dense} />;
  }

  const roles = getRoles(theme);
  return (
    <Box
      sx={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        textAlign: 'center',
        gap: 1,
        px: 3,
        py: dense ? 3 : 5,
        minHeight: dense ? 140 : 200,
      }}
    >
      <Box
        aria-hidden
        sx={{
          width: 46,
          height: 46,
          mb: 0.5,
          borderRadius: 0,
          display: 'grid',
          placeItems: 'center',
          color: roles.chrome.stroke,
          border: `1px solid ${roles.chrome.stroke}`,
          '& svg': { fontSize: 24 },
        }}
      >
        {icon}
      </Box>
      <Typography sx={{ fontWeight: 700, fontSize: 15 }}>{title}</Typography>
      {description && (
        <Typography variant="body2" sx={{ color: 'text.secondary', maxWidth: '34ch', textWrap: 'pretty' }}>
          {description}
        </Typography>
      )}
      {action && <Box sx={{ mt: 1.5 }}>{action}</Box>}
    </Box>
  );
}
