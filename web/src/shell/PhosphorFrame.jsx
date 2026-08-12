/**
 * PhosphorFrame — the Phosphor-only command-console shell (task 3.1).
 *
 * A thin structural wrapper `AppShell.jsx` mounts around its existing,
 * unmodified interaction tree only when the active skin is Phosphor: a void
 * `#0A0A0A` surface, an orange double border with chamfered corners, and an
 * ambient panel glow. Depth is border + hue + glow only — no `backdropFilter`
 * blur and no cast `boxShadow` elevation (see `shellStyles.frameSx`, which
 * supplies every value from `getRoles(theme).shell`; nothing here is a new
 * hardcoded hex/size).
 *
 * Deliberately NOT the vendored `ConsoleFrame` (`phosphor-console-theme/
 * components`): that component owns its own header/sidebar/main/rail grid,
 * which would duplicate `AppShell`'s existing layout engine (design.md D1 —
 * "branch structure only at composition points"). This is only the visual
 * frame recipe wrapped around the app's real tree; `AppShell` still owns
 * every ref, piece of state, and callback for what renders inside it.
 *
 * CRT scanline/vignette pass (task 3.3): NOT re-applied here. `skins/
 * phosphor.jsx`'s `<CssBaseline />` already installs it exactly once, as a
 * `position: fixed` `body::before` layer at `theme.nerv.layers.crt` (=1).
 * That is a *positioned* layer with a z-index, so per normal CSS stacking
 * rules it already paints above this frame's ordinary (non-positioned, no
 * z-index) content — i.e. over the masthead/sidebar/main/dock — without any
 * cooperation from this component. It is also independent of this frame's
 * `clip-path`/chamfer: `body::before` belongs to `<body>`, not to any node
 * inside this tree, so the frame's chamfer never clips it. Every MUI overlay
 * (Dialog/Drawer/Menu/Tooltip/Popover) portals to `document.body` by default
 * and reads its z-index from the same `theme.nerv.layers` scale (modal:1300,
 * tooltip:1500 — see `phosphor-console-theme/theme/index.ts`'s `zIndex`
 * option), which is already above the CRT's z-index of 1 — so menus,
 * dialogs, tooltips, and the task dossier (a `Drawer`, also portaled) stack
 * above both this frame and its CRT pass automatically. The one exception,
 * MUI's `Snackbar`, is not portaled but is `position: fixed` itself. Two
 * separate questions apply to it, and the answers differ:
 *
 *  - *Positioning* is safe. This frame sets no `transform`/`filter`/
 *    `perspective`/`contain`/`will-change` (only `position: relative`, for the
 *    inset-rule pseudo), none of which `clip-path` joins, so the frame never
 *    becomes a containing block for fixed descendants — the toast still
 *    resolves its offsets against the real viewport.
 *  - *Clipping* is not. `clip-path` clips the whole descendant subtree,
 *    fixed-position children included, so a toast that strayed outside the
 *    chamfered polygon would be visually cut. In practice both toasts anchor
 *    `top`/`center` (AppShell.jsx) while the chamfer removes only a 16px
 *    triangle at the top-*right* and bottom-*left*, so they land well inside
 *    the clip region. Anchoring a future toast to a cut corner would need it
 *    portaled out of this frame.
 */
import Box from '@mui/material/Box';
import { frameSx } from '@/shell/shellStyles.js';

/**
 * @param {Object} props
 * @param {import('react').ReactNode} props.masthead the Phosphor masthead (flex:none header band)
 * @param {import('react').ReactNode} props.children the app's existing shell tree, unmodified
 */
export default function PhosphorFrame({ masthead, children }) {
  return (
    <Box
      sx={(t) => ({
        ...frameSx(t),
        margin: '12px',
        height: 'calc(100dvh - 24px)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      })}
    >
      {masthead}
      {children}
    </Box>
  );
}
